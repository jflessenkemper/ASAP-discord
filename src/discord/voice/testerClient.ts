import { Client, GatewayIntentBits, VoiceBasedChannel } from 'discord.js';
import {
  entersState,
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  AudioPlayer,
  AudioPlayerStatus,
  StreamType,
} from '@discordjs/voice';
import { Readable } from 'stream';
import { textToSpeech } from './tts';

let testerClient: Client | null = null;
let testerReady = false;
let testerReadyPromise: Promise<void> | null = null;
let testerVoiceConnection: VoiceConnection | null = null;
let testerAudioPlayer: AudioPlayer | null = null;

function isEnabled(): boolean {
  return String(process.env.ASAPTESTER_VOICE_CLIENT_ENABLED || 'true').toLowerCase() !== 'false';
}

function getTesterToken(): string {
  return String(process.env.DISCORD_TEST_BOT_TOKEN || '').trim();
}

async function ensureTesterClient(): Promise<Client> {
  if (!isEnabled()) {
    throw new Error('ASAPTester voice client is disabled (ASAPTESTER_VOICE_CLIENT_ENABLED=false).');
  }

  const token = getTesterToken();
  if (!token) {
    throw new Error('DISCORD_TEST_BOT_TOKEN is missing.');
  }

  if (testerClient && testerReady) return testerClient;

  if (!testerClient) {
    testerClient = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    testerReadyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ASAPTester login timed out after 15s.')), 15000);
      testerClient?.once('ready', () => {
        clearTimeout(timeout);
        testerReady = true;
        resolve();
      });
      testerClient?.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    await testerClient.login(token);
  }

  if (testerReadyPromise) {
    await testerReadyPromise;
  }

  if (!testerClient) {
    throw new Error('Failed to initialize ASAPTester Discord client.');
  }

  return testerClient;
}

export async function joinTesterVoiceChannel(channel: VoiceBasedChannel): Promise<void> {
  const client = await ensureTesterClient();

  const guild = await client.guilds.fetch(channel.guild.id);
  const testerChannel = await guild.channels.fetch(channel.id);
  if (!testerChannel || !('isVoiceBased' in testerChannel) || !testerChannel.isVoiceBased()) {
    throw new Error('ASAPTester could not resolve the target voice channel.');
  }

  if (testerVoiceConnection) {
    try {
      testerVoiceConnection.destroy();
    } catch {
    } finally {
      testerVoiceConnection = null;
    }
  }

  const connection = joinVoiceChannel({
    channelId: testerChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 10000);
  testerAudioPlayer = createAudioPlayer();
  connection.subscribe(testerAudioPlayer);
  testerVoiceConnection = connection;
}

export async function speakAsTesterInVoice(text: string, language?: string): Promise<void> {
  if (!testerVoiceConnection || !testerAudioPlayer) {
    throw new Error('ASAPTester is not connected to voice.');
  }

  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Tester speech text is empty.');
  }

  const testerVoice = process.env.ASAPTESTER_VOICE_NAME || 'Achernar';
  const audio = await textToSpeech(trimmed, testerVoice, language);
  const resource = createAudioResource(Readable.from(audio), { inputType: StreamType.Arbitrary });

  await new Promise<void>((resolve, reject) => {
    const player = testerAudioPlayer;
    if (!player) {
      reject(new Error('Tester audio player is unavailable.'));
      return;
    }

    let started = false;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(started ? 'Tester playback timed out.' : 'Tester playback did not start in time.'));
    }, 20000);

    const cleanup = () => {
      clearTimeout(timeout);
      player.off(AudioPlayerStatus.Playing, onPlaying);
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
    };

    const onPlaying = () => {
      started = true;
    };
    const onIdle = () => {
      if (!started) return;
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    player.on(AudioPlayerStatus.Playing, onPlaying);
    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onError);
    player.play(resource);
  });
}

export function leaveTesterVoiceChannel(): void {
  if (testerAudioPlayer) {
    try {
      testerAudioPlayer.stop(true);
    } catch {
    } finally {
      testerAudioPlayer = null;
    }
  }
  if (!testerVoiceConnection) return;
  try {
    testerVoiceConnection.destroy();
  } catch {
  } finally {
    testerVoiceConnection = null;
  }
}

export function isTesterVoiceConnected(): boolean {
  return testerVoiceConnection !== null;
}
