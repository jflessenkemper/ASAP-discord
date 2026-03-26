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
} from '@discordjs/voice';
import { VoiceBasedChannel, GuildMember } from 'discord.js';
import { Readable } from 'stream';
import { transcribeVoice } from './tts';
import { isDeepgramAvailable, startLiveTranscription, DeepgramLiveSession } from './deepgram';

let currentConnection: VoiceConnection | null = null;
let audioPlayer: AudioPlayer | null = null;

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
  if (audioPlayer) {
    audioPlayer.stop();
    audioPlayer = null;
  }
  if (currentConnection) {
    currentConnection.destroy();
    currentConnection = null;
  }
}

/**
 * Speak audio in the currently connected voice channel.
 * Accepts a raw audio buffer (PCM/WAV).
 * Uses event-based completion instead of blocking entersState.
 */
export async function speakInVC(audioBuffer: Buffer): Promise<void> {
  if (!currentConnection || !audioPlayer) {
    throw new Error('Not connected to a voice channel');
  }

  const stream = Readable.from(audioBuffer);
  const resource = createAudioResource(stream);

  return new Promise<void>((resolve, reject) => {
    const player = audioPlayer;
    if (!player) {
      reject(new Error('Audio player not available'));
      return;
    }
    const onIdle = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve(); // Don't throw on timeout — just continue
    }, 30_000);

    const cleanup = () => {
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
      clearTimeout(timeout);
    };

    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onError);
    player.play(resource);
  });
}

export function getConnection(): VoiceConnection | null {
  return currentConnection;
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
}

/** Max consecutive resubscribes before giving up (prevents infinite loop on broken streams) */
const MAX_RESUBSCRIBES = 500;
/** Max audio buffer size (5 MB) — reject oversized buffers */
const MAX_AUDIO_BUFFER = 5 * 1024 * 1024;

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

    const chunks: Buffer[] = [];
    let totalSize = 0;

    subscription.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize <= MAX_AUDIO_BUFFER) {
        chunks.push(chunk);
      }
    });

    subscription.on('end', async () => {
      if (destroyed) return;

      if (chunks.length > 0 && totalSize <= MAX_AUDIO_BUFFER) {
        const audioBuffer = Buffer.concat(chunks);
        // Need at least ~0.5s of audio (rough threshold)
        if (audioBuffer.length >= 8000) {
          try {
            const text = await transcribeVoice(audioBuffer);
            if (text && !destroyed) {
              onTranscription({
                userId: member.id,
                username: member.displayName,
                text,
                timestamp: new Date(),
              });
            }
          } catch (err) {
            console.error('Voice transcription error:', err instanceof Error ? err.message : 'Unknown');
          }
        }
      } else if (totalSize > MAX_AUDIO_BUFFER) {
        console.warn(`Audio buffer exceeded ${MAX_AUDIO_BUFFER} bytes for ${member.displayName} — skipped`);
      }

      // Re-subscribe for next utterance (non-recursive — just calls subscribe again)
      subscribe();
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

  const receiver = connection.receiver;

  // Start Deepgram session with timeout fallback
  const dgTimeout = setTimeout(() => {
    if (!dgSession && !destroyed) {
      console.warn(`Deepgram session start timed out for ${member.displayName} — falling back to Gemini batch STT`);
      // Fall back to Gemini listener instead of going silent
      fallbackUnsub = listenToUser(connection, member, onTranscription);
    }
  }, 10_000);

  startLiveTranscription(
    (text, detectedLanguage) => {
      if (!destroyed && text.trim()) {
        onTranscription({
          userId: member.id,
          username: member.displayName,
          text: text.trim(),
          timestamp: new Date(),
          language: detectedLanguage,
        });
      }
    },
    (err) => {
      console.error(`Deepgram error for ${member.displayName}:`, err.message);
      // On runtime error, fall back to Gemini if not already
      if (!destroyed && !fallbackUnsub) {
        console.warn(`Deepgram runtime error — falling back to Gemini for ${member.displayName}`);
        dgSession = null;
        fallbackUnsub = listenToUser(connection, member, onTranscription);
      }
    }
  ).then((session) => {
    clearTimeout(dgTimeout);
    if (destroyed || fallbackUnsub) {
      // Already fell back to Gemini or was cleaned up
      session.close();
      return;
    }
    dgSession = session;

    // Subscribe to user's audio and pipe it to Deepgram
    function subscribe() {
      if (destroyed) return;

      const subscription = receiver.subscribe(member.id, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
      });

      subscription.on('data', (chunk: Buffer) => {
        if (!destroyed && dgSession) {
          dgSession.send(chunk);
        }
      });

      subscription.on('end', () => {
        if (!destroyed) subscribe(); // Re-subscribe for next utterance
      });
    }

    subscribe();
  }).catch((err) => {
    clearTimeout(dgTimeout);
    console.error(`Failed to start Deepgram for ${member.displayName}:`, err instanceof Error ? err.message : 'Unknown');
    // Fall back to Gemini
    if (!destroyed && !fallbackUnsub) {
      console.warn(`Deepgram connection failed — falling back to Gemini for ${member.displayName}`);
      fallbackUnsub = listenToUser(connection, member, onTranscription);
    }
  });

  return () => {
    destroyed = true;
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
