/**
 * Integration test: Convai PCM → ffmpeg → 48 kHz stereo s16le.
 *
 * Why this exists: production reported silence even though
 * onPlaybackStart fired. Root cause was that prism.FFmpeg prepends
 * `-i -` BEFORE caller args, so input format hints (`-f s16le -ar
 * 16000 -ac 1`) end up AFTER the input declaration where ffmpeg
 * treats them as OUTPUT options. That made ffmpeg auto-detect raw
 * PCM as "Invalid data" and emit zero bytes.
 *
 * Fix: spawn ffmpeg directly so the caller controls argument order
 * (input args before `-i pipe:0`, output args after). This test
 * re-exercises that exact spawn invocation against synthetic PCM and
 * asserts the output is non-silent.
 */

import { spawn } from 'child_process';
import { PassThrough } from 'stream';

describe('Convai audio pipeline (PCM → ffmpeg via spawn)', () => {
  it('produces non-silent 48 kHz stereo from 16 kHz mono PCM input', async () => {
    // 1s of 440 Hz sine at 16 kHz mono s16le.
    const SAMPLE_RATE_IN = 16000;
    const samples = SAMPLE_RATE_IN; // 1 second
    const sineInput = Buffer.alloc(samples * 2);
    const amplitude = 0.5 * 32767;
    for (let i = 0; i < samples; i++) {
      const sample = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE_IN));
      sineInput.writeInt16LE(sample, i * 2);
    }

    const out = await runProductionFfmpegArgs(sineInput, SAMPLE_RATE_IN, 1);

    // 1s of 48 kHz stereo s16le ≈ 192000 bytes.
    expect(out.length).toBeGreaterThan(180_000);
    expect(out.length).toBeLessThan(220_000);

    const rms = computeRms16LE(out);
    expect(rms).toBeGreaterThan(5000);
    expect(rms).toBeLessThan(20000);
  }, 15_000);

  it('handles small chunked writes (mimics Convai streaming)', async () => {
    const SAMPLE_RATE_IN = 16000;
    const samples = SAMPLE_RATE_IN;
    const fullBuf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const sample = Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE_IN));
      fullBuf.writeInt16LE(sample, i * 2);
    }

    // Chunk the input the way Convai does.
    const chunks: Buffer[] = [];
    const CHUNK = 320;
    for (let off = 0; off < fullBuf.length; off += CHUNK) {
      chunks.push(fullBuf.subarray(off, Math.min(off + CHUNK, fullBuf.length)));
    }

    const out = await runProductionFfmpegArgs(chunks, SAMPLE_RATE_IN, 1);

    expect(out.length).toBeGreaterThan(180_000);
    const rms = computeRms16LE(out);
    expect(rms).toBeGreaterThan(2500);
  }, 15_000);
});

/**
 * Mirrors the spawn invocation in src/discord/voice/testerClient.ts
 * streamRawPcmToTesterVC. If you change one, change the other.
 */
async function runProductionFfmpegArgs(
  inputData: Buffer | Buffer[],
  sampleRate: number,
  channels: number,
): Promise<Buffer> {
  const proc = spawn('ffmpeg', [
    '-analyzeduration', '0',
    '-loglevel', 'error',
    '-f', 's16le',
    '-ar', String(sampleRate),
    '-ac', String(channels),
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const outChunks: Buffer[] = [];
  const errChunks: string[] = [];
  proc.stdout.on('data', (c: Buffer) => outChunks.push(c));
  proc.stderr.on('data', (c: Buffer) => errChunks.push(c.toString()));

  const exit = new Promise<number>((resolve, reject) => {
    proc.on('close', (code) => resolve(code ?? -1));
    proc.on('error', reject);
  });

  if (Array.isArray(inputData)) {
    const input = new PassThrough();
    input.pipe(proc.stdin);
    for (const chunk of inputData) {
      input.write(chunk);
      await new Promise((r) => setImmediate(r));
    }
    input.end();
  } else {
    proc.stdin.write(inputData);
    proc.stdin.end();
  }

  const code = await exit;
  if (code !== 0) {
    throw new Error(`ffmpeg exit ${code}: ${errChunks.join('').slice(0, 400)}`);
  }
  return Buffer.concat(outChunks);
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
