import { ElevenLabsClient } from 'elevenlabs';
import WebSocket from 'ws';

import { withTimeout } from '../../utils/withTimeout';

let convaiClient: ElevenLabsClient | null = null;

const ELEVENLABS_CONVAI_ENABLED = String(process.env.ELEVENLABS_CONVAI_ENABLED || 'true').toLowerCase() !== 'false';
const ELEVENLABS_CONVAI_AGENT_ID = String(process.env.ELEVENLABS_CONVAI_AGENT_ID || '').trim();
const ELEVENLABS_CONVAI_TIMEOUT_MS = parseInt(process.env.ELEVENLABS_CONVAI_TIMEOUT_MS || '12000', 10);
const ELEVENLABS_CONVAI_MAX_REPLY_CHARS = parseInt(process.env.ELEVENLABS_CONVAI_MAX_REPLY_CHARS || '500', 10);
const ELEVENLABS_CONVAI_WS_TIMEOUT_MS = parseInt(process.env.ELEVENLABS_CONVAI_WS_TIMEOUT_MS || '16000', 10);

function getClient(): ElevenLabsClient {
  if (!convaiClient) {
    const apiKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured');
    convaiClient = new ElevenLabsClient({ apiKey });
  }
  return convaiClient;
}

function normalizeLanguage(language?: string): string {
  const raw = String(language || 'en').trim().toLowerCase();
  if (!raw) return 'en';
  return raw.includes('-') ? raw.split('-')[0] : raw;
}


export function isElevenLabsConvaiEnabled(): boolean {
  if (!ELEVENLABS_CONVAI_ENABLED) return false;
  if (!ELEVENLABS_CONVAI_AGENT_ID) return false;
  return !!String(process.env.ELEVENLABS_API_KEY || '').trim();
}

export async function getElevenLabsConvaiReply(
  userText: string,
  language?: string,
): Promise<string> {
  const result = await getElevenLabsConvaiReplyWithAudio(userText, language);
  return result.text;
}

/**
 * Convai over WebSocket — returns both the agent's TEXT reply and the raw
 * AUDIO buffer it streamed back. Callers that play voice can hand the
 * audio buffer straight to Discord's audio player and skip the second TTS
 * pass we'd otherwise do via ElevenLabs `textToSpeech`. That eliminates
 * the duplicate-TTS double-up Jordan flagged in April 2026.
 *
 * Audio buffer is the concatenation of every `audio_event.audio_base_64`
 * chunk the Convai socket sent before the conversation closed; the
 * configured agent must be set to send audio (default for Convai agents).
 * If audio bytes are zero, callers should fall back to local TTS on text.
 */
export async function getElevenLabsConvaiReplyWithAudio(
  userText: string,
  language?: string,
): Promise<{ text: string; audio: Buffer }> {
  if (!isElevenLabsConvaiEnabled()) {
    throw new Error('ElevenLabs ConvAI is not enabled');
  }

  const client = getClient();
  const signed = await withTimeout(
    client.conversationalAi.getSignedUrl({ agent_id: ELEVENLABS_CONVAI_AGENT_ID }),
    Math.max(3000, ELEVENLABS_CONVAI_TIMEOUT_MS),
    'ElevenLabs ConvAI getSignedUrl'
  );
  const signedUrl = String((signed as any)?.signed_url || '').trim();
  if (!signedUrl) {
    throw new Error('ElevenLabs ConvAI did not return signed_url');
  }

  const result = await withTimeout(
    streamReplyViaSignedUrlSocket(signedUrl, userText, normalizeLanguage(language)),
    Math.max(3000, ELEVENLABS_CONVAI_WS_TIMEOUT_MS),
    'ElevenLabs ConvAI signed-url websocket'
  );

  if (!result.text) {
    throw new Error('ElevenLabs ConvAI returned no agent message');
  }

  return {
    text: result.text.slice(0, Math.max(80, ELEVENLABS_CONVAI_MAX_REPLY_CHARS)),
    audio: result.audio,
  };
}

function extractTextFromEvent(msg: any): string {
  const direct = [
    msg?.agent_response,
    msg?.text,
    msg?.message,
    msg?.transcript,
    msg?.user_transcript,
    msg?.agent_response_event?.agent_response,
    msg?.agent_response_event?.text,
    msg?.agent_response_correction_event?.agent_response,
    msg?.agent_response_correction_event?.text,
  ];
  for (const candidate of direct) {
    const value = String(candidate || '').replace(/\s+/g, ' ').trim();
    if (value) return value;
  }
  return '';
}

function extractAudioBase64(msg: any): string {
  // Convai sends audio under a few field names depending on event variant.
  // Cover the common ones: `audio_base_64`, nested `audio_event.audio_base_64`,
  // and the snake/camel variants.
  const candidates = [
    msg?.audio_base_64,
    msg?.audioBase64,
    msg?.audio_event?.audio_base_64,
    msg?.audio_event?.audioBase64,
    msg?.audio,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return '';
}

interface ConvaiStreamResult {
  text: string;
  audio: Buffer;
}

async function streamReplyViaSignedUrlSocket(
  signedUrl: string,
  userText: string,
  language: string,
): Promise<ConvaiStreamResult> {
  const prompt = String(userText || '').replace(/\s+/g, ' ').trim();
  if (!prompt) throw new Error('Empty ConvAI prompt');

  return new Promise<ConvaiStreamResult>((resolve, reject) => {
    const ws = new WebSocket(signedUrl);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    let collectedText = '';
    const audioChunks: Buffer[] = [];
    // Settle when we've seen the agent's final text reply, but give the
    // socket a short grace window so any straggler audio frames land
    // before we close. Without this we'd miss the trailing audio chunk.
    const AUDIO_GRACE_MS = 300;
    let textSeenAt: number | null = null;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch { /* ignore */ }
      if (err) reject(err);
      else resolve({
        text: collectedText,
        audio: audioChunks.length > 0 ? Buffer.concat(audioChunks) : Buffer.alloc(0),
      });
    };

    timeout = setTimeout(() => {
      timedOut = true;
      finish(new Error('ConvAI websocket timed out'));
    }, Math.max(3000, ELEVENLABS_CONVAI_WS_TIMEOUT_MS));

    ws.on('open', () => {
      const initPayload = {
        type: 'conversation_initiation_client_data',
        conversation_initiation_client_data: {
          dynamic_variables: {
            caller_language: language,
          },
        },
      };
      const primaryUserFrame = { type: 'user_message', text: prompt };
      const fallbackUserFrame = { type: 'user_transcript', user_transcript: prompt, final: true };
      ws.send(JSON.stringify(initPayload));
      ws.send(JSON.stringify(primaryUserFrame));
      ws.send(JSON.stringify(fallbackUserFrame));
    });

    ws.on('message', (raw) => {
      let parsed: any;
      try { parsed = JSON.parse(String(raw)); } catch { parsed = null; }
      if (!parsed) return;

      const eventType = String(parsed.type || parsed.message_type || '').toLowerCase();
      if (eventType === 'ping') {
        const pong = { type: 'pong', event_id: parsed?.event_id || parsed?.ping_event?.event_id };
        try { ws.send(JSON.stringify(pong)); } catch { /* ignore */ }
        return;
      }

      // Capture audio frames whenever they appear, regardless of which
      // event type carried them — Convai interleaves text + audio events.
      const audioB64 = extractAudioBase64(parsed);
      if (audioB64) {
        try { audioChunks.push(Buffer.from(audioB64, 'base64')); } catch { /* ignore bad b64 */ }
      }

      const text = extractTextFromEvent(parsed);
      if (text) {
        const looksLikeAgentEvent =
          eventType.includes('agent_response') ||
          eventType.includes('tentative_agent_response') ||
          (eventType && !eventType.includes('user_transcript') && !eventType.includes('audio'));
        if (looksLikeAgentEvent) {
          // First-write-wins for the text reply (matches the prior
          // text-only behaviour) so duplicate agent_response events don't
          // overwrite the canonical first reply.
          if (!collectedText) collectedText = text;
          if (textSeenAt === null) {
            textSeenAt = Date.now();
            // Grace window — keep collecting audio chunks even after the
            // text reply has landed, since Convai interleaves audio frames.
            setTimeout(() => { if (!settled) finish(); }, AUDIO_GRACE_MS);
          }
        }
      }
    });

    ws.on('error', (err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on('close', () => {
      if (settled) return;
      if (timedOut) { finish(new Error('ConvAI websocket closed after timeout')); return; }
      // Socket closed naturally — if we already have text, deliver it
      // along with whatever audio chunks landed.
      if (collectedText) finish();
      else finish(new Error('ConvAI websocket closed before response'));
    });
  });
}
