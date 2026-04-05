import {
  Guild,
  ChannelType,
  TextChannel,
  VoiceChannel,
  CategoryChannel,
  Role,
  PermissionFlagsBits,
} from 'discord.js';
import { getAgents, setAgentRoleId } from './agents';
import { getWebhook } from './services/webhooks';

const CAT_MAIN = 'ASAP';
const CAT_AGENTS = 'Agents';
const CAT_OPS = 'Operations';

const MAIN_CHANNELS = {
  groupchat: '💬-groupchat',
  threadStatus: '🧵-thread-status',
  decisions: '📋-decisions',
  voice: '🎤-voice',
} as const;

const OPS_CHANNELS = {
  github: '📦-github',
  upgrades: '🆙-upgrades',
  callLog: '📋-call-log',
  limits: '📊-limits',
  cost: '💸-cost',
  screenshots: '📸-screenshots',
  url: '🔗-url',
  terminal: '💻-terminal',
  voiceErrors: '🧯-voice-errors',
  agentErrors: '🚨-agent-errors',
} as const;

const LEGACY_ACCIDENTAL_CHANNELS = new Set([
  'developer',
  'qa',
  'security',
  'ux',
  'database',
  'devops',
  'legal',
  'copywriter',
  'performance',
  'api',
  '-groupchat',
  '-developer',
  '-qa',
  '-security',
  '-ux',
  '-database',
  '-devops',
  '-legal',
  '-copywriter',
  '-performance',
  '-api',
]);

const LEGACY_COMMAND_VOICE_CHANNELS = new Set([
  'command',
  '🎤-command',
  'voice-command',
  '🎤-voice-command',
]);

export interface BotChannels {
  agentChannels: Map<string, TextChannel>;
  groupchat: TextChannel;
  threadStatus: TextChannel;
  decisions: TextChannel;
  github: TextChannel;
  upgrades: TextChannel;
  callLog: TextChannel;
  limits: TextChannel;
  cost: TextChannel;
  screenshots: TextChannel;
  url: TextChannel;
  terminal: TextChannel;
  voiceErrors: TextChannel;
  agentErrors: TextChannel;
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

async function ensureAgentRole(guild: Guild, name: string, color: number): Promise<Role> {
  let role = guild.roles.cache.find((existing) => existing.name === name);

  if (!role) {
    role = await guild.roles.create({
      name,
      color,
      mentionable: true,
      hoist: false,
      permissions: [],
      reason: 'ASAP agent routing role',
    });
    return role;
  }

  const updates: Parameters<Role['edit']>[0] = {};
  if (role.color !== color) updates.color = color;
  if (!role.mentionable) updates.mentionable = true;
  if (Object.keys(updates).length > 0) {
    role = await role.edit({ ...updates, reason: 'Sync ASAP agent role metadata' });
  }

  return role;
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
 *   ASAP        — groupchat, voice
 *   Agents      — per-agent work log channels
 *   Operations  — github, upgrades, call-log, limits
 *
 * Cleans up duplicate channels left from previous runs.
 */
export async function setupChannels(guild: Guild): Promise<BotChannels> {
  const agents = getAgents();

  await guild.channels.fetch();
  await guild.roles.fetch();

  if (process.env.RESET_CHANNELS === 'true') {
    console.log('🔄 RESET_CHANNELS=true — deleting all managed channels for fresh recreation...');
    const managedCategories = [CAT_MAIN, CAT_AGENTS, CAT_OPS];
    for (const catName of managedCategories) {
      const cat = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name === catName
      ) as CategoryChannel | undefined;
      if (cat) {
        for (const child of cat.children.cache.values()) {
          try { await child.delete('Channel reset'); } catch { /* ignore */ }
        }
        try { await cat.delete('Channel reset'); } catch { /* ignore */ }
      }
    }
    await guild.channels.fetch();
    console.log('✅ Channel reset complete — recreating...');
  }

  const catMain = await findOrCreateCategory(guild, CAT_MAIN);
  const catAgents = await findOrCreateCategory(guild, CAT_AGENTS);
  const catOps = await findOrCreateCategory(guild, CAT_OPS);

  for (const [agentId, agent] of agents) {
    const role = await ensureAgentRole(guild, agent.roleName, agent.color);
    setAgentRoleId(agentId, role.id);
  }

  async function ensureText(
    name: string,
    parent: CategoryChannel,
    topic: string,
    welcomeMessage?: string
  ): Promise<TextChannel> {
    let channel = await deduplicateChannel(guild, name);

    if (channel) {
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

  const groupchat = await ensureText(
    MAIN_CHANNELS.groupchat,
    catMain,
    '💬 Talk to Riley naturally. She coordinates everything.',
    `**ASAP Command Center**\n\n` +
      `📋 **Riley (Executive Assistant)** is your point of contact.\n` +
      `💻 **Ace (Developer)** implements what Riley plans.\n\n` +
      `Just type naturally — Riley handles everything.\n` +
      `She can join voice calls, deploy, take screenshots, and coordinate the whole team.\n\n` +
        `You can also mention any agent role directly (for example Ace, Kane, or Elena). Plain-text handles still work as a fallback.`
  );

  const threadStatus = await ensureText(
    MAIN_CHANNELS.threadStatus,
    catOps,
    '🧵 Riley posts a fresh hourly summary of open workspace threads and close-ready items.',
    '🧵 Thread status snapshots post here.'
  );

  const decisions = await ensureText(
    MAIN_CHANNELS.decisions,
    catMain,
    '📋 Riley queues decisions here while you sleep. Reply to any decision to continue the work.',
    `📋 **Decisions Queue**\n\nWhen the team hits a decision point overnight, Riley posts it here instead of stopping work.\nReply to any decision with your answer — Riley will pick it up and continue.\nReact with a numbered emoji to choose from listed options.`
  );

  let voiceChannel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildVoice && c.name === MAIN_CHANNELS.voice
  ) as VoiceChannel | undefined;

  if (voiceChannel) {
    if (voiceChannel.parentId !== catMain.id) {
      await voiceChannel.setParent(catMain, { lockPermissions: false });
    }
  } else {
    voiceChannel = await guild.channels.create({
      name: MAIN_CHANNELS.voice,
      type: ChannelType.GuildVoice,
      parent: catMain,
    });
  }

  for (const ch of guild.channels.cache.values()) {
    if (ch.type !== ChannelType.GuildVoice) continue;
    if (ch.id === voiceChannel.id) continue;
    if (!LEGACY_COMMAND_VOICE_CHANNELS.has(ch.name)) continue;
    try {
      await ch.delete('Removing legacy command voice channel in favor of main voice channel');
      console.log(`  Deleted legacy voice channel: ${ch.name}`);
    } catch {
    }
  }

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

  const github = await ensureText(
    OPS_CHANNELS.github,
    catOps,
    '📦 Live GitHub activity feed — commits, PRs, issues, releases',
    '📦 GitHub activity feed posts here as one-line updates.'
  );

  const upgrades = await ensureText(
    OPS_CHANNELS.upgrades,
    catOps,
    '🆙 Agent-proposed upgrades: better ways of working, blockers to remove, and worthwhile capability enhancements',
    '🆙 Agents can post upgrade ideas, blockers to remove, and automation/tooling enhancements here for Jordan to approve.'
  );

  const callLog = await ensureText(
    OPS_CHANNELS.callLog,
    catMain,
    '📋 Automatic transcripts and summaries of voice calls',
    '📋 Voice call transcripts and summaries post here.'
  );

  const limits = await ensureText(
    OPS_CHANNELS.limits,
    catOps,
    '📊 Gemini/GCP usage, quotas, and estimated spend — refreshed every 5 minutes'
  );

  const cost = await ensureText(
    OPS_CHANNELS.cost,
    catOps,
    '💸 Per-action spend feed by agent (model, tokens, estimated USD)',
    '💸 One-line agent cost feed posts here.'
  );

  const screenshots = await ensureText(
    OPS_CHANNELS.screenshots,
    catMain,
    '📸 Automated screenshots of every app screen after each build (iPhone 17 Pro Max)',
    '📸 Build screenshot updates post here as one-line entries.'
  );

  const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
  const url = await ensureText(
    OPS_CHANNELS.url,
    catMain,
    '🔗 Live app URL and build links — updated on every deploy',
    `🔗 App URL: ${appUrl} | Cloud Build: https://console.cloud.google.com/cloud-build/builds?project=asap-489910 | Cloud Run: https://console.cloud.google.com/run/detail/australia-southeast1/asap?project=asap-489910`
  );

  const terminal = await ensureText(
    OPS_CHANNELS.terminal,
    catOps,
    '💻 Live feed of all tool calls made by agents — file ops, git, commands, searches',
    '💻 One-line tool activity feed posts here.'
  );

  const voiceErrors = await ensureText(
    OPS_CHANNELS.voiceErrors,
    catOps,
    '🧯 Voice runtime errors and per-stage latency logs (ms) for live debugging',
    `🧯 **Voice Runtime Logs**\n\nLive voice pipeline telemetry and failures.\nStages include STT, Riley LLM, TTS/playback, sub-agent fan-out, and total turn latency.`
  );

  const agentErrors = await ensureText(
    OPS_CHANNELS.agentErrors,
    catOps,
    '🚨 Central runtime and agent error feed for postmortems and rapid fixes',
    `🚨 **Agent Runtime Errors**\n\nCentralized Riley, sub-agent, tooling, and automation failures for later diagnosis and cleanup.`
  );

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

  for (const ch of guild.channels.cache.values()) {
    if (ch.type !== ChannelType.GuildText) continue;
    if (LEGACY_ACCIDENTAL_CHANNELS.has(ch.name)) {
      try {
        await ch.delete('Removing accidental recovery channel');
        console.log(`  Deleted accidental channel: #${ch.name}`);
      } catch {
      }
    }
  }

  const oldCat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === 'ASAP Agents'
  );
  if (oldCat) {
    const children = guild.channels.cache.filter((c) => c.parentId === oldCat.id);
    if (children.size === 0) {
      try { await oldCat.delete('Replaced by new category structure'); } catch { /* ignore */ }
    }
  }

  const allTextChannels = [groupchat, threadStatus, decisions, github, upgrades, callLog, limits, cost, screenshots, url, terminal, voiceErrors, agentErrors, ...agentChannels.values()];
  console.log('🔗 Pre-creating webhooks for all channels...');
  const webhookResults = await Promise.allSettled(
    allTextChannels.map((channel) => getWebhook(channel))
  );
  const failed = webhookResults.filter((r) => r.status === 'rejected').length;
  if (failed > 0) console.warn(`  ⚠️ ${failed}/${allTextChannels.length} webhook(s) failed`);
  console.log('✅ Webhooks ready');

  const botId = guild.client.user?.id;
  if (botId) {
    const opsChannels = [decisions, github, upgrades, callLog, limits, cost, screenshots, url, terminal, voiceErrors, agentErrors];
    const restricted = allTextChannels.filter((channel) => !opsChannels.some((ops) => ops.id === channel.id));
    for (const ch of restricted) {
      try {
        await ch.permissionOverwrites.edit(botId, {
          SendMessages: false,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          AddReactions: false,
          ManageWebhooks: true,
          ViewChannel: true,
          ReadMessageHistory: true,
        });
      } catch (err) {
        console.warn(`Failed to apply bot posting restriction in #${ch.name}:`, err instanceof Error ? err.message : 'Unknown');
      }
    }
    for (const ch of opsChannels) {
      try {
        await ch.permissionOverwrites.edit(botId, {
          SendMessages: true,
          SendMessagesInThreads: true,
          CreatePublicThreads: true,
          CreatePrivateThreads: true,
          AddReactions: true,
          ManageWebhooks: true,
          ViewChannel: true,
          ReadMessageHistory: true,
        });
      } catch (err) {
        console.warn(`Failed to apply bot Operations permissions in #${ch.name}:`, err instanceof Error ? err.message : 'Unknown');
      }
    }
    console.log(`🔒 Restricted raw bot posting in ${restricted.length} non-Operations channel(s)`);
  }

  return { agentChannels, groupchat, threadStatus, decisions, github, upgrades, callLog, limits, cost, screenshots, url, terminal, voiceErrors, agentErrors, voiceChannel };
}
