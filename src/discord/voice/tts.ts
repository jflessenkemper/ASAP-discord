import { GoogleGenerativeAI } from '@google/generative-ai';
import { recordGeminiUsage, isGeminiOverLimit } from '../usage';

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

/**
 * Transcribe audio from a Discord voice stream using Gemini.
 * Accepts raw PCM/opus audio buffer from discord.js voice receiver.
 */
export async function transcribeVoice(audioBuffer: Buffer): Promise<string> {
  if (!genAI) throw new Error('Gemini API key not configured');
  if (isGeminiOverLimit()) throw new Error('Daily Gemini API call limit reached');

  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const base64Audio = audioBuffer.toString('base64');

  const result = await model.generateContent([
    {
      text: 'Transcribe the following audio recording. Return ONLY the transcribed text, nothing else. If the audio is unclear or silent, respond with [silence].',
    },
    { inlineData: { mimeType: 'audio/webm', data: base64Audio } },
  ]);

  const text = result.response.text().trim();
  recordGeminiUsage();
  if (!text || text === '[silence]') return '';
  return text;
}

/**
 * Generate speech audio from text using Gemini TTS.
 * Returns a Buffer of audio data (WAV format suitable for discord playback).
 */
export async function textToSpeech(
  text: string,
  voiceName: string = 'Kore'
): Promise<Buffer> {
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
