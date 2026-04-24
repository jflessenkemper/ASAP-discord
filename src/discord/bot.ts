import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  ChannelType,
  Message,
  TextChannel,
  EmbedBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';

import pool from '../db/pool';
import { LEGACY_APP_TABLES, LEGACY_DROP_MIGRATION, REQUIRED_RUNTIME_TABLES } from '../db/runtimeSchema';

import { getAgentByChannelName } from './agents';
import { getAgent, loadDynamicAgentsFromDb } from './agents';
import { setVoiceErrorChannel } from './handlers/callSession';
import { startCall, endCall, isCallActive, preInitSttForMember, processTesterVoiceTurnForCall, announceVoiceMember } from './handlers/callSession';
import { setBotChannels } from './handlers/documentation';
import { setGitHubChannel } from './handlers/github';
import {
  setDecisionsChannel,
  setThreadStatusChannel,
  handleDecisionReply,
  handleGroupchatMessage,
  dispatchUpgradeToRiley,
  dispatchReactionReply,
  getThreadStatusOpsLine,
  startSelfImprovementQueueWorker,
  stopSelfImprovementQueueWorker,
} from './handlers/groupchat';
import { autoReviewPR } from './handlers/review';
import { handleAgentMessage } from './handlers/textChannel';
import { runLoggingEngine } from './loggingEngine';
import { flushPendingWrites, initMemory } from './memory';
import { flushAllOpsDigests, formatToolAuditHuman, postOpsLine } from './activityLog';
import { setAgentErrorChannel, postAgentErrorLog } from './services/agentErrors';
import { runModelHealthChecks } from './services/modelHealthCheck';
import { setScreenshotsChannel } from './services/screenshots';
import { setTelephonyChannels, isTelephonyAvailable, initContacts } from './services/telephony';
import { setupChannels, BotChannels } from './setup';
import { setCommandAuditCallback, setPRReviewCallback, setSmokeTestCallback, smokeTestAgents, setDiscordGuild, setToolAuditCallback, setAgentChannelResolver } from './tools';
import { setLimitsChannel, setCostChannel, startDashboardUpdates, stopDashboardUpdates, initUsageCounters, flushUsageCounters, getUsageReport, getCostOpsSummaryLine, refreshUsageDashboard, toAgentTag } from './usage';
import { formatAge } from '../utils/time';
import { mapFilesToCategories, getTestsForCategories } from './tester';
import { recordAgentDecision, consolidateMemoryInsights, recordSmokeInsight, recordAgentLearning } from './vectorMemory';
import { recordUserEvent } from './userEvents';
import { captureAttachments } from './services/mediaCapture';
import { startEmbeddingWorker } from './embeddingWorker';
import { initPresence } from './presence';
import { registerContextMenus, handleMessageContextMenu } from './contextMenus';
import { isUpgradeApprovalCard } from './upgradeApproval';
import { enqueueSelfImprovementJob } from './selfImprovementQueue';
import { detectAnomalies } from './anomalyDetection';
import { goalState } from './handlers/goalState';
import { updateListingByMsgId, draftApplication, getProfile, getPortalByCompany, submitToGreenhouse, getListingById, updateListingStatus, setListingDiscordMsg, guessCompanyEmail, type JobListing } from '../services/jobSearch';
import { sendJobApplication } from '../services/email';
import { SYSTEM_COLORS, BUTTON_IDS, jobScoreColor } from './ui/constants';
import { errMsg } from '../utils/errors';
import { isTesterBotId } from '../utils/botIdentity';
import { buildDatabaseAuditSummary } from './databaseAudit';
import { recordLoopHealth, setLoopReportChannel } from './loopHealth';


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
let memoryConsolidationTimer: ReturnType<typeof setInterval> | null = null;
let databaseAuditTimer: ReturnType<typeof setInterval> | null = null;
let loggingEngineTimer: ReturnType<typeof setInterval> | null = null;
let anomalyDetectionTimer: ReturnType<typeof setInterval> | null = null;
const staleAlertDedupe = new Map<string, number>();
/** Tracks recovery attempts per feed to prevent infinite heal loops. */
const staleHealAttempts = new Map<string, { count: number; lastAttemptAt: number }>();
const HEAL_MAX_ATTEMPTS = 3;
const HEAL_COOLDOWN_MS = 15 * 60 * 1000; // 15 min between heal attempts
const OPS_STEWARD_AGENT_ID = 'operations-manager';
const RUNTIME_INSTANCE_TAG = (process.env.RUNTIME_INSTANCE_TAG || process.env.HOSTNAME || `pid-${process.pid}`).slice(0, 80);

/**
 * Best-effort inference of which agent authored a given Discord message.
 * The bot uses per-agent webhook usernames (`📋 Cortana`, `🧪 Argus`, …) so
 * matching on the displayed author name usually works. Falls back to the
 * owner of the workspace channel, or 'executive-assistant' as last resort.
 */
function inferAgentIdFromMessage(msg: Message): string {
  const authorName = String(msg.author?.username || '').toLowerCase();
  if (authorName) {
    const registry = [
      'cortana', 'argus', 'aphrodite', 'athena', 'iris', 'mnemosyne',
      'hermes', 'hephaestus', 'calliope', 'themis', 'artemis', 'prometheus',
    ];
    for (const name of registry) {
      if (authorName.includes(name)) {
        // Resolve display name → id via the agent lookup
        const found = getAgentByChannelName(name);
        if (found) return found.id;
      }
    }
  }
  // Channel name matches agent channel → use that agent's id
  const channelName = (msg.channel as { name?: string })?.name;
  if (channelName) {
    const found = getAgentByChannelName(channelName);
    if (found) return found.id;
  }
  return 'executive-assistant';
}
const nonTesterTriggerNoticeAt = new Map<string, number>();
let dedupeTableReady = false;
let lastDedupePruneAt = 0;
const CHANNEL_HEARTBEAT_INTERVAL_MS = Math.max(5 * 60 * 1000, parseInt(process.env.CHANNEL_HEARTBEAT_INTERVAL_MS || '1800000', 10));
const STALE_ALERT_COOLDOWN_MS = Math.max(10 * 60 * 1000, parseInt(process.env.CHANNEL_STALE_ALERT_COOLDOWN_MS || '7200000', 10));
const UPGRADES_TRIAGE_INTERVAL_MS = Math.max(30 * 60 * 1000, parseInt(process.env.UPGRADES_TRIAGE_INTERVAL_MS || '21600000', 10));
const DATABASE_AUDIT_INTERVAL_MS = Math.max(60 * 60 * 1000, parseInt(process.env.DATABASE_AUDIT_INTERVAL_MS || '21600000', 10));
const LOGGING_ENGINE_INTERVAL_MS = Math.max(10 * 60 * 1000, parseInt(process.env.LOGGING_ENGINE_INTERVAL_MS || '1800000', 10));
const NON_TESTER_TRIGGER_NOTICE_COOLDOWN_MS = parseInt(process.env.NON_TESTER_TRIGGER_NOTICE_COOLDOWN_MS || '120000', 10);
const UPGRADES_TRIAGE_MARKER = '[UPGRADES_TRIAGE_V1]';

type ChannelFeedContract = {
  key: string;
  channel: TextChannel;
  cadence: string;
  staleMs: number;
};

function getFeedContracts(channels: BotChannels): ChannelFeedContract[] {
  return [
    { key: 'thread-status', channel: channels.threadStatus, cadence: 'hourly', staleMs: 2 * 60 * 60 * 1000 },
    { key: 'limits', channel: channels.limits, cadence: '5m', staleMs: 20 * 60 * 1000 },
    { key: 'terminal', channel: channels.terminal, cadence: 'on-tool-call', staleMs: 2 * 60 * 60 * 1000 },
    { key: 'upgrades', channel: channels.upgrades, cadence: 'daily-triage', staleMs: 48 * 60 * 60 * 1000 },
    { key: 'url', channel: channels.url, cadence: 'on-deploy', staleMs: 72 * 60 * 60 * 1000 },
  ];
}

/**
 * Cache of the most recent message timestamp per monitored channel, updated
 * opportunistically from `MessageCreate` events (see the `messageCreate`
 * listener below). Lets the heartbeat loop skip a Discord REST round-trip
 * per feed when we've seen activity recently.
 */
const latestChannelMsgCache = new Map<string, number>();

/** Update the cache when a message lands in a channel we care about. */
function noteChannelActivity(channelId: string, timestamp: number): void {
  const prev = latestChannelMsgCache.get(channelId) || 0;
  if (timestamp > prev) latestChannelMsgCache.set(channelId, timestamp);
}

async function latestChannelMessageTimestamp(channel: TextChannel): Promise<number | null> {
  const cached = latestChannelMsgCache.get(channel.id);
  if (cached) return cached;
  const messages = await channel.messages.fetch({ limit: 1 }).catch(() => null);
  const latest = messages?.first();
  const ts = latest?.createdTimestamp || null;
  if (ts) latestChannelMsgCache.set(channel.id, ts);
  return ts;
}

export async function runChannelHeartbeat(channels: BotChannels): Promise<void> {
  try {
    const contracts = getFeedContracts(channels);
    const now = Date.now();
    const parts: string[] = [];
    const healed: string[] = [];

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

        const healState = staleHealAttempts.get(contract.key) || { count: 0, lastAttemptAt: 0 };
        if (healState.count < HEAL_MAX_ATTEMPTS && now - healState.lastAttemptAt >= HEAL_COOLDOWN_MS) {
          healState.count++;
          healState.lastAttemptAt = now;
          staleHealAttempts.set(contract.key, healState);

          try {
            if (contract.key === 'limits') {
              await refreshUsageDashboard();
              healed.push(`limits(restart-dashboard)`);
            } else if (contract.key === 'upgrades') {
              void runUpgradesTriage(channels).catch(() => {});
              healed.push(`upgrades(trigger-triage)`);
            }
          } catch (err) {
            console.error(`[heartbeat-heal] Failed to heal ${contract.key}:`, errMsg(err));
          }
        }
      } else {
        staleHealAttempts.delete(contract.key);
        // Close the loop on any prior stale alert: if we previously emitted
        // "Feed stale: X" we haven't yet emitted a recovery. Post one now
        // so the ops channel shows healed → state-change instead of
        // silently flipping.
        if (staleAlertDedupe.has(contract.key)) {
          staleAlertDedupe.delete(contract.key);
          await postAgentErrorLog('discord:feed-recovered', `Feed recovered: ${contract.key}`, {
            level: 'info',
            detail: `channel=#${contract.channel.name} age=${ts ? formatAge(age) : 'unknown'}`,
          });
        }
      }
    }

    const healNote = healed.length > 0 ? ` | healed: ${healed.join(', ')}` : '';
    const severity = parts.some((p) => p.startsWith('⚠️')) ? 'error' : 'info';
    await postOpsLine(channels.threadStatus, {
      actor: OPS_STEWARD_AGENT_ID,
      scope: 'channel-heartbeat',
      metric: `feeds=${contracts.length}`,
      delta: parts.join(' | ') + healNote,
      action: healed.length > 0 ? 'heal' : 'none',
      severity,
    });
    recordLoopHealth('channel-heartbeat', severity === 'error' ? 'warn' : 'ok', `${parts.join(' | ')}${healNote}`);
  } catch (err) {
    recordLoopHealth('channel-heartbeat', 'error', errMsg(err));
    throw err;
  }
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

export async function runUpgradesTriage(channels: BotChannels): Promise<void> {
  try {
    const upgrades = channels.upgrades;
    const messages = await upgrades.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages || messages.size === 0) {
      recordLoopHealth('upgrades-triage', 'ok', 'no upgrades to triage');
      return;
    }

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

    const actionable = top.find((e) => e.label === 'accepted' && e.count >= 2);
    if (actionable && channels.groupchat) {
      await dispatchUpgradeToRiley(actionable.sample, channels.groupchat).catch((err) => {
        console.warn('Upgrades auto-dispatch failed:', errMsg(err));
      });
      // Create a durable self-improvement job so the upgrade is tracked even if the groupchat dispatch is lost
      enqueueSelfImprovementJob({
        packet: {
          managerAgentId: 'executive-assistant',
          consumerAgentId: 'opus',
          stewardAgentId: 'operations-manager',
          summary: `Accepted upgrade: ${actionable.sample.slice(0, 200)}`,
          requests: [{ kind: 'upgrade', summary: actionable.sample.slice(0, 300) }],
          recommendedLoopIds: ['upgrades-triage'],
        },
        goal: `Apply accepted upgrade: ${actionable.sample.slice(0, 200)}`,
        conversationSummary: '',
        status: 'completed',
        directiveContext: `upgrade-accepted:${actionable.sample.slice(0, 200)}`,
        groupchatChannelId: channels.groupchat.id,
        workspaceChannelId: channels.threadStatus?.id || channels.groupchat.id,
      }).catch((err) => console.warn('Upgrade job enqueue failed:', errMsg(err)));
      recordAgentLearning('operations-manager', `Accepted upgrade: ${actionable.sample.slice(0, 300)}`, 'upgrade-accepted', 'upgrade').catch(() => {});
    }
    recordLoopHealth('upgrades-triage', 'ok', `items=${top.length}${actionable ? ' dispatched=1' : ' dispatched=0'}`);
  } catch (err) {
    recordLoopHealth('upgrades-triage', 'error', errMsg(err));
    throw err;
  }
}

async function getExistingTables(tableNames: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const tableName of tableNames) {
    const res = await pool.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${tableName}`]);
    if (res.rows?.[0]?.exists) {
      existing.push(tableName);
    }
  }
  return existing;
}

export async function runDatabaseAudit(channels: BotChannels): Promise<void> {
  try {
    const appliedResult = await pool.query('SELECT filename FROM applied_migrations ORDER BY filename');
    const applied = new Set(appliedResult.rows.map((row: { filename: string }) => row.filename));
    const runtimeTables = await getExistingTables(REQUIRED_RUNTIME_TABLES);
    const missingRuntimeTables = REQUIRED_RUNTIME_TABLES.filter((table) => !runtimeTables.includes(table));
    const legacyTables = await getExistingTables(LEGACY_APP_TABLES);
    const dropApplied = applied.has(LEGACY_DROP_MIGRATION);

    const summary = buildDatabaseAuditSummary({
      appliedMigrationCount: applied.size,
      requiredRuntimeTableCount: REQUIRED_RUNTIME_TABLES.length,
      runtimeTables,
      missingRuntimeTables,
      legacyTables,
      dropApplied,
    });

    await postOpsLine(channels.threadStatus, {
      actor: OPS_STEWARD_AGENT_ID,
      scope: 'database-audit',
      metric: summary.metric,
      delta: summary.delta,
      action: summary.action,
      severity: summary.severity,
    });

    if (missingRuntimeTables.length > 0) {
      await postAgentErrorLog('discord:db-audit', 'Database audit found missing runtime tables', {
        level: 'warn',
        detail: `Missing runtime tables: ${missingRuntimeTables.join(', ')}`,
      });
    }

    if (dropApplied && legacyTables.length > 0) {
      await postAgentErrorLog('discord:db-audit', 'Legacy tables remain after drop migration', {
        level: 'warn',
        detail: `Drop migration ${LEGACY_DROP_MIGRATION} is marked applied but legacy tables still exist: ${legacyTables.join(', ')}`,
      });
    }
    recordLoopHealth('database-audit', summary.severity === 'error' ? 'error' : summary.severity === 'warn' ? 'warn' : 'ok', summary.delta);
  } catch (err) {
    const detail = errMsg(err);
    await postOpsLine(channels.threadStatus, {
      actor: OPS_STEWARD_AGENT_ID,
      scope: 'database-audit',
      metric: 'query-failed',
      delta: detail,
      action: 'none',
      severity: 'warn',
    }).catch(() => {});
    await postAgentErrorLog('discord:db-audit', 'Database audit failed', {
      level: 'warn',
      detail,
    });
    recordLoopHealth('database-audit', 'error', detail);
  }
}

function startOpsMonitors(channels: BotChannels): void {
  if (channelHeartbeatTimer) clearInterval(channelHeartbeatTimer);
  if (upgradesTriageTimer) clearInterval(upgradesTriageTimer);
  if (memoryConsolidationTimer) clearInterval(memoryConsolidationTimer);
  if (databaseAuditTimer) clearInterval(databaseAuditTimer);
  if (loggingEngineTimer) clearInterval(loggingEngineTimer);
  if (anomalyDetectionTimer) clearInterval(anomalyDetectionTimer);

  channelHeartbeatTimer = setInterval(() => {
    void runChannelHeartbeat(channels).catch(() => {});
  }, CHANNEL_HEARTBEAT_INTERVAL_MS);
  upgradesTriageTimer = setInterval(() => {
    void runUpgradesTriage(channels).catch(() => {});
  }, UPGRADES_TRIAGE_INTERVAL_MS);
  memoryConsolidationTimer = setInterval(() => {
    void consolidateMemoryInsights().then((result) => {
      recordLoopHealth('memory-consolidation', 'ok', result ? result.slice(0, 160) : 'no new insights');
      if (result) {
        void postOpsLine(channels.threadStatus, {
          actor: OPS_STEWARD_AGENT_ID,
          scope: 'memory-consolidation',
          metric: 'insights',
          delta: result.slice(0, 300),
          action: 'none',
          severity: 'info',
        }).catch(() => {});
      }
    }).catch((err) => {
      recordLoopHealth('memory-consolidation', 'error', errMsg(err));
    });
  }, 4 * 60 * 60 * 1000);
  databaseAuditTimer = setInterval(() => {
    void runDatabaseAudit(channels).catch(() => {});
  }, DATABASE_AUDIT_INTERVAL_MS);
  loggingEngineTimer = setInterval(() => {
    void runLoggingEngine(channels).catch(() => {});
  }, LOGGING_ENGINE_INTERVAL_MS);
  anomalyDetectionTimer = setInterval(() => {
    void detectAnomalies().then((anomalies) => {
      if (anomalies.length > 0 && channels.agentErrors) {
        const lines = anomalies.map(a => `${a.severity === 'error' ? '❌' : '⚠️'} **${a.type}**: ${a.detail}`);
        channels.agentErrors.send(`🔍 **Anomaly Detection**\n${lines.join('\n')}`.slice(0, 1900)).catch(() => {});
      }
    }).catch(() => {});
  }, LOGGING_ENGINE_INTERVAL_MS);

  void runChannelHeartbeat(channels).catch(() => {});
  void runLoggingEngine(channels).catch(() => {});
  void runUpgradesTriage(channels).catch(() => {});
  void runDatabaseAudit(channels).catch(() => {});
  void detectAnomalies().catch(() => {});
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
    initPresence(readyClient);

    // Warm outbound connections + caches so the first turn after boot is
    // fast. All best-effort — failures never block startup.
    void (async () => {
      try {
        const [{ warmCortanaVoiceAtStartup }, { warmAnthropicConnection }] = await Promise.all([
          import('./voice/elevenlabs'),
          import('./warmStart'),
        ]);
        // Run in parallel — voice warm takes ~2-5s for multiple phrases,
        // Anthropic probe is ~300-800ms. No reason to serialize.
        await Promise.allSettled([
          warmCortanaVoiceAtStartup(),
          warmAnthropicConnection(),
        ]);
      } catch (err) {
        console.warn('[warm] startup warm failed:', errMsg(err));
      }
    })();

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
      await loadDynamicAgentsFromDb();
      await initUsageCounters();
      botChannels = await setupChannels(guild);
      const configuredChannels = botChannels;
      setBotChannels(configuredChannels);
      setLoopReportChannel(configuredChannels.loops);
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
        const msg = errMsg(err);
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

          const input = {
            actor: tag,
            scope: 'tool-audit:db',
            metric: toolName,
            delta: `batched${suppressedNote}`,
            action: 'none',
            severity: 'info' as const,
          };
          const line = formatToolAuditHuman(input);
          const taggedLine = `${line} [TOOL:${toolName}]`;
          void terminalChannel.send(taggedLine.slice(0, 1900)).catch(() => {});
          return;
        }

        const input = {
          actor: tag,
          scope: 'tool-audit',
          metric: toolName,
          delta: summary.replace(/\s+/g, ' ').trim(),
          action: 'none',
          severity: 'info' as const,
        };
        const line = formatToolAuditHuman(input);
        // Append structured tag for machine-readable tool-audit matching
        const taggedLine = `${line} [TOOL:${toolName}]`;
        void terminalChannel.send(taggedLine.slice(0, 1900)).catch(() => {});
      });

      setPRReviewCallback(async (prNumber, prTitle, changedFiles, diffSummary) => {
        await autoReviewPR(prNumber, prTitle, changedFiles, diffSummary, configuredChannels.groupchat);
      });

      // ── Test Engine Loop: auto-smoke after PR merge ──
      setSmokeTestCallback(async (prNumber, changedFiles) => {
        try {
          const categories = mapFilesToCategories(changedFiles);
          const tests = getTestsForCategories(categories);
          if (tests.length === 0) {
            recordLoopHealth('test-engine', 'ok', `pr=${prNumber} no matching tests`);
            return;
          }

          const testNames = [...new Set(tests.map((t) => t.capability))].join(',');
          console.log(`[smoke-auto] PR #${prNumber} merged — running ${tests.length} tests across [${[...categories].join(', ')}]`);

          const result = await smokeTestAgents({ tests: testNames, profile: 'readiness' });
          const hasFails = result.includes('❌') || result.toLowerCase().includes('fail');
          const summary = result.slice(-500);

          void recordAgentDecision(
            'executive-assistant',
            `PR #${prNumber} post-merge smoke (${[...categories].join(',')}): ${hasFails ? 'FAILURES' : 'PASS'}\n${summary}`,
            `merge PR #${prNumber}`
          );

          void recordSmokeInsight([...categories], hasFails, summary);

          if (hasFails && !goalState.isActive()) {
            const failSummary = `Post-merge smoke test regression from PR #${prNumber}.\nAffected categories: ${[...categories].join(', ')}\n\n${summary}`;
            void dispatchUpgradeToRiley(failSummary, configuredChannels.groupchat).catch((err) => {
              console.warn(`[smoke-auto] Cortana dispatch failed:`, errMsg(err));
            });
          }

          recordLoopHealth('test-engine', hasFails ? 'warn' : 'ok', `pr=${prNumber} tests=${tests.length} categories=${[...categories].join(',')}`);
        } catch (err) {
          recordLoopHealth('test-engine', 'error', `pr=${prNumber} ${errMsg(err)}`);
          throw err;
        }
      });
      console.log(`Discord channels configured in "${guild.name}"`);

      startOpsMonitors(configuredChannels);
      startSelfImprovementQueueWorker();
      startEmbeddingWorker();
      // Register message/user context-menu commands (right-click → Apps
      // → "Ask Cortana about this"). Idempotent.
      void registerContextMenus(guild);
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
      console.error('Channel setup error:', errMsg(err));
      void postAgentErrorLog('discord:startup', 'Channel setup error', { detail: msg });

      // Retry with exponential backoff (max 3 attempts)
      const MAX_STARTUP_RETRIES = 3;
      for (let attempt = 1; attempt <= MAX_STARTUP_RETRIES; attempt++) {
        const delayMs = Math.min(5_000 * Math.pow(2, attempt - 1), 30_000);
        console.warn(`[startup-retry] Attempt ${attempt}/${MAX_STARTUP_RETRIES} in ${delayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        try {
          await initMemory();
          await loadDynamicAgentsFromDb();
          await initUsageCounters();
          botChannels = await setupChannels(guild);
          console.log(`[startup-retry] Attempt ${attempt} succeeded.`);
          break;
        } catch (retryErr) {
          console.error(`[startup-retry] Attempt ${attempt} failed:`, errMsg(retryErr));
          if (attempt === MAX_STARTUP_RETRIES) {
            console.error('Bot initialization failed after retries — destroying client');
            readyClient.destroy();
            client = null;
            return;
          }
        }
      }
      if (!botChannels) return;
      const configuredChannels = botChannels;
      setBotChannels(configuredChannels);
      setLoopReportChannel(configuredChannels.loops);
      setGitHubChannel(configuredChannels.github);
      setLimitsChannel(configuredChannels.limits);
      setCostChannel(configuredChannels.cost);
      setScreenshotsChannel(configuredChannels.screenshots);
      setVoiceErrorChannel(configuredChannels.voiceErrors);
      setAgentErrorChannel(configuredChannels.agentErrors);
      setDiscordGuild(guild);
      setAgentChannelResolver((agentId: string) => configuredChannels.agentChannels.get(agentId) || null);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    // Update the heartbeat cache so runChannelHeartbeat can skip a REST
    // fetch for channels we've seen activity in recently.
    if (message.channel && 'id' in message.channel) {
      noteChannelActivity((message.channel as { id: string }).id, message.createdTimestamp);
    }

    // Debug: trace message reception for groupchat channel
    if (botChannels && message.channel.id === botChannels.groupchat.id) {
      console.log(`[msg-trace] author=${message.author.id} bot=${message.author.bot} tester=${isTesterBotId(message.author.id)} content="${String(message.content || '').slice(0, 60)}"`);
    }

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
      console.warn('Discord message dedupe check failed:', errMsg(err));
      return true;
    });
    if (!claimed) return;

    const channelId = message.channel.id;

    // Capture every user message into user_events for Cortana's memory + SI.
    // Runs fire-and-forget so memory capture never blocks the hot path.
    void (async () => {
      const threadId = message.channel.isThread() ? message.channel.id : null;
      const parentChannelId = message.channel.isThread()
        ? (message.channel.parentId || channelId)
        : channelId;
      const hasText = !!(message.content && message.content.trim());
      const hasAttachments = message.attachments.size > 0;

      if (hasText) {
        await recordUserEvent({
          userId: message.author.id,
          channelId: parentChannelId,
          threadId,
          messageId: message.id,
          kind: 'text',
          text: message.content,
          metadata: { username: message.author.username },
        });
      }

      if (hasAttachments) {
        await captureAttachments(message, { parentChannelId, threadId });
      }
    })().catch((err) => console.warn('[capture] user event capture failed:', errMsg(err)));

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
      console.error('Message handler error:', errMsg(err));
      void postAgentErrorLog('discord:message-handler', isAbortLike ? 'Message handler aborted' : 'Message handler error', {
        detail: msg,
        level: isAbortLike ? 'info' : 'error',
      });
    }
  });

  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    try {
      if (!newMessage.author || newMessage.author.bot) return;
      if (!newMessage.guild) return;
      const parentChannelId = newMessage.channel.isThread()
        ? (newMessage.channel.parentId || newMessage.channel.id)
        : newMessage.channel.id;
      const threadId = newMessage.channel.isThread() ? newMessage.channel.id : null;
      await recordUserEvent({
        userId: newMessage.author.id,
        channelId: parentChannelId,
        threadId,
        messageId: newMessage.id,
        kind: 'edit',
        text: newMessage.content || null,
        metadata: {
          before: typeof oldMessage.content === 'string' ? oldMessage.content.slice(0, 500) : null,
        },
      });
    } catch (err) {
      console.warn('[capture] edit capture failed:', errMsg(err));
    }
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (user.bot) return;
      if (reaction.partial) {
        try { await reaction.fetch(); } catch { return; }
      }
      const msg = reaction.message;
      if (!msg?.channel) return;
      const parentChannelId = msg.channel.isThread()
        ? (msg.channel.parentId || msg.channel.id)
        : msg.channel.id;
      const threadId = msg.channel.isThread() ? msg.channel.id : null;
      await recordUserEvent({
        userId: user.id,
        channelId: parentChannelId,
        threadId,
        messageId: msg.id,
        kind: 'reaction',
        text: reaction.emoji.name || null,
        metadata: {
          emoji: reaction.emoji.name,
          targetAuthorId: msg.author?.id,
        },
      });

      // Quick-react feedback: 👍/👎 on a bot-authored or webhook-authored message
      // counts as a signal on that agent's reply. Record as an agent_learning
      // so self-improvement can pick it up later.
      const emoji = String(reaction.emoji.name || '');
      const isThumbsUp = emoji === '👍' || emoji === '👍🏻' || emoji === '👍🏼' || emoji === '👍🏽' || emoji === '👍🏾' || emoji === '👍🏿';
      const isThumbsDown = emoji === '👎' || emoji === '👎🏻' || emoji === '👎🏼' || emoji === '👎🏽' || emoji === '👎🏾' || emoji === '👎🏿';
      if ((isThumbsUp || isThumbsDown) && (msg.webhookId || msg.author?.bot)) {
        const agentId = inferAgentIdFromMessage(msg as Message);
        const preview = typeof msg.content === 'string' ? msg.content.slice(0, 280) : '';
        const tag = isThumbsUp ? 'feedback-positive' : 'feedback-negative';
        const pattern = isThumbsUp
          ? `User \ud83d\udc4d'd this reply: "${preview}"`
          : `User \ud83d\udc4e'd this reply — consider what went wrong: "${preview}"`;
        void recordAgentLearning(agentId, pattern, tag, 'discord-react');
      }

      // ✅/❌ on a bot message that asked a binary question → route as a yes/no reply.
      const isCheck = emoji === '✅';
      const isCross = emoji === '❌';
      if ((isCheck || isCross) && (msg.webhookId || msg.author?.bot) && botChannels) {
        const text = typeof msg.content === 'string' ? msg.content : '';

        // Upgrade-approval card reactions take priority — ✅ implements,
        // ❌ dismisses. Handled before the generic yes/no fallback below.
        const inUpgradesChannel = msg.channelId === botChannels.upgrades.id;
        if (inUpgradesChannel && isUpgradeApprovalCard(text)) {
          if (isCheck) {
            const cleaned = text.replace(/^\[UPGRADE CARD\]\s*<@!?\d+>\s*—\s*/, '').trim();
            void dispatchUpgradeToRiley(cleaned, botChannels.groupchat).catch(() => {});
            void msg.reply(`✅ Approved by ${user.username} — implementing now.`).catch(() => {});
          } else {
            void msg.reply(`❌ Dismissed by ${user.username}.`).catch(() => {});
          }
          return;
        }

        if (/\?\s*$/.test(text.trim())) {
          void dispatchReactionReply(
            isCheck ? 'yes' : 'no',
            text,
            user.username || 'user',
            botChannels.groupchat,
          );
        }
      }
    } catch (err) {
      console.warn('[capture] reaction capture failed:', errMsg(err));
    }
  });

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    if (!botChannels) return;

    const targetVoiceId = botChannels.voiceChannel.id;
    const joinedTarget = oldState.channelId !== targetVoiceId && newState.channelId === targetVoiceId;
    const leftTarget = oldState.channelId === targetVoiceId && newState.channelId !== targetVoiceId;

    // Ignore voice state updates unrelated to the managed Cortana voice channel.
    if (!joinedTarget && !leftTarget) return;

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) {
      return;
    }

    if (joinedTarget && !isCallActive()) {
      try {
        await startCall(botChannels.voiceChannel, botChannels.groupchat, botChannels.callLog, member);
      } catch (err) {
        const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
        console.error('Voice auto join handler error:', errMsg(err));
        void postAgentErrorLog('discord:voice-auto-start', 'Voice auto join error', { detail: msg, level: 'warn' });
      }
    } else if (joinedTarget && isCallActive()) {
      // Pre-init STT for the new member to eliminate WebSocket cold-start latency
      preInitSttForMember(member);
      // Multi-party: Cortana acknowledges the new participant out loud.
      // Fire-and-forget — failure doesn't affect call state.
      void announceVoiceMember('joined', member.displayName, member.id);
    }

    if (leftTarget && isCallActive()) {
      const remainingHumans = botChannels.voiceChannel.members.filter((m) => !m.user.bot).size;
      if (remainingHumans === 0) {
        try {
          await endCall();
        } catch (err) {
          const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
          console.error('Voice auto leave handler error:', errMsg(err));
          void postAgentErrorLog('discord:voice-auto-end', 'Voice auto leave error', { detail: msg, level: 'warn' });
        }
      } else {
        // Someone left but others remain — Cortana sends them off.
        void announceVoiceMember('left', member.displayName, member.id);
      }
    }
  });

  // ── Button interaction handler for job approvals + draft approvals ──
  client.on(Events.InteractionCreate, async (interaction) => {
    // Context-menu (right-click → Apps → "Ask Cortana about this"). Routed
    // into Cortana's orchestration via the groupchat entry point.
    if (interaction.isMessageContextMenuCommand()) {
      if (!botChannels) return;
      try {
        await handleMessageContextMenu(interaction, botChannels.groupchat);
      } catch (err) {
        console.error('Context-menu handler error:', errMsg(err));
      }
      return;
    }

    if (!interaction.isButton()) return;
    const customId = interaction.customId;

    void recordUserEvent({
      userId: interaction.user.id,
      channelId: interaction.channelId ?? '',
      threadId: interaction.channel?.isThread() ? interaction.channel.id : null,
      messageId: interaction.message?.id,
      kind: 'button',
      text: customId,
      metadata: {
        customId,
        messagePreview: typeof interaction.message?.content === 'string'
          ? interaction.message.content.slice(0, 200)
          : null,
      },
    }).catch(() => {});

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
              console.error('Auto-draft error:', errMsg(err))
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
      console.error('Button interaction error:', errMsg(err));
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
    console.error('Discord bot login failed:', errMsg(err));
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
  if (memoryConsolidationTimer) {
    clearInterval(memoryConsolidationTimer);
    memoryConsolidationTimer = null;
  }
  if (databaseAuditTimer) {
    clearInterval(databaseAuditTimer);
    databaseAuditTimer = null;
  }
  stopSelfImprovementQueueWorker();
  stopDashboardUpdates();
  setCommandAuditCallback(() => {});
  setToolAuditCallback(() => {});
  setPRReviewCallback(async () => {});
  setSmokeTestCallback(null);
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
    setLoopReportChannel(null);
    console.log('Discord bot disconnected');
  }
}
