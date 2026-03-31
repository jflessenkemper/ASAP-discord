import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  AudioPlayer,
  EndBehaviorType,
  StreamType,
} from '@discordjs/voice';
import { VoiceBasedChannel, GuildMember } from 'discord.js';
import { Readable, Transform } from 'stream';
import prism from 'prism-media';
import { transcribeVoice } from './tts';
import { isDeepgramAvailable, startLiveTranscription, DeepgramLiveSession } from './deepgram';

let currentConnection: VoiceConnection | null = null;
let audioPlayer: AudioPlayer | null = null;
let isCleaningUp = false;

/**
 * Join a voice channel and return the connection.
 */
export async function joinVC(channel: VoiceBasedChannel): Promise<VoiceConnection> {
  if (currentConnection) {
    currentConnection.destroy();
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  currentConnection = connection;
  audioPlayer = createAudioPlayer();
  connection.subscribe(audioPlayer);

  return connection;
}

/**
 * Leave the voice channel.
 */
export function leaveVC(): void {
  if (isCleaningUp) {
    console.warn('[VOICE] leaveVC called while cleanup is already in progress — skipping duplicate call');
    return;
  }
  isCleaningUp = true;
  try {
    if (audioPlayer) {
      try { audioPlayer.stop(); } catch { /* best-effort — player may already be stopping */ }
      audioPlayer = null;
    }
    if (currentConnection) {
      try { currentConnection.destroy(); } catch { /* best-effort — connection may already be destroyed */ }
      currentConnection = null;
    }
  } finally {
    isCleaningUp = false;
  }
}

/**
 * Speak audio in the currently connected voice channel.
 * Accepts a raw audio buffer (PCM/WAV).
 * Uses event-based completion instead of blocking entersState.
 */
export async function speakInVC(audioBuffer: Buffer): Promise<void> {
  return speakInVCWithOptions(audioBuffer);
}

export async function speakInVCWithOptions(
  audioBuffer: Buffer,
  options?: { signal?: AbortSignal }
): Promise<void> {
  if (!currentConnection || !audioPlayer) {
    throw new Error('Not connected to a voice channel');
  }
  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error('TTS returned empty audio buffer');
  }

  const stream = Readable.from(audioBuffer);
  // ElevenLabs returns MP3, Gemini may return WAV/PCM — use Arbitrary so
  // prism-media/FFmpeg auto-detects and transcodes to Opus for Discord.
  const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
  console.log(`VC playback: queued ${audioBuffer.length} bytes`);

  return new Promise<void>((resolve, reject) => {
    const player = audioPlayer;
    if (!player) {
      reject(new Error('Audio player not available'));
      return;
    }
    let sawPlaying = false;
    let aborted = false;

    const onPlaying = () => {
      sawPlaying = true;
      console.log('VC playback: started');
    };
    const onIdle = () => {
      // Ignore idle transitions before playback actually starts.
      if (!sawPlaying) return;
      cleanup();
      if (aborted) {
        reject(new Error('Playback aborted'));
      } else {
        resolve();
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timeout = setTimeout(() => {
      cleanup();
      if (!sawPlaying) {
        reject(new Error('Playback timed out before audio started (check ffmpeg/transcoding)'));
      } else {
        reject(new Error('Playback timed out before completion'));
      }
    }, 20_000);

    const cleanup = () => {
      player.off(AudioPlayerStatus.Playing, onPlaying);
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
      options?.signal?.removeEventListener('abort', onAbort);
      clearTimeout(timeout);
    };

    const onAbort = () => {
      aborted = true;
      stopVCPlayback();
    };

    player.on(AudioPlayerStatus.Playing, onPlaying);
    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onError);
    if (options?.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    player.play(resource);
  });
}

/** Immediately stop the current VC playback, if any. */
export function stopVCPlayback(): void {
  if (!audioPlayer) return;
  try {
    audioPlayer.stop(true);
  } catch {
    // best-effort
  }
}

export function getConnection(): VoiceConnection | null {
  return currentConnection;
}

/** Returns true if a voice connection is active and not currently being torn down. */
export function isVoiceActive(): boolean {
  return currentConnection !== null && !isCleaningUp;
}

export function getPlayer(): AudioPlayer | null {
  return audioPlayer;
}

export interface VoiceTranscription {
  userId: string;
  username: string;
  text: string;
  timestamp: Date;
  /** Detected language code from Deepgram (e.g. 'en', 'zh') */
  language?: string;
  /** Approximate end-to-end STT latency for this utterance. */
  sttLatencyMs?: number;
  /** STT provider used for this transcript. */
  sttProvider?: 'deepgram' | 'gemini';
}

/** Max consecutive resubscribes before giving up (prevents infinite loop on broken streams) */
const MAX_RESUBSCRIBES = 500;
/** Max audio buffer size (5 MB) — reject oversized buffers */
const MAX_AUDIO_BUFFER = 5 * 1024 * 1024;
const VOICE_MIN_AUDIO_BYTES = parseInt(process.env.VOICE_MIN_AUDIO_BYTES || '48000', 10);
const MAX_DEEPGRAM_SESSION_RETRIES = parseInt(process.env.MAX_DEEPGRAM_SESSION_RETRIES || '3', 10);

/**
 * Create a prism-media Opus decoder that converts Opus frames from the Discord
 * voice receiver into signed 16-bit LE PCM (48 kHz, stereo).
 * The receiver outputs raw Opus frames in objectMode — the decoder consumes
 * them and emits a continuous PCM stream that STT services expect.
 */
function createOpusDecoder(): Transform {
  try {
    return new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  } catch (err) {
    throw new Error(`Failed to initialize Opus decoder: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

/**
 * Start listening to a user's voice in the current connection.
 * Uses a non-recursive approach: re-subscribes via the receiver instead of
 * recursion to avoid stacking subscriptions and memory leaks.
 */
export function listenToUser(
  connection: VoiceConnection,
  member: GuildMember,
  onTranscription: (transcription: VoiceTranscription) => void
): () => void {
  let destroyed = false;
  let resubscribeCount = 0;
  const receiver = connection.receiver;

  function subscribe() {
    if (destroyed) return;
    resubscribeCount++;
    if (resubscribeCount >= MAX_RESUBSCRIBES) {
      console.warn(`Max resubscribes (${MAX_RESUBSCRIBES}) reached for ${member.displayName} — stopping listener`);
      return; // Stop listening instead of continuing forever
    }

    const subscription = receiver.subscribe(member.id, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
    });

    // Decode Opus frames → PCM (s16le, 48kHz, stereo) before collecting
    let decoder: Transform;
    try {
      decoder = createOpusDecoder();
    } catch (err) {
      console.error(`Opus decoder error for ${member.displayName}:`, err instanceof Error ? err.message : 'Unknown');
      return;
    }
    subscription.pipe(decoder);

    const chunks: Buffer[] = [];
    let totalSize = 0;
    const utteranceStartAt = Date.now();

    decoder.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize <= MAX_AUDIO_BUFFER) {
        chunks.push(chunk);
      }
    });

    decoder.on('end', async () => {
      if (destroyed) return;

      if (chunks.length > 0 && totalSize <= MAX_AUDIO_BUFFER) {
        const audioBuffer = Buffer.concat(chunks);
        // Need at least ~0.5s of PCM audio at 48kHz stereo (192 KB/s)
        if (audioBuffer.length >= VOICE_MIN_AUDIO_BYTES) {
          try {
            const text = await transcribeVoice(audioBuffer);
            if (text && !destroyed) {
              onTranscription({
                userId: member.id,
                username: member.displayName,
                text,
                timestamp: new Date(),
                sttLatencyMs: Date.now() - utteranceStartAt,
                sttProvider: 'gemini',
              });
            }
          } catch (err) {
            console.error('Voice transcription error:', err instanceof Error ? err.message : 'Unknown');
          }
        } else {
          console.debug(`Skipped short voice buffer for ${member.displayName}: ${audioBuffer.length} bytes < ${VOICE_MIN_AUDIO_BYTES}`);
        }
      } else if (totalSize > MAX_AUDIO_BUFFER) {
        console.warn(`Audio buffer exceeded ${MAX_AUDIO_BUFFER} bytes for ${member.displayName} — skipped`);
      }

      // Re-subscribe for next utterance (non-recursive — just calls subscribe again)
      subscribe();
    });

    decoder.on('error', (err: Error) => {
      console.error(`Decoder stream error for ${member.displayName}:`, err.message);
      if (!destroyed) subscribe();
    });

    // If the Opus subscription ends, make sure the decoder also ends
    subscription.on('end', () => { decoder.end(); });
    subscription.on('error', (err: Error) => {
      console.error(`Voice subscription error for ${member.displayName}:`, err.message);
      decoder.end();
    });
  }

  subscribe();

  return () => {
    destroyed = true;
  };
}

/**
 * Start listening to ALL voice members in the channel (multi-member support).
 * Also watches for new members joining mid-call via the receiver 'speaking' event.
 * Returns a single cleanup function that stops listening to everyone.
 */
export function listenToAllMembers(
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  onTranscription: (transcription: VoiceTranscription) => void
): () => void {
  const unsubscribers: Array<() => void> = [];
  const listeningUserIds = new Set<string>();
  let destroyed = false;

  // Listen to existing members
  for (const [, member] of voiceChannel.members) {
    if (member.user.bot) continue;
    listeningUserIds.add(member.id);
    const unsub = listenToUser(connection, member, onTranscription);
    unsubscribers.push(unsub);
  }

  // Listen for new members who join mid-call via the speaking event
  const onSpeaking = (userId: string) => {
    if (destroyed || listeningUserIds.has(userId)) return;
    const member = voiceChannel.members.get(userId);
    if (!member || member.user.bot) return;
    listeningUserIds.add(userId);
    const unsub = listenToUser(connection, member, onTranscription);
    unsubscribers.push(unsub);
  };
  connection.receiver.speaking.on('start', onSpeaking);

  return () => {
    destroyed = true;
    connection.receiver.speaking.off('start', onSpeaking);
    for (const unsub of unsubscribers) {
      unsub();
    }
  };
}

/**
 * Real-time listener using Deepgram streaming STT.
 * Instead of buffering silence-delimited chunks and batch-transcribing,
 * this streams raw audio to Deepgram and gets transcripts back in real-time
 * with ~200-400ms latency (vs ~1-2s for batch Gemini).
 *
 * Falls back to Gemini batch STT if Deepgram fails to start within 10s.
 */
export function listenToUserDeepgram(
  connection: VoiceConnection,
  member: GuildMember,
  onTranscription: (transcription: VoiceTranscription) => void
): () => void {
  let destroyed = false;
  let dgSession: DeepgramLiveSession | null = null;
  let fallbackUnsub: (() => void) | null = null;
  let currentSubscription: Readable | null = null;
  let currentDecoder: Transform | null = null;
  let deepgramRetryAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let utteranceStartAt: number | null = null;
  let firstTranscriptPending = false;

  const receiver = connection.receiver;

  function cleanupReceiveChain(): void {
    try {
      currentSubscription?.destroy();
    } catch {
      // best-effort
    }
    try {
      currentDecoder?.destroy();
    } catch {
      // best-effort
    }
    currentSubscription = null;
    currentDecoder = null;
  }

  function fallbackToGemini(reason: string): void {
    if (destroyed || fallbackUnsub) return;
    console.warn(`Deepgram unavailable for ${member.displayName} — ${reason}. Falling back to Gemini batch STT`);
    cleanupReceiveChain();
    dgSession?.close();
    dgSession = null;
    fallbackUnsub = listenToUser(connection, member, onTranscription);
  }

  function scheduleDeepgramRetry(reason: string): void {
    if (destroyed || fallbackUnsub) return;
    const normalizedReason = reason.toLowerCase();
    // Some transient disconnects recover poorly in long-lived sessions and cause
    // the "one response then silence" symptom. Fail over quickly to batch STT.
    if (normalizedReason.includes('closed unexpectedly') || normalizedReason.includes('unauthorized')) {
      fallbackToGemini(reason);
      return;
    }
    if (deepgramRetryAttempts >= MAX_DEEPGRAM_SESSION_RETRIES) {
      fallbackToGemini(reason);
      return;
    }

    const delayMs = 1000 * Math.pow(2, deepgramRetryAttempts);
    deepgramRetryAttempts += 1;
    cleanupReceiveChain();
    dgSession?.close();
    dgSession = null;
    console.warn(`Retrying Deepgram for ${member.displayName} in ${delayMs}ms (${deepgramRetryAttempts}/${MAX_DEEPGRAM_SESSION_RETRIES}) — ${reason}`);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!destroyed && !fallbackUnsub) {
        startSession();
      }
    }, delayMs);
  }

  function startSession(): void {
    startLiveTranscription(
      (text, detectedLanguage) => {
        if (!destroyed && text.trim()) {
          const sttLatencyMs = firstTranscriptPending && utteranceStartAt
            ? Date.now() - utteranceStartAt
            : undefined;
          firstTranscriptPending = false;
          onTranscription({
            userId: member.id,
            username: member.displayName,
            text: text.trim(),
            timestamp: new Date(),
            language: detectedLanguage,
            sttLatencyMs,
            sttProvider: 'deepgram',
          });
        }
      },
      (err) => {
        console.error(`Deepgram error for ${member.displayName}:`, err.message);
        scheduleDeepgramRetry(err.message);
      }
    ).then((session) => {
      if (destroyed || fallbackUnsub) {
        session.close();
        return;
      }
      dgSession = session;
      deepgramRetryAttempts = 0;

      // Subscribe to user's audio and pipe it to Deepgram
      function subscribe() {
        if (destroyed) return;

        cleanupReceiveChain();

        const subscription = receiver.subscribe(member.id, {
          // AfterInactivity is more resilient than AfterSilence for some clients
          // that send sparse/non-standard silence packets.
          end: { behavior: EndBehaviorType.AfterInactivity, duration: 2000 },
        });
        currentSubscription = subscription;
        utteranceStartAt = Date.now();
        firstTranscriptPending = true;

        // Decode Opus frames → PCM before sending to Deepgram (expects linear16)
        let decoder: Transform;
        try {
          decoder = createOpusDecoder();
        } catch (err) {
          console.error(`Opus decoder error for ${member.displayName}:`, err instanceof Error ? err.message : 'Unknown');
          return;
        }
        currentDecoder = decoder;
        subscription.pipe(decoder);

        decoder.on('data', (chunk: Buffer) => {
          if (!destroyed && dgSession) {
            dgSession.send(chunk);
          }
        });

        decoder.on('end', () => {
          if (!destroyed) {
            setTimeout(() => {
              if (!destroyed) subscribe();
            }, 120);
          }
        });

        decoder.on('error', (err: Error) => {
          console.error(`Deepgram decoder error for ${member.displayName}:`, err.message);
          if (!destroyed) {
            setTimeout(() => {
              if (!destroyed) subscribe();
            }, 250);
          }
        });

        // When Opus subscription ends, also end the decoder
        subscription.on('end', () => { decoder.end(); });
        subscription.on('error', (err: Error) => {
          console.error(`Deepgram voice subscription error for ${member.displayName}:`, err.message);
          decoder.end();
        });
      }

      subscribe();
    }).catch((err) => {
      console.error(`Failed to start Deepgram for ${member.displayName}:`, err instanceof Error ? err.message : 'Unknown');
      scheduleDeepgramRetry(err instanceof Error ? err.message : 'startup failure');
    });
  }

  // Start Deepgram session with timeout fallback
  const dgTimeout = setTimeout(() => {
    if (!dgSession && !destroyed && !fallbackUnsub) {
      fallbackToGemini('session start timed out');
    }
  }, 10_000);

  startSession();

  return () => {
    destroyed = true;
    if (retryTimer) clearTimeout(retryTimer);
    clearTimeout(dgTimeout);
    cleanupReceiveChain();
    try {
      currentSubscription?.destroy();
    } catch {
      // best-effort
    }
    try {
      currentDecoder?.destroy();
    } catch {
      // best-effort
    }
    dgSession?.close();
    fallbackUnsub?.();
  };
}

/**
 * Listen to all members using the best available STT.
 * Prefers Deepgram (real-time) over Gemini (batch) for lower latency.
 */
export function listenToAllMembersSmart(
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  onTranscription: (transcription: VoiceTranscription) => void
): () => void {
  // Use Deepgram if available for real-time streaming
  if (isDeepgramAvailable()) {
    console.log('Using Deepgram real-time STT for voice transcription');
    return listenToAllMembersDeepgram(connection, voiceChannel, onTranscription);
  }

  // Fall back to batch Gemini transcription
  console.log('Using Gemini batch STT for voice transcription (Deepgram not configured)');
  return listenToAllMembers(connection, voiceChannel, onTranscription);
}

/**
 * Deepgram version of listenToAllMembers — real-time streaming STT.
 */
function listenToAllMembersDeepgram(
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  onTranscription: (transcription: VoiceTranscription) => void
): () => void {
  const unsubscribers: Array<() => void> = [];
  const listeningUserIds = new Set<string>();
  let destroyed = false;

  for (const [, member] of voiceChannel.members) {
    if (member.user.bot) continue;
    listeningUserIds.add(member.id);
    const unsub = listenToUserDeepgram(connection, member, onTranscription);
    unsubscribers.push(unsub);
  }

  const onSpeaking = (userId: string) => {
    if (destroyed || listeningUserIds.has(userId)) return;
    const member = voiceChannel.members.get(userId);
    if (!member || member.user.bot) return;
    listeningUserIds.add(userId);
    const unsub = listenToUserDeepgram(connection, member, onTranscription);
    unsubscribers.push(unsub);
  };
  connection.receiver.speaking.on('start', onSpeaking);

  return () => {
    destroyed = true;
    connection.receiver.speaking.off('start', onSpeaking);
    for (const unsub of unsubscribers) unsub();
  };
}
