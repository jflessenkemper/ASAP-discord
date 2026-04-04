import { Client, GatewayIntentBits, VoiceBasedChannel } from 'discord.js';
import { entersState, joinVoiceChannel, VoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';

let testerClient: Client | null = null;
let testerReady = false;
let testerReadyPromise: Promise<void> | null = null;
let testerVoiceConnection: VoiceConnection | null = null;

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
    selfMute: true,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 10000);
  testerVoiceConnection = connection;
}

export function leaveTesterVoiceChannel(): void {
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
