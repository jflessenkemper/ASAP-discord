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

  const reply = await withTimeout(
    getReplyViaSignedUrlSocket(signedUrl, userText, normalizeLanguage(language)),
    Math.max(3000, ELEVENLABS_CONVAI_WS_TIMEOUT_MS),
    'ElevenLabs ConvAI signed-url websocket'
  );

  if (!reply) {
    throw new Error('ElevenLabs ConvAI returned no agent message');
  }

  return reply.slice(0, Math.max(80, ELEVENLABS_CONVAI_MAX_REPLY_CHARS));
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

async function getReplyViaSignedUrlSocket(signedUrl: string, userText: string, language: string): Promise<string> {
  const prompt = String(userText || '').replace(/\s+/g, ' ').trim();
  if (!prompt) throw new Error('Empty ConvAI prompt');

  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(signedUrl);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const finish = (err?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
      }
      if (err) reject(err);
      else resolve(String(text || ''));
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
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        parsed = null;
      }
      if (!parsed) return;

      const eventType = String(parsed.type || parsed.message_type || '').toLowerCase();
      if (eventType === 'ping') {
        const pong = {
          type: 'pong',
          event_id: parsed?.event_id || parsed?.ping_event?.event_id,
        };
        try {
          ws.send(JSON.stringify(pong));
        } catch {
        }
      }

      const text = extractTextFromEvent(parsed);
      if (!text) return;

      const looksLikeAgentEvent =
        eventType.includes('agent_response') ||
        eventType.includes('tentative_agent_response') ||
        (eventType && !eventType.includes('user_transcript'));

      if (looksLikeAgentEvent) {
        finish(undefined, text);
      }
    });

    ws.on('error', (err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on('close', () => {
      if (settled) return;
      if (timedOut) {
        finish(new Error('ConvAI websocket closed after timeout'));
        return;
      }
      finish(new Error('ConvAI websocket closed before response'));
    });
  });
}
