import { TextChannel, EmbedBuilder } from 'discord.js';
import pool from '../db/pool';
import { getLiveBillingSnapshot, refreshLiveBillingSnapshot } from '../services/billing';

// ─── Daily limits (configurable via env vars) ───────────────────────────────
const DAILY_LIMITS = {
  /** Max LLM input+output tokens per day (Gemini) */
  claudeTokens: parseInt(process.env.DAILY_LIMIT_GEMINI_LLM_TOKENS || process.env.DAILY_LIMIT_CLAUDE_TOKENS || '2000000', 10),
  /** Max Gemini API calls per day (TTS + transcription) */
  geminiCalls: parseInt(process.env.DAILY_LIMIT_GEMINI_CALLS || '500', 10),
  /** Max ElevenLabs characters per day */
  elevenLabsChars: parseInt(process.env.DAILY_LIMIT_ELEVENLABS_CHARS || '10000', 10),
  /** Hard dollar budget — ALL agents stop when this is exceeded */
  budgetUsd: parseFloat(process.env.DAILY_BUDGET_USD || '100.00'),
};
const DEFAULT_BUDGET_APPROVAL_INCREMENT_USD = parseFloat(process.env.BUDGET_APPROVAL_INCREMENT_USD || '5.00');
const DASHBOARD_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

/** Optional running Anthropic credit cap — no longer used with Gemini */
const ANTHROPIC_CREDIT_CAP_USD = 0;

// ─── Usage counters ─────────────────────────────────────────────────────────
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

function markUsageDirty(): void {
  usageDirty = true;
  if (usageWriteTimer) clearTimeout(usageWriteTimer);
  usageWriteTimer = setTimeout(() => {
    flushUsageCounters().catch((err) => {
      console.error('Usage counter flush failed:', err instanceof Error ? err.message : 'Unknown');
    });
  }, 2000);
}

export async function initUsageCounters(): Promise<void> {
  if (usageLoaded) return;
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

      // Backfill older installs that only stored aggregate text-model tokens.
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
    console.error('Failed to initialize usage counters:', err instanceof Error ? err.message : 'Unknown');
  } finally {
    usageLoaded = true;
    resetIfNewDay();
  }
}

export async function flushUsageCounters(): Promise<void> {
  if (!usageLoaded || !usageDirty) return;
  if (usageWriteTimer) {
    clearTimeout(usageWriteTimer);
    usageWriteTimer = null;
  }
  const payload = JSON.stringify(usage);
  await pool.query(
    `INSERT INTO agent_memory (file_name, content, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (file_name) DO UPDATE SET content = $2, updated_at = NOW()`,
    [USAGE_DB_KEY, payload]
  );
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

  // Cloud Billing can lag by a few minutes; keep the larger value to avoid under-gating.
  return Math.max(estimatedGcpSpend, live.dailyCostUsd);
}

function effectiveTotalSpendForBudget(): number {
  const estimated = estimateDailyCost();
  const gcpEstimated = estimated.claude + estimated.gemini;
  const effectiveGcp = effectiveGcpSpendForBudget(gcpEstimated);
  return effectiveGcp + estimated.elevenLabs;
}

// ─── Recording functions ────────────────────────────────────────────────────
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
    const line =
      `💸 **${agentLabel}** • ${modelLabel}\n` +
      `in=${inputTokens.toLocaleString()} out=${outputTokens.toLocaleString()} • est **$${reqCost.toFixed(4)}**\n` +
      `today **$${budget.spent.toFixed(4)} / $${budget.limit.toFixed(2)}**`;
    void costChannel.send(line.slice(0, 1900)).catch(() => {});
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

// ─── Limit checks ──────────────────────────────────────────────────────────
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
  // Apply immediately in-process
  DAILY_LIMITS.budgetUsd = newLimitUsd;
  // Reset approvedBudgetUsd — the new limit already incorporates any desired headroom
  usage.approvedBudgetUsd = 0;
  markUsageDirty();

  if (persist) {
    try {
      // Locate the .env file relative to this module's compiled location
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
      // Non-fatal — in-process change already applied
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
export function getClaudeTokenStatus(): { used: number; remaining: number; limit: number } {
  resetIfNewDay();
  const used = usage.claudeInputTokens + usage.claudeOutputTokens;
  return {
    used,
    remaining: Math.max(0, DAILY_LIMITS.claudeTokens - used),
    limit: DAILY_LIMITS.claudeTokens,
  };
}

// ─── Cost estimates ─────────────────────────────────────────────────────────
// These counters aggregate text-model usage across the bot.
// Since coding work now prefers Claude Opus, use conservative Opus pricing by default
// so the budget gate does not undercount spend. Override with env vars if the mix changes.
const CLAUDE_INPUT_COST_PER_M = parseFloat(process.env.CLAUDE_INPUT_COST_PER_M || process.env.LLM_INPUT_COST_PER_M || '15');
const CLAUDE_OUTPUT_COST_PER_M = parseFloat(process.env.CLAUDE_OUTPUT_COST_PER_M || process.env.LLM_OUTPUT_COST_PER_M || '75');
const GEMINI_TEXT_INPUT_COST_PER_M = parseFloat(process.env.GEMINI_TEXT_INPUT_COST_PER_M || '0.20');
const GEMINI_TEXT_OUTPUT_COST_PER_M = parseFloat(process.env.GEMINI_TEXT_OUTPUT_COST_PER_M || '1.27');
// Gemini TTS/transcription calls — still cheap, but kept configurable.
const GEMINI_COST_PER_CALL = parseFloat(process.env.GEMINI_COST_PER_CALL || '0.0001');
// ElevenLabs — depends on plan, approximate per character.
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
  const claude =
    (usage.anthropicInputTokens / 1_000_000) * CLAUDE_INPUT_COST_PER_M +
    (usage.anthropicOutputTokens / 1_000_000) * CLAUDE_OUTPUT_COST_PER_M;
  const geminiText =
    (usage.geminiTextInputTokens / 1_000_000) * GEMINI_TEXT_INPUT_COST_PER_M +
    (usage.geminiTextOutputTokens / 1_000_000) * GEMINI_TEXT_OUTPUT_COST_PER_M;
  const gemini = geminiText + (usage.geminiCalls * GEMINI_COST_PER_CALL);
  const elevenLabs = usage.elevenLabsChars * ELEVENLABS_COST_PER_CHAR;
  return { claude, gemini, elevenLabs, total: claude + gemini + elevenLabs };
}

// ─── Progress bar helper ────────────────────────────────────────────────────
function progressBar(used: number, limit: number, length: number = 20): string {
  const ratio = Math.min(used / limit, 1);
  const filled = Math.round(ratio * length);
  const empty = length - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const pct = Math.round(ratio * 100);
  const emoji = ratio >= 0.9 ? '🔴' : ratio >= 0.7 ? '🟡' : '🟢';
  return `${emoji} ${bar} ${pct}%`;
}

function formatCompactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

export function getPromptAttributionSnapshot(): {
  requests: number;
  anthropicRequests: number;
  geminiRequests: number;
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
    geminiRequests: usage.geminiTextRequests,
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

// ─── Formatted usage report (embed) ─────────────────────────────────────────
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
  const color = totalRatio >= 0.9 ? 0xed4245 : totalRatio >= 0.7 ? 0xfee75c : 0x57f287;

  return new EmbedBuilder()
    .setTitle('📊 ASAP Usage Dashboard')
    .setDescription('Live GCP billed spend (Cloud Monitoring) + estimated non-GCP spend from internal counters.')
    .setColor(color)
    .addFields(
      {
        name: '🧠 LLM Tokens (Claude/Gemini)',
        value:
          `${progressBar(totalClaudeTokens, DAILY_LIMITS.claudeTokens)}\n` +
          `${totalClaudeTokens.toLocaleString()} / ${DAILY_LIMITS.claudeTokens.toLocaleString()} tokens\n` +
          `(${usage.claudeInputTokens.toLocaleString()} in · ${usage.claudeOutputTokens.toLocaleString()} out)\n` +
          `Estimated spend: **$${cost.claude.toFixed(4)}**`,
      },
      {
        name: '🔊 Gemini Voice APIs',
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
          : `Unavailable right now (${live.error || 'no billing metric data yet'})`,
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
    ? `Live GCP billed spend today (UTC): **$${live.dailyCostUsd.toFixed(4)} ${live.currency}** (month-to-date **$${(live.monthCostUsd || 0).toFixed(4)} ${live.currency}**).`
    : `Live GCP billed spend is currently unavailable (${live.error || 'no billing metric data yet'}).`;

  return (
    `📊 **ASAP Usage Dashboard** — ${usage.lastReset}\n\n` +
    `${liveLine}\n\n` +
    `**LLM Tokens (Claude/Gemini)**\n` +
    `${progressBar(totalClaudeTokens, DAILY_LIMITS.claudeTokens)}\n` +
    `${totalClaudeTokens.toLocaleString()} / ${DAILY_LIMITS.claudeTokens.toLocaleString()} tokens` +
    ` (${usage.claudeInputTokens.toLocaleString()} in · ${usage.claudeOutputTokens.toLocaleString()} out)\n` +
    `Estimated spend: **$${cost.claude.toFixed(4)}**\n` +
    `Cache read/write input tokens: **${formatCompactCount(promptStats.cacheReadTokens)} / ${formatCompactCount(promptStats.cacheCreationTokens)}**\n` +
    `Cache read hits: **${promptStats.cacheReadRequests}/${promptStats.requests || 0} requests (${promptStats.cacheHitRatePct}%)**\n` +
    `Avg prompt chars/request: system ${formatCompactCount(promptStats.avgPromptChars.system)} · tools ${formatCompactCount(promptStats.avgPromptChars.tools)} · history ${formatCompactCount(promptStats.avgPromptChars.history)} · user ${formatCompactCount(promptStats.avgPromptChars.user)} · tool results ${formatCompactCount(promptStats.avgPromptChars.toolResults)}\n\n` +
    `**Gemini Voice APIs**\n` +
    `${progressBar(usage.geminiCalls, DAILY_LIMITS.geminiCalls)}\n` +
    `${usage.geminiCalls} / ${DAILY_LIMITS.geminiCalls} API calls\n` +
    `Estimated spend: **$${cost.gemini.toFixed(4)}**\n\n` +
    `**ElevenLabs TTS**\n` +
    `${progressBar(usage.elevenLabsChars, DAILY_LIMITS.elevenLabsChars)}\n` +
    `${usage.elevenLabsChars.toLocaleString()} / ${DAILY_LIMITS.elevenLabsChars.toLocaleString()} characters\n` +
    `Estimated spend: **$${cost.elevenLabs.toFixed(4)}**\n\n` +
    `💰 **Effective spend for budget gate today: $${effectiveTotalSpend.toFixed(4)}**\n` +
    `Budget gate: **$${effectiveBudgetLimit().toFixed(2)}**${extraBudget > 0 ? ` (base $${DAILY_LIMITS.budgetUsd.toFixed(2)} + approved $${extraBudget.toFixed(2)})` : ''}`
  );
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
      `• ${entry.model}: $${entry.cost.toFixed(4)} | req=${entry.stats.requests} | in=${formatCompactCount(entry.stats.inputTokens)} out=${formatCompactCount(entry.stats.outputTokens)} | cache r/w=${formatCompactCount(entry.stats.cacheReadTokens)}/${formatCompactCount(entry.stats.cacheWriteTokens)}`
    ).join('\n')
    : '• No per-model data yet.';

  return (
    `📦 **Prompt Context Breakdown**\n` +
    `Requests observed: ${promptStats.requests}\n` +
    `Avg chars/request: ${formatCompactCount(totalAvg)}\n` +
    `• system: ${formatCompactCount(promptStats.avgPromptChars.system)} (${pct(promptStats.avgPromptChars.system)})\n` +
    `• tools: ${formatCompactCount(promptStats.avgPromptChars.tools)} (${pct(promptStats.avgPromptChars.tools)})\n` +
    `• history: ${formatCompactCount(promptStats.avgPromptChars.history)} (${pct(promptStats.avgPromptChars.history)})\n` +
    `• user: ${formatCompactCount(promptStats.avgPromptChars.user)} (${pct(promptStats.avgPromptChars.user)})\n` +
    `• tool results: ${formatCompactCount(promptStats.avgPromptChars.toolResults)} (${pct(promptStats.avgPromptChars.toolResults)})\n\n` +
    `Cache read/write tokens: ${formatCompactCount(promptStats.cacheReadTokens)} / ${formatCompactCount(promptStats.cacheCreationTokens)}\n` +
    `Cache hit rate: ${promptStats.cacheHitRatePct}% (${promptStats.cacheReadRequests}/${req})\n\n` +
    `📉 **Top model cost + cache economics**\n` +
    `${modelLines}`
  );
}

// ─── Limits channel auto-update ─────────────────────────────────────────────
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

  // Post initial dashboard
  await updateDashboard();

  // Update every 5 minutes
  updateInterval = setInterval(() => {
    updateDashboard().catch((err) =>
      console.error('Dashboard update error:', err instanceof Error ? err.message : 'Unknown')
    );
  }, DASHBOARD_UPDATE_INTERVAL_MS);
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
    console.warn('Live billing refresh failed:', err instanceof Error ? err.message : 'Unknown');
  });

  const embed = getUsageEmbed();

  // Try to edit existing message first — avoids delete+recreate spam
  if (dashboardMessageId) {
    try {
      const existing = await limitsChannel.messages.fetch(dashboardMessageId);
      await existing.edit({ embeds: [embed] });
      return;
    } catch {
      // Message was deleted or can't be fetched — fall through to create new one
      dashboardMessageId = null;
    }
  }

  // Clear old messages and post fresh
  try {
    const messages = await limitsChannel.messages.fetch({ limit: 50 });
    if (messages.size > 0) {
      await limitsChannel.bulkDelete(messages, true).catch(async () => {
        // bulkDelete fails on messages > 14 days old — delete individually (sequentially to respect rate limits)
        for (const m of messages.values()) {
          await m.delete().catch(() => {});
        }
      });
    }
  } catch {
    // Ignore cleanup errors
  }

  const msg = await limitsChannel.send({ embeds: [embed] });
  dashboardMessageId = msg.id;
}
