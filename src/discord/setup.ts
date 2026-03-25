import {
  Guild,
  ChannelType,
  TextChannel,
  VoiceChannel,
  CategoryChannel,
} from 'discord.js';
import { getAgents } from './agents';

const CAT_MAIN = 'ASAP';
const CAT_AGENTS = 'Agents';
const CAT_OPS = 'Operations';

export interface BotChannels {
  agentChannels: Map<string, TextChannel>;
  groupchat: TextChannel;
  github: TextChannel;
  callLog: TextChannel;
  limits: TextChannel;
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
    '💬 Talk to Riley. She coordinates everything. Use /goal, /call, /status, /agents',
    `**ASAP Command Center**\n\n` +
      `📋 **Riley (Executive Assistant)** is your point of contact.\n` +
      `💻 **Ace (Developer)** implements what Riley plans.\n\n` +
      `**Slash Commands:**\n` +
      `\`/goal <description>\` — Give Riley a goal to plan and execute\n` +
      `\`/call\` — Start a voice call with Riley and Ace\n` +
      `\`/leave\` — End the voice call\n` +
      `\`/status\` — Show current progress\n` +
      `\`/agents\` — List all available agents\n` +
      `\`/ask <agent> <question>\` — Ask a specific agent directly\n` +
      `\`/clear\` — Reset conversation context\n\n` +
      `Or just type naturally — Riley handles everything. You can @mention agents directly too.`
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

  return { agentChannels, groupchat, github, callLog, limits, voiceChannel };
}
