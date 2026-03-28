import 'dotenv/config';
import { ChannelType, Client, GatewayIntentBits, Message } from 'discord.js';

type TesterConfig = {
  token: string;
  channelId: string;
  message: string;
  expectedContains?: string;
  timeoutMs: number;
  targetBotId?: string;
};

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function parseArgs(): TesterConfig {
  const token = process.env.DISCORD_TEST_BOT_TOKEN || '';
  const channelId = readArg('channel') || process.env.DISCORD_TEST_CHANNEL_ID || '';
  const message = readArg('message') || process.env.DISCORD_TEST_MESSAGE || 'ping';
  const expectedContains = readArg('expect') || process.env.DISCORD_TEST_EXPECT || undefined;
  const targetBotId = readArg('target-bot-id') || process.env.DISCORD_TARGET_BOT_ID || undefined;
  const timeoutMsRaw = readArg('timeout-ms') || process.env.DISCORD_TEST_TIMEOUT_MS || '30000';
  const timeoutMs = Number(timeoutMsRaw);

  if (!token) {
    throw new Error('Missing DISCORD_TEST_BOT_TOKEN. Set it in env or pass via process env.');
  }
  if (!channelId) {
    throw new Error('Missing test channel. Use --channel=<channelId> or DISCORD_TEST_CHANNEL_ID.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeout-ms value: ${timeoutMsRaw}`);
  }

  return {
    token,
    channelId,
    message,
    expectedContains,
    timeoutMs,
    targetBotId,
  };
}

function isCandidateReply(reply: Message, sentAt: number, selfBotId: string, targetBotId?: string): boolean {
  if (reply.createdTimestamp < sentAt) return false;
  if (reply.author.id === selfBotId) return false;
  if (targetBotId && reply.author.id !== targetBotId) return false;
  if (!targetBotId && reply.author.bot === false) return false;
  return true;
}

async function run(): Promise<void> {
  const config = parseArgs();
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  const timeoutHandle = setTimeout(() => {
    console.error(`FAIL: Timeout waiting for reply after ${config.timeoutMs}ms`);
    void client.destroy();
    process.exit(1);
  }, config.timeoutMs);

  client.once('ready', async () => {
    try {
      const channel = await client.channels.fetch(config.channelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new Error(`Channel ${config.channelId} is not a text guild channel`);
      }

      const sent = await channel.send(config.message);
      console.log(`Sent: ${config.message}`);

      const collector = channel.createMessageCollector({ time: config.timeoutMs });
      collector.on('collect', (msg) => {
        if (!client.user) return;
        if (!isCandidateReply(msg, sent.createdTimestamp, client.user.id, config.targetBotId)) return;

        const content = msg.content || '';
        const passesContains = config.expectedContains
          ? content.toLowerCase().includes(config.expectedContains.toLowerCase())
          : true;

        if (!passesContains) return;

        clearTimeout(timeoutHandle);
        collector.stop('matched');
        console.log(`PASS: ${msg.author.tag} -> ${content.slice(0, 500)}`);
        void client.destroy();
        process.exit(0);
      });

      collector.on('end', (_collected, reason) => {
        if (reason === 'matched') return;
        clearTimeout(timeoutHandle);
        console.error('FAIL: Collector ended without a matching reply');
        void client.destroy();
        process.exit(1);
      });
    } catch (err) {
      clearTimeout(timeoutHandle);
      console.error('FAIL:', err instanceof Error ? err.message : String(err));
      void client.destroy();
      process.exit(1);
    }
  });

  client.on('error', (err) => {
    clearTimeout(timeoutHandle);
    console.error('FAIL: Discord client error:', err.message);
    void client.destroy();
    process.exit(1);
  });

  await client.login(config.token);
}

void run();
