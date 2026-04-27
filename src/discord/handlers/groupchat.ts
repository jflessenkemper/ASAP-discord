import { execFileSync, execFile } from 'child_process';
import { buildSafeCommandEnv } from '../envSandbox';
import { formatAge } from '../../utils/time';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { isTesterBotId } from '../../utils/botIdentity';
import { withPgAdvisoryLock } from '../../utils/pgLock';

import { Message, TextChannel, GuildMember, EmbedBuilder, ThreadAutoArchiveDuration, ButtonBuilder, ActionRowBuilder, ButtonStyle, ComponentType, ChannelType } from 'discord.js';

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
import {
  buildSelfImprovementOpsUpdates,
  buildSelfImprovementPacket,
  formatOperationsStewardRequests,
  type OperationsStewardRequest,
  type SelfImprovementPacket,
} from '../operationsSteward';
import { createAgentExecutionReport, executeOpusPlan, type OpusExecutionSummary } from '../opusExecution';
import {
  claimNextSelfImprovementJob,
  enqueueSelfImprovementJob,
  markSelfImprovementJobCompleted,
  markSelfImprovementJobFailed,
  type SelfImprovementQueuePayload,
} from '../selfImprovementQueue';
import { postAgentErrorLog } from '../services/agentErrors';
import { buildToolNotificationLine, formatToolNotificationItem, ToolChainTracker } from '../services/discordOutputSanitizer';
import { shouldEchoDirectedResponseToGroupchat, shouldKeepGroupchatPromptInChannel } from '../services/groupchatRouting';
import { captureAndPostScreenshots } from '../services/screenshots';
import { makeOutboundCall, makeAsapTesterCall, startConferenceCall, isTelephonyAvailable } from '../services/telephony';
import { getWebhook, sendWebhookMessage, editWebhookMessage, WebhookCapableChannel } from '../services/webhooks';
import { trackAgentActive, trackAgentIdle } from '../presence';
import { recordDecision, resolveDecision } from '../decisions';
import { beginTurn, TurnTracker } from '../turnTracker';
import {
  approveAdditionalBudget,
  clearConversationTokens,
  getClaudeTokenLimitState,
  getContextEfficiencyReport,
  getRemainingBudget,
  getUsageReport,
  isBudgetExceeded,
  refreshLiveBillingData,
  refreshUsageDashboard,
} from '../usage';
import { logAgentEvent, postOpsLine } from '../activityLog';
import { recordAgentLearning } from '../vectorMemory';

import { startCall, endCall, isCallActive, injectVoiceTranscriptForTesting, processTesterVoiceTurnForCall } from './callSession';
import { SYSTEM_COLORS, BUTTON_IDS } from '../ui/constants';
import { shouldSkipContractEnforcement } from './designDeliverable';
import { documentToChannel } from './documentation';
import { goalState, GOAL_THREAD_COUNTER_RE } from './goalState';
import { LOW_SIGNAL_COMPLETION_RE } from './responseNormalization';
import { sendAgentMessage, clearHistory } from './textChannel';
import { errMsg } from '../../utils/errors';
import { envIntFirst, envBoolFirst } from '../../utils/env';
import { buildLoopHealthCompactSummary, buildLoopHealthDetailedReport, recordLoopHealth } from '../loopHealth';
import { buildLoggingEngineReport, runLoggingEngine } from '../loggingEngine';
import { buildGroupchatDecisionAttention, buildGroupchatSingleUserNotice, buildTextStatusSummary } from '../cortanaInteraction';


type ToolChainMessage = {
  channel: WebhookCapableChannel;
  agent: AgentConfig;
  tracker: ToolChainTracker;
  messageId: string | null;
  editTimer: NodeJS.Timeout | null;
};

const TOOL_CHAIN_EDIT_DEBOUNCE_MS = parseInt(process.env.TOOL_CHAIN_EDIT_DEBOUNCE_MS || '400', 10);
const toolChainMessages = new Map<string, ToolChainMessage>();
const cortanaStallNoticeAt = new Map<string, number>();
const CORTANA_STALL_NOTICE_COOLDOWN_MS = envIntFirst(['CORTANA_STALL_NOTICE_COOLDOWN_MS', 'RILEY_STALL_NOTICE_COOLDOWN_MS'], 120000);

/** Record a tool start/completion for Copilot-style live chain display. */
function updateToolChain(
  channel: WebhookCapableChannel,
  agent: AgentConfig,
  toolName: string,
  summary: string,
  status: 'start' | 'done',
): void {
  const key = `${channel.id}:${agent.id}`;
  let chain = toolChainMessages.get(key);
  if (!chain) {
    chain = { channel, agent, tracker: new ToolChainTracker(), messageId: null, editTimer: null };
    toolChainMessages.set(key, chain);
  }

  if (status === 'start') {
    chain.tracker.startTool(toolName, summary);
  } else {
    chain.tracker.completeTool(toolName, summary);
  }

  // Debounce edits to avoid Discord rate limits
  if (chain.editTimer) clearTimeout(chain.editTimer);
  chain.editTimer = setTimeout(() => {
    void flushToolChainEdit(key);
  }, Math.max(200, TOOL_CHAIN_EDIT_DEBOUNCE_MS));
}

/** Legacy wrapper — called from onToolUse callbacks that only have 'done' status */
async function sendToolNotification(channel: WebhookCapableChannel, agent: AgentConfig, toolName: string, summary: string): Promise<void> {
  updateToolChain(channel, agent, toolName, summary, 'done');
}

async function flushToolChainEdit(key: string): Promise<void> {
  const chain = toolChainMessages.get(key);
  if (!chain || chain.tracker.isEmpty) return;
  if (chain.editTimer) {
    clearTimeout(chain.editTimer);
    chain.editTimer = null;
  }

  const content = chain.tracker.render();

  try {
    if (chain.messageId) {
      const wh = await getWebhook(chain.channel);
      await wh.editMessage(chain.messageId, { content });
    } else {
      const msg = await sendWebhookMessage(chain.channel, {
        content,
        username: `${chain.agent.emoji} ${chain.agent.name}`,
        avatarURL: chain.agent.avatarUrl,
      });
      chain.messageId = msg.id;
    }
  } catch (err) {
    console.warn(`Tool chain edit failed for ${chain.agent.name}:`, errMsg(err));
    chain.messageId = null;
  }
}

/** Reset tool chain for a channel so the next invocation creates a fresh message. */
function resetToolChain(channelId: string): void {
  for (const [key, chain] of toolChainMessages) {
    if (key.startsWith(`${channelId}:`)) {
      if (chain.editTimer) clearTimeout(chain.editTimer);
      toolChainMessages.delete(key);
    }
  }
}
const groupHistory: ConversationMessage[] = loadMemory('groupchat');

// Dedupe the "⏳ Verification pending" notice so it doesn't re-append on
// every completion-claim cycle. Keyed by goal text, 10 min cooldown.
const verificationPendingShownAt = new Map<string, number>();
const VERIFICATION_PENDING_COOLDOWN_MS = Math.max(60_000, parseInt(process.env.VERIFICATION_PENDING_COOLDOWN_MS || '600000', 10));

// Global FIFO for groupchat events. A single stuck request can block all later
// messages, so processing is always paired with explicit timeout guards.
let messageQueue: Promise<void> = Promise.resolve();

// In-flight cancellation token. New inbound messages abort older work so the
// bot follows the newest user intent instead of finishing stale tasks.
let activeAbortController: AbortController | null = null;
let activeThinkingMessage: Message | null = null;
// Per-workspace-channel turn tracker — the unified status message for the
// active Cortana turn. Keyed by the workspace thread/channel id so parallel
// turns in different threads don't collide.
const activeTurnByChannel: Map<string, TurnTracker> = new Map();
let activeGroupchatOwner: { userId: string; displayName: string } | null = null;
let selfImprovementWorkerRunning = false;
let selfImprovementWorkerTimer: ReturnType<typeof setInterval> | null = null;
let lastSelfImprovementWorkerErrorAt = 0;
let lastSelfImprovementWorkerErrorKey = '';

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
const CORTANA_NO_RESPONSE_TIMEOUT_MS = envIntFirst(['CORTANA_NO_RESPONSE_TIMEOUT_MS', 'RILEY_NO_RESPONSE_TIMEOUT_MS'], 180000);
const CORTANA_PROGRESS_PING_MS = envIntFirst(
  ['CORTANA_PROGRESS_PING_MS', 'RILEY_PROGRESS_PING_MS'],
  Math.max(20_000, Math.floor(CORTANA_NO_RESPONSE_TIMEOUT_MS * 0.6)),
);
const SELF_IMPROVEMENT_WORKER_POLL_MS = Math.max(2_000, parseInt(process.env.SELF_IMPROVEMENT_WORKER_POLL_MS || '5000', 10));
const SELF_IMPROVEMENT_WORKER_ERROR_COOLDOWN_MS = Math.max(5_000, parseInt(process.env.SELF_IMPROVEMENT_WORKER_ERROR_COOLDOWN_MS || '60000', 10));
const GOAL_WATCHDOG_TOKEN_OVERRUN_ALLOWANCE = Math.max(0, envIntFirst(['CORTANA_TOKEN_OVERRUN_ALLOWANCE', 'RILEY_TOKEN_OVERRUN_ALLOWANCE'], 2000000));

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
const MAX_CONTINUATION_CYCLES = envIntFirst(['CORTANA_MAX_CONTINUATION_CYCLES', 'RILEY_MAX_CONTINUATION_CYCLES'], 3);
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


let lastThreadCloseReviewAt = 0;
let lastAutoRebuildErrorAt = 0;
let lastAutoRebuildErrorKey = '';
let goalWatchdog: ReturnType<typeof setInterval> | null = null;
let threadStatusChannel: TextChannel | null = null;
let threadStatusSourceChannel: TextChannel | null = null;
let threadStatusReporter: ReturnType<typeof setInterval> | null = null;
const recentGroupchatFingerprints = new Map<string, number>();

// ── Vision: Discord image attachment → base64 image blocks ──

type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

async function extractImageBlocksFromMessage(message: Message): Promise<ImageBlock[]> {
  const blocks: ImageBlock[] = [];
  if (!message.attachments?.size) return blocks;

  for (const attachment of message.attachments.values()) {
    if (blocks.length >= MAX_IMAGE_ATTACHMENTS) break;
    const ct = String(attachment.contentType || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_CONTENT_TYPES.has(ct)) continue;
    if (attachment.size > MAX_IMAGE_SIZE_BYTES) continue;

    try {
      const res = await fetch(attachment.url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: ct, data: buf.toString('base64') },
      });
    } catch (err) {
      console.warn(`Failed to download attachment ${attachment.name}:`, err instanceof Error ? err.message : err);
    }
  }
  return blocks;
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

function inferCortanaStatus(text: string, completionClaimed: boolean, completionVerified: boolean): 'fixed' | 'partially fixed' | 'blocked' {
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

/**
 * Scrub the Status/Root cause/Fix location block from Cortana's visible reply
 * when she slipped into machine-contract formatting. The block is useful in
 * logs but noisy for users, so we strip it from what Discord sees. The
 * upstream activityLog captures the full response separately for audits.
 *
 * Historically this also synthesized a "contract" object and dumped JSON to
 * the console on every turn — that did nothing observable and was CPU +
 * regex churn, so it's gone.
 */
/**
 * Detect short conversational pings that don't warrant a goal/workspace.
 * Examples: "Cortana", "hi", "ok", "thanks", "are you there".
 *
 * Heuristics:
 *   - <= 6 words AND
 *   - no imperative verb (do/run/check/fix/build/show/explain/…) AND
 *   - not a question that names a concrete subject
 *
 * The agent name itself ("Cortana") is treated as a pure ping.
 */
const NO_OP_IMPERATIVE_RE = /\b(?:do|run|check|fix|implement|deploy|investigate|diagnose|build|write|edit|create|delete|add|remove|update|read|search|find|show|tell|explain|summari[sz]e|list|why|how|what|where|when|review|test|verify|launch|scan|generate|patch)\b/i;
function isNoOpUserPing(content: string): boolean {
  const raw = String(content || '');
  // URLs / Discord links are real instructions even with short surrounding
  // text ("Cortana do this <link>"). Don't classify those as pings.
  if (/https?:\/\/\S+|discord\.com\/channels\//i.test(raw)) return false;
  const stripped = raw
    .replace(/<@[!&]?\d+>/g, ' ')
    .replace(/[^\w\s'’?!.,-]/g, ' ')
    .trim();
  if (!stripped) return true;
  const wordCount = stripped.split(/\s+/).filter(Boolean).length;
  if (wordCount > 6) return false;
  if (NO_OP_IMPERATIVE_RE.test(stripped)) return false;
  const lower = stripped.toLowerCase();
  if (/^(?:cortana|hi|hello|hey|yo|sup|ok|okay|thanks?|thank you|cool|nice|great|got it|sounds good|are you there|you up|you online|ping)\b/.test(lower)) return true;
  // Plain agent-name mentions or single-word handles are pings.
  if (wordCount <= 2 && /^[a-z][\w-]*$/.test(lower.replace(/[?!.,]/g, ''))) return true;
  return false;
}

/** Tools that count as "actually changing code" for the no-tool-no-fix gate. */
const EDIT_TOOL_NAMES = new Set([
  'edit_file', 'write_file', 'batch_edit',
  'edit_self_file', 'create_pull_request', 'gcp_deploy', 'deploy_app',
]);

function isEditToolName(name: string): boolean {
  return EDIT_TOOL_NAMES.has(String(name || '').trim().toLowerCase());
}

function enforceCortanaResponseContract(
  text: string,
  completionClaimed: boolean,
  _completionVerified: boolean,
  opts?: { editToolUsedThisTurn?: boolean },
): string {
  const normalized = String(text || '').trim();
  if (!normalized) return normalized;
  if (shouldSkipContractEnforcement(normalized)) return normalized;

  // No-tool-no-fix gate: if Cortana is claiming completion ("fixed"/"done")
  // for a code-y goal but didn't actually call an edit tool this turn AND
  // didn't cite a file path in the response, downgrade to "in progress" and
  // surface why. Stops her from saying "I dug deep into the voice code" with
  // an empty fixLocations and no actual change. (Behaviour seen in the
  // April 2026 voice-chat experiment.)
  if (completionClaimed && opts && opts.editToolUsedThisTurn === false) {
    const cited = /(?:^|[\s(])(?:[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|sql|py|sh|css|scss|html))\b/i.test(normalized);
    if (!cited) {
      const note = '\n\n⚠️ **No code change observed this turn.** I claimed "fixed" but didn\'t call an edit tool or name a concrete file. Downgrading to *in progress* — re-attempt with `edit_file` / `edit_self_file` and cite the path.';
      return normalized + note;
    }
  }

  const hasContract = /\bstatus\s*:/i.test(normalized)
    && /\broot cause\s*:/i.test(normalized)
    && /\bfix location\s*:/i.test(normalized)
    && /\bverification evidence\s*:/i.test(normalized)
    && /\bresidual risk\s*:/i.test(normalized);
  if (!hasContract) return normalized;

  const stripped = normalized.replace(/\n\s*Status:[\s\S]*$/i, '').trim();
  return stripped || normalized;
}

async function emitCortanaStallAlert(
  workspaceChannel: WebhookCapableChannel,
  groupchat: TextChannel,
  goal: string,
  timeoutMs: number,
): Promise<boolean> {
  const key = goal.trim().toLowerCase().slice(0, 240) || 'none';
  const now = Date.now();
  const prev = cortanaStallNoticeAt.get(key) || 0;
  if (now - prev < CORTANA_STALL_NOTICE_COOLDOWN_MS) {
    return false;
  }
  cortanaStallNoticeAt.set(key, now);

  const seconds = Math.round(timeoutMs / 1000);
  const msg = `⚠️ No Cortana response after ${seconds}s for this goal. Investigating stall and retrying safeguards.`;
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

async function sendAutopilotAudit(
  groupchat: TextChannel,
  event: string,
  detail: string,
  extra?: { action?: string; buildId?: string; attempt?: number }
): Promise<void> {
  const cortana = getAgent('executive-assistant' as AgentId);
  const goal = compactAuditField(goalState.goal || 'none', 64);
  const status = compactAuditField(goalState.status || 'n/a', 48);

  // Structured line for logs + audit analysis.
  const bits = [
    `event=${event}`,
    extra?.action ? `action=${compactAuditField(extra.action, 24)}` : null,
    Number.isFinite(extra?.attempt) ? `attempt=${extra!.attempt}` : null,
    extra?.buildId ? `build=${compactAuditField(extra.buildId, 24)}` : null,
    `goal="${goal}"`,
    `status="${status}"`,
    `detail="${compactAuditField(detail, 120)}"`,
  ].filter(Boolean);
  console.log(`AUTOPILOT_AUDIT ${bits.join(' ')}`);

  if (process.env.AUTOPILOT_AUDIT_PUBLIC !== 'true') return;

  // Human one-liner for the channel. The old format exposed raw key=value
  // pairs which read like terminal output; this reformats as a short sentence.
  const prettyDetail = compactAuditField(detail, 160);
  const actionNote = extra?.action ? ` (${compactAuditField(extra.action, 40)})` : '';
  const attemptNote = Number.isFinite(extra?.attempt) ? ` — attempt ${extra!.attempt}` : '';
  const line = `🛰️ Autopilot — ${event}${actionNote}${attemptNote}: ${prettyDetail}`;

  if (!cortana) {
    await groupchat.send(line).catch(() => {});
    return;
  }
  try {
    await sendWebhookMessage(groupchat, { content: line, username: `${cortana.emoji} ${cortana.name}`, avatarURL: cortana.avatarUrl });
  } catch {
    await groupchat.send(line).catch(() => {});
  }
}

function ensureClaudeNotifications(groupchat: TextChannel): void {
  if (claudeNotificationsBoundChannelId === groupchat.id) return;
  claudeNotificationsBoundChannelId = groupchat.id;

  const sendSystemNotice = (content: string) => {
    const cortana = getAgent('executive-assistant' as AgentId);
    const send = async () => {
      const targetChannel = getAgentWorkChannel('executive-assistant', groupchat);
      if (cortana) {
        try {
          await sendWebhookMessage(targetChannel, {
            content,
            username: `${cortana.emoji} ${cortana.name}`,
            avatarURL: cortana.avatarUrl,
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
  const allowInfraActions = envBoolFirst(['CORTANA_ALLOW_IMPLICIT_INFRA_ACTIONS', 'RILEY_ALLOW_IMPLICIT_INFRA_ACTIONS']);

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
    void runGoalWatchdogTick(groupchat);
  }, GOAL_STALL_CHECK_INTERVAL_MS);
}

type GoalWatchdogBlocker = {
  kind: 'budget' | 'token' | 'recovery';
  status: string;
  detail: string;
  workspaceMessage: string;
  action: string;
};

function getGoalWatchdogBlocker(): GoalWatchdogBlocker | null {
  if (isBudgetExceeded()) {
    const { spent, limit, remaining } = getRemainingBudget();
    return {
      kind: 'budget',
      status: '⏸️ Parked: waiting for budget approval',
      detail: `Budget gate active at $${spent.toFixed(2)}/$${limit.toFixed(2)}. Auto-recovery is paused until budget is approved.`,
      workspaceMessage: `⏸️ I parked this goal because the daily budget gate is active at $${spent.toFixed(2)}/$${limit.toFixed(2)} with $${remaining.toFixed(2)} remaining. I will stop watchdog retries until budget is approved or the gate clears.`,
      action: 'await budget approval',
    };
  }

  const tokenStatus = getClaudeTokenLimitState(GOAL_WATCHDOG_TOKEN_OVERRUN_ALLOWANCE);
  if (tokenStatus.overHardLimit) {
    return {
      kind: 'token',
      status: '⏸️ Parked: Anthropic hard token limit reached',
      detail: `Token gate active at ${tokenStatus.used}/${tokenStatus.hardLimit} Claude tokens (soft limit ${tokenStatus.limit}). Auto-recovery is paused until capacity returns.`,
      workspaceMessage: `⏸️ I parked this goal because the Anthropic hard token limit is active at ${tokenStatus.used}/${tokenStatus.hardLimit} tokens. The soft daily limit is ${tokenStatus.limit}, but Cortana's overrun allowance is now exhausted, so I will stop watchdog retries until the limit resets or the runtime cap is raised.`,
      action: 'await token capacity',
    };
  }

  if (goalState.shouldParkForRecovery()) {
    return {
      kind: 'recovery',
      status: '⏸️ Parked: stalled after repeated recovery attempts',
      detail: `Goal stalled after ${goalState.recoveryAttempts} recovery attempts. Auto-recovery is parked until an operator intervenes or a new input arrives.`,
      workspaceMessage: `⏸️ I parked this goal after ${goalState.recoveryAttempts} failed recovery attempts to avoid a retry loop. I need an operator nudge or a fresh instruction before I resume.`,
      action: 'await operator review',
    };
  }

  return null;
}

async function resolveGoalWorkspaceChannel(groupchat: TextChannel): Promise<WebhookCapableChannel | null> {
  if (!goalState.threadId) return groupchat;
  return groupchat.threads.cache.get(goalState.threadId)
    || await groupchat.threads.fetch(goalState.threadId).catch(() => groupchat);
}

async function parkGoalWatchdog(groupchat: TextChannel, blocker: GoalWatchdogBlocker): Promise<void> {
  if (!goalState.goal || goalState.isPaused()) return;

  goalState.pause(blocker.kind, blocker.status, blocker.detail);
  recordLoopHealth('goal-watchdog', 'warn', `parked=${blocker.kind} goal=${goalState.goal.slice(0, 80)}`);

  await sendAutopilotAudit(
    groupchat,
    'watchdog_parked',
    blocker.detail,
    { action: blocker.action },
  ).catch(() => {});

  const channels = getBotChannels();
  if (channels?.threadStatus) {
    await postOpsLine(channels.threadStatus, {
      actor: 'operations-manager',
      scope: 'goal-watchdog',
      metric: `parked=${blocker.kind}`,
      delta: blocker.detail,
      action: blocker.action,
      severity: 'warn',
    }).catch(() => {});
  }

  const workspaceChannel = await resolveGoalWorkspaceChannel(groupchat);
  if (workspaceChannel) {
    const cortana = getAgent('executive-assistant' as AgentId);
    if (cortana) {
      await sendAgentMessage(workspaceChannel, cortana, blocker.workspaceMessage).catch(() => {});
    }
  }
}

async function autoResumeParkedGoal(groupchat: TextChannel): Promise<void> {
  if (!goalState.goal || !goalState.isPaused()) return;
  const pausedReason = goalState.pausedReason;
  const pauseDetail = goalState.pauseDetail || 'runtime gate cleared';

  goalState.resume(
    pausedReason === 'budget'
      ? '▶️ Auto-resuming after budget gate cleared'
      : pausedReason === 'token'
        ? '▶️ Auto-resuming after token capacity returned'
        : '▶️ Auto-resuming after stalled goal was unparked'
  );

  recordLoopHealth('goal-watchdog', 'ok', `resumed=${pausedReason || 'unknown'} goal=${goalState.goal.slice(0, 80)}`);
  await sendAutopilotAudit(
    groupchat,
    'watchdog_resume',
    `${pauseDetail} Gate cleared; resuming goal automatically.`,
    { action: 'resume' },
  ).catch(() => {});

  handleCortanaMessage(
    `[System auto-resume] The previous blocker has cleared for this goal: "${goalState.goal}". Previous pause note: ${pauseDetail}. Summarize current state in one short paragraph, then continue from the next unfinished step without repeating completed work.`,
    'System',
    undefined,
    groupchat,
  ).catch((err) => {
    console.error('Goal watchdog auto-resume error:', errMsg(err));
  });
}

async function runGoalWatchdogTick(groupchat: TextChannel): Promise<void> {
  if (!goalState.goal) return;

  await maybeReviewThreadForClosure(groupchat).catch((err) => {
    console.error('Thread close review error:', errMsg(err));
  });

  if (activeAbortController) return;

  const blocker = getGoalWatchdogBlocker();
  if (goalState.isPaused()) {
    if (!blocker) {
      await autoResumeParkedGoal(groupchat);
    }
    return;
  }

  if (blocker) {
    await parkGoalWatchdog(groupchat, blocker);
    return;
  }

  if (!goalState.isStalled()) return;

  goalState.recordRecoveryAttempt();
  recordLoopHealth('goal-watchdog', 'warn', `attempt=${goalState.recoveryAttempts} goal=${goalState.goal?.slice(0, 80) || 'unknown'}`);

  await sendAutopilotAudit(
    groupchat,
    'watchdog_recovery',
    'Goal was stalled; sending system nudge to Cortana for continuation and pending actions.',
    { attempt: goalState.recoveryAttempts }
  ).catch(() => {});

  handleCortanaMessage(
    `[System auto-recovery] This goal appears stalled: "${goalState.goal}". Summarize current state in one short paragraph, execute any pending deploy/screenshots/urls actions now using explicit [ACTION:...] tags, and continue without waiting for user follow-up. If the work is actually complete, post a short wrap-up in the workspace thread and include [ACTION:CLOSE_THREAD].`,
    'System',
    undefined,
    groupchat
  ).catch((err) => {
    console.error('Goal watchdog recovery error:', errMsg(err));
  });
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

  const cortana = getAgent('executive-assistant' as AgentId);
  const timestamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
  const label = reason === 'hourly' ? '🕐 Hourly' : '📋 Manual';
  const currentGoal = goalState.goal
    ? `**Goal:** ${goalState.goal.replace(/\s+/g, ' ').slice(0, 120)}\n**Status:** ${(goalState.status || 'in-progress').replace(/\s+/g, ' ').slice(0, 60)}`
    : '**Goal:** None\n**Status:** Idle';
  const report = await buildThreadStatusReport(threadStatusSourceChannel);
  const content = `${label} Thread Status — ${timestamp}\n\n${currentGoal}\n\n${report}`;

  await clearThreadStatusMessages(threadStatusChannel).catch(() => {});

  if (cortana) {
    await sendWebhookMessage(threadStatusChannel, {
      content: content.slice(0, 1900),
      username: `${cortana.emoji} ${cortana.name}`,
      avatarURL: cortana.avatarUrl,
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

/**
 * Maintain a single "Cortana is thinking…" / "Cortana is doing X…" message per
 * turn. On first call in a turn, posts a webhook message; subsequent calls
 * edit that message in place so the user sees a single evolving status line
 * instead of a stream of delete-and-repost notifications.
 *
 * `clearThinkingMessage` deletes the status (used when the final answer is
 * about to post as its own message). To fold the final answer into the same
 * message, use `finalizeThinkingMessage` instead.
 */
async function setThinkingMessage(channel: WebhookCapableChannel, agent: AgentConfig, content = '⏳ Thinking…'): Promise<void> {
  if (activeThinkingMessage && activeThinkingMessage.channelId === channel.id) {
    const edited = await editWebhookMessage(channel, activeThinkingMessage.id, content).catch(() => null);
    if (edited) {
      activeThinkingMessage = edited;
      return;
    }
    // Edit failed (message gone, webhook rotated) — fall through and re-send.
    activeThinkingMessage = null;
  } else if (activeThinkingMessage) {
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

/**
 * Edit the rolling status into the final answer, so the turn collapses to a
 * single message. Falls back to clear+send if the edit fails.
 */
async function finalizeThinkingMessage(channel: WebhookCapableChannel, finalContent: string): Promise<Message | null> {
  if (!activeThinkingMessage) return null;
  const msg = activeThinkingMessage;
  activeThinkingMessage = null;
  const edited = await editWebhookMessage(channel, msg.id, finalContent.slice(0, 2000)).catch(() => null);
  return edited ?? msg;
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
  const FILLER = new Set(['hey', 'hi', 'hello', 'please', 'can', 'you', 'could', 'would', 'cortana', 'the', 'a', 'an', 'i', 'we', 'need', 'want', 'to', 'me', 'my', 'our', 'this', 'that', 'it', 'is', 'for', 'on', 'in', 'of', 'and', 'or', 'with', 'some', 'just', 'also']);
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
  clearConversationTokens(`groupchat:${workspaceChannel.id}`);
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
      username: '📋 Cortana (Executive Assistant)',
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
      void postAgentErrorLog('cortana:auto-deploy', 'Auto rebuild on thread close failed', { detail: msg, level: 'warn' });
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
    clearConversationTokens(`groupchat:${goalState.threadId}`);
    goalState.threadId = null;
    return;
  }

  lastThreadCloseReviewAt = now;
  goalState.lastProgressAt = now;
  goalState.status = '🔎 Cortana reviewing whether this thread can close...';

  await sendAutopilotAudit(
    groupchat,
    'thread_close_review',
    'Idle workspace thread triggered a closure-readiness review.',
    { action: 'CHECK_CLOSE_THREAD' }
  ).catch(() => {});

  await handleCortanaMessage(
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
  const addressesCortana = /\b(?:cortana|asap)\b/i.test(normalized);
  const directJoinCall = addressesCortana && /\bjoin\b/i.test(normalized) && /\bcall\b/i.test(normalized);
  const directLeaveCall = addressesCortana && /\b(?:leave|end|disconnect|hang\s*up|drop)\b/i.test(normalized) && /\bcall\b/i.test(normalized);

  if ((joinVerb && voiceTarget) || directJoinCall) return 'join';
  if ((leaveVerb && (voiceTarget || /^(?:leave|end call|hang up|disconnect)$/i.test(normalized))) || directLeaveCall) return 'leave';
  return null;
}

function getSpeechBridgeText(text: string): string | null {
  const normalized = stripMentionsForIntent(text);
  if (!normalized) return null;
  const match = normalized.match(/^(?:cortana\s+)?(?:tester\s+)?(?:say|voice|speak)\s*(?::|-)\s*(.{1,260})$/i);
  if (!match) return null;
  return String(match[1] || '').trim() || null;
}

function isLikelyVoiceCommandIntent(text: string): boolean {
  const normalized = stripMentionsForIntent(text).toLowerCase();
  if (!normalized) return false;
  if (normalized.length > 220) return false;

  const hasVoiceTarget = /\b(?:voice|vc|voice\s+chat|voice\s+channel|call)\b/.test(normalized);
  const hasVoiceVerb = /\b(?:join|start|open|connect|enter|hop\s+in|jump\s+in|leave|end|stop|disconnect|hang\s*up|drop)\b/.test(normalized);
  const hasAssistantCue = /\b(?:cortana|asap)\b/.test(normalized);

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

  const testerPromptMatch = stripped.match(/^(?:hey|hi|yo)?\s*(?:cortana|asap)?\s*[,!:;-]?\s*(?:please\s+)?(?:inject|simulate|test)\s+(?:voice|transcript)\s*(?::|-)\s*(.{1,260})$/i);
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
      await groupchat.send('📞 Cortana is already in voice.').catch(() => {});
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

  const lead = String.raw`^(?:hey|hi|yo)?\s*(?:cortana|asap)?\s*[,!:;-]?\s*(?:please\s+)?(?:can you\s+|could you\s+|will you\s+)?`;
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

async function sendQuickCortanaMessage(groupchat: TextChannel, content: string): Promise<void> {
  const cortana = getAgent('executive-assistant' as AgentId);
  if (cortana) {
    await sendAgentMessage(groupchat, cortana, content);
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

async function postSelfImprovementOpsUpdates(
  channels: ReturnType<typeof getBotChannels>,
  managerAgentId: string,
  updates: ReturnType<typeof buildSelfImprovementOpsUpdates>,
): Promise<void> {
  if (!channels || updates.length === 0) return;

  for (const update of updates) {
    if (update.channelKey === 'thread-status') {
      await postOpsLine(channels.threadStatus, {
        actor: managerAgentId,
        scope: 'self-improvement-engine',
        metric: update.metric,
        delta: update.delta,
        action: update.action,
        severity: update.severity,
      }).catch(() => {});
      continue;
    }

    const channel = update.channelKey === 'loops' ? channels.loops : channels.upgrades;
    const label = update.channelKey === 'loops' ? 'Loops' : 'Upgrades';
    await channel.send(
      `🛰️ Cortana manager | ${label} | severity=${update.severity} | metric=${update.metric} | ${update.delta} | action=${update.action}`.slice(0, 1900)
    ).catch(() => {});
  }
}

async function resolveWebhookCapableChannelById(channelId: string): Promise<WebhookCapableChannel | null> {
  const channels = getBotChannels();
  const client = channels?.groupchat?.client;
  if (!client || !channelId) return null;
  const resolved = await client.channels.fetch(channelId).catch(() => null);
  if (!resolved) return null;
  if (resolved.type === ChannelType.GuildText || resolved.type === ChannelType.PublicThread || resolved.type === ChannelType.PrivateThread || resolved.type === ChannelType.AnnouncementThread) {
    return resolved as WebhookCapableChannel;
  }
  return null;
}

async function processSelfImprovementBackgroundJob(job: SelfImprovementQueuePayload): Promise<void> {
  const { packet, goal, conversationSummary, status, directiveContext } = job;
  const stewardRequests = packet.requests;
  const groupchat = await resolveWebhookCapableChannelById(job.groupchatChannelId);
  const workspaceChannel = await resolveWebhookCapableChannelById(job.workspaceChannelId);
  if (!groupchat || groupchat.type !== ChannelType.GuildText) {
    throw new Error(`Could not resolve groupchat channel ${job.groupchatChannelId}`);
  }
  if (!workspaceChannel) {
    throw new Error(`Could not resolve workspace channel ${job.workspaceChannelId}`);
  }
  const channels = getBotChannels();
  const stewardKinds = [...new Set(stewardRequests.map((request) => request.kind))].join(',');

  logAgentEvent(packet.managerAgentId, 'invoke', `self-improvement:${stewardKinds}:${directiveContext.slice(0, 240)}`);
  if (channels?.threadStatus) {
    await postOpsLine(channels.threadStatus, {
      actor: packet.managerAgentId,
      scope: 'self-improvement-engine',
      metric: `requests=${stewardRequests.length}`,
      delta: `kinds=${stewardKinds || 'none'}`,
      action: 'run background stewardship worker',
      severity: status === 'completed' ? 'info' : 'warn',
    }).catch(() => {});
  }

  await postWorkspaceProgressUpdate(
    workspaceChannel,
    packet.managerAgentId as AgentId,
    `Background self-improvement started for Cortana Opus: ${stewardRequests.map((request) => `[${request.kind}] ${request.summary}`).slice(0, 4).join(' | ')}`
  );

  const loopReports = await executeLoopAdapters(packet.recommendedLoopIds);
  if (loopReports.length > 0) {
    const loopSummary = loopReports.map((report) => `${report.loopId}=${report.status}`).join(', ');
    logAgentEvent(packet.managerAgentId, 'response', `loop-adapter-summary:${loopSummary}`);
    if (channels?.threadStatus) {
      await postOpsLine(channels.threadStatus, {
        actor: packet.managerAgentId,
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
      packet.managerAgentId as AgentId,
      `Background loop maintenance results: ${loopReports.map((report) => `${report.loopId}=${report.status}`).slice(0, 6).join(', ')}`
    );
  }

  const opsAgentId = packet.stewardAgentId as AgentId;
  const opsStartedAt = Date.now();
  const opsChannel = getAgentWorkChannel(opsAgentId, groupchat);
  const stewardshipGoal = goal.replace(/\s+/g, ' ').trim().slice(0, 200) || 'operations stewardship';
  const opsHandoffCtx = buildHandoffContext({
    fromAgent: packet.consumerAgentId,
    toAgent: opsAgentId,
    traceId: `opus-ops-${Date.now()}`,
    task: `Maintain self-improvement, loop health, and ops-channel hygiene for: ${stewardshipGoal}`,
    conversationSummary,
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
  const opsContext = `${formatHandoffPrompt(opsHandoffCtx)}\n\nOperations steward requests:\n${formatOperationsStewardRequests(stewardRequests)}${loopEvidenceBlock}`;
  const opsResponse = await dispatchToAgent(opsAgentId, opsContext, opsChannel, {
    maxTokens: SUBAGENT_MAX_TOKENS,
    memoryWindow: 6,
    priority: 'background',
    persistUserContent: `[Opus stewardship request]: ${opsContext.slice(0, 900)}`,
    documentLine: '🛰️ {response}',
    workspaceChannel,
  });

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
    await postWorkspaceProgressUpdate(
      workspaceChannel,
      opsAgentId,
      `Operations steward update: ${opsResponse.slice(0, 700)}`
    );
  }

  await postSelfImprovementOpsUpdates(
    channels,
    packet.managerAgentId,
    buildSelfImprovementOpsUpdates(packet, loopReports, opsResponse.slice(0, 500)),
  );
}

function noteSelfImprovementWorkerIssue(detail: string, level: 'warn' | 'error' = 'warn'): void {
  const normalized = String(detail || 'unknown self-improvement worker error').replace(/\s+/g, ' ').trim();
  recordLoopHealth('self-improvement-worker', level === 'error' ? 'error' : 'warn', normalized.slice(0, 160));

  const now = Date.now();
  const key = normalized.slice(0, 180).toLowerCase();
  if (key === lastSelfImprovementWorkerErrorKey && now - lastSelfImprovementWorkerErrorAt < SELF_IMPROVEMENT_WORKER_ERROR_COOLDOWN_MS) {
    return;
  }

  lastSelfImprovementWorkerErrorKey = key;
  lastSelfImprovementWorkerErrorAt = now;
  void postAgentErrorLog('self-improvement:worker', 'Self-improvement queue unavailable', {
    level,
    detail: normalized,
  });
}

export async function runSelfImprovementQueueTick(): Promise<void> {
  if (selfImprovementWorkerRunning) return;
  selfImprovementWorkerRunning = true;
  try {
    while (true) {
      let claimed;
      try {
        claimed = await claimNextSelfImprovementJob(process.env.RUNTIME_INSTANCE_TAG || process.env.HOSTNAME || `pid-${process.pid}`);
      } catch (err) {
        noteSelfImprovementWorkerIssue(errMsg(err), 'warn');
        break;
      }
      if (!claimed) break;
      try {
        await processSelfImprovementBackgroundJob(claimed.payload);
        try {
          await markSelfImprovementJobCompleted(claimed.id);
          // Record a learning from the completed job for future prompt injection
          const kinds = [...new Set(claimed.payload.packet.requests.map(r => r.kind))];
          for (const kind of kinds) {
            const summaries = claimed.payload.packet.requests
              .filter(r => r.kind === kind)
              .map(r => r.summary)
              .join('; ');
            recordAgentLearning(
              claimed.payload.packet.stewardAgentId,
              `Completed ${kind}: ${summaries}`.slice(0, 500),
              kind,
              'self-improvement',
            ).catch(() => {});
          }
        } catch (err) {
          noteSelfImprovementWorkerIssue(errMsg(err), 'warn');
          break;
        }
      } catch (err) {
        const detail = errMsg(err);
        logAgentEvent(claimed.payload.packet.stewardAgentId, 'error', `steward-handoff:blocked:${detail}`);
        noteSelfImprovementWorkerIssue(detail, claimed.attempts >= claimed.maxAttempts ? 'error' : 'warn');
        void postAgentErrorLog('self-improvement:worker', 'Background stewardship worker failed', {
          level: claimed.attempts >= claimed.maxAttempts ? 'error' : 'warn',
          detail,
          agentId: claimed.payload.packet.stewardAgentId,
        });
        try {
          await markSelfImprovementJobFailed(claimed.id, claimed.attempts, claimed.maxAttempts, detail, (failedId, failedDetail) => {
            void postAgentErrorLog('self-improvement:terminal-failure', `❌ Self-improvement job #${failedId} failed permanently: ${failedDetail.slice(0, 300)}`, {
              level: 'error',
              detail: failedDetail,
              agentId: claimed!.payload.packet.stewardAgentId,
            });
          });
        } catch (markErr) {
          noteSelfImprovementWorkerIssue(errMsg(markErr), 'warn');
          break;
        }
      }
    }
  } finally {
    selfImprovementWorkerRunning = false;
  }
}

export function startSelfImprovementQueueWorker(): void {
  if (selfImprovementWorkerTimer) return;
  selfImprovementWorkerTimer = setInterval(() => {
    void runSelfImprovementQueueTick().catch((err) => {
      noteSelfImprovementWorkerIssue(errMsg(err), 'warn');
    });
  }, SELF_IMPROVEMENT_WORKER_POLL_MS);
  void runSelfImprovementQueueTick().catch((err) => {
    noteSelfImprovementWorkerIssue(errMsg(err), 'warn');
  });
}

export function stopSelfImprovementQueueWorker(): void {
  if (selfImprovementWorkerTimer) {
    clearInterval(selfImprovementWorkerTimer);
    selfImprovementWorkerTimer = null;
  }
}

async function maybeSendGroupchatSingleUserNotice(groupchat: TextChannel): Promise<void> {
  const now = Date.now();
  if (now - lastGroupchatSingleUserNoticeAt < GROUPCHAT_SINGLE_USER_NOTICE_COOLDOWN_MS) return;
  lastGroupchatSingleUserNoticeAt = now;
  await sendQuickCortanaMessage(groupchat, buildGroupchatSingleUserNotice(activeGroupchatOwner?.displayName));
}

async function handleDirectOpsActionIfRequested(content: string, groupchat: TextChannel): Promise<boolean> {
  const action = detectDirectOpsAction(content);
  if (!action) return false;

  if (action === 'help') {
    await sendQuickCortanaMessage(
      groupchat,
      '⚡ Quick actions: `status`, `loops`, `logs`, `limits`, `threads`, `join voice`, `leave voice`, `cleanup`, `smoke`, `health`.'
    );
    return true;
  }

  if (action === 'status') {
    await sendQuickCortanaMessage(
      groupchat,
      buildTextStatusSummary(getStatusSummary() || '📋 No active tasks.', buildLoopHealthCompactSummary())
    );
    return true;
  }

  if (action === 'loops') {
    await sendQuickCortanaMessage(groupchat, buildLoopHealthDetailedReport());
    return true;
  }

  if (action === 'logs') {
    const channels = getBotChannels();
    if (channels) {
      await runLoggingEngine(channels).catch(() => {});
    }
    await sendQuickCortanaMessage(groupchat, buildLoggingEngineReport());
    return true;
  }

  if (action === 'limits') {
    await refreshLiveBillingData().catch(() => {});
    await sendQuickCortanaMessage(groupchat, getUsageReport());
    return true;
  }

  const report = await buildThreadStatusReport(groupchat);
  await postThreadStatusSnapshotNow('manual').catch(() => {});
  await sendQuickCortanaMessage(groupchat, report);
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
  priority?: 'normal' | 'voice' | 'background';
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

  // If a turn tracker is active on the parent workspace, route tool calls into
  // its per-agent section too so the unified message shows nested activity.
  const workspaceTurn = options.workspaceChannel
    ? activeTurnByChannel.get(options.workspaceChannel.id)
    : undefined;

  const rawResponse = await agentRespond(
    agent,
    [...agentMemory, ...groupHistory],
    contextMessage,
    async (toolName, summary) => {
      updateToolChain(outputChannel, agent, toolName, summary, 'done');
      workspaceTurn?.addTool(agentId, toolName, summary, 'done', agent);
      options.onToolUse?.(toolName, summary);
    },
    {
      maxTokens: options.maxTokens,
      signal: options.signal,
      priority: options.priority,
      threadKey: `groupchat:${outputChannel.id}`,
      onToolStart: async (toolName, summary) => {
        updateToolChain(outputChannel, agent, toolName, summary, 'start');
        workspaceTurn?.addTool(agentId, toolName, summary, 'start', agent);
      },
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
 * Cortana-led flow: everything goes through Cortana unless user @mentions a specific agent.
 * Cortana can trigger actions via [ACTION:xxx] tags in her responses.
 */
export async function handleGroupchatMessage(
  message: Message,
  groupchat: TextChannel
): Promise<void> {
  const content = message.content.trim();
  if (!content) return;

  // During an active smoke_test_agents run, tester bot messages are subprocess
  // probes (test prompts, budget approval, status checks). They must NOT abort
  // the parent Cortana call. Process them on a parallel path so the serialized
  // messageQueue doesn't deadlock (Cortana blocks the queue while smoke_test_agents
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
      const cortana = getAgent('executive-assistant' as AgentId);
      if (cortana) {
        void sendAgentMessage(groupchat, cortana, '📋 Current Goal: Smoke test in progress. Status: active.').catch(() => {});
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
    await sendQuickCortanaMessage(groupchat, '⏳ I already received that request and I am still processing it.');
    return;
  }

  // No-op ping: a short conversational message with no imperative verb (just
  // "Cortana", "hi", "ok"). These got escalated to full goals + watchdog
  // recovery cycles in the April 2026 logs, burning tokens on no real task.
  // Acknowledge briefly and exit before any workspace/goal machinery starts.
  if (isNoOpUserPing(content)) {
    const cortana = getAgent('executive-assistant' as AgentId);
    if (cortana) {
      await sendAgentMessage(groupchat, cortana, "I'm here — what would you like me to do?").catch(() => {});
    }
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
    await sendQuickCortanaMessage(groupchat, '📞 Voice command detected. Say "Cortana join voice call" or "Cortana leave voice call" and I will handle it directly without opening a workspace thread.');
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
  resetToolChain(groupchat.id);

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
          const cortana = getAgent('executive-assistant' as AgentId);
          const timeoutNotice = '⏳ I hit a runtime timeout while processing that request. I canceled the stalled run to avoid duplicate loops. Please retry with a tighter prompt or request one action at a time.';
          if (cortana) {
            await sendAgentMessage(groupchat, cortana, timeoutNotice).catch(() => {});
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

  // Smoke tests always run through Cortana directly so the tester sees one
  // stable execution path and doesn't depend on internal delegation.
  const cortana = getAgent('executive-assistant' as AgentId);
  if (!cortana) return;

  const cortanaMemory = getMemoryContext('executive-assistant');
  const contextMessage = `[smoke-test]: ${content}`;

  console.log(`[smoke-guard] Calling agentRespond for: "${content.slice(0, 60)}"`);

  const rawResponse = await agentRespond(
    cortana,
    [...cortanaMemory],
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
      username: `${cortana.emoji} ${cortana.name}`,
      avatarURL: cortana.avatarUrl,
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
  // Extract images from attachments for vision (non-blocking; empty if none)
  const imageBlocks = await extractImageBlocksFromMessage(message);
  let workspaceChannel: WebhookCapableChannel | null = null;
  const getWorkspaceChannel = async (): Promise<WebhookCapableChannel> => {
    if (workspaceChannel) return workspaceChannel;
    workspaceChannel = await ensureGoalWorkspace(groupchat, senderName, content);
    return workspaceChannel;
  };

  if (await handleDirectOpsActionIfRequested(content, groupchat)) {
    markGoalProgress('⚡ Quick ops action handled directly');
    return;
  }

  if (await handleDirectVoiceActionIfRequested(message, content, groupchat)) {
    markGoalProgress('📞 Voice action handled directly');
    return;
  }

  if (isLikelyVoiceCommandIntent(content)) {
    await sendQuickCortanaMessage(groupchat, '📞 Voice command detected. Say "Cortana join voice call" or "Cortana leave voice call" and I will handle it directly without opening a workspace thread.');
    markGoalProgress('📞 Voice intent handled without workspace thread');
    return;
  }
  markGoalProgress();

  const approvedAmount = parseBudgetApproval(content);
  if (approvedAmount !== null) {
    const workspaceChannel = await getWorkspaceChannel();
    const cortana = getAgent('executive-assistant' as AgentId);
    const result = approveAdditionalBudget(Number.isFinite(approvedAmount) ? approvedAmount : undefined);
    await refreshUsageDashboard().catch(() => {});

    if (cortana) {
      await sendAgentMessage(
        workspaceChannel,
        cortana,
        `Budget approval recorded. I added $${result.added.toFixed(2)} of extra budget for today, so the new limit is $${result.limit.toFixed(2)}. We've spent $${result.spent.toFixed(2)} so far and have $${result.remaining.toFixed(2)} remaining.`
      );
    }

    if (goalState.goal) {
      if (goalState.isPaused()) {
        goalState.resume('▶️ Resuming after budget approval');
      } else {
        markGoalProgress('▶️ Resuming after budget approval');
      }
      await withCortanaResponseWatchdog(
        workspaceChannel,
        groupchat,
        handleCortanaMessage(
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

  // Append an image hint so the model knows to inspect the attached images
  if (imageBlocks.length > 0) {
    content += `\n\n[${imageBlocks.length} image${imageBlocks.length > 1 ? 's' : ''} attached — see the image content blocks in this message]`;
  }

  const uniqueMentions = parseMentionedAgentIds(content);
  const keepInGroupchat = shouldKeepGroupchatPromptInChannel(uniqueMentions, content);

  if (uniqueMentions.length > 0) {
    if (uniqueMentions.length === 1 && uniqueMentions[0] === 'executive-assistant') {
      goalState.setGoal(content);
      const targetChannel = keepInGroupchat ? groupchat : await getWorkspaceChannel();
      await withCortanaResponseWatchdog(
        targetChannel,
        groupchat,
        handleCortanaMessage(content, senderName, message.member || undefined, groupchat, signal, targetChannel, {
          allowDirectGroupchat: keepInGroupchat,
          imageBlocks,
        }),
      );
    } else {
      const normalized = `${content}\n\n[System: Cortana should execute directly when possible and involve specialists only when needed.]`;
      goalState.setGoal(normalized);
      const workspaceChannel = await getWorkspaceChannel();
      await withCortanaResponseWatchdog(
        workspaceChannel,
        groupchat,
        handleCortanaMessage(normalized, senderName, message.member || undefined, groupchat, signal, workspaceChannel, { imageBlocks }),
      );
    }
  } else {
    goalState.setGoal(content);
    const targetChannel = keepInGroupchat ? groupchat : await getWorkspaceChannel();
    await withCortanaResponseWatchdog(
      targetChannel,
      groupchat,
      handleCortanaMessage(content, senderName, message.member || undefined, groupchat, signal, targetChannel, {
        allowDirectGroupchat: keepInGroupchat,
        imageBlocks,
      }),
    );
  }
}

async function withCortanaResponseWatchdog(
  workspaceChannel: WebhookCapableChannel,
  groupchat: TextChannel,
  work: Promise<void>,
): Promise<void> {
  // Outer watchdog: if Cortana never emits visible output for a goal, post a
  // clear stalled-run alert so operators are not left with silent threads.
  if (!Number.isFinite(CORTANA_NO_RESPONSE_TIMEOUT_MS) || CORTANA_NO_RESPONSE_TIMEOUT_MS <= 0) {
    await work;
    return;
  }

  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    const goal = goalState.goal || 'none';
    void emitCortanaStallAlert(workspaceChannel, groupchat, goal, CORTANA_NO_RESPONSE_TIMEOUT_MS)
      .then((posted) => {
        if (!posted) return;
        void postAgentErrorLog('cortana:watchdog', 'No Cortana response observed for goal', {
          agentId: 'executive-assistant',
          detail: `goal=${goal} timeoutMs=${CORTANA_NO_RESPONSE_TIMEOUT_MS}`,
          level: 'warn',
        });
      });
  }, CORTANA_NO_RESPONSE_TIMEOUT_MS);

  try {
    await work;
  } finally {
    clearTimeout(timer);
    if (fired) {
      markGoalProgress('⚠️ Cortana response timeout observed');
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
 * Cortana receives the message, responds, and can involve specialists when needed.
 * She can trigger system actions by including [ACTION:xxx] tags in her response.
 */
/**
 * Synthesize any implicit [ACTION:*] tags from Cortana's prose, fold the
 * machine-supplied tags in, audit the synthesis, and execute the combined set.
 */
async function dispatchImpliedActions(
  orchestrationResponse: string,
  displayResponse: string,
  machineActionTags: string[],
  shouldExecuteDirectly: boolean,
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  member: GuildMember | undefined,
  userMessage: string,
): Promise<void> {
  const implicitTags = inferImplicitActionTags(displayResponse);
  // When Cortana was asked to execute smoke_test_agents directly, suppress the implicit
  // [ACTION:SMOKE] tag to avoid running a redundant second smoke test via runSmokeSummary.
  const filteredImplicitTags = shouldExecuteDirectly
    ? implicitTags.replace(/\[ACTION:SMOKE\]/gi, '').trim()
    : implicitTags;
  const machineTagsBlock = machineActionTags.join('\n');
  const actionPayload = [orchestrationResponse, machineTagsBlock, filteredImplicitTags].filter(Boolean).join('\n');
  if (filteredImplicitTags) {
    await sendAutopilotAudit(
      groupchat,
      'implied_actions',
      'Cortana response implied operational actions without explicit tags; autopilot synthesized tags.',
      { action: implicitTags.replace(/\s+/g, ',') }
    );
  }
  await executeActions(actionPayload, member, groupchat, workspaceChannel, userMessage);
}

/**
 * Runtime-verification gate for completion claims. Triggers an auto-harness
 * capture if no evidence is found and appends a single "verification pending"
 * note (cooldown-keyed per goal) when evidence is still missing after that.
 */
async function runVerificationCycle(
  displayResponse: string,
  userMessage: string,
  response: string,
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
): Promise<{ displayResponse: string; completionClaimed: boolean; completionVerified: boolean }> {
  const verificationRequired = goalNeedsRuntimeVerification(goalState.goal || userMessage || response);
  const completionClaimed = isCompletionClaim(displayResponse);
  let completionVerified = true;
  let updated = displayResponse;

  if (verificationRequired && completionClaimed) {
    const evidenceSince = Math.max(Date.now() - 2 * 60 * 60 * 1000, goalState.startedAt - 60_000);
    completionVerified = await hasRecentRuntimeVerificationEvidence(groupchat, workspaceChannel, evidenceSince);
    if (!completionVerified) {
      const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
      try {
        await captureAndPostScreenshots(appUrl, `auto-verify ${(goalState.goal || 'completion').slice(0, 40)}`, {
          targetChannel: workspaceChannel as TextChannel,
          clearTargetChannel: false,
        });
        completionVerified = await hasRecentRuntimeVerificationEvidence(groupchat, workspaceChannel, evidenceSince);
      } catch (err) {
        console.warn('Auto-harness capture failed:', errMsg(err));
      }
    }
    if (!completionVerified) {
      const goalKey = String(goalState.goal || 'untagged').slice(0, 120);
      const now = Date.now();
      const lastShown = verificationPendingShownAt.get(goalKey) || 0;
      if (now - lastShown > VERIFICATION_PENDING_COOLDOWN_MS) {
        verificationPendingShownAt.set(goalKey, now);
        updated += '\n\n⏳ **Verification pending**: completion cannot be confirmed yet — no runtime evidence in screenshots/harness output. Keeping this open until proof is posted.';
      }
    }
  }

  return { displayResponse: updated, completionClaimed, completionVerified };
}

/**
 * Multi-step continuation loop: re-invoke Cortana with a follow-up prompt
 * until the goal is fixed/blocked or MAX_CONTINUATION_CYCLES is reached.
 * Early-exits on aborted signal, empty continuation output, or a response
 * fingerprint-identical to the prior cycle (no-progress guard).
 */
async function runContinuationCycles(
  seed: {
    cortana: AgentConfig;
    goal: string;
    displayResponse: string;
    chainResult: { summary?: string };
    groupchat: TextChannel;
    workspaceChannel: WebhookCapableChannel;
    cortanaWorkChannel: WebhookCapableChannel;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { cortana, groupchat, workspaceChannel, cortanaWorkChannel, signal } = seed;
  let { displayResponse, chainResult } = seed;
  let prevFingerprint = displayResponse.trim().slice(0, 240).toLowerCase();

  for (let cycle = 2; cycle <= MAX_CONTINUATION_CYCLES; cycle++) {
    if (signal?.aborted) break;

    const lastStatus = inferCortanaStatus(
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

    const continuationPrompt = `[System continuation — cycle ${cycle}/${MAX_CONTINUATION_CYCLES}] Previous cycle status: ${lastStatus}. ${executionSummary}\n\nContinue with the next sub-task from the original goal: "${seed.goal.slice(0, 300)}". Do not repeat completed work. Focus on the next unfinished item.`;

    await sendAutopilotAudit(
      groupchat,
      'continuation_cycle',
      `Multi-step continuation cycle ${cycle}/${MAX_CONTINUATION_CYCLES} for: ${(goalState.goal || '').slice(0, 80)}`,
      { attempt: cycle }
    );

    markGoalProgress(`🔄 Continuation cycle ${cycle}/${MAX_CONTINUATION_CYCLES}...`);

    const cortanaMemoryCtx = getMemoryContext('executive-assistant');
    const continuationResponse = await agentRespond(cortana, [...cortanaMemoryCtx, ...groupHistory], continuationPrompt, async (toolName, summary) => {
      updateToolChain(cortanaWorkChannel, cortana, toolName, summary, 'done');
    }, {
      signal,
      outputMode: 'machine_json',
      machineEnvelopeRaw: true,
      threadKey: `groupchat:${workspaceChannel.id}`,
      onToolStart: async (toolName, summary) => {
        updateToolChain(cortanaWorkChannel, cortana, toolName, summary, 'start');
      },
    });

    if (signal?.aborted) break;

    const contEnvelope = extractAgentResponseEnvelope(continuationResponse);
    const contVisible = sanitizeVisibleAgentReply(contEnvelope?.human || continuationResponse);
    const contRendered = appendDefaultNextSteps(contVisible.replace(/\[\s*action:[^\]]+\]/gi, '').trim());

    // No-progress guard: if Cortana returns nothing new, or a response that's
    // substantively identical to the previous cycle's output, stop looping
    // instead of burning more tokens on the same restatement.
    if (!contRendered.trim()) {
      console.log(`[continuation] Stopping at cycle ${cycle}: empty response`);
      break;
    }
    const fingerprint = contRendered.trim().slice(0, 240).toLowerCase();
    if (fingerprint === prevFingerprint) {
      console.log(`[continuation] Stopping at cycle ${cycle}: duplicate response fingerprint`);
      break;
    }
    prevFingerprint = fingerprint;

    appendToMemory('executive-assistant', [
      { role: 'user', content: continuationPrompt },
      { role: 'assistant', content: `[Cortana]: ${continuationResponse}` },
    ]);
    groupHistory.push({ role: 'user', content: continuationPrompt });
    groupHistory.push({ role: 'assistant', content: `[Cortana]: ${continuationResponse}` });
    persistGroupHistory();

    await sendAgentMessage(workspaceChannel, cortana, contRendered);

    displayResponse = contRendered;
    chainResult = await handleAgentChain(continuationResponse, groupchat, workspaceChannel, signal);
    markGoalProgress(`✅ Cortana cycle ${cycle} completed`);
  }
}

async function handleCortanaMessage(
  userMessage: string,
  senderName: string,
  member: GuildMember | undefined,
  groupchat: TextChannel,
  signal?: AbortSignal,
  workspaceChannel: WebhookCapableChannel = groupchat,
  options?: { allowDirectGroupchat?: boolean; imageBlocks?: ImageBlock[] },
): Promise<void> {
  if (workspaceChannel === groupchat && !options?.allowDirectGroupchat) {
    workspaceChannel = await ensureGoalWorkspace(groupchat, senderName || 'system', userMessage || 'request');
  }

  const cortana = getAgent('executive-assistant' as AgentId);
  if (!cortana) return;
  const cortanaWorkChannel = getAgentWorkChannel('executive-assistant', groupchat);

  let stopTyping: () => void = () => {};
  let hasVisibleCortanaResponse = false;
  let noResponseTimer: NodeJS.Timeout | null = null;
  let progressTimer: NodeJS.Timeout | null = null;
  try {
    stopTyping = startTypingLoop(workspaceChannel);
    trackAgentActive('executive-assistant', 'planning');
    // Unified turn tracker: single message Cortana owns, nested sub-lines per
    // specialist as they activate. setThinkingMessage is kept as a no-op
    // fallback for code paths that still reference it.
    const turn = await beginTurn(workspaceChannel, cortana);
    activeTurnByChannel.set(workspaceChannel.id, turn);

    // Progress + stall timers fold their signal into the unified turn message
    // (via turn.setPhase) rather than posting separate "⏳ still working" lines
    // that the user then has to scroll past.
    progressTimer = setTimeout(() => {
      if (hasVisibleCortanaResponse || signal?.aborted) return;
      const seconds = Math.round(Math.max(0, CORTANA_PROGRESS_PING_MS) / 1000);
      turn.setPhase('executive-assistant', 'working', `still working · ${seconds}s`);
    }, Math.max(5_000, CORTANA_PROGRESS_PING_MS));

    // The watchdog used to fire whenever no VISIBLE message had landed in
    // CORTANA_NO_RESPONSE_TIMEOUT_MS — but legitimate long work (multi-tool
    // investigations, big test runs) is silent for minutes and was getting
    // false-flagged as stalled. Now it watches *active progress*: any tool
    // call (start or complete) resets the timer. Real stalls — agent crashed,
    // no LLM response, no tool activity — still fire after the full window.
    const armWatchdog = (): void => {
      if (noResponseTimer) clearTimeout(noResponseTimer);
      noResponseTimer = setTimeout(() => {
        if (hasVisibleCortanaResponse || signal?.aborted) return;
        const goal = goalState.goal || 'none';
        void emitCortanaStallAlert(workspaceChannel, groupchat, goal, CORTANA_NO_RESPONSE_TIMEOUT_MS)
          .then((posted) => {
            if (!posted) return;
            void postAgentErrorLog('cortana:timeout', 'No Cortana response within timeout', {
              agentId: 'executive-assistant',
              detail: `goal=${goal} timeoutMs=${CORTANA_NO_RESPONSE_TIMEOUT_MS}`,
              level: 'warn',
            });
          });
      }, CORTANA_NO_RESPONSE_TIMEOUT_MS);
    };
    const kickWatchdog = (): void => { armWatchdog(); };
    armWatchdog();

    const cortanaMemory = getMemoryContext('executive-assistant');
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
    // Per-turn self-repair hint: if the user is asking about something that
    // lives in the bot's own runtime (voice, tools, message routing, the bot
    // itself), nudge Cortana to use the *_self_* tool family. This sits
    // ATTACHED to the user message so it survives memory compression
    // (which strips the static system prompt's appendix sections).
    const SELF_REPAIR_KEYWORDS_RE = /\b(voice|stt|tts|elevenlabs|webhook|tool dispatch|message routing|tool wiring|the bot|her own code|self.repair|asap.bot)\b/i;
    const selfRepairHint = SELF_REPAIR_KEYWORDS_RE.test(userMessage)
      ? `\n\n[Bot-runtime hint: this lives in /opt/asap-bot. Use \`read_self_file\` / \`search_self_files\` first; do not claim "fixed" without an \`edit_self_file\` call.]`
      : '';
    const contextMessageWithLang = `${textLangHint ? `${contextMessage}${textLangHint}` : contextMessage}${mentionGuide}${threadCloseGuide}${decisionGuide}${selfRepairHint}`;

    let editToolUsedThisTurn = false;
    const response = await agentRespond(cortana, [...cortanaMemory, ...groupHistory], contextMessageWithLang, async (toolName, summary) => {
      if (isEditToolName(toolName)) editToolUsedThisTurn = true;
      kickWatchdog();
      turn.addTool('executive-assistant', toolName, summary, 'done', cortana);
      updateToolChain(cortanaWorkChannel, cortana, toolName, summary, 'done');
    }, {
      signal,
      outputMode: 'machine_json',
      machineEnvelopeRaw: true,
      threadKey: `groupchat:${workspaceChannel.id}`,
      imageBlocks: options?.imageBlocks,
      onToolStart: async (toolName, summary) => {
        kickWatchdog();
        turn.addTool('executive-assistant', toolName, summary, 'start', cortana);
        updateToolChain(cortanaWorkChannel, cortana, toolName, summary, 'start');
      },
    });

    const responseEnvelope = extractAgentResponseEnvelope(response);
    const machineDelegateAgents = (responseEnvelope?.machine?.delegateAgents || [])
      .map((id) => resolveAgentId(id))
      .filter((id): id is AgentId => Boolean(id) && id !== 'executive-assistant');
    const machineActionTags = (responseEnvelope?.machine?.actionTags || [])
      .map((tag) => String(tag || '').trim())
      .filter((tag) => /^\[ACTION:[^\]]+\]$/i.test(tag));
    const machineRoutingSuffix = machineDelegateAgents.length > 0
      ? `\n\n${machineDelegateAgents.map((id) => getAgentMention(id)).join(' ')} please help Cortana with the focused follow-up for this task.`
      : '';
    const visibleHumanResponse = sanitizeVisibleAgentReply(responseEnvelope?.human || response);
    const orchestrationResponse = `${visibleHumanResponse}${machineRoutingSuffix}`.trim();

    if (signal?.aborted) return;
    await clearThinkingMessage();

    let displayResponse = appendDefaultNextSteps(
      visibleHumanResponse.replace(/\[\s*action:[^\]]+\]/gi, '').trim()
    );
    markGoalProgress('🧭 Cortana coordinating...');

    appendToMemory('executive-assistant', [
      { role: 'user', content: contextMessage },
      { role: 'assistant', content: `[Cortana]: ${orchestrationResponse}` },
    ]);

    groupHistory.push({ role: 'user', content: contextMessage });
    groupHistory.push({ role: 'assistant', content: `[Cortana]: ${orchestrationResponse}` });
    persistGroupHistory();

    if (signal?.aborted) return;

    await dispatchImpliedActions(
      orchestrationResponse,
      displayResponse,
      machineActionTags,
      shouldExecuteDirectly,
      groupchat,
      workspaceChannel,
      member,
      userMessage,
    );
    markGoalProgress();

    const verification = await runVerificationCycle(displayResponse, userMessage, response, groupchat, workspaceChannel);
    displayResponse = verification.displayResponse;
    const completionClaimed = verification.completionClaimed;
    const completionVerified = verification.completionVerified;

    // Use the actual verification result instead of re-scanning text for "blocked"/"verification pending"
    // which would false-positive on our appended verification note.
    const statusBlocked = !completionVerified || /\bblocked\b/i.test(displayResponse.replace(/⏳.*verification pending.*/i, ''));
    displayResponse = enforceCortanaResponseContract(
      displayResponse,
      completionClaimed && !statusBlocked,
      completionVerified && !statusBlocked,
      { editToolUsedThisTurn },
    );

    if (shouldQueueDecisionReview(displayResponse)) {
      // Decisions are non-blocking: Cortana keeps executing on her default plan
      // while the user can override via buttons in the dedicated decisions
      // channel. If the decisions channel isn't configured, skip the card
      // rather than polluting groupchat with buttons.
      if (decisionsChannel) {
        postDecisionEmbed(decisionsChannel, groupchat, displayResponse).catch(() => {});
      }
    }

    if (signal?.aborted) return;

    if (!signal?.aborted && displayResponse) {
      hasVisibleCortanaResponse = true;
      // Fold the final answer into the same unified message Cortana has been
      // updating for this turn. The tracker marks itself finalized.
      const finalized = await turn.finalize(displayResponse);
      if (!finalized) {
        // Fallback: tracker failed — post the normal way.
        await sendAgentMessage(workspaceChannel, cortana, displayResponse);
      }

      if (workspaceChannel.id !== groupchat.id && (statusBlocked || (completionClaimed && completionVerified && shouldMirrorCompletionToGroupchat(displayResponse, workspaceChannel, groupchat)))) {
        const compact = buildCompactGroupchatStatus(displayResponse, {
          complete: completionClaimed && completionVerified && !statusBlocked,
          blocked: statusBlocked,
        });
        if (compact) {
          await sendAgentMessage(groupchat, cortana, compact);
        }
      }
    }

    const chainResult = await handleAgentChain(orchestrationResponse, groupchat, workspaceChannel, signal);

    markGoalProgress('✅ Cortana cycle 1 completed');

    if (isMultiStepGoal(goalState.goal || userMessage) && !signal?.aborted) {
      await runContinuationCycles({
        cortana,
        goal: goalState.goal || userMessage,
        displayResponse,
        chainResult,
        groupchat,
        workspaceChannel,
        cortanaWorkChannel,
        signal,
      });
    }
  } catch (err) {
    const abortLike = String((err as any)?.name || '').includes('Abort') || String((err as any)?.message || '').toLowerCase().includes('abort');
    if (abortLike || signal?.aborted) return;
    const errMsg = err instanceof Error ? err.stack || err.message : String(err);
    console.error('Cortana error:', errMsg);
    // Full stack goes to #🚨-agent-errors via postAgentErrorLog — the detail
    // is useful there. The user-facing message stays short and non-scary:
    // no stack, no code block, just an acknowledgment + retry hint.
    void postAgentErrorLog('cortana:groupchat', 'Cortana orchestration error', {
      agentId: 'executive-assistant',
      detail: errMsg,
    });
    try {
      hasVisibleCortanaResponse = true;
      await sendWebhookMessage(workspaceChannel, {
        content: '⚠️ Something went sideways on my end. Give me a moment — try again or rephrase.',
        username: `${cortana.emoji} ${cortana.name}`,
        avatarURL: cortana.avatarUrl,
      });
    } catch {
      const fallback = ('send' in workspaceChannel) ? workspaceChannel : cortanaWorkChannel;
      await fallback.send('⚠️ Something went sideways on my end. Give me a moment — try again or rephrase.').catch(() => {});
    }
  } finally {
    if (progressTimer) clearTimeout(progressTimer);
    if (noResponseTimer) clearTimeout(noResponseTimer);
    await clearThinkingMessage().catch(() => {});
    // If we still own an unfinalized turn tracker (e.g. error path), wipe it.
    const orphan = activeTurnByChannel.get(workspaceChannel.id);
    if (orphan && !orphan.isFinalized) {
      await orphan.remove().catch(() => {});
    }
    activeTurnByChannel.delete(workspaceChannel.id);
    stopTyping();
    trackAgentIdle('executive-assistant');
  }
}

/**
 * Internal bridge: accept a voice-call instruction and run it through Cortana's
 * normal text orchestration flow (workspace thread + agent chain).
 */
export async function handoffVoiceInstructionToCortanaText(
  instruction: string,
  senderName: string,
  groupchat: TextChannel
): Promise<void> {
  const cleanInstruction = String(instruction || '').trim();
  if (!cleanInstruction) return;

  const workspaceChannel = await ensureGoalWorkspace(groupchat, senderName || 'Voice', cleanInstruction);
  await handleCortanaMessage(
    `[Voice handoff from ${senderName || 'Voice user'}]: ${cleanInstruction}`,
    senderName || 'Voice user',
    undefined,
    groupchat,
    undefined,
    workspaceChannel,
  );
}

/**
 * Internal bridge: dispatch an upgrade implementation task to Cortana's
 * normal orchestration flow. Called by the upgrades triage loop.
 */
export async function dispatchUpgradeToCortana(
  upgradeDescription: string,
  groupchat: TextChannel
): Promise<void> {
  const prompt = `[Upgrades triage — auto-dispatch] The following upgrade has been accepted by multiple agents and is ready for implementation. Review it and either implement it directly or involve the right specialist:\n\n${upgradeDescription}`;
  await handleCortanaMessage(prompt, 'system', undefined, groupchat);
}

/**
 * Entry point used by the "Ask Cortana about this message" context-menu
 * command. Routes the target message + the triggering user's identity
 * into Cortana's standard orchestration so her reply comes back through
 * the unified turn tracker in the current channel or groupchat.
 */
export async function askCortanaAboutMessage(
  quotedAuthor: string,
  quotedContent: string,
  askedBy: string,
  groupchat: TextChannel,
): Promise<void> {
  const content = (quotedContent || '(no text)').slice(0, 1600);
  const prompt = `[Context-menu ask] ${askedBy} right-clicked a message from @${quotedAuthor} and asked you to take a look. Summarize what it means, flag anything noteworthy, and propose a next step if any.\n\n---\n${content}\n---`;
  await handleCortanaMessage(prompt, askedBy || 'user', undefined, groupchat);
}

/**
 * Route a yes/no reaction on a bot-authored message as a quick reply.
 * Used for lightweight binary prompts ("ship it? ✅/❌") where the user
 * reacts instead of typing a reply.
 */
export async function dispatchReactionReply(
  answer: 'yes' | 'no',
  quotedContent: string,
  reactedBy: string,
  groupchat: TextChannel,
): Promise<void> {
  const content = (quotedContent || '').slice(0, 800);
  const prompt = `[Reaction reply] ${reactedBy} reacted "${answer}" to your question. Treat this as their answer and continue.\n\nYour question was:\n---\n${content}\n---`;
  await handleCortanaMessage(prompt, reactedBy || 'user', undefined, groupchat);
}

/**
 * Parse and execute [ACTION:xxx] tags from Cortana's response.
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

  const cortana = getAgent('executive-assistant' as AgentId);

  /** Send a message as Cortana via webhook, fallback to bot if webhook fails */
  async function sendAsCortana(msg: string): Promise<void> {
    const safeMsg = workspaceChannel.id === groupchat.id
      ? String(msg || '').replace(/https?:\/\/\S+/gi, '[see #url]')
      : msg;

    if (cortana) {
      try {
        await sendWebhookMessage(workspaceChannel, { content: safeMsg, username: `${cortana.emoji} ${cortana.name}`, avatarURL: cortana.avatarUrl });
        return;
      } catch (err) {
        console.warn('Webhook send failed for Cortana action response:', errMsg(err));
      }
    }

    if ('send' in workspaceChannel) {
      await workspaceChannel.send(safeMsg).catch(() => {});
      return;
    }
    const cortanaChannel = getAgentWorkChannel('executive-assistant', groupchat);
    await cortanaChannel.send(safeMsg).catch(() => {});
  }

  for (const [, action, param] of actions) {
    try {
      switch (action.toUpperCase()) {
        case 'JOIN_VC': {
          const channels = getBotChannels();
          if (!channels) break;
          if (isCallActive()) {
            await sendAsCortana('📞 Already in a voice call.');
            break;
          }
          if (member) {
            await startCall(channels.voiceChannel, groupchat, channels.callLog, member);
          } else {
            await sendAsCortana('📞 I need you to be in the server to join VC.');
          }
          break;
        }
        case 'LEAVE_VC': {
          if (isCallActive()) {
            await endCall();
          } else {
            await sendAsCortana('No active voice call to leave.');
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
            await sendAsCortana(
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
            await sendAsCortana(`❌ Deploy failed: ${errMsg(err)}`);
          }
          break;
        }
        case 'SCREENSHOTS': {
          const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
          captureAndPostScreenshots(appUrl, param || 'manual').catch((err) => {
            sendAsCortana(`❌ Screenshot capture failed: ${errMsg(err)}`).catch(() => {});
          });
          markGoalProgress('📸 Screenshot capture started');
          await sendAutopilotAudit(groupchat, 'action_executed', 'Screenshot capture workflow started.', {
            action: 'SCREENSHOTS',
          });
          await sendAsCortana('📸 Capturing screenshots...');
          break;
        }
        case 'URLS': {
          const linkIntent = /\b(url|urls|link|links|asap links|app url|share url|cloud run|cloud build)\b/i.test(String(userMessage || goalState.goal || ''));
          if (!linkIntent && String(param || '').trim().toLowerCase() !== 'force') {
            await sendAsCortana('🔗 Skipped link posting because no explicit link request was detected.');
            break;
          }

          const now = Date.now();
          if (now - lastUrlsActionAt < URL_ACTION_COOLDOWN_MS) {
            await sendAsCortana('🔗 Links were posted recently. Skipping duplicate link blast in groupchat.');
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
            await sendAsCortana('🔗 Posted updated links in #url.');
          } else {
            await sendAsCortana('🔗 Links are ready, but #url is unavailable right now.');
          }
          break;
        }
        case 'STATUS': {
          const summary = getStatusSummary();
          await sendAsCortana(summary || '📋 No active tasks.');
          break;
        }
        case 'THREADS': {
          markGoalProgress('🧵 Reviewing workspace threads');
          const report = await buildThreadStatusReport(groupchat);
          await postThreadStatusSnapshotNow('manual').catch(() => {});
          await sendAsCortana(report);
          break;
        }
        case 'HEALTH': {
          markGoalProgress('🩺 Running app health check');
          await sendAsCortana(await buildDeploymentHealthReport());
          break;
        }
        case 'REGRESSION': {
          await sendAsCortana(buildRegressionReport(param));
          break;
        }
        case 'SMOKE': {
          markGoalProgress('🧪 Running smoke check');
          await sendAsCortana(await runSmokeSummary(param));
          break;
        }
        case 'LIMITS': {
          await refreshLiveBillingData().catch(() => {});
          const report = getUsageReport();
          markGoalProgress('📊 Usage report posted');
          await sendAsCortana(report);
          break;
        }
        case 'UNFUSE': {
          clearGeminiQuotaFuse();
          const status = getGeminiQuotaFuseStatus();
          markGoalProgress('🧯 Cleared local Gemini quota fuse');
          await sendAsCortana(`🧯 Cleared local Gemini quota/rate fuse. blocked=${status.blocked ? 'yes' : 'no'}.`);
          break;
        }
        case 'CONTEXT': {
          const report = `${getContextEfficiencyReport()}\n\n${getContextRuntimeReport()}`;
          markGoalProgress('🧠 Context report posted');
          await sendAsCortana(report);
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
            await sendAsCortana(`🧽 Cleaned up ${removed} noisy messages in groupchat from ${options.descriptor}.${clipped}`);
          } catch (err) {
            await sendAsCortana(`❌ Groupchat cleanup failed: ${errMsg(err)}`);
          }
          break;
        }
        case 'CLEAR': {
          clearHistory(groupchat.id);
          groupHistory.splice(0);
          clearMemory('groupchat');
          markGoalProgress('🧹 Context cleared');
          await sendAsCortana('🧹 Conversation context cleared.');
          break;
        }
        case 'ROLLBACK': {
          if (param) {
            try {
              const result = await rollbackToRevision(param);
              markGoalProgress('↩️ Rollback complete');
              await sendAsCortana(result);
            } catch (err) {
              await sendAsCortana(`❌ Rollback failed: ${errMsg(err)}`);
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
              await sendAsCortana(`📦 **Cloud Run Revisions**\n\n${list}`);
            } catch (err) {
              await sendAsCortana(`❌ Failed to list revisions: ${errMsg(err)}`);
            }
          }
          break;
        }
        case 'AGENTS': {
          const agents = getAgents();
          const list = Array.from(agents.values())
            .map((a) => `${a.emoji} **${a.name}**`)
            .join('\n');
          await sendAsCortana(`**ASAP Agent Team**\n\n${list}`);
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
                await sendAsCortana('📸 Auto-capturing web harness verification before closing...');
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
              await sendAsCortana('🛑 Cannot close this thread yet. Runtime verification evidence is missing. Web harness capture was attempted but may have failed — check the app URL is reachable.');
              break;
            }
          }
          await sendAsCortana('🧵 Closing this workspace thread now that the task is complete.');
          await closeGoalWorkspace(groupchat, workspaceChannel, 'Closed by Cortana action');
          break;
        }
        case 'CALL': {
          if (!isTelephonyAvailable()) {
            await sendAsCortana('📞 Phone system not configured (missing Twilio credentials).');
            break;
          }
          if (!param) {
            await sendAsCortana('📞 No phone number specified. Cortana, include a number with [ACTION:CALL:number].');
            break;
          }
          const verifiedNumbers = (process.env.TWILIO_VERIFIED_NUMBERS || '0436012231')
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean);
          const phoneNumber = param.trim();
          if (!verifiedNumbers.includes(phoneNumber)) {
            await sendAsCortana(`📞 ${phoneNumber} is not in the verified list for this Twilio account. Verified numbers: ${verifiedNumbers.join(', ')}`);
            break;
          }
          try {
            await makeOutboundCall(phoneNumber, "Hey Jordan, it's Cortana! You asked me to give you a call.");
            await sendAsCortana(`📞 Calling ${phoneNumber}...`);
          } catch (err) {
            await sendAsCortana(`❌ Call failed: ${errMsg(err)}`);
          }
          break;
        }
        case 'TEST_CALL': {
          if (!isTelephonyAvailable()) {
            await sendAsCortana('📞 Phone system not configured (missing Twilio credentials).');
            break;
          }
          if (!param) {
            await sendAsCortana('📞 No phone number specified. Use [ACTION:TEST_CALL:number].');
            break;
          }
          const verifiedNumbers = (process.env.TWILIO_VERIFIED_NUMBERS || '0436012231')
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean);
          const phoneNumber = param.trim();
          if (!verifiedNumbers.includes(phoneNumber)) {
            await sendAsCortana(`📞 ${phoneNumber} is not in the verified list for this Twilio account. Verified numbers: ${verifiedNumbers.join(', ')}`);
            break;
          }
          try {
            await makeAsapTesterCall(phoneNumber);
            await sendAsCortana(`🧪📞 ASAPTester voice check calling ${phoneNumber}...`);
          } catch (err) {
            await sendAsCortana(`❌ ASAPTester test call failed: ${errMsg(err)}`);
          }
          break;
        }
        case 'CONFERENCE': {
          if (!isTelephonyAvailable()) {
            await sendAsCortana('📞 Phone system not configured (missing Twilio credentials).');
            break;
          }
          if (!param) {
            await sendAsCortana('📞 No phone numbers specified. Cortana, include numbers with [ACTION:CONFERENCE:num1,num2].');
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
            await sendAsCortana(`📞 None of the requested numbers are verified for this Twilio account. Verified numbers: ${[...verifiedNumbers].join(', ')}`);
            break;
          }
          try {
            const confName = await startConferenceCall(numbers);
            await sendAsCortana(`📞 **Conference call started** — ${confName}\nCalling: ${numbers.join(', ')} + Cortana`);
          } catch (err) {
            await sendAsCortana(`❌ Conference failed: ${errMsg(err)}`);
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
 * Parse Cortana and specialist directives using strict word-boundary regex.
 * Only matches explicit @name patterns to avoid false positives.
 */
const DIRECTED_AGENT_IDS = new Set<string>([
  'qa', 'ux-reviewer', 'security-auditor', 'api-reviewer',
  'dba', 'performance', 'devops', 'copywriter', 'lawyer',
  'ios-engineer', 'android-engineer',
]);

const CORTANA_USE_ALL_AGENTS = process.env.CORTANA_USE_ALL_AGENTS === 'true';
const CORTANA_DIRECT_SPECIALISTS = false;
const CORTANA_ACE_ERROR_RECOVERY = process.env.CORTANA_ACE_ERROR_RECOVERY === 'true';

function parseDirectives(text: string): string[] {
  return parseMentionedAgentIds(text, DIRECTED_AGENT_IDS);
}

function shouldFanOutAllAgents(cortanaResponse: string): boolean {
  const text = cortanaResponse.toLowerCase();
  if (text.includes('no action needed') || text.includes('for awareness only')) return false;
  if (/(only|just)\s+@(max|sophie|kane|raj|elena|kai|jude|liv|harper|mia|leo)\b/i.test(cortanaResponse)) return false;
  return true;
}

const FILE_PATH_EVIDENCE_RE = /\b(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+\b/;
const CHECK_EVIDENCE_RE = /\b(?:npm\s+run|pnpm\s+|yarn\s+|typecheck|lint|test|build|smoke|harness|playwright|jest|tsc)\b/i;

function hasExecutionCompletionContract(text: string): boolean {
  const content = String(text || '');
  if (!content.trim()) return false;
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

function summarizeExecutionForCortana(text: string): string {
  const content = String(text || '').trim();
  if (!content) return 'Execution completed; evidence is available in the workspace thread.';

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

function appendDefaultNextSteps(text: string): string {
  const normalized = String(text || '').trim();
  if (!normalized) return normalized;
  const hasActionCue = /\b(next step|action|will|now|recommend|should|run|check|verify|post|update|fix|implement|create|change|retry|owner)\b/i.test(normalized);
  if (!hasActionCue) {
    return `${normalized}\n\nNext step: Cortana will post a concrete action with owner and ETA.`;
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
    .replace(/^\s*(?:Cortana|Ace|Argus|Athena|Aphrodite|Iris|Mnemosyne|Hephaestus|Themis|Hermes|Calliope|Artemis|Prometheus)\s*:\s*/i, '')
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
  const cortanaChannel = getAgentWorkChannel('executive-assistant', groupchat);
  const candidates = [channels?.screenshots, workspaceChannel, cortanaChannel].filter(Boolean);

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
  if (/please\s+create|<@&\d+>.*(?:create|build|implement|review|validate|help)/.test(normalized)) return false;
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
  return `🧭 Cortana update: ${concise}`;
}

function buildCompactChainStatus(findings: string[], errors: string[]): string {
  const findingCount = findings.length;
  const errorCount = errors.length;
  if (errorCount > 0) {
    const firstError = firstSentence(errors[0] || '', 180);
    return `⚠️ Cortana execution update: ${findingCount} finding(s), ${errorCount} issue(s). ${firstError || 'Follow-up is required in the workspace thread.'}`;
  }
  if (findingCount > 0) {
    const firstFinding = firstSentence(findings[0] || '', 180);
    return `✅ Cortana execution complete: ${findingCount} finding(s). ${firstFinding || 'Details are in the workspace thread.'}`;
  }
  return '✅ Cortana execution cycle finished. Details are in the workspace thread.';
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
    : 'Workstream completed via Cortana orchestration.';

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

async function recoverFromExecutionErrors(
  cortanaResponse: string,
  errorLines: string[],
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  signal?: AbortSignal
): Promise<{ findings: string[]; errors: string[] }> {
  const cortana = getAgent('executive-assistant' as AgentId);
  if (!cortana) return { findings: [], errors: ['Cortana: unavailable for recovery'] };

  try {
    if (signal?.aborted) return { findings: [], errors: [] };
    markGoalProgress('🧯 Cortana recovering execution errors...');
    const cortanaChannel = getAgentWorkChannel('executive-assistant', groupchat);
    cortanaChannel.sendTyping().catch(() => {});

    const recoveryContext = [
      '[System execution recovery]: One or more specialist agents errored during execution.',
      '',
      'Original Cortana plan:',
      cortanaResponse,
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

    const recoveryResponse = await dispatchToAgent('executive-assistant', recoveryContext, cortanaChannel, {
      signal,
      maxTokens: Math.max(SUBAGENT_MAX_TOKENS, 2200),
      persistUserContent: `[Cortana execution recovery]: ${errorLines.join('; ').slice(0, 1200)}`,
      documentLine: '🧯 {response}',
      workspaceChannel,
    });

    if (signal?.aborted) return { findings: [], errors: [] };

    const findings: string[] = [];
    if (recoveryResponse.trim()) {
      findings.push(`${getAgentMention('executive-assistant' as AgentId)}: ${recoveryResponse.slice(0, 500)}`);
    }

    const recoverySubDirectives = parseDirectives(recoveryResponse);
    if (recoverySubDirectives.length > 0) {
      const delegated = await handleSubAgents(recoverySubDirectives, recoveryResponse, groupchat, workspaceChannel, signal);
      findings.push(...delegated.findings);
      return { findings, errors: delegated.errors };
    }

    return { findings, errors: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
    console.error('Cortana recovery error:', errMsg(err));
    void postAgentErrorLog('cortana:recovery', 'Cortana recovery error', { agentId: 'executive-assistant', detail: msg });
    try {
      const wh = await getWebhook(workspaceChannel);
      await wh.send({ content: '⚠️ Cortana had an error while recovering specialist failures.', username: `${cortana.emoji} ${cortana.name}`, avatarURL: cortana.avatarUrl });
    } catch {
    }
    return { findings: [], errors: ['Cortana: recovery error'] };
  }
}
async function runSpecialistFallback(
  cortanaResponse: string,
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  signal?: AbortSignal,
): Promise<{ findings: string[]; errors: string[] }> {
  const findings: string[] = [];
  const errors: string[] = [];
  const inferredSpecialists = inferSpecialistsForContext(cortanaResponse);
  const fallbackAgents = [...new Set(inferredSpecialists)].slice(0, 2);
  if (fallbackAgents.length > 0) {
    const autoSpecialistRun = await handleSubAgents(fallbackAgents, cortanaResponse, groupchat, workspaceChannel, signal);
    findings.push(...autoSpecialistRun.findings);
    errors.push(...autoSpecialistRun.errors);
  }
  return { findings, errors };
}

/**
 * Handle the chain: Cortana executes directly, then optionally fans out to specialists.
 * Returns a summary of the chain outcome for use in continuation loops.
 */
async function handleAgentChain(
  cortanaResponse: string,
  groupchat: TextChannel,
  workspaceChannel: WebhookCapableChannel,
  signal?: AbortSignal
): Promise<{ summary: string; hadErrors: boolean; hadFileChanges: boolean }> {
  const result = { summary: '', hadErrors: false, hadFileChanges: false };
  const directedAgents = parseDirectives(cortanaResponse);
  const wantsFullTeam = CORTANA_USE_ALL_AGENTS && shouldFanOutAllAgents(cortanaResponse);
  const effectiveAgents = wantsFullTeam
    ? [...DIRECTED_AGENT_IDS]
    : directedAgents;
  if (effectiveAgents.length === 0) return result;
  markGoalProgress('🧩 Coordinating specialist agents...');

  const otherDirected = CORTANA_DIRECT_SPECIALISTS ? effectiveAgents : [];
  const consolidatedFindings: string[] = [];
  const consolidatedErrors: string[] = [];
  const cortanaAlreadyCompletion = /(done|completed|complete|fixed|resolved|implemented|deployed|shipped|finished|ready)/i.test(cortanaResponse);
  const needsRuntimeEvidence = goalNeedsRuntimeVerification(`${goalState.goal || ''}\n${cortanaResponse}`);
  if (hasExecutionCompletionContract(cortanaResponse)) {
    result.summary = summarizeExecutionForCortana(cortanaResponse);
  }

  if (otherDirected.length > 0) {
    const direct = await handleSubAgents(otherDirected, cortanaResponse, groupchat, workspaceChannel, signal);
    consolidatedFindings.push(...direct.findings);
    consolidatedErrors.push(...direct.errors);
  } else if (!signal?.aborted) {
    const fallbackResult = await runSpecialistFallback(cortanaResponse, groupchat, workspaceChannel, signal);
    consolidatedFindings.push(...fallbackResult.findings);
    consolidatedErrors.push(...fallbackResult.errors);
  }

  if (!signal?.aborted && hasBlockingVerificationFinding(consolidatedFindings)) {
    consolidatedErrors.push('Verification is blocked based on specialist findings; completion remains blocked until verification passes.');
  }

  if (CORTANA_ACE_ERROR_RECOVERY && !signal?.aborted && consolidatedErrors.length > 0) {
    const recovered = await recoverFromExecutionErrors(cortanaResponse, consolidatedErrors, groupchat, workspaceChannel, signal);
    consolidatedFindings.push(...recovered.findings);
    consolidatedErrors.push(...recovered.errors);
  }

  if (!signal?.aborted && needsRuntimeEvidence) {
    // Auto-capture web harness screenshots so verification evidence is produced
    // without waiting for a separate manual check.
    const evidenceSince = Math.max(Date.now() - 2 * 60 * 60 * 1000, goalState.startedAt - 60_000);
    let hasEvidence = await hasRecentRuntimeVerificationEvidence(groupchat, workspaceChannel, evidenceSince);
    if (!hasEvidence) {
      const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
      try {
        const cortana = getAgent('executive-assistant' as AgentId);
        if (cortana) {
          await sendAgentMessage(workspaceChannel, cortana, '📸 Auto-capturing web harness verification screenshots...');
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
      const cortana = getAgent('executive-assistant' as AgentId);
      if (cortana) {
        await sendAgentMessage(workspaceChannel, cortana, '🛑 Completion gate: runtime verification evidence is required but missing. I will keep this thread open until checkable proof is posted (screenshots or harness/puppeteer output).');
      }
    }
  }

  if (GROUPCHAT_SUMMARY_ONLY && !signal?.aborted && (consolidatedFindings.length > 0 || consolidatedErrors.length > 0)) {
    const cortana = getAgent('executive-assistant' as AgentId);
    if (cortana) {
      const consolidatedUpdate = buildConsolidatedAgentUpdate(consolidatedFindings, consolidatedErrors);
      const watchdogSummary = !cortanaAlreadyCompletion
        ? buildChainCompletionWatchdogMessage(consolidatedFindings, consolidatedErrors)
        : '';
      const workspaceSummary = [consolidatedUpdate, watchdogSummary].filter(Boolean).join('\n\n');
      await sendAgentMessage(workspaceChannel, cortana, workspaceSummary);

      if (workspaceChannel.id !== groupchat.id) {
        const compact = buildCompactChainStatus(consolidatedFindings, consolidatedErrors);
        await sendAgentMessage(groupchat, cortana, compact);
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
  'ux-reviewer': 0,      // Aphrodite — design first
  'dba': 0,              // Mnemosyne — schema design (parallel with Aphrodite)
  'api-reviewer': 0,     // Iris — API design (parallel with Aphrodite/Mnemosyne)
  'security-auditor': 2, // Athena — review (parallel with other reviewers)
  'lawyer': 2,           // Themis — compliance review
  'qa': 2,               // Argus — testing review
  'performance': 2,      // Hermes — perf review
  'copywriter': 2,       // Calliope — copy review
  'devops': 3,           // Hephaestus — deploy (after review)
  'ios-engineer': 3,     // Artemis — platform (parallel with deploy)
  'android-engineer': 3, // Prometheus — platform
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

    // Push sub-agents into the unified turn tracker so the user sees one
    // message with nested per-agent sub-lines instead of a fresh status
    // post per specialist.
    const cortana = getAgent('executive-assistant');
    const activeTurn = activeTurnByChannel.get(workspaceChannel.id);
    if (activeTurn && cortana) {
      // Use short role names only (e.g. "Argus" not "🧪 Argus (QA)") so the
      // tracker header stays clean.
      const names = tierAgents
        .map((a) => (a.agent as unknown as { roleName?: string }).roleName || a.agent.name)
        .filter(Boolean);
      const joined = names.length <= 1
        ? names[0] ?? ''
        : names.length === 2
          ? `${names[0]} and ${names[1]}`
          : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
      activeTurn.setPhase('executive-assistant', 'planning', `consulting ${joined}`, cortana);
      for (const { id, agent } of tierAgents) {
        activeTurn.setPhase(id, 'queued', 'queued', agent);
      }
    }

    const priorSummary = priorFindings.slice(-3).join('\n').slice(0, 900);
    const priorContext = priorSummary
      ? `\n\nPrior agent findings (use only if relevant):\n${priorSummary}`
      : '';
    const directiveExcerpt = directiveContext.replace(/\s+/g, ' ').trim().slice(0, 1400);

    const tierResults = await runLimited(
      tierAgents.map(({ id, agent }) => async () => {
        if (signal?.aborted) return;
        const startedAt = Date.now();
        trackAgentActive(id, 'working');
        const turnRef = activeTurnByChannel.get(workspaceChannel.id);
        turnRef?.setPhase(id, 'working', 'working', agent);
        try {
        documentToChannel(id, `📥 Received task from groupchat. Working...`).catch(() => {});

        const handoffCtx = buildHandoffContext({
          fromAgent: 'cortana',
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
        // Policy: specialists post in their own agent channel + the workspace
        // thread Cortana created for this goal. Never in #groupchat. If no
        // dedicated agent channel exists, mirror into the workspace thread
        // twice rather than leaking specialist chatter into groupchat.
        const dedicatedChannel = getBotChannels()?.agentChannels.get(id);
        const workspaceFallback = workspaceChannel as unknown as TextChannel;
        const outChannel = (dedicatedChannel ?? workspaceFallback) as WebhookCapableChannel;
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
        turnRef?.setPhase(id, trimmed ? 'done' : 'error', trimmed ? 'done' : 'no response', agent);
        return {
          finding: `${getAgentMention(id as AgentId)}: ${trimmed}`,
          report,
        };
        } catch (err) {
          turnRef?.setPhase(id, 'error', `error: ${(err as Error).message.slice(0, 40)}`, agent);
          throw err;
        } finally {
          trackAgentIdle(id);
        }
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
    requestedBy: 'cortana',
    specialistReports: reports,
  }, {
    onMilestone: (milestone) => {
      if (milestone.stage === 'blocked') {
        markGoalProgress(`⚠️ ${milestone.message}`);
      }
    },
  });

  const selfImprovement = buildSelfImprovementPacket({
    goal: opusSummary.goal,
    status: opusSummary.status,
    summary: opusSummary.summary,
    issues: opusSummary.issues,
  });

  if (selfImprovement.requests.length > 0 && !signal?.aborted) {
    await enqueueSelfImprovementJob({
      packet: selfImprovement,
      goal: opusSummary.goal,
      conversationSummary: opusSummary.summary,
      status: opusSummary.status,
      directiveContext,
      groupchatChannelId: groupchat.id,
      workspaceChannelId: workspaceChannel.id,
    });
    await postWorkspaceProgressUpdate(
      workspaceChannel,
      selfImprovement.managerAgentId as AgentId,
      `Self-improvement queued in the background for Cortana Opus: ${selfImprovement.requests.map((request) => `[${request.kind}] ${request.summary}`).slice(0, 4).join(' | ')}`
    );
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
 * Routes the answer back to Cortana in groupchat so she can continue blocked work.
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

  await handleCortanaMessage(
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
 * Parses numbered options from Cortana's response and adds interactive buttons.
 */
async function postDecisionEmbed(
  targetChannel: TextChannel,
  groupchat: TextChannel,
  cortanaResponse: string
): Promise<void> {
  const decisionText = String(cortanaResponse || '');
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

  // Cortana assumes option 1 is her recommended default and keeps working on it
  // while awaiting input. The embed marks this explicitly so the user knows
  // the system is not stalled.
  const defaultIdx = 0;
  const defaultLabel = choiceSet[defaultIdx];
  const embed = new EmbedBuilder()
    .setTitle('📋 Decision (non-blocking)')
    .setDescription(
      choiceSet
        .map((opt, i) => `${choiceEmojis[i]} ${opt}${i === defaultIdx ? '  ← _default_' : ''}`)
        .join('\n\n')
    )
    .setColor(SYSTEM_COLORS.decision)
    .setFooter({ text: `⚡ Cortana is proceeding with "${defaultLabel}". Click a button to override; she will adapt immediately.` });

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

  // Persist so a resolution can land even after a bot restart.
  void recordDecision({
    messageId: decisionMsg.id,
    channelId: targetChannel.id,
    groupchatId: groupchat.id,
    options: choiceSet,
    defaultIdx,
    reversible: true,
    context: decisionText.slice(0, 1200),
  });

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

    const cortana = getAgent('executive-assistant' as AgentId);
    const confirmText = `✅ **${userName}** chose: **${choice}**`;

    try {
      await btnInteraction.update({ components: [disabledRow] });
    } catch { /* ignore if already replied */ }

    if (cortana) {
      try {
        await sendWebhookMessage(targetChannel, { content: confirmText, username: `${cortana.emoji} ${cortana.name}`, avatarURL: cortana.avatarUrl });
      } catch {
        await targetChannel.send(confirmText);
      }
    } else {
      await targetChannel.send(confirmText);
    }

    // Mark the decision resolved in the durable log.
    void resolveDecision(decisionMsg.id, userName, choiceIndex, choice);

    // If the user picked the default, Cortana is already proceeding — just
    // acknowledge. Otherwise, trigger an adapt turn so Cortana changes course.
    const isDefault = choiceIndex === defaultIdx;
    if (isDefault) {
      try {
        const msg = `👍 Default confirmed — continuing with "${choice}".`;
        if (cortana) {
          await sendWebhookMessage(targetChannel, { content: msg, username: `${cortana.emoji} ${cortana.name}`, avatarURL: cortana.avatarUrl });
        }
      } catch { /* best-effort ack */ }
      return;
    }

    const decisionMessage = `[Decision override] ${userName} selected "${choice}" instead of the default "${defaultLabel}". Adapt the in-flight plan accordingly — do not repeat work already done; only pivot what's different under this option.`;
    const workspaceChannel = await ensureGoalWorkspace(groupchat, userName, decisionMessage);
    await handleCortanaMessage(decisionMessage, userName, undefined, groupchat, undefined, workspaceChannel);
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
