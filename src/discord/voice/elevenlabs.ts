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

/** Map agent voice names to ElevenLabs voice IDs.
 *  These use ElevenLabs default voices — update with custom voice IDs as needed. */
const VOICE_ID_MAP: Record<string, string> = {
  // Riley (Executive Assistant) — warm, professional female
  Achernar: 'EXAVITQu4vr4xnSDxMaL',  // Sarah
  // Ace (Developer) — clear, confident male
  Aoede: 'pNInz6obpgDQGcFmaJgB',       // Adam
};

/** Default voice if agent voice not mapped */
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';

/**
 * Generate speech with ElevenLabs — returns complete audio buffer.
 * Uses the Turbo v2.5 model for lowest latency (~200ms TTFB).
 */
export async function elevenLabsTTS(
  text: string,
  voiceName: string = 'Achernar'
): Promise<Buffer> {
  if (isElevenLabsOverLimit()) {
    throw new Error('Daily ElevenLabs character limit reached');
  }

  const el = getClient();
  const voiceId = VOICE_ID_MAP[voiceName] || DEFAULT_VOICE_ID;

  const audio = await el.textToSpeech.convert(voiceId, {
    text,
    model_id: 'eleven_turbo_v2_5',
    output_format: 'pcm_24000',
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
  if (isElevenLabsOverLimit()) {
    throw new Error('Daily ElevenLabs character limit reached');
  }

  const el = getClient();
  const voiceId = VOICE_ID_MAP[voiceName] || DEFAULT_VOICE_ID;

  const audio = await el.textToSpeech.convert(voiceId, {
    text,
    model_id: 'eleven_turbo_v2_5',
    output_format: 'pcm_24000',
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
