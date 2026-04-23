import { ElevenLabsClient } from 'elevenlabs';

import { recordElevenLabsUsage, isElevenLabsOverLimit } from '../usage';

let client: ElevenLabsClient | null = null;
const warmedVoicePhraseSets = new Set<string>();

type CacheEntry = { buffer: Buffer; ts: number };
const ttsCache = new Map<string, CacheEntry>();
const TTS_CACHE_MAX_ENTRIES = parseInt(process.env.TTS_CACHE_MAX_ENTRIES || '64', 10);
const TTS_CACHE_TTL_MS = parseInt(process.env.TTS_CACHE_TTL_MS || '900000', 10); // 15 min

function resolveVoiceId(voiceName: string): string {
  const requested = String(voiceName || '').trim();
  // ElevenLabs voice IDs are alphanumeric (commonly 20 chars).
  if (/^[A-Za-z0-9]{20,}$/.test(requested)) {
    return requested;
  }
  return VOICE_ID_MAP[requested] || VOICE_ID_MAP[requested.toLowerCase()] || DEFAULT_VOICE_ID;
}

function getCacheKey(text: string, voiceName: string): string {
  return `${voiceName}::${text.trim()}`;
}

function getCachedTts(text: string, voiceName: string): Buffer | null {
  const key = getCacheKey(text, voiceName);
  const entry = ttsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTS_CACHE_TTL_MS) {
    ttsCache.delete(key);
    return null;
  }
  ttsCache.delete(key);
  ttsCache.set(key, entry);
  return Buffer.from(entry.buffer);
}

function setCachedTts(text: string, voiceName: string, buffer: Buffer): void {
  const key = getCacheKey(text, voiceName);
  ttsCache.set(key, { buffer: Buffer.from(buffer), ts: Date.now() });
  while (ttsCache.size > TTS_CACHE_MAX_ENTRIES) {
    const oldestKey = ttsCache.keys().next().value;
    if (!oldestKey) break;
    ttsCache.delete(oldestKey);
  }
}

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
  RileyEL: 'XgJBU07aO5LKJqYttcYx',   // Cortana dedicated voice
  Achernar: 'lsgXALPNLFUcQfT1dmP1',  // shared/default legacy voice
  Aoede: 'XgJBU07aO5LKJqYttcYx',     // legacy alias -> Cortana voice

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
const DEFAULT_VOICE_ID = 'lsgXALPNLFUcQfT1dmP1'; // shared default

/**
 * Select the ElevenLabs model based on the target language.
 * eleven_turbo_v2_5 is optimised for English speed (~200ms TTFB, 32 languages).
 * eleven_multilingual_v2 provides higher quality for non-English output.
 */
function resolveElevenLabsModel(language?: string): string {
  if (!language || language === 'en' || language.startsWith('en-')) {
    return 'eleven_turbo_v2_5';
  }
  return 'eleven_multilingual_v2';
}

/**
 * Generate speech with ElevenLabs — returns complete audio buffer.
 * Uses the Turbo v2.5 model for lowest latency (~200ms TTFB) for English,
 * and eleven_multilingual_v2 for non-English languages.
 */
export async function elevenLabsTTS(
  text: string,
  voiceName: string = 'Achernar',
  language?: string
): Promise<Buffer> {
  if (!text || text.trim().length < 2) return Buffer.alloc(0);
  if (isElevenLabsOverLimit()) {
    throw new Error('Daily ElevenLabs character limit reached');
  }

  if (text.length <= 160) {
    const cached = getCachedTts(text, voiceName);
    if (cached) return cached;
  }

  const el = getClient();
  const voiceId = resolveVoiceId(voiceName);

  const audio = await el.textToSpeech.convert(voiceId, {
    text,
    model_id: resolveElevenLabsModel(language),
    output_format: 'mp3_44100_128',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    },
  });

  const chunks: Buffer[] = [];
  for await (const chunk of audio) {
    chunks.push(Buffer.from(chunk));
  }

  const buffer = Buffer.concat(chunks);
  if (text.length <= 160 && buffer.length > 0) {
    setCachedTts(text, voiceName, buffer);
  }
  recordElevenLabsUsage(text.length);
  return buffer;
}

export async function primeElevenLabsVoiceCache(
  voiceName: string,
  phrases: string[],
  language?: string
): Promise<void> {
  if (!isElevenLabsAvailable()) return;
  const normalizedPhrases = phrases.map((phrase) => phrase.trim()).filter((phrase) => phrase.length >= 2);
  if (normalizedPhrases.length === 0) return;

  const warmKey = `${voiceName}::${language || 'default'}::${normalizedPhrases.join('|')}`;
  if (warmedVoicePhraseSets.has(warmKey)) return;
  warmedVoicePhraseSets.add(warmKey);

  await Promise.allSettled(
    normalizedPhrases.map(async (phrase) => {
      if (getCachedTts(phrase, voiceName)) return;
      await elevenLabsTTS(phrase, voiceName, language);
    })
  );
}

/**
 * Short filler phrases Cortana says often on voice — warmed into the TTS
 * cache so the first voice call after boot hits zero-latency playback. If
 * the set grows, keep it under ~10 entries to avoid over-burning credits
 * during startup.
 */
export const CORTANA_WARM_PHRASES: readonly string[] = [
  'One moment.',
  'Let me check.',
  "I'm on it.",
  'Here is what I found.',
  'Done.',
  'Go ahead.',
  'Still here.',
];

/**
 * Warm the ElevenLabs TTS cache at bot startup so the first voice utterance
 * after a deploy isn't a cold TTS call. Defaults to Cortana's voice; override
 * for other agents if needed.
 */
export async function warmCortanaVoiceAtStartup(): Promise<void> {
  if (!isElevenLabsAvailable()) return;
  const voice = process.env.TELEPHONY_CORTANA_VOICE_NAME
    || process.env.TELEPHONY_RILEY_VOICE_NAME
    || 'RileyEL';
  await primeElevenLabsVoiceCache(voice, [...CORTANA_WARM_PHRASES]);
}

/**
 * Check if ElevenLabs is configured and available.
 */
export function isElevenLabsAvailable(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}
