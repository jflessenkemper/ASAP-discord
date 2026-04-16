import { recordTtsError, recordTtsLatency, recordTranscriptionLatency } from '../metrics';

import { elevenLabsTTS, isElevenLabsAvailable } from './elevenlabs';

type SttProvider = 'elevenlabs';

export interface TranscriptionResult {
  text: string;
  provider: SttProvider;
}

function getConfiguredSttProvider(): SttProvider {
  const configured = String(process.env.VOICE_STT_PROVIDER || 'elevenlabs').trim().toLowerCase();
  if (configured === 'elevenlabs') return 'elevenlabs';
  return 'elevenlabs';
}

function pcm16Stereo48kToWav(pcm: Buffer): Buffer {
  const channels = 2;
  const sampleRate = 48000;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const riffSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(riffSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

async function elevenLabsTranscribeVoice(audioBuffer: Buffer): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured');

  const wav = pcm16Stereo48kToWav(audioBuffer);
  const file = new Blob([wav as any], { type: 'audio/wav' });
  const form = new FormData();
  form.append('file', file, 'voice.wav');
  form.append('model_id', process.env.ELEVENLABS_STT_MODEL_ID || 'scribe_v1');
  form.append('language_code', process.env.ELEVENLABS_STT_LANGUAGE_CODE || 'en');

  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
    },
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs STT error: ${response.status} ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as { text?: string };
  return String(data?.text || '').trim();
}

export async function transcribeVoiceDetailed(audioBuffer: Buffer): Promise<TranscriptionResult> {
  const provider = getConfiguredSttProvider();
  const startedAt = Date.now();
  const text = await elevenLabsTranscribeVoice(audioBuffer);
  recordTranscriptionLatency('elevenlabs', Date.now() - startedAt);
  if (!text || text === '[silence]') return { text: '', provider };
  return { text, provider };
}

/**
 * Generate speech audio from text using ElevenLabs only for the live voice stack.
 * Returns a Buffer of audio data suitable for Discord playback.
 */
export async function textToSpeech(
  text: string,
  voiceName: string = 'Kore',
  language?: string
): Promise<Buffer> {
  const startedAt = Date.now();
  if (!isElevenLabsAvailable()) {
    throw new Error('ELEVENLABS_API_KEY not configured');
  }

  try {
    const audio = await elevenLabsTTS(text, voiceName, language);
    recordTtsLatency('elevenlabs', Date.now() - startedAt);
    return audio;
  } catch (err) {
    recordTtsError('elevenlabs', 'runtime_error');
    throw err;
  }
}
