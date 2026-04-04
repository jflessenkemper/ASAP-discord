import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { Message, TextChannel, GuildMember, EmbedBuilder, ThreadAutoArchiveDuration } from 'discord.js';
import {
  getAgents,
  getAgent,
  AgentConfig,
  AgentId,
  buildAgentMentionGuide,
  getAgentMention,
  resolveAgentId,
  resolveAgentIdByRoleId,
} from '../agents';
import { agentRespond, clearGeminiQuotaFuse, ConversationMessage, getContextRuntimeReport, getGeminiQuotaFuseStatus, setQuotaFuseNotifyCallback, setRateLimitNotifyCallback } from '../claude';
import { appendToMemory, getMemoryContext, loadMemory, saveMemory, clearMemory, compressMemory } from '../memory';
import { documentToChannel } from './documentation';
import { sendAgentMessage, clearHistory } from './textChannel';
import { startCall, endCall, isCallActive, injectVoiceTranscriptForTesting } from './callSession';
import { makeOutboundCall, makeAsapTesterCall, startConferenceCall, isTelephonyAvailable } from '../services/telephony';
import { getBotChannels } from '../bot';
import { approveAdditionalBudget, getContextEfficiencyReport, getUsageReport, refreshLiveBillingData, refreshUsageDashboard } from '../usage';
import { getWebhook, sendWebhookMessage, WebhookCapableChannel } from '../services/webhooks';

/** Send a tool-use notification as the agent (via webhook). */
async function sendToolNotification(channel: WebhookCapableChannel, agent: AgentConfig, summary: string): Promise<void> {
  try {
    await sendWebhookMessage(channel, {
      content: `🔧 ${summary}`,
      username: `${agent.emoji} ${agent.name}`,
      avatarURL: agent.avatarUrl,
    });
  } catch (err) {
    console.warn(`Webhook tool notification failed for ${agent.name}:`, err instanceof Error ? err.message : 'Unknown');
  }
}
import { triggerCloudBuild, listRevisions, getCurrentRevision, rollbackToRevision } from '../../services/cloudrun';
import { captureAndPostScreenshots } from '../services/screenshots';
import { postAgentErrorLog } from '../services/agentErrors';
import { formatOpsLine } from '../services/opsFeed';

let groupHistory: ConversationMessage[] = loadMemory('groupchat');

// Global FIFO for groupchat events. A single stuck request can block all later
// messages, so processing is always paired with explicit timeout guards.
let messageQueue: Promise<void> = Promise.resolve();

// In-flight cancellation token. New inbound messages abort older work so the
// bot follows the newest user intent instead of finishing stale tasks.
let activeAbortController: AbortController | null = null;
let activeThinkingMessage: Message | null = null;
let activeGoalThreadId: string | null = null;
let activeGoalSequence = 0;
let claudeNotificationsBoundChannelId: string | null = null;
const MAX_PARALLEL_SUBAGENTS = parseInt(process.env.MAX_PARALLEL_SUBAGENTS || '1', 10);
const SUBAGENT_MAX_TOKENS = parseInt(process.env.SUBAGENT_MAX_TOKENS || '900', 10);
const GROUPCHAT_PROCESS_TIMEOUT_MS = parseInt(process.env.GROUPCHAT_PROCESS_TIMEOUT_MS || '120000', 10);
const RILEY_NO_RESPONSE_TIMEOUT_MS = parseInt(process.env.RILEY_NO_RESPONSE_TIMEOUT_MS || '45000', 10);
const DIRECT_GROUPCHAT_SHORT_PROMPT_MAX_WORDS = parseInt(process.env.DIRECT_GROUPCHAT_SHORT_PROMPT_MAX_WORDS || '18', 10);

let activeGoal: string | null = null;
let goalStatus: string | null = null;
let activeGoalStartedAt = Date.now();

const GOAL_STALL_TIMEOUT_MS = parseInt(process.env.GOAL_STALL_TIMEOUT_MS || '420000', 10);
const GOAL_STALL_CHECK_INTERVAL_MS = parseInt(process.env.GOAL_STALL_CHECK_INTERVAL_MS || '60000', 10);
const GOAL_STALL_MAX_RECOVERY_ATTEMPTS = parseInt(process.env.GOAL_STALL_MAX_RECOVERY_ATTEMPTS || '1', 10);
const ENABLE_AUTOMATIC_THREAD_CLOSE_REVIEW = process.env.ENABLE_AUTOMATIC_THREAD_CLOSE_REVIEW === 'true';
const THREAD_CLOSE_REVIEW_IDLE_MS = parseInt(process.env.THREAD_CLOSE_REVIEW_IDLE_MS || '1800000', 10);
const THREAD_CLOSE_REVIEW_INTERVAL_MS = parseInt(process.env.THREAD_CLOSE_REVIEW_INTERVAL_MS || '7200000', 10);
const THREAD_STATUS_POST_INTERVAL_MS = parseInt(process.env.THREAD_STATUS_POST_INTERVAL_MS || '3600000', 10);
const ACTION_COMMAND_TIMEOUT_MS = parseInt(process.env.ACTION_COMMAND_TIMEOUT_MS || '120000', 10);
const AUTO_DEPLOY_ON_THREAD_CLOSE = String(process.env.AUTO_DEPLOY_ON_THREAD_CLOSE || 'true').toLowerCase() !== 'false';
const GOAL_THREAD_COUNTER_RE = /\bgoal[-\s]?(\d{4})\b/i;
const APP_SERVER_ROOT = (fs.existsSync(path.join(process.cwd(), 'package.json')) && fs.existsSync(path.join(process.cwd(), 'src')))
  ? process.cwd()
  : path.resolve(__dirname, '../../..');
const APP_REPO_ROOT = path.resolve(APP_SERVER_ROOT, '..');
let lastGoalProgressAt = Date.now();
let goalRecoveryAttempts = 0;
const DEFAULT_TESTER_BOT_ID = '1487426371209789450';

function isTesterBotId(userId: string): boolean {
  const configured = String(process.env.DISCORD_TESTER_BOT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const allowed = new Set([DEFAULT_TESTER_BOT_ID, ...configured]);
  return allowed.has(userId);
}
let lastThreadCloseReviewAt = 0;
let lastThreadStatusPostAt = 0;
let goalSequenceInitialized = false;
let goalWatchdog: ReturnType<typeof setInterval> | null = null;
let threadStatusChannel: TextChannel | null = null;
let threadStatusSourceChannel: TextChannel | null = null;
let threadStatusReporter: ReturnType<typeof setInterval> | null = null;

function markGoalProgress(status?: string): void {
  lastGoalProgressAt = Date.now();
  goalRecoveryAttempts = 0;
  if (status) goalStatus = status;
}

function compactAuditField(value: string | undefined | null, maxLen = 80): string {
  const normalized = (value || 'n/a').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1)}…`;
}

function normalizeDirectedPrompt(prompt: string): string {
  return String(prompt || '')
    .replace(/<@[!&]?\d+>/g, ' ')
    .replace(/^(?:\[[^\]]+\]\s*)+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldEchoDirectedResponseToGroupchat(agentIds: string[], userMessage: string): boolean {
  if (agentIds.length !== 1 || agentIds[0] !== 'developer') return false;
  const normalized = normalizeDirectedPrompt(userMessage);
  if (!normalized) return false;
  if (normalized.length > 180) return false;
  return normalized.split(/\s+/).length <= DIRECT_GROUPCHAT_SHORT_PROMPT_MAX_WORDS;
}

async function sendAutopilotAudit(
  groupchat: TextChannel,
  event: string,
  detail: string,
  extra?: { action?: string; buildId?: string; attempt?: number }
): Promise<void> {
  const riley = getAgent('executive-assistant' as AgentId);
  const goal = compactAuditField(activeGoal || 'none', 64);
  const status = compactAuditField(goalStatus || 'n/a', 48);
  const bits = [
    `event=${event}`,
    extra?.action ? `action=${compactAuditField(extra.action, 24)}` : null,
    Number.isFinite(extra?.attempt) ? `attempt=${extra!.attempt}` : null,
    extra?.buildId ? `build=${compactAuditField(extra.buildId, 24)}` : null,
    `goal="${goal}"`,
    `status="${status}"`,
    `detail="${compactAuditField(detail, 120)}"`,
  ].filter(Boolean);
  const line = `AUTOPILOT_AUDIT ${bits.join(' ')}`;

  console.log(line);

  if (process.env.AUTOPILOT_AUDIT_PUBLIC !== 'true') {
    return;
  }

  if (!riley) {
    await groupchat.send(line).catch(() => {});
    return;
  }

  try {
    const wh = await getWebhook(groupchat);
    await wh.send({ content: line, username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
  } catch {
    await groupchat.send(line).catch(() => {});
  }
}

function ensureClaudeNotifications(groupchat: TextChannel): void {
  if (claudeNotificationsBoundChannelId === groupchat.id) return;
  claudeNotificationsBoundChannelId = groupchat.id;

  const sendSystemNotice = (content: string) => {
    const riley = getAgent('executive-assistant' as AgentId);
    const send = async () => {
      const targetChannel = getAgentWorkChannel('executive-assistant', groupchat);
      if (riley) {
        try {
          const wh = await getWebhook(targetChannel);
          await wh.send({
            content,
            username: `${riley.emoji} ${riley.name}`,
            avatarURL: riley.avatarUrl,
          });
          return;
        } catch {
        }
      }
      await targetChannel.send(content).catch(() => {});
    };

    void send();
  };

  setRateLimitNotifyCallback(sendSystemNotice);
  setQuotaFuseNotifyCallback(sendSystemNotice);
}

function inferImplicitActionTags(text: string): string {
  const tags = new Set<string>();
  const normalized = text.toLowerCase();
  const allowInfraActions = process.env.RILEY_ALLOW_IMPLICIT_INFRA_ACTIONS === 'true';

  const deployRequested = /(build triggered|triggered build|deploying|deployment triggered|rolling out|release started)/i.test(normalized);
  const deployNegated = /\b(?:do not|don't|dont|won't|wont|not|skip|without|avoid|no)\b[^.!?\n]{0,24}\b(?:deploy|deployment|roll\s*out|release)\b/i.test(normalized);
  if (allowInfraActions && deployRequested && !deployNegated) {
    tags.add('[ACTION:DEPLOY]');
  }

  const screenshotsRequested = /(capturing screenshots|taking screenshots|screenshot capture|posting screenshots|take screenshots|capture screenshots)/i.test(normalized);
  const screenshotsNegated = /\b(?:do not|don't|dont|won't|wont|not|skip|without|avoid|no)\b[^.!?\n]{0,24}\b(?:take|taking|capture|capturing|post|posting)?\s*screenshots?\b/i.test(normalized);
  if (screenshotsRequested && !screenshotsNegated) {
    tags.add('[ACTION:SCREENSHOTS]');
  }

  const urlsRequested = /(asap links|live url|app url|posting.*url|paste.*url|share.*url)/i.test(normalized);
  const urlsNegated = /\b(?:do not|don't|dont|won't|wont|not|skip|without|avoid|no)\b[^.!?\n]{0,24}\b(?:post|paste|share)?\s*.*url\b/i.test(normalized);
  if (allowInfraActions && urlsRequested && !urlsNegated) {
    tags.add('[ACTION:URLS]');
  }

  if (/(usage report|limits report|budget report|token report)/i.test(normalized)) {
    tags.add('[ACTION:LIMITS]');
  }
  if (/(clear quota fuse|reset quota fuse|unfuse|clear gemini fuse|reset gemini fuse)/i.test(normalized)) {
    tags.add('[ACTION:UNFUSE]');
  }
  if (/(context report|prompt breakdown|token breakdown|context efficiency|prompt efficiency report)/i.test(normalized)) {
    tags.add('[ACTION:CONTEXT]');
  }
  if (/(thread status|open threads|stale threads|ready to close)/i.test(normalized)) {
    tags.add('[ACTION:THREADS]');
  }
  if (/(health check|release health|prod health|deployment health)/i.test(normalized)) {
    tags.add('[ACTION:HEALTH]');
  }
  if (/(smoke test|sanity check|end to end check|e2e check)/i.test(normalized)) {
    tags.add('[ACTION:SMOKE]');
  }
  if (/(who changed|look through commits|regression|git history|blame)/i.test(normalized)) {
    tags.add('[ACTION:REGRESSION]');
  }
  if (/(clean\s*up\s*(group)?\s*chat|delete\s+(spam|noise|disjointed|clutter)|tidy\s+up\s+groupchat|remove\s+spam\s+messages)/i.test(normalized)) {
    tags.add('[ACTION:CLEANUP:25]');
  }

  return [...tags].join('\n');
}

function parseCleanupOptions(param?: string): {
  requestedCount: number;
  targetCount: number;
  maxAgeMs: number | null;
  descriptor: string;
} {
  if (!param) {
    return { requestedCount: 25, targetCount: 25, maxAgeMs: null, descriptor: 'latest messages' };
  }

  const [countPart, windowPart] = param.split(':').map((part) => part.trim()).filter(Boolean);
  const parsedCount = parseInt((countPart || '25').match(/\d+/)?.[0] || '25', 10);
  const requestedCount = Number.isFinite(parsedCount) ? Math.max(1, parsedCount) : 25;
  const targetCount = Math.min(50, requestedCount);

  let maxAgeMs: number | null = null;
  let descriptor = 'latest messages';
  if (windowPart) {
    const match = windowPart.match(/^(\d+)([mh])$/i);
    if (match) {
      const amount = parseInt(match[1], 10);
      maxAgeMs = match[2].toLowerCase() === 'h'
        ? amount * 60 * 60 * 1000
        : amount * 60 * 1000;
      descriptor = `last ${amount}${match[2].toLowerCase()}`;
    }
  }

  return { requestedCount, targetCount, maxAgeMs, descriptor };
}

async function cleanupGroupchatNoise(groupchat: TextChannel, targetCount: number, maxAgeMs: number | null): Promise<number> {
  const fetchLimit = Math.max(40, Math.min(100, targetCount * 4));
  const recent = await groupchat.messages.fetch({ limit: fetchLimit });
  const now = Date.now();
  const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
  const botId = groupchat.client.user?.id;

  const deletable = [...recent.values()].filter((msg) => {
    if (!msg.deletable || msg.pinned) return false;
    if (now - msg.createdTimestamp > TWO_WEEKS_MS) return false;
    if (maxAgeMs !== null && now - msg.createdTimestamp > maxAgeMs) return false;

    const byBot = !!botId && msg.author?.id === botId;
    const byWebhook = !!msg.webhookId;
    const noisyPrefix = /^(AUTOPILOT_AUDIT|Thinking…|🔧|📥|✅|⚠️)/u.test(msg.content || '');

    return byBot || byWebhook || noisyPrefix;
  });

  const selected = deletable
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
    .slice(0, targetCount)
    .map((m) => m.id);

  if (selected.length === 0) return 0;
  const deleted = await groupchat.bulkDelete(selected, true);
  return deleted.size;
}

function ensureGoalWatchdog(groupchat: TextChannel): void {
  if (goalWatchdog) return;

  goalWatchdog = setInterval(() => {
    if (!activeGoal) return;

    maybeReviewThreadForClosure(groupchat).catch((err) => {
      console.error('Thread close review error:', err instanceof Error ? err.message : 'Unknown');
    });

    if (activeAbortController) return;
    if (Date.now() - lastGoalProgressAt < GOAL_STALL_TIMEOUT_MS) return;
    if (goalRecoveryAttempts >= GOAL_STALL_MAX_RECOVERY_ATTEMPTS) return;

    goalRecoveryAttempts += 1;
    goalStatus = `⚠️ Auto-recovery nudge ${goalRecoveryAttempts}/${GOAL_STALL_MAX_RECOVERY_ATTEMPTS}`;
    lastGoalProgressAt = Date.now();

    sendAutopilotAudit(
      groupchat,
      'watchdog_recovery',
      'Goal was stalled; sending system nudge to Riley for continuation and pending actions.',
      { attempt: goalRecoveryAttempts }
    ).catch(() => {});

    handleRileyMessage(
      `[System auto-recovery] This goal appears stalled: "${activeGoal}". Summarize current state in one short paragraph, execute any pending deploy/screenshots/urls actions now using explicit [ACTION:...] tags, and continue without waiting for user follow-up. If the work is actually complete, post a short wrap-up in the workspace thread and include [ACTION:CLOSE_THREAD].`,
      'System',
      undefined,
      groupchat
    ).catch((err) => {
      console.error('Goal watchdog recovery error:', err instanceof Error ? err.message : 'Unknown');
    });
  }, GOAL_STALL_CHECK_INTERVAL_MS);
}

let decisionsChannel: TextChannel | null = null;

/** Wire up the #decisions channel from bot startup. */
export function setDecisionsChannel(channel: TextChannel): void {
  decisionsChannel = channel;
}

async function clearThreadStatusMessages(channel: TextChannel): Promise<number> {
  let removed = 0;
  let before: string | undefined;
  const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

  for (let batch = 0; batch < 5; batch++) {
    const messages = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!messages || messages.size === 0) break;

    const recentIds = [...messages.values()]
      .filter((msg) => msg.deletable && (Date.now() - msg.createdTimestamp) < TWO_WEEKS_MS)
      .map((msg) => msg.id);

    if (recentIds.length > 0) {
      const deleted = await channel.bulkDelete(recentIds, true).catch(() => null);
      removed += deleted?.size ?? recentIds.length;
    }

    const oldMessages = [...messages.values()]
      .filter((msg) => msg.deletable && (Date.now() - msg.createdTimestamp) >= TWO_WEEKS_MS);

    for (const msg of oldMessages) {
      await msg.delete().catch(() => {});
      removed += 1;
    }

    before = messages.last()?.id;
    if (messages.size < 100) break;
  }

  return removed;
}

export async function postThreadStatusSnapshotNow(reason = 'hourly'): Promise<void> {
  if (!threadStatusChannel || !threadStatusSourceChannel) return;

  const riley = getAgent('executive-assistant' as AgentId);
  const timestamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
  const label = reason === 'hourly' ? 'hourly' : 'manual';
  const currentGoal = activeGoal
    ? `goal=${activeGoal.replace(/\s+/g, ' ').slice(0, 72)} status=${(goalStatus || 'in-progress').replace(/\s+/g, ' ').slice(0, 48)}`
    : 'goal=none status=idle';
  const report = await buildThreadStatusReport(threadStatusSourceChannel);
  const content = formatOpsLine({
    actor: 'executive-assistant',
    scope: 'thread-status',
    metric: `type=${label}`,
    delta: `at=${timestamp} ${currentGoal} ${report}`,
    action: 'none',
    severity: 'info',
  });

  await clearThreadStatusMessages(threadStatusChannel).catch(() => {});

  if (riley) {
    await sendWebhookMessage(threadStatusChannel, {
      content,
      username: `${riley.emoji} ${riley.name}`,
      avatarURL: riley.avatarUrl,
    }).catch(async () => {
      await threadStatusChannel?.send(content).catch(() => {});
    });
  } else {
    await threadStatusChannel.send(content).catch(() => {});
  }

  lastThreadStatusPostAt = Date.now();
}

export async function getThreadStatusOpsLine(): Promise<string> {
  if (!threadStatusSourceChannel) {
    return formatOpsLine({
      actor: 'executive-assistant',
      scope: 'thread-status',
      metric: 'snapshot',
      delta: 'source-channel=unavailable',
      action: 'check groupchat channel wiring',
      severity: 'warn',
    });
  }

  const report = await buildThreadStatusReport(threadStatusSourceChannel);
  const currentGoal = activeGoal
    ? `goal=${activeGoal.replace(/\s+/g, ' ').slice(0, 60)} status=${(goalStatus || 'in-progress').replace(/\s+/g, ' ').slice(0, 40)}`
    : 'goal=none status=idle';

  return formatOpsLine({
    actor: 'executive-assistant',
    scope: 'thread-status',
    metric: 'snapshot',
    delta: `${currentGoal} ${report}`,
    action: 'none',
    severity: 'info',
  });
}

export function setThreadStatusChannel(channel: TextChannel | null, groupchat?: TextChannel | null): void {
  threadStatusChannel = channel;
  if (groupchat) {
    threadStatusSourceChannel = groupchat;
  }

  if (threadStatusReporter) {
    clearInterval(threadStatusReporter);
    threadStatusReporter = null;
  }

  if (!threadStatusChannel || !threadStatusSourceChannel) {
    return;
  }

  lastThreadStatusPostAt = Date.now();
  threadStatusReporter = setInterval(() => {
    postThreadStatusSnapshotNow('hourly').catch((err) => {
      console.error('Thread status reporter error:', err instanceof Error ? err.message : 'Unknown');
    });
  }, THREAD_STATUS_POST_INTERVAL_MS);
}

/** Generic parser for real Discord role mentions plus plain-text fallback handles. */
const ROLE_MENTION_RE = /<@&(\d+)>/g;
const AGENT_MENTION_RE = /@([a-z0-9-]+)\b/gi;

/** Keep typing indicator alive during long agent operations. Returns a stop function. */
function startTypingLoop(channel: WebhookCapableChannel): () => void {
  channel.sendTyping().catch(() => {});
  const interval = setInterval(() => { channel.sendTyping().catch(() => {}); }, 8000);
  return () => clearInterval(interval);
}

async function setThinkingMessage(channel: WebhookCapableChannel, agent: AgentConfig, content = 'Thinking…'): Promise<void> {
  if (activeThinkingMessage) {
    await activeThinkingMessage.delete().catch(() => {});
    activeThinkingMessage = null;
  }
  try {
    activeThinkingMessage = await sendWebhookMessage(channel, {
      content,
      username: `${agent.emoji} ${agent.name}`,
      avatarURL: agent.avatarUrl,
    });
  } catch {
    activeThinkingMessage = null;
  }
}

async function clearThinkingMessage(): Promise<void> {
  if (!activeThinkingMessage) return;
  await activeThinkingMessage.delete().catch(() => {});
  activeThinkingMessage = null;
}

function sanitizeThreadName(input: string): string {
  return input
    .replace(/<@&\d+>/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72);
}

function extractGoalSequence(threadName: string): number {
  const match = String(threadName || '').match(GOAL_THREAD_COUNTER_RE);
  if (!match) return 0;
  const parsed = parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function syncGoalSequence(groupchat: TextChannel): Promise<void> {
  if (goalSequenceInitialized) return;

  let maxSeen = activeGoalSequence;
  const ingest = (threads: Iterable<{ name?: string }>) => {
    for (const thread of threads || []) {
      const seq = extractGoalSequence(thread?.name || '');
      if (seq > maxSeen) {
        maxSeen = seq;
      }
    }
  };

  try {
    ingest(groupchat.threads.cache.values());
    const active = await groupchat.threads.fetchActive().catch(() => null);
    if (active) ingest(active.threads.values());
    const archived = await groupchat.threads.fetchArchived({ limit: 100 }).catch(() => null);
    if (archived) ingest(archived.threads.values());
  } catch (err) {
    console.warn('Could not sync goal thread counter:', err instanceof Error ? err.message : 'Unknown');
  }

  activeGoalSequence = maxSeen;
  goalSequenceInitialized = true;
}

function buildGoalThreadName(senderName: string, content: string): string {
  activeGoalSequence = (activeGoalSequence + 1) % 10000;
  const goalId = activeGoalSequence.toString().padStart(4, '0');
  const sender = sanitizeThreadName(senderName).replace(/\s+/g, '-').toLowerCase() || 'user';
  const preview = sanitizeThreadName(content).split(' ').slice(0, 8).join(' ');
  return sanitizeThreadName(`Goal-${goalId} ${sender} ${preview}`) || `Goal-${goalId}`;
}

async function closeGoalWorkspace(
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  reason: string
): Promise<void> {
  let thread: any = null;
  if ('setArchived' in workspaceChannel) {
    thread = workspaceChannel;
  } else if (activeGoalThreadId) {
    thread = groupchat.threads.cache.get(activeGoalThreadId) || await groupchat.threads.fetch(activeGoalThreadId).catch(() => null);
  }

  if (thread && !thread.archived) {
    await sendWebhookMessage(thread, {
      content: `✅ Task complete. Closing this workspace thread (${reason}).`,
      username: '📋 Riley (Executive Assistant)',
    }).catch(() => {});
    await thread.setArchived(true, reason).catch(() => {});
  }

  activeGoalThreadId = null;
  activeGoal = null;
  goalStatus = '✅ Completed';
  activeGoalStartedAt = Date.now();
  lastThreadCloseReviewAt = 0;

  if (AUTO_DEPLOY_ON_THREAD_CLOSE) {
    try {
      const { buildId, logUrl } = await triggerCloudBuild('latest');
      await groupchat.send(
        `🚀 Auto rebuild triggered after thread completion (${reason}). Build: \`${buildId}\` — ${logUrl}`
      ).catch(() => {});
      await sendAutopilotAudit(groupchat, 'auto_rebuild_on_close', 'Triggered build after workspace thread completion.', {
        action: 'DEPLOY',
        buildId,
      }).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      await groupchat.send(`⚠️ Auto rebuild after thread close failed: ${msg}`).catch(() => {});
      void postAgentErrorLog('riley:auto-deploy', 'Auto rebuild on thread close failed', { detail: msg, level: 'warn' });
    }
  }
}

async function maybeReviewThreadForClosure(groupchat: TextChannel): Promise<void> {
  if (!ENABLE_AUTOMATIC_THREAD_CLOSE_REVIEW) return;
  if (!activeGoal || !activeGoalThreadId || activeAbortController) return;

  const now = Date.now();
  if (now - lastGoalProgressAt < THREAD_CLOSE_REVIEW_IDLE_MS) return;
  if (now - lastThreadCloseReviewAt < THREAD_CLOSE_REVIEW_INTERVAL_MS) return;

  const thread = groupchat.threads.cache.get(activeGoalThreadId)
    || await groupchat.threads.fetch(activeGoalThreadId).catch(() => null);

  if (!thread || thread.archived) {
    activeGoalThreadId = null;
    return;
  }

  lastThreadCloseReviewAt = now;
  lastGoalProgressAt = now;
  goalStatus = '🔎 Riley reviewing whether this thread can close...';

  await sendAutopilotAudit(
    groupchat,
    'thread_close_review',
    'Idle workspace thread triggered a closure-readiness review.',
    { action: 'CHECK_CLOSE_THREAD' }
  ).catch(() => {});

  await handleRileyMessage(
    `[System thread-close review] Review the current workspace thread for "${activeGoal}". If the work is fully complete and no more follow-up is required, post one concise final update in the workspace thread and include [ACTION:CLOSE_THREAD]. If anything is still pending or blocked, say exactly what remains and keep the thread open.`,
    'System',
    undefined,
    groupchat,
    undefined,
    thread
  );
}

function formatRelativeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'just now';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function trimCommandOutput(text: string, maxLen = 1500): string {
  const normalized = String(text || '').trim();
  if (!normalized) return '(no output)';
  return normalized.length > maxLen
    ? `${normalized.slice(0, maxLen)}\n… (truncated)`
    : normalized;
}

function runRepoInspection(command: string, cwd = APP_REPO_ROOT): string {
  try {
    return execFileSync('bash', ['-lc', command], {
      cwd,
      timeout: ACTION_COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      env: { ...process.env, CI: 'true' },
    });
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    return execErr.stderr || execErr.stdout || execErr.message || 'Unknown command error';
  }
}

async function buildThreadStatusReport(groupchat: TextChannel): Promise<string> {
  const active = await groupchat.threads.fetchActive().catch(() => null);
  const threads = [...(active?.threads.values() || [])]
    .filter((thread) => GOAL_THREAD_COUNTER_RE.test(thread.name))
    .sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0))
    .slice(0, 8);

  if (threads.length === 0) {
    return '📈 open=0 | ✅ ready=0 | ⏳ active=0 | 🧵 top=none';
  }

  const now = Date.now();
  const rows = await Promise.all(threads.map(async (thread) => {
    const recent = await thread.messages.fetch({ limit: 1 }).catch(() => null);
    const last = recent?.first();
    const lastTs = last?.createdTimestamp || thread.createdTimestamp || now;
    const idleMs = Math.max(0, now - lastTs);
    const ready = idleMs >= THREAD_CLOSE_REVIEW_IDLE_MS;
    const shortName = thread.name
      .replace(/\s+/g, '_')
      .slice(0, 22);
    return {
      ready,
      summary: `${ready ? '✅' : '⏳'}${shortName}:${formatRelativeTime(idleMs)}`,
    };
  }));

  const readyCount = rows.filter((row) => row.ready).length;
  const activeCount = Math.max(0, rows.length - readyCount);
  const top = rows.slice(0, 5).map((row) => row.summary).join(' | ');

  return `📈 open=${threads.length} | ✅ ready=${readyCount} | ⏳ active=${activeCount} | 🧵 top=${top || 'none'}`;
}

async function fetchStatusSummary(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': 'ASAPBot/1.0' },
      signal: controller.signal,
    });
    const body = await res.text();
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 120);
    return `${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ''}`;
  } catch (err) {
    return `unreachable — ${err instanceof Error ? err.message : 'Unknown'}`;
  } finally {
    clearTimeout(timer);
  }
}

async function buildDeploymentHealthReport(): Promise<string> {
  const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
  const healthUrl = `${appUrl.replace(/\/$/, '')}/api/health`;

  const [appStatus, apiStatus, currentRevision, revisions] = await Promise.all([
    fetchStatusSummary(appUrl),
    fetchStatusSummary(healthUrl),
    getCurrentRevision().catch(() => 'unknown'),
    listRevisions(3).catch(() => []),
  ]);

  const revisionSummary = revisions.length > 0
    ? revisions
      .slice(0, 3)
      .map((rev) => `• \`${rev.name}\` — ${new Date(rev.createTime).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}`)
      .join('\n')
    : '• No recent revision data available';

  return `🩺 **ASAP Health Check**\n\n🌐 App: ${appStatus}\n🧪 API health: ${apiStatus}\n📦 Active revision: \`${currentRevision}\`\n\nRecent revisions:\n${revisionSummary}`;
}

function buildRegressionReport(param?: string): string {
  const raw = String(param || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_./\-\s]/g, ' ').trim().slice(0, 120);
  const sections: string[] = [];

  if (cleaned) {
    if (/[/.]/.test(cleaned)) {
      sections.push(`**File history for \`${cleaned}\`**\n\n\
\
${trimCommandOutput(runRepoInspection(`git log --oneline --decorate -n 10 -- ${JSON.stringify(cleaned)}`))}`);
    }

    sections.push(`**Matching commits**\n\n\
\
${trimCommandOutput(runRepoInspection(`git log --oneline --decorate --regexp-ignore-case --grep ${JSON.stringify(cleaned)} -n 10`))}`);
  }

  if (sections.length === 0) {
    sections.push(`**Recent commits**\n\n\
\
${trimCommandOutput(runRepoInspection('git log --oneline --decorate -n 12'))}`);
  }

  return `🕵️ **Regression Detective**\n\n${sections.join('\n\n')}`;
}

async function runSmokeSummary(param?: string): Promise<string> {
  const requested = String(param || '').trim().toLowerCase();
  const safeAgent = requested.replace(/[^a-z0-9-]/g, '');
  const defaultAgent = safeAgent || 'executive-assistant';

  if (!process.env.DISCORD_TEST_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) {
    return `${await buildDeploymentHealthReport()}\n\nℹ️ Full Discord smoke runner is not configured on this environment, so I ran the deployment health check instead.`;
  }

  const output = runRepoInspection(
    `npm run discord:test:dist -- --agent=${JSON.stringify(defaultAgent)}`,
    APP_SERVER_ROOT,
  );

  return `🧪 **Agent Smoke Test** (${defaultAgent})\n\n\
\
${trimCommandOutput(output, 1800)}`;
}

async function ensureGoalWorkspace(groupchat: TextChannel, senderName: string, content: string): Promise<WebhookCapableChannel> {
  if (activeGoalThreadId) {
    const existing = groupchat.threads.cache.get(activeGoalThreadId)
      || await groupchat.threads.fetch(activeGoalThreadId).catch(() => null);
    if (existing && !existing.archived) return existing;
    activeGoalThreadId = null;
  }

  await syncGoalSequence(groupchat);
  const threadName = buildGoalThreadName(senderName, content);
  const thread = await groupchat.threads.create({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: `Goal workspace for ${senderName}`,
  });

  activeGoalThreadId = thread.id;
  activeGoalStartedAt = Date.now();
  lastThreadCloseReviewAt = 0;

  const riley = getAgent('executive-assistant' as AgentId);
  if (riley) {
    await sendWebhookMessage(thread, {
      content: `🧵 Workspace created for: ${content.slice(0, 300)}`,
      username: `${riley.emoji} ${riley.name}`,
      avatarURL: riley.avatarUrl,
    }).catch(() => {});
  }

  return thread;
}

async function runLimited<T>(items: Array<() => Promise<T>>, concurrency: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = { status: 'fulfilled', value: await items[current]() };
      } catch (err) {
        results[current] = { status: 'rejected', reason: err };
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

function resolveMentionedAgentId(raw: string): AgentId | null {
  return resolveAgentId(raw);
}

function parseMentionedAgentIds(text: string, allowedIds?: Set<string>): AgentId[] {
  const found = new Set<AgentId>();

  ROLE_MENTION_RE.lastIndex = 0;
  for (const match of text.matchAll(ROLE_MENTION_RE)) {
    const resolved = resolveAgentIdByRoleId(match[1]);
    if (!resolved) continue;
    if (allowedIds && !allowedIds.has(resolved)) continue;
    found.add(resolved);
  }

  AGENT_MENTION_RE.lastIndex = 0;
  for (const match of text.matchAll(AGENT_MENTION_RE)) {
    const resolved = resolveMentionedAgentId(match[1]);
    if (!resolved) continue;
    if (allowedIds && !allowedIds.has(resolved)) continue;
    found.add(resolved);
  }
  return [...found];
}

const GROUPCHAT_SUMMARY_ONLY = true;

function formatAgentSummaryLine(line: string): string {
  const normalized = line.replace(/\s+/g, ' ').trim();
  const bracketed = normalized.match(/^\[([^\]]+)\]:\s*(.*)$/);
  if (bracketed) {
    const resolved = resolveAgentId(bracketed[1]);
    const label = resolved ? getAgentMention(resolved) : bracketed[1];
    return `${label}: ${bracketed[2]}`.trim();
  }

  const plain = normalized.match(/^([A-Za-z][A-Za-z\s-]{1,40}):\s*(.*)$/);
  if (plain) {
    const resolved = resolveAgentId(plain[1]);
    const label = resolved ? getAgentMention(resolved) : plain[1];
    return `${label}: ${plain[2]}`.trim();
  }

  return normalized;
}

function buildConsolidatedAgentUpdate(findings: string[], errors: string[]): string {
  const normalizedFindings = findings
    .map(formatAgentSummaryLine)
    .filter((line) => line.length > 0)
    .slice(0, 12);

  const lines: string[] = ['Sub-agent update:'];
  for (const finding of normalizedFindings) {
    lines.push(`- ${finding}`);
  }
  if (errors.length > 0) {
    lines.push('Errors:');
    for (const err of errors.slice(0, 8)) {
      lines.push(`- ${err}`);
    }
  }

  const rendered = lines.join('\n').trim();
  if (rendered.length <= 1800) return rendered;
  return `${rendered.slice(0, 1750).trim()}\n\n(Additional details are in each agent channel.)`;
}

function parseBudgetApproval(text: string): number | undefined | null {
  const normalized = text.toLowerCase().trim();

  const simpleYes = /^(yes|yep|yeah|yup|ok|okay|sure|go|go ahead|continue|resume|proceed|approved?|keep going|carry on|do it|let'?s? go)$/i.test(normalized);
  if (simpleYes) return undefined; // undefined → use default increment

  const hasApprovalWord = /(approve|approved|increase|raise|bump|add|authorise|authorize)/i.test(normalized);
  const hasBudgetWord = /(budget|spend|limit|credits?|more|extra|funds?)/i.test(normalized);
  const standaloneApprove = /^approve[sd]?[!.]*$/i.test(normalized);

  if (!standaloneApprove && !(hasApprovalWord && hasBudgetWord)) return null;

  const dollarMatch = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  if (dollarMatch) return parseFloat(dollarMatch[1]);

  const numberMatch = text.match(/\b(\d+(?:\.\d{1,2})?)\b/);
  if (numberMatch) return parseFloat(numberMatch[1]);

  return undefined;
}

function stripMentionsForIntent(text: string): string {
  return String(text || '')
    .replace(/<@[!&]?\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectDirectVoiceAction(text: string): 'join' | 'leave' | null {
  const normalized = stripMentionsForIntent(text).toLowerCase();
  if (!normalized) return null;

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 20 || normalized.length > 180) return null;

  const lead = String.raw`(?:hey|hi|yo)?\s*(?:riley|asap)?\s*[,!:;-]?\s*(?:please\s+)?(?:can you\s+|could you\s+|will you\s+)?`;
  const joinPattern = new RegExp(
    String.raw`^${lead}(?:join|start|open|connect|enter|hop\s+in(?:to)?|jump\s+in(?:to)?)\b[\w\s-]{0,40}\b(?:voice|vc|call|voice\s+chat|voice\s+channel)\b`,
    'i',
  );
  const leavePattern = new RegExp(
    String.raw`^${lead}(?:leave|end|stop|disconnect|hang\s*up|drop)\b[\w\s-]{0,40}\b(?:voice|vc|call|voice\s+chat|voice\s+channel)?\b`,
    'i',
  );

  if (joinPattern.test(normalized)) return 'join';
  if (leavePattern.test(normalized) || /^(?:leave|end call|hang up|disconnect)$/i.test(normalized)) return 'leave';
  return null;
}

function isLikelyVoiceCommandIntent(text: string): boolean {
  const normalized = stripMentionsForIntent(text).toLowerCase();
  if (!normalized) return false;
  if (normalized.length > 220) return false;

  const hasVoiceTarget = /\b(?:voice|vc|voice\s+chat|voice\s+channel|call)\b/.test(normalized);
  const hasVoiceVerb = /\b(?:join|start|open|connect|enter|hop\s+in|jump\s+in|leave|end|stop|disconnect|hang\s*up|drop)\b/.test(normalized);
  const hasAssistantCue = /\b(?:riley|asap)\b/.test(normalized);

  if (hasVoiceTarget && hasVoiceVerb && hasAssistantCue) return true;

  // Treat short imperative voice commands as direct voice intent, even
  // without assistant name, to avoid accidentally spawning workspace threads.
  const directImperative = /^(?:please\s+)?(?:join|start|open|connect|enter|hop\s+in(?:to)?|jump\s+in(?:to)?|leave|end|stop|disconnect|hang\s*up|drop)\b/.test(normalized);
  return hasVoiceTarget && hasVoiceVerb && directImperative;
}

async function handleDirectVoiceActionIfRequested(message: Message, content: string, groupchat: TextChannel): Promise<boolean> {
  const stripped = stripMentionsForIntent(content);
  const testerPromptMatch = stripped.match(/^(?:hey|hi|yo)?\s*(?:riley|asap)?\s*[,!:;-]?\s*(?:please\s+)?(?:inject|simulate|test)\s+(?:voice|transcript)\s*(?::|-)\s*(.{1,260})$/i);
  if (testerPromptMatch) {
    const injectionEnabled = String(process.env.VOICE_TEST_INJECTION_ENABLED || 'false').toLowerCase() === 'true';
    const isAuthorized = isTesterBotId(message.author.id) || injectionEnabled;
    if (!isAuthorized) {
      await groupchat.send('🛑 Voice transcript injection is restricted to ASAPTester unless VOICE_TEST_INJECTION_ENABLED=true.').catch(() => {});
      return true;
    }
    if (!isCallActive()) {
      await groupchat.send('📞 No active voice call. Start one first, then inject transcript text.').catch(() => {});
      return true;
    }

    const injectedText = testerPromptMatch[1].trim();
    const result = await injectVoiceTranscriptForTesting({
      userId: message.author.id,
      username: message.member?.displayName || message.author.username || 'ASAPTester',
      text: injectedText,
    });

    if (!result.ok) {
      await groupchat.send(`⚠️ Voice test injection failed: ${result.reason || 'unknown error'}`).catch(() => {});
      return true;
    }

    await groupchat.send(`🧪 Injected test transcript: "${injectedText.slice(0, 120)}"`).catch(() => {});
    return true;
  }

  const action = detectDirectVoiceAction(content);
  if (!action) return false;

  const channels = getBotChannels();
  if (!channels) {
    await groupchat.send('⚠️ Voice channels are not configured yet.').catch(() => {});
    return true;
  }

  if (action === 'join') {
    if (isCallActive()) {
      await groupchat.send('📞 Riley is already in voice.').catch(() => {});
      return true;
    }
    if (!message.member) {
      await groupchat.send('📞 I need you to be in the server to join voice.').catch(() => {});
      return true;
    }
    await startCall(channels.voiceChannel, groupchat, channels.callLog, message.member);
    return true;
  }

  if (!isCallActive()) {
    await groupchat.send('📞 No active voice call to leave.').catch(() => {});
    return true;
  }
  await endCall();
  return true;
}

function detectDirectOpsAction(text: string): 'status' | 'limits' | 'threads' | null {
  const normalized = stripMentionsForIntent(text).toLowerCase();
  if (!normalized) return null;

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 18 || normalized.length > 160) return null;

  const lead = String.raw`^(?:hey|hi|yo)?\s*(?:riley|asap)?\s*[,!:;-]?\s*(?:please\s+)?(?:can you\s+|could you\s+|will you\s+)?`;
  const statusPattern = new RegExp(`${lead}(?:status|what(?:'| i)?s\s+the\s+status|update\s+status|current\s+goal)\??$`, 'i');
  const limitsPattern = new RegExp(`${lead}(?:limits|usage|budget|spend|costs|token\s+usage|show\s+limits|show\s+usage)\??$`, 'i');
  const threadsPattern = new RegExp(`${lead}(?:threads|thread\s+status|open\s+threads|workspace\s+threads)\??$`, 'i');

  if (statusPattern.test(normalized)) return 'status';
  if (limitsPattern.test(normalized)) return 'limits';
  if (threadsPattern.test(normalized)) return 'threads';
  return null;
}

async function sendQuickRileyMessage(groupchat: TextChannel, content: string): Promise<void> {
  const riley = getAgent('executive-assistant' as AgentId);
  if (riley) {
    await sendAgentMessage(groupchat, riley, content);
    return;
  }
  await groupchat.send(content).catch(() => {});
}

async function handleDirectOpsActionIfRequested(content: string, groupchat: TextChannel): Promise<boolean> {
  const action = detectDirectOpsAction(content);
  if (!action) return false;

  if (action === 'status') {
    await sendQuickRileyMessage(groupchat, getStatusSummary() || '📋 No active tasks.');
    return true;
  }

  if (action === 'limits') {
    await refreshLiveBillingData().catch(() => {});
    await sendQuickRileyMessage(groupchat, getUsageReport());
    return true;
  }

  const report = await buildThreadStatusReport(groupchat);
  await postThreadStatusSnapshotNow('manual').catch(() => {});
  await sendQuickRileyMessage(groupchat, report);
  return true;
}

function getAgentWorkChannel(agentId: string, fallback: TextChannel): TextChannel {
  const channels = getBotChannels();
  return channels?.agentChannels.get(agentId) || fallback;
}

interface AgentDispatchOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  memoryWindow?: number;
  documentLine?: string;
  persistUserContent?: string;
  workspaceChannel?: WebhookCapableChannel;
  suppressVisibleOutput?: (response: string) => boolean;
}

async function dispatchToAgent(
  agentId: AgentId,
  contextMessage: string,
  outputChannel: WebhookCapableChannel,
  options: AgentDispatchOptions = {}
): Promise<string> {
  const agent = getAgent(agentId);
  if (!agent) return '';

  const agentMemory = typeof options.memoryWindow === 'number'
    ? getMemoryContext(agentId, options.memoryWindow)
    : getMemoryContext(agentId);

  const response = await agentRespond(
    agent,
    [...agentMemory, ...groupHistory],
    contextMessage,
    async (_toolName, summary) => {
      sendToolNotification(outputChannel, agent, summary).catch(() => {});
    },
    { maxTokens: options.maxTokens, signal: options.signal }
  );

  if (options.signal?.aborted) return '';

  const suppressVisibleOutput = options.suppressVisibleOutput?.(response) === true;

  if (!suppressVisibleOutput) {
    await sendAgentMessage(outputChannel, agent, response);
    if (options.workspaceChannel && options.workspaceChannel.id !== outputChannel.id) {
      await sendAgentMessage(options.workspaceChannel, agent, response);
    }
  }
  appendToMemory(agentId, [
    { role: 'user', content: options.persistUserContent || contextMessage },
    { role: 'assistant', content: `[${agent.name}]: ${response}` },
  ]);
  if (options.documentLine) {
    documentToChannel(agentId, options.documentLine.replace('{response}', response.slice(0, 300))).catch(() => {});
  }
  groupHistory.push({ role: 'assistant', content: `[${agent.name.split(' ')[0]}]: ${response}` });

  return response;
}

/**
 * Handle a message in the groupchat channel.
 * Riley-led flow: everything goes through Riley unless user @mentions a specific agent.
 * Riley can trigger actions via [ACTION:xxx] tags in her responses.
 */
export async function handleGroupchatMessage(
  message: Message,
  groupchat: TextChannel
): Promise<void> {
  const content = message.content.trim();
  if (!content) return;

  // Fast-path direct commands before queue orchestration to avoid abort races
  // between back-to-back control messages (e.g. join then inject test voice).
  if (await handleDirectOpsActionIfRequested(content, groupchat)) {
    markGoalProgress('⚡ Quick ops action handled directly');
    return;
  }
  if (await handleDirectVoiceActionIfRequested(message, content, groupchat)) {
    markGoalProgress('📞 Voice action handled directly');
    return;
  }
  if (isLikelyVoiceCommandIntent(content)) {
    await sendQuickRileyMessage(groupchat, '📞 Voice command detected. Say "Riley join voice call" or "Riley leave voice call" and I will handle it directly without opening a workspace thread.');
    markGoalProgress('📞 Voice intent handled without workspace thread');
    return;
  }

  ensureClaudeNotifications(groupchat);
  ensureGoalWatchdog(groupchat);

  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  clearThinkingMessage().catch(() => {});

  const controller = new AbortController();
  activeAbortController = controller;

  messageQueue = messageQueue.then(async () => {
    if (controller.signal.aborted) return;
    try {
      await withMessageTimeout(
        processGroupchatMessage(message, content, groupchat, controller.signal),
        GROUPCHAT_PROCESS_TIMEOUT_MS,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.stack || err.message : String(err);
      console.error('Groupchat message processing failed:', detail);
      void postAgentErrorLog('groupchat:queue', 'Groupchat message processing failed', {
        detail,
        level: 'warn',
      });
    } finally {
      if (activeAbortController === controller) activeAbortController = null;
    }
  }).catch((err) => {
    console.error('Groupchat queue error:', err instanceof Error ? err.message : 'Unknown');
  });
}

async function withMessageTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Groupchat message timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function processGroupchatMessage(
  message: Message,
  content: string,
  groupchat: TextChannel,
  signal?: AbortSignal
): Promise<void> {
  const senderName = message.member?.displayName || message.author.username;
  if (await handleDirectOpsActionIfRequested(content, groupchat)) {
    markGoalProgress('⚡ Quick ops action handled directly');
    return;
  }

  if (await handleDirectVoiceActionIfRequested(message, content, groupchat)) {
    markGoalProgress('📞 Voice action handled directly');
    return;
  }

  if (isLikelyVoiceCommandIntent(content)) {
    await sendQuickRileyMessage(groupchat, '📞 Voice command detected. Say "Riley join voice call" or "Riley leave voice call" and I will handle it directly without opening a workspace thread.');
    markGoalProgress('📞 Voice intent handled without workspace thread');
    return;
  }

  const workspaceChannel = await ensureGoalWorkspace(groupchat, senderName, content);
  markGoalProgress();

  const approvedAmount = parseBudgetApproval(content);
  if (approvedAmount !== null) {
    const riley = getAgent('executive-assistant' as AgentId);
    const result = approveAdditionalBudget(Number.isFinite(approvedAmount) ? approvedAmount : undefined);
    await refreshUsageDashboard().catch(() => {});

    if (riley) {
      await sendAgentMessage(
        workspaceChannel,
        riley,
        `Budget approval recorded. I added $${result.added.toFixed(2)} of extra budget for today, so the new limit is $${result.limit.toFixed(2)}. We've spent $${result.spent.toFixed(2)} so far and have $${result.remaining.toFixed(2)} remaining.`
      );
    }

    if (activeGoal) {
      markGoalProgress('▶️ Resuming after budget approval');
      await withRileyResponseWatchdog(
        workspaceChannel,
        groupchat,
        handleRileyMessage(
        `Budget approval has been granted by ${senderName}. Resume the paused work on this goal: ${activeGoal}`,
        senderName,
        message.member || undefined,
        groupchat,
        signal,
        workspaceChannel
        ),
      );
    }
    return;
  }

  const uniqueMentions = parseMentionedAgentIds(content);

  if (uniqueMentions.length > 0) {
    if (uniqueMentions.length === 1 && uniqueMentions[0] === 'executive-assistant') {
      activeGoal = content;
      activeGoalStartedAt = Date.now();
      markGoalProgress('⏳ Riley planning...');
      await withRileyResponseWatchdog(
        workspaceChannel,
        groupchat,
        handleRileyMessage(content, senderName, message.member || undefined, groupchat, signal, workspaceChannel),
      );
    } else {
      await handleDirectedMessage(content, senderName, uniqueMentions, groupchat, workspaceChannel, signal);
    }
  } else {
    activeGoal = content;
    activeGoalStartedAt = Date.now();
    markGoalProgress('⏳ Riley planning...');
    await withRileyResponseWatchdog(
      workspaceChannel,
      groupchat,
      handleRileyMessage(content, senderName, message.member || undefined, groupchat, signal, workspaceChannel),
    );
  }
}

async function withRileyResponseWatchdog(
  workspaceChannel: WebhookCapableChannel,
  groupchat: TextChannel,
  work: Promise<void>,
): Promise<void> {
  // Outer watchdog: if Riley never emits visible output for a goal, post a
  // clear stalled-run alert so operators are not left with silent threads.
  if (!Number.isFinite(RILEY_NO_RESPONSE_TIMEOUT_MS) || RILEY_NO_RESPONSE_TIMEOUT_MS <= 0) {
    await work;
    return;
  }

  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    const seconds = Math.round(RILEY_NO_RESPONSE_TIMEOUT_MS / 1000);
    const msg = `⚠️ No Riley response after ${seconds}s for this goal. Investigating stall and retrying safeguards.`;
    void postAgentErrorLog('riley:watchdog', 'No Riley response observed for goal', {
      agentId: 'executive-assistant',
      detail: `goal=${activeGoal || 'none'} timeoutMs=${RILEY_NO_RESPONSE_TIMEOUT_MS}`,
      level: 'warn',
    });
    if ('send' in workspaceChannel) {
      void workspaceChannel.send(msg).catch(() => {});
    }
    if (workspaceChannel.id !== groupchat.id) {
      void groupchat.send(msg).catch(() => {});
    }
  }, RILEY_NO_RESPONSE_TIMEOUT_MS);

  try {
    await work;
  } finally {
    clearTimeout(timer);
    if (fired) {
      markGoalProgress('⚠️ Riley response timeout observed');
    }
  }
}

/**
 * Handle a goal or request — Riley receives it and orchestrates.
 * Also used internally when feeding decisions back.
 */
export async function handleGoalCommand(
  description: string,
  member: GuildMember,
  groupchat: TextChannel
): Promise<void> {
  const senderName = member.displayName || member.user.username;
  activeGoal = description;
  activeGoalStartedAt = Date.now();
  markGoalProgress('⏳ Planning...');

  const workspaceChannel = await ensureGoalWorkspace(groupchat, senderName, description);
  await handleRileyMessage(description, senderName, member, groupchat, undefined, workspaceChannel);
}

/**
 * Get current status summary.
 */
export function getStatusSummary(): string | null {
  if (!activeGoal) return null;
  return `📋 **Current Goal:** ${activeGoal}\n**Status:** ${goalStatus || 'In progress...'}`;
}

/**
 * Riley receives the message, responds, and orchestrates Ace + sub-agents.
 * She can trigger system actions by including [ACTION:xxx] tags in her response.
 */
async function handleRileyMessage(
  userMessage: string,
  senderName: string,
  member: GuildMember | undefined,
  groupchat: TextChannel,
  signal?: AbortSignal,
  workspaceChannel: WebhookCapableChannel = groupchat,
): Promise<void> {
  if (workspaceChannel === groupchat) {
    workspaceChannel = await ensureGoalWorkspace(groupchat, senderName || 'system', userMessage || 'request');
  }

  const riley = getAgent('executive-assistant' as AgentId);
  if (!riley) return;
  const rileyWorkChannel = getAgentWorkChannel('executive-assistant', groupchat);

  let stopTyping: () => void = () => {};
  let hasVisibleRileyResponse = false;
  let noResponseTimer: NodeJS.Timeout | null = null;
  try {
    noResponseTimer = setTimeout(() => {
      if (hasVisibleRileyResponse || signal?.aborted) return;
      const seconds = Math.round(RILEY_NO_RESPONSE_TIMEOUT_MS / 1000);
      const timeoutText = `⚠️ Riley has not responded in ${seconds}s for this goal. The run may be stalled; timeout safeguards are active.`;
      void sendAgentMessage(workspaceChannel, riley, timeoutText).catch(() => {});
      if (workspaceChannel.id !== groupchat.id) {
        void groupchat.send(timeoutText).catch(() => {});
      }
      void postAgentErrorLog('riley:timeout', 'No Riley response within timeout', {
        agentId: 'executive-assistant',
        detail: `goal=${activeGoal || 'none'} timeoutMs=${RILEY_NO_RESPONSE_TIMEOUT_MS}`,
        level: 'warn',
      });
    }, RILEY_NO_RESPONSE_TIMEOUT_MS);

    stopTyping = startTypingLoop(rileyWorkChannel);
    await setThinkingMessage(rileyWorkChannel, riley);

    const rileyMemory = getMemoryContext('executive-assistant');
    const contextMessage = `[${senderName}]: ${userMessage}`;
    const aceGuide = buildAgentMentionGuide(['developer']);
    const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf]/;
    const textLangHint = cjkPattern.test(userMessage)
      ? '\n\n[Language detected: Mandarin Chinese. Please reply in Mandarin Chinese (简体中文).]'
      : '';
    const mentionGuide = `\n\n[Delegation default: start with ${aceGuide}. Ace can bring in other specialists only if needed.]`;
    const threadCloseGuide = `\n\n[Keep the workspace thread updated briefly. Include [ACTION:CLOSE_THREAD] only when the task is fully complete.]`;
    const contextMessageWithLang = `${textLangHint ? `${contextMessage}${textLangHint}` : contextMessage}${mentionGuide}${threadCloseGuide}`;

    const response = await agentRespond(riley, [...rileyMemory, ...groupHistory], contextMessageWithLang, async (_toolName, summary) => {
      sendToolNotification(rileyWorkChannel, riley, summary).catch(() => {});
    }, { signal });

    if (signal?.aborted) return;
    await clearThinkingMessage();

    let displayResponse = appendDefaultNextSteps(
      response.replace(/\[\s*action:[^\]]+\]/gi, '').trim()
    );
    markGoalProgress('🧭 Riley coordinating...');

    appendToMemory('executive-assistant', [
      { role: 'user', content: contextMessage },
      { role: 'assistant', content: `[Riley]: ${response}` },
    ]);

    groupHistory.push({ role: 'user', content: contextMessage });
    groupHistory.push({ role: 'assistant', content: `[Riley]: ${response}` });
    persistGroupHistory();

    if (signal?.aborted) return;

    const implicitTags = inferImplicitActionTags(displayResponse);
    const actionPayload = implicitTags ? `${response}\n${implicitTags}` : response;
    if (implicitTags) {
      await sendAgentMessage(rileyWorkChannel, riley, 'Autopilot: executing the requested operational actions now.');
      await sendAutopilotAudit(
        groupchat,
        'implied_actions',
        'Riley response implied operational actions without explicit tags; autopilot synthesized tags.',
        { action: implicitTags.replace(/\s+/g, ',') }
      );
    }
    await executeActions(actionPayload, member, groupchat, workspaceChannel);
    markGoalProgress();

    const verificationRequired = goalNeedsRuntimeVerification(activeGoal || userMessage || response);
    const completionClaimed = isCompletionClaim(displayResponse);
    let completionVerified = true;
    if (verificationRequired && completionClaimed) {
      const evidenceSince = Math.max(Date.now() - 2 * 60 * 60 * 1000, activeGoalStartedAt - 60_000);
      completionVerified = await hasRecentRuntimeVerificationEvidence(groupchat, workspaceChannel, evidenceSince);
      if (!completionVerified) {
        displayResponse = '⏳ Verification pending: I cannot mark this as complete yet because there is no checkable runtime evidence in screenshots/harness output. I will keep this open until proof is posted.';
      }
    }

    if (shouldQueueDecisionReview(displayResponse)) {
      const target = decisionsChannel || groupchat;
      postDecisionEmbed(target, groupchat, displayResponse).catch(() => {});
    }

    if (signal?.aborted) return;

    if (!signal?.aborted && displayResponse) {
      hasVisibleRileyResponse = true;
      await sendAgentMessage(rileyWorkChannel, riley, displayResponse);
      if (workspaceChannel.id !== rileyWorkChannel.id) {
        await sendAgentMessage(workspaceChannel, riley, displayResponse);
      }
      if (completionClaimed && completionVerified && shouldMirrorCompletionToGroupchat(displayResponse, workspaceChannel, groupchat)) {
        await sendAgentMessage(groupchat, riley, `✅ Completion update: ${displayResponse}`);
      }
    }

    const chainResponse = ensureAceFirstDelegation(response, userMessage);
    await handleAgentChain(chainResponse, groupchat, workspaceChannel, signal);

    markGoalProgress('✅ Riley cycle completed');
  } catch (err) {
    const abortLike = String((err as any)?.name || '').includes('Abort') || String((err as any)?.message || '').toLowerCase().includes('abort');
    if (abortLike || signal?.aborted) return;
    const errMsg = err instanceof Error ? err.stack || err.message : String(err);
    console.error('Riley error:', errMsg);
    void postAgentErrorLog('riley:groupchat', 'Riley orchestration error', {
      agentId: 'executive-assistant',
      detail: errMsg,
    });
    const short = errMsg.length > 200 ? errMsg.slice(0, 200) + '…' : errMsg;
    try {
      hasVisibleRileyResponse = true;
      const wh = await getWebhook(workspaceChannel);
      await wh.send({
        content: `⚠️ Riley encountered an error:\n\`\`\`${short}\`\`\``,
        username: `${riley.emoji} ${riley.name}`,
        avatarURL: riley.avatarUrl,
      });
    } catch {
      const fallback = ('send' in workspaceChannel) ? workspaceChannel : rileyWorkChannel;
      await fallback.send(`⚠️ Riley encountered an error:\n\`\`\`${short}\`\`\``).catch(() => {});
    }
  } finally {
    if (noResponseTimer) clearTimeout(noResponseTimer);
    await clearThinkingMessage().catch(() => {});
    stopTyping();
  }
}

/**
 * Parse and execute [ACTION:xxx] tags from Riley's response.
 */
async function executeActions(
  response: string,
  member: GuildMember | undefined,
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel
): Promise<void> {
  const actionRe = /\[\s*action:(\w+)(?::([^\]]*))?\]/gi;
  const actions = [...response.matchAll(actionRe)];

  const riley = getAgent('executive-assistant' as AgentId);

  /** Send a message as Riley via webhook, fallback to bot if webhook fails */
  async function sendAsRiley(msg: string): Promise<void> {
    if (riley) {
      try {
        const wh = await getWebhook(workspaceChannel);
        await wh.send({ content: msg, username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
        return;
      } catch (err) {
        console.warn('Webhook send failed for Riley action response:', err instanceof Error ? err.message : 'Unknown');
      }
    }

    if ('send' in workspaceChannel) {
      await workspaceChannel.send(msg).catch(() => {});
      return;
    }
    const rileyChannel = getAgentWorkChannel('executive-assistant', groupchat);
    await rileyChannel.send(msg).catch(() => {});
  }

  for (const [, action, param] of actions) {
    try {
      switch (action.toUpperCase()) {
        case 'JOIN_VC': {
          const channels = getBotChannels();
          if (!channels) break;
          if (isCallActive()) {
            await sendAsRiley('📞 Already in a voice call.');
            break;
          }
          if (member) {
            await startCall(channels.voiceChannel, groupchat, channels.callLog, member);
          } else {
            await sendAsRiley('📞 I need you to be in the server to join VC.');
          }
          break;
        }
        case 'LEAVE_VC': {
          if (isCallActive()) {
            await endCall();
          } else {
            await sendAsRiley('No active voice call to leave.');
          }
          break;
        }
        case 'DEPLOY': {
          try {
            const { buildId, logUrl } = await triggerCloudBuild(param || 'latest');
            markGoalProgress('🚀 Deploy triggered');
            await sendAutopilotAudit(groupchat, 'action_executed', 'Cloud Build deployment was triggered.', {
              action: 'DEPLOY',
              buildId,
            });
            await sendAsRiley(
              `🚀 **Build triggered**\nBuild ID: \`${buildId}\`\n[View logs](${logUrl})`
            );
            const channels = getBotChannels();
            if (channels?.url) {
              const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
              await channels.url.send(
                `🚀 **Build triggered** — ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}\n` +
                `🔨 Build: \`${buildId}\` — [View logs](${logUrl})\n` +
                `🌐 App: ${appUrl}`
              );
            }
          } catch (err) {
            await sendAsRiley(`❌ Deploy failed: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          break;
        }
        case 'SCREENSHOTS': {
          const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
          captureAndPostScreenshots(appUrl, param || 'manual').catch((err) => {
            sendAsRiley(`❌ Screenshot capture failed: ${err instanceof Error ? err.message : 'Unknown'}`).catch(() => {});
          });
          markGoalProgress('📸 Screenshot capture started');
          await sendAutopilotAudit(groupchat, 'action_executed', 'Screenshot capture workflow started.', {
            action: 'SCREENSHOTS',
          });
          await sendAsRiley('📸 Capturing screenshots...');
          break;
        }
        case 'URLS': {
          const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
          const projectId = process.env.GCS_PROJECT_ID || 'asap-489910';
          const region = process.env.CLOUD_RUN_REGION || 'australia-southeast1';
          markGoalProgress('🔗 URLs posted');
          await sendAutopilotAudit(groupchat, 'action_executed', 'ASAP links were posted.', {
            action: 'URLS',
          });
          await sendAsRiley(
            `🔗 **ASAP Links**\n\n` +
            `🌐 **App**: ${appUrl}\n` +
            `📦 **Cloud Build**: https://console.cloud.google.com/cloud-build/builds?project=${projectId}\n` +
            `☁️ **Cloud Run**: https://console.cloud.google.com/run/detail/${region}/asap?project=${projectId}\n` +
            `📊 **Logs**: https://console.cloud.google.com/logs/query?project=${projectId}`
          );
          break;
        }
        case 'STATUS': {
          const summary = getStatusSummary();
          await sendAsRiley(summary || '📋 No active tasks.');
          break;
        }
        case 'THREADS': {
          markGoalProgress('🧵 Reviewing workspace threads');
          const report = await buildThreadStatusReport(groupchat);
          await postThreadStatusSnapshotNow('manual').catch(() => {});
          await sendAsRiley(report);
          break;
        }
        case 'HEALTH': {
          markGoalProgress('🩺 Running app health check');
          await sendAsRiley(await buildDeploymentHealthReport());
          break;
        }
        case 'REGRESSION': {
          await sendAsRiley(buildRegressionReport(param));
          break;
        }
        case 'SMOKE': {
          markGoalProgress('🧪 Running smoke check');
          await sendAsRiley(await runSmokeSummary(param));
          break;
        }
        case 'LIMITS': {
          await refreshLiveBillingData().catch(() => {});
          const report = getUsageReport();
          markGoalProgress('📊 Usage report posted');
          await sendAsRiley(report);
          break;
        }
        case 'UNFUSE': {
          clearGeminiQuotaFuse();
          const status = getGeminiQuotaFuseStatus();
          markGoalProgress('🧯 Cleared local Gemini quota fuse');
          await sendAsRiley(`🧯 Cleared local Gemini quota/rate fuse. blocked=${status.blocked ? 'yes' : 'no'}.`);
          break;
        }
        case 'CONTEXT': {
          const report = `${getContextEfficiencyReport()}\n\n${getContextRuntimeReport()}`;
          markGoalProgress('🧠 Context report posted');
          await sendAsRiley(report);
          break;
        }
        case 'CLEANUP': {
          const options = parseCleanupOptions(param);
          try {
            const removed = await cleanupGroupchatNoise(groupchat, options.targetCount, options.maxAgeMs);
            markGoalProgress('🧽 Groupchat cleanup complete');
            await sendAutopilotAudit(groupchat, 'action_executed', `Cleaned up ${removed} noisy groupchat messages from ${options.descriptor}. Requested by ${member?.displayName || 'system'}.`, {
              action: `CLEANUP:${options.targetCount}`,
            });
            const clipped = options.requestedCount > options.targetCount
              ? ` Requested ${options.requestedCount}, capped at ${options.targetCount} for safety.`
              : '';
            await sendAsRiley(`🧽 Cleaned up ${removed} noisy messages in groupchat from ${options.descriptor}.${clipped}`);
          } catch (err) {
            await sendAsRiley(`❌ Groupchat cleanup failed: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          break;
        }
        case 'CLEAR': {
          clearHistory(groupchat.id);
          groupHistory.splice(0);
          clearMemory('groupchat');
          markGoalProgress('🧹 Context cleared');
          await sendAsRiley('🧹 Conversation context cleared.');
          break;
        }
        case 'ROLLBACK': {
          if (param) {
            try {
              const result = await rollbackToRevision(param);
              markGoalProgress('↩️ Rollback complete');
              await sendAsRiley(result);
            } catch (err) {
              await sendAsRiley(`❌ Rollback failed: ${err instanceof Error ? err.message : 'Unknown'}`);
            }
          } else {
            try {
              const current = await getCurrentRevision();
              const revisions = await listRevisions(5);
              const list = revisions.map((r) => {
                const date = new Date(r.createTime).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
                const tag = r.image.split(':').pop()?.slice(0, 12) || '?';
                const active = r.name === current ? ' ← **active**' : '';
                return `\`${r.name}\` — ${date} (${tag})${active}`;
              }).join('\n');
              await sendAsRiley(`📦 **Cloud Run Revisions**\n\n${list}`);
            } catch (err) {
              await sendAsRiley(`❌ Failed to list revisions: ${err instanceof Error ? err.message : 'Unknown'}`);
            }
          }
          break;
        }
        case 'AGENTS': {
          const agents = getAgents();
          const list = Array.from(agents.values())
            .map((a) => `${a.emoji} **${a.name}**`)
            .join('\n');
          await sendAsRiley(`**ASAP Agent Team**\n\n${list}`);
          break;
        }
        case 'CLOSE_THREAD': {
          const goalNeedsEvidence = goalNeedsRuntimeVerification(activeGoal || '');
          if (goalNeedsEvidence) {
            const evidenceSince = Math.max(Date.now() - 2 * 60 * 60 * 1000, activeGoalStartedAt - 60_000);
            const hasEvidence = await hasRecentRuntimeVerificationEvidence(groupchat, workspaceChannel, evidenceSince);
            if (!hasEvidence) {
              await sendAsRiley('🛑 Cannot close this thread yet. Runtime verification evidence is missing. Please provide checkable proof via screenshots or mobile harness/puppeteer output before closing.');
              break;
            }
          }
          await sendAsRiley('🧵 Closing this workspace thread now that the task is complete.');
          await closeGoalWorkspace(groupchat, workspaceChannel, 'Closed by Riley action');
          break;
        }
        case 'CALL': {
          if (!isTelephonyAvailable()) {
            await sendAsRiley('📞 Phone system not configured (missing Twilio credentials).');
            break;
          }
          if (!param) {
            await sendAsRiley('📞 No phone number specified. Riley, include a number with [ACTION:CALL:number].');
            break;
          }
          const verifiedNumbers = (process.env.TWILIO_VERIFIED_NUMBERS || '0436012231')
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean);
          const phoneNumber = param.trim();
          if (!verifiedNumbers.includes(phoneNumber)) {
            await sendAsRiley(`📞 ${phoneNumber} is not in the verified list for this Twilio account. Verified numbers: ${verifiedNumbers.join(', ')}`);
            break;
          }
          try {
            await makeOutboundCall(phoneNumber, "Hey Jordan, it's Riley! You asked me to give you a call.");
            await sendAsRiley(`📞 Calling ${phoneNumber}...`);
          } catch (err) {
            await sendAsRiley(`❌ Call failed: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          break;
        }
        case 'TEST_CALL': {
          if (!isTelephonyAvailable()) {
            await sendAsRiley('📞 Phone system not configured (missing Twilio credentials).');
            break;
          }
          if (!param) {
            await sendAsRiley('📞 No phone number specified. Use [ACTION:TEST_CALL:number].');
            break;
          }
          const verifiedNumbers = (process.env.TWILIO_VERIFIED_NUMBERS || '0436012231')
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean);
          const phoneNumber = param.trim();
          if (!verifiedNumbers.includes(phoneNumber)) {
            await sendAsRiley(`📞 ${phoneNumber} is not in the verified list for this Twilio account. Verified numbers: ${verifiedNumbers.join(', ')}`);
            break;
          }
          try {
            await makeAsapTesterCall(phoneNumber);
            await sendAsRiley(`🧪📞 ASAPTester voice check calling ${phoneNumber}...`);
          } catch (err) {
            await sendAsRiley(`❌ ASAPTester test call failed: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          break;
        }
        case 'CONFERENCE': {
          if (!isTelephonyAvailable()) {
            await sendAsRiley('📞 Phone system not configured (missing Twilio credentials).');
            break;
          }
          if (!param) {
            await sendAsRiley('📞 No phone numbers specified. Riley, include numbers with [ACTION:CONFERENCE:num1,num2].');
            break;
          }
          const verifiedNumbers = new Set(
            (process.env.TWILIO_VERIFIED_NUMBERS || '0436012231')
              .split(',')
              .map((n) => n.trim())
              .filter(Boolean)
          );
          const requested = param
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean);
          const numbers = requested.filter((n) => verifiedNumbers.has(n));
          if (numbers.length === 0) {
            await sendAsRiley(`📞 None of the requested numbers are verified for this Twilio account. Verified numbers: ${[...verifiedNumbers].join(', ')}`);
            break;
          }
          try {
            const confName = await startConferenceCall(numbers);
            await sendAsRiley(`📞 **Conference call started** — ${confName}\nCalling: ${numbers.join(', ')} + Riley`);
          } catch (err) {
            await sendAsRiley(`❌ Conference failed: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          break;
        }
      }
    } catch (err) {
      console.error(`Action ${action} error:`, err instanceof Error ? err.message : 'Unknown');
    }
  }
}

/**
 * Parse Riley/Ace's response for @agent directives using strict word-boundary regex.
 * Only matches explicit @name patterns to avoid false positives.
 */
const DIRECTED_AGENT_IDS = new Set<string>([
  'developer', 'qa', 'ux-reviewer', 'security-auditor', 'api-reviewer',
  'dba', 'performance', 'devops', 'copywriter', 'lawyer',
  'ios-engineer', 'android-engineer',
]);

const RILEY_USE_ALL_AGENTS = process.env.RILEY_USE_ALL_AGENTS === 'true';
const RILEY_DIRECT_SPECIALISTS = process.env.RILEY_DIRECT_SPECIALISTS === 'true';
const RILEY_ACE_ERROR_RECOVERY = process.env.RILEY_ACE_ERROR_RECOVERY === 'true';

function parseDirectives(text: string): string[] {
  return parseMentionedAgentIds(text, DIRECTED_AGENT_IDS);
}

function shouldFanOutAllAgents(rileyResponse: string): boolean {
  const text = rileyResponse.toLowerCase();
  if (text.includes('no action needed') || text.includes('for awareness only')) return false;
  if (/(only|just)\s+@(ace|max|sophie|kane|raj|elena|kai|jude|liv|harper|mia|leo)\b/i.test(rileyResponse)) return false;
  return true;
}

const ACE_FIRST_TASK_RE = /\b(?:fix|inspect|investigate|check|review|test|debug|look at|look into|trace|implement|update|change|patch|deploy|smoke|regression|audit|compare|why)\b/i;
const LOW_SIGNAL_COMPLETION_RE = /^\s*(?:done|fixed|resolved|completed|all good|finished)\.?\s*$/i;
const FILE_PATH_EVIDENCE_RE = /\b(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+\b/;
const CHECK_EVIDENCE_RE = /\b(?:npm\s+run|pnpm\s+|yarn\s+|typecheck|lint|test|build|smoke|harness|playwright|jest|tsc)\b/i;

function isAceSelfDelegationResponse(text: string): boolean {
  const normalized = String(text || '').toLowerCase();
  if (!normalized) return false;
  const selfMention = getAgentMention('developer' as AgentId).toLowerCase();
  return normalized.includes('coordinate with ace')
    || normalized.includes('investigate the `client` codebase')
    || normalized.includes('@ace')
    || normalized.includes(selfMention);
}

function hasAceCompletionContract(text: string): boolean {
  const content = String(text || '');
  if (!content.trim()) return false;
  if (!/\bresult\s*:/i.test(content)) return false;
  if (!/\bevidence\s*:/i.test(content)) return false;
  if (!/\brisk\s*\/\s*follow-?up\s*:/i.test(content)) return false;
  if (!FILE_PATH_EVIDENCE_RE.test(content)) return false;
  if (!CHECK_EVIDENCE_RE.test(content)) return false;
  return true;
}

function summarizeAceCompletionForRiley(text: string): string {
  const content = String(text || '').trim();
  if (!content) return 'Execution completed; evidence is available in the developer channel.';

  const result = content.match(/\bresult\s*:\s*([^\n]+)/i)?.[1]?.trim();
  const evidence = content.match(/\bevidence\s*:\s*([^\n]+)/i)?.[1]?.trim();
  const risk = content.match(/\brisk\s*\/\s*follow-?up\s*:\s*([^\n]+)/i)?.[1]?.trim();

  const parts = [
    result ? `Result: ${result}` : null,
    evidence ? `Evidence: ${evidence}` : null,
    risk ? `Risk/Follow-up: ${risk}` : null,
  ].filter(Boolean);

  if (parts.length > 0) {
    return parts.join(' | ').slice(0, 480);
  }

  return content.replace(/\s+/g, ' ').slice(0, 480);
}

function shouldSuppressAceVisibleOutput(text: string): boolean {
  const content = String(text || '');
  return content.trim().length < 90
    || LOW_SIGNAL_COMPLETION_RE.test(content)
    || isAceSelfDelegationResponse(content)
    || !hasAceCompletionContract(content);
}

function inferSpecialistsForContext(text: string): string[] {
  const normalized = String(text || '').toLowerCase();
  const picks = new Set<string>();

  if (/(ui|ux|screen|layout|visual|map|flow|onboarding|mobile)/.test(normalized)) picks.add('ux-reviewer');
  if (/(test|smoke|regression|verify|qa|validation)/.test(normalized)) picks.add('qa');
  if (/(security|auth|token|permission|vuln|owasp)/.test(normalized)) picks.add('security-auditor');
  if (/(api|endpoint|http|route|rest|contract)/.test(normalized)) picks.add('api-reviewer');
  if (/(db|database|schema|migration|sql|query)/.test(normalized)) picks.add('dba');
  if (/(deploy|build|cloud run|gcp|infra|ci|cd)/.test(normalized)) picks.add('devops');
  if (/(perf|performance|latency|slow|optimi[sz]e)/.test(normalized)) picks.add('performance');
  if (/(copy|wording|message|text|empty state)/.test(normalized)) picks.add('copywriter');

  return [...picks].slice(0, 3);
}

function shouldAutoDelegateToAce(userMessage: string, rileyResponse: string): boolean {
  if (parseDirectives(rileyResponse).length > 0) return false;
  const responseText = rileyResponse.toLowerCase();
  if (responseText.includes('no action needed') || responseText.includes('for awareness only') || responseText.includes('decision required')) {
    return false;
  }
  return ACE_FIRST_TASK_RE.test(userMessage);
}

function ensureAceFirstDelegation(rileyResponse: string, userMessage: string): string {
  if (!shouldAutoDelegateToAce(userMessage, rileyResponse)) return rileyResponse;
  return `${rileyResponse}\n\n${getAgentMention('developer' as AgentId)} please take the lead on this task and involve other specialists only if needed.`;
}

function appendDefaultNextSteps(text: string): string {
  return String(text || '').trim();
}

function goalNeedsRuntimeVerification(text: string): boolean {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) return false;
  if (/\bstatus\b|\bthreads?\b|\busage\b|\blimits\b|\bhealth\b|\burls?\b|\blink\b/.test(normalized)) return false;
  return /\bfix|implement|update|change|refactor|remove|add|build|ship|deploy|feature|bug|ui|screen|flow\b/.test(normalized);
}

function isCompletionClaim(text: string): boolean {
  const normalized = String(text || '').toLowerCase();
  return /(done|completed|complete|fixed|resolved|implemented|deployed|shipped|finished|ready)/.test(normalized);
}

function hasInteractiveEvidenceText(content: string): boolean {
  const normalized = String(content || '').toLowerCase();
  return /harness snapshot|mobile harness|capture screenshots|screenshots captured|puppeteer|playwright|visual verification|interactive flow verification|verified in app/.test(normalized);
}

function shouldQueueDecisionReview(text: string): boolean {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) return false;
  if (/\bdecision\b|🛑/.test(normalized)) return true;
  if (/\boption\s*[1-5]\b|^[1-5][.)]\s+/m.test(normalized)) return true;
  if (/\bshould we\b|\bchoose\b|\bpick\b|\bprefer\b|\btrade-?off\b/.test(normalized)) return true;
  return false;
}

async function fetchRecentMessages(channel: any, limit = 60): Promise<Message[]> {
  if (!channel || !('messages' in channel) || !channel.messages?.fetch) return [];
  try {
    const fetched = await channel.messages.fetch({ limit });
    return [...fetched.values()] as Message[];
  } catch {
    return [];
  }
}

async function hasRecentRuntimeVerificationEvidence(
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  sinceTs: number
): Promise<boolean> {
  const channels = getBotChannels();
  const rileyChannel = getAgentWorkChannel('executive-assistant', groupchat);
  const candidates = [channels?.screenshots, workspaceChannel, rileyChannel].filter(Boolean);

  try {
    for (const candidate of candidates) {
      const recent = await fetchRecentMessages(candidate, 60);
      for (const msg of recent) {
        if (msg.createdTimestamp < sinceTs) continue;
        if (msg.attachments?.size > 0) {
          return true;
        }

        const content = String(msg.content || '');
        if (hasInteractiveEvidenceText(content)) {
          return true;
        }

        for (const attachment of msg.attachments.values()) {
          const name = String(attachment.name || '').toLowerCase();
          if (/\.(png|jpg|jpeg|webp)$/.test(name)) {
            return true;
          }
        }
      }
    }
  } catch (err) {
    console.warn('Could not verify runtime evidence:', err instanceof Error ? err.message : 'Unknown');
  }

  return false;
}

function shouldMirrorCompletionToGroupchat(text: string, workspaceChannel: WebhookCapableChannel, groupchat: TextChannel): boolean {
  if (workspaceChannel.id === groupchat.id) return false;
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) return false;
  if (/decision\s+required|\bblocked\b|waiting\s+for\s+(?:approval|input)|need\s+approval/.test(normalized)) return false;
  if (/\breceived\b|\bstarting\b|\bworking\b|\bplan\b|\bwill\b|\bin progress\b|\bongoing\b/.test(normalized)) return false;
  return isCompletionClaim(normalized);
}

function buildChainCompletionWatchdogMessage(findings: string[], errors: string[]): string {
  const findingBits = findings
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((line) => `- ${line.slice(0, 220)}`);
  const errorBits = errors
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((line) => `- ${line.slice(0, 220)}`);

  const statusLine = errorBits.length > 0
    ? 'Work is partially complete with follow-up required.'
    : 'Workstream completed via Riley orchestration.';

  const body = [
    `✅ ${statusLine}`,
    findingBits.length > 0 ? `Evidence:\n${findingBits.join('\n')}` : 'Evidence: agent execution completed; details logged in workspace channels.',
    errorBits.length > 0 ? `Open issues:\n${errorBits.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  return appendDefaultNextSteps(body);
}

async function recoverFromAgentErrors(
  rileyResponse: string,
  errorLines: string[],
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  signal?: AbortSignal
): Promise<{ findings: string[]; errors: string[] }> {
  const ace = getAgent('developer' as AgentId);
  if (!ace) return { findings: [], errors: ['Ace: unavailable for recovery'] };

  try {
    if (signal?.aborted) return { findings: [], errors: [] };
    markGoalProgress('🧯 Ace recovering agent errors...');
    const aceChannel = getAgentWorkChannel('developer', groupchat);
    aceChannel.sendTyping().catch(() => {});

    const recoveryContext = [
      '[System escalation from Riley]: One or more specialist agents errored during execution.',
      '',
      'Original Riley plan:',
      rileyResponse,
      '',
      'Reported errors:',
      ...errorLines.map((line) => `- ${line}`),
      '',
      'Your task:',
      '1) Diagnose likely root cause(s).',
      '2) Apply repo/tool fixes when possible.',
      '3) Re-run or re-coordinate only the needed specialists using explicit @mentions from this guide:',
      buildAgentMentionGuide(['security-auditor', 'api-reviewer', 'dba', 'performance', 'devops', 'copywriter', 'lawyer', 'qa', 'ux-reviewer', 'ios-engineer', 'android-engineer']),
      '4) End with a short status: fixed, partially fixed, or blocked.',
    ].join('\n');

    const aceRecovery = await dispatchToAgent('developer', recoveryContext, aceChannel, {
      signal,
      maxTokens: Math.max(SUBAGENT_MAX_TOKENS, 2200),
      persistUserContent: `[Riley recovery escalation]: ${errorLines.join('; ').slice(0, 1200)}`,
      documentLine: '🧯 {response}',
      workspaceChannel,
    });

    if (signal?.aborted) return { findings: [], errors: [] };

    const findings: string[] = [];
    if (aceRecovery.trim()) {
      findings.push(`${getAgentMention('developer' as AgentId)}: ${aceRecovery.slice(0, 500)}`);
    }

    const recoverySubDirectives = parseDirectives(aceRecovery);
    if (recoverySubDirectives.length > 0) {
      const delegated = await handleSubAgents(recoverySubDirectives, aceRecovery, groupchat, workspaceChannel, signal);
      findings.push(...delegated.findings);
      return { findings, errors: delegated.errors };
    }

    return { findings, errors: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
    console.error('Ace recovery error:', err instanceof Error ? err.message : 'Unknown');
    void postAgentErrorLog('ace:recovery', 'Ace recovery error', { agentId: 'developer', detail: msg });
    try {
      const wh = await getWebhook(workspaceChannel);
      await wh.send({ content: '⚠️ Ace had an error while recovering specialist failures.', username: `${ace.emoji} ${ace.name}`, avatarURL: ace.avatarUrl });
    } catch {
    }
    return { findings: [], errors: ['Ace: recovery error'] };
  }
}

/**
 * Handle the chain: Riley → Ace → sub-agents → report back
 */
async function handleAgentChain(
  rileyResponse: string,
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  signal?: AbortSignal
): Promise<void> {
  const directedAgents = parseDirectives(rileyResponse);
  const wantsFullTeam = RILEY_USE_ALL_AGENTS && shouldFanOutAllAgents(rileyResponse);
  const effectiveAgents = wantsFullTeam
    ? [...DIRECTED_AGENT_IDS]
    : directedAgents;
  if (effectiveAgents.length === 0) return;
  markGoalProgress('🧩 Coordinating specialist agents...');

  const aceDirected = effectiveAgents.length > 0;
  const otherDirected = RILEY_DIRECT_SPECIALISTS
    ? effectiveAgents.filter((id) => id !== 'developer')
    : [];
  const consolidatedFindings: string[] = [];
  const consolidatedErrors: string[] = [];
  const rileyAlreadyCompletion = /(done|completed|complete|fixed|resolved|implemented|deployed|shipped|finished|ready)/i.test(rileyResponse);
  const needsRuntimeEvidence = goalNeedsRuntimeVerification(`${activeGoal || ''}\n${rileyResponse}`);
  if (aceDirected) {
    const ace = getAgent('developer' as AgentId);
    if (ace) {
      try {
        if (signal?.aborted) return;
        const aceChannel = getAgentWorkChannel('developer', groupchat);
        aceChannel.sendTyping().catch(() => {});
        const aceContext = `[Riley directed you]: ${rileyResponse}\n\nOwn execution yourself first. Only bring in extra specialists if they are truly needed. If you do delegate, use the exact Discord mentions from this guide: ${buildAgentMentionGuide(['security-auditor', 'api-reviewer', 'dba', 'performance', 'devops', 'copywriter', 'lawyer', 'qa', 'ux-reviewer', 'ios-engineer', 'android-engineer'])}.\n\nWhen you finish, do NOT reply with just "Done". Include these exact sections:\n- Result: one sentence outcome.\n- Evidence: files changed, commands/tests run, and key output.\n- Risk/Follow-up: any caveats or next checks.`;

        let aceResponse = await dispatchToAgent('developer', aceContext, aceChannel, {
          signal,
          persistUserContent: `[Riley directed]: ${rileyResponse.slice(0, 1000)}`,
          documentLine: '✅ {response}',
          workspaceChannel,
          suppressVisibleOutput: shouldSuppressAceVisibleOutput,
        });

        const needsQualityRetry = () => (
          aceResponse.trim().length < 90
          || LOW_SIGNAL_COMPLETION_RE.test(aceResponse)
          || isAceSelfDelegationResponse(aceResponse)
          || !hasAceCompletionContract(aceResponse)
        );

        if (!signal?.aborted && needsQualityRetry()) {
          aceResponse = await dispatchToAgent(
            'developer',
            '[System quality check] Your last update did not satisfy execution standards. Do not delegate back to Ace, do not ask others to investigate, and do not use placeholders. Execute directly and provide a concrete completion summary with these exact sections: Result, Evidence, Risk/Follow-up. Include at least one real file path and one validation command or check.',
            aceChannel,
            {
              signal,
              maxTokens: Math.max(SUBAGENT_MAX_TOKENS, 700),
              persistUserContent: '[System quality check for Ace response detail]',
              documentLine: '✅ {response}',
              workspaceChannel,
              suppressVisibleOutput: shouldSuppressAceVisibleOutput,
            }
          );
        }

        if (!signal?.aborted && needsQualityRetry()) {
          aceResponse = await dispatchToAgent(
            'developer',
            '[System quality check final] Return only this format and fill it concretely:\nResult: <one sentence>\nEvidence: files=<path1,path2>; checks=<command and outcome>\nRisk/Follow-up: <one sentence>.\nNo delegation text. No placeholders.',
            aceChannel,
            {
              signal,
              maxTokens: Math.max(SUBAGENT_MAX_TOKENS, 500),
              persistUserContent: '[System final quality check for Ace response detail]',
              documentLine: '✅ {response}',
              workspaceChannel,
              suppressVisibleOutput: shouldSuppressAceVisibleOutput,
            }
          );
        }

        const aceQualityFailed = !signal?.aborted && needsQualityRetry();
        if (aceQualityFailed) {
          consolidatedErrors.push('Ace completion quality check failed after retries.');
        }

        if (!signal?.aborted && hasAceCompletionContract(aceResponse)) {
          consolidatedFindings.push(`${getAgentMention('developer' as AgentId)}: ${summarizeAceCompletionForRiley(aceResponse)}`);
        }

        if (signal?.aborted) return;
        markGoalProgress('💻 Ace implementing...');

        const aceSubDirectives = parseDirectives(aceResponse);
        if (aceSubDirectives.length > 0) {
          const fromAce = await handleSubAgents(aceSubDirectives, aceResponse, groupchat, workspaceChannel, signal);
          consolidatedFindings.push(...fromAce.findings);
          consolidatedErrors.push(...fromAce.errors);
        } else {
          const inferredSpecialists = inferSpecialistsForContext(`${rileyResponse}\n${aceResponse}`)
            .filter((id) => id !== 'developer');
          const forcedFallback = aceQualityFailed
            ? ['qa', 'ux-reviewer', 'api-reviewer']
            : [];
          const fallbackAgents = [...new Set([...forcedFallback, ...inferredSpecialists])];
          if (fallbackAgents.length > 0) {
            if (aceQualityFailed) {
              consolidatedFindings.push('Forced specialist fallback executed due to weak Ace completion output.');
            }
            const autoSpecialistRun = await handleSubAgents(fallbackAgents, aceResponse, groupchat, workspaceChannel, signal);
            consolidatedFindings.push(...autoSpecialistRun.findings);
            consolidatedErrors.push(...autoSpecialistRun.errors);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
        console.error('Ace error:', err instanceof Error ? err.message : 'Unknown');
        void postAgentErrorLog('ace:groupchat', 'Ace error', { agentId: 'developer', detail: msg });
        try {
          const wh = await getWebhook(workspaceChannel);
          await wh.send({ content: `⚠️ Ace had an error.`, username: `${ace.emoji} ${ace.name}`, avatarURL: ace.avatarUrl });
        } catch (webhookErr) {
          console.warn('Webhook error notification failed for Ace:', webhookErr instanceof Error ? webhookErr.message : 'Unknown');
        }
      }
    }
  }

  if (otherDirected.length > 0) {
    const direct = await handleSubAgents(otherDirected, rileyResponse, groupchat, workspaceChannel, signal);
    consolidatedFindings.push(...direct.findings);
    consolidatedErrors.push(...direct.errors);
  }

  if (RILEY_ACE_ERROR_RECOVERY && !signal?.aborted && consolidatedErrors.length > 0) {
    const recovered = await recoverFromAgentErrors(rileyResponse, consolidatedErrors, groupchat, workspaceChannel, signal);
    consolidatedFindings.push(...recovered.findings);
    consolidatedErrors.push(...recovered.errors);
  }

  if (!signal?.aborted && needsRuntimeEvidence) {
    const evidenceSince = Math.max(Date.now() - 2 * 60 * 60 * 1000, activeGoalStartedAt - 60_000);
    const hasEvidence = await hasRecentRuntimeVerificationEvidence(groupchat, workspaceChannel, evidenceSince);
    if (!hasEvidence) {
      consolidatedErrors.push('Required runtime verification evidence is missing (screenshots or mobile harness/puppeteer output).');
      const riley = getAgent('executive-assistant' as AgentId);
      if (riley) {
        await sendAgentMessage(workspaceChannel, riley, '🛑 Completion gate: runtime verification evidence is required but missing. I will keep this thread open until checkable proof is posted (screenshots or harness/puppeteer output).');
      }
    }
  }

  if (GROUPCHAT_SUMMARY_ONLY && !signal?.aborted && (consolidatedFindings.length > 0 || consolidatedErrors.length > 0)) {
    const riley = getAgent('executive-assistant' as AgentId);
    if (riley) {
      await sendAgentMessage(workspaceChannel, riley, buildConsolidatedAgentUpdate(consolidatedFindings, consolidatedErrors));

      if (!rileyAlreadyCompletion) {
        const watchdogSummary = buildChainCompletionWatchdogMessage(consolidatedFindings, consolidatedErrors);
        await sendAgentMessage(workspaceChannel, riley, watchdogSummary);
        if (workspaceChannel.id !== groupchat.id) {
          await sendAgentMessage(groupchat, riley, `✅ Completion update: ${watchdogSummary}`);
        }
      }
    }
  }
}

/**
 * Tier-based parallelism: agents in the same tier run concurrently.
 * Earlier tiers complete before later tiers start, so designer output
 * informs implementation, and implementation informs reviewers.
 */
const AGENT_TIER: Record<string, number> = {
  'ux-reviewer': 0,      // Sophie — design first
  'dba': 0,              // Elena — schema design (parallel with Sophie)
  'api-reviewer': 0,     // Raj — API design (parallel with Sophie/Elena)
  'developer': 1,        // Ace — implementation (after design)
  'security-auditor': 2, // Kane — review (parallel with other reviewers)
  'lawyer': 2,           // Harper — compliance review
  'qa': 2,               // Max — testing review
  'performance': 2,      // Kai — perf review
  'copywriter': 2,       // Liv — copy review
  'devops': 3,           // Jude — deploy (after review)
  'ios-engineer': 3,     // Mia — platform (parallel with deploy)
  'android-engineer': 3, // Leo — platform
};

async function handleSubAgents(
  agentIds: string[],
  directiveContext: string,
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  signal?: AbortSignal
): Promise<{ findings: string[]; errors: string[] }> {
  const validAgents = agentIds
    .filter((id) => id !== 'executive-assistant')
    .map((id) => ({ id, agent: getAgent(id as AgentId) }))
    .filter((a): a is { id: string; agent: AgentConfig } => a.agent !== null && a.agent !== undefined);

  if (validAgents.length === 0) return { findings: [], errors: [] };
  markGoalProgress('🛠️ Sub-agents running...');

  const tiers = new Map<number, typeof validAgents>();
  for (const entry of validAgents) {
    const tier = AGENT_TIER[entry.id] ?? 99;
    if (!tiers.has(tier)) tiers.set(tier, []);
    tiers.get(tier)!.push(entry);
  }

  const sortedTiers = [...tiers.keys()].sort((a, b) => a - b);
  const priorFindings: string[] = [];
  const errorLines: string[] = [];

  for (const tierNum of sortedTiers) {
    const tierAgents = tiers.get(tierNum)!;
    if (signal?.aborted) break;
    groupchat.sendTyping().catch(() => {});

    const priorSummary = priorFindings.slice(-3).join('\n').slice(0, 900);
    const priorContext = priorSummary
      ? `\n\nPrior agent findings (use only if relevant):\n${priorSummary}`
      : '';
    const directiveExcerpt = directiveContext.replace(/\s+/g, ' ').trim().slice(0, 1400);

    const tierResults = await runLimited(
      tierAgents.map(({ id, agent }) => async () => {
        if (signal?.aborted) return;
        documentToChannel(id, `📥 Received task from groupchat. Working...`).catch(() => {});
        const agentContext = `[Directive from groupchat]: ${directiveExcerpt}${priorContext}\n\nDo only the specialist work relevant to your role. Be concise — max 120 words. Report what you found or changed.`;
        const outChannel = getAgentWorkChannel(id, groupchat);
        const agentResponse = await dispatchToAgent(id as AgentId, agentContext, outChannel, {
          maxTokens: SUBAGENT_MAX_TOKENS,
          memoryWindow: 6,
          signal,
          persistUserContent: `[Groupchat directive]: ${directiveContext.slice(0, 500)}`,
          documentLine: `✅ {response}`,
          workspaceChannel,
        });

        if (signal?.aborted) return;
        return `${getAgentMention(id as AgentId)}: ${agentResponse.slice(0, 500)}`;
      }),
      MAX_PARALLEL_SUBAGENTS
    );

    for (let i = 0; i < tierResults.length; i++) {
      const result = tierResults[i];
      if (result.status === 'fulfilled') {
        if (typeof result.value === 'string' && result.value.length > 0) {
          priorFindings.push(result.value);
        }
      } else {
        console.error('Sub-agent tier error:', result.reason);
        void postAgentErrorLog(`sub-agent:${tierAgents[i]?.id || 'unknown'}`, 'Sub-agent tier error', {
          agentId: tierAgents[i]?.id,
          detail: result.reason instanceof Error ? result.reason.stack || result.reason.message : String(result.reason),
        });
      }
    }

    for (let i = 0; i < tierResults.length; i++) {
      if (tierResults[i].status === 'rejected') {
        const { agent } = tierAgents[i];
        errorLines.push(`${getAgentMention(tierAgents[i].id as AgentId)}: error`);
        try {
          const wh = await getWebhook(getAgentWorkChannel(tierAgents[i].id, groupchat));
          await wh.send({ content: `⚠️ ${agent.name.split(' ')[0]} had an error.`, username: `${agent.emoji} ${agent.name}`, avatarURL: agent.avatarUrl });
        } catch (webhookErr) {
          console.warn(`Webhook error notification failed for ${agent.name}:`, webhookErr instanceof Error ? webhookErr.message : 'Unknown');
        }
      }
    }
  }
  persistGroupHistory();
  markGoalProgress('📝 Sub-agent cycle completed');
  return { findings: priorFindings, errors: errorLines };
}

/**
 * User explicitly @mentioned agents — route directly to them in parallel.
 */
async function handleDirectedMessage(
  userMessage: string,
  senderName: string,
  agentIds: string[],
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  signal?: AbortSignal
): Promise<void> {
  const contextMessage = `[${senderName}]: ${userMessage}`;
  markGoalProgress('🎯 Direct specialist routing...');
  groupchat.sendTyping().catch(() => {});
  const echoToGroupchat = shouldEchoDirectedResponseToGroupchat(agentIds, userMessage);

  const validAgents = agentIds
    .map((id) => ({ id, agent: getAgent(id as AgentId) }))
    .filter((a): a is { id: string; agent: AgentConfig } => a.agent !== null && a.agent !== undefined);

  const results = await runLimited(
    validAgents.map(({ id, agent }) => async () => {
      if (signal?.aborted) return;
      const outChannel = getAgentWorkChannel(id, groupchat);
      const agentResponse = await dispatchToAgent(id as AgentId, contextMessage, outChannel, {
        maxTokens: SUBAGENT_MAX_TOKENS,
        memoryWindow: 6,
        signal,
        documentLine: `direct-mention sender=${senderName} response={response}`,
        workspaceChannel,
      });

      if (signal?.aborted) return;
      if (echoToGroupchat) {
        const compact = agentResponse.replace(/\s+/g, ' ').trim().slice(0, 600);
        if (compact) {
          await sendAgentMessage(groupchat, agent, compact);
        }
      }

      if (signal?.aborted) return;
    }),
    MAX_PARALLEL_SUBAGENTS
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      const { agent } = validAgents[i];
      const reason = (results[i] as PromiseRejectedResult).reason;
      console.error(`${agent.name} error:`, reason);
      void postAgentErrorLog(`direct:${validAgents[i].id}`, `${agent.name} error`, {
        agentId: validAgents[i].id,
        detail: reason instanceof Error ? reason.stack || reason.message : String(reason),
      });
      try {
        const wh = await getWebhook(getAgentWorkChannel(validAgents[i].id, groupchat));
        await wh.send({ content: `⚠️ ${agent.name.split(' ')[0]} had an error.`, username: `${agent.emoji} ${agent.name}`, avatarURL: agent.avatarUrl });
      } catch (webhookErr) {
        console.warn(`Webhook error notification failed for ${agent.name}:`, webhookErr instanceof Error ? webhookErr.message : 'Unknown');
      }
    }
  }

  groupHistory.push({ role: 'user', content: contextMessage });
  persistGroupHistory();
  markGoalProgress('✅ Directed response completed');
}

/**
 * Handle a reply typed in the #decisions channel.
 * Routes the answer back to Riley in groupchat so she can continue blocked work.
 */
export async function handleDecisionReply(
  message: Message,
  groupchat: TextChannel
): Promise<void> {
  const userName = message.member?.displayName || message.author.username;
  const content = message.content.trim();
  if (!content) return;

  try {
    await message.react('✅');
  } catch { /* ignore — bot may lack reaction perms */ }

  const workspaceChannel = await ensureGoalWorkspace(groupchat, userName, `Decision response: ${content}`);

  await handleRileyMessage(
    `[Decision response from ${userName} in #decisions]: ${content}`,
    userName,
    message.member || undefined,
    groupchat,
    undefined,
    workspaceChannel
  );
}

/**
 * Post a reaction-based decision embed.
 * Parses numbered options from Riley's response and adds reaction buttons.
 */
async function postDecisionEmbed(
  targetChannel: TextChannel,
  groupchat: TextChannel,
  rileyResponse: string
): Promise<void> {
  const decisionText = String(rileyResponse || '');
  if (!decisionText.trim()) return;

  const optionRe = /^[1-5]️?⃣?\s*[.):]\s*(.+)$/gm;
  const options: string[] = [];
  for (const match of decisionText.matchAll(optionRe)) {
    options.push(match[1].trim());
  }

  if (options.length === 0) {
    const altRe = /[1-5]️⃣\s*\*\*(.+?)\*\*/g;
    for (const match of decisionText.matchAll(altRe)) {
      options.push(match[1].trim());
    }
  }

  const numberReactions = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
  const yesNoReactions = ['✅', '❌'];
  const hasYesNoCue = /\byes\b.*\bno\b|\bapprove\b.*\breject\b|\bgo\b.*\bno-go\b|\bship\b.*\bhold\b/i.test(decisionText);
  const usingYesNo = options.length === 0 && hasYesNoCue;

  const reactionSet = usingYesNo ? yesNoReactions : numberReactions;
  const choiceSet = usingYesNo ? ['Yes', 'No'] : options.slice(0, 5);

  if (choiceSet.length === 0) return; // No parseable options

  const isDecisionsChannel = decisionsChannel && targetChannel.id === decisionsChannel.id;

  const embed = new EmbedBuilder()
    .setTitle('📋 Decision Review (Optional)')
    .setDescription(
      choiceSet
        .map((opt, i) => `${reactionSet[i]} ${opt}`)
        .join('\n\n')
    )
    .setColor(0x3a8dff)
    .setFooter({ text: isDecisionsChannel ? 'Work continues automatically. React to steer plan or type your preference.' : 'Work continues automatically. React to steer plan.' });

  const decisionMsg = await targetChannel.send({ embeds: [embed] });

  for (let i = 0; i < choiceSet.length; i++) {
    await decisionMsg.react(reactionSet[i]).catch(() => {});
  }

  const timeoutMs = isDecisionsChannel ? 12 * 60 * 60 * 1000 : 5 * 60 * 1000;
  const filter = (reaction: any, user: any) => {
    return reactionSet.includes(reaction.emoji.name || '') && !user.bot;
  };

  decisionMsg.awaitReactions({ filter, max: 1, time: timeoutMs })
    .then(async (collected) => {
      const reaction = collected.first();
      if (!reaction) return;
      const choiceIndex = reactionSet.indexOf(reaction.emoji.name || '');
      const choice = choiceSet[choiceIndex] || `Option ${choiceIndex + 1}`;
      const users = await reaction.users.fetch();
      const reactUser = users.find((u) => !u.bot);
      const userName = reactUser?.username || 'User';

      console.log(`Decision: ${userName} chose option ${choiceIndex + 1}: "${choice}"`);

      const riley = getAgent('executive-assistant' as AgentId);
      if (riley) {
        try {
          const wh = await getWebhook(targetChannel);
          await wh.send({ content: `✅ **${userName}** chose: **${choice}**`, username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
        } catch {
          await targetChannel.send(`✅ **${userName}** chose: **${choice}**`);
        }
      } else {
        await targetChannel.send(`✅ **${userName}** chose: **${choice}**`);
      }

      const decisionMessage = `[Plan preference from decisions reactions] ${userName} selected ${choice}. Continue execution and adjust plan accordingly.`;
      const workspaceChannel = await ensureGoalWorkspace(groupchat, userName, decisionMessage);
      await handleRileyMessage(decisionMessage, userName, undefined, groupchat, undefined, workspaceChannel);
    })
    .catch(() => {
    });
}

/** Persist groupHistory to disk. Called after every interaction. */
function persistGroupHistory(): void {
  saveMemory('groupchat', groupHistory);
  if (groupHistory.length >= 60) {
    compressMemory('groupchat').catch(() => {});
  }
}
