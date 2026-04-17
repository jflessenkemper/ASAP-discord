import {
  Guild,
  ChannelType,
  TextChannel,
  VoiceChannel,
  CategoryChannel,
  Role,
} from 'discord.js';

import { getAgents, setAgentRoleId } from './agents';
import { getWebhook } from './services/webhooks';
import { REPO_TOOLS } from './tools';
import { errMsg } from '../utils/errors';

const TOOLS_POST_MARKER = '[ASAP_TOOLS_POST_V3]';
const DEFAULT_PUBLIC_APP_URL = 'https://asap-489910.australia-southeast1.run.app';

const CAT_MAIN = 'ASAP';
const CAT_AGENTS = 'Agents';
const CAT_OPS = 'Operations';
const OWNER_NAME = process.env.DISCORD_OWNER_NAME || 'jflessenkemper';
const CAT_PERSONAL = `👤-${OWNER_NAME}-personal`;

const MAIN_CHANNELS = {
  groupchat: '💬-groupchat',
  threadStatus: '🧵-thread-status',
  decisions: '📋-decisions',
  voice: '🎤-voice',
} as const;

const OPS_CHANNELS = {
  github: '📦-github',
  loops: '🔁-loops',
  upgrades: '🆙-upgrades',
  tools: '🧰-tools',
  callLog: '📋-call-log',
  limits: '📊-limits',
  cost: '💸-cost',
  screenshots: '📸-screenshots',
  url: '🔗-url',
  terminal: '💻-terminal',
  voiceErrors: '🧯-voice-errors',
  agentErrors: '🚨-agent-errors',
} as const;

const PERSONAL_CHANNELS = {
  careerOps: '💼-career-ops',
  jobApplications: '📋-job-applications',
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
  loops: TextChannel;
  upgrades: TextChannel;
  tools: TextChannel;
  callLog: TextChannel;
  limits: TextChannel;
  cost: TextChannel;
  screenshots: TextChannel;
  url: TextChannel;
  terminal: TextChannel;
  voiceErrors: TextChannel;
  agentErrors: TextChannel;
  careerOps: TextChannel;
  jobApplications: TextChannel;
  voiceChannel: VoiceChannel;
}

interface ChannelContract {
  owner: string;
  cadence: string;
  staleAlert: string;
}

function applyChannelContract(topic: string, contract?: ChannelContract): string {
  const base = String(topic || '').trim();
  if (!contract) return base.slice(0, 1024);
  const suffix = ` | owner=${contract.owner}; cadence=${contract.cadence}; stale=${contract.staleAlert}`;
  return `${base}${suffix}`.slice(0, 1024);
}

function buildToolsChannelSummary(): string {
  const coreRuntimeTools = [
    'read_file',
    'search_files',
    'check_file_exists',
    'run_command',
    'send_channel_message',
    'list_threads',
    'gcp_run_describe',
    'repo_memory_index',
    'repo_memory_search',
  ].filter((name) => REPO_TOOLS.some((tool) => tool.name === name));

  const lines = [
    TOOLS_POST_MARKER,
    '**ASAP Tools and Delegation**',
    '',
    '**Delegation Flow**',
    '- Riley coordinates work and delegates to specialists.',
    '- Specialists post one concise improvement in #upgrades when they identify a blocker or better workflow.',
    '- Review agents can send channel messages to #upgrades (or their own channel) only.',
    '',
    '**Core Runtime Tools**',
    coreRuntimeTools.map((name) => `\`${name}\``).join(', ') || '_No tools configured._',
    '',
    '**External and Free Tools (Requested)**',
    '- Installed and usable: Spectral, Prism, Newman, Artillery, MSW, Jest Image Snapshot, pa11y-ci, Lighthouse, axe-core, sqlfluff, schemathesis, checkov.',
    '- In GCP tooling pipeline: Trivy, OWASP ZAP baseline, k6.',
    '- External/manual: Snyk and Infracost (require separate auth/integration).',
    '',
    '**Readiness Rule**',
    '- Keep exactly one bot post in this channel; refresh replaces prior bot posts.',
  ];

  const summary = lines.join('\n');
  return summary.slice(0, 1900);
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!/^https?:$/.test(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return false;
    if (host.endsWith('.local')) return false;
    return true;
  } catch {
    return false;
  }
}

function resolvePublicAppUrl(): string {
  const candidates = [
    process.env.PUBLIC_APP_URL,
    process.env.APP_URL,
    process.env.FRONTEND_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.CLOUD_RUN_APP_URL,
  ];

  for (const candidate of candidates) {
    const url = String(candidate || '').trim();
    if (isPublicHttpUrl(url)) return url;
  }

  return DEFAULT_PUBLIC_APP_URL;
}

function splitDiscordMessage(content: string, maxLen = 1900): string[] {
  const normalized = String(content || '').trim();
  if (!normalized) return [];
  if (normalized.length <= maxLen) return [normalized];

  const lines = normalized.split('\n');
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length <= maxLen) {
      current = line;
      continue;
    }
    // Fallback for exceptionally long single lines.
    for (let i = 0; i < line.length; i += maxLen) {
      chunks.push(line.slice(i, i + maxLen));
    }
    current = '';
  }

  if (current) chunks.push(current);
  return chunks;
}

async function refreshToolsChannelPost(channel: TextChannel): Promise<void> {
  const botId = channel.client.user?.id;
  if (botId) {
    let before: string | undefined;
    for (let page = 0; page < 5; page++) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      before = batch.last()?.id;

      const oldPosts = [...batch.values()].filter((msg) => msg.author.id === botId);

      for (const msg of oldPosts) {
        try { await msg.delete(); } catch { /* ignore cleanup failures */ }
      }
    }
  }

  const summary = buildToolsChannelSummary();
  await channel.send(summary);
}

async function refreshUrlChannelPost(channel: TextChannel, appUrl: string): Promise<void> {
  const botId = channel.client.user?.id;
  if (botId) {
    let before: string | undefined;
    for (let page = 0; page < 5; page++) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      before = batch.last()?.id;

      const oldPosts = [...batch.values()].filter((msg) => msg.author.id === botId);
      for (const msg of oldPosts) {
        try { await msg.delete(); } catch { /* ignore cleanup failures */ }
      }
    }
  }

  await channel.send(
    `🔗 App URL: ${appUrl} | Cloud Build: https://console.cloud.google.com/cloud-build/builds?project=asap-489910 | Cloud Run: https://console.cloud.google.com/run/detail/australia-southeast1/asap?project=asap-489910`
  );
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
 *   Operations  — github, loops, upgrades, call-log, limits
 *   Personal    — owner-specific channels (for example career ops)
 *
 * Cleans up duplicate channels left from previous runs.
 */
export async function setupChannels(guild: Guild): Promise<BotChannels> {
  const agents = getAgents();

  await guild.channels.fetch();
  await guild.roles.fetch();

  if (process.env.RESET_CHANNELS === 'true') {
    console.log('🔄 RESET_CHANNELS=true — deleting all managed channels for fresh recreation...');
    const managedCategories = [CAT_MAIN, CAT_AGENTS, CAT_OPS, CAT_PERSONAL];
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
  const catPersonal = await findOrCreateCategory(guild, CAT_PERSONAL);

  for (const [agentId, agent] of agents) {
    const role = await ensureAgentRole(guild, agent.roleName, agent.color);
    setAgentRoleId(agentId, role.id);
  }

  async function ensureText(
    name: string,
    parent: CategoryChannel,
    topic: string,
    welcomeMessage?: string,
    contract?: ChannelContract,
  ): Promise<TextChannel> {
    const desiredTopic = applyChannelContract(topic, contract);
    let channel = await deduplicateChannel(guild, name);

    if (channel) {
      if (channel.parentId !== parent.id) {
        await channel.setParent(parent, { lockPermissions: false });
      }
      if ((channel.topic || '') !== desiredTopic) {
        await channel.setTopic(desiredTopic).catch(() => {});
      }
    } else {
      channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent,
        topic: desiredTopic,
      });
      if (welcomeMessage) {
        for (const chunk of splitDiscordMessage(welcomeMessage)) {
          await channel.send(chunk);
        }
      }
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
    '🧵 Automated hourly summary of open workspace threads and close-ready items.',
    '🧵 Thread status snapshots post here.',
    { owner: 'system', cadence: 'hourly', staleAlert: '2h' }
  );

  const decisions = await ensureText(
    MAIN_CHANNELS.decisions,
    catMain,
    '📋 Riley queues decisions here while you sleep. Reply to any decision to continue the work.',
    `📋 **Decisions Queue**\n\nWhen the team hits a decision point overnight or while you are away, Riley posts it here instead of stopping work.\nIn live groupchat, Riley can ask you directly and tag you there. In live voice calls, Riley asks you in voice instead of using this channel.\nReply to any decision with your answer — Riley will pick it up and continue.\nClick a button to choose from listed options.`
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
    '📦 GitHub activity feed posts here as one-line updates.',
    { owner: 'system', cadence: 'on-event', staleAlert: '24h' }
  );

  const loops = await ensureText(
    OPS_CHANNELS.loops,
    catOps,
    '🔁 Independent loop runs, start/finish state, and Riley-readable loop reports',
    '🔁 Loop health changes and loop run reports post here so Riley can reason over them explicitly.',
    { owner: 'system', cadence: 'on-loop-run', staleAlert: '24h' }
  );

  const upgrades = await ensureText(
    OPS_CHANNELS.upgrades,
    catOps,
    '🆙 Agent-proposed upgrades: better ways of working, blockers to remove, and worthwhile capability enhancements',
    '🆙 Agents can post upgrade ideas, blockers to remove, and automation/tooling enhancements here for Jordan to approve.',
    { owner: 'system', cadence: 'daily-triage', staleAlert: '48h' }
  );

  const tools = await ensureText(
    OPS_CHANNELS.tools,
    catOps,
    '🧰 Agent capabilities and runtime tool access summary',
    buildToolsChannelSummary(),
    { owner: 'ace', cadence: 'on-change', staleAlert: '7d' }
  );
  await refreshToolsChannelPost(tools);

  const callLog = await ensureText(
    OPS_CHANNELS.callLog,
    catMain,
    '📋 Automatic transcripts and summaries of voice calls',
    '📋 Voice call transcripts and summaries post here.',
    { owner: 'riley', cadence: 'on-call', staleAlert: '7d' }
  );

  const limits = await ensureText(
    OPS_CHANNELS.limits,
    catOps,
    '📊 Gemini/GCP usage, quotas, and estimated spend — refreshed every 5 minutes',
    undefined,
    { owner: 'jude', cadence: '5m', staleAlert: '20m' }
  );

  const cost = await ensureText(
    OPS_CHANNELS.cost,
    catOps,
    '💸 Per-action spend feed by agent (model, tokens, estimated USD)',
    '💸 One-line agent cost feed posts here.',
    { owner: 'jude', cadence: 'on-request', staleAlert: '24h' }
  );

  const screenshots = await ensureText(
    OPS_CHANNELS.screenshots,
    catMain,
    '📸 Automated screenshots of every app screen after each build (iPhone 17 Pro Max)',
    '📸 Build screenshot updates post here as one-line entries.',
    { owner: 'ace', cadence: 'on-deploy', staleAlert: '7d' }
  );

  const appUrl = resolvePublicAppUrl();
  const url = await ensureText(
    OPS_CHANNELS.url,
    catMain,
    '🔗 Live app URL and build links — updated on every deploy',
    `🔗 App URL: ${appUrl} | Cloud Build: https://console.cloud.google.com/cloud-build/builds?project=asap-489910 | Cloud Run: https://console.cloud.google.com/run/detail/australia-southeast1/asap?project=asap-489910`,
    { owner: 'jude', cadence: 'on-deploy', staleAlert: '72h' }
  );
  await refreshUrlChannelPost(url, appUrl);

  const terminal = await ensureText(
    OPS_CHANNELS.terminal,
    catOps,
    '💻 Live feed of all tool calls made by agents — file ops, git, commands, searches',
    '💻 One-line tool activity feed posts here.',
    { owner: 'ace', cadence: 'on-tool-call', staleAlert: '2h' }
  );

  const voiceErrors = await ensureText(
    OPS_CHANNELS.voiceErrors,
    catOps,
    '🧯 Voice runtime errors and per-stage latency logs (ms) for live debugging',
    `🧯 **Voice Runtime Logs**\n\nLive voice pipeline telemetry and failures.\nStages include STT, Riley LLM, TTS/playback, sub-agent fan-out, and total turn latency.`,
    { owner: 'system', cadence: 'on-error', staleAlert: '7d' }
  );

  const agentErrors = await ensureText(
    OPS_CHANNELS.agentErrors,
    catOps,
    '🚨 Central runtime and agent error feed for postmortems and rapid fixes',
    `🚨 **Agent Runtime Errors**\n\nCentralized Riley, sub-agent, tooling, and automation failures for later diagnosis and cleanup.`,
    { owner: 'system', cadence: 'on-error', staleAlert: '7d' }
  );

  const careerOps = await ensureText(
    PERSONAL_CHANNELS.careerOps,
    catPersonal,
    '💼 Career operations command center: role targets, pipeline, outreach, applications, and weekly goals',
    `💼 **Career Ops**\n\nUse this channel to run your job search pipeline with Riley: role targeting, shortlist scoring, tailored CV generation, outreach drafts, and application tracking.`,
    { owner: 'jflessenkemper', cadence: 'daily', staleAlert: '14d' }
  );

  const jobApplications = await ensureText(
    PERSONAL_CHANNELS.jobApplications,
    catPersonal,
    '📋 Job approval queue — click Approve or Reject on each card · cards update after you choose',
    `📋 **Job Applications**\n\n**How it works:**\n1. Ask Riley to scan & evaluate jobs in #💼-career-ops\n2. Riley posts the best matches here as cards\n3. Click **Approve** — Riley auto-drafts a tailored cover letter & resume highlights, then posts them in #💼-career-ops\n4. Click **Reject** to skip\n5. Cards update after you choose so only pending approvals remain`,
    { owner: 'jflessenkemper', cadence: 'on-demand', staleAlert: '14d' }
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

  const allTextChannels = [groupchat, threadStatus, decisions, github, loops, upgrades, tools, callLog, limits, cost, screenshots, url, terminal, voiceErrors, agentErrors, careerOps, jobApplications, ...agentChannels.values()];
  console.log('🔗 Pre-creating webhooks for all channels...');
  const webhookResults = await Promise.allSettled(
    allTextChannels.map((channel) => getWebhook(channel))
  );
  const failed = webhookResults.filter((r) => r.status === 'rejected').length;
  if (failed > 0) console.warn(`  ⚠️ ${failed}/${allTextChannels.length} webhook(s) failed`);
  console.log('✅ Webhooks ready');

  const botId = guild.client.user?.id;
  if (botId) {
    const opsChannels = [threadStatus, decisions, github, loops, upgrades, tools, callLog, limits, cost, screenshots, url, terminal, voiceErrors, agentErrors, careerOps, jobApplications];
    const restricted = allTextChannels.filter((channel) => !opsChannels.some((ops) => ops.id === channel.id));
    for (const ch of restricted) {
      try {
        await ch.permissionOverwrites.edit(botId, {
          SendMessages: false,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          AddReactions: false,
          
          ViewChannel: true,
          ReadMessageHistory: true,
        });
      } catch (err) {
        console.warn(`Failed to apply bot posting restriction in #${ch.name}:`, errMsg(err));
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
          ViewChannel: true,
          ReadMessageHistory: true,
        });
      } catch (err) {
        console.warn(`Failed to apply bot Operations permissions in #${ch.name}:`, errMsg(err));
      }
    }
    console.log(`🔒 Restricted raw bot posting in ${restricted.length} non-Operations channel(s)`);

    const hardenSensitive = String(process.env.DISCORD_HARDEN_SENSITIVE_CHANNELS || 'true').toLowerCase() !== 'false';
    if (hardenSensitive) {
      const sensitiveChannels = [terminal, voiceErrors, agentErrors, limits, cost, callLog, loops, upgrades, careerOps, jobApplications];
      const everyoneRoleId = guild.roles.everyone.id;
      const ownerMember = await guild.fetchOwner().catch(() => null);
      if (!ownerMember) {
        console.warn('Could not resolve guild owner member for sensitive channel ACL hardening');
      }

      for (const channel of sensitiveChannels) {
        try {
          await channel.permissionOverwrites.edit(everyoneRoleId, {
            ViewChannel: false,
          });
          await channel.permissionOverwrites.edit(botId, {
            ViewChannel: true,
            ReadMessageHistory: true,
            SendMessages: true,
            SendMessagesInThreads: true,
          });
          if (ownerMember) {
            await channel.permissionOverwrites.edit(ownerMember, {
              ViewChannel: true,
              ReadMessageHistory: true,
              SendMessages: true,
              SendMessagesInThreads: true,
              ManageMessages: true,
              ManageThreads: true,
            });
          }
        } catch (err) {
          console.warn(`Failed to harden permissions in #${channel.name}:`, errMsg(err));
        }
      }
      console.log(`🔐 Applied sensitive channel ACL hardening to ${sensitiveChannels.length} channel(s)`);
    }
  }

  return { agentChannels, groupchat, threadStatus, decisions, github, loops, upgrades, tools, callLog, limits, cost, screenshots, url, terminal, voiceErrors, agentErrors, careerOps, jobApplications, voiceChannel };
}
