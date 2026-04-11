import 'dotenv/config';
import { ChannelType, Client, GatewayIntentBits } from 'discord.js';
import { setupChannels } from './src/discord/setup';

async function cleanGuildMessages(token: string, guildId: string): Promise<{channels:number;deleted:number;failed:number}> {
  const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
  const guildRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers });
  if (!guildRes.ok) throw new Error(`List channels failed: ${guildRes.status}`);
  const channels = (await guildRes.json()) as Array<{ id: string; name: string; type: number }>;
  const targetTypes = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);
  const targets = channels.filter((c) => targetTypes.has(c.type));

  let totalDeleted = 0;
  let failedChannels = 0;
  for (const ch of targets) {
    let deleted = 0;
    let before: string | undefined;
    let failed = false;
    for (;;) {
      if (deleted >= 500) break;
      const qs = new URLSearchParams({ limit: '100' });
      if (before) qs.set('before', before);
      const listRes = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages?${qs.toString()}`, { headers });
      if (!listRes.ok) { failed = true; break; }
      const msgs = (await listRes.json()) as Array<{ id: string }>;
      if (!msgs.length) break;
      before = msgs[msgs.length - 1]?.id;
      for (const msg of msgs) {
        if (deleted >= 500) break;
        const delRes = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages/${msg.id}`, { method: 'DELETE', headers });
        if (delRes.ok || delRes.status === 404) { deleted += 1; totalDeleted += 1; continue; }
        if (delRes.status === 429) {
          const body = await delRes.json().catch(() => ({} as any));
          const retryMs = Math.ceil((Number(body?.retry_after) || 1) * 1000) + 100;
          await new Promise((r) => setTimeout(r, retryMs));
          continue;
        }
      }
    }
    if (failed) failedChannels += 1;
  }
  return { channels: targets.length, deleted: totalDeleted, failed: failedChannels };
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_TEST_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) throw new Error('Missing DISCORD_TEST_BOT_TOKEN or DISCORD_GUILD_ID');

  console.log('Cleaning channels (non-destructive)...');
  const cleaned = await cleanGuildMessages(token, guildId);
  console.log(`Cleanup complete: channels=${cleaned.channels} deleted=${cleaned.deleted} failed_channels=${cleaned.failed}`);

  console.log('Repopulating automation/ops channels...');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    void client.login(token).catch(reject);
  });
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();
  await guild.roles.fetch();
  await setupChannels(guild);
  await client.destroy();
  console.log('Repopulation complete.');
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
