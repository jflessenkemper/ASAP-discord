import {
  Guild,
  ChannelType,
  TextChannel,
  VoiceChannel,
  CategoryChannel,
} from 'discord.js';
import { getAgents } from './agents';
import { getWebhook } from './services/webhooks';

const CAT_MAIN = 'ASAP';
const CAT_AGENTS = 'Agents';
const CAT_OPS = 'Operations';

export interface BotChannels {
  agentChannels: Map<string, TextChannel>;
  groupchat: TextChannel;
  github: TextChannel;
  callLog: TextChannel;
  limits: TextChannel;
  screenshots: TextChannel;
  url: TextChannel;
  terminal: TextChannel;
  voiceChannel: VoiceChannel;
}

/** Find or create a category by name. */
async function findOrCreateCategory(guild: Guild, name: string): Promise<CategoryChannel> {
  let cat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name
  ) as CategoryChannel | undefined;

  if (!cat) {
    cat = await guild.channels.create({ name, type: ChannelType.GuildCategory });
  }
  return cat;
}

/** Find a text channel by name anywhere in the guild (ignores category). */
function findTextChannel(guild: Guild, name: string): TextChannel | undefined {
  return guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name
  ) as TextChannel | undefined;
}

/** Delete duplicate text channels with the same name, keeping the oldest one. */
async function deduplicateChannel(guild: Guild, name: string): Promise<TextChannel | undefined> {
  const matches = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildText && c.name === name
  );
  if (matches.size <= 1) return matches.first() as TextChannel | undefined;

  // Keep the oldest, delete the rest
  const sorted = [...matches.values()].sort(
    (a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0)
  );
  const keep = sorted[0] as TextChannel;
  for (let i = 1; i < sorted.length; i++) {
    try { await sorted[i].delete('Removing duplicate channel'); } catch { /* ignore */ }
  }
  return keep;
}

/**
 * Set up all required channels in the guild, organized under categories:
 *   ASAP        — groupchat, command (voice)
 *   Agents      — per-agent work log channels
 *   Operations  — github, call-log, limits
 *
 * Cleans up duplicate channels left from previous runs.
 */
export async function setupChannels(guild: Guild): Promise<BotChannels> {
  const agents = getAgents();

  // Ensure caches are fresh
  await guild.channels.fetch();

  // ── One-time channel reset (set RESET_CHANNELS=true env var to trigger) ──
  if (process.env.RESET_CHANNELS === 'true') {
    console.log('🔄 RESET_CHANNELS=true — deleting all managed channels for fresh recreation...');
    const managedCategories = [CAT_MAIN, CAT_AGENTS, CAT_OPS];
    for (const catName of managedCategories) {
      const cat = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name === catName
      ) as CategoryChannel | undefined;
      if (cat) {
        // Delete all children first
        for (const child of cat.children.cache.values()) {
          try { await child.delete('Channel reset'); } catch { /* ignore */ }
        }
        // Delete the category itself
        try { await cat.delete('Channel reset'); } catch { /* ignore */ }
      }
    }
    // Refresh cache after deletions
    await guild.channels.fetch();
    console.log('✅ Channel reset complete — recreating...');
  }

  // ── Categories ──
  const catMain = await findOrCreateCategory(guild, CAT_MAIN);
  const catAgents = await findOrCreateCategory(guild, CAT_AGENTS);
  const catOps = await findOrCreateCategory(guild, CAT_OPS);

  // ── Helper: ensure a text channel exists (deduplicate, move to correct category) ──
  async function ensureText(
    name: string,
    parent: CategoryChannel,
    topic: string,
    welcomeMessage?: string
  ): Promise<TextChannel> {
    let channel = await deduplicateChannel(guild, name);

    if (channel) {
      // Move to correct category if needed
      if (channel.parentId !== parent.id) {
        await channel.setParent(parent, { lockPermissions: false });
      }
    } else {
      channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent,
        topic,
      });
      if (welcomeMessage) await channel.send(welcomeMessage);
    }
    return channel;
  }

  // ── ASAP (main) ──
  const groupchat = await ensureText(
    'groupchat',
    catMain,
    '💬 Talk to Riley naturally. She coordinates everything.',
    `**ASAP Command Center**\n\n` +
      `📋 **Riley (Executive Assistant)** is your point of contact.\n` +
      `💻 **Ace (Developer)** implements what Riley plans.\n\n` +
      `Just type naturally — Riley handles everything.\n` +
      `She can join voice calls, deploy, take screenshots, and coordinate the whole team.\n\n` +
      `You can also @mention any agent directly (e.g. @ace, @kane, @elena).`
  );

  // Voice channel under main
  let voiceChannel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildVoice && c.name === 'command'
  ) as VoiceChannel | undefined;

  if (voiceChannel) {
    if (voiceChannel.parentId !== catMain.id) {
      await voiceChannel.setParent(catMain, { lockPermissions: false });
    }
  } else {
    voiceChannel = await guild.channels.create({
      name: 'command',
      type: ChannelType.GuildVoice,
      parent: catMain,
    });
  }

  // ── Agents ──
  const agentChannels = new Map<string, TextChannel>();
  for (const [agentId, agent] of agents) {
    const channel = await ensureText(
      agent.channelName,
      catAgents,
      `${agent.emoji} ${agent.name} — work log and notes`,
      `${agent.emoji} **${agent.name}** work log.\nThis channel shows what ${agent.name.split(' ')[0]} is working on.`
    );
    agentChannels.set(agentId, channel);
  }

  // ── Operations ──
  const github = await ensureText(
    'github',
    catOps,
    '📦 Live GitHub activity feed — commits, PRs, issues, releases',
    `📦 **GitHub Activity Feed**\n\nThis channel shows real-time updates from the ASAP repository.\nCommits, pull requests, issues, releases, and more.`
  );

  const callLog = await ensureText(
    'call-log',
    catOps,
    '📋 Automatic transcripts and summaries of voice calls'
  );

  const limits = await ensureText(
    'limits',
    catOps,
    '📊 API usage limits, costs, and remaining credits — updated every 5 minutes'
  );

  const screenshots = await ensureText(
    'screenshots',
    catOps,
    '📸 Automated screenshots of every app screen after each build (iPhone 17 Pro Max)',
    `📸 **Build Screenshots**\n\nAutomated screenshots of every screen captured on iPhone 17 Pro Max viewport after each successful build.`
  );

  const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
  const url = await ensureText(
    'url',
    catOps,
    '🔗 Live app URL and build links — updated on every deploy',
    `🔗 **ASAP URLs**\n\n` +
      `🌐 **App**: ${appUrl}\n` +
      `📦 **Cloud Build**: https://console.cloud.google.com/cloud-build/builds?project=asap-489910\n` +
      `☁️ **Cloud Run**: https://console.cloud.google.com/run/detail/australia-southeast1/asap?project=asap-489910`
  );

  const terminal = await ensureText(
    'terminal',
    catOps,
    '💻 Live feed of all tool calls made by agents — file ops, git, commands, searches',
    `💻 **Agent Terminal**\n\nReal-time log of every tool invocation by any agent.\nFile reads, writes, edits, searches, git ops, commands, and more.`
  );

  // ── Clean up old agent channels without emoji prefix ──
  const agentIds = [...agents.keys()]; // e.g. 'qa', 'developer', 'lawyer'
  for (const oldName of agentIds) {
    const oldChannel = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === oldName
    );
    if (oldChannel) {
      try {
        await oldChannel.delete('Replaced by emoji-prefixed channel');
        console.log(`  Deleted old channel: #${oldName}`);
      } catch { /* ignore */ }
    }
  }

  // ── Clean up old "ASAP Agents" category if empty ──
  const oldCat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === 'ASAP Agents'
  );
  if (oldCat) {
    const children = guild.channels.cache.filter((c) => c.parentId === oldCat.id);
    if (children.size === 0) {
      try { await oldCat.delete('Replaced by new category structure'); } catch { /* ignore */ }
    }
  }

  // ── Pre-create webhooks for all text channels (parallel) ──
  const allTextChannels = [groupchat, github, callLog, limits, screenshots, url, terminal, ...agentChannels.values()];
  console.log('🔗 Pre-creating webhooks for all channels...');
  const webhookResults = await Promise.allSettled(
    allTextChannels.map((channel) => getWebhook(channel))
  );
  const failed = webhookResults.filter((r) => r.status === 'rejected').length;
  if (failed > 0) console.warn(`  ⚠️ ${failed}/${allTextChannels.length} webhook(s) failed`);
  console.log('✅ Webhooks ready');

  return { agentChannels, groupchat, github, callLog, limits, screenshots, url, terminal, voiceChannel };
}
