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

import { startElevenLabsRealtimeTranscription, ElevenLabsRealtimeSession, isElevenLabsRealtimeAvailable } from './elevenlabsRealtime';
import { openConvaiCallSession, isConvaiStreamingAvailable, ConvaiCallSession } from './convaiCallSession';
import { transcribeVoiceDetailed } from './tts';
import { errMsg } from '../../utils/errors';
import { isTesterBotId } from '../../utils/botIdentity';



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
      cleanup();
      if (aborted) {
        reject(new Error('Playback aborted'));
      } else {
        // For very short clips the player may transition to Idle before Playing is observed.
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

export interface VoiceTranscription {
  userId: string;
  username: string;
  text: string;
  timestamp: Date;
  /** Detected language code from ElevenLabs STT (for example 'en' or 'zh'). */
  language?: string;
  /** Approximate end-to-end STT latency for this utterance. */
  sttLatencyMs?: number;
  /** STT provider used for this transcript. */
  sttProvider?: 'elevenlabs';
}

function getSttProviderPreference(): 'elevenlabs' {
  return 'elevenlabs';
}

/** Max consecutive resubscribes before giving up (prevents infinite loop on broken streams) */
const MAX_RESUBSCRIBES = 500;
/** Max audio buffer size (5 MB) — reject oversized buffers */
const MAX_AUDIO_BUFFER = 5 * 1024 * 1024;
const VOICE_MIN_AUDIO_BYTES = parseInt(process.env.VOICE_MIN_AUDIO_BYTES || '48000', 10);
const VOICE_SHORT_BUFFER_COALESCE_WINDOW_MS = Math.max(500, parseInt(process.env.VOICE_SHORT_BUFFER_COALESCE_WINDOW_MS || '2500', 10));
const MAX_REALTIME_SESSION_RETRIES = parseInt(process.env.MAX_ELEVENLABS_REALTIME_SESSION_RETRIES || process.env.MAX_DEEPGRAM_SESSION_RETRIES || '3', 10);
const VOICE_ENDPOINT_SILENCE_BASE_MS = parseInt(process.env.VOICE_ENDPOINT_SILENCE_BASE_MS || '400', 10);
const VOICE_ENDPOINT_SILENCE_MIN_MS = parseInt(process.env.VOICE_ENDPOINT_SILENCE_MIN_MS || '350', 10);
const VOICE_ENDPOINT_SILENCE_MAX_MS = parseInt(process.env.VOICE_ENDPOINT_SILENCE_MAX_MS || '1000', 10);
const VOICE_ENDPOINT_STATE_TTL_MS = Math.max(300_000, parseInt(process.env.VOICE_ENDPOINT_STATE_TTL_MS || '1800000', 10));
const VOICE_ENDPOINT_CLEANUP_INTERVAL_MS = Math.max(60_000, parseInt(process.env.VOICE_ENDPOINT_CLEANUP_INTERVAL_MS || '120000', 10));

const voiceEndpointingByUser = new Map<string, { silenceMs: number; lastAudioBytes: number; turns: number; updatedAt: number }>();
const pendingShortAudioByUser = new Map<string, { audio: Buffer; capturedAt: number }>();
const SHORT_AUDIO_STATE_TTL_MS = Math.max(10_000, parseInt(process.env.VOICE_SHORT_AUDIO_STATE_TTL_MS || '120000', 10));

function pruneVoiceEndpointingState(now = Date.now()): void {
  for (const [userId, state] of voiceEndpointingByUser.entries()) {
    if (now - state.updatedAt > VOICE_ENDPOINT_STATE_TTL_MS) {
      voiceEndpointingByUser.delete(userId);
    }
  }
  for (const [userId, state] of pendingShortAudioByUser.entries()) {
    if (now - state.capturedAt > SHORT_AUDIO_STATE_TTL_MS) {
      pendingShortAudioByUser.delete(userId);
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
    throw new Error(`Failed to initialize Opus decoder: ${errMsg(err)}`);
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
  let currentSubscription: Readable | null = null;
  let currentDecoder: Transform | null = null;

  function cleanupCurrentChain(): void {
    if (currentSubscription && currentDecoder) {
      try { currentSubscription.unpipe(currentDecoder); } catch {
      }
    }
    try { currentSubscription?.destroy(); } catch {
    }
    try { currentDecoder?.destroy(); } catch {
    }
    currentSubscription = null;
    currentDecoder = null;
  }

  function subscribe() {
    if (destroyed) return;
    cleanupCurrentChain();
    resubscribeCount++;
    if (resubscribeCount >= MAX_RESUBSCRIBES) {
      console.warn(`Argus resubscribes (${MAX_RESUBSCRIBES}) reached for ${member.displayName} — stopping listener`);
      pendingShortAudioByUser.delete(member.id);
      return; // Stop listening instead of continuing forever
    }

    const subscription = receiver.subscribe(member.id, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: getAdaptiveSilenceDuration(member.id) },
    });
    currentSubscription = subscription;

    let decoder: Transform;
    try {
      decoder = createOpusDecoder();
    } catch (err) {
      console.error(`Opus decoder error for ${member.displayName}:`, errMsg(err));
      return;
    }
    currentDecoder = decoder;
    subscription.pipe(decoder);

    const chunks: Buffer[] = [];
    let totalSize = 0;
    let utteranceStartAt: number | null = null;
    let speechStartNotified = false;

    const onDecoderData = (chunk: Buffer) => {
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
    };

    const onDecoderEnd = async () => {
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
            console.error('Voice transcription error:', errMsg(err));
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
    };

    const onDecoderError = (err: Error) => {
      console.error(`Decoder stream error for ${member.displayName}:`, err.message);
      if (!destroyed) subscribe();
    };

    const onSubscriptionEnd = () => { decoder.end(); };
    const onSubscriptionError = (err: Error) => {
      console.error(`Voice subscription error for ${member.displayName}:`, err.message);
      decoder.end();
    };

    decoder.on('data', onDecoderData);
    decoder.on('end', onDecoderEnd);
    decoder.on('error', onDecoderError);
    subscription.on('end', onSubscriptionEnd);
    subscription.on('error', onSubscriptionError);

    const detach = () => {
      decoder.off('data', onDecoderData);
      decoder.off('end', onDecoderEnd);
      decoder.off('error', onDecoderError);
      subscription.off('end', onSubscriptionEnd);
      subscription.off('error', onSubscriptionError);
    };
    decoder.once('close', detach);
    subscription.once('close', detach);
  }

  subscribe();

  return () => {
    destroyed = true;
    pendingShortAudioByUser.delete(member.id);
    cleanupCurrentChain();
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
  // Tracks how many transcripts the realtime session has actually delivered.
  // If we keep getting "connection closed unexpectedly" without ever
  // receiving a transcript, the endpoint is wedged for this caller and we
  // shouldn't burn the full retry budget — fall back to batch immediately.
  let transcriptsReceivedCount = 0;

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
    // If we've retried at least once and haven't received a single transcript,
    // the realtime endpoint is wedged for this caller — burn no more retries
    // and switch to batch STT now. Stops the close→retry→close loop Cortana
    // diagnosed during the April 2026 voice issue.
    if (realtimeRetryAttempts >= 1 && transcriptsReceivedCount === 0) {
      fallbackToBatch(`${reason} (no transcripts received in ${realtimeRetryAttempts} attempt(s))`);
      return;
    }
    if (realtimeRetryAttempts >= MAX_REALTIME_SESSION_RETRIES) {
      fallbackToBatch(reason);
      return;
    }

    const delayMs = 1000 * Math.pow(2, realtimeRetryAttempts);
    realtimeRetryAttempts += 1;
    cleanupReceiveChain();
    elSession?.close();
    elSession = null;
    console.warn(`Retrying ElevenLabs realtime for ${member.displayName} in ${delayMs}ms (${realtimeRetryAttempts}/${MAX_REALTIME_SESSION_RETRIES}) — ${reason}`);
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
          transcriptsReceivedCount += 1;
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
          console.error(`Opus decoder error for ${member.displayName}:`, errMsg(err));
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
      console.error(`Failed to start ElevenLabs realtime for ${member.displayName}:`, errMsg(err));
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
 * Uses ElevenLabs realtime STT when available, otherwise ElevenLabs batch STT.
 */
export interface SmartListenerHandle {
  unsubscribe: () => void;
  /** Pre-init STT session for a member joining the channel (avoids cold start). */
  preInitMember: (member: GuildMember) => void;
  /**
   * Set when the active path is Convai streaming (audio in + audio out
   * over one WS). callSession listens for agent turns here so it can
   * play the audio directly without re-running TTS.
   */
  onAgentTurn?: (cb: (text: string, audio: Buffer, language?: string) => void) => void;
  /** Live PCM chunk (16 kHz mono s16le) — fires per audio_event from Convai. */
  onAgentAudioChunk?: (cb: (pcmChunk: Buffer) => void) => void;
  /** Final agent text once Convai finishes generating it (per turn). */
  onAgentText?: (cb: (text: string) => void) => void;
  /** Fires when the agent's current turn ends (inactivity gap). */
  onAgentTurnEnd?: (cb: () => void) => void;
  /** Convai detected the user interrupted the agent. */
  onUserInterruption?: (cb: () => void) => void;
}

export function listenToAllMembersSmart(
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  onTranscription: (transcription: VoiceTranscription) => void,
  onSpeechStart?: (member: GuildMember) => void
): SmartListenerHandle {
  const preference = getSttProviderPreference();

  // Preferred path: long-lived Convai streaming WS — Convai handles VAD,
  // STT, LLM, and TTS server-side. Audio frames stream in; agent text +
  // audio stream back. Skips the Scribe → Claude → TTS round-trip and
  // saves a full WS per turn. Disable with VOICE_CONVAI_STREAMING=false.
  const convaiStreamingDisabled = String(process.env.VOICE_CONVAI_STREAMING || 'true').toLowerCase() === 'false';
  if (!convaiStreamingDisabled && isConvaiStreamingAvailable()) {
    console.log('Using ElevenLabs Convai streaming for voice (audio in + audio out)');
    return listenToAllMembersConvaiStreaming(connection, voiceChannel, onTranscription, onSpeechStart);
  }

  if (preference === 'elevenlabs' && VOICE_REALTIME_MODE && isElevenLabsRealtimeAvailable()) {
    console.log('Using ElevenLabs real-time STT for voice transcription');
    return listenToAllMembersElevenLabsRealtime(connection, voiceChannel, onTranscription, onSpeechStart);
  }

  const batchUnsub = preference === 'elevenlabs'
    ? (console.log('Using ElevenLabs batch STT for voice transcription'), listenToAllMembers(connection, voiceChannel, onTranscription, onSpeechStart))
    : (console.log('Using ElevenLabs batch STT for voice transcription'), listenToAllMembers(connection, voiceChannel, onTranscription, onSpeechStart));
  return { unsubscribe: batchUnsub, preInitMember: () => {} };
}

/**
 * Convai-streaming path: one long-lived WS for the whole call. Every
 * member's PCM audio gets routed into the same Convai session. Convai
 * does VAD + STT + LLM + TTS server-side and emits agent text + audio
 * frames back. Multi-speaker note: Convai treats all incoming audio as
 * one speaker; if multiple humans talk simultaneously the agent's
 * transcript will read as a single mixed stream. Acceptable trade-off
 * for the typical 1:1 voice flow.
 */
function listenToAllMembersConvaiStreaming(
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  onTranscription: (transcription: VoiceTranscription) => void,
  onSpeechStart?: (member: GuildMember) => void,
): SmartListenerHandle {
  let destroyed = false;
  let convaiSession: ConvaiCallSession | null = null;
  const subscriberCleanups: Array<() => void> = [];
  const listening = new Set<string>();
  const memberById = new Map<string, GuildMember>();
  let agentTurnCb: ((text: string, audio: Buffer, language?: string) => void) | null = null;
  let agentAudioChunkCb: ((pcm: Buffer) => void) | null = null;
  let agentTextCb: ((text: string) => void) | null = null;
  let agentTurnEndCb: (() => void) | null = null;
  let userInterruptionCb: (() => void) | null = null;
  let lastSpeechStartAt = 0;

  function attachMemberAudio(member: GuildMember): void {
    if (destroyed || listening.has(member.id)) return;
    if (!isTranscribableMember(member)) return;
    listening.add(member.id);
    memberById.set(member.id, member);

    // ConvAI streaming path: use Manual end behavior so the subscription
    // stays open for the entire call. ConvAI handles VAD server-side —
    // we just pipe a continuous audio stream. This eliminates the 600ms+
    // silence gap + 120-250ms re-subscribe delay that the batch STT path
    // needs, cutting round-trip latency by ~800ms.
    const subscription = connection.receiver.subscribe(member.id, {
      end: { behavior: EndBehaviorType.Manual },
    });
    let decoder: Transform;
    try {
      decoder = createOpusDecoder();
    } catch (err) {
      console.error(`Convai opus decoder error for ${member.displayName}:`, errMsg(err));
      return;
    }
    subscription.pipe(decoder);
    decoder.on('data', (chunk: Buffer) => {
      // Throttle onSpeechStart callbacks so callers (typing indicators)
      // don't get spammed. 250ms gate is enough for UI responsiveness.
      if (Date.now() - lastSpeechStartAt > 250) {
        lastSpeechStartAt = Date.now();
        onSpeechStart?.(member);
      }
      if (!destroyed && convaiSession?.isOpen) {
        convaiSession.sendUserAudio(chunk);
      }
    });
    decoder.on('error', (err: Error) => {
      console.warn(`Convai decoder error for ${member.displayName}:`, err.message);
    });

    subscriberCleanups.push(() => {
      try { subscription.destroy(); } catch { /* ignore */ }
      try { decoder.destroy(); } catch { /* ignore */ }
    });
  }

  // Open the Convai WS up front so audio chunks have a place to land.
  void openConvaiCallSession({
    onUserTranscript: (text, language) => {
      if (destroyed) return;
      // Convai doesn't tell us *which* member spoke. Best-effort: pick the
      // most recent active member, otherwise the first one we know about.
      const member = [...memberById.values()][0];
      onTranscription({
        userId: member?.id || 'convai',
        username: member?.displayName || 'Caller',
        text,
        timestamp: new Date(),
        language,
        sttProvider: 'elevenlabs',
      });
    },
    onAgentTurn: (text, audio) => {
      if (destroyed) return;
      try { agentTurnCb?.(text, audio); } catch (err) { console.warn('[convai-stream] agentTurn cb threw:', errMsg(err)); }
    },
    onAgentAudioChunk: (chunk) => {
      if (destroyed) return;
      try { agentAudioChunkCb?.(chunk); } catch (err) { console.warn('[convai-stream] agentAudioChunk cb threw:', errMsg(err)); }
    },
    onAgentText: (text) => {
      if (destroyed) return;
      try { agentTextCb?.(text); } catch (err) { console.warn('[convai-stream] agentText cb threw:', errMsg(err)); }
    },
    onAgentTurnEnd: () => {
      if (destroyed) return;
      try { agentTurnEndCb?.(); } catch (err) { console.warn('[convai-stream] agentTurnEnd cb threw:', errMsg(err)); }
    },
    onUserInterruption: () => {
      if (destroyed) return;
      try { userInterruptionCb?.(); } catch (err) { console.warn('[convai-stream] userInterruption cb threw:', errMsg(err)); }
    },
    onError: (err) => {
      console.warn(`[convai-stream] error: ${err.message}`);
    },
    onClose: () => {
      // Convai socket closed; if the call is still active, future audio
      // chunks will be silently dropped. callSession will end the call
      // soon enough on its own.
    },
  })
    .then((session) => {
      if (destroyed) { session.close(); return; }
      convaiSession = session;
      // Attach member audio AFTER the WS is open so we don't drop chunks.
      for (const [, member] of voiceChannel.members) attachMemberAudio(member);
    })
    .catch((err) => {
      console.error('[convai-stream] failed to open session, falling back is required:', errMsg(err));
    });

  // Catch members joining mid-call.
  const onSpeaking = (userId: string) => {
    if (destroyed) return;
    const member = voiceChannel.members.get(userId);
    if (!member) return;
    attachMemberAudio(member);
  };
  connection.receiver.speaking.on('start', onSpeaking);

  return {
    unsubscribe: () => {
      destroyed = true;
      connection.receiver.speaking.off('start', onSpeaking);
      for (const cleanup of subscriberCleanups) cleanup();
      subscriberCleanups.length = 0;
      convaiSession?.close();
      convaiSession = null;
    },
    preInitMember: (member: GuildMember) => attachMemberAudio(member),
    onAgentTurn: (cb) => { agentTurnCb = cb; },
    onAgentAudioChunk: (cb) => { agentAudioChunkCb = cb; },
    onAgentText: (cb) => { agentTextCb = cb; },
    onAgentTurnEnd: (cb) => { agentTurnEndCb = cb; },
    onUserInterruption: (cb) => { userInterruptionCb = cb; },
  };
}

function listenToAllMembersElevenLabsRealtime(
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  onTranscription: (transcription: VoiceTranscription) => void,
  onSpeechStart?: (member: GuildMember) => void
): SmartListenerHandle {
  const unsubscribers: Array<() => void> = [];
  const listeningUserIds = new Set<string>();
  let destroyed = false;

  function initMember(member: GuildMember): void {
    if (destroyed || listeningUserIds.has(member.id)) return;
    if (!isTranscribableMember(member)) return;
    listeningUserIds.add(member.id);
    const unsub = listenToUserElevenLabsRealtime(connection, member, onTranscription, onSpeechStart);
    unsubscribers.push(unsub);
  }

  for (const [, member] of voiceChannel.members) {
    initMember(member);
  }

  const onSpeaking = (userId: string) => {
    if (destroyed || listeningUserIds.has(userId)) return;
    const member = voiceChannel.members.get(userId);
    if (!member) return;
    initMember(member);
  };
  connection.receiver.speaking.on('start', onSpeaking);

  return {
    unsubscribe: () => {
      destroyed = true;
      connection.receiver.speaking.off('start', onSpeaking);
      for (const unsub of unsubscribers) unsub();
    },
    preInitMember: (member) => initMember(member),
  };
}
