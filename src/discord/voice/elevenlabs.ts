import { ElevenLabsClient } from 'elevenlabs';
import { recordElevenLabsUsage, isElevenLabsOverLimit } from '../usage';

let client: ElevenLabsClient | null = null;

function getClient(): ElevenLabsClient {
  if (!client) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured');
    client = new ElevenLabsClient({ apiKey });
  }
  return client;
}

/** Map agent voice names (from agents.ts) → ElevenLabs voice IDs.
 *  Also supports choosing voices by ElevenLabs name directly.
 *  Full catalog: https://elevenlabs.io/voice-library */
const VOICE_ID_MAP: Record<string, string> = {
  // ── Agent voice mappings (keyed by Gemini voice name from agents.ts) ──
  Achernar: 'EXAVITQu4vr4xnSDxMaL',  // Riley → Sarah
  Aoede: 'pNInz6obpgDQGcFmaJgB',       // Ace → Adam

  // ── ElevenLabs default voices (pick by name) ──
  sarah: 'EXAVITQu4vr4xnSDxMaL',
  adam: 'pNInz6obpgDQGcFmaJgB',
  rachel: '21m00Tcm4TlvDq8ikWAM',
  domi: 'AZnzlk1XvdvUeBnXmlld',
  bella: 'EXAVITQu4vr4xnSDxMaL',
  antoni: 'ErXwobaYiN019PkySvjV',
  elli: 'MF3mGyEYCl7XYWbV9V6O',
  josh: 'TxGEqnHWrfWFTfGW9XjX',
  arnold: 'VR6AewLTigWG4xSOukaG',
  charlotte: 'XB0fDUnXU5powFXDhCwa',
  clyde: '2EiwWnXFnvU5JabPnv8n',
  dave: 'CYw3kZ02Hs0563khs1Fj',
  emily: 'LcfcDJNUP1GQjkzn1xUU',
  fin: 'D38z5RcWu1voky8WS1ja',
  freya: 'jsCqWAovK2LkecY7zXl4',
  gigi: 'jBpfuIE2acCO8z3wKNLl',
  glinda: 'z9fAnlkpzviPz146aGWa',
  grace: 'oWAxZDx7w5VEj9dCyTzz',
  harry: 'SOYHLrjzK2X1ezoPC6cr',
  james: 'ZQe5CZNOzWyzPSCn5a3c',
  jeremy: 'bVMeCyTHy58xNoL34h3p',
  jessie: 't0jbNlBVZ17f02VDIeMI',
  joseph: 'Zlb1dXrM653N07WRdFW3',
  lily: 'pFZP5JQG7iQjIQuC4Bku',
  matilda: 'XrExE9yKIg1WjnnlVkGX',
  michael: 'flq6f7yk4E4fJM5XTYuZ',
  mimi: 'zrHiDhphv9ZnVXBqCLjz',
  nicole: 'piTKgcLEGmPE4e6mEKli',
  patrick: 'ODq5zmih8GrVes37Dizd',
  river: 'SAz9YHcvj6GT2YYXdXww',
  sam: 'yoZ06aMxZJJ28mfd3POQ',
  serena: 'pMsXgVXv3BLzUgSXRplE',
  thomas: 'GBv7mTt0atIp3Br8iCZE',
};

/** Default voice if agent voice not mapped */
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // Sarah

/**
 * Generate speech with ElevenLabs — returns complete audio buffer.
 * Uses the Turbo v2.5 model for lowest latency (~200ms TTFB).
 */
export async function elevenLabsTTS(
  text: string,
  voiceName: string = 'Achernar'
): Promise<Buffer> {
  if (!text || text.trim().length < 2) return Buffer.alloc(0);
  if (isElevenLabsOverLimit()) {
    throw new Error('Daily ElevenLabs character limit reached');
  }

  const el = getClient();
  const voiceId = VOICE_ID_MAP[voiceName] || VOICE_ID_MAP[voiceName.toLowerCase()] || DEFAULT_VOICE_ID;

  const audio = await el.textToSpeech.convert(voiceId, {
    text,
    model_id: 'eleven_turbo_v2_5',
    output_format: 'mp3_44100_128',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    },
  });

  // Collect the stream into a buffer
  const chunks: Buffer[] = [];
  for await (const chunk of audio) {
    chunks.push(Buffer.from(chunk));
  }

  const buffer = Buffer.concat(chunks);
  recordElevenLabsUsage(text.length);
  return buffer;
}

/**
 * Stream TTS audio in chunks — yields buffers as they arrive.
 * Each chunk is playable on its own (PCM 24kHz 16-bit mono).
 * This enables "start speaking while still generating" for ultra-low latency.
 */
export async function* elevenLabsTTSStream(
  text: string,
  voiceName: string = 'Achernar'
): AsyncGenerator<Buffer> {
  if (!text || text.trim().length < 2) return;
  if (isElevenLabsOverLimit()) {
    throw new Error('Daily ElevenLabs character limit reached');
  }

  const el = getClient();
  const voiceId = VOICE_ID_MAP[voiceName] || VOICE_ID_MAP[voiceName.toLowerCase()] || DEFAULT_VOICE_ID;

  const audio = await el.textToSpeech.convert(voiceId, {
    text,
    model_id: 'eleven_turbo_v2_5',
    output_format: 'mp3_44100_128',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    },
  });

  for await (const chunk of audio) {
    yield Buffer.from(chunk);
  }

  recordElevenLabsUsage(text.length);
}

/**
 * Check if ElevenLabs is configured and available.
 */
export function isElevenLabsAvailable(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}

/**
 * Get list of available ElevenLabs voice names.
 */
export function getAvailableVoices(): string[] {
  return Object.keys(VOICE_ID_MAP).filter((k) => k === k.toLowerCase());
}
