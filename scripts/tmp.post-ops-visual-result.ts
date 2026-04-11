import { ChannelType, Client, GatewayIntentBits, TextChannel } from 'discord.js';

const TARGET_CHANNELS = ['💻-terminal', '📸-screenshots', '📋-decisions'] as const;

async function main(): Promise<void> {
  const token = process.env.DISCORD_TEST_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) throw new Error('Missing DISCORD_TEST_BOT_TOKEN or DISCORD_GUILD_ID');

  const message = [
    '🧪 Visual regression cycle complete (asap-bot-vm).',
    'Baseline: PASS (2 screenshots created).',
    'Check: FAIL (1 mismatch).',
    'Mismatch: home.desktop.png changed 0.662% (8586/1296000 pixels).',
    'Threshold: VISUAL_MAX_DIFF_PERCENT=0.5% (default).',
    'Artifacts on VM:',
    '- /opt/asap-bot/server/visual-regression/baseline',
    '- /opt/asap-bot/server/visual-regression/current',
    '- /opt/asap-bot/server/visual-regression/diff',
    'Next step: review diff image and either accept as new baseline or treat as regression.',
  ].join('\n');

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  await client.login(token);

  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();

  const posted: Array<{ channel: string; ok: boolean; reason?: string }> = [];
  for (const name of TARGET_CHANNELS) {
    const channel = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === name) as TextChannel | undefined;
    if (!channel) {
      posted.push({ channel: name, ok: false, reason: 'missing channel' });
      continue;
    }
    await channel.send(message);
    posted.push({ channel: name, ok: true });
  }

  console.log(JSON.stringify(posted, null, 2));
  await client.destroy();
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
