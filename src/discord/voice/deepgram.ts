import { createClient, LiveTranscriptionEvents, LiveClient } from '@deepgram/sdk';
import { recordGeminiUsage } from '../usage';

let deepgramClient: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (!deepgramClient) {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) throw new Error('DEEPGRAM_API_KEY not configured');
    deepgramClient = createClient(apiKey);
  }
  return deepgramClient;
}

export interface DeepgramLiveSession {
  /** Send raw audio data to Deepgram for real-time transcription */
  send: (audio: Buffer) => void;
  /** Close the connection */
  close: () => void;
}

/**
 * Start a real-time Deepgram live transcription session.
 * Audio is streamed in real-time and transcriptions arrive as callbacks
 * with very low latency (~200-400ms).
 *
 * @param onTranscript Called when a final (not interim) transcript arrives
 * @param onError Called on connection errors
 * @returns Session object with send() and close() methods
 */
export async function startLiveTranscription(
  onTranscript: (text: string, detectedLanguage?: string) => void,
  onError?: (err: Error) => void
): Promise<DeepgramLiveSession> {
  const client = getClient();

  const connection: LiveClient = client.listen.live({
    model: 'nova-3',
    language: 'multi',            // Auto-detect language (English, Mandarin, etc.)
    smart_format: true,
    punctuate: true,
    interim_results: false,       // Only final results — no flicker
    endpointing: 500,             // 500ms silence = end of utterance
    utterance_end_ms: 1500,       // 1.5s marks end of full utterance
    encoding: 'linear16',          // Discord receiver decodes to PCM s16le
    sample_rate: 48000,           // Discord PCM sample rate
    channels: 2,                  // Discord stereo
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
    const transcript = data?.channel?.alternatives?.[0]?.transcript;
    const detectedLang = data?.channel?.alternatives?.[0]?.languages?.[0] || data?.metadata?.language;
    if (transcript && data.is_final) {
      recordGeminiUsage(); // Reuse gemini counter for simplicity
      onTranscript(transcript, detectedLang);
    }
  });

  connection.on(LiveTranscriptionEvents.Error, (err: any) => {
    console.error('Deepgram error:', err?.message || err);
    onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    // Connection closed
  });

  return {
    send: (audio: Buffer) => {
      if (connection.getReadyState() === 1) { // OPEN
        connection.send(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer);
      }
    },
    close: () => {
      connection.requestClose();
    },
  };
}

/**
 * Check if Deepgram is configured and available.
 */
export function isDeepgramAvailable(): boolean {
  return !!process.env.DEEPGRAM_API_KEY;
}
