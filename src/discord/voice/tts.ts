import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAuth } from 'google-auth-library';
import { recordGeminiUsage, isGeminiOverLimit } from '../usage';
import { elevenLabsTTS, isElevenLabsAvailable } from './elevenlabs';
import { recordTtsError, recordTtsLatency, recordTranscriptionLatency } from '../metrics';

const USE_VERTEX_AI = process.env.GEMINI_USE_VERTEX_AI === 'true';
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

let vertexAuth: GoogleAuth | null = null;
let vertexTokenCache: { token: string; expiresAtMs: number } | null = null;

function hasGeminiProviderConfigured(): boolean {
  if (USE_VERTEX_AI) {
    return Boolean(VERTEX_PROJECT_ID);
  }
  return Boolean(genAI);
}

async function getVertexAccessToken(): Promise<string> {
  const now = Date.now();
  if (vertexTokenCache && vertexTokenCache.expiresAtMs - now > 60_000) {
    return vertexTokenCache.token;
  }

  if (!vertexAuth) {
    vertexAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }

  const authClient = await vertexAuth.getClient();
  const accessToken = await authClient.getAccessToken();
  const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;
  if (!token) throw new Error('Vertex auth failed: no access token');

  vertexTokenCache = { token, expiresAtMs: now + 45 * 60_000 };
  return token;
}

async function callVertexGenerateContent(modelName: string, body: Record<string, any>): Promise<any> {
  if (!VERTEX_PROJECT_ID) {
    throw new Error('Vertex AI is enabled but VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set');
  }
  const token = await getVertexAccessToken();
  const endpoint = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${encodeURIComponent(modelName)}:generateContent`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vertex Gemini error: ${response.status} ${errText.slice(0, 300)}`);
  }

  return response.json();
}

/**
 * Transcribe audio from a Discord voice stream using Gemini.
 * Accepts raw PCM/opus audio buffer from discord.js voice receiver.
 * Pre-filters silence to avoid wasting Gemini API calls.
 */
export async function transcribeVoice(audioBuffer: Buffer): Promise<string> {
  const startedAt = Date.now();
  if (!hasGeminiProviderConfigured()) {
    throw new Error(USE_VERTEX_AI ? 'Vertex Gemini is not configured' : 'Gemini API key not configured');
  }

  let nonSilentSamples = 0;
  const totalSamples = Math.floor(audioBuffer.length / 2);
  for (let i = 0; i < audioBuffer.length - 1; i += 2) {
    if (Math.abs(audioBuffer.readInt16LE(i)) > 500) nonSilentSamples++;
  }
  if (totalSamples > 0 && nonSilentSamples / totalSamples < 0.01) {
    return ''; // Less than 1% non-silent — skip Gemini call
  }

  if (isGeminiOverLimit()) throw new Error('Daily Gemini API call limit reached');

  const base64Audio = audioBuffer.toString('base64');

  let text = '';
  if (USE_VERTEX_AI) {
    const data = await callVertexGenerateContent('gemini-flash-latest', {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: 'Transcribe the following audio recording. Return ONLY the transcribed text, nothing else. If the audio is unclear or silent, respond with [silence].',
            },
            { inlineData: { mimeType: 'audio/l16;rate=48000;channels=2', data: base64Audio } },
          ],
        },
      ],
    });
    text = String(data?.candidates?.[0]?.content?.parts?.find((p: any) => typeof p?.text === 'string')?.text || '').trim();
  } else {
    const model = genAI!.getGenerativeModel({ model: 'gemini-flash-latest' });
    const result = await model.generateContent([
      {
        text: 'Transcribe the following audio recording. Return ONLY the transcribed text, nothing else. If the audio is unclear or silent, respond with [silence].',
      },
      { inlineData: { mimeType: 'audio/l16;rate=48000;channels=2', data: base64Audio } },
    ]);
    text = result.response.text().trim();
  }

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
    }
  }

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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!USE_VERTEX_AI && !apiKey) throw new Error('Gemini API key not configured');
  if (USE_VERTEX_AI && !VERTEX_PROJECT_ID) {
    throw new Error('Vertex AI is enabled but VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set');
  }
  if (isGeminiOverLimit()) throw new Error('Daily Gemini API call limit reached');

  const body = {
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
  };

  let data: {
    candidates?: Array<{
      content?: {
        parts?: Array<{ inlineData?: { mimeType: string; data: string } }>;
      };
    }>;
  };

  if (USE_VERTEX_AI) {
    data = await callVertexGenerateContent('gemini-2.5-flash-preview-tts', body);
  } else {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini TTS error: ${response.status} ${errText}`);
    }

    data = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ inlineData?: { mimeType: string; data: string } }>;
        };
      }>;
    };
  }

  const audioPart = data.candidates?.[0]?.content?.parts?.find(
    (p) => p.inlineData?.mimeType?.startsWith('audio/')
  );

  if (!audioPart?.inlineData?.data) {
    throw new Error('No audio data in Gemini TTS response');
  }

  recordGeminiUsage();
  return Buffer.from(audioPart.inlineData.data, 'base64');
}
