import { ChannelType, Client, GatewayIntentBits, Message } from 'discord.js';

const CHANNELS = [
  '🧵-thread-status',
  '📋-decisions',
  '📦-github',
  '🆙-upgrades',
  '🧰-tools',
  '📋-call-log',
  '📊-limits',
  '💸-cost',
  '📸-screenshots',
  '🔗-url',
  '💻-terminal',
  '🧯-voice-errors',
  '🚨-agent-errors',
] as const;

function sampleMessage(msg: Message | undefined): string {
  if (!msg) return '';
  const content = String(msg.content || '').trim();
  const embedText = String(msg.embeds?.[0]?.description || msg.embeds?.[0]?.title || '').trim();
  return (content || embedText).slice(0, 140);
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_TEST_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) throw new Error('Missing DISCORD_TEST_BOT_TOKEN or DISCORD_GUILD_ID');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  await client.login(token);
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();

  const rows: Array<Record<string, unknown>> = [];

  for (const name of CHANNELS) {
    const channel = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === name);
    if (!channel || !channel.isTextBased()) {
      rows.push({ channel: name, exists: false, hasPost: false });
      continue;
    }

    const fetched = await channel.messages.fetch({ limit: 1 }).catch(() => null);
    const latest = fetched?.first();

    rows.push({
      channel: name,
      exists: true,
      hasPost: !!latest,
      lastAuthor: latest ? (latest.webhookId ? 'webhook' : latest.author.bot ? 'bot' : 'user') : null,
      lastAt: latest ? new Date(latest.createdTimestamp).toISOString() : null,
      sample: sampleMessage(latest),
    });
  }

  console.log(JSON.stringify(rows, null, 2));
  await client.destroy();
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
