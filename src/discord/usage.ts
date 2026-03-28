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
  budgetUsd: parseFloat(process.env.DAILY_BUDGET_USD || '2.00'),
};
const DEFAULT_BUDGET_APPROVAL_INCREMENT_USD = parseFloat(process.env.BUDGET_APPROVAL_INCREMENT_USD || '5.00');
const DASHBOARD_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

/** Optional running Anthropic credit cap — no longer used with Gemini */
const ANTHROPIC_CREDIT_CAP_USD = 0;

// ─── Usage counters ─────────────────────────────────────────────────────────
interface UsageCounters {
  claudeInputTokens: number;
  claudeOutputTokens: number;
  geminiCalls: number;
  geminiInputTokens: number;
  elevenLabsChars: number;
  approvedBudgetUsd: number;
  lastReset: string; // ISO date string (YYYY-MM-DD)
}

const usage: UsageCounters = {
  claudeInputTokens: 0,
  claudeOutputTokens: 0,
  geminiCalls: 0,
  geminiInputTokens: 0,
  elevenLabsChars: 0,
  approvedBudgetUsd: 0,
  lastReset: new Date().toISOString().split('T')[0],
};

const USAGE_DB_KEY = 'usage-counters-v1';
let usageLoaded = false;
let usageDirty = false;
let usageWriteTimer: ReturnType<typeof setTimeout> | null = null;

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
      usage.geminiCalls = Number(parsed.geminiCalls) || 0;
      usage.geminiInputTokens = Number(parsed.geminiInputTokens) || 0;
      usage.elevenLabsChars = Number(parsed.elevenLabsChars) || 0;
      usage.approvedBudgetUsd = Number(parsed.approvedBudgetUsd) || 0;
      usage.lastReset = typeof parsed.lastReset === 'string'
        ? parsed.lastReset
        : new Date().toISOString().split('T')[0];
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
    usage.geminiCalls = 0;
    usage.geminiInputTokens = 0;
    usage.elevenLabsChars = 0;
    usage.approvedBudgetUsd = 0;
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
export function recordClaudeUsage(inputTokens: number, outputTokens: number): void {
  resetIfNewDay();
  usage.claudeInputTokens += inputTokens;
  usage.claudeOutputTokens += outputTokens;
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
// Gemini pricing per 1M tokens (Google AI / Vertex AI)
// Gemini 2.0 Flash: $0.075 input / $0.30 output
// Gemini 2.5 Pro:   $1.25  input / $10.00 output
// Blended rate assuming ~90% Flash usage:
const CLAUDE_INPUT_COST_PER_M = 0.20;   // blended: 0.9*0.075 + 0.1*1.25
const CLAUDE_OUTPUT_COST_PER_M = 1.27;  // blended: 0.9*0.30  + 0.1*10.00
// Gemini TTS/transcription calls — very cheap
const GEMINI_COST_PER_CALL = 0.0001;
// ElevenLabs — depends on plan, approximate per character
const ELEVENLABS_COST_PER_CHAR = 0.00018;

function estimateDailyCost(): { claude: number; gemini: number; elevenLabs: number; total: number } {
  const claude =
    (usage.claudeInputTokens / 1_000_000) * CLAUDE_INPUT_COST_PER_M +
    (usage.claudeOutputTokens / 1_000_000) * CLAUDE_OUTPUT_COST_PER_M;
  const gemini = usage.geminiCalls * GEMINI_COST_PER_CALL;
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
        name: '🧠 Gemini LLM (Google)',
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

  const liveLine = live.available && live.dailyCostUsd !== null
    ? `Live GCP billed spend today (UTC): **$${live.dailyCostUsd.toFixed(4)} ${live.currency}** (month-to-date **$${(live.monthCostUsd || 0).toFixed(4)} ${live.currency}**).`
    : `Live GCP billed spend is currently unavailable (${live.error || 'no billing metric data yet'}).`;

  return (
    `📊 **ASAP Usage Dashboard** — ${usage.lastReset}\n\n` +
    `${liveLine}\n\n` +
    `**Gemini LLM (Google)**\n` +
    `${progressBar(totalClaudeTokens, DAILY_LIMITS.claudeTokens)}\n` +
    `${totalClaudeTokens.toLocaleString()} / ${DAILY_LIMITS.claudeTokens.toLocaleString()} tokens` +
    ` (${usage.claudeInputTokens.toLocaleString()} in · ${usage.claudeOutputTokens.toLocaleString()} out)\n` +
    `Estimated spend: **$${cost.claude.toFixed(4)}**\n\n` +
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

// ─── Limits channel auto-update ─────────────────────────────────────────────
let limitsChannel: TextChannel | null = null;
let dashboardMessageId: string | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;

export function setLimitsChannel(channel: TextChannel): void {
  limitsChannel = channel;
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
