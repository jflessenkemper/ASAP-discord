import { Readable, Transform } from 'stream';

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
import prism from 'prism-media';

import { isDeepgramAvailable, startLiveTranscription, DeepgramLiveSession } from './deepgram';
import { startElevenLabsRealtimeTranscription, ElevenLabsRealtimeSession, isElevenLabsRealtimeAvailable } from './elevenlabsRealtime';
import { transcribeVoiceDetailed } from './tts';

const DEFAULT_TESTER_BOT_ID = '1487426371209789450';

function decodeBotIdFromToken(token: string): string | null {
  try {
    const head = String(token || '').split('.')[0];
    if (!head) return null;
    const normalized = head.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8').trim();
    return /^\d{16,22}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function isTesterBotId(userId: string): boolean {
  const configured = String(process.env.DISCORD_TESTER_BOT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const tokenDerived = decodeBotIdFromToken(process.env.DISCORD_TEST_BOT_TOKEN || '');
  const allowed = new Set([DEFAULT_TESTER_BOT_ID, ...configured, ...(tokenDerived ? [tokenDerived] : [])]);
  return allowed.has(userId);
}

function isTranscribableMember(member: GuildMember): boolean {
  if (!member.user.bot) return true;
  return isTesterBotId(member.id);
}

let currentConnection: VoiceConnection | null = null;
let audioPlayer: AudioPlayer | null = null;
let isCleaningUp = false;
const VOICE_REALTIME_MODE = String(process.env.VOICE_REALTIME_MODE || 'true').toLowerCase() !== 'false';

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
  options?: { signal?: AbortSignal; onPlaybackStart?: () => void }
): Promise<void> {
  if (!currentConnection || !audioPlayer) {
    throw new Error('Not connected to a voice channel');
  }
  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error('TTS returned empty audio buffer');
  }

  const stream = Readable.from(audioBuffer);
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
      options?.onPlaybackStart?.();
    };
    const onIdle = () => {
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
  sttProvider?: 'deepgram' | 'gemini' | 'elevenlabs';
}

function getSttProviderPreference(): 'deepgram' | 'elevenlabs' | 'gemini' {
  if (VOICE_REALTIME_MODE && isElevenLabsRealtimeAvailable()) {
    return 'elevenlabs';
  }
  if (VOICE_REALTIME_MODE && isDeepgramAvailable()) {
    return 'deepgram';
  }
  const configured = String(process.env.VOICE_STT_PROVIDER || '').trim().toLowerCase();
  if (configured === 'elevenlabs') return 'elevenlabs';
  if (configured === 'gemini') return 'gemini';
  return 'elevenlabs';
}

/** Max consecutive resubscribes before giving up (prevents infinite loop on broken streams) */
const MAX_RESUBSCRIBES = 500;
/** Max audio buffer size (5 MB) — reject oversized buffers */
const MAX_AUDIO_BUFFER = 5 * 1024 * 1024;
const VOICE_MIN_AUDIO_BYTES = parseInt(process.env.VOICE_MIN_AUDIO_BYTES || '48000', 10);
const VOICE_SHORT_BUFFER_COALESCE_WINDOW_MS = Math.max(500, parseInt(process.env.VOICE_SHORT_BUFFER_COALESCE_WINDOW_MS || '2500', 10));
const MAX_DEEPGRAM_SESSION_RETRIES = parseInt(process.env.MAX_DEEPGRAM_SESSION_RETRIES || '3', 10);
const VOICE_ENDPOINT_SILENCE_BASE_MS = parseInt(process.env.VOICE_ENDPOINT_SILENCE_BASE_MS || '900', 10);
const VOICE_ENDPOINT_SILENCE_MIN_MS = parseInt(process.env.VOICE_ENDPOINT_SILENCE_MIN_MS || '650', 10);
const VOICE_ENDPOINT_SILENCE_MAX_MS = parseInt(process.env.VOICE_ENDPOINT_SILENCE_MAX_MS || '1400', 10);
const VOICE_ENDPOINT_STATE_TTL_MS = Math.max(300_000, parseInt(process.env.VOICE_ENDPOINT_STATE_TTL_MS || '7200000', 10));
const VOICE_ENDPOINT_CLEANUP_INTERVAL_MS = Math.max(60_000, parseInt(process.env.VOICE_ENDPOINT_CLEANUP_INTERVAL_MS || '600000', 10));

const voiceEndpointingByUser = new Map<string, { silenceMs: number; lastAudioBytes: number; turns: number; updatedAt: number }>();
const pendingShortAudioByUser = new Map<string, { audio: Buffer; capturedAt: number }>();

function pruneVoiceEndpointingState(now = Date.now()): void {
  for (const [userId, state] of voiceEndpointingByUser.entries()) {
    if (now - state.updatedAt > VOICE_ENDPOINT_STATE_TTL_MS) {
      voiceEndpointingByUser.delete(userId);
    }
  }
}

const voiceEndpointCleanupTimer = setInterval(() => {
  pruneVoiceEndpointingState();
}, VOICE_ENDPOINT_CLEANUP_INTERVAL_MS);
voiceEndpointCleanupTimer.unref();

function getAdaptiveSilenceDuration(userId: string): number {
  const state = voiceEndpointingByUser.get(userId);
  if (!state) return VOICE_ENDPOINT_SILENCE_BASE_MS;
  return Math.max(VOICE_ENDPOINT_SILENCE_MIN_MS, Math.min(VOICE_ENDPOINT_SILENCE_MAX_MS, Math.round(state.silenceMs)));
}

function updateAdaptiveSilenceDuration(userId: string, audioBytes: number): void {
  const prev = voiceEndpointingByUser.get(userId) || { silenceMs: VOICE_ENDPOINT_SILENCE_BASE_MS, lastAudioBytes: 0, turns: 0, updatedAt: Date.now() };
  const next = { ...prev };
  next.lastAudioBytes = audioBytes;
  next.turns += 1;
  next.updatedAt = Date.now();

  if (audioBytes < VOICE_MIN_AUDIO_BYTES * 2) {
    next.silenceMs = Math.max(VOICE_ENDPOINT_SILENCE_MIN_MS, next.silenceMs - 80);
  } else if (audioBytes > VOICE_MIN_AUDIO_BYTES * 6) {
    next.silenceMs = Math.min(VOICE_ENDPOINT_SILENCE_MAX_MS, next.silenceMs + 120);
  } else {
    next.silenceMs = next.silenceMs + (VOICE_ENDPOINT_SILENCE_BASE_MS - next.silenceMs) * 0.2;
  }

  voiceEndpointingByUser.set(userId, next);
  if (voiceEndpointingByUser.size > 5000) {
    pruneVoiceEndpointingState();
  }
}

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
  onTranscription: (transcription: VoiceTranscription) => void,
  onSpeechStart?: (member: GuildMember) => void
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
      end: { behavior: EndBehaviorType.AfterSilence, duration: getAdaptiveSilenceDuration(member.id) },
    });

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
    let utteranceStartAt: number | null = null;
    let speechStartNotified = false;

    decoder.on('data', (chunk: Buffer) => {
      if (utteranceStartAt === null) {
        utteranceStartAt = Date.now();
      }
      if (!speechStartNotified) {
        speechStartNotified = true;
        onSpeechStart?.(member);
      }
      totalSize += chunk.length;
      if (totalSize <= MAX_AUDIO_BUFFER) {
        chunks.push(chunk);
      }
    });

    decoder.on('end', async () => {
      if (destroyed) return;

      if (chunks.length > 0 && totalSize <= MAX_AUDIO_BUFFER) {
        const rawAudioBuffer = Buffer.concat(chunks);
        const pending = pendingShortAudioByUser.get(member.id);
        const isPendingFresh = Boolean(pending && (Date.now() - pending.capturedAt) <= VOICE_SHORT_BUFFER_COALESCE_WINDOW_MS);
        const audioBuffer = isPendingFresh && pending
          ? Buffer.concat([pending.audio, rawAudioBuffer])
          : rawAudioBuffer;
        pendingShortAudioByUser.delete(member.id);

        if (audioBuffer.length >= VOICE_MIN_AUDIO_BYTES) {
          updateAdaptiveSilenceDuration(member.id, audioBuffer.length);
          try {
            const result = await transcribeVoiceDetailed(audioBuffer);
            const text = result.text;
            if (text && !destroyed) {
              onTranscription({
                userId: member.id,
                username: member.displayName,
                text,
                timestamp: new Date(),
                sttLatencyMs: utteranceStartAt ? Date.now() - utteranceStartAt : undefined,
                sttProvider: result.provider,
              });
            }
          } catch (err) {
            console.error('Voice transcription error:', err instanceof Error ? err.message : 'Unknown');
          }
        } else {
          updateAdaptiveSilenceDuration(member.id, audioBuffer.length);
          pendingShortAudioByUser.set(member.id, {
            audio: audioBuffer,
            capturedAt: Date.now(),
          });
          console.debug(`Coalescing short voice buffer for ${member.displayName}: ${audioBuffer.length} bytes < ${VOICE_MIN_AUDIO_BYTES}`);
        }
      } else if (totalSize > MAX_AUDIO_BUFFER) {
        console.warn(`Audio buffer exceeded ${MAX_AUDIO_BUFFER} bytes for ${member.displayName} — skipped`);
        pendingShortAudioByUser.delete(member.id);
      }

      subscribe();
    });

    decoder.on('error', (err: Error) => {
      console.error(`Decoder stream error for ${member.displayName}:`, err.message);
      if (!destroyed) subscribe();
    });

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
  onTranscription: (transcription: VoiceTranscription) => void,
  onSpeechStart?: (member: GuildMember) => void
): () => void {
  const unsubscribers: Array<() => void> = [];
  const listeningUserIds = new Set<string>();
  let destroyed = false;

  for (const [, member] of voiceChannel.members) {
    if (!isTranscribableMember(member)) continue;
    listeningUserIds.add(member.id);
    const unsub = listenToUser(connection, member, onTranscription, onSpeechStart);
    unsubscribers.push(unsub);
  }

  const onSpeaking = (userId: string) => {
    if (destroyed || listeningUserIds.has(userId)) return;
    const member = voiceChannel.members.get(userId);
    if (!member || !isTranscribableMember(member)) return;
    listeningUserIds.add(userId);
    const unsub = listenToUser(connection, member, onTranscription, onSpeechStart);
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
  onTranscription: (transcription: VoiceTranscription) => void,
  onSpeechStart?: (member: GuildMember) => void
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
    }
    try {
      currentDecoder?.destroy();
    } catch {
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

      function subscribe() {
        if (destroyed) return;

        cleanupReceiveChain();

        const subscription = receiver.subscribe(member.id, {
          end: { behavior: EndBehaviorType.AfterInactivity, duration: getAdaptiveSilenceDuration(member.id) },
        });
        currentSubscription = subscription;
        utteranceStartAt = null;
        firstTranscriptPending = true;

        let decoder: Transform;
        try {
          decoder = createOpusDecoder();
        } catch (err) {
          console.error(`Opus decoder error for ${member.displayName}:`, err instanceof Error ? err.message : 'Unknown');
          return;
        }
        currentDecoder = decoder;
        subscription.pipe(decoder);

        let speechStartNotified = false;

        decoder.on('data', (chunk: Buffer) => {
          if (utteranceStartAt === null) {
            utteranceStartAt = Date.now();
          }
          if (!speechStartNotified) {
            speechStartNotified = true;
            onSpeechStart?.(member);
          }
          if (!destroyed && dgSession) {
            dgSession.send(chunk);
          }
        });

        decoder.on('end', () => {
          if (utteranceStartAt !== null) {
            const approxBytes = Math.max(VOICE_MIN_AUDIO_BYTES, Math.floor((Date.now() - utteranceStartAt) * 192));
            updateAdaptiveSilenceDuration(member.id, approxBytes);
          }
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
    }
    try {
      currentDecoder?.destroy();
    } catch {
    }
    dgSession?.close();
    fallbackUnsub?.();
  };
}

/**
 * Real-time listener using ElevenLabs streaming STT.
 */
export function listenToUserElevenLabsRealtime(
  connection: VoiceConnection,
  member: GuildMember,
  onTranscription: (transcription: VoiceTranscription) => void,
  onSpeechStart?: (member: GuildMember) => void
): () => void {
  let destroyed = false;
  let elSession: ElevenLabsRealtimeSession | null = null;
  let fallbackUnsub: (() => void) | null = null;
  let currentSubscription: Readable | null = null;
  let currentDecoder: Transform | null = null;
  let realtimeRetryAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let utteranceStartAt: number | null = null;
  let firstTranscriptPending = false;

  const receiver = connection.receiver;

  function cleanupReceiveChain(): void {
    try {
      currentSubscription?.destroy();
    } catch {
    }
    try {
      currentDecoder?.destroy();
    } catch {
    }
    currentSubscription = null;
    currentDecoder = null;
  }

  function fallbackToBatch(reason: string): void {
    if (destroyed || fallbackUnsub) return;
    console.warn(`ElevenLabs realtime unavailable for ${member.displayName} — ${reason}. Falling back to batch STT`);
    cleanupReceiveChain();
    elSession?.close();
    elSession = null;
    fallbackUnsub = listenToUser(connection, member, onTranscription);
  }

  function scheduleRetry(reason: string): void {
    if (destroyed || fallbackUnsub) return;
    const normalizedReason = reason.toLowerCase();
    if (normalizedReason.includes('unauthorized') || normalizedReason.includes('quota')) {
      fallbackToBatch(reason);
      return;
    }
    if (realtimeRetryAttempts >= MAX_DEEPGRAM_SESSION_RETRIES) {
      fallbackToBatch(reason);
      return;
    }

    const delayMs = 1000 * Math.pow(2, realtimeRetryAttempts);
    realtimeRetryAttempts += 1;
    cleanupReceiveChain();
    elSession?.close();
    elSession = null;
    console.warn(`Retrying ElevenLabs realtime for ${member.displayName} in ${delayMs}ms (${realtimeRetryAttempts}/${MAX_DEEPGRAM_SESSION_RETRIES}) — ${reason}`);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!destroyed && !fallbackUnsub) {
        startSession();
      }
    }, delayMs);
  }

  function startSession(): void {
    startElevenLabsRealtimeTranscription(
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
            sttProvider: 'elevenlabs',
          });
        }
      },
      (err) => {
        console.error(`ElevenLabs realtime error for ${member.displayName}:`, err.message);
        scheduleRetry(err.message);
      }
    ).then((session) => {
      if (destroyed || fallbackUnsub) {
        session.close();
        return;
      }
      elSession = session;
      realtimeRetryAttempts = 0;

      function subscribe() {
        if (destroyed) return;

        cleanupReceiveChain();

        const subscription = receiver.subscribe(member.id, {
          end: { behavior: EndBehaviorType.AfterInactivity, duration: getAdaptiveSilenceDuration(member.id) },
        });
        currentSubscription = subscription;
        utteranceStartAt = null;
        firstTranscriptPending = true;

        let decoder: Transform;
        try {
          decoder = createOpusDecoder();
        } catch (err) {
          console.error(`Opus decoder error for ${member.displayName}:`, err instanceof Error ? err.message : 'Unknown');
          return;
        }
        currentDecoder = decoder;
        subscription.pipe(decoder);

        let speechStartNotified = false;

        decoder.on('data', (chunk: Buffer) => {
          if (utteranceStartAt === null) {
            utteranceStartAt = Date.now();
          }
          if (!speechStartNotified) {
            speechStartNotified = true;
            onSpeechStart?.(member);
          }
          if (!destroyed && elSession) {
            elSession.send(chunk);
          }
        });

        decoder.on('end', () => {
          if (utteranceStartAt !== null) {
            const approxBytes = Math.max(VOICE_MIN_AUDIO_BYTES, Math.floor((Date.now() - utteranceStartAt) * 192));
            updateAdaptiveSilenceDuration(member.id, approxBytes);
          }
          if (!destroyed) {
            setTimeout(() => {
              if (!destroyed) subscribe();
            }, 120);
          }
        });

        decoder.on('error', (err: Error) => {
          console.error(`ElevenLabs realtime decoder error for ${member.displayName}:`, err.message);
          if (!destroyed) {
            setTimeout(() => {
              if (!destroyed) subscribe();
            }, 250);
          }
        });

        subscription.on('end', () => { decoder.end(); });
        subscription.on('error', (err: Error) => {
          console.error(`ElevenLabs realtime voice subscription error for ${member.displayName}:`, err.message);
          decoder.end();
        });
      }

      subscribe();
    }).catch((err) => {
      console.error(`Failed to start ElevenLabs realtime for ${member.displayName}:`, err instanceof Error ? err.message : 'Unknown');
      scheduleRetry(err instanceof Error ? err.message : 'startup failure');
    });
  }

  const startTimeout = setTimeout(() => {
    if (!elSession && !destroyed && !fallbackUnsub) {
      fallbackToBatch('session start timed out');
    }
  }, 10_000);

  startSession();

  return () => {
    destroyed = true;
    if (retryTimer) clearTimeout(retryTimer);
    clearTimeout(startTimeout);
    cleanupReceiveChain();
    try {
      currentSubscription?.destroy();
    } catch {
    }
    try {
      currentDecoder?.destroy();
    } catch {
    }
    elSession?.close();
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
  onTranscription: (transcription: VoiceTranscription) => void,
  onSpeechStart?: (member: GuildMember) => void
): () => void {
  const preference = getSttProviderPreference();

  if (preference === 'elevenlabs' && VOICE_REALTIME_MODE && isElevenLabsRealtimeAvailable()) {
    console.log('Using ElevenLabs real-time STT for voice transcription');
    return listenToAllMembersElevenLabsRealtime(connection, voiceChannel, onTranscription, onSpeechStart);
  }

  if (preference === 'deepgram' && isDeepgramAvailable()) {
    console.log('Using Deepgram real-time STT for voice transcription');
    return listenToAllMembersDeepgram(connection, voiceChannel, onTranscription, onSpeechStart);
  }

  if (preference === 'elevenlabs') {
    console.log('Using ElevenLabs batch STT for voice transcription');
    return listenToAllMembers(connection, voiceChannel, onTranscription, onSpeechStart);
  }

  console.log('Using Gemini batch STT for voice transcription (Deepgram not configured)');
  return listenToAllMembers(connection, voiceChannel, onTranscription, onSpeechStart);
}

/**
 * Deepgram version of listenToAllMembers — real-time streaming STT.
 */
function listenToAllMembersDeepgram(
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  onTranscription: (transcription: VoiceTranscription) => void,
  onSpeechStart?: (member: GuildMember) => void
): () => void {
  const unsubscribers: Array<() => void> = [];
  const listeningUserIds = new Set<string>();
  let destroyed = false;

  for (const [, member] of voiceChannel.members) {
    if (!isTranscribableMember(member)) continue;
    listeningUserIds.add(member.id);
    const unsub = listenToUserDeepgram(connection, member, onTranscription, onSpeechStart);
    unsubscribers.push(unsub);
  }

  const onSpeaking = (userId: string) => {
    if (destroyed || listeningUserIds.has(userId)) return;
    const member = voiceChannel.members.get(userId);
    if (!member || !isTranscribableMember(member)) return;
    listeningUserIds.add(userId);
    const unsub = listenToUserDeepgram(connection, member, onTranscription, onSpeechStart);
    unsubscribers.push(unsub);
  };
  connection.receiver.speaking.on('start', onSpeaking);

  return () => {
    destroyed = true;
    connection.receiver.speaking.off('start', onSpeaking);
    for (const unsub of unsubscribers) unsub();
  };
}

function listenToAllMembersElevenLabsRealtime(
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  onTranscription: (transcription: VoiceTranscription) => void,
  onSpeechStart?: (member: GuildMember) => void
): () => void {
  const unsubscribers: Array<() => void> = [];
  const listeningUserIds = new Set<string>();
  let destroyed = false;

  for (const [, member] of voiceChannel.members) {
    if (!isTranscribableMember(member)) continue;
    listeningUserIds.add(member.id);
    const unsub = listenToUserElevenLabsRealtime(connection, member, onTranscription, onSpeechStart);
    unsubscribers.push(unsub);
  }

  const onSpeaking = (userId: string) => {
    if (destroyed || listeningUserIds.has(userId)) return;
    const member = voiceChannel.members.get(userId);
    if (!member || !isTranscribableMember(member)) return;
    listeningUserIds.add(userId);
    const unsub = listenToUserElevenLabsRealtime(connection, member, onTranscription, onSpeechStart);
    unsubscribers.push(unsub);
  };
  connection.receiver.speaking.on('start', onSpeaking);

  return () => {
    destroyed = true;
    connection.receiver.speaking.off('start', onSpeaking);
    for (const unsub of unsubscribers) unsub();
  };
}
