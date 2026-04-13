import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  ChannelType,
  ChatInputCommandInteraction,
  Message,
  TextChannel,
  EmbedBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';

import pool from '../db/pool';

import { getAgentByChannelName } from './agents';
import { getAgent } from './agents';
import { registerCommands } from './commands';
import { setVoiceErrorChannel } from './handlers/callSession';
import { startCall, endCall, isCallActive, processTesterVoiceTurnForCall } from './handlers/callSession';
import { setBotChannels } from './handlers/documentation';
import { setGitHubChannel } from './handlers/github';
import { setDecisionsChannel, setThreadStatusChannel, handleDecisionReply } from './handlers/groupchat';
import { handleGroupchatMessage, dispatchUpgradeToRiley } from './handlers/groupchat';
import { getThreadStatusOpsLine } from './handlers/groupchat';
import { autoReviewPR } from './handlers/review';
import { handleAgentMessage } from './handlers/textChannel';
import { flushPendingWrites, initMemory } from './memory';
import { setAgentErrorChannel, postAgentErrorLog } from './services/agentErrors';
import { runModelHealthChecks } from './services/modelHealth';
import { flushAllOpsDigests, postOpsLine } from './services/opsFeed';
import { setScreenshotsChannel } from './services/screenshots';
import { setTelephonyChannels, isTelephonyAvailable, initContacts } from './services/telephony';
import { setupChannels, BotChannels } from './setup';
import { setCommandAuditCallback, setPRReviewCallback, setDiscordGuild, setToolAuditCallback, setAgentChannelResolver } from './tools';
import { setLimitsChannel, setCostChannel, startDashboardUpdates, stopDashboardUpdates, initUsageCounters, flushUsageCounters, getUsageReport, getCostOpsSummaryLine } from './usage';
import { updateListingByMsgId, draftApplication, getProfile, getPortalByCompany, submitToGreenhouse, getListingById, updateListingStatus, setListingDiscordMsg, guessCompanyEmail, type JobListing } from '../services/jobSearch';
import { sendJobApplication } from '../services/email';
import { SYSTEM_COLORS, BUTTON_IDS, jobScoreColor } from './ui/constants';


/**
 * Discord runtime bootstrap.
 *
 * Responsibilities:
 * 1) Resolve and wire channels/services at startup.
 * 2) Route inbound messages to agent/groupchat handlers.
 * 3) Keep shared callbacks (tool audit, PR review, usage dashboards) connected.
 */
let client: Client | null = null;
let botChannels: BotChannels | null = null;
let channelHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let upgradesTriageTimer: ReturnType<typeof setInterval> | null = null;
const staleAlertDedupe = new Map<string, number>();
const DEFAULT_TESTER_BOT_ID = '1487426371209789450';
const RUNTIME_INSTANCE_TAG = (process.env.RUNTIME_INSTANCE_TAG || process.env.HOSTNAME || `pid-${process.pid}`).slice(0, 80);
const nonTesterTriggerNoticeAt = new Map<string, number>();
let dedupeTableReady = false;
let lastDedupePruneAt = 0;
const CHANNEL_HEARTBEAT_INTERVAL_MS = Math.max(5 * 60 * 1000, parseInt(process.env.CHANNEL_HEARTBEAT_INTERVAL_MS || '1800000', 10));
const STALE_ALERT_COOLDOWN_MS = Math.max(10 * 60 * 1000, parseInt(process.env.CHANNEL_STALE_ALERT_COOLDOWN_MS || '7200000', 10));
const UPGRADES_TRIAGE_INTERVAL_MS = Math.max(30 * 60 * 1000, parseInt(process.env.UPGRADES_TRIAGE_INTERVAL_MS || '21600000', 10));
const NON_TESTER_TRIGGER_NOTICE_COOLDOWN_MS = parseInt(process.env.NON_TESTER_TRIGGER_NOTICE_COOLDOWN_MS || '120000', 10);
const UPGRADES_TRIAGE_MARKER = '[UPGRADES_TRIAGE_V1]';

type ChannelFeedContract = {
  key: string;
  channel: TextChannel;
  cadence: string;
  staleMs: number;
};

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function getFeedContracts(channels: BotChannels): ChannelFeedContract[] {
  return [
    { key: 'thread-status', channel: channels.threadStatus, cadence: 'hourly', staleMs: 2 * 60 * 60 * 1000 },
    { key: 'limits', channel: channels.limits, cadence: '5m', staleMs: 20 * 60 * 1000 },
    { key: 'terminal', channel: channels.terminal, cadence: 'on-tool-call', staleMs: 2 * 60 * 60 * 1000 },
    { key: 'upgrades', channel: channels.upgrades, cadence: 'daily-triage', staleMs: 48 * 60 * 60 * 1000 },
    { key: 'url', channel: channels.url, cadence: 'on-deploy', staleMs: 72 * 60 * 60 * 1000 },
  ];
}

async function latestChannelMessageTimestamp(channel: TextChannel): Promise<number | null> {
  const messages = await channel.messages.fetch({ limit: 1 }).catch(() => null);
  const latest = messages?.first();
  return latest?.createdTimestamp || null;
}

async function runChannelHeartbeat(channels: BotChannels): Promise<void> {
  const contracts = getFeedContracts(channels);
  const now = Date.now();
  const parts: string[] = [];

  for (const contract of contracts) {
    const ts = await latestChannelMessageTimestamp(contract.channel);
    const age = ts ? now - ts : Number.POSITIVE_INFINITY;
    const stale = !ts || age > contract.staleMs;
    parts.push(`${stale ? '⚠️' : '✅'}${contract.key}:${ts ? formatAge(age) : 'none'}`);

    if (stale) {
      const lastAlert = staleAlertDedupe.get(contract.key) || 0;
      if (now - lastAlert >= STALE_ALERT_COOLDOWN_MS) {
        staleAlertDedupe.set(contract.key, now);
        await postAgentErrorLog('discord:feed-stale', `Feed stale: ${contract.key}`, {
          level: 'warn',
          detail: `channel=#${contract.channel.name} cadence=${contract.cadence} age=${ts ? formatAge(age) : 'no-messages'} threshold=${formatAge(contract.staleMs)}`,
        });
      }
    }
  }

  await postOpsLine(channels.threadStatus, {
    actor: 'executive-assistant',
    scope: 'channel-heartbeat',
    metric: `feeds=${contracts.length}`,
    delta: parts.join(' | '),
    action: 'none',
    severity: parts.some((p) => p.startsWith('⚠️')) ? 'error' : 'info',
  });
}

function normalizeUpgradeText(raw: string): string {
  return String(raw || '')
    .replace(/SMOKE_[A-Z0-9_]+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyUpgrade(text: string): 'accepted' | 'deferred' | 'needs-info' | 'not-actionable' {
  const normalized = text.toLowerCase();
  const hasStructured = normalized.includes('problem') && (normalized.includes('proposed') || normalized.includes('upgrade'));
  const hasBenefit = normalized.includes('benefit') || normalized.includes('expected');
  if (hasStructured && hasBenefit) return 'accepted';
  if (normalized.length < 50) return 'needs-info';
  if (/manual|external|optional|later|future/.test(normalized)) return 'deferred';
  if (/token|security|csp|audit|dependency|workflow|automation|cache|stale|heartbeat|ux|discord|embed|formatting|thread|button|message/.test(normalized)) return 'accepted';
  if (normalized.split(' ').length < 8) return 'not-actionable';
  return 'needs-info';
}

type UpgradeDigestEntry = {
  key: string;
  sample: string;
  label: 'accepted' | 'deferred' | 'needs-info' | 'not-actionable';
  count: number;
  lastTs: number;
};

function mergeUpgradeEntry(entries: UpgradeDigestEntry[], candidate: Omit<UpgradeDigestEntry, 'count' | 'lastTs'>, ts: number): void {
  const normalized = candidate.key;
  const existing = entries.find((entry) => entry.key.includes(normalized) || normalized.includes(entry.key));
  if (existing) {
    existing.count += 1;
    existing.lastTs = Math.max(existing.lastTs, ts);
    if (candidate.sample.length > existing.sample.length) {
      existing.sample = candidate.sample;
      existing.label = candidate.label;
    }
    return;
  }
  entries.push({ ...candidate, count: 1, lastTs: ts });
}

async function runUpgradesTriage(channels: BotChannels): Promise<void> {
  const upgrades = channels.upgrades;
  const messages = await upgrades.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages || messages.size === 0) return;

  const botId = upgrades.client.user?.id;
  let triageMessage: Message | null = null;
  const entries: UpgradeDigestEntry[] = [];

  for (const msg of messages.values()) {
    const content = [
      String(msg.content || ''),
      ...(msg.embeds || []).map((embed) => `${embed.title || ''} ${embed.description || ''}`),
    ].join(' ').trim();

    if (!content) continue;
    if (botId && msg.author.id === botId && content.includes(UPGRADES_TRIAGE_MARKER)) {
      triageMessage = msg;
      continue;
    }

    const cleaned = normalizeUpgradeText(content);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase().replace(/[^a-z0-9\s-]/g, '').slice(0, 140);
    const label = classifyUpgrade(cleaned);
    mergeUpgradeEntry(entries, { key, sample: cleaned.slice(0, 220), label }, msg.createdTimestamp || Date.now());
  }

  const top = entries
    .sort((a, b) => b.count - a.count || b.lastTs - a.lastTs)
    .slice(0, 10);

  const lines = [
    UPGRADES_TRIAGE_MARKER,
    '**Upgrades Backlog (auto-triaged)**',
    `Updated: ${new Date().toISOString()}`,
    'Labels: accepted | deferred | needs-info | not-actionable',
    '',
    ...(top.length > 0
      ? top.map((entry, idx) => `${idx + 1}. [${entry.label}] (x${entry.count}, ${formatAge(Date.now() - entry.lastTs)} ago) ${entry.sample}`)
      : ['1. [needs-info] No upgrades captured yet.']),
  ];

  const payload = lines.join('\n').slice(0, 1900);
  if (triageMessage) {
    await triageMessage.edit(payload).catch(() => {});
  } else {
    triageMessage = await upgrades.send(payload).catch(() => null);
  }

  if (triageMessage && !triageMessage.pinned) {
    await triageMessage.pin().catch(() => {});
  }

  // ── Actionable dispatch: auto-send top accepted upgrade to Riley ──
  // Rate limit: max 1 per triage cycle, only items with consensus (count >= 2)
  const actionable = top.find((e) => e.label === 'accepted' && e.count >= 2);
  if (actionable && channels.groupchat) {
    await dispatchUpgradeToRiley(actionable.sample, channels.groupchat).catch((err) => {
      console.warn('Upgrades auto-dispatch failed:', err instanceof Error ? err.message : 'Unknown');
    });
  }
}

function startOpsMonitors(channels: BotChannels): void {
  if (channelHeartbeatTimer) clearInterval(channelHeartbeatTimer);
  if (upgradesTriageTimer) clearInterval(upgradesTriageTimer);

  channelHeartbeatTimer = setInterval(() => {
    void runChannelHeartbeat(channels).catch(() => {});
  }, CHANNEL_HEARTBEAT_INTERVAL_MS);
  upgradesTriageTimer = setInterval(() => {
    void runUpgradesTriage(channels).catch(() => {});
  }, UPGRADES_TRIAGE_INTERVAL_MS);

  void runChannelHeartbeat(channels).catch(() => {});
  void runUpgradesTriage(channels).catch(() => {});
}

function decodeBotIdFromToken(token: string): string | null {
  try {
    const head = String(token || '').split('.')[0];
    if (!head) return null;
    const normalized = head.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8').trim();
    return /^\d{16,22}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function isTesterBotId(userId: string): boolean {
  const configured = String(process.env.DISCORD_TESTER_BOT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const tokenDerived = decodeBotIdFromToken(process.env.DISCORD_TEST_BOT_TOKEN || '');
  const allowed = new Set([DEFAULT_TESTER_BOT_ID, ...configured, ...(tokenDerived ? [tokenDerived] : [])]);
  return allowed.has(userId);
}

async function ensureDedupeTable(): Promise<void> {
  if (dedupeTableReady) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS discord_message_dedupe (
      message_id TEXT PRIMARY KEY,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  );
  dedupeTableReady = true;
}

async function claimDiscordMessage(messageId: string): Promise<boolean> {
  await ensureDedupeTable();
  const res = await pool.query(
    'INSERT INTO discord_message_dedupe (message_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_id',
    [messageId]
  );

  const now = Date.now();
  if (now - lastDedupePruneAt > 60 * 60 * 1000) {
    lastDedupePruneAt = now;
    void pool.query("DELETE FROM discord_message_dedupe WHERE claimed_at < NOW() - INTERVAL '3 days'").catch(() => {});
  }

  return (res.rowCount || 0) > 0;
}

function getTesterSpeechBridgeText(content: string): string | null {
  const normalized = String(content || '').trim();
  if (!normalized) return null;
  const match = normalized.match(/^(?:riley\s+)?(?:tester\s+)?(?:say|voice|speak)\s*(?::|-)\s*(.{1,260})$/i);
  if (!match) return null;
  return match[1].trim() || null;
}

/**
 * Get the current bot channels (used by webhook route).
 */
export function getBotChannels(): BotChannels | null {
  return botChannels;
}

/**
 * Initialize and start the Discord bot.
 * Requires DISCORD_BOT_TOKEN and DISCORD_GUILD_ID environment variables.
 */
export async function startBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token) {
    console.log('DISCORD_BOT_TOKEN not set — Discord bot disabled');
    return;
  }

  if (!guildId) {
    console.log('DISCORD_GUILD_ID not set — Discord bot disabled');
    return;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Discord bot logged in as ${readyClient.user.tag}`);

    let guild = readyClient.guilds.cache.get(guildId);
    if (!guild) {
      try {
        guild = await readyClient.guilds.fetch(guildId);
      } catch {
        console.error(`Guild ${guildId} not found. Invite the bot first.`);
        return;
      }
    }

    try {
      await initMemory();
      await initUsageCounters();
      botChannels = await setupChannels(guild);
      const configuredChannels = botChannels;
      setBotChannels(configuredChannels);
      setGitHubChannel(configuredChannels.github);
      setLimitsChannel(configuredChannels.limits);
      setCostChannel(configuredChannels.cost);
      setScreenshotsChannel(configuredChannels.screenshots);
      setVoiceErrorChannel(configuredChannels.voiceErrors);
      setAgentErrorChannel(configuredChannels.agentErrors);
      setDiscordGuild(guild);
      setAgentChannelResolver((agentId: string) => configuredChannels.agentChannels.get(agentId) || null);
      setDecisionsChannel(configuredChannels.decisions);
      setThreadStatusChannel(configuredChannels.threadStatus, configuredChannels.groupchat);
      if (isTelephonyAvailable()) {
        setTelephonyChannels(configuredChannels.callLog, configuredChannels.groupchat);
        await initContacts();
      }
      await startDashboardUpdates();
      runModelHealthChecks().catch((err) => {
        const msg = err instanceof Error ? err.message : 'Unknown';
        console.error('Model health check failed:', msg);
        void postAgentErrorLog('discord:model-health', 'Model health check failed', { detail: msg, level: 'warn' });
      });

      setCommandAuditCallback((cmd, allowed, reason) => {
        const githubChannel = configuredChannels.github;
        if (!githubChannel) return;
        const truncated = cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd;
        void postOpsLine(githubChannel, {
          actor: 'system',
          scope: 'command-audit',
          metric: `run-command allowed=${allowed}`,
          delta: `${truncated.replace(/\s+/g, ' ')} reason=${reason.replace(/\s+/g, ' ')}`,
          action: allowed ? 'none' : 'review blocked command request',
          severity: allowed ? 'info' : 'warn',
        });
      });

      let lastDbAuditPost = 0;
      let suppressedDbAudits = 0;
      const DB_AUDIT_POST_INTERVAL_MS = 30_000;
      const toAgentTag = (name: string): string => {
        const normalized = String(name || '').toLowerCase();
        if (normalized.includes('riley')) return 'executive-assistant';
        if (normalized.includes('ace')) return 'developer';
        if (normalized.includes('max')) return 'qa';
        if (normalized.includes('sophie')) return 'ux-reviewer';
        if (normalized.includes('kane')) return 'security-auditor';
        if (normalized.includes('raj')) return 'api-reviewer';
        if (normalized.includes('elena')) return 'dba';
        if (normalized.includes('kai')) return 'performance';
        if (normalized.includes('jude')) return 'devops';
        if (normalized.includes('liv')) return 'copywriter';
        if (normalized.includes('harper')) return 'lawyer';
        if (normalized.includes('mia')) return 'ios-engineer';
        if (normalized.includes('leo')) return 'android-engineer';
        return normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
      };
      setToolAuditCallback((agentName, toolName, summary) => {
        const terminalChannel = configuredChannels.terminal;
        if (!terminalChannel) return;

        const tag = toAgentTag(agentName);
        const isDbTool = toolName === 'db_query' || toolName === 'db_query_readonly';

        if (isDbTool) {
          const now = Date.now();
          if (now - lastDbAuditPost < DB_AUDIT_POST_INTERVAL_MS) {
            suppressedDbAudits++;
            return;
          }

          const suppressedNote = suppressedDbAudits > 0
            ? ` (+${suppressedDbAudits} db queries suppressed in last ${Math.round(DB_AUDIT_POST_INTERVAL_MS / 1000)}s)`
            : '';
          suppressedDbAudits = 0;
          lastDbAuditPost = now;
          void postOpsLine(terminalChannel, {
            actor: tag,
            scope: 'tool-audit:db',
            metric: toolName,
            delta: `batched${suppressedNote}`,
            action: 'none',
            severity: 'info',
          });
          return;
        }

        void postOpsLine(terminalChannel, {
          actor: tag,
          scope: 'tool-audit',
          metric: toolName,
          delta: summary.replace(/\s+/g, ' ').trim(),
          action: 'none',
          severity: 'info',
        });
      });

      setPRReviewCallback(async (prNumber, prTitle, changedFiles, diffSummary) => {
        await autoReviewPR(prNumber, prTitle, changedFiles, diffSummary, configuredChannels.groupchat);
      });
      console.log(`Discord channels configured in "${guild.name}"`);

      await registerCommands(readyClient, guildId);
      startOpsMonitors(configuredChannels);
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
      console.error('Channel setup error:', err instanceof Error ? err.message : 'Unknown');
      void postAgentErrorLog('discord:startup', 'Channel setup error', { detail: msg });
      console.error('Bot initialization failed — destroying client');
      readyClient.destroy();
      client = null;
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (botChannels && message.channel.id === botChannels.groupchat.id) {
      const linkSpam = message.author.bot
        && /🔗\s*\*\*ASAP Links\*\*|Cloud Build\*\*:\s*https?:\/\//i.test(String(message.content || ''));
      if (linkSpam) {
        await message.delete().catch(() => {});
        await botChannels.groupchat.send('🔗 Detailed links are available in #url.').catch(() => {});
        return;
      }
    }

    // Ignore bot traffic except the dedicated smoke-test bot so e2e tests can
    // still exercise the same production routing path. In groupchat, emit a
    // short hint so operators know why a bot-authored trigger was ignored.
    // Always silently skip our own messages to avoid self-triggered notices.
    if (message.author.id === client?.user?.id) return;
    if (message.author.bot && !isTesterBotId(message.author.id)) {
      if (botChannels && message.channel.id === botChannels.groupchat.id) {
        const key = `${message.author.id}:${message.channel.id}`;
        const now = Date.now();
        const prev = nonTesterTriggerNoticeAt.get(key) || 0;
        if (now - prev >= NON_TESTER_TRIGGER_NOTICE_COOLDOWN_MS) {
          nonTesterTriggerNoticeAt.set(key, now);
          console.log(`Workflow trigger ignored for bot ${message.author.id} in groupchat`);
        }
      }
      return;
    }
    if (!botChannels) return;

    const claimed = await claimDiscordMessage(message.id).catch((err) => {
      console.warn('Discord message dedupe check failed:', err instanceof Error ? err.message : 'Unknown');
      return true;
    });
    if (!claimed) return;

    const channelId = message.channel.id;

    try {
      for (const [agentId, channel] of botChannels.agentChannels) {
        if (channel.id === channelId) {
          const agent = getAgentByChannelName(agentId);
          if (agent) {
            await handleAgentMessage(message, agent);
          }
          return;
        }
      }

      if (channelId === botChannels.groupchat.id) {
        if (isTesterBotId(message.author.id)) {
          const testerSpeech = getTesterSpeechBridgeText(message.content);
          if (testerSpeech) {
            const injected = await processTesterVoiceTurnForCall({
              userId: message.author.id,
              username: message.member?.displayName || message.author.username || 'ASAPTester',
              text: testerSpeech,
            });
            if (injected.ok) {
              const modeLabel = injected.mode === 'voice' ? 'ASAPTester spoke in voice' : 'Tester speech injected into voice turn';
              await botChannels.groupchat.send(`🧪 ${modeLabel} [${RUNTIME_INSTANCE_TAG}]: "${testerSpeech.slice(0, 120)}"`).catch(() => {});
            } else {
              await botChannels.groupchat.send(`⚠️ ASAPTester voice turn failed [${RUNTIME_INSTANCE_TAG}]: ${injected.reason || 'unknown error'}`).catch(() => {});
            }
            return;
          }
        }

        await handleGroupchatMessage(message, botChannels.groupchat);
        return;
      }

      if (channelId === botChannels.careerOps.id) {
        const riley = getAgent('executive-assistant');
        if (riley) {
          await handleAgentMessage(message, riley);
        }
        return;
      }

      if (channelId === botChannels.decisions.id) {
        await handleDecisionReply(message, botChannels.groupchat);
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
      const lowered = String(err instanceof Error ? err.message : err || '').toLowerCase();
      const isAbortLike =
        (err instanceof Error && err.name === 'AbortError')
        || lowered.includes('aborterror')
        || lowered.includes('aborted');
      console.error('Message handler error:', err instanceof Error ? err.message : 'Unknown');
      void postAgentErrorLog('discord:message-handler', isAbortLike ? 'Message handler aborted' : 'Message handler error', {
        detail: msg,
        level: isAbortLike ? 'info' : 'error',
      });
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'ops') return;

    try {
      await handleOpsInteraction(interaction);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unknown';
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: `Ops command failed: ${detail}`, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: `Ops command failed: ${detail}`, ephemeral: true }).catch(() => {});
      }
    }
  });

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    if (!botChannels) return;

    const targetVoiceId = botChannels.voiceChannel.id;
    const joinedTarget = oldState.channelId !== targetVoiceId && newState.channelId === targetVoiceId;
    const leftTarget = oldState.channelId === targetVoiceId && newState.channelId !== targetVoiceId;

    // Ignore voice state updates unrelated to the managed Riley voice channel.
    if (!joinedTarget && !leftTarget) return;

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) {
      return;
    }

    try {
      if (joinedTarget && !isCallActive()) {
        await startCall(botChannels.voiceChannel, botChannels.groupchat, botChannels.callLog, member);
      }

      if (leftTarget && isCallActive()) {
        const remainingHumans = botChannels.voiceChannel.members.filter((m) => !m.user.bot).size;
        if (remainingHumans === 0) {
          await endCall();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
      console.error('Voice auto join/leave handler error:', err instanceof Error ? err.message : 'Unknown');
      void postAgentErrorLog('discord:voice-auto', 'Voice auto join/leave error', { detail: msg, level: 'warn' });
    }
  });

  // ── Button interaction handler for job approvals + draft approvals ──
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    const customId = interaction.customId;

    try {
      // ── Job card approve/reject buttons in #📋-job-applications ──
      if (customId.startsWith(BUTTON_IDS.JOB_APPROVE_PREFIX) || customId.startsWith(BUTTON_IDS.JOB_REJECT_PREFIX)) {
        const isApprove = customId.startsWith(BUTTON_IDS.JOB_APPROVE_PREFIX);
        const listingId = parseInt(customId.replace(isApprove ? BUTTON_IDS.JOB_APPROVE_PREFIX : BUTTON_IDS.JOB_REJECT_PREFIX, ''), 10);
        if (isNaN(listingId)) return;

        const newStatus = isApprove ? 'approved' : 'rejected';
        const listing = await updateListingByMsgId(interaction.message.id, newStatus);

        if (listing) {
          const confirmText = isApprove
            ? `✅ **Approved**: **${listing.title}** @ ${listing.company}`
            : `❌ **Rejected**: **${listing.title}** @ ${listing.company}`;

          await interaction.update({ content: confirmText, embeds: [], components: [] });

          // Auto-draft application on approval
          if (newStatus === 'approved') {
            const ch = interaction.channel as TextChannel;
            handleApprovalDraft(listing, ch).catch((err) =>
              console.error('Auto-draft error:', err instanceof Error ? err.message : 'Unknown')
            );
          }
        } else {
          await interaction.reply({ content: 'Listing not found or already processed.', ephemeral: true });
        }
        return;
      }

      // ── Draft approve/reject buttons in #💼-career-ops ────────────
      if (customId.startsWith(BUTTON_IDS.DRAFT_APPROVE_PREFIX) || customId.startsWith(BUTTON_IDS.DRAFT_REJECT_PREFIX)) {
        const isApprove = customId.startsWith(BUTTON_IDS.DRAFT_APPROVE_PREFIX);
        const listingId = parseInt(customId.replace(isApprove ? BUTTON_IDS.DRAFT_APPROVE_PREFIX : BUTTON_IDS.DRAFT_REJECT_PREFIX, ''), 10);
        if (isNaN(listingId)) return;

        const listing = await updateListingByMsgId(interaction.message.id, isApprove ? 'applied' : 'discarded');
        if (!listing) {
          await interaction.reply({ content: 'Listing not found or already processed.', ephemeral: true });
          return;
        }

        const ch = interaction.channel as TextChannel;

        if (isApprove) {
          await interaction.deferUpdate();
          const profile = await getProfile();
          let submitted = false;

          // 1. Try Greenhouse API if portal has a key
          if (listing.source === 'greenhouse' && profile) {
            const portal = await getPortalByCompany(listing.company);
            if (portal?.board_api_key) {
              const result = await submitToGreenhouse(listing, profile, listing.cover_letter || '', listing.resume_text || '');
              if (result.success) {
                await ch.send(`🚀 **Submitted** to ${listing.company} via Greenhouse API!`);
                submitted = true;
              } else {
                await ch.send(`⚠️ Greenhouse API failed: ${result.error} — trying email...`);
              }
            }
          }

          // 2. Fall back to email application
          if (!submitted && profile) {
            try {
              const toEmail = await guessCompanyEmail(listing.company);
              const fromName = `${profile.first_name || 'Jordan'} ${profile.last_name || 'Flessenkemper'}`;
              await sendJobApplication(
                toEmail,
                fromName,
                profile.email || 'jordan.flessenkemper@gmail.com',
                listing.title,
                listing.company,
                listing.cover_letter || '',
                listing.resume_text || '',
                listing.url,
                profile.phone || undefined,
              );
              await ch.send(`📧 **Application emailed** to ${toEmail} for **${listing.title}** @ ${listing.company}`);
              submitted = true;
            } catch (emailErr) {
              const msg = emailErr instanceof Error ? emailErr.message : 'Unknown';
              await ch.send(`⚠️ Email send failed: ${msg}\n👉 Apply manually: ${listing.url}`);
            }
          }

          if (!submitted) {
            await ch.send(`✅ **Approved** — apply manually: ${listing.url}`);
          }
        } else {
          await interaction.update({ content: `❌ Draft discarded for **${listing.title}** @ ${listing.company}`, embeds: [], components: [] });
        }

        // Remove the original draft message
        if (isApprove) {
          await interaction.message.delete().catch(() => {});
        }
        return;
      }
    } catch (err) {
      console.error('Button interaction error:', err instanceof Error ? err.message : 'Unknown');
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong processing that button.', ephemeral: true }).catch(() => {});
      }
    }
  });

  /** Auto-draft a cover letter + resume highlights after ✅ approval, post to #💼-career-ops. */
  async function handleApprovalDraft(listing: JobListing, notifyChannel: TextChannel): Promise<void> {
    if (!client) return;
    const guild = client.guilds.cache.first();
    if (!guild) return;

    const careerOps = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === '💼-career-ops'
    ) as TextChannel | undefined;
    const targetChannel = careerOps || notifyChannel;

    await targetChannel.send(`✍️ Drafting application for **${listing.title}** @ ${listing.company}...`);

    const draft = await draftApplication(listing.id!);
    if (!draft) {
      await targetChannel.send(`⚠️ Could not draft application for **${listing.title}** — check profile and GEMINI_API_KEY.`);
      return;
    }

    const salary = listing.salary_min
      ? `💰 $${Math.round(listing.salary_min / 1000)}k–$${Math.round((listing.salary_max || listing.salary_min) / 1000)}k`
      : '💰 Not specified';

    // Combine cover letter + resume highlights into a single embed with approval buttons
    const descParts = [
      `**Company:** ${listing.company}`,
      `**Location:** ${listing.location || 'Unknown'}`,
      salary,
      `[View listing](${listing.url})`,
      '',
      '**Cover Letter:**',
      draft.coverLetter.slice(0, 2500),
    ];
    if (draft.resumeHighlights) {
      descParts.push('', '**Resume Highlights:**', draft.resumeHighlights.slice(0, 1200));
    }

    const draftEmbed = new EmbedBuilder()
      .setTitle(`📝 Application Draft: ${listing.title}`)
      .setDescription(descParts.join('\n'))
      .setColor(SYSTEM_COLORS.draft)
      .setFooter({ text: `Listing #${listing.id}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_IDS.DRAFT_APPROVE_PREFIX}${listing.id}`)
        .setLabel('Approve & Submit')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_IDS.DRAFT_REJECT_PREFIX}${listing.id}`)
        .setLabel('Discard')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
    );

    const draftMsg = await targetChannel.send({ embeds: [draftEmbed], components: [row] });

    // Track this message so the button handler can find the listing
    await setListingDiscordMsg(listing.id!, draftMsg.id);
  }

  try {
    await client.login(token);
  } catch (err) {
    const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
    console.error('Discord bot login failed:', err instanceof Error ? err.message : 'Unknown');
    void postAgentErrorLog('discord:login', 'Discord bot login failed', { detail: msg });
  }
}

/**
 * Gracefully shut down the Discord bot.
 */
export async function stopBot(): Promise<void> {
  if (channelHeartbeatTimer) {
    clearInterval(channelHeartbeatTimer);
    channelHeartbeatTimer = null;
  }
  if (upgradesTriageTimer) {
    clearInterval(upgradesTriageTimer);
    upgradesTriageTimer = null;
  }
  stopDashboardUpdates();
  setCommandAuditCallback(() => {});
  setToolAuditCallback(() => {});
  setPRReviewCallback(async () => {});
  setCostChannel(null);
  setVoiceErrorChannel(null);
  setAgentErrorChannel(null);
  setThreadStatusChannel(null);
  await flushUsageCounters().catch(() => {});
  await flushAllOpsDigests().catch(() => {});
  if (isCallActive()) {
    await endCall();
  }
  await flushPendingWrites();
  if (client) {
    client.destroy();
    client = null;
    botChannels = null;
    console.log('Discord bot disconnected');
  }
}

async function handleOpsInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  const view = interaction.options.getSubcommand(true);

  if (view === 'deploy-checklist') {
    const phase = interaction.options.getString('phase') || 'full';
    const content = buildDeployChecklist(phase);
    await interaction.reply({ content: content.slice(0, 1900), ephemeral: true });
    return;
  }

  if (view === 'costs') {
    const embed = new EmbedBuilder()
      .setTitle('💸 Ops Costs')
      .setDescription(`${getCostOpsSummaryLine()}\n${getUsageReport().split('\n')[1] || ''}`)
      .setColor(SYSTEM_COLORS.default)
      .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (view === 'threads') {
    const threadLine = await getThreadStatusOpsLine();
    const embed = new EmbedBuilder()
      .setTitle('🧵 Ops Threads')
      .setDescription(threadLine || 'No active threads.')
      .setColor(SYSTEM_COLORS.default)
      .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const threadLine = await getThreadStatusOpsLine();
  const costLine = getCostOpsSummaryLine();
  const liveLine = getUsageReport().split('\n')[1] || '';
  const embed = new EmbedBuilder()
    .setTitle('📡 Ops Now')
    .setDescription(`${costLine}\n${liveLine}\n${threadLine}`)
    .setColor(SYSTEM_COLORS.default)
    .setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

function buildDeployChecklist(phase: string): string {
  const pre = [
    '🧰 PRE-DEPLOY',
    '1) Build/typecheck: npm run build',
    '2) Quality: npm run quality:app && (cd server && npm run quality)',
    '3) Security quick-pass: npm run security:semgrep && (cd server && npm run security:semgrep)',
    '4) Confirm env/secrets present for deploy target',
    '5) Commit + push with release notes and rollback commit hash',
  ];

  const post = [
    '✅ POST-DEPLOY',
    '1) Restart process and verify online status',
    '2) Run full Discord smoke suite (pre-clear enabled)',
    '3) Check /ops now + /ops threads + /ops costs outputs',
    '4) Confirm error channels stayed quiet (voice-errors, agent-errors)',
    '5) If failed: rollback immediately to previous known-good commit',
  ];

  if (phase === 'pre') return pre.join('\n');
  if (phase === 'post') return post.join('\n');
  return [...pre, '', ...post].join('\n');
}
