import WebSocket from 'ws';

export interface ElevenLabsRealtimeSession {
  send: (audio: Buffer) => void;
  close: () => void;
}

function toBoolParam(value: string | undefined, fallback: boolean): string {
  if (typeof value !== 'string') return fallback ? 'true' : 'false';
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' ? 'true' : 'false';
}

function pcm48StereoTo16Mono(pcm48Stereo: Buffer): Buffer {
  const frameBytes = 4; // 16-bit stereo
  const inputFrames = Math.floor(pcm48Stereo.length / frameBytes);
  if (inputFrames <= 0) return Buffer.alloc(0);

  // 48kHz -> 16kHz decimation factor of 3.
  const outputFrames = Math.floor(inputFrames / 3);
  const out = Buffer.alloc(outputFrames * 2);

  for (let i = 0; i < outputFrames; i++) {
    const inFrame = i * 3;
    const offset = inFrame * frameBytes;
    const left = pcm48Stereo.readInt16LE(offset);
    const right = pcm48Stereo.readInt16LE(offset + 2);
    const mono = Math.max(-32768, Math.min(32767, Math.round((left + right) / 2)));
    out.writeInt16LE(mono, i * 2);
  }

  return out;
}

/**
 * Start ElevenLabs realtime transcription over WebSocket.
 */
export async function startElevenLabsRealtimeTranscription(
  onTranscript: (text: string, detectedLanguage?: string) => void,
  onError?: (err: Error) => void
): Promise<ElevenLabsRealtimeSession> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY not configured');
  }

  const modelId = process.env.ELEVENLABS_STT_REALTIME_MODEL_ID || 'scribe_v2_realtime';
  const language = process.env.ELEVENLABS_STT_LANGUAGE_CODE || 'en';
  const includeLanguageDetection = toBoolParam(process.env.ELEVENLABS_STT_INCLUDE_LANGUAGE_DETECTION, true);
  const includeTimestamps = toBoolParam(process.env.ELEVENLABS_STT_INCLUDE_TIMESTAMPS, false);
  const vadSilenceThresholdSecs = process.env.ELEVENLABS_STT_VAD_SILENCE_THRESHOLD_SECS || '0.4';
  const vadThreshold = process.env.ELEVENLABS_STT_VAD_THRESHOLD || '0.4';
  const minSpeechDurationMs = process.env.ELEVENLABS_STT_MIN_SPEECH_DURATION_MS || '80';
  const minSilenceDurationMs = process.env.ELEVENLABS_STT_MIN_SILENCE_DURATION_MS || '120';

  const qs = new URLSearchParams({
    model_id: modelId,
    audio_format: 'pcm_16000',
    language_code: language,
    commit_strategy: 'vad',
    include_language_detection: includeLanguageDetection,
    include_timestamps: includeTimestamps,
    vad_silence_threshold_secs: vadSilenceThresholdSecs,
    vad_threshold: vadThreshold,
    min_speech_duration_ms: minSpeechDurationMs,
    min_silence_duration_ms: minSilenceDurationMs,
  });

  const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${qs.toString()}`;
  let closedExplicitly = false;
  let errorReported = false;
  const sendQueue: Array<string> = [];
  const startupRetries = Math.max(1, parseInt(process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES || '3', 10));
  const startupTimeoutMs = Math.max(3000, parseInt(process.env.ELEVENLABS_STT_STARTUP_TIMEOUT_MS || '10000', 10));
  const startupBackoffBaseMs = Math.max(250, parseInt(process.env.ELEVENLABS_STT_STARTUP_BACKOFF_BASE_MS || '500', 10));

  let ws: WebSocket | null = null;
  let startupAttempt = 0;
  while (startupAttempt < startupRetries) {
    startupAttempt += 1;
    ws = new WebSocket(wsUrl, {
      headers: {
        'xi-api-key': apiKey,
      },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('ElevenLabs realtime connection timed out')), startupTimeoutMs);

        ws!.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });

        ws!.once('error', (err) => {
          clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
      break;
    } catch (err) {
      try { ws.close(); } catch {
      }
      if (startupAttempt >= startupRetries) {
        throw err;
      }
      const backoffMs = Math.min(30_000, startupBackoffBaseMs * Math.pow(2, startupAttempt - 1));
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  if (!ws) {
    throw new Error('Failed to initialize ElevenLabs realtime websocket');
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as {
        message_type?: string;
        text?: string;
        language_code?: string;
        error?: { code?: string; message?: string };
      };

      const type = String(msg.message_type || '').toLowerCase();
      if (type === 'committed_transcript' || type === 'committed_transcript_with_timestamps') {
        const text = String(msg.text || '').trim();
        if (text) {
          onTranscript(text, msg.language_code);
        }
        return;
      }

      if (type.startsWith('scribe_') && type.endsWith('_error')) {
        const detail = msg.error?.message || msg.error?.code || type;
        errorReported = true;
        onError?.(new Error(`ElevenLabs realtime error: ${detail}`));
      }
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  ws.on('error', (err) => {
    errorReported = true;
    onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  ws.on('close', () => {
    if (!closedExplicitly && !errorReported) {
      onError?.(new Error('ElevenLabs realtime connection closed unexpectedly'));
    }
  });

  while (sendQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
    const payload = sendQueue.shift();
    if (payload) ws.send(payload);
  }

  return {
    send: (audio: Buffer) => {
      const mono16 = pcm48StereoTo16Mono(audio);
      if (!mono16.length) return;
      const payload = JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: mono16.toString('base64'),
        sample_rate: 16000,
        commit: false,
      });

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      } else if (ws.readyState === WebSocket.CONNECTING) {
        sendQueue.push(payload);
      }
    },
    close: () => {
      closedExplicitly = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}

export function isElevenLabsRealtimeAvailable(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}