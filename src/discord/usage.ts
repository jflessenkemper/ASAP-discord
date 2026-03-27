import { TextChannel, EmbedBuilder } from 'discord.js';

// ─── Daily limits (configurable via env vars) ───────────────────────────────
const DAILY_LIMITS = {
  /** Max Claude input+output tokens per day */
  claudeTokens: parseInt(process.env.DAILY_LIMIT_CLAUDE_TOKENS || '2000000', 10),
  /** Max Gemini API calls per day (TTS + transcription) */
  geminiCalls: parseInt(process.env.DAILY_LIMIT_GEMINI_CALLS || '500', 10),
  /** Max ElevenLabs characters per day */
  elevenLabsChars: parseInt(process.env.DAILY_LIMIT_ELEVENLABS_CHARS || '10000', 10),
  /** Hard dollar budget — ALL agents stop when this is exceeded */
  budgetUsd: parseFloat(process.env.DAILY_BUDGET_USD || '2.00'),
};

// ─── Usage counters ─────────────────────────────────────────────────────────
interface UsageCounters {
  claudeInputTokens: number;
  claudeOutputTokens: number;
  geminiCalls: number;
  geminiInputTokens: number;
  elevenLabsChars: number;
  lastReset: string; // ISO date string (YYYY-MM-DD)
}

const usage: UsageCounters = {
  claudeInputTokens: 0,
  claudeOutputTokens: 0,
  geminiCalls: 0,
  geminiInputTokens: 0,
  elevenLabsChars: 0,
  lastReset: new Date().toISOString().split('T')[0],
};

function resetIfNewDay(): void {
  const today = new Date().toISOString().split('T')[0];
  if (usage.lastReset !== today) {
    usage.claudeInputTokens = 0;
    usage.claudeOutputTokens = 0;
    usage.geminiCalls = 0;
    usage.geminiInputTokens = 0;
    usage.elevenLabsChars = 0;
    usage.lastReset = today;
  }
}

// ─── Recording functions ────────────────────────────────────────────────────
export function recordClaudeUsage(inputTokens: number, outputTokens: number): void {
  resetIfNewDay();
  usage.claudeInputTokens += inputTokens;
  usage.claudeOutputTokens += outputTokens;
}

export function recordGeminiUsage(calls: number = 1): void {
  resetIfNewDay();
  usage.geminiCalls += calls;
}

export function recordElevenLabsUsage(chars: number): void {
  resetIfNewDay();
  usage.elevenLabsChars += chars;
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
  return estimateDailyCost().total >= DAILY_LIMITS.budgetUsd;
}

/** Get remaining budget in USD (for injection into agent prompts) */
export function getRemainingBudget(): { remaining: number; spent: number; limit: number } {
  resetIfNewDay();
  const spent = estimateDailyCost().total;
  return {
    remaining: Math.max(0, DAILY_LIMITS.budgetUsd - spent),
    spent,
    limit: DAILY_LIMITS.budgetUsd,
  };
}

// ─── Cost estimates ─────────────────────────────────────────────────────────
// Claude pricing per 1M tokens (Anthropic API direct)
// Opus 4: $15 input / $75 output — only used by Ace (developer)
// Sonnet 4: $3 input / $15 output — used by all other agents
// We use a blended rate assuming ~90% Sonnet usage
const CLAUDE_INPUT_COST_PER_M = 4.2;   // blended: 0.9*3 + 0.1*15
const CLAUDE_OUTPUT_COST_PER_M = 21.0;  // blended: 0.9*15 + 0.1*75
// Gemini 2.0 Flash — very cheap, approximate
const GEMINI_COST_PER_CALL = 0.0005;
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
  const totalRatio = Math.max(
    totalClaudeTokens / DAILY_LIMITS.claudeTokens,
    usage.geminiCalls / DAILY_LIMITS.geminiCalls,
    usage.elevenLabsChars / DAILY_LIMITS.elevenLabsChars
  );
  const color = totalRatio >= 0.9 ? 0xed4245 : totalRatio >= 0.7 ? 0xfee75c : 0x57f287;

  return new EmbedBuilder()
    .setTitle('📊 ASAP Usage Dashboard')
    .setColor(color)
    .addFields(
      {
        name: '🧠 Claude (Anthropic)',
        value:
          `${progressBar(totalClaudeTokens, DAILY_LIMITS.claudeTokens)}\n` +
          `${totalClaudeTokens.toLocaleString()} / ${DAILY_LIMITS.claudeTokens.toLocaleString()} tokens\n` +
          `(${usage.claudeInputTokens.toLocaleString()} in · ${usage.claudeOutputTokens.toLocaleString()} out)\n` +
          `Est: **$${cost.claude.toFixed(4)}**`,
      },
      {
        name: '🔊 Gemini (TTS + Transcription)',
        value:
          `${progressBar(usage.geminiCalls, DAILY_LIMITS.geminiCalls)}\n` +
          `${usage.geminiCalls} / ${DAILY_LIMITS.geminiCalls} API calls\n` +
          `Est: **$${cost.gemini.toFixed(4)}**`,
      },
      {
        name: '🗣️ ElevenLabs (TTS)',
        value:
          `${progressBar(usage.elevenLabsChars, DAILY_LIMITS.elevenLabsChars)}\n` +
          `${usage.elevenLabsChars.toLocaleString()} / ${DAILY_LIMITS.elevenLabsChars.toLocaleString()} chars\n` +
          `Est: **$${cost.elevenLabs.toFixed(4)}**`,
      },
      {
        name: '💰 Total Cost Today',
        value: `**$${cost.total.toFixed(4)}**`,
        inline: true,
      }
    )
    .setFooter({ text: 'Resets at midnight UTC · Updates every hour' })
    .setTimestamp();
}

/** Plain-text report for /limits command */
export function getUsageReport(): string {
  resetIfNewDay();
  const totalClaudeTokens = usage.claudeInputTokens + usage.claudeOutputTokens;
  const cost = estimateDailyCost();

  return (
    `📊 **ASAP Usage Dashboard** — ${usage.lastReset}\n\n` +
    `**Claude (Anthropic)**\n` +
    `${progressBar(totalClaudeTokens, DAILY_LIMITS.claudeTokens)}\n` +
    `${totalClaudeTokens.toLocaleString()} / ${DAILY_LIMITS.claudeTokens.toLocaleString()} tokens` +
    ` (${usage.claudeInputTokens.toLocaleString()} in · ${usage.claudeOutputTokens.toLocaleString()} out)\n` +
    `Est. cost: **$${cost.claude.toFixed(4)}**\n\n` +
    `**Gemini (TTS + Transcription)**\n` +
    `${progressBar(usage.geminiCalls, DAILY_LIMITS.geminiCalls)}\n` +
    `${usage.geminiCalls} / ${DAILY_LIMITS.geminiCalls} API calls\n` +
    `Est. cost: **$${cost.gemini.toFixed(4)}**\n\n` +
    `**ElevenLabs (TTS)**\n` +
    `${progressBar(usage.elevenLabsChars, DAILY_LIMITS.elevenLabsChars)}\n` +
    `${usage.elevenLabsChars.toLocaleString()} / ${DAILY_LIMITS.elevenLabsChars.toLocaleString()} characters\n` +
    `Est. cost: **$${cost.elevenLabs.toFixed(4)}**\n\n` +
    `💰 **Total estimated cost today: $${cost.total.toFixed(4)}**`
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
 * Start periodic dashboard updates (every 1 hour).
 * Clears the channel and posts a fresh embed each time.
 */
export async function startDashboardUpdates(): Promise<void> {
  if (!limitsChannel) return;

  // Post initial dashboard
  await updateDashboard();

  // Update every 1 hour
  updateInterval = setInterval(() => {
    updateDashboard().catch((err) =>
      console.error('Dashboard update error:', err instanceof Error ? err.message : 'Unknown')
    );
  }, 60 * 60 * 1000);
}

export function stopDashboardUpdates(): void {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
}

async function updateDashboard(): Promise<void> {
  if (!limitsChannel) return;

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
