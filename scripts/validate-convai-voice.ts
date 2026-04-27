/**
 * End-to-end validator for Cortana's Convai voice path.
 *
 * Without this script the only way to know whether voice "works" was to
 * hop in a Discord voice call and listen. That's slow, doesn't show up
 * in CI, and gives no diagnostic when it fails.
 *
 * What this does:
 *   1. Opens a real Convai WebSocket using the live agent + API key.
 *   2. Sends a deterministic test prompt ("Say a short hello.").
 *   3. Collects every audio_event chunk Convai streams back (raw PCM
 *      16-bit signed-LE 16 kHz mono).
 *   4. Pipes those bytes through the EXACT same ffmpeg invocation the
 *      production code uses (`-f s16le -ar 16000 -ac 1` →
 *      `-f s16le -ar 48000 -ac 2`).
 *   5. Computes RMS amplitude on the resampled output to prove the
 *      audio isn't all-zeros.
 *   6. Writes a `.wav` file so a human can verify by ear if needed.
 *
 * Usage:
 *   npx tsx scripts/validate-convai-voice.ts
 *   npx tsx scripts/validate-convai-voice.ts "What time is it?"
 *
 * Exit codes:
 *   0  — Convai returned audio AND ffmpeg produced non-silent output.
 *   1  — anything failed (missing config, no audio, silence, ffmpeg error).
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';

import prism from 'prism-media';
import WebSocket from 'ws';
import { ElevenLabsClient } from 'elevenlabs';

const SILENCE_RMS_THRESHOLD = 30; // Out of 32768 — anything quieter than this is effectively silence.

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(' ').trim() || 'Say a short hello.';

  const apiKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
  const agentId = String(process.env.ELEVENLABS_CONVAI_AGENT_ID || '').trim();
  if (!apiKey) fatal('ELEVENLABS_API_KEY is not set in env (.env or process env).');
  if (!agentId) fatal('ELEVENLABS_CONVAI_AGENT_ID is not set.');

  console.log(`[validate] prompt: ${prompt}`);
  console.log(`[validate] agent_id=${agentId.slice(-12)}`);

  // 1. Get a signed URL for the WS.
  const client = new ElevenLabsClient({ apiKey });
  const signed = await client.conversationalAi.getSignedUrl({ agent_id: agentId });
  const signedUrl = String((signed as any)?.signed_url || '').trim();
  if (!signedUrl) fatal('Convai did not return signed_url.');

  // 2. Open WS, send prompt, collect audio + text + event types.
  const startMs = Date.now();
  const result = await new Promise<{ text: string; pcm: Buffer; events: string[] }>((resolve, reject) => {
    const ws = new WebSocket(signedUrl);
    const events: string[] = [];
    const audioChunks: Buffer[] = [];
    let collectedText = '';
    let textSeenAt: number | null = null;
    let settled = false;
    const AUDIO_GRACE_MS = 800;
    const HARD_TIMEOUT_MS = 20_000;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve({ text: collectedText, pcm: Buffer.concat(audioChunks), events });
    };

    setTimeout(() => finish(new Error(`Timeout after ${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'conversation_initiation_client_data',
        conversation_initiation_client_data: { dynamic_variables: { caller_language: 'en' } },
      }));
      ws.send(JSON.stringify({ type: 'user_message', text: prompt }));
    });

    ws.on('message', (raw) => {
      let parsed: any;
      try { parsed = JSON.parse(String(raw)); } catch { return; }
      const eventType = String(parsed.type || '').toLowerCase();
      events.push(eventType);

      if (eventType === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', event_id: parsed?.ping_event?.event_id }));
        return;
      }

      const audioB64 = parsed?.audio_event?.audio_base_64 || parsed?.audio_base_64 || '';
      if (typeof audioB64 === 'string' && audioB64) {
        audioChunks.push(Buffer.from(audioB64, 'base64'));
      }

      if (eventType.includes('agent_response') && !eventType.includes('part') && !eventType.includes('audio')) {
        const text = String(parsed?.agent_response_event?.agent_response || '').trim();
        if (text && !collectedText) {
          collectedText = text;
          textSeenAt = Date.now();
          // Give audio frames a grace window after text lands.
          setTimeout(() => finish(), AUDIO_GRACE_MS);
        }
      }
    });

    ws.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
    ws.on('close', () => { if (!settled) finish(); });
  });

  const elapsedMs = Date.now() - startMs;
  console.log(`[validate] convai round-trip: ${elapsedMs}ms`);
  console.log(`[validate] event types seen: ${dedupe(result.events).join(', ')}`);
  console.log(`[validate] text reply: "${result.text.slice(0, 200)}"`);
  console.log(`[validate] raw pcm bytes: ${result.pcm.length}`);

  if (result.pcm.length === 0) {
    fatal('Convai returned ZERO audio bytes. Check the agent\'s voice config in the dashboard.');
  }

  // 3. Pipe through ffmpeg directly via child_process for full visibility
  // (prism.FFmpeg can swallow stderr in older versions). Same args as the
  // production streamRawPcmToTesterVC path.
  const { spawn } = await import('child_process');
  const proc = spawn('ffmpeg', [
    '-analyzeduration', '0',
    '-loglevel', 'info',
    '-f', 's16le', '-ar', '16000', '-ac', '1',
    '-i', 'pipe:0',
    '-f', 's16le', '-ar', '48000', '-ac', '2',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const outputChunks: Buffer[] = [];
  const stderrChunks: string[] = [];
  proc.stdout.on('data', (c: Buffer) => outputChunks.push(c));
  proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c.toString()));

  const exitPromise = new Promise<number>((res, rej) => {
    proc.on('close', (code) => res(code ?? -1));
    proc.on('error', rej);
  });

  // Write PCM to stdin AFTER listeners are attached, then close stdin.
  proc.stdin.write(result.pcm);
  proc.stdin.end();
  const exitCode = await exitPromise;

  const stderr = stderrChunks.join('');
  if (stderr) console.log(`[validate] ffmpeg stderr (last 800):\n${stderr.slice(-800)}`);
  console.log(`[validate] ffmpeg exit code: ${exitCode}`);

  const resampled = Buffer.concat(outputChunks);
  console.log(`[validate] ffmpeg output bytes: ${resampled.length} (${(resampled.length / 192000).toFixed(2)}s of 48 kHz stereo s16le)`);
  if (resampled.length === 0) {
    fatal('ffmpeg produced ZERO output bytes. Pipeline broken.');
  }

  // 4. RMS check on the resampled output.
  const rms = computeRms16LE(resampled);
  console.log(`[validate] rms amplitude: ${rms.toFixed(2)} (silence threshold ${SILENCE_RMS_THRESHOLD})`);

  // 5. Write WAV for manual listening.
  const wav = pcm16MonoToWavSurround(resampled, 48000, 2);
  const outDir = path.resolve(__dirname, '..', '.tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'convai-validate.wav');
  fs.writeFileSync(outPath, wav);
  console.log(`[validate] wrote ${outPath} — play it locally to listen.`);

  if (rms < SILENCE_RMS_THRESHOLD) {
    fatal(`Audio is effectively silent (rms ${rms.toFixed(2)} < ${SILENCE_RMS_THRESHOLD}). The bytes flowed but they're zeros.`);
  }

  console.log('[validate] ✅ Convai voice path is producing non-silent audio end-to-end.');
}

function fatal(msg: string): never {
  console.error(`[validate] ❌ ${msg}`);
  process.exit(1);
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

function computeRms16LE(buf: Buffer): number {
  const samples = Math.floor(buf.length / 2);
  if (samples === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(i * 2);
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / samples);
}

/** Wrap raw PCM s16le with a WAV header for manual playback. */
function pcm16MonoToWavSurround(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 30);
  header.writeUInt16LE(bitsPerSample, 32);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

main().catch((err) => {
  console.error('[validate] threw:', err);
  process.exit(1);
});
