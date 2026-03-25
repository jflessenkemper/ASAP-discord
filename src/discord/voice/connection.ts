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
      audioPlayer!.off(AudioPlayerStatus.Idle, onIdle);
      audioPlayer!.off('error', onError);
      clearTimeout(timeout);
    };

    audioPlayer!.on(AudioPlayerStatus.Idle, onIdle);
    audioPlayer!.on('error', onError);
    audioPlayer!.play(resource);
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
  const receiver = connection.receiver;

  function subscribe() {
    if (destroyed) return;

    const subscription = receiver.subscribe(member.id, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
    });

    const chunks: Buffer[] = [];

    subscription.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    subscription.on('end', async () => {
      if (destroyed) return;

      if (chunks.length > 0) {
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
 * Returns a single cleanup function that stops listening to everyone.
 */
export function listenToAllMembers(
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  onTranscription: (transcription: VoiceTranscription) => void
): () => void {
  const unsubscribers: Array<() => void> = [];

  // Listen to existing members
  for (const [, member] of voiceChannel.members) {
    if (member.user.bot) continue;
    const unsub = listenToUser(connection, member, onTranscription);
    unsubscribers.push(unsub);
  }

  return () => {
    for (const unsub of unsubscribers) {
      unsub();
    }
  };
}
