import { GoogleGenerativeAI } from '@google/generative-ai';
import { recordGeminiUsage, isGeminiOverLimit } from '../usage';
import { elevenLabsTTS, isElevenLabsAvailable } from './elevenlabs';
import { recordTtsError, recordTtsLatency, recordTranscriptionLatency } from '../metrics';

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

/**
 * Transcribe audio from a Discord voice stream using Gemini.
 * Accepts raw PCM/opus audio buffer from discord.js voice receiver.
 * Pre-filters silence to avoid wasting Gemini API calls.
 */
export async function transcribeVoice(audioBuffer: Buffer): Promise<string> {
    const startedAt = Date.now();
  if (!genAI) throw new Error('Gemini API key not configured');

  // Client-side silence detection — skip silent audio before calling Gemini
  let nonSilentSamples = 0;
  const totalSamples = Math.floor(audioBuffer.length / 2);
  for (let i = 0; i < audioBuffer.length - 1; i += 2) {
    if (Math.abs(audioBuffer.readInt16LE(i)) > 500) nonSilentSamples++;
  }
  if (totalSamples > 0 && nonSilentSamples / totalSamples < 0.01) {
    return ''; // Less than 1% non-silent — skip Gemini call
  }

  if (isGeminiOverLimit()) throw new Error('Daily Gemini API call limit reached');

  const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

  const base64Audio = audioBuffer.toString('base64');

  const result = await model.generateContent([
    {
      text: 'Transcribe the following audio recording. Return ONLY the transcribed text, nothing else. If the audio is unclear or silent, respond with [silence].',
    },
    { inlineData: { mimeType: 'audio/l16;rate=48000;channels=2', data: base64Audio } },
  ]);

  const text = result.response.text().trim();
  recordTranscriptionLatency('gemini', Date.now() - startedAt);
  recordGeminiUsage();
  if (!text || text === '[silence]') return '';
  return text;
}

/**
 * Generate speech audio from text.
 * Prefers ElevenLabs (much lower latency ~200ms TTFB) over Gemini TTS.
 * Falls back to Gemini if ElevenLabs is not configured.
 * Returns a Buffer of audio data suitable for Discord playback.
 */
export async function textToSpeech(
  text: string,
  voiceName: string = 'Kore',
  language?: string
): Promise<Buffer> {
  const startedAt = Date.now();
  // Prefer ElevenLabs for significantly lower latency
  if (isElevenLabsAvailable()) {
    try {
      const audio = await elevenLabsTTS(text, voiceName, language);
      recordTtsLatency('elevenlabs', Date.now() - startedAt);
      return audio;
    } catch (err) {
      recordTtsError('elevenlabs', 'runtime_error');
      console.warn(
        '[TTS] ElevenLabs failed, falling back to Gemini:',
        err instanceof Error ? err.message : String(err)
      );
      // Fall through to Gemini below
    }
  }

  // Gemini TTS fallback (also used when ElevenLabs is not configured)
  try {
    const audio = await geminiTTS(text, voiceName);
    recordTtsLatency('gemini', Date.now() - startedAt);
    return audio;
  } catch (err) {
    recordTtsError('gemini', 'runtime_error');
    throw err;
  }
}

/**
 * Gemini TTS fallback — used when ElevenLabs key is not set.
 */
async function geminiTTS(text: string, voiceName: string): Promise<Buffer> {
  // Use Gemini 2.5 Flash with audio output for TTS
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');
  if (isGeminiOverLimit()) throw new Error('Daily Gemini API call limit reached');

  // Use the REST API directly for TTS since the SDK doesn't support audio output natively
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text }],
          },
        ],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini TTS error: ${response.status} ${errText}`);
  }

  const data = await response.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ inlineData?: { mimeType: string; data: string } }>;
      };
    }>;
  };

  // Extract audio data from response
  const audioPart = data.candidates?.[0]?.content?.parts?.find(
    (p) => p.inlineData?.mimeType?.startsWith('audio/')
  );

  if (!audioPart?.inlineData?.data) {
    throw new Error('No audio data in Gemini TTS response');
  }

  recordGeminiUsage();
  return Buffer.from(audioPart.inlineData.data, 'base64');
}
