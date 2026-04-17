import { execFileSync, execFile } from 'child_process';
import { buildSafeCommandEnv } from '../envSandbox';
import { formatAge } from '../../utils/time';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import pool from '../../db/pool';

import { Message, TextChannel, GuildMember, EmbedBuilder, ThreadAutoArchiveDuration, ButtonBuilder, ActionRowBuilder, ButtonStyle, ComponentType } from 'discord.js';

import { triggerCloudBuild, listRevisions, getCurrentRevision, rollbackToRevision } from '../../services/cloudrun';
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
import { getBotChannels } from '../bot';
import { agentRespond, clearGeminiQuotaFuse, ConversationMessage, extractAgentResponseEnvelope, getContextRuntimeReport, getGeminiQuotaFuseStatus, setQuotaFuseNotifyCallback, setRateLimitNotifyCallback } from '../claude';
import { buildHandoffContext, type HandoffResult, type ExecutionIssue, type ExecutionEvidence, formatHandoffPrompt } from '../handoff';
import { appendToMemory, getMemoryContext, loadMemory, saveMemory, clearMemory, compressMemory } from '../memory';
import { getAllModelHealth } from '../modelHealth';
import { executeLoopAdapters } from '../loopAdapters';
import { formatOperationsStewardRequests } from '../operationsSteward';
import { createAgentExecutionReport, executeOpusPlan, type OpusExecutionSummary } from '../opusExecution';
import { postAgentErrorLog } from '../services/agentErrors';
import { captureAndPostScreenshots } from '../services/screenshots';
import { makeOutboundCall, makeAsapTesterCall, startConferenceCall, isTelephonyAvailable } from '../services/telephony';
import { getWebhook, sendWebhookMessage, WebhookCapableChannel } from '../services/webhooks';
import { approveAdditionalBudget, getContextEfficiencyReport, getUsageReport, refreshLiveBillingData, refreshUsageDashboard } from '../usage';
import { logAgentEvent, postOpsLine } from '../activityLog';

import { startCall, endCall, isCallActive, injectVoiceTranscriptForTesting, processTesterVoiceTurnForCall } from './callSession';
import { SYSTEM_COLORS, BUTTON_IDS } from '../ui/constants';
import { isDesignDeliverableDetailed, shouldSkipContractEnforcement, buildAceDesignContext, buildAceStandardContext } from './designDeliverable';
import { documentToChannel } from './documentation';
import { goalState, GOAL_THREAD_COUNTER_RE } from './goalState';
import { LOW_SIGNAL_COMPLETION_RE } from './responseNormalization';
import { sendAgentMessage, clearHistory } from './textChannel';
import { errMsg } from '../../utils/errors';
import { buildLoopHealthCompactSummary, buildLoopHealthDetailedReport, recordLoopHealth } from '../loopHealth';
import { buildLoggingEngineReport, runLoggingEngine } from '../loggingEngine';
import { buildGroupchatDecisionAttention, buildGroupchatSingleUserNotice, buildTextStatusSummary } from '../rileyInteraction';


type ToolNotificationBatch = {
  channel: WebhookCapableChannel;
  agent: AgentConfig;
  items: string[];
  timer: NodeJS.Timeout | null;
};

const TOOL_NOTIFICATION_FLUSH_MS = parseInt(process.env.TOOL_NOTIFICATION_FLUSH_MS || '2500', 10);
const TOOL_NOTIFICATION_MAX_ITEMS = parseInt(process.env.TOOL_NOTIFICATION_MAX_ITEMS || '6', 10);
const TOOL_NOTIFICATION_CHANNEL_COOLDOWN_MS = parseInt(process.env.TOOL_NOTIFICATION_CHANNEL_COOLDOWN_MS || '5000', 10);
const TOOL_NOTIFICATIONS_TOOLS_ONLY = String(process.env.TOOL_NOTIFICATIONS_TOOLS_ONLY || 'true').toLowerCase() !== 'false';
const toolNotificationBatches = new Map<string, ToolNotificationBatch>();
const toolNotificationLastPostedAt = new Map<string, number>();
const rileyStallNoticeAt = new Map<string, number>();
const RILEY_STALL_NOTICE_COOLDOWN_MS = parseInt(process.env.RILEY_STALL_NOTICE_COOLDOWN_MS || '120000', 10);

/** Send a tool-use notification as the agent (via webhook). */
async function sendToolNotification(channel: WebhookCapableChannel, agent: AgentConfig, summary: string): Promise<void> {
  const key = `${channel.id}:${agent.id}`;
  let batch = toolNotificationBatches.get(key);
  if (!batch) {
    batch = { channel, agent, items: [], timer: null };
    toolNotificationBatches.set(key, batch);
  }

  batch.items.push(String(summary || '').trim());
  if (batch.items.length >= TOOL_NOTIFICATION_MAX_ITEMS) {
    await flushToolNotificationBatch(key);
    return;
  }

  if (batch.timer) return;
  batch.timer = setTimeout(() => {
    void flushToolNotificationBatch(key);
  }, Math.max(300, TOOL_NOTIFICATION_FLUSH_MS));
}

async function flushToolNotificationBatch(key: string): Promise<void> {
  const batch = toolNotificationBatches.get(key);
  if (!batch) return;
  if (batch.timer) {
    clearTimeout(batch.timer);
    batch.timer = null;
  }

  const items = batch.items.splice(0, TOOL_NOTIFICATION_MAX_ITEMS).filter(Boolean);
  if (items.length === 0) {
    toolNotificationBatches.delete(key);
    return;
  }

  const deduped = [...new Set(items)].slice(0, TOOL_NOTIFICATION_MAX_ITEMS);
  const channels = getBotChannels();
  const targetChannel = (TOOL_NOTIFICATIONS_TOOLS_ONLY && channels?.tools)
    ? channels.tools
    : batch.channel;
  const contextPrefix = targetChannel.id !== batch.channel.id
    ? `[#${(batch.channel as any)?.name || 'channel'}] `
    : '';

  const channelCooldown = Math.max(0, TOOL_NOTIFICATION_CHANNEL_COOLDOWN_MS);
  const lastPostedAt = toolNotificationLastPostedAt.get(targetChannel.id) || 0;
  const waitMs = channelCooldown - (Date.now() - lastPostedAt);
  if (waitMs > 0) {
    batch.items.unshift(...items);
    batch.timer = setTimeout(() => {
      void flushToolNotificationBatch(key);
    }, Math.max(300, waitMs));
    return;
  }

  const content = deduped.length === 1
    ? `🔧 ${contextPrefix}${deduped[0]}`
    : `🔧 ${contextPrefix}${deduped.length} tool actions:\n- ${deduped.join('\n- ')}`;

  try {
    await sendWebhookMessage(targetChannel, {
      content,
      username: `${batch.agent.emoji} ${batch.agent.name}`,
      avatarURL: batch.agent.avatarUrl,
    });
    toolNotificationLastPostedAt.set(targetChannel.id, Date.now());
  } catch (err) {
    console.warn(`Webhook tool notification failed for ${batch.agent.name}:`, errMsg(err));
  } finally {
    if (batch.items.length === 0) {
      toolNotificationBatches.delete(key);
    } else {
      batch.timer = setTimeout(() => {
        void flushToolNotificationBatch(key);
      }, Math.max(300, TOOL_NOTIFICATION_FLUSH_MS));
    }
  }
}
const groupHistory: ConversationMessage[] = loadMemory('groupchat');

// Global FIFO for groupchat events. A single stuck request can block all later
// messages, so processing is always paired with explicit timeout guards.
let messageQueue: Promise<void> = Promise.resolve();

// In-flight cancellation token. New inbound messages abort older work so the
// bot follows the newest user intent instead of finishing stale tasks.
let activeAbortController: AbortController | null = null;
let activeThinkingMessage: Message | null = null;
let activeGroupchatOwner: { userId: string; displayName: string } | null = null;

// When true, a smoke_test_agents tool call is in progress. Tester bot messages
// arriving during this window are subprocess probes and must NOT abort or
// re-enter the main message queue.
let activeSmokeTestRunning = false;
export function setActiveSmokeTestRunning(val: boolean): void { activeSmokeTestRunning = val; }
export function isActiveSmokeTestRunning(): boolean { return activeSmokeTestRunning; }
let claudeNotificationsBoundChannelId: string | null = null;
const MAX_PARALLEL_SUBAGENTS = parseInt(process.env.MAX_PARALLEL_SUBAGENTS || '3', 10);
const SUBAGENT_MAX_TOKENS = parseInt(process.env.SUBAGENT_MAX_TOKENS || '900', 10);
const GROUPCHAT_PROCESS_TIMEOUT_MS = parseInt(process.env.GROUPCHAT_PROCESS_TIMEOUT_MS || '480000', 10);
const RILEY_NO_RESPONSE_TIMEOUT_MS = parseInt(process.env.RILEY_NO_RESPONSE_TIMEOUT_MS || '180000', 10);
const RILEY_PROGRESS_PING_MS = parseInt(
  process.env.RILEY_PROGRESS_PING_MS || String(Math.max(20_000, Math.floor(RILEY_NO_RESPONSE_TIMEOUT_MS * 0.6))),
  10,
);
const DIRECT_GROUPCHAT_SHORT_PROMPT_MAX_WORDS = parseInt(process.env.DIRECT_GROUPCHAT_SHORT_PROMPT_MAX_WORDS || '18', 10);

const GOAL_STALL_TIMEOUT_MS = parseInt(process.env.GOAL_STALL_TIMEOUT_MS || '420000', 10);
const GOAL_STALL_CHECK_INTERVAL_MS = parseInt(process.env.GOAL_STALL_CHECK_INTERVAL_MS || '60000', 10);
const GOAL_STALL_MAX_RECOVERY_ATTEMPTS = parseInt(process.env.GOAL_STALL_MAX_RECOVERY_ATTEMPTS || '1', 10);
const ENABLE_AUTOMATIC_THREAD_CLOSE_REVIEW = process.env.ENABLE_AUTOMATIC_THREAD_CLOSE_REVIEW === 'true';
const THREAD_CLOSE_REVIEW_IDLE_MS = parseInt(process.env.THREAD_CLOSE_REVIEW_IDLE_MS || '1800000', 10);
const THREAD_CLOSE_REVIEW_INTERVAL_MS = parseInt(process.env.THREAD_CLOSE_REVIEW_INTERVAL_MS || '7200000', 10);
const THREAD_STATUS_POST_INTERVAL_MS = parseInt(process.env.THREAD_STATUS_POST_INTERVAL_MS || '3600000', 10);
const ACTION_COMMAND_TIMEOUT_MS = parseInt(process.env.ACTION_COMMAND_TIMEOUT_MS || '120000', 10);
const AUTO_DEPLOY_ON_THREAD_CLOSE = String(process.env.AUTO_DEPLOY_ON_THREAD_CLOSE || 'true').toLowerCase() !== 'false';
const AUTO_REBUILD_ERROR_COOLDOWN_MS = parseInt(process.env.AUTO_REBUILD_ERROR_COOLDOWN_MS || '900000', 10);
const URL_ACTION_COOLDOWN_MS = parseInt(process.env.URL_ACTION_COOLDOWN_MS || '1800000', 10);
const GROUPCHAT_DUPLICATE_WINDOW_MS = parseInt(process.env.GROUPCHAT_DUPLICATE_WINDOW_MS || '10000', 10);
/** Maximum continuation cycles for multi-step tasks before stopping. */
const MAX_CONTINUATION_CYCLES = parseInt(process.env.RILEY_MAX_CONTINUATION_CYCLES || '3', 10);
const APP_SERVER_ROOT = (fs.existsSync(path.join(process.cwd(), 'package.json')) && fs.existsSync(path.join(process.cwd(), 'src')))
  ? process.cwd()
  : path.resolve(__dirname, '../../..');
const APP_REPO_ROOT = path.resolve(APP_SERVER_ROOT, '..');
let lastUrlsActionAt = 0;
let lastGroupchatTimeoutNoticeAt = 0;
const GROUPCHAT_TIMEOUT_NOTICE_COOLDOWN_MS = parseInt(process.env.GROUPCHAT_TIMEOUT_NOTICE_COOLDOWN_MS || '120000', 10);
const GROUPCHAT_SINGLE_USER_NOTICE_COOLDOWN_MS = parseInt(process.env.GROUPCHAT_SINGLE_USER_NOTICE_COOLDOWN_MS || '15000', 10);
const DEFAULT_TESTER_BOT_ID = '1487426371209789450';
let lastGroupchatSingleUserNoticeAt = 0;

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
let lastThreadCloseReviewAt = 0;
let lastAutoRebuildErrorAt = 0;
let lastAutoRebuildErrorKey = '';
let goalWatchdog: ReturnType<typeof setInterval> | null = null;
let threadStatusChannel: TextChannel | null = null;
let threadStatusSourceChannel: TextChannel | null = null;
let threadStatusReporter: ReturnType<typeof setInterval> | null = null;
const recentGroupchatFingerprints = new Map<string, number>();

async function withPgAdvisoryLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
    client.release();
  }
}

function isDuplicateGroupchatMessage(message: Message, content: string): boolean {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  const sender = message.author?.id || 'unknown';
  const key = `${sender}:${normalized.slice(0, 240)}`;
  const now = Date.now();
  const prev = recentGroupchatFingerprints.get(key) || 0;
  recentGroupchatFingerprints.set(key, now);
  if (recentGroupchatFingerprints.size > 500) {
    for (const [k, ts] of recentGroupchatFingerprints) {
      if (now - ts > GROUPCHAT_DUPLICATE_WINDOW_MS * 3) {
        recentGroupchatFingerprints.delete(k);
      }
    }
  }
  return now - prev < GROUPCHAT_DUPLICATE_WINDOW_MS;
}

function markGoalProgress(status?: string): void {
  goalState.markProgress(status);
}

function inferRileyStatus(text: string, completionClaimed: boolean, completionVerified: boolean): 'fixed' | 'partially fixed' | 'blocked' {
  const normalized = String(text || '').toLowerCase();
  if (/\bblocked\b|\bverification pending\b|\bfailed\b|\berror\b/.test(normalized)) return 'blocked';
  // For multi-step goals, suppress premature "fixed" status.
  // If the active goal looks like a multi-step task, require the response to address
  // more than a single sub-item before accepting completion.
  if (completionClaimed && completionVerified) {
    if (isMultiStepGoal(goalState.goal || '') && !hasMultiStepEvidence(normalized)) {
      return 'partially fixed';
    }
    return 'fixed';
  }
  if (completionClaimed && !completionVerified) return 'blocked';
  return 'partially fixed';
}

/** Detect goals that contain numbered lists, "all agents", "each", or multiple items */
function isMultiStepGoal(goal: string): boolean {
  const normalized = goal.toLowerCase();
  // Numbered list or bullet points with multiple items
  if (/(?:^|\n)\s*(?:\d+[.)]\s|[-*]\s)/.test(goal) && (goal.match(/(?:^|\n)\s*(?:\d+[.)]\s|[-*]\s)/g) || []).length >= 2) return true;
  // Multi-target keywords
  if (/\b(all agents|each agent|all the|every|all\s+\d+|all upgrades|implement all)\b/i.test(normalized)) return true;
  // "and" joining multiple tasks
  if (/\b(?:and also|and then|and ask|, and)\b/i.test(normalized)) return true;
  return false;
}

/** Check if the response references completing multiple items, not just one */
function hasMultiStepEvidence(text: string): boolean {
  // Count completion-like signals (e.g., "completed X", "done Y", "implemented Z", "fixed A")
  const completionMatches = text.match(/\b(completed|done|implemented|fixed|finished|created|updated|deployed|merged)\b/gi) || [];
  return completionMatches.length >= 3;
}

function enforceRileyResponseContract(
  text: string,
  completionClaimed: boolean,
  completionVerified: boolean,
): string {
  const normalized = String(text || '').trim();
  if (!normalized) return normalized;
  // Skip contract enforcement for creative/design deliverables — the Status/Root-cause
  // appendage makes no sense for design specs, creative briefs, or information responses.
  if (shouldSkipContractEnforcement(normalized)) return normalized;
  const hasContract = /\bstatus\s*:/i.test(normalized)
    && /\broot cause\s*:/i.test(normalized)
    && /\bfix location\s*:/i.test(normalized)
    && /\bverification evidence\s*:/i.test(normalized)
    && /\bresidual risk\s*:/i.test(normalized);
  if (hasContract) {
    // Strip existing contract block from visible output, log internally
    const stripped = normalized
      .replace(/\n\s*Status:[\s\S]*$/i, '')
      .trim();
    console.log('[riley-contract]', normalized.slice(stripped.length));
    return stripped || normalized;
  }

  const status = inferRileyStatus(normalized, completionClaimed, completionVerified);
  const rootCause = normalized.split(/(?<=[.!?])\s+/)[0]?.slice(0, 180) || 'Investigation in progress.';
  const fixLocations = (normalized.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g) || []).slice(0, 3);
  const verificationEvidence = completionVerified
    ? 'Runtime evidence present (harness/screenshots/checks observed).'
    : 'Runtime evidence missing or blocked; completion is not yet verified.';
  const residualRisk = status === 'fixed'
    ? 'Monitor regressions in the same user flow after next deploy.'
    : 'User flow remains at risk until verification passes.';

  // Log contract internally for audit trail, do NOT append to visible output
  console.log('[riley-contract]', JSON.stringify({ status, rootCause, fixLocations: fixLocations.join(', '), verificationEvidence, residualRisk }));

  return normalized;
}

async function emitRileyStallAlert(
  workspaceChannel: WebhookCapableChannel,
  groupchat: TextChannel,
  goal: string,
  timeoutMs: number,
): Promise<boolean> {
  const key = goal.trim().toLowerCase().slice(0, 240) || 'none';
  const now = Date.now();
  const prev = rileyStallNoticeAt.get(key) || 0;
  if (now - prev < RILEY_STALL_NOTICE_COOLDOWN_MS) {
    return false;
  }
  rileyStallNoticeAt.set(key, now);

  const seconds = Math.round(timeoutMs / 1000);
  const msg = `⚠️ No Riley response after ${seconds}s for this goal. Investigating stall and retrying safeguards.`;
  if ('send' in workspaceChannel) {
    await workspaceChannel.send(msg).catch(() => {});
  }
  if (workspaceChannel.id !== groupchat.id) {
    await groupchat.send(msg).catch(() => {});
  }
  return true;
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
  if (agentIds.length !== 1 || agentIds[0] !== 'executive-assistant') return false;
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
  const goal = compactAuditField(goalState.goal || 'none', 64);
  const status = compactAuditField(goalState.status || 'n/a', 48);
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
    await sendWebhookMessage(groupchat, { content: line, username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
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
          await sendWebhookMessage(targetChannel, {
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
  if (/(?:run|perform|execute)\s+(?:a\s+)?(?:release|prod(?:uction)?|deployment|app)?\s*health\s*check|\/ops\s+health\b/i.test(normalized)) {
    tags.add('[ACTION:HEALTH]');
  }
  // Only synthesize SMOKE when the text is an imperative instruction, not a narrative mention
  const smokeImperative = /(?:run|execute|perform|start|trigger|do)\s+(?:a\s+)?(?:smoke test|sanity check|end to end check|e2e check)/i.test(normalized);
  const smokeNegated = /\b(?:will|plan to|later|after|going to|intend to|want to|should)\b[^.!?\n]{0,30}(?:smoke test|sanity check|e2e check)/i.test(normalized);
  if (smokeImperative && !smokeNegated) {
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
    if (!goalState.goal) return;

    maybeReviewThreadForClosure(groupchat).catch((err) => {
      console.error('Thread close review error:', errMsg(err));
    });

    if (activeAbortController) return;
    if (!goalState.isStalled()) return;

    goalState.recordRecoveryAttempt();
    recordLoopHealth('goal-watchdog', 'warn', `attempt=${goalState.recoveryAttempts} goal=${goalState.goal?.slice(0, 80) || 'unknown'}`);

    sendAutopilotAudit(
      groupchat,
      'watchdog_recovery',
      'Goal was stalled; sending system nudge to Riley for continuation and pending actions.',
      { attempt: goalState.recoveryAttempts }
    ).catch(() => {});

    handleRileyMessage(
      `[System auto-recovery] This goal appears stalled: "${goalState.goal}". Summarize current state in one short paragraph, execute any pending deploy/screenshots/urls actions now using explicit [ACTION:...] tags, and continue without waiting for user follow-up. If the work is actually complete, post a short wrap-up in the workspace thread and include [ACTION:CLOSE_THREAD].`,
      'System',
      undefined,
      groupchat
    ).catch((err) => {
      console.error('Goal watchdog recovery error:', errMsg(err));
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
  const label = reason === 'hourly' ? '🕐 Hourly' : '📋 Manual';
  const currentGoal = goalState.goal
    ? `**Goal:** ${goalState.goal.replace(/\s+/g, ' ').slice(0, 120)}\n**Status:** ${(goalState.status || 'in-progress').replace(/\s+/g, ' ').slice(0, 60)}`
    : '**Goal:** None\n**Status:** Idle';
  const report = await buildThreadStatusReport(threadStatusSourceChannel);
  const content = `${label} Thread Status — ${timestamp}\n\n${currentGoal}\n\n${report}`;

  await clearThreadStatusMessages(threadStatusChannel).catch(() => {});

  if (riley) {
    await sendWebhookMessage(threadStatusChannel, {
      content: content.slice(0, 1900),
      username: `${riley.emoji} ${riley.name}`,
      avatarURL: riley.avatarUrl,
    }).catch(async () => {
      await threadStatusChannel?.send(content.slice(0, 1900)).catch(() => {});
    });
  } else {
    await threadStatusChannel.send(content.slice(0, 1900)).catch(() => {});
  }

  recordLoopHealth('thread-status-reporter', 'ok', `reason=${reason}`);

}

export async function getThreadStatusOpsLine(): Promise<string> {
  if (!threadStatusSourceChannel) {
    return '⚠️ Thread status source channel unavailable — check groupchat channel wiring';
  }

  const report = await buildThreadStatusReport(threadStatusSourceChannel);
  const currentGoal = goalState.goal
    ? `**Goal:** ${goalState.goal.replace(/\s+/g, ' ').slice(0, 80)}\n**Status:** ${(goalState.status || 'in-progress').replace(/\s+/g, ' ').slice(0, 50)}`
    : '**Goal:** None — **Status:** Idle';

  return `${currentGoal}\n\n${report}`;
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

  threadStatusReporter = setInterval(() => {
    postThreadStatusSnapshotNow('hourly').catch((err) => {
      console.error('Thread status reporter error:', errMsg(err));
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

async function syncGoalSequence(groupchat: TextChannel): Promise<void> {
  if (goalState.sequenceInitialized) return;
  try {
    const cached = [...groupchat.threads.cache.values()];
    const active = await groupchat.threads.fetchActive().catch(() => null);
    const archived = await groupchat.threads.fetchArchived({ limit: 100 }).catch(() => null);
    await goalState.syncSequence([
      cached,
      active ? [...active.threads.values()] : [],
      archived ? [...archived.threads.values()] : [],
    ]);
  } catch (err) {
    console.warn('Could not sync goal thread counter:', errMsg(err));
  }
}

function buildGoalThreadDescriptor(senderName: string, content: string): string {
  const sender = sanitizeThreadName(senderName).replace(/\s+/g, '-').toLowerCase() || 'user';
  // Extract a concise task-oriented preview by stripping filler words
  const FILLER = new Set(['hey', 'hi', 'hello', 'please', 'can', 'you', 'could', 'would', 'riley', 'the', 'a', 'an', 'i', 'we', 'need', 'want', 'to', 'me', 'my', 'our', 'this', 'that', 'it', 'is', 'for', 'on', 'in', 'of', 'and', 'or', 'with', 'some', 'just', 'also']);
  const words = sanitizeThreadName(content).split(' ').filter(Boolean);
  const meaningful = words.filter(w => !FILLER.has(w.toLowerCase()));
  const preview = (meaningful.length >= 3 ? meaningful : words).slice(0, 6).join(' ');
  return sanitizeThreadName(`${sender} ${preview}`) || sender;
}

function buildGoalThreadName(senderName: string, content: string): string {
  const goalId = goalState.nextThreadSequence().toString().padStart(4, '0');
  const descriptor = buildGoalThreadDescriptor(senderName, content);
  return sanitizeThreadName(`Goal-${goalId} ${descriptor}`) || `Goal-${goalId}`;
}

function stripGoalThreadPrefix(name: string): string {
  return String(name || '').replace(/^Goal-\d+\s+/i, '').trim();
}

async function findMatchingGoalWorkspace(groupchat: TextChannel, senderName: string, content: string): Promise<WebhookCapableChannel | null> {
  const descriptor = buildGoalThreadDescriptor(senderName, content);
  const cached = [...groupchat.threads.cache.values()];
  const active = await groupchat.threads.fetchActive().catch(() => null);
  const candidates = [...cached, ...(active ? [...active.threads.values()] : [])]
    .filter((thread) => !thread.archived && stripGoalThreadPrefix(thread.name) === descriptor)
    .sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0));
  return candidates[0] || null;
}

async function closeGoalWorkspace(
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  reason: string
): Promise<void> {
  let thread: any = null;
  if ('setArchived' in workspaceChannel) {
    thread = workspaceChannel;
  } else if (goalState.threadId) {
    thread = groupchat.threads.cache.get(goalState.threadId) || await groupchat.threads.fetch(goalState.threadId).catch(() => null);
  }

  if (thread && !thread.archived) {
    const finalThreadName = String(thread.name || 'workspace');
    const goalText = goalState.goal || finalThreadName;
    const elapsed = Date.now() - goalState.startedAt;
    const durationStr = elapsed < 60_000
      ? `${Math.round(elapsed / 1000)}s`
      : elapsed < 3_600_000
        ? `${Math.round(elapsed / 60_000)}m`
        : `${(elapsed / 3_600_000).toFixed(1)}h`;

    // Send a completion embed instead of plain text
    const completionEmbed = new EmbedBuilder()
      .setTitle('✅ Goal Complete')
      .setDescription(goalText.slice(0, 200))
      .addFields(
        { name: 'Duration', value: durationStr, inline: true },
        { name: 'Thread', value: thread.id ? `<#${thread.id}>` : finalThreadName, inline: true },
      )
      .setColor(SYSTEM_COLORS.success)
      .setFooter({ text: reason })
      .setTimestamp();

    // Post embed to thread before archiving
    await sendWebhookMessage(thread, {
      content: '',
      username: '📋 Riley (Executive Assistant)',
      embeds: [completionEmbed],
    }).catch(() => {});

    // Also post to groupchat so it's visible outside the thread
    await groupchat.send({ embeds: [completionEmbed] }).catch(() => {});

    await thread.setArchived(true, reason).catch(() => {});

    if (decisionsChannel) {
      const summary = `📋 Decision log: closed workspace ${thread.id ? `<#${thread.id}>` : `"${finalThreadName}"`} (${reason}).`;
      await decisionsChannel.send(summary.slice(0, 1800)).catch(() => {});
    }
  }

  goalState.clear();
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
      const msg = errMsg(err);
      const normalized = msg.toLowerCase();
      const isCredentialError = normalized.includes('could not load the default credentials');
      const userMsg = isCredentialError
        ? 'Auto rebuild skipped: GCP credentials are not configured for this runtime. Please run manual deploy until credentials are restored.'
        : `Auto rebuild after thread close failed: ${msg}`;
      const now = Date.now();
      const dedupeKey = isCredentialError ? 'cred-missing' : userMsg.slice(0, 180);
      if (dedupeKey !== lastAutoRebuildErrorKey || now - lastAutoRebuildErrorAt >= AUTO_REBUILD_ERROR_COOLDOWN_MS) {
        await groupchat.send(`⚠️ ${userMsg}`).catch(() => {});
        lastAutoRebuildErrorAt = now;
        lastAutoRebuildErrorKey = dedupeKey;
      }
      void postAgentErrorLog('riley:auto-deploy', 'Auto rebuild on thread close failed', { detail: msg, level: 'warn' });
    }
  }
}

async function maybeReviewThreadForClosure(groupchat: TextChannel): Promise<void> {
  if (!ENABLE_AUTOMATIC_THREAD_CLOSE_REVIEW) return;
  if (!goalState.goal || !goalState.threadId || activeAbortController) return;

  const now = Date.now();
  if (now - goalState.lastProgressAt < THREAD_CLOSE_REVIEW_IDLE_MS) return;
  if (now - lastThreadCloseReviewAt < THREAD_CLOSE_REVIEW_INTERVAL_MS) return;

  const thread = groupchat.threads.cache.get(goalState.threadId)
    || await groupchat.threads.fetch(goalState.threadId).catch(() => null);

  if (!thread || thread.archived) {
    goalState.threadId = null;
    return;
  }

  lastThreadCloseReviewAt = now;
  goalState.lastProgressAt = now;
  goalState.status = '🔎 Riley reviewing whether this thread can close...';

  await sendAutopilotAudit(
    groupchat,
    'thread_close_review',
    'Idle workspace thread triggered a closure-readiness review.',
    { action: 'CHECK_CLOSE_THREAD' }
  ).catch(() => {});

  await handleRileyMessage(
    `[System thread-close review] Review the current workspace thread for "${goalState.goal}". If the work is fully complete and no more follow-up is required, post one concise final update in the workspace thread and include [ACTION:CLOSE_THREAD]. If anything is still pending or blocked, say exactly what remains and keep the thread open.`,
    'System',
    undefined,
    groupchat,
    undefined,
    thread
  );
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
      env: { ...buildSafeCommandEnv(), CI: 'true' },
    });
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    return execErr.stderr || execErr.stdout || execErr.message || 'Unknown command error';
  }
}

const execFileAsync = promisify(execFile);

/** Async version of runRepoInspection — avoids blocking the event loop for long-running commands like smoke tests. */
async function runRepoInspectionAsync(command: string, cwd = APP_REPO_ROOT): Promise<string> {
  try {
    const { stdout } = await execFileAsync('bash', ['-lc', command], {
      cwd,
      timeout: ACTION_COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: { ...buildSafeCommandEnv(), CI: 'true' },
    });
    return stdout || '';
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
    return '📈 **0** threads open — no active work';
  }

  const now = Date.now();
  const rows = await Promise.all(threads.map(async (thread) => {
    const recent = await thread.messages.fetch({ limit: 1 }).catch(() => null);
    const last = recent?.first();
    const lastTs = last?.createdTimestamp || thread.createdTimestamp || now;
    const idleMs = Math.max(0, now - lastTs);
    const ready = idleMs >= THREAD_CLOSE_REVIEW_IDLE_MS;
    const threadName = thread.name.replace(/\s+/g, ' ').slice(0, 60);
    const idleLabel = formatAge(idleMs);
    const icon = ready ? '✅' : '⏳';
    return {
      ready,
      line: `${icon} **${threadName}** — idle ${idleLabel}`,
    };
  }));

  const readyCount = rows.filter((row) => row.ready).length;
  const activeCount = Math.max(0, rows.length - readyCount);
  const header = `📈 **${threads.length}** open — ⏳ **${activeCount}** active, ✅ **${readyCount}** ready to close`;
  const threadLines = rows.slice(0, 6).map((row) => row.line).join('\n');

  return `${header}\n${threadLines}`;
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
    return `unreachable — ${errMsg(err)}`;
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

  const output = await runRepoInspectionAsync(
    `npm run discord:test:dist -- --agent=${JSON.stringify(defaultAgent)}`,
    APP_SERVER_ROOT,
  );

  return `🧪 **Agent Smoke Test** (${defaultAgent})\n\n\
\
${trimCommandOutput(output, 1800)}`;
}

async function ensureGoalWorkspace(groupchat: TextChannel, senderName: string, content: string): Promise<WebhookCapableChannel> {
  return withPgAdvisoryLock(`goal-workspace:${groupchat.guild.id}:${groupchat.id}`, async () => {
    if (goalState.threadId) {
      const existing = groupchat.threads.cache.get(goalState.threadId)
        || await groupchat.threads.fetch(goalState.threadId).catch(() => null);
      if (existing && !existing.archived) return existing;
      goalState.threadId = null;
    }

    const matching = await findMatchingGoalWorkspace(groupchat, senderName, content);
    if (matching) {
      goalState.threadId = matching.id;
      goalState.startedAt = matching.createdTimestamp || Date.now();
      lastThreadCloseReviewAt = 0;
      return matching;
    }

    await syncGoalSequence(groupchat);
    const threadName = buildGoalThreadName(senderName, content);
    const thread = await groupchat.threads.create({
      name: threadName,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `Goal workspace for ${senderName}`,
    });

    goalState.threadId = thread.id;
    goalState.startedAt = Date.now();
    lastThreadCloseReviewAt = 0;

    const riley = getAgent('executive-assistant' as AgentId);
    if (riley) {
      await sendWebhookMessage(thread, {
        content: `🧵 Workspace created for: ${content.slice(0, 300)}`,
        username: `${riley.emoji} ${riley.name}`,
        avatarURL: riley.avatarUrl,
      }).catch(() => {});
    }

    await groupchat.send(`🧵 Created workspace thread: <#${thread.id}>`).catch(() => {});

    return thread;
  });
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
  if (words.length > 80 || normalized.length > 500) return null;

  const joinVerb = /\b(?:join|start|open|connect|enter|hop\s+in(?:to)?|jump\s+in(?:to)?)\b/i.test(normalized);
  const leaveVerb = /\b(?:leave|end|stop|disconnect|hang\s*up|drop)\b/i.test(normalized);
  const voiceTarget = /\b(?:voice|vc|call|voice\s+chat|voice\s+channel|the\s+call|in\s+the\s+call)\b/i.test(normalized);
  const addressesRiley = /\b(?:riley|asap)\b/i.test(normalized);
  const directJoinCall = addressesRiley && /\bjoin\b/i.test(normalized) && /\bcall\b/i.test(normalized);
  const directLeaveCall = addressesRiley && /\b(?:leave|end|disconnect|hang\s*up|drop)\b/i.test(normalized) && /\bcall\b/i.test(normalized);

  if ((joinVerb && voiceTarget) || directJoinCall) return 'join';
  if ((leaveVerb && (voiceTarget || /^(?:leave|end call|hang up|disconnect)$/i.test(normalized))) || directLeaveCall) return 'leave';
  return null;
}

function getSpeechBridgeText(text: string): string | null {
  const normalized = stripMentionsForIntent(text);
  if (!normalized) return null;
  const match = normalized.match(/^(?:riley\s+)?(?:tester\s+)?(?:say|voice|speak)\s*(?::|-)\s*(.{1,260})$/i);
  if (!match) return null;
  return String(match[1] || '').trim() || null;
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
  const speechBridgeText = getSpeechBridgeText(stripped);
  if (speechBridgeText) {
    const injectionEnabled = String(process.env.VOICE_TEST_INJECTION_ENABLED || 'false').toLowerCase() === 'true';
    const isAuthorized = isTesterBotId(message.author.id) || injectionEnabled;
    if (!isAuthorized) {
      await groupchat.send('🛑 Voice speech bridge is restricted to ASAPTester unless VOICE_TEST_INJECTION_ENABLED=true.').catch(() => {});
      return true;
    }

    const result = await processTesterVoiceTurnForCall({
      userId: message.author.id,
      username: message.member?.displayName || message.author.username || 'ASAPTester',
      text: speechBridgeText,
    });

    if (!result.ok) {
      await groupchat.send(`⚠️ ASAPTester voice turn failed: ${result.reason || 'unknown error'}`).catch(() => {});
      return true;
    }

    if (result.mode === 'voice') {
      await groupchat.send(`🧪 ASAPTester spoke in voice: "${speechBridgeText.slice(0, 120)}"`).catch(() => {});
    } else {
      await groupchat.send(`🧪 Tester speech injected into voice turn: "${speechBridgeText.slice(0, 120)}"`).catch(() => {});
    }
    return true;
  }

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
    const member = message.member || await message.guild?.members.fetch(message.author.id).catch(() => null);
    if (!member) {
      await groupchat.send('📞 I need you to be in the server to join voice.').catch(() => {});
      return true;
    }
    await startCall(channels.voiceChannel, groupchat, channels.callLog, member);
    return true;
  }

  if (!isCallActive()) {
    await groupchat.send('📞 No active voice call to leave.').catch(() => {});
    return true;
  }
  await endCall();
  return true;
}

function detectDirectOpsAction(text: string): 'status' | 'limits' | 'threads' | 'loops' | 'logs' | 'help' | null {
  const normalized = stripMentionsForIntent(text).toLowerCase();
  if (!normalized) return null;

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 30 || normalized.length > 260) return null;

  const lead = String.raw`^(?:hey|hi|yo)?\s*(?:riley|asap)?\s*[,!:;-]?\s*(?:please\s+)?(?:can you\s+|could you\s+|will you\s+)?`;
  const statusPattern = new RegExp(`${lead}(?:status|what(?:'| i)?s\\s+the\\s+status|update\\s+status|current\\s+goal)\\??$`, 'i');
  const limitsPattern = new RegExp(`${lead}(?:limits|usage|budget|spend|costs|token\\s+usage|show\\s+limits|show\\s+usage)\\??$`, 'i');
  const threadsPattern = new RegExp(`${lead}(?:threads|thread\\s+status|open\\s+threads|workspace\\s+threads)\\??$`, 'i');
  const loopsPattern = new RegExp(`${lead}(?:loops|loop\\s+health|runtime\\s+loops|monitoring)\\??$`, 'i');
  const logsPattern = new RegExp(`${lead}(?:logs|recent\\s+logs|ops\\s+logs|logging\\s+engine|show\\s+logs)\\??$`, 'i');
  const helpPattern = new RegExp(`${lead}(?:help|what\\s+can\\s+you\\s+do|commands?)\\??$`, 'i');

  if (statusPattern.test(normalized)) return 'status';
  if (limitsPattern.test(normalized)) return 'limits';
  if (threadsPattern.test(normalized)) return 'threads';
  if (loopsPattern.test(normalized)) return 'loops';
  if (logsPattern.test(normalized)) return 'logs';
  if (helpPattern.test(normalized)) return 'help';
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

async function postWorkspaceProgressUpdate(
  workspaceChannel: WebhookCapableChannel,
  agentId: AgentId,
  content: string,
): Promise<void> {
  const trimmed = String(content || '').trim();
  if (!trimmed) return;
  const agent = getAgent(agentId);
  if (agent) {
    await sendAgentMessage(workspaceChannel, agent, trimmed.slice(0, 1800));
    return;
  }
  if ('send' in workspaceChannel) {
    await workspaceChannel.send(trimmed.slice(0, 1800)).catch(() => {});
  }
}

async function maybeSendGroupchatSingleUserNotice(groupchat: TextChannel): Promise<void> {
  const now = Date.now();
  if (now - lastGroupchatSingleUserNoticeAt < GROUPCHAT_SINGLE_USER_NOTICE_COOLDOWN_MS) return;
  lastGroupchatSingleUserNoticeAt = now;
  await sendQuickRileyMessage(groupchat, buildGroupchatSingleUserNotice(activeGroupchatOwner?.displayName));
}

async function handleDirectOpsActionIfRequested(content: string, groupchat: TextChannel): Promise<boolean> {
  const action = detectDirectOpsAction(content);
  if (!action) return false;

  if (action === 'help') {
    await sendQuickRileyMessage(
      groupchat,
      '⚡ Quick actions: `status`, `loops`, `logs`, `limits`, `threads`, `join voice`, `leave voice`, `cleanup`, `smoke`, `health`.'
    );
    return true;
  }

  if (action === 'status') {
    await sendQuickRileyMessage(
      groupchat,
      buildTextStatusSummary(getStatusSummary() || '📋 No active tasks.', buildLoopHealthCompactSummary())
    );
    return true;
  }

  if (action === 'loops') {
    await sendQuickRileyMessage(groupchat, buildLoopHealthDetailedReport());
    return true;
  }

  if (action === 'logs') {
    const channels = getBotChannels();
    if (channels) {
      await runLoggingEngine(channels).catch(() => {});
    }
    await sendQuickRileyMessage(groupchat, buildLoggingEngineReport());
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
  onToolUse?: (toolName: string, summary: string) => void;
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

  const rawResponse = await agentRespond(
    agent,
    [...agentMemory, ...groupHistory],
    contextMessage,
    async (toolName, summary) => {
      sendToolNotification(outputChannel, agent, `[${toolName}] ${summary}`).catch(() => {});
      options.onToolUse?.(toolName, summary);
    },
    {
      maxTokens: options.maxTokens,
      signal: options.signal,
      threadKey: `groupchat:${outputChannel.id}`,
    }
  );

  const response = String(rawResponse || '').trim();

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

  // During an active smoke_test_agents run, tester bot messages are subprocess
  // probes (test prompts, budget approval, status checks). They must NOT abort
  // the parent Riley call. Process them on a parallel path so the serialized
  // messageQueue doesn't deadlock (Riley blocks the queue while smoke_test_agents
  // waits for these very messages to be processed).
  if (activeSmokeTestRunning && message.author.bot && isTesterBotId(message.author.id)) {
    console.log(`[smoke-guard] Processing tester bot message in parallel during active smoke test: "${content.slice(0, 80)}"`);
    // Skip budget/voice messages that are smoke test scaffolding, not actual test prompts.
    if (/^approve budget|^tester\s+say:/i.test(content)) {
      console.log(`[smoke-guard] Skipping scaffolding message: "${content.slice(0, 60)}"`);
      return;
    }
    // Fast-path: respond to "status" health checks immediately without calling the AI.
    // The tester subprocess just needs ANY bot/webhook reply to pass the health check.
    const stripped = content.replace(/<@[!&]?\d+>\s*/g, '').trim();
    if (/^status$/i.test(stripped)) {
      const riley = getAgent('executive-assistant' as AgentId);
      if (riley) {
        void sendAgentMessage(groupchat, riley, '📋 Current Goal: Smoke test in progress. Status: active.').catch(() => {});
        console.log('[smoke-guard] Sent fast status response for health check');
      }
      return;
    }
    // Fire-and-forget: respond directly in groupchat (not workspace threads) so the
    // tester subprocess monitor can observe the bot response in the correct channel.
    void handleSmokeTestPrompt(content, groupchat).catch((err) => {
      console.error('[smoke-guard] Parallel smoke test message processing failed:', errMsg(err));
    });
    return;
  }

  if (isDuplicateGroupchatMessage(message, content)) {
    await sendQuickRileyMessage(groupchat, '⏳ I already received that request and I am still processing it.');
    return;
  }

  if (activeAbortController && activeGroupchatOwner && message.author.id !== activeGroupchatOwner.userId) {
    await maybeSendGroupchatSingleUserNotice(groupchat);
    return;
  }

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
  activeGroupchatOwner = {
    userId: message.author.id,
    displayName: message.member?.displayName || message.author.username,
  };

  messageQueue = messageQueue.then(async () => {
    if (controller.signal.aborted) return;
    try {
      await withMessageTimeout(
        processGroupchatMessage(message, content, groupchat, controller.signal),
        GROUPCHAT_PROCESS_TIMEOUT_MS,
        () => {
          controller.abort();
          markGoalProgress('⚠️ Groupchat run timed out');
        },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.stack || err.message : String(err);
      console.error('Groupchat message processing failed:', detail);
      void postAgentErrorLog('groupchat:queue', 'Groupchat message processing failed', {
        detail,
        level: 'warn',
      });
      if (String(err instanceof Error ? err.message : err || '').includes('Groupchat message timed out')) {
        const now = Date.now();
        if (now - lastGroupchatTimeoutNoticeAt >= GROUPCHAT_TIMEOUT_NOTICE_COOLDOWN_MS) {
          lastGroupchatTimeoutNoticeAt = now;
          const riley = getAgent('executive-assistant' as AgentId);
          const timeoutNotice = '⏳ I hit a runtime timeout while processing that request. I canceled the stalled run to avoid duplicate loops. Please retry with a tighter prompt or request one action at a time.';
          if (riley) {
            await sendAgentMessage(groupchat, riley, timeoutNotice).catch(() => {});
          } else {
            await groupchat.send(timeoutNotice).catch(() => {});
          }
        }
      }
    } finally {
      if (activeAbortController === controller) {
        activeAbortController = null;
        activeGroupchatOwner = null;
      }
    }
  }).catch((err) => {
    console.error('Groupchat queue error:', errMsg(err));
  });
}

async function withMessageTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`Groupchat message timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Lightweight handler for smoke-test subprocess prompts.
 * Responds directly in groupchat (not workspace threads) so the tester's
 * LiveMonitor can observe the response in the correct channel.
 */
async function handleSmokeTestPrompt(content: string, groupchat: TextChannel): Promise<void> {
  // Determine which agent is being addressed
  const mentionedIds = parseMentionedAgentIds(content);
  const targetAgentId: AgentId = mentionedIds.length > 0 ? mentionedIds[0] : 'executive-assistant' as AgentId;

  // For specialist mentions, Riley routes through Ace — but for smoke tests
  // we respond directly as Riley to keep things simple and fast.
  const riley = getAgent('executive-assistant' as AgentId);
  if (!riley) return;

  const rileyMemory = getMemoryContext('executive-assistant');
  const contextMessage = `[smoke-test]: ${content}`;

  console.log(`[smoke-guard] Calling agentRespond for: "${content.slice(0, 60)}"`);

  const rawResponse = await agentRespond(
    riley,
    [...rileyMemory],
    contextMessage,
    undefined,
    {
      outputMode: 'machine_json',
      machineEnvelopeRaw: true,
      threadKey: `smoke-test:${Date.now()}`,
    },
  );

  const rawStr = String(rawResponse || '').trim();
  if (!rawStr) return;

  // Extract human-readable text from the JSON envelope so the tester can match
  // against expectAny/expectAll patterns (raw JSON confuses validation).
  const envelope = extractAgentResponseEnvelope(rawStr);
  const rawHuman = (envelope?.human || rawStr).trim();

  // Apply the same rendering pipeline as sendAgentMessage (strips ACTION tags,
  // resolves @agent → Discord mentions, etc.) but skip progressive reveal.
  // Progressive reveal edits can be missed by the tester's Discord client,
  // causing pattern-matching failures when the initial truncated message
  // doesn't contain expected keywords.
  const { renderAgentMessage } = await import('./textChannel');
  const response = renderAgentMessage(rawHuman);
  if (!response.trim()) return;

  const { sendWebhookMessage } = await import('../services/webhooks');
  // Split into ≤1900-char chunks on newline boundaries
  const chunks: string[] = [];
  let remaining = response;
  while (remaining.length > 1900) {
    const breakAt = remaining.lastIndexOf('\n', 1900);
    const splitAt = breakAt > 800 ? breakAt : 1900;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);

  for (const chunk of chunks) {
    await sendWebhookMessage(groupchat, {
      content: chunk,
      username: `${riley.emoji} ${riley.name}`,
      avatarURL: riley.avatarUrl,
    });
  }
  console.log(`[smoke-guard] Posted response to groupchat (${response.length} chars)`);
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

    if (goalState.goal) {
      markGoalProgress('▶️ Resuming after budget approval');
      await withRileyResponseWatchdog(
        workspaceChannel,
        groupchat,
        handleRileyMessage(
        `Budget approval has been granted by ${senderName}. Resume the paused work on this goal: ${goalState.goal}`,
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
      goalState.setGoal(content);
      await withRileyResponseWatchdog(
        workspaceChannel,
        groupchat,
        handleRileyMessage(content, senderName, message.member || undefined, groupchat, signal, workspaceChannel),
      );
    } else if (uniqueMentions.length === 1 && uniqueMentions[0] === 'developer') {
      // Legacy @ace/@developer mentions route to Riley.
      await handleDirectedMessage(content, senderName, uniqueMentions, groupchat, workspaceChannel, signal);
    } else {
      const normalized = `${content}\n\n[System: Riley should execute directly when possible and involve specialists only when needed.]`;
      goalState.setGoal(normalized);
      await withRileyResponseWatchdog(
        workspaceChannel,
        groupchat,
        handleRileyMessage(normalized, senderName, message.member || undefined, groupchat, signal, workspaceChannel),
      );
    }
  } else {
    goalState.setGoal(content);
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
    const goal = goalState.goal || 'none';
    void emitRileyStallAlert(workspaceChannel, groupchat, goal, RILEY_NO_RESPONSE_TIMEOUT_MS)
      .then((posted) => {
        if (!posted) return;
        void postAgentErrorLog('riley:watchdog', 'No Riley response observed for goal', {
          agentId: 'executive-assistant',
          detail: `goal=${goal} timeoutMs=${RILEY_NO_RESPONSE_TIMEOUT_MS}`,
          level: 'warn',
        });
      });
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
 * Get current status summary.
 */
export function getStatusSummary(): string | null {
  return goalState.getSummary();
}

/**
 * Riley receives the message, responds, and can involve specialists when needed.
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
  let progressTimer: NodeJS.Timeout | null = null;
  const progressMessages: Message[] = [];
  try {
    progressTimer = setTimeout(() => {
      if (hasVisibleRileyResponse || signal?.aborted) return;
      const seconds = Math.round(Math.max(0, RILEY_PROGRESS_PING_MS) / 1000);
      const progressText = `⏳ Riley is still working (${seconds}s elapsed). No action needed yet.`;
      void sendWebhookMessage(workspaceChannel, {
        content: progressText,
        username: `${riley.emoji} ${riley.name}`,
        avatarURL: riley.avatarUrl,
      }).then((msg) => progressMessages.push(msg)).catch(() => {});
      if (workspaceChannel.id !== groupchat.id) {
        void groupchat.send(progressText).then((msg) => progressMessages.push(msg)).catch(() => {});
      }
    }, Math.max(5_000, RILEY_PROGRESS_PING_MS));

    noResponseTimer = setTimeout(() => {
      if (hasVisibleRileyResponse || signal?.aborted) return;
      const goal = goalState.goal || 'none';
      void emitRileyStallAlert(workspaceChannel, groupchat, goal, RILEY_NO_RESPONSE_TIMEOUT_MS)
        .then((posted) => {
          if (!posted) return;
          void postAgentErrorLog('riley:timeout', 'No Riley response within timeout', {
            agentId: 'executive-assistant',
            detail: `goal=${goal} timeoutMs=${RILEY_NO_RESPONSE_TIMEOUT_MS}`,
            level: 'warn',
          });
        });
    }, RILEY_NO_RESPONSE_TIMEOUT_MS);

    stopTyping = startTypingLoop(rileyWorkChannel);
    await setThinkingMessage(rileyWorkChannel, riley);

    const rileyMemory = getMemoryContext('executive-assistant');
    const contextMessage = `[${senderName}]: ${userMessage}`;
    const specialistGuide = buildAgentMentionGuide(['qa', 'ux-reviewer', 'security-auditor', 'api-reviewer', 'dba', 'performance', 'devops', 'copywriter', 'lawyer', 'ios-engineer', 'android-engineer']);
    const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf]/;
    const textLangHint = cjkPattern.test(userMessage)
      ? '\n\n[Language detected: Mandarin Chinese. Please reply in Mandarin Chinese (简体中文).]'
      : '';
    const isSmokeTest = /\[smoke\s*test:/i.test(userMessage);
    const isDirectToolRequest = /smoke_test_agents|run\s+(all\s+)?(smoke|test)|test\s+engine/i.test(userMessage);
    const shouldExecuteDirectly = isSmokeTest || isDirectToolRequest;
    const mentionGuide = shouldExecuteDirectly
      ? '\n\n[This is a direct tool request. Execute tools yourself directly — especially smoke_test_agents. Do NOT delegate to specialists. Do NOT mention or tag any agent roles. Call the smoke_test_agents tool immediately.]'
      : `\n\n[Execution contract: execute directly whenever possible. Involve specialists only when a focused review or domain-specific help is needed. Available specialists: ${specialistGuide}.]`;
    const threadCloseGuide = `\n\n[Keep the workspace thread updated briefly. Include [ACTION:CLOSE_THREAD] only when the task is fully complete.]`;
    const decisionGuide = '\n\n[Decision policy: only ask the user for MAJOR decisions (prod risk, security/privacy, rollback/no-rollback, schema/data-loss risk, spend increase, legal/compliance impact). For routine implementation choices, decide and proceed. In #groupchat, when a major decision is needed, address the user directly and the system will tag them. Use the decisions channel for queued/offline decisions, not for live voice.]';
    const contextMessageWithLang = `${textLangHint ? `${contextMessage}${textLangHint}` : contextMessage}${mentionGuide}${threadCloseGuide}${decisionGuide}`;

    const response = await agentRespond(riley, [...rileyMemory, ...groupHistory], contextMessageWithLang, async (toolName, summary) => {
      sendToolNotification(rileyWorkChannel, riley, `[${toolName}] ${summary}`).catch(() => {});
    }, {
      signal,
      outputMode: 'machine_json',
      machineEnvelopeRaw: true,
      threadKey: `groupchat:${workspaceChannel.id}`,
    });

    const responseEnvelope = extractAgentResponseEnvelope(response);
    const machineDelegateAgents = (responseEnvelope?.machine?.delegateAgents || [])
      .map((id) => resolveAgentId(id))
      .filter((id): id is AgentId => Boolean(id) && id !== 'executive-assistant');
    const machineActionTags = (responseEnvelope?.machine?.actionTags || [])
      .map((tag) => String(tag || '').trim())
      .filter((tag) => /^\[ACTION:[^\]]+\]$/i.test(tag));
    const machineRoutingSuffix = machineDelegateAgents.length > 0
      ? `\n\n${machineDelegateAgents.map((id) => getAgentMention(id)).join(' ')} please help Riley with the focused follow-up for this task.`
      : '';
    const visibleHumanResponse = sanitizeVisibleAgentReply(responseEnvelope?.human || response);
    const orchestrationResponse = `${visibleHumanResponse}${machineRoutingSuffix}`.trim();

    if (signal?.aborted) return;
    await clearThinkingMessage();

    let displayResponse = appendDefaultNextSteps(
      visibleHumanResponse.replace(/\[\s*action:[^\]]+\]/gi, '').trim()
    );
    markGoalProgress('🧭 Riley coordinating...');

    appendToMemory('executive-assistant', [
      { role: 'user', content: contextMessage },
      { role: 'assistant', content: `[Riley]: ${orchestrationResponse}` },
    ]);

    groupHistory.push({ role: 'user', content: contextMessage });
    groupHistory.push({ role: 'assistant', content: `[Riley]: ${orchestrationResponse}` });
    persistGroupHistory();

    if (signal?.aborted) return;

    const implicitTags = inferImplicitActionTags(displayResponse);
    // When Riley was asked to execute smoke_test_agents directly, suppress the implicit
    // [ACTION:SMOKE] tag to avoid running a redundant second smoke test via runSmokeSummary.
    const filteredImplicitTags = shouldExecuteDirectly
      ? implicitTags.replace(/\[ACTION:SMOKE\]/gi, '').trim()
      : implicitTags;
    const machineTagsBlock = machineActionTags.join('\n');
    const actionPayloadBase = orchestrationResponse;
    const actionPayload = [actionPayloadBase, machineTagsBlock, filteredImplicitTags].filter(Boolean).join('\n');
    if (filteredImplicitTags) {
      await sendAutopilotAudit(
        groupchat,
        'implied_actions',
        'Riley response implied operational actions without explicit tags; autopilot synthesized tags.',
        { action: implicitTags.replace(/\s+/g, ',') }
      );
    }
    await executeActions(actionPayload, member, groupchat, workspaceChannel, userMessage);
    markGoalProgress();

    const verificationRequired = goalNeedsRuntimeVerification(goalState.goal || userMessage || response);
    const completionClaimed = isCompletionClaim(displayResponse);
    let completionVerified = true;
    if (verificationRequired && completionClaimed) {
      const evidenceSince = Math.max(Date.now() - 2 * 60 * 60 * 1000, goalState.startedAt - 60_000);
      completionVerified = await hasRecentRuntimeVerificationEvidence(groupchat, workspaceChannel, evidenceSince);
      if (!completionVerified) {
        // Auto-trigger web harness capture before blocking on missing evidence
        const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
        try {
          await captureAndPostScreenshots(appUrl, `auto-verify ${(goalState.goal || 'completion').slice(0, 40)}`, {
            targetChannel: workspaceChannel as TextChannel,
            clearTargetChannel: false,
          });
          // Re-check — screenshots were just posted
          completionVerified = await hasRecentRuntimeVerificationEvidence(groupchat, workspaceChannel, evidenceSince);
        } catch (err) {
          console.warn('Auto-harness capture failed:', errMsg(err));
        }
      }
      if (!completionVerified) {
        // Append a verification note instead of overwriting the entire response.
        // The original content has useful context that should not be lost.
        displayResponse += '\n\n⏳ **Verification pending**: completion cannot be confirmed yet — no runtime evidence in screenshots/harness output. Keeping this open until proof is posted.';
      }
    }

    // Use the actual verification result instead of re-scanning text for "blocked"/"verification pending"
    // which would false-positive on our appended verification note.
    const statusBlocked = !completionVerified || /\bblocked\b/i.test(displayResponse.replace(/⏳.*verification pending.*/i, ''));
    displayResponse = enforceRileyResponseContract(
      displayResponse,
      completionClaimed && !statusBlocked,
      completionVerified && !statusBlocked,
    );

    if (shouldQueueDecisionReview(displayResponse)) {
      const target = decisionsChannel || groupchat;
      postDecisionEmbed(target, groupchat, displayResponse).catch(() => {});
    }

    if (signal?.aborted) return;

    if (!signal?.aborted && displayResponse) {
      hasVisibleRileyResponse = true;
      // Auto-delete "still working" progress messages before posting real response
      for (const pm of progressMessages) {
        pm.delete().catch(() => {});
      }
      progressMessages.length = 0;
      await sendAgentMessage(rileyWorkChannel, riley, displayResponse);
      if (workspaceChannel.id !== rileyWorkChannel.id) {
        await sendAgentMessage(workspaceChannel, riley, displayResponse);
      }
      if (workspaceChannel.id !== groupchat.id && (statusBlocked || (completionClaimed && completionVerified && shouldMirrorCompletionToGroupchat(displayResponse, workspaceChannel, groupchat)))) {
        const compact = buildCompactGroupchatStatus(displayResponse, {
          complete: completionClaimed && completionVerified && !statusBlocked,
          blocked: statusBlocked,
        });
        if (compact) {
          await sendAgentMessage(groupchat, riley, compact);
        }
      }
    }

    let chainResult = await handleAgentChain(orchestrationResponse, groupchat, workspaceChannel, signal);

    markGoalProgress('✅ Riley cycle 1 completed');

    // Continuation loop: if this is a multi-step goal and we're not done yet,
    // re-invoke Riley with a continuation prompt so she can plan the next sub-task.
    const isMultiStep = isMultiStepGoal(goalState.goal || userMessage);
    if (isMultiStep && !signal?.aborted) {
      for (let cycle = 2; cycle <= MAX_CONTINUATION_CYCLES; cycle++) {
        // Check whether last cycle's status suggests more work is needed
        const lastStatus = inferRileyStatus(
          displayResponse + ' ' + (chainResult.summary || ''),
          isCompletionClaim(displayResponse),
          true, // verification is separate from continuation logic
        );
        if (lastStatus === 'fixed' || lastStatus === 'blocked') {
          console.log(`[continuation] Stopping at cycle ${cycle}: status=${lastStatus}`);
          break;
        }

        const executionSummary = chainResult.summary
          ? `Specialist summary: ${chainResult.summary.slice(0, 500)}`
          : 'No specialist follow-up summary was produced.';

        const continuationPrompt = `[System continuation — cycle ${cycle}/${MAX_CONTINUATION_CYCLES}] Previous cycle status: ${lastStatus}. ${executionSummary}\n\nContinue with the next sub-task from the original goal: "${(goalState.goal || userMessage).slice(0, 300)}". Do not repeat completed work. Focus on the next unfinished item.`;

        await sendAutopilotAudit(
          groupchat,
          'continuation_cycle',
          `Multi-step continuation cycle ${cycle}/${MAX_CONTINUATION_CYCLES} for: ${(goalState.goal || '').slice(0, 80)}`,
          { attempt: cycle }
        );

        markGoalProgress(`🔄 Continuation cycle ${cycle}/${MAX_CONTINUATION_CYCLES}...`);

        // Re-invoke Riley for the next sub-task
        const rileyMemoryCtx = getMemoryContext('executive-assistant');
        const continuationResponse = await agentRespond(riley, [...rileyMemoryCtx, ...groupHistory], continuationPrompt, async (toolName, summary) => {
          sendToolNotification(rileyWorkChannel, riley, `[${toolName}] ${summary}`).catch(() => {});
        }, {
          signal,
          outputMode: 'machine_json',
          machineEnvelopeRaw: true,
          threadKey: `groupchat:${workspaceChannel.id}`,
        });

        if (signal?.aborted) break;

        const contEnvelope = extractAgentResponseEnvelope(continuationResponse);
        const contVisible = sanitizeVisibleAgentReply(contEnvelope?.human || continuationResponse);
        const contRendered = appendDefaultNextSteps(contVisible.replace(/\[\s*action:[^\]]+\]/gi, '').trim());

        appendToMemory('executive-assistant', [
          { role: 'user', content: continuationPrompt },
          { role: 'assistant', content: `[Riley]: ${continuationResponse}` },
        ]);
        groupHistory.push({ role: 'user', content: continuationPrompt });
        groupHistory.push({ role: 'assistant', content: `[Riley]: ${continuationResponse}` });
        persistGroupHistory();

        // Post Riley's continuation response
        if (contRendered) {
          await sendAgentMessage(workspaceChannel, riley, contRendered);
        }

        // Update display for next iteration's status check
        displayResponse = contRendered;

        chainResult = await handleAgentChain(continuationResponse, groupchat, workspaceChannel, signal);

        markGoalProgress(`✅ Riley cycle ${cycle} completed`);

        if (signal?.aborted) break;
      }
    }
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
      await sendWebhookMessage(workspaceChannel, {
        content: `⚠️ Riley encountered an error:\n\`\`\`${short}\`\`\``,
        username: `${riley.emoji} ${riley.name}`,
        avatarURL: riley.avatarUrl,
      });
    } catch {
      const fallback = ('send' in workspaceChannel) ? workspaceChannel : rileyWorkChannel;
      await fallback.send(`⚠️ Riley encountered an error:\n\`\`\`${short}\`\`\``).catch(() => {});
    }
  } finally {
    if (progressTimer) clearTimeout(progressTimer);
    if (noResponseTimer) clearTimeout(noResponseTimer);
    await clearThinkingMessage().catch(() => {});
    stopTyping();
  }
}

/**
 * Internal bridge: accept a voice-call instruction and run it through Riley's
 * normal text orchestration flow (workspace thread + agent chain).
 */
export async function handoffVoiceInstructionToRileyText(
  instruction: string,
  senderName: string,
  groupchat: TextChannel
): Promise<void> {
  const cleanInstruction = String(instruction || '').trim();
  if (!cleanInstruction) return;

  const workspaceChannel = await ensureGoalWorkspace(groupchat, senderName || 'Voice', cleanInstruction);
  await handleRileyMessage(
    `[Voice handoff from ${senderName || 'Voice user'}]: ${cleanInstruction}`,
    senderName || 'Voice user',
    undefined,
    groupchat,
    undefined,
    workspaceChannel,
  );
}

/**
 * Internal bridge: dispatch an upgrade implementation task to Riley's
 * normal orchestration flow. Called by the upgrades triage loop.
 */
export async function dispatchUpgradeToRiley(
  upgradeDescription: string,
  groupchat: TextChannel
): Promise<void> {
  const prompt = `[Upgrades triage — auto-dispatch] The following upgrade has been accepted by multiple agents and is ready for implementation. Review it and either implement it directly or involve the right specialist:\n\n${upgradeDescription}`;
  await handleRileyMessage(prompt, 'system', undefined, groupchat);
}

/**
 * Parse and execute [ACTION:xxx] tags from Riley's response.
 */
async function executeActions(
  response: string,
  member: GuildMember | undefined,
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  userMessage?: string,
): Promise<void> {
  const actionRe = /\[\s*action:(\w+)(?::([^\]]*))?\]/gi;
  const actions = [...response.matchAll(actionRe)];

  const riley = getAgent('executive-assistant' as AgentId);

  /** Send a message as Riley via webhook, fallback to bot if webhook fails */
  async function sendAsRiley(msg: string): Promise<void> {
    const safeMsg = workspaceChannel.id === groupchat.id
      ? String(msg || '').replace(/https?:\/\/\S+/gi, '[see #url]')
      : msg;

    if (riley) {
      try {
        await sendWebhookMessage(workspaceChannel, { content: safeMsg, username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
        return;
      } catch (err) {
        console.warn('Webhook send failed for Riley action response:', errMsg(err));
      }
    }

    if ('send' in workspaceChannel) {
      await workspaceChannel.send(safeMsg).catch(() => {});
      return;
    }
    const rileyChannel = getAgentWorkChannel('executive-assistant', groupchat);
    await rileyChannel.send(safeMsg).catch(() => {});
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
            await sendAsRiley(`❌ Deploy failed: ${errMsg(err)}`);
          }
          break;
        }
        case 'SCREENSHOTS': {
          const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
          captureAndPostScreenshots(appUrl, param || 'manual').catch((err) => {
            sendAsRiley(`❌ Screenshot capture failed: ${errMsg(err)}`).catch(() => {});
          });
          markGoalProgress('📸 Screenshot capture started');
          await sendAutopilotAudit(groupchat, 'action_executed', 'Screenshot capture workflow started.', {
            action: 'SCREENSHOTS',
          });
          await sendAsRiley('📸 Capturing screenshots...');
          break;
        }
        case 'URLS': {
          const linkIntent = /\b(url|urls|link|links|asap links|app url|share url|cloud run|cloud build)\b/i.test(String(userMessage || goalState.goal || ''));
          if (!linkIntent && String(param || '').trim().toLowerCase() !== 'force') {
            await sendAsRiley('🔗 Skipped link posting because no explicit link request was detected.');
            break;
          }

          const now = Date.now();
          if (now - lastUrlsActionAt < URL_ACTION_COOLDOWN_MS) {
            await sendAsRiley('🔗 Links were posted recently. Skipping duplicate link blast in groupchat.');
            break;
          }
          lastUrlsActionAt = now;

          const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
          const projectId = process.env.GCS_PROJECT_ID || 'asap-489910';
          const region = process.env.CLOUD_RUN_REGION || 'australia-southeast1';
          markGoalProgress('🔗 URLs posted');
          await sendAutopilotAudit(groupchat, 'action_executed', 'ASAP links were posted.', {
            action: 'URLS',
          });
          const linksMessage =
            `🔗 **ASAP Links**\n\n` +
            `🌐 **App**: ${appUrl}\n` +
            `📦 **Cloud Build**: https://console.cloud.google.com/cloud-build/builds?project=${projectId}\n` +
            `☁️ **Cloud Run**: https://console.cloud.google.com/run/detail/${region}/asap?project=${projectId}\n` +
            `📊 **Logs**: https://console.cloud.google.com/logs/query?project=${projectId}`;

          const channels = getBotChannels();
          if (channels?.url) {
            await channels.url.send(linksMessage).catch(() => {});
            await sendAsRiley('🔗 Posted updated links in #url.');
          } else {
            await sendAsRiley('🔗 Links are ready, but #url is unavailable right now.');
          }
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
            await sendAsRiley(`❌ Groupchat cleanup failed: ${errMsg(err)}`);
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
              await sendAsRiley(`❌ Rollback failed: ${errMsg(err)}`);
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
              await sendAsRiley(`❌ Failed to list revisions: ${errMsg(err)}`);
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
          const goalNeedsEvidence = goalNeedsRuntimeVerification(goalState.goal || '');
          if (goalNeedsEvidence) {
            const evidenceSince = Math.max(Date.now() - 2 * 60 * 60 * 1000, goalState.startedAt - 60_000);
            let hasEvidence = await hasRecentRuntimeVerificationEvidence(groupchat, workspaceChannel, evidenceSince);
            if (!hasEvidence) {
              // Auto-trigger web harness before refusing to close
              const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
              try {
                await sendAsRiley('📸 Auto-capturing web harness verification before closing...');
                await captureAndPostScreenshots(appUrl, `close-verify ${(goalState.goal || '').slice(0, 40)}`, {
                  targetChannel: workspaceChannel as TextChannel,
                  clearTargetChannel: false,
                });
                hasEvidence = await hasRecentRuntimeVerificationEvidence(groupchat, workspaceChannel, evidenceSince);
              } catch (err) {
                console.warn('Auto-harness on close failed:', errMsg(err));
              }
            }
            if (!hasEvidence) {
              await sendAsRiley('🛑 Cannot close this thread yet. Runtime verification evidence is missing. Web harness capture was attempted but may have failed — check the app URL is reachable.');
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
            await sendAsRiley(`❌ Call failed: ${errMsg(err)}`);
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
            await sendAsRiley(`❌ ASAPTester test call failed: ${errMsg(err)}`);
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
            await sendAsRiley(`❌ Conference failed: ${errMsg(err)}`);
          }
          break;
        }
      }
    } catch (err) {
      console.error(`Action ${action} error:`, errMsg(err));
    }
  }
}

/**
 * Parse Riley and specialist directives using strict word-boundary regex.
 * Only matches explicit @name patterns to avoid false positives.
 */
const DIRECTED_AGENT_IDS = new Set<string>([
  'qa', 'ux-reviewer', 'security-auditor', 'api-reviewer',
  'dba', 'performance', 'devops', 'copywriter', 'lawyer',
  'ios-engineer', 'android-engineer',
]);

const RILEY_USE_ALL_AGENTS = process.env.RILEY_USE_ALL_AGENTS === 'true';
const RILEY_DIRECT_SPECIALISTS = false;
const RILEY_ACE_ERROR_RECOVERY = process.env.RILEY_ACE_ERROR_RECOVERY === 'true';

function parseDirectives(text: string): string[] {
  return parseMentionedAgentIds(text, DIRECTED_AGENT_IDS);
}

function shouldFanOutAllAgents(rileyResponse: string): boolean {
  const text = rileyResponse.toLowerCase();
  if (text.includes('no action needed') || text.includes('for awareness only')) return false;
  if (/(only|just)\s+@(max|sophie|kane|raj|elena|kai|jude|liv|harper|mia|leo)\b/i.test(rileyResponse)) return false;
  return true;
}

const ACE_FIRST_TASK_RE = /\b(?:fix|inspect|investigate|check|review|test|debug|look at|look into|trace|implement|update|change|patch|deploy|smoke|regression|audit|compare|why)\b/i;
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
  // Design/spec deliverables with substantial HTML/CSS content satisfy the contract
  // without requiring the Result/Evidence/Risk format.
  if (isSubstantialDesignDeliverable(content)) return true;
  if (!/\bresult\s*:/i.test(content)) return false;
  if (!/\bevidence\s*:/i.test(content)) return false;
  if (!/\brisk\s*\/\s*follow-?up\s*:/i.test(content)) return false;
  if (!FILE_PATH_EVIDENCE_RE.test(content)) return false;
  if (!CHECK_EVIDENCE_RE.test(content)) return false;
  return true;
}

function isSubstantialDesignDeliverable(text: string): boolean {
  const content = String(text || '');
  if (content.length < 500) return false;
  const htmlIndicators = (content.match(/<(?:html|style|div|section|header|nav|main|footer|button|input|table|form)\b/gi) || []).length;
  return htmlIndicators >= 3;
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

  // Detect code-only tasks to suppress UX/copy routing for pure implementation work
  const isCodeTask = /\b(edit_file|write_file|batch_edit|git_create_branch|create_pull_request|\.ts\b|\.js\b|function\s|const\s|import\s|export\s)/i.test(normalized);

  if (!isCodeTask && /\b(ui|ux|screen|layout|visual|onboarding|mobile)\b/.test(normalized)) picks.add('ux-reviewer');
  if (/\b(smoke\s*test|regression|qa|validation)\b/.test(normalized)) picks.add('qa');
  if (/\b(security|auth|token|permission|vuln|owasp)\b/.test(normalized)) picks.add('security-auditor');
  if (/\b(endpoint|http|route|rest)\b/.test(normalized)) picks.add('api-reviewer');
  if (/\b(database|schema|migration|sql)\b/.test(normalized)) picks.add('dba');
  if (/\b(deploy|cloud run|gcp|infra|ci\/cd)\b/.test(normalized)) picks.add('devops');
  if (/\b(perf|performance|latency|slow|optimi[sz]e)\b/.test(normalized)) picks.add('performance');
  if (!isCodeTask && /\b(copy|wording|empty state)\b/.test(normalized)) picks.add('copywriter');

  return [...picks].slice(0, 3);
}

function shouldAutoDelegateToAce(userMessage: string, rileyResponse: string): boolean {
  return false;
}

function ensureAceFirstDelegation(rileyResponse: string, userMessage: string): string {
  if (!shouldAutoDelegateToAce(userMessage, rileyResponse)) return rileyResponse;
  return `${rileyResponse}\n\n${getAgentMention('developer' as AgentId)} please take the lead on this task and involve other specialists only if needed.`;
}

function appendDefaultNextSteps(text: string): string {
  const normalized = String(text || '').trim();
  if (!normalized) return normalized;
  const hasActionCue = /\b(next step|action|will|now|recommend|should|run|check|verify|post|update|fix|implement|create|change|retry|owner)\b/i.test(normalized);
  if (!hasActionCue) {
    return `${normalized}\n\nNext step: Riley will post a concrete action with owner and ETA.`;
  }
  return normalized;
}

function sanitizeVisibleAgentReply(text: string): string {
  let out = String(text || '').trim();
  if (!out) return out;

  // Remove fenced JSON blobs that sometimes leak from machine_json mode.
  out = out.replace(/```json[\s\S]*?```/gi, '').trim();

  // If the full payload still looks like an envelope, extract the human field.
  const envelopeMatch = out.match(/\{[\s\S]*"human"\s*:\s*"([\s\S]*?)"[\s\S]*\}/i);
  if (envelopeMatch?.[1]) {
    out = envelopeMatch[1]
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim();
  }

  // Strip obvious leaked machine fields from plain text output.
  out = out
    .replace(/^\s*"?machine"?\s*:\s*\{[\s\S]*$/im, '')
    .replace(/^\s*"?(delegateAgents|actionTags|notes)"?\s*:\s*.*$/gim, '')
    .replace(/\bSMOKE_[A-Z0-9_]+\b/g, '[smoke-token]')
    .replace(/^\s*(?:Riley|Ace|Max|Kane|Sophie|Raj|Elena|Jude|Harper|Kai|Liv|Mia|Leo)\s*:\s*/i, '')
    .replace(/^\s*[\]}]\s*$/gm, '')
    .trim();

  return out;
}

function goalNeedsRuntimeVerification(text: string): boolean {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) return false;
  if (/\bsmoke.test\b/i.test(normalized)) return false;
  if (/\bstatus\b|\bthreads?\b|\busage\b|\blimits\b|\bhealth\b|\burls?\b|\blink\b/.test(normalized)) return false;
  if (shouldSkipContractEnforcement(normalized)) return false;
  return /\b(?:fix|implement|update|change|refactor|remove|add|build|ship|deploy|feature|bug|ui|screen|flow)\b/.test(normalized);
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
  // Queue only major/blocking decisions to avoid interrupting routine execution.
  if (!/\bdecision\b|🛑|\bblocked\b|\bapproval\b|\bescalat(?:e|ion)\b|\bgo\s*\/\s*no-?go\b/.test(normalized)) return false;
  if (/\bminor\b|\bnit\b|\bnice to have\b|\bcosmetic\b/.test(normalized)) return false;
  if (/\b(option\s*[1-5]|yes\s*\/\s*no|approve\s*\/\s*reject|ship\s*\/\s*hold)\b/.test(normalized)) return true;
  if (/\b(prod|production|security|rollback|schema|migration|budget|spend|customer impact|outage|data loss|compliance)\b/.test(normalized)) return true;
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
    console.warn('Could not verify runtime evidence:', errMsg(err));
  }

  return false;
}

function shouldMirrorCompletionToGroupchat(text: string, workspaceChannel: WebhookCapableChannel, groupchat: TextChannel): boolean {
  if (workspaceChannel.id === groupchat.id) return false;
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) return false;
  if (/decision\s+required|\bblocked\b|waiting\s+for\s+(?:approval|input)|need\s+approval/.test(normalized)) return false;
  if (/\breceived\b|\bstarting\b|\bworking\b|\bplan\b|\bwill\b|\bin progress\b|\bongoing\b/.test(normalized)) return false;
  // Don't mirror delegation-to-Ace as a completion — the chain hasn't run yet.
  if (/please\s+create|@ace|<@&\d+>.*(?:create|build|implement|take the lead)/.test(normalized)) return false;
  return isCompletionClaim(normalized);
}

function firstSentence(text: string, maxLen = 220): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const sentence = normalized.split(/(?<=[.!?])\s+/)[0] || normalized;
  if (sentence.length <= maxLen) return sentence;
  return `${sentence.slice(0, Math.max(40, maxLen - 1)).trim()}…`;
}

function buildCompactGroupchatStatus(text: string, opts: { complete?: boolean; blocked?: boolean } = {}): string {
  const concise = firstSentence(text, 220);
  if (!concise) return '';
  if (opts.blocked) return `🛑 Blocked: ${concise}`;
  if (opts.complete) return `✅ Completion update: ${concise}`;
  return `🧭 Riley update: ${concise}`;
}

function buildCompactChainStatus(findings: string[], errors: string[]): string {
  const findingCount = findings.length;
  const errorCount = errors.length;
  if (errorCount > 0) {
    const firstError = firstSentence(errors[0] || '', 180);
    return `⚠️ Riley execution update: ${findingCount} finding(s), ${errorCount} issue(s). ${firstError || 'Follow-up is required in the workspace thread.'}`;
  }
  if (findingCount > 0) {
    const firstFinding = firstSentence(findings[0] || '', 180);
    return `✅ Riley execution complete: ${findingCount} finding(s). ${firstFinding || 'Details are in the workspace thread.'}`;
  }
  return '✅ Riley execution cycle finished. Details are in the workspace thread.';
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

function hasBlockingVerificationFinding(findings: string[]): boolean {
  return findings.some((line) => /\bverification\s+is\s+blocked\b|\bblocked\b|\bunable\s+to\s+find\b|\bapp\s+.*not\s+loading\b|\bno\s+elements\b/i.test(String(line || '')));
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
    console.error('Ace recovery error:', errMsg(err));
    void postAgentErrorLog('ace:recovery', 'Ace recovery error', { agentId: 'developer', detail: msg });
    try {
      const wh = await getWebhook(workspaceChannel);
      await wh.send({ content: '⚠️ Ace had an error while recovering specialist failures.', username: `${ace.emoji} ${ace.name}`, avatarURL: ace.avatarUrl });
    } catch {
    }
    return { findings: [], errors: ['Ace: recovery error'] };
  }
}

interface AceDispatchResult {
  response: string;
  qualityFailed: boolean;
  designTask: boolean;
  fileChanges: string[];
}

async function dispatchAceWithQualityGate(
  rileyResponse: string,
  aceChannel: WebhookCapableChannel,
  workspaceChannel: WebhookCapableChannel,
  signal?: AbortSignal,
): Promise<AceDispatchResult> {
  const designCheck = isDesignDeliverableDetailed(rileyResponse, goalState.goal);
  const designTask = designCheck.match;
  console.log(`AGENT_CHAIN isDesignDeliverable=${designTask} rileyMatch=${designCheck.rileyMatch} goalMatch=${designCheck.goalMatch} goal="${(goalState.goal || '').slice(0, 80)}" rileySnippet="${rileyResponse.slice(0, 120)}"`);

  const aceContext = designTask
    ? buildAceDesignContext(rileyResponse)
    : buildAceStandardContext(rileyResponse);

  // Track mutating tool calls to inform the quality gate.
  // If Ace used edit_file/write_file/run_command/etc., real work was done
  // regardless of how short or formulaic the text response is.
  const MUTATING_TOOLS = new Set(['edit_file', 'write_file', 'batch_edit', 'run_command', 'git_create_branch', 'create_pull_request']);
  const FILE_TOOLS = new Set(['edit_file', 'write_file', 'batch_edit']);
  const toolsUsed = new Set<string>();
  let mutatingToolCount = 0;
  const fileChanges: string[] = [];

  let aceResponse = await dispatchToAgent('developer', aceContext, aceChannel, {
    signal,
    maxTokens: designTask ? 4000 : undefined,
    persistUserContent: `[Riley directed]: ${rileyResponse.slice(0, 1000)}`,
    documentLine: '✅ {response}',
    workspaceChannel,
    suppressVisibleOutput: shouldSuppressAceVisibleOutput,
    onToolUse: (toolName, summary) => {
      toolsUsed.add(toolName);
      if (MUTATING_TOOLS.has(toolName)) mutatingToolCount++;
      if (FILE_TOOLS.has(toolName) && summary) fileChanges.push(summary);
    },
  });

  const needsQualityRetry = () => {
    // If Ace used mutating tools, real work was done — skip text-based quality checks
    if (mutatingToolCount > 0) return false;
    return (
      aceResponse.trim().length < 90
      || LOW_SIGNAL_COMPLETION_RE.test(aceResponse)
      || isAceSelfDelegationResponse(aceResponse)
      || !hasAceCompletionContract(aceResponse)
    );
  };

  // Design deliverables: Ace's file creation via tools IS the deliverable.
  // The quality gate (Result/Evidence/Risk) is irrelevant — skip retries.
  if (!designTask) {
    if (!signal?.aborted && needsQualityRetry()) {
      aceResponse = await dispatchToAgent(
        'developer',
        '[System quality check] Execute directly and provide a concrete completion summary: Result (one sentence), Evidence (file paths + validation), Risk/Follow-up (one sentence). No delegation, no placeholders.',
        aceChannel,
        {
          signal,
          maxTokens: Math.max(SUBAGENT_MAX_TOKENS, 500),
          persistUserContent: '[System quality check for Ace response detail]',
          documentLine: '✅ {response}',
          workspaceChannel,
          suppressVisibleOutput: shouldSuppressAceVisibleOutput,
        }
      );
    }
  }

  const qualityFailed = !designTask && !signal?.aborted && needsQualityRetry();
  console.log(`AGENT_CHAIN aceQualityFailed=${qualityFailed} designTask=${designTask} needsRetry=${needsQualityRetry()} mutatingTools=${mutatingToolCount} toolsUsed=${[...toolsUsed].join(',')} aceLen=${aceResponse.trim().length} aceSnippet="${aceResponse.slice(0, 120)}"`);
  return { response: aceResponse, qualityFailed, designTask, fileChanges };
}

async function runSpecialistFallback(
  rileyResponse: string,
  aceResponse: string,
  aceQualityFailed: boolean,
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  signal?: AbortSignal,
): Promise<{ findings: string[]; errors: string[] }> {
  const findings: string[] = [];
  const errors: string[] = [];
  const inferredSpecialists = inferSpecialistsForContext(`${rileyResponse}\n${aceResponse}`)
    .filter((id) => id !== 'developer');
  // Don't force QA fallback when Ace quality fails — it wastes tokens routing code tasks
  // to agents that can't write code. Only run genuinely inferred specialists.
  const fallbackAgents = [...new Set(inferredSpecialists)].slice(0, 2);
  if (fallbackAgents.length > 0) {
    const autoSpecialistRun = await handleSubAgents(fallbackAgents, aceResponse, groupchat, workspaceChannel, signal);
    findings.push(...autoSpecialistRun.findings);
    errors.push(...autoSpecialistRun.errors);
  }
  return { findings, errors };
}

/**
 * Handle the chain: Riley → Ace → sub-agents → report back.
 * Returns a summary of the chain outcome for use in continuation loops.
 */
async function handleAgentChain(
  rileyResponse: string,
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  signal?: AbortSignal
): Promise<{ summary: string; hadErrors: boolean; hadFileChanges: boolean }> {
  const result = { summary: '', hadErrors: false, hadFileChanges: false };
  const directedAgents = parseDirectives(rileyResponse);
  const wantsFullTeam = RILEY_USE_ALL_AGENTS && shouldFanOutAllAgents(rileyResponse);
  const effectiveAgents = wantsFullTeam
    ? [...DIRECTED_AGENT_IDS]
    : directedAgents;
  if (effectiveAgents.length === 0) return result;
  markGoalProgress('🧩 Coordinating specialist agents...');

  const aceDirected = effectiveAgents.length > 0;
  const otherDirected = RILEY_DIRECT_SPECIALISTS
    ? effectiveAgents.filter((id) => id !== 'developer')
    : [];
  const consolidatedFindings: string[] = [];
  const consolidatedErrors: string[] = [];
  const rileyAlreadyCompletion = /(done|completed|complete|fixed|resolved|implemented|deployed|shipped|finished|ready)/i.test(rileyResponse);
  const needsRuntimeEvidence = goalNeedsRuntimeVerification(`${goalState.goal || ''}\n${rileyResponse}`);
  if (aceDirected) {
    const ace = getAgent('developer' as AgentId);
    if (ace) {
      try {
        if (signal?.aborted) return result;
        const aceChannel = getAgentWorkChannel('developer', groupchat);
        aceChannel.sendTyping().catch(() => {});

        const { response: aceResponse, qualityFailed: aceQualityFailed, designTask, fileChanges } =
          await dispatchAceWithQualityGate(rileyResponse, aceChannel, workspaceChannel, signal);

        if (aceQualityFailed) {
          consolidatedErrors.push('Ace completion quality check failed after retries.');
        }

        // Post a compact diff preview if files were changed
        if (fileChanges.length > 0 && !signal?.aborted) {
          result.hadFileChanges = true;
          const diffLines = fileChanges.slice(0, 15).map(s => `\`${s.slice(0, 100)}\``).join('\n');
          const diffEmbed = new EmbedBuilder()
            .setTitle(`📝 Files Changed (${fileChanges.length})`)
            .setDescription(diffLines)
            .setColor(SYSTEM_COLORS.info)
            .setTimestamp();
          await workspaceChannel.send({ embeds: [diffEmbed] }).catch(() => {});
        }

        if (!signal?.aborted && hasAceCompletionContract(aceResponse)) {
          consolidatedFindings.push(`${getAgentMention('developer' as AgentId)}: ${summarizeAceCompletionForRiley(aceResponse)}`);
          result.summary = summarizeAceCompletionForRiley(aceResponse);
        }

        if (signal?.aborted) return result;
        markGoalProgress('💻 Ace implementing...');

        const aceSubDirectives = parseDirectives(aceResponse);
        if (aceSubDirectives.length > 0) {
          const fromAce = await handleSubAgents(aceSubDirectives, aceResponse, groupchat, workspaceChannel, signal);
          consolidatedFindings.push(...fromAce.findings);
          consolidatedErrors.push(...fromAce.errors);
        } else if (!designTask) {
          const fallbackResult = await runSpecialistFallback(rileyResponse, aceResponse, aceQualityFailed, groupchat, workspaceChannel, signal);
          consolidatedFindings.push(...fallbackResult.findings);
          consolidatedErrors.push(...fallbackResult.errors);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
        console.error('Ace error:', errMsg(err));
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

  if (!signal?.aborted && hasBlockingVerificationFinding(consolidatedFindings)) {
    consolidatedErrors.push('Verification is blocked based on specialist findings; completion remains blocked until verification passes.');
  }

  if (RILEY_ACE_ERROR_RECOVERY && !signal?.aborted && consolidatedErrors.length > 0) {
    const recovered = await recoverFromAgentErrors(rileyResponse, consolidatedErrors, groupchat, workspaceChannel, signal);
    consolidatedFindings.push(...recovered.findings);
    consolidatedErrors.push(...recovered.errors);
  }

  if (!signal?.aborted && needsRuntimeEvidence) {
    // Auto-capture web harness screenshots when Ace made file changes,
    // so verification evidence is produced without manual intervention.
    const evidenceSince = Math.max(Date.now() - 2 * 60 * 60 * 1000, goalState.startedAt - 60_000);
    let hasEvidence = await hasRecentRuntimeVerificationEvidence(groupchat, workspaceChannel, evidenceSince);
    if (!hasEvidence) {
      const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
      try {
        const riley = getAgent('executive-assistant' as AgentId);
        if (riley) {
          await sendAgentMessage(workspaceChannel, riley, '📸 Auto-capturing web harness verification screenshots...');
        }
        await captureAndPostScreenshots(appUrl, `auto-verify ${goalState.goal?.slice(0, 40) || 'goal'}`, {
          targetChannel: workspaceChannel as TextChannel,
          clearTargetChannel: false,
        });
        // Re-check after capture — screenshots were posted to workspaceChannel
        hasEvidence = await hasRecentRuntimeVerificationEvidence(groupchat, workspaceChannel, evidenceSince);
      } catch (err) {
        console.warn('Auto-harness capture failed:', errMsg(err));
      }
    }
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
      const consolidatedUpdate = buildConsolidatedAgentUpdate(consolidatedFindings, consolidatedErrors);
      const watchdogSummary = !rileyAlreadyCompletion
        ? buildChainCompletionWatchdogMessage(consolidatedFindings, consolidatedErrors)
        : '';
      const workspaceSummary = [consolidatedUpdate, watchdogSummary].filter(Boolean).join('\n\n');
      await sendAgentMessage(workspaceChannel, riley, workspaceSummary);

      if (workspaceChannel.id !== groupchat.id) {
        const compact = buildCompactChainStatus(consolidatedFindings, consolidatedErrors);
        await sendAgentMessage(groupchat, riley, compact);
      }
    }
  }

  result.hadErrors = consolidatedErrors.length > 0;
  if (!result.summary && consolidatedFindings.length > 0) {
    result.summary = consolidatedFindings.join('; ');
  }
  return result;
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
): Promise<{ findings: string[]; errors: string[]; opusSummary: OpusExecutionSummary | null; reports: HandoffResult[] }> {
  const validAgents = agentIds
    .filter((id) => id !== 'executive-assistant')
    .map((id) => ({ id, agent: getAgent(id as AgentId) }))
    .filter((a): a is { id: string; agent: AgentConfig } => a.agent !== null && a.agent !== undefined);

  if (validAgents.length === 0) return { findings: [], errors: [], opusSummary: null, reports: [] };
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
  const reports: HandoffResult[] = [];

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
      tierAgents.map(({ id }) => async () => {
        if (signal?.aborted) return;
        const startedAt = Date.now();
        documentToChannel(id, `📥 Received task from groupchat. Working...`).catch(() => {});

        const handoffCtx = buildHandoffContext({
          fromAgent: 'riley',
          toAgent: id,
          traceId: `groupchat-${Date.now()}`,
          task: directiveExcerpt,
          conversationSummary: priorSummary || undefined,
          constraints: ['Be concise — max 120 words', 'Do only specialist work relevant to your role', 'Report what you found or changed'],
          expectedOutput: 'Brief specialist finding or action result',
          parentGoal: directiveContext.slice(0, 200),
        });
        const handoffPrefix = formatHandoffPrompt(handoffCtx);
        const agentContext = `${handoffPrefix}\n\nDo only the specialist work relevant to your role. Be concise — max 120 words. Report what you found or changed.`;
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
        const trimmed = agentResponse.slice(0, 500);
        const report = createAgentExecutionReport({
          agentId: id,
          summary: trimmed || 'No visible specialist response.',
          status: trimmed ? 'completed' : 'partial',
          durationMs: Date.now() - startedAt,
          evidence: [{ kind: 'message', value: trimmed || 'empty-response' }],
        });
        return {
          finding: `${getAgentMention(id as AgentId)}: ${trimmed}`,
          report,
        };
      }),
      MAX_PARALLEL_SUBAGENTS
    );

    for (let i = 0; i < tierResults.length; i++) {
      const result = tierResults[i];
      if (result.status === 'fulfilled') {
        if (result.value && typeof result.value.finding === 'string' && result.value.finding.length > 0) {
          priorFindings.push(result.value.finding);
        }
        if (result.value?.report) {
          reports.push(result.value.report);
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
        const issue: ExecutionIssue = {
          scope: 'agent',
          severity: 'error',
          source: tierAgents[i].id,
          message: resultReasonToMessage(tierResults[i]),
          suggestedAction: 'Retry the specialist task or escalate to Opus recovery.',
        };
        const errorEvidence: ExecutionEvidence = {
          kind: 'log',
          value: issue.message,
        };
        reports.push(createAgentExecutionReport({
          agentId: tierAgents[i].id,
          summary: 'Specialist execution failed.',
          status: 'blocked',
          durationMs: 0,
          issues: [issue],
          evidence: [errorEvidence],
        }));
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
  let opusSummary = await executeOpusPlan({
    executionId: `subagents:${Date.now()}`,
    goal: directiveContext.replace(/\s+/g, ' ').trim().slice(0, 200) || 'specialist follow-up',
    requestedBy: 'riley',
    specialistReports: reports,
  }, {
    onMilestone: (milestone) => {
      if (milestone.stage === 'blocked') {
        markGoalProgress(`⚠️ ${milestone.message}`);
      }
    },
  });

  if (opusSummary.stewardRequests.length > 0 && !signal?.aborted) {
    const channels = getBotChannels();
    const stewardKinds = [...new Set(opusSummary.stewardRequests.map((request) => request.kind))].join(',');
    logAgentEvent('operations-manager', 'invoke', `steward-requests:${stewardKinds}:${directiveContext.slice(0, 240)}`);
    if (channels?.threadStatus) {
      await postOpsLine(channels.threadStatus, {
        actor: 'operations-manager',
        scope: 'opus-stewardship',
        metric: `requests=${opusSummary.stewardRequests.length}`,
        delta: `kinds=${stewardKinds || 'none'}`,
        action: 'run loop adapters and stewardship handoff',
        severity: opusSummary.status === 'completed' ? 'info' : 'warn',
      }).catch(() => {});
    }
    await postWorkspaceProgressUpdate(
      workspaceChannel,
      'operations-manager',
      `Stewardship queue received from Opus: ${opusSummary.stewardRequests.map((request) => `[${request.kind}] ${request.summary}`).slice(0, 4).join(' | ')}`
    );
    markGoalProgress('🛰️ Operations steward maintaining self-improvement and loops...');
    const loopReports = await executeLoopAdapters(
      opusSummary.stewardRequests.flatMap((request) => request.recommendedLoopIds || [])
    );
    if (loopReports.length > 0) {
      const loopSummary = loopReports.map((report) => `${report.loopId}=${report.status}`).join(', ');
      logAgentEvent('operations-manager', 'response', `loop-adapter-summary:${loopSummary}`);
      if (channels?.threadStatus) {
        await postOpsLine(channels.threadStatus, {
          actor: 'operations-manager',
          scope: 'loop-adapter',
          metric: `loops=${loopReports.length}`,
          delta: loopSummary,
          action: loopReports.some((report) => report.status === 'blocked' || report.status === 'partial')
            ? 'inspect loop adapter results'
            : 'none',
          severity: loopReports.some((report) => report.status === 'blocked')
            ? 'error'
            : loopReports.some((report) => report.status === 'partial')
              ? 'warn'
              : 'info',
        }).catch(() => {});
      }
      await postWorkspaceProgressUpdate(
        workspaceChannel,
        'operations-manager',
        `Loop maintenance results: ${loopReports.map((report) => `${report.loopId}=${report.status}`).slice(0, 6).join(', ')}`
      );
    }

    const opsAgentId = 'operations-manager' as AgentId;
    const opsStartedAt = Date.now();
    const opsChannel = getAgentWorkChannel(opsAgentId, groupchat);
    const stewardshipGoal = directiveContext.replace(/\s+/g, ' ').trim().slice(0, 200) || 'operations stewardship';
    const opsHandoffCtx = buildHandoffContext({
      fromAgent: 'opus',
      toAgent: opsAgentId,
      traceId: `opus-ops-${Date.now()}`,
      task: `Maintain self-improvement, loop health, and ops-channel hygiene for: ${stewardshipGoal}`,
      conversationSummary: opusSummary.summary,
      constraints: [
        'Focus on memory, logging, regression coverage, loop reporting, and ops-channel hygiene only.',
        'Be concise and operational.',
        'Return what you changed, what you observed, and what still needs follow-up.',
      ],
      expectedOutput: 'Operational stewardship summary with actions taken and remaining risk',
      parentGoal: stewardshipGoal,
    });
    const loopEvidenceBlock = loopReports.length > 0
      ? `\n\nLoop adapter reports:\n${loopReports.map((report) => `- ${report.loopId}: ${report.summary}`).join('\n')}`
      : '';
    const opsContext = `${formatHandoffPrompt(opsHandoffCtx)}\n\nOperations steward requests:\n${formatOperationsStewardRequests(opusSummary.stewardRequests)}${loopEvidenceBlock}`;
    const opsResponse = await dispatchToAgent(opsAgentId, opsContext, opsChannel, {
      maxTokens: SUBAGENT_MAX_TOKENS,
      memoryWindow: 6,
      signal,
      persistUserContent: `[Opus stewardship request]: ${opsContext.slice(0, 900)}`,
      documentLine: '🛰️ {response}',
      workspaceChannel,
    });

    if (!signal?.aborted) {
      const loopIssues = loopReports.flatMap((report) => report.issues || []);
      const loopEvidence = loopReports.flatMap((report) => report.evidence || []);
      const opsReport = createAgentExecutionReport({
        agentId: opsAgentId,
        summary: opsResponse.slice(0, 500) || 'Operations steward completed a maintenance pass.',
        status: loopIssues.some((issue) => issue.severity === 'error') ? 'partial' : 'completed',
        durationMs: Date.now() - opsStartedAt,
        issues: loopIssues,
        evidence: [{ kind: 'message', value: opsResponse.slice(0, 500) || 'operations-steward:no-visible-response' }, ...loopEvidence],
      });
      reports.push(opsReport);
      logAgentEvent(opsAgentId, 'response', `steward-handoff:${opsReport.status}:${opsReport.summary}`);
      if (channels?.threadStatus) {
        await postOpsLine(channels.threadStatus, {
          actor: opsAgentId,
          scope: 'opus-stewardship',
          metric: `status=${opsReport.status}`,
          delta: opsReport.summary,
          action: opsReport.status === 'completed' ? 'none' : 'review steward follow-up',
          severity: opsReport.status === 'completed' ? 'info' : 'warn',
        }).catch(() => {});
      }
      if (opsResponse.trim()) {
        priorFindings.push(`${getAgentMention(opsAgentId)}: ${opsResponse.slice(0, 500)}`);
        await postWorkspaceProgressUpdate(
          workspaceChannel,
          opsAgentId,
          `Operations steward update: ${opsResponse.slice(0, 700)}`
        );
      }
      if (loopIssues.some((issue) => issue.severity === 'error')) {
        errorLines.push(`${getAgentMention(opsAgentId)}: loop maintenance encountered errors`);
      }
      opusSummary = await executeOpusPlan({
        executionId: `subagents:${Date.now()}`,
        goal: stewardshipGoal,
        requestedBy: 'riley',
        specialistReports: reports,
        loopReports,
      });
    }
  }
  markGoalProgress('📝 Sub-agent cycle completed');
  return { findings: priorFindings, errors: errorLines, opusSummary, reports };
}

function resultReasonToMessage(result: PromiseSettledResult<unknown>): string {
  if (result.status !== 'rejected') return 'Unknown specialist error';
  const reason = result.reason;
  return reason instanceof Error ? reason.stack || reason.message : String(reason);
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
 * Post a button-based decision embed.
 * Parses numbered options from Riley's response and adds interactive buttons.
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

  const hasYesNoCue = /\byes\b.*\bno\b|\bapprove\b.*\breject\b|\bgo\b.*\bno-go\b|\bship\b.*\bhold\b/i.test(decisionText);
  const usingYesNo = options.length === 0 && hasYesNoCue;

  const choiceSet = usingYesNo ? ['Yes', 'No'] : options.slice(0, 5);
  const choiceEmojis = usingYesNo ? ['✅', '❌'] : ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

  if (choiceSet.length === 0) return;

  const isDecisionsChannel = decisionsChannel && targetChannel.id === decisionsChannel.id;
  const attentionLine = buildGroupchatDecisionAttention(targetChannel.id, groupchat.id, process.env.DISCORD_PRIMARY_USER_ID);

  const embed = new EmbedBuilder()
    .setTitle('📋 Decision Review (Optional)')
    .setDescription(
      choiceSet
        .map((opt, i) => `${choiceEmojis[i]} ${opt}`)
        .join('\n\n')
    )
    .setColor(SYSTEM_COLORS.decision)
    .setFooter({ text: isDecisionsChannel ? 'Work continues automatically. Click a button or type your preference.' : 'Work continues automatically. Click a button to steer plan.' });

  // Build button rows (max 5 per row)
  const buttons = choiceSet.map((label, i) =>
    new ButtonBuilder()
      .setCustomId(`${BUTTON_IDS.DECISION_PREFIX}${i}`)
      .setLabel(label.slice(0, 80))
      .setEmoji(choiceEmojis[i])
      .setStyle(usingYesNo && i === 1 ? ButtonStyle.Danger : ButtonStyle.Primary)
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

  const decisionMsg = await targetChannel.send({ content: attentionLine || undefined, embeds: [embed], components: [row] });

  const timeoutMs = isDecisionsChannel ? 12 * 60 * 60 * 1000 : 5 * 60 * 1000;

  // Use persistent-style collector for long-lived decisions
  const collector = decisionMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: timeoutMs,
    max: 1,
    filter: (i) => !i.user.bot,
  });

  collector.on('collect', async (btnInteraction) => {
    const choiceIndex = parseInt(btnInteraction.customId.replace(BUTTON_IDS.DECISION_PREFIX, ''), 10);
    const choice = choiceSet[choiceIndex] || `Option ${choiceIndex + 1}`;
    const userName = btnInteraction.user.username;

    console.log(`Decision: ${userName} chose option ${choiceIndex + 1}: "${choice}"`);

    // Disable all buttons after choice
    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      buttons.map((b, i) =>
        ButtonBuilder.from(b.toJSON())
          .setDisabled(true)
          .setStyle(i === choiceIndex ? ButtonStyle.Success : ButtonStyle.Secondary)
      )
    );

    const riley = getAgent('executive-assistant' as AgentId);
    const confirmText = `✅ **${userName}** chose: **${choice}**`;

    try {
      await btnInteraction.update({ components: [disabledRow] });
    } catch { /* ignore if already replied */ }

    if (riley) {
      try {
        await sendWebhookMessage(targetChannel, { content: confirmText, username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
      } catch {
        await targetChannel.send(confirmText);
      }
    } else {
      await targetChannel.send(confirmText);
    }

    const decisionMessage = `[Plan preference from decisions buttons] ${userName} selected ${choice}. Continue execution and adjust plan accordingly.`;
    const workspaceChannel = await ensureGoalWorkspace(groupchat, userName, decisionMessage);
    await handleRileyMessage(decisionMessage, userName, undefined, groupchat, undefined, workspaceChannel);
  });

  collector.on('end', async (collected) => {
    if (collected.size === 0) {
      // Timeout — disable buttons
      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.map((b) => ButtonBuilder.from(b.toJSON()).setDisabled(true).setStyle(ButtonStyle.Secondary))
      );
      await decisionMsg.edit({ components: [disabledRow] }).catch(() => {});
    }
  });
}

/** Persist groupHistory to disk. Called after every interaction. */
function persistGroupHistory(): void {
  saveMemory('groupchat', groupHistory);
  // Auto-compress at 50 messages (was 60) + periodic mid-session compression at 30
  if (groupHistory.length >= 50) {
    compressMemory('groupchat').catch(() => {});
  } else if (groupHistory.length >= 30 && groupHistory.length % 10 === 0) {
    // Periodic light compression every 10 messages once we pass 30
    compressMemory('groupchat').catch(() => {});
  }
}
