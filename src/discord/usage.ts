import { randomUUID } from 'crypto';
import { TextChannel, EmbedBuilder } from 'discord.js';

import pool from '../db/pool';
import { getLiveBillingSnapshot, refreshLiveBillingSnapshot } from '../services/billing';

import { formatOpsLine, postOpsLine } from './activityLog';
import { upsertMemory } from './memory';
import { statusColor } from './ui/constants';
import { errMsg } from '../utils/errors';

// ─── Tracing Types ───

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  agentId: string;
  modelName?: string;
  operation: string;
  status: 'ok' | 'error' | 'timeout' | 'rate_limited';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs?: number;
  toolName?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
}

// ─── Trace ID Generation ───

export function newTraceId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

export function newSpanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

export function createTraceContext(parentTrace?: TraceContext): TraceContext {
  return {
    traceId: parentTrace?.traceId || newTraceId(),
    spanId: newSpanId(),
  };
}

// ─── Span Recording ───

let traceDbDisabled = false;

function logSpanStructured(span: TraceSpan): void {
  const log = {
    level: span.status === 'error' ? 'error' : 'info',
    type: 'trace_span',
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    agent: span.agentId,
    model: span.modelName,
    op: span.operation,
    status: span.status,
    tokensIn: span.inputTokens,
    tokensOut: span.outputTokens,
    cacheRead: span.cacheReadTokens,
    cacheWrite: span.cacheWriteTokens,
    durationMs: span.durationMs,
    tool: span.toolName,
    error: span.errorMessage?.slice(0, 200),
  };
  console.log(JSON.stringify(log));
}

export async function recordSpan(span: TraceSpan): Promise<void> {
  logSpanStructured(span);

  if (traceDbDisabled) return;

  try {
    await pool.query(
      `INSERT INTO trace_spans
        (trace_id, span_id, parent_span_id, agent_id, model_name, operation,
         status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         duration_ms, tool_name, error_message, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        span.traceId,
        span.spanId,
        span.parentSpanId || null,
        span.agentId,
        span.modelName || null,
        span.operation,
        span.status,
        span.inputTokens,
        span.outputTokens,
        span.cacheReadTokens,
        span.cacheWriteTokens,
        span.durationMs ?? null,
        span.toolName || null,
        span.errorMessage?.slice(0, 500) || null,
        span.metadata ? JSON.stringify(span.metadata) : null,
      ],
    );
  } catch (err: any) {
    if (
      String(err?.message || '').includes('does not exist') ||
      String(err?.code || '') === '42P01'
    ) {
      traceDbDisabled = true;
      console.warn('trace_spans table not found — tracing DB persistence disabled');
    }
  }
}

const DAILY_LIMITS = {
  /** Max LLM input+output tokens per day */
  claudeTokens: parseInt(process.env.DAILY_LIMIT_GEMINI_LLM_TOKENS || process.env.DAILY_LIMIT_CLAUDE_TOKENS || '8000000', 10),
  /** Max realtime API calls per day */
  geminiCalls: parseInt(process.env.DAILY_LIMIT_GEMINI_CALLS || '2000', 10),
  /** Max ElevenLabs characters per day */
  elevenLabsChars: parseInt(process.env.DAILY_LIMIT_ELEVENLABS_CHARS || '10000', 10),
  /** Hard dollar budget — ALL agents stop when this is exceeded */
  budgetUsd: parseFloat(process.env.DAILY_BUDGET_USD || '250.00'),
};
const DEFAULT_BUDGET_APPROVAL_INCREMENT_USD = parseFloat(process.env.BUDGET_APPROVAL_INCREMENT_USD || '5.00');
const DASHBOARD_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

interface UsageCounters {
  claudeInputTokens: number;
  claudeOutputTokens: number;
  anthropicInputTokens: number;
  anthropicOutputTokens: number;
  geminiTextInputTokens: number;
  geminiTextOutputTokens: number;
  geminiCalls: number;
  geminiInputTokens: number;
  elevenLabsChars: number;
  approvedBudgetUsd: number;
  llmRequests: number;
  anthropicRequests: number;
  geminiTextRequests: number;
  llmCacheReadInputTokens: number;
  llmCacheCreationInputTokens: number;
  llmCacheReadRequests: number;
  llmCacheCreationRequests: number;
  promptSystemChars: number;
  promptHistoryChars: number;
  promptToolsChars: number;
  promptUserChars: number;
  promptToolResultChars: number;
  modelStats: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    requests: number;
  }>;
  lastReset: string; // ISO date string (YYYY-MM-DD)
}

export interface PromptBreakdown {
  systemChars?: number;
  historyChars?: number;
  toolsChars?: number;
  userChars?: number;
  toolResultChars?: number;
}

export interface ClaudeUsageAttribution {
  modelName?: string;
  agentLabel?: string;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  promptBreakdown?: PromptBreakdown;
}

const usage: UsageCounters = {
  claudeInputTokens: 0,
  claudeOutputTokens: 0,
  anthropicInputTokens: 0,
  anthropicOutputTokens: 0,
  geminiTextInputTokens: 0,
  geminiTextOutputTokens: 0,
  geminiCalls: 0,
  geminiInputTokens: 0,
  elevenLabsChars: 0,
  approvedBudgetUsd: 0,
  llmRequests: 0,
  anthropicRequests: 0,
  geminiTextRequests: 0,
  llmCacheReadInputTokens: 0,
  llmCacheCreationInputTokens: 0,
  llmCacheReadRequests: 0,
  llmCacheCreationRequests: 0,
  promptSystemChars: 0,
  promptHistoryChars: 0,
  promptToolsChars: 0,
  promptUserChars: 0,
  promptToolResultChars: 0,
  modelStats: {},
  lastReset: new Date().toISOString().split('T')[0],
};

const USAGE_DB_KEY = 'usage-counters-v1';
let usageLoaded = false;
let usageDirty = false;
let usageWriteTimer: ReturnType<typeof setTimeout> | null = null;
let costChannel: TextChannel | null = null;
let usageDbDisabled = false;

function isPermissionDeniedError(err: unknown): boolean {
  const code = String((err as any)?.code || '');
  const msg = String((err as any)?.message || err || '').toLowerCase();
  return code === '42501' || msg.includes('permission denied');
}

function disableUsageDb(reason: string): void {
  if (usageDbDisabled) return;
  usageDbDisabled = true;
  console.warn(`Usage counter DB persistence disabled: ${reason}. Using in-memory counters only.`);
}

export function toAgentTag(agentLabel: string): string {
  const normalized = String(agentLabel || '').toLowerCase();
  if (normalized.includes('riley')) return 'executive-assistant';
  if (normalized.includes('ace')) return 'executive-assistant';
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
}

function markUsageDirty(): void {
  usageDirty = true;
  if (usageWriteTimer) clearTimeout(usageWriteTimer);
  usageWriteTimer = setTimeout(() => {
    flushUsageCounters().catch((err) => {
      console.error('Usage counter flush failed:', errMsg(err));
    });
  }, 2000);
  usageWriteTimer.unref?.();
}

export async function initUsageCounters(): Promise<void> {
  if (usageLoaded) return;
  if (usageDbDisabled) {
    usageLoaded = true;
    resetIfNewDay();
    return;
  }
  try {
    const { rows } = await pool.query(
      'SELECT content FROM agent_memory WHERE file_name = $1 LIMIT 1',
      [USAGE_DB_KEY]
    );
    if (rows.length > 0 && rows[0].content) {
      const parsed = JSON.parse(rows[0].content);
      usage.claudeInputTokens = Number(parsed.claudeInputTokens) || 0;
      usage.claudeOutputTokens = Number(parsed.claudeOutputTokens) || 0;
      usage.anthropicInputTokens = Number(parsed.anthropicInputTokens) || 0;
      usage.anthropicOutputTokens = Number(parsed.anthropicOutputTokens) || 0;
      usage.geminiTextInputTokens = Number(parsed.geminiTextInputTokens) || 0;
      usage.geminiTextOutputTokens = Number(parsed.geminiTextOutputTokens) || 0;
      usage.geminiCalls = Number(parsed.geminiCalls) || 0;
      usage.geminiInputTokens = Number(parsed.geminiInputTokens) || 0;
      usage.elevenLabsChars = Number(parsed.elevenLabsChars) || 0;
      usage.approvedBudgetUsd = Number(parsed.approvedBudgetUsd) || 0;
      usage.llmRequests = Number(parsed.llmRequests) || 0;
      usage.anthropicRequests = Number(parsed.anthropicRequests) || 0;
      usage.geminiTextRequests = Number(parsed.geminiTextRequests) || 0;
      usage.llmCacheReadInputTokens = Number(parsed.llmCacheReadInputTokens) || 0;
      usage.llmCacheCreationInputTokens = Number(parsed.llmCacheCreationInputTokens) || 0;
      usage.llmCacheReadRequests = Number(parsed.llmCacheReadRequests) || 0;
      usage.llmCacheCreationRequests = Number(parsed.llmCacheCreationRequests) || 0;
      usage.promptSystemChars = Number(parsed.promptSystemChars) || 0;
      usage.promptHistoryChars = Number(parsed.promptHistoryChars) || 0;
      usage.promptToolsChars = Number(parsed.promptToolsChars) || 0;
      usage.promptUserChars = Number(parsed.promptUserChars) || 0;
      usage.promptToolResultChars = Number(parsed.promptToolResultChars) || 0;
      usage.modelStats = (parsed.modelStats && typeof parsed.modelStats === 'object') ? parsed.modelStats : {};
      usage.lastReset = typeof parsed.lastReset === 'string'
        ? parsed.lastReset
        : new Date().toISOString().split('T')[0];

      if (
        usage.anthropicInputTokens === 0 &&
        usage.anthropicOutputTokens === 0 &&
        usage.geminiTextInputTokens === 0 &&
        usage.geminiTextOutputTokens === 0 &&
        (usage.claudeInputTokens > 0 || usage.claudeOutputTokens > 0)
      ) {
        usage.geminiTextInputTokens = usage.claudeInputTokens;
        usage.geminiTextOutputTokens = usage.claudeOutputTokens;
      }
    }
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      disableUsageDb(err instanceof Error ? err.message : 'permission denied');
    }
    console.error('Failed to initialize usage counters:', errMsg(err));
  } finally {
    usageLoaded = true;
    resetIfNewDay();
  }
}

export async function flushUsageCounters(): Promise<void> {
  if (!usageLoaded || !usageDirty) return;
  if (usageDbDisabled) {
    usageDirty = false;
    return;
  }
  if (usageWriteTimer) {
    clearTimeout(usageWriteTimer);
    usageWriteTimer = null;
  }
  const payload = JSON.stringify(usage);
  try {
    await upsertMemory(USAGE_DB_KEY, payload);
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      disableUsageDb(err instanceof Error ? err.message : 'permission denied');
      usageDirty = false;
      return;
    }
    throw err;
  }
  usageDirty = false;
}

function resetIfNewDay(): void {
  const today = new Date().toISOString().split('T')[0];
  if (usage.lastReset !== today) {
    usage.claudeInputTokens = 0;
    usage.claudeOutputTokens = 0;
    usage.anthropicInputTokens = 0;
    usage.anthropicOutputTokens = 0;
    usage.geminiTextInputTokens = 0;
    usage.geminiTextOutputTokens = 0;
    usage.geminiCalls = 0;
    usage.geminiInputTokens = 0;
    usage.elevenLabsChars = 0;
    usage.approvedBudgetUsd = 0;
    usage.llmRequests = 0;
    usage.anthropicRequests = 0;
    usage.geminiTextRequests = 0;
    usage.llmCacheReadInputTokens = 0;
    usage.llmCacheCreationInputTokens = 0;
    usage.llmCacheReadRequests = 0;
    usage.llmCacheCreationRequests = 0;
    usage.promptSystemChars = 0;
    usage.promptHistoryChars = 0;
    usage.promptToolsChars = 0;
    usage.promptUserChars = 0;
    usage.promptToolResultChars = 0;
    usage.modelStats = {};
    usage.lastReset = today;
    markUsageDirty();
  }
}

function effectiveBudgetLimit(): number {
  return DAILY_LIMITS.budgetUsd + usage.approvedBudgetUsd;
}

function effectiveGcpSpendForBudget(estimatedGcpSpend: number): number {
  const live = getLiveBillingSnapshot();
  if (!live.available || live.dailyCostUsd === null || !Number.isFinite(live.dailyCostUsd)) {
    return estimatedGcpSpend;
  }

  return Math.max(estimatedGcpSpend, live.dailyCostUsd);
}

function effectiveTotalSpendForBudget(): number {
  const estimated = estimateDailyCost();
  const gcpEstimated = estimated.claude + estimated.gemini;
  const effectiveGcp = effectiveGcpSpendForBudget(gcpEstimated);
  return effectiveGcp + estimated.elevenLabs;
}

function isAnthropicModelName(modelName?: string): boolean {
  const key = String(modelName || '').trim().toLowerCase();
  return key.includes('claude') || key.includes('opus') || key.includes('sonnet') || key.includes('haiku');
}

function asNonNegativeInt(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
}

function normalizeModelName(modelName?: string): string {
  const value = String(modelName || '').trim().toLowerCase();
  return value || 'unknown-model';
}

export function recordClaudeUsage(
  inputTokens: number,
  outputTokens: number,
  modelNameOrAttribution?: string | ClaudeUsageAttribution,
): void {
  resetIfNewDay();

  const attribution = typeof modelNameOrAttribution === 'string'
    ? { modelName: modelNameOrAttribution }
    : (modelNameOrAttribution || {});
  const modelName = attribution.modelName;
  const agentLabel = attribution.agentLabel || 'system';

  usage.claudeInputTokens += inputTokens;
  usage.claudeOutputTokens += outputTokens;
  usage.llmRequests += 1;

  if (isAnthropicModelName(modelName)) {
    usage.anthropicInputTokens += inputTokens;
    usage.anthropicOutputTokens += outputTokens;
    usage.anthropicRequests += 1;
  } else {
    usage.geminiTextInputTokens += inputTokens;
    usage.geminiTextOutputTokens += outputTokens;
    usage.geminiTextRequests += 1;
  }

  const cacheRead = asNonNegativeInt(attribution.cacheReadInputTokens);
  const cacheCreation = asNonNegativeInt(attribution.cacheCreationInputTokens);
  usage.llmCacheReadInputTokens += cacheRead;
  usage.llmCacheCreationInputTokens += cacheCreation;
  if (cacheRead > 0) usage.llmCacheReadRequests += 1;
  if (cacheCreation > 0) usage.llmCacheCreationRequests += 1;

  const prompt = attribution.promptBreakdown || {};
  usage.promptSystemChars += asNonNegativeInt(prompt.systemChars);
  usage.promptHistoryChars += asNonNegativeInt(prompt.historyChars);
  usage.promptToolsChars += asNonNegativeInt(prompt.toolsChars);
  usage.promptUserChars += asNonNegativeInt(prompt.userChars);
  usage.promptToolResultChars += asNonNegativeInt(prompt.toolResultChars);

  const modelKey = normalizeModelName(modelName);
  const modelStats = usage.modelStats[modelKey] || {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requests: 0,
  };
  modelStats.inputTokens += inputTokens;
  modelStats.outputTokens += outputTokens;
  modelStats.cacheReadTokens += cacheRead;
  modelStats.cacheWriteTokens += cacheCreation;
  modelStats.requests += 1;
  usage.modelStats[modelKey] = modelStats;

  if (costChannel) {
    const reqCost = estimateRequestCostUsd(modelName, inputTokens, outputTokens);
    const budget = getRemainingBudget();
    const modelLabel = modelName || 'unknown-model';
    const agentTag = toAgentTag(agentLabel);
    void postOpsLine(costChannel, {
      actor: agentTag,
      scope: 'cost:request',
      metric: modelLabel,
      delta: `in=${formatCompactCount(inputTokens)} out=${formatCompactCount(outputTokens)} req=$${reqCost.toFixed(4)} today=$${budget.spent.toFixed(2)}/$${budget.limit.toFixed(2)}`,
      action: 'none',
      severity: 'info',
    });
  }

  markUsageDirty();
}

export function recordGeminiUsage(calls: number = 1): void {
  resetIfNewDay();
  usage.geminiCalls += calls;
  markUsageDirty();
}

export function recordElevenLabsUsage(chars: number): void {
  resetIfNewDay();
  usage.elevenLabsChars += chars;
  markUsageDirty();
}

export function isClaudeOverLimit(): boolean {
  resetIfNewDay();
  return (usage.claudeInputTokens + usage.claudeOutputTokens) >= DAILY_LIMITS.claudeTokens;
}

export function isGeminiOverLimit(): boolean {
  resetIfNewDay();
  return usage.geminiCalls >= DAILY_LIMITS.geminiCalls;
}

export function isElevenLabsOverLimit(): boolean {
  resetIfNewDay();
  return usage.elevenLabsChars >= DAILY_LIMITS.elevenLabsChars;
}

/** Check if the daily dollar budget has been exceeded */
export function isBudgetExceeded(): boolean {
  resetIfNewDay();
  return effectiveTotalSpendForBudget() >= effectiveBudgetLimit();
}

/** Get remaining budget in USD (for injection into agent prompts) */
export function getRemainingBudget(): { remaining: number; spent: number; limit: number } {
  resetIfNewDay();
  const spent = effectiveTotalSpendForBudget();
  const limit = effectiveBudgetLimit();
  return {
    remaining: Math.max(0, limit - spent),
    spent,
    limit,
  };
}

export function approveAdditionalBudget(amountUsd?: number): { added: number; limit: number; spent: number; remaining: number } {
  resetIfNewDay();
  const amount = Number.isFinite(amountUsd as number) && (amountUsd as number) > 0
    ? Number(amountUsd)
    : DEFAULT_BUDGET_APPROVAL_INCREMENT_USD;
  usage.approvedBudgetUsd += amount;
  markUsageDirty();
  const spent = effectiveTotalSpendForBudget();
  const limit = effectiveBudgetLimit();
  return {
    added: amount,
    limit,
    spent,
    remaining: Math.max(0, limit - spent),
  };
}

/**
 * Permanently raise (or lower) the daily hard budget cap at runtime.
 * The new value is active immediately for all subsequent agent calls.
 * If persist=true the change is also written to the server .env file so it
 * survives bot restarts.
 */
export function setDailyBudgetLimit(
  newLimitUsd: number,
  persist = true,
): { previous: number; current: number; spent: number; remaining: number } {
  const previous = DAILY_LIMITS.budgetUsd;
  if (!Number.isFinite(newLimitUsd) || newLimitUsd < 0) {
    throw new Error(`Invalid budget limit: ${newLimitUsd}`);
  }
  DAILY_LIMITS.budgetUsd = newLimitUsd;
  usage.approvedBudgetUsd = 0;
  markUsageDirty();

  if (persist) {
    try {
      const path = require('path');
      const fs = require('fs');
      const envPath = path.resolve(__dirname, '../../.env');
      if (fs.existsSync(envPath)) {
        let contents = fs.readFileSync(envPath, 'utf8');
        if (/^DAILY_BUDGET_USD=/m.test(contents)) {
          contents = contents.replace(/^DAILY_BUDGET_USD=.*/m, `DAILY_BUDGET_USD=${newLimitUsd.toFixed(2)}`);
        } else {
          contents += `\nDAILY_BUDGET_USD=${newLimitUsd.toFixed(2)}\n`;
        }
        fs.writeFileSync(envPath, contents, 'utf8');
      }
    } catch {
    }
  }

  const spent = effectiveTotalSpendForBudget();
  return {
    previous,
    current: DAILY_LIMITS.budgetUsd,
    spent,
    remaining: Math.max(0, DAILY_LIMITS.budgetUsd - spent),
  };
}

/** Get Claude token status so agents can self-regulate tool usage */
export function getClaudeTokenStatus(): { used: number; remaining: number; limit: number; promptBreakdown: string } {
  resetIfNewDay();
  const used = usage.claudeInputTokens + usage.claudeOutputTokens;
  return {
    used,
    remaining: Math.max(0, DAILY_LIMITS.claudeTokens - used),
    limit: DAILY_LIMITS.claudeTokens,
    promptBreakdown: getPromptBreakdownSummary(),
  };
}

const CLAUDE_INPUT_COST_PER_M = parseFloat(process.env.CLAUDE_INPUT_COST_PER_M || process.env.LLM_INPUT_COST_PER_M || '15');
const CLAUDE_OUTPUT_COST_PER_M = parseFloat(process.env.CLAUDE_OUTPUT_COST_PER_M || process.env.LLM_OUTPUT_COST_PER_M || '75');
const CLAUDE_CACHE_READ_COST_PER_M = parseFloat(process.env.CLAUDE_CACHE_READ_COST_PER_M || '1.5');
const GEMINI_TEXT_INPUT_COST_PER_M = parseFloat(process.env.GEMINI_TEXT_INPUT_COST_PER_M || '0.20');
const GEMINI_TEXT_OUTPUT_COST_PER_M = parseFloat(process.env.GEMINI_TEXT_OUTPUT_COST_PER_M || '1.27');
const GEMINI_COST_PER_CALL = parseFloat(process.env.GEMINI_COST_PER_CALL || '0.0001');
const ELEVENLABS_COST_PER_CHAR = parseFloat(process.env.ELEVENLABS_COST_PER_CHAR || '0.00018');

function estimateRequestCostUsd(modelName: string | undefined, inputTokens: number, outputTokens: number): number {
  if (isAnthropicModelName(modelName)) {
    return (inputTokens / 1_000_000) * CLAUDE_INPUT_COST_PER_M +
      (outputTokens / 1_000_000) * CLAUDE_OUTPUT_COST_PER_M;
  }
  return (inputTokens / 1_000_000) * GEMINI_TEXT_INPUT_COST_PER_M +
    (outputTokens / 1_000_000) * GEMINI_TEXT_OUTPUT_COST_PER_M;
}

function estimateDailyCost(): { claude: number; gemini: number; elevenLabs: number; total: number } {
  // Discount cache-read tokens: charge at cache rate instead of full input rate
  const cacheReadTokens = usage.llmCacheReadInputTokens;
  const nonCacheInputTokens = Math.max(0, usage.anthropicInputTokens - cacheReadTokens);
  const claude =
    (nonCacheInputTokens / 1_000_000) * CLAUDE_INPUT_COST_PER_M +
    (cacheReadTokens / 1_000_000) * CLAUDE_CACHE_READ_COST_PER_M +
    (usage.anthropicOutputTokens / 1_000_000) * CLAUDE_OUTPUT_COST_PER_M;
  const geminiText =
    (usage.geminiTextInputTokens / 1_000_000) * GEMINI_TEXT_INPUT_COST_PER_M +
    (usage.geminiTextOutputTokens / 1_000_000) * GEMINI_TEXT_OUTPUT_COST_PER_M;
  const gemini = geminiText + (usage.geminiCalls * GEMINI_COST_PER_CALL);
  const elevenLabs = usage.elevenLabsChars * ELEVENLABS_COST_PER_CHAR;
  return { claude, gemini, elevenLabs, total: claude + gemini + elevenLabs };
}

function progressBar(used: number, limit: number, length: number = 20): string {
  if (!Number.isFinite(limit) || limit <= 0) {
    return '⚪ n/a';
  }
  const ratio = Math.min(Math.max(used / limit, 0), 1);
  const filled = Math.round(ratio * length);
  const empty = length - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const pctNum = ratio * 100;
  const pct = pctNum >= 10
    ? `${Math.round(pctNum)}%`
    : pctNum >= 1
      ? `${pctNum.toFixed(1)}%`
      : `${pctNum.toFixed(2)}%`;
  const emoji = ratio >= 0.9 ? '🔴' : ratio >= 0.7 ? '🟡' : '🟢';
  return `${emoji} ${bar} ${pct}`;
}

function formatCompactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

export function getPromptAttributionSnapshot(): {
  requests: number;
  anthropicRequests: number;
  secondaryRequests: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheReadRequests: number;
  cacheCreationRequests: number;
  cacheHitRatePct: number;
  avgPromptChars: {
    system: number;
    history: number;
    tools: number;
    user: number;
    toolResults: number;
    total: number;
  };
} {
  resetIfNewDay();
  const requests = Math.max(0, usage.llmRequests);
  const avg = (value: number) => requests > 0 ? Math.round(value / requests) : 0;
  const system = avg(usage.promptSystemChars);
  const history = avg(usage.promptHistoryChars);
  const tools = avg(usage.promptToolsChars);
  const user = avg(usage.promptUserChars);
  const toolResults = avg(usage.promptToolResultChars);

  return {
    requests,
    anthropicRequests: usage.anthropicRequests,
    secondaryRequests: usage.geminiTextRequests,
    cacheReadTokens: usage.llmCacheReadInputTokens,
    cacheCreationTokens: usage.llmCacheCreationInputTokens,
    cacheReadRequests: usage.llmCacheReadRequests,
    cacheCreationRequests: usage.llmCacheCreationRequests,
    cacheHitRatePct: requests > 0 ? Math.round((usage.llmCacheReadRequests / requests) * 100) : 0,
    avgPromptChars: {
      system,
      history,
      tools,
      user,
      toolResults,
      total: system + history + tools + user + toolResults,
    },
  };
}

export function getUsageEmbed(): EmbedBuilder {
  resetIfNewDay();
  const totalClaudeTokens = usage.claudeInputTokens + usage.claudeOutputTokens;
  const cost = estimateDailyCost();
  const estimatedGcp = cost.claude + cost.gemini;
  const live = getLiveBillingSnapshot();
  const effectiveGcpSpend = effectiveGcpSpendForBudget(estimatedGcp);
  const effectiveTotalSpend = effectiveGcpSpend + cost.elevenLabs;
  const extraBudget = usage.approvedBudgetUsd;
  const promptStats = getPromptAttributionSnapshot();
  const promptLine = promptStats.requests > 0
    ? `Avg chars/request: sys ${formatCompactCount(promptStats.avgPromptChars.system)} · tools ${formatCompactCount(promptStats.avgPromptChars.tools)} · hist ${formatCompactCount(promptStats.avgPromptChars.history)} · user ${formatCompactCount(promptStats.avgPromptChars.user)} · tool ${formatCompactCount(promptStats.avgPromptChars.toolResults)}`
    : 'Prompt attribution will appear after the next LLM request.';
  const cacheLine = `Cache read/write: ${formatCompactCount(promptStats.cacheReadTokens)} / ${formatCompactCount(promptStats.cacheCreationTokens)} tokens\nRead hits: ${promptStats.cacheReadRequests}/${promptStats.requests || 0} requests (${promptStats.cacheHitRatePct}%)`;
  const totalRatio = Math.max(
    totalClaudeTokens / DAILY_LIMITS.claudeTokens,
    usage.geminiCalls / DAILY_LIMITS.geminiCalls,
    usage.elevenLabsChars / DAILY_LIMITS.elevenLabsChars
  );
  const color = statusColor(totalRatio);

  return new EmbedBuilder()
    .setTitle('📊 ASAP Usage Dashboard')
    .setDescription('Live GCP billed spend (Cloud Monitoring) + estimated non-GCP spend from internal counters.')
    .setColor(color)
    .addFields(
      {
        name: '🧠 LLM Tokens',
        value:
          `${progressBar(totalClaudeTokens, DAILY_LIMITS.claudeTokens)}\n` +
          `${totalClaudeTokens.toLocaleString()} / ${DAILY_LIMITS.claudeTokens.toLocaleString()} tokens\n` +
          `(${usage.claudeInputTokens.toLocaleString()} in · ${usage.claudeOutputTokens.toLocaleString()} out)\n` +
          `Estimated spend: **$${cost.claude.toFixed(4)}**`,
      },
      {
        name: '🔊 Realtime API Calls',
        value:
          `${progressBar(usage.geminiCalls, DAILY_LIMITS.geminiCalls)}\n` +
          `${usage.geminiCalls} / ${DAILY_LIMITS.geminiCalls} API calls\n` +
          `Estimated spend: **$${cost.gemini.toFixed(4)}**`,
      },
      {
        name: '🗣️ ElevenLabs TTS',
        value:
          `${progressBar(usage.elevenLabsChars, DAILY_LIMITS.elevenLabsChars)}\n` +
          `${usage.elevenLabsChars.toLocaleString()} / ${DAILY_LIMITS.elevenLabsChars.toLocaleString()} chars\n` +
          `Estimated spend: **$${cost.elevenLabs.toFixed(4)}**`,
      },
      {
        name: '☁️ Live GCP Billed Spend',
        value: live.available && live.dailyCostUsd !== null
          ? `Today (UTC): **$${live.dailyCostUsd.toFixed(4)} ${live.currency}**\nMonth-to-date: **$${(live.monthCostUsd || 0).toFixed(4)} ${live.currency}**\nSource: Cloud Monitoring`
          : `Estimated today (fallback): **$${estimatedGcp.toFixed(4)} USD**\nReason: ${live.error || 'Live billing metric unavailable'}\nSource: Internal usage counters`,
      },
      {
        name: '💰 Budget Gate (Today)',
        value: `Effective spend: **$${effectiveTotalSpend.toFixed(4)}**\nGCP used for gate: **$${effectiveGcpSpend.toFixed(4)}**\nLimit: **$${effectiveBudgetLimit().toFixed(2)}**${extraBudget > 0 ? ` (base $${DAILY_LIMITS.budgetUsd.toFixed(2)} + approved $${extraBudget.toFixed(2)})` : ''}`,
        inline: true,
      },
      {
        name: '🧮 Prompt Efficiency',
        value: `${cacheLine}\n${promptLine}`,
      }
    )
    .setFooter({ text: 'Resets at midnight UTC · Updates every 5 minutes · Live GCP billing may be delayed a few minutes' })
    .setTimestamp();
}

/** Plain-text report for /limits command */
export function getUsageReport(): string {
  resetIfNewDay();
  const totalClaudeTokens = usage.claudeInputTokens + usage.claudeOutputTokens;
  const cost = estimateDailyCost();
  const estimatedGcp = cost.claude + cost.gemini;
  const live = getLiveBillingSnapshot();
  const effectiveGcpSpend = effectiveGcpSpendForBudget(estimatedGcp);
  const effectiveTotalSpend = effectiveGcpSpend + cost.elevenLabs;
  const extraBudget = usage.approvedBudgetUsd;
  const promptStats = getPromptAttributionSnapshot();

  const liveLine = live.available && live.dailyCostUsd !== null
    ? `☁️ Live GCP | today $${live.dailyCostUsd.toFixed(4)} ${live.currency} | mtd $${(live.monthCostUsd || 0).toFixed(4)} ${live.currency}`
    : `☁️ Live GCP | fallback est=$${estimatedGcp.toFixed(4)} USD (${live.error || 'Live billing metric unavailable'})`;

  const lines = [
    `📊 ASAP Usage Dashboard | reset ${usage.lastReset}`,
    liveLine,
    `🧠 LLM Tokens | ${progressBar(totalClaudeTokens, DAILY_LIMITS.claudeTokens)} | ${formatCompactCount(totalClaudeTokens)}/${formatCompactCount(DAILY_LIMITS.claudeTokens)} tokens | in ${formatCompactCount(usage.claudeInputTokens)} | out ${formatCompactCount(usage.claudeOutputTokens)} | est $${cost.claude.toFixed(4)}`,
    `🔊 Realtime APIs | ${progressBar(usage.geminiCalls, DAILY_LIMITS.geminiCalls)} | ${formatCompactCount(usage.geminiCalls)}/${formatCompactCount(DAILY_LIMITS.geminiCalls)} calls | est $${cost.gemini.toFixed(4)}`,
    `🗣️ ElevenLabs | ${progressBar(usage.elevenLabsChars, DAILY_LIMITS.elevenLabsChars)} | ${formatCompactCount(usage.elevenLabsChars)}/${formatCompactCount(DAILY_LIMITS.elevenLabsChars)} chars | est $${cost.elevenLabs.toFixed(4)}`,
    `🧮 Prompt | cache r/w ${formatCompactCount(promptStats.cacheReadTokens)}/${formatCompactCount(promptStats.cacheCreationTokens)} | hits ${promptStats.cacheReadRequests}/${promptStats.requests || 0} (${promptStats.cacheHitRatePct}%) | avg chars sys ${formatCompactCount(promptStats.avgPromptChars.system)} tools ${formatCompactCount(promptStats.avgPromptChars.tools)} hist ${formatCompactCount(promptStats.avgPromptChars.history)} user ${formatCompactCount(promptStats.avgPromptChars.user)} tool ${formatCompactCount(promptStats.avgPromptChars.toolResults)}`,
    `💰 Budget gate | spend $${effectiveTotalSpend.toFixed(4)} | limit $${effectiveBudgetLimit().toFixed(2)}${extraBudget > 0 ? ` (base $${DAILY_LIMITS.budgetUsd.toFixed(2)} + approved $${extraBudget.toFixed(2)})` : ''}`,
  ];

  return lines.join('\n');
}

export function getCostOpsSummaryLine(): string {
  resetIfNewDay();
  const cost = estimateDailyCost();
  const live = getLiveBillingSnapshot();
  const effectiveGcpSpend = effectiveGcpSpendForBudget(cost.claude + cost.gemini);
  const total = effectiveGcpSpend + cost.elevenLabs;
  const budget = effectiveBudgetLimit();
  const livePart = live.available && live.dailyCostUsd !== null
    ? `live=$${live.dailyCostUsd.toFixed(2)}${live.currency ? ` ${live.currency}` : ''}`
    : 'live=unavailable';
  return formatOpsLine({
    actor: 'system',
    scope: 'cost:daily',
    metric: 'budget-gate',
    delta: `total=$${total.toFixed(2)} limit=$${budget.toFixed(2)} ${livePart}`,
    action: 'none',
    severity: 'info',
    correlationId: 'cost-snapshot',
    occurredAtMs: Date.now(),
  });
}

export function getContextEfficiencyReport(): string {
  resetIfNewDay();
  const promptStats = getPromptAttributionSnapshot();
  const req = Math.max(1, promptStats.requests);
  const totalAvg = promptStats.avgPromptChars.total;
  const pct = (value: number) => `${Math.round((value / Math.max(1, totalAvg)) * 100)}%`;

  const topModels = Object.entries(usage.modelStats || {})
    .map(([model, stats]) => {
      const cost = estimateRequestCostUsd(model, stats.inputTokens, stats.outputTokens);
      return { model, stats, cost };
    })
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);

  const modelLines = topModels.length > 0
    ? topModels.map((entry) =>
      `🤖 ${entry.model} req ${entry.stats.requests} in ${formatCompactCount(entry.stats.inputTokens)} out ${formatCompactCount(entry.stats.outputTokens)} cache ${formatCompactCount(entry.stats.cacheReadTokens)}/${formatCompactCount(entry.stats.cacheWriteTokens)} est $${entry.cost.toFixed(4)}`
    ).join(' || ')
    : '🤖 No per-model data yet.';

  return (
    `📦 Prompt context | requests ${promptStats.requests} | avg chars ${formatCompactCount(totalAvg)}\n` +
    `🧩 Breakdown | sys ${formatCompactCount(promptStats.avgPromptChars.system)} (${pct(promptStats.avgPromptChars.system)}) | tools ${formatCompactCount(promptStats.avgPromptChars.tools)} (${pct(promptStats.avgPromptChars.tools)}) | hist ${formatCompactCount(promptStats.avgPromptChars.history)} (${pct(promptStats.avgPromptChars.history)}) | user ${formatCompactCount(promptStats.avgPromptChars.user)} (${pct(promptStats.avgPromptChars.user)}) | tool ${formatCompactCount(promptStats.avgPromptChars.toolResults)} (${pct(promptStats.avgPromptChars.toolResults)})\n` +
    `🧠 Cache | read/write ${formatCompactCount(promptStats.cacheReadTokens)}/${formatCompactCount(promptStats.cacheCreationTokens)} | hit-rate ${promptStats.cacheHitRatePct}% (${promptStats.cacheReadRequests}/${req})\n` +
    `📉 Models | ${modelLines}`
  );
}

let limitsChannel: TextChannel | null = null;
let dashboardMessageId: string | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;

export function setLimitsChannel(channel: TextChannel): void {
  limitsChannel = channel;
}

export function setCostChannel(channel: TextChannel | null): void {
  costChannel = channel;
}

/**
 * Start periodic dashboard updates (every 5 minutes).
 * Clears the channel and posts a fresh embed each time.
 */
export async function startDashboardUpdates(): Promise<void> {
  if (!limitsChannel) return;

  await updateDashboard();

  updateInterval = setInterval(() => {
    updateDashboard().catch((err) =>
      console.error('Dashboard update error:', errMsg(err))
    );
  }, DASHBOARD_UPDATE_INTERVAL_MS);
  updateInterval.unref?.();
}

export async function refreshUsageDashboard(): Promise<void> {
  await updateDashboard();
}

export async function refreshLiveBillingData(): Promise<void> {
  await refreshLiveBillingSnapshot();
}

export function stopDashboardUpdates(): void {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
}

async function updateDashboard(): Promise<void> {
  if (!limitsChannel) return;

  await refreshLiveBillingSnapshot().catch((err) => {
    console.warn('Live billing refresh failed:', errMsg(err));
  });

  const embed = getUsageEmbed();

  if (dashboardMessageId) {
    try {
      const existing = await limitsChannel.messages.fetch(dashboardMessageId);
      await existing.edit({ embeds: [embed] });
      return;
    } catch {
      dashboardMessageId = null;
    }
  }

  try {
    const messages = await limitsChannel.messages.fetch({ limit: 50 });
    if (messages.size > 0) {
      await limitsChannel.bulkDelete(messages, true).catch(async () => {
        for (const m of messages.values()) {
          await m.delete().catch(() => {});
        }
      });
    }
  } catch {
  }

  const msg = await limitsChannel.send({ embeds: [embed] });
  dashboardMessageId = msg.id;
}

// ── Per-Conversation Token Tracking ──

const CONVERSATION_TOKEN_WARN = parseInt(process.env.CONVERSATION_TOKEN_WARN || '300000', 10);
const CONVERSATION_TOKEN_LIMIT = parseInt(process.env.CONVERSATION_TOKEN_LIMIT || '500000', 10);

const conversationTokens = new Map<string, number>();

export function recordConversationTokens(conversationKey: string, tokens: number): void {
  const current = conversationTokens.get(conversationKey) || 0;
  conversationTokens.set(conversationKey, current + tokens);
}

export function getConversationTokenUsage(conversationKey: string): { used: number; warn: number; limit: number; overWarn: boolean; overLimit: boolean } {
  const used = conversationTokens.get(conversationKey) || 0;
  return {
    used,
    warn: CONVERSATION_TOKEN_WARN,
    limit: CONVERSATION_TOKEN_LIMIT,
    overWarn: used >= CONVERSATION_TOKEN_WARN,
    overLimit: used >= CONVERSATION_TOKEN_LIMIT,
  };
}

export function clearConversationTokens(conversationKey: string): void {
  conversationTokens.delete(conversationKey);
}

// ── Prompt Breakdown Dashboard ──

export function getPromptBreakdownSummary(): string {
  const total = usage.promptSystemChars + usage.promptHistoryChars + usage.promptToolsChars + usage.promptUserChars + usage.promptToolResultChars;
  if (total === 0) return 'No prompt data collected yet.';

  const pct = (val: number) => total > 0 ? `${((val / total) * 100).toFixed(1)}%` : '0%';
  const fmt = (val: number) => val >= 1000000 ? `${(val / 1000000).toFixed(1)}M` : val >= 1000 ? `${(val / 1000).toFixed(0)}K` : String(val);

  return [
    `📊 Prompt composition today (${fmt(total)} total chars):`,
    `  System:       ${fmt(usage.promptSystemChars)} (${pct(usage.promptSystemChars)})`,
    `  History:      ${fmt(usage.promptHistoryChars)} (${pct(usage.promptHistoryChars)})`,
    `  Tool schemas: ${fmt(usage.promptToolsChars)} (${pct(usage.promptToolsChars)})`,
    `  User msgs:    ${fmt(usage.promptUserChars)} (${pct(usage.promptUserChars)})`,
    `  Tool results: ${fmt(usage.promptToolResultChars)} (${pct(usage.promptToolResultChars)})`,
    `  LLM requests: ${usage.llmRequests}`,
    `  Cache reads:  ${usage.llmCacheReadRequests} (${fmt(usage.llmCacheReadInputTokens)} tokens saved)`,
  ].join('\n');
}
