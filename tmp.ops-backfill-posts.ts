import { ChannelType, Client, GatewayIntentBits, TextChannel } from 'discord.js';

const TARGETS = [
  '🧵-thread-status',
  '📋-decisions',
  '📦-github',
  '📋-call-log',
  '💸-cost',
  '📸-screenshots',
  '💻-terminal',
  '🧯-voice-errors',
  '🚨-agent-errors',
] as const;

function messageFor(channelName: string): string {
  const now = new Date().toISOString();
  switch (channelName) {
    case '🧵-thread-status':
      return `🧵 Thread-status monitor ready. Next automated hourly summary will appear here. (${now})`;
    case '📋-decisions':
      return `📋 Decisions channel ready. Decision digests and approvals will be recorded here. (${now})`;
    case '📦-github':
      return `📦 GitHub feed ready. Commit/PR/release events will post here. (${now})`;
    case '📋-call-log':
      return `📋 Call log channel ready. Voice/session call records will appear here. (${now})`;
    case '💸-cost':
      return `💸 Cost monitor ready. Budget and spend summaries will post here. (${now})`;
    case '📸-screenshots':
      return `📸 Screenshot channel ready. Automated captures and visual diagnostics will post here. (${now})`;
    case '💻-terminal':
      return `💻 Terminal relay ready. Command execution outputs and automation traces will post here. (${now})`;
    case '🧯-voice-errors':
      return `🧯 Voice error feed ready. Runtime voice failures and latency diagnostics will post here. (${now})`;
    case '🚨-agent-errors':
      return `🚨 Agent error feed ready. Agent/runtime exceptions and alerts will post here. (${now})`;
    default:
      return `✅ Channel ready. (${now})`;
  }
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TEST_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) throw new Error('Missing DISCORD_BOT_TOKEN (or DISCORD_TEST_BOT_TOKEN) and/or DISCORD_GUILD_ID');

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  await client.login(token);

  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();

  const results: Array<{ channel: string; posted: boolean; reason?: string }> = [];

  for (const name of TARGETS) {
    const channel = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === name) as TextChannel | undefined;
    if (!channel) {
      results.push({ channel: name, posted: false, reason: 'missing' });
      continue;
    }

    const latest = await channel.messages.fetch({ limit: 1 }).catch(() => null);
    if (latest && latest.size > 0) {
      results.push({ channel: name, posted: false, reason: 'already-has-post' });
      continue;
    }

    await channel.send(messageFor(name));
    results.push({ channel: name, posted: true });
  }

  console.log(JSON.stringify(results, null, 2));
  await client.destroy();
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
