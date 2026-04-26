/**
 * Long-lived ElevenLabs Conversational AI WebSocket for an entire Discord
 * voice call.
 *
 * Replaces the per-utterance ElevenLabs Scribe (STT) round-trip + the
 * separate per-turn Convai handoff. Audio streams in, Convai handles VAD +
 * STT + LLM + TTS server-side, agent audio + text stream back. One WS
 * round-trip for the whole conversation.
 *
 * Why not Scribe + Convai both?
 *   That double-pays for transcription (Scribe + Convai's internal STT)
 *   and adds a network hop. Jordan's ask 2026-04-27: "I don't need
 *   transcription, ElevenLabs records all audio."
 *
 * Format note:
 *   Discord voice receivers hand out PCM 48 kHz stereo. Convai expects
 *   PCM 16 kHz mono. The decimation helper from elevenlabsRealtime is
 *   reused so byte-format stays consistent across both paths.
 */

import { Buffer } from 'buffer';
import WebSocket from 'ws';

import { errMsg } from '../../utils/errors';

let convaiClient: import('elevenlabs').ElevenLabsClient | null = null;

const ELEVENLABS_CONVAI_AGENT_ID = String(process.env.ELEVENLABS_CONVAI_AGENT_ID || '').trim();
const SIGNED_URL_TIMEOUT_MS = parseInt(process.env.ELEVENLABS_CONVAI_TIMEOUT_MS || '12000', 10);
const TURN_INACTIVITY_MS = Math.max(200, parseInt(process.env.CONVAI_TURN_INACTIVITY_MS || '800', 10));

async function getClient(): Promise<import('elevenlabs').ElevenLabsClient> {
  if (!convaiClient) {
    const apiKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured');
    const { ElevenLabsClient } = await import('elevenlabs');
    convaiClient = new ElevenLabsClient({ apiKey });
  }
  return convaiClient;
}

/** Decimate Discord 48 kHz stereo PCM to 16 kHz mono. Same math as the Scribe path. */
export function pcm48StereoTo16Mono(pcm48Stereo: Buffer): Buffer {
  const frameBytes = 4;
  const inputFrames = Math.floor(pcm48Stereo.length / frameBytes);
  if (inputFrames <= 0) return Buffer.alloc(0);
  const outputFrames = Math.floor(inputFrames / 3);
  const out = Buffer.alloc(outputFrames * 2);
  for (let i = 0; i < outputFrames; i++) {
    const offset = i * 3 * frameBytes;
    const left = pcm48Stereo.readInt16LE(offset);
    const right = pcm48Stereo.readInt16LE(offset + 2);
    const mono = Math.max(-32768, Math.min(32767, Math.round((left + right) / 2)));
    out.writeInt16LE(mono, i * 2);
  }
  return out;
}

export interface ConvaiCallEvents {
  /** Convai has transcribed the user's utterance. Save to memory + log. */
  onUserTranscript?: (text: string, language?: string) => void;
  /**
   * One full agent turn — text + concatenated audio bytes ready to feed
   * Discord's audio player. Fired when an inactivity gap or new turn
   * boundary signals the agent has finished speaking.
   */
  onAgentTurn?: (text: string, audio: Buffer) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export interface ConvaiCallSession {
  sendUserAudio(pcm48Stereo: Buffer): void;
  /** Force-end the current agent turn (e.g. user interrupted). */
  flushPendingTurn(): void;
  close(): void;
  readonly isOpen: boolean;
}

export function isConvaiStreamingAvailable(): boolean {
  if (!ELEVENLABS_CONVAI_AGENT_ID) return false;
  return !!String(process.env.ELEVENLABS_API_KEY || '').trim();
}

export async function openConvaiCallSession(
  events: ConvaiCallEvents,
  language?: string,
): Promise<ConvaiCallSession> {
  if (!isConvaiStreamingAvailable()) {
    throw new Error('ElevenLabs Convai streaming unavailable (missing API key or agent id)');
  }

  const client = await getClient();
  const signed = await client.conversationalAi.getSignedUrl({ agent_id: ELEVENLABS_CONVAI_AGENT_ID });
  const signedUrl = String((signed as any)?.signed_url || '').trim();
  if (!signedUrl) throw new Error('Convai did not return signed_url');

  return new Promise<ConvaiCallSession>((resolve, reject) => {
    const ws = new WebSocket(signedUrl);
    const sendQueue: string[] = [];
    let opened = false;
    let closed = false;

    // Per-turn buffer for the agent's outbound audio. The text reply lands
    // first (agent_response_event), then audio chunks stream in across
    // multiple audio_event frames. We emit the turn when audio stops
    // arriving for TURN_INACTIVITY_MS or when a new transcript starts.
    let currentTurnText = '';
    const currentTurnAudio: Buffer[] = [];
    let turnInactivityTimer: ReturnType<typeof setTimeout> | null = null;

    const finalizeTurn = (): void => {
      if (turnInactivityTimer) {
        clearTimeout(turnInactivityTimer);
        turnInactivityTimer = null;
      }
      if (!currentTurnText && currentTurnAudio.length === 0) return;
      const text = currentTurnText;
      const audio = currentTurnAudio.length > 0 ? Buffer.concat(currentTurnAudio) : Buffer.alloc(0);
      currentTurnText = '';
      currentTurnAudio.length = 0;
      try {
        events.onAgentTurn?.(text, audio);
      } catch (err) {
        console.warn('[convai-stream] onAgentTurn handler threw:', errMsg(err));
      }
    };

    const scheduleTurnFinalize = (): void => {
      if (turnInactivityTimer) clearTimeout(turnInactivityTimer);
      turnInactivityTimer = setTimeout(() => {
        turnInactivityTimer = null;
        finalizeTurn();
      }, TURN_INACTIVITY_MS);
    };

    const sendNow = (payload: unknown): void => {
      const json = JSON.stringify(payload);
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
      else if (ws.readyState === WebSocket.CONNECTING) sendQueue.push(json);
    };

    const session: ConvaiCallSession = {
      sendUserAudio: (pcm48Stereo: Buffer) => {
        if (closed) return;
        const mono16 = pcm48StereoTo16Mono(pcm48Stereo);
        if (!mono16.length) return;
        sendNow({ user_audio_chunk: mono16.toString('base64') });
      },
      flushPendingTurn: () => finalizeTurn(),
      close: () => {
        if (closed) return;
        closed = true;
        finalizeTurn();
        try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch { /* ignore */ }
      },
      get isOpen() { return !closed && ws.readyState === WebSocket.OPEN; },
    };

    const initTimeout = setTimeout(() => {
      if (!opened) {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`Convai signed-url socket open timeout after ${SIGNED_URL_TIMEOUT_MS}ms`));
      }
    }, SIGNED_URL_TIMEOUT_MS);

    ws.on('open', () => {
      opened = true;
      clearTimeout(initTimeout);
      // Init frame — language hint helps the server-side STT.
      sendNow({
        type: 'conversation_initiation_client_data',
        conversation_initiation_client_data: {
          dynamic_variables: { caller_language: String(language || 'en').slice(0, 8) },
        },
      });
      while (sendQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
        const payload = sendQueue.shift();
        if (payload) ws.send(payload);
      }
      resolve(session);
    });

    ws.on('message', (raw) => {
      let parsed: any;
      try { parsed = JSON.parse(String(raw)); } catch { return; }
      if (!parsed) return;

      const eventType = String(parsed.type || parsed.message_type || '').toLowerCase();

      if (eventType === 'ping') {
        sendNow({ type: 'pong', event_id: parsed?.event_id || parsed?.ping_event?.event_id });
        return;
      }

      // User finished speaking — Convai delivers their transcript.
      if (eventType.includes('user_transcript')) {
        const userText = String(
          parsed.user_transcription_event?.user_transcript
          || parsed.user_transcript_event?.user_transcript
          || parsed.user_transcript
          || ''
        ).trim();
        const lang = parsed.user_transcription_event?.language || parsed.user_transcript_event?.language;
        if (userText) {
          // A new user utterance ends any previous agent turn we were
          // still buffering — flush so the prior reply isn't held on.
          finalizeTurn();
          try { events.onUserTranscript?.(userText, typeof lang === 'string' ? lang : undefined); }
          catch (err) { console.warn('[convai-stream] onUserTranscript threw:', errMsg(err)); }
        }
        return;
      }

      // Agent text reply — typically arrives once before the audio chunks.
      if (eventType.includes('agent_response') && !eventType.includes('audio')) {
        const replyText = String(
          parsed.agent_response_event?.agent_response
          || parsed.agent_response_correction_event?.corrected_agent_response
          || parsed.agent_response
          || ''
        ).trim();
        if (replyText && !currentTurnText) currentTurnText = replyText;
        scheduleTurnFinalize();
        return;
      }

      // Audio frame for the current agent turn.
      const audioB64 =
        parsed.audio_event?.audio_base_64
        || parsed.audio_base_64
        || parsed.audio_event?.audioBase64
        || '';
      if (typeof audioB64 === 'string' && audioB64.length > 0) {
        try {
          currentTurnAudio.push(Buffer.from(audioB64, 'base64'));
          scheduleTurnFinalize();
        } catch { /* ignore bad b64 */ }
        return;
      }

      // User interrupted — drop whatever agent turn we were buffering.
      if (eventType.includes('interruption')) {
        currentTurnText = '';
        currentTurnAudio.length = 0;
        if (turnInactivityTimer) {
          clearTimeout(turnInactivityTimer);
          turnInactivityTimer = null;
        }
      }
    });

    ws.on('error', (err) => {
      try { events.onError?.(err instanceof Error ? err : new Error(String(err))); }
      catch { /* ignore */ }
      if (!opened) {
        clearTimeout(initTimeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on('close', () => {
      closed = true;
      finalizeTurn();
      try { events.onClose?.(); } catch { /* ignore */ }
    });
  });
}
