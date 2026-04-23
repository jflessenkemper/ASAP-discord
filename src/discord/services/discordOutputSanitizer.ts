import { generateAnthropicText } from '../../services/anthropicText';
import { DEFAULT_FAST_MODEL, isAnthropicModel } from '../../services/modelConfig';

import { errMsg } from '../../utils/errors';

const DISCORD_OUTPUT_SANITIZER_ENABLED = String(process.env.DISCORD_OUTPUT_SANITIZER_ENABLED || 'true').toLowerCase() !== 'false';

function resolveDiscordOutputSanitizerModel(): string {
  const configured = String(process.env.DISCORD_OUTPUT_SANITIZER_MODEL || '').trim();
  const candidate = configured || DEFAULT_FAST_MODEL;
  if (candidate.toLowerCase() === 'claude-3-5-haiku-latest') {
    return DEFAULT_FAST_MODEL;
  }
  return candidate;
}

const DISCORD_OUTPUT_SANITIZER_MODEL = resolveDiscordOutputSanitizerModel();
const DISCORD_OUTPUT_SANITIZER_TIMEOUT_MS = Math.max(1000, parseInt(process.env.DISCORD_OUTPUT_SANITIZER_TIMEOUT_MS || '6000', 10));
const DISCORD_OUTPUT_SANITIZER_MAX_INPUT_CHARS = Math.max(200, parseInt(process.env.DISCORD_OUTPUT_SANITIZER_MAX_INPUT_CHARS || '3200', 10));
const DISCORD_TOOL_LINE_MAX_CHARS = Math.max(120, parseInt(process.env.DISCORD_TOOL_LINE_MAX_CHARS || '220', 10));

// ────────────────────── Tool Chain Display ──────────────────────
// Copilot-style live-updating tool chain with per-tool emojis.

const TOOL_EMOJI: Record<string, string> = {
  // File operations
  read_file: '📖', write_file: '✍️', edit_file: '✏️', batch_edit: '✏️',
  search_files: '🔍', list_directory: '📂',
  // Execution
  run_command: '⚙️', run_tests: '🧪', typecheck: '🔬',
  // Git / GitHub
  git_create_branch: '🌿', create_pull_request: '📬', merge_pull_request: '🔀',
  add_pr_comment: '💬', list_pull_requests: '📋', github_search: '🔍',
  // Discord channels
  list_channels: '📺', delete_channel: '🗑️', create_channel: '📺',
  rename_channel: '✏️', set_channel_topic: '📝', send_channel_message: '💬',
  delete_category: '🗑️', move_channel: '📦',
  // GCP / Deploy
  gcp_preflight: '🔍', gcp_build_image: '🏗️', gcp_deploy: '🚀',
  gcp_set_env: '⚙️', gcp_get_env: '📖', gcp_list_revisions: '📋',
  gcp_rollback: '⏮️', gcp_build_status: '📊', gcp_logs_query: '📋',
  gcp_run_describe: '📊', gcp_redeploy_bot_vm: '🚀', gcp_vm_ssh: '💻',
  gcp_project_info: '📊', gcp_storage_ls: '📂', gcp_artifact_list: '📋',
  gcp_sql_describe: '🗄️',
  // Secrets
  gcp_secret_set: '🔐', gcp_secret_bind: '🔐', gcp_secret_list: '🔐',
  // Database
  db_query: '🗄️', db_query_readonly: '🗄️', db_schema: '🗄️',
  // Memory
  memory_read: '🧠', memory_write: '🧠', memory_append: '🧠', memory_list: '🧠',
  // Screenshots / mobile
  capture_screenshots: '📸', mobile_harness_start: '📱', mobile_harness_step: '📱',
  mobile_harness_snapshot: '📸', mobile_harness_stop: '📱',
  // Network
  fetch_url: '🌐', read_logs: '📋',
};

export function getToolEmoji(toolName: string): string {
  return TOOL_EMOJI[toolName] || '🔧';
}

export interface ToolChainEntry {
  emoji: string;
  summary: string;
  status: 'running' | 'done';
}

const TOOL_CHAIN_MAX_VISIBLE = parseInt(process.env.TOOL_CHAIN_MAX_VISIBLE || '15', 10);

export class ToolChainTracker {
  private entries: ToolChainEntry[] = [];

  startTool(toolName: string, summary: string): void {
    this.entries.push({
      emoji: getToolEmoji(toolName),
      summary: sanitizeToolFragment(summary),
      status: 'running',
    });
  }

  completeTool(toolName: string, summary: string): void {
    const clean = sanitizeToolFragment(summary);
    // Mark the matching running entry as done (last match first for parallel calls)
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].status === 'running' && this.entries[i].summary === clean) {
        this.entries[i].status = 'done';
        return;
      }
    }
    // No running match — add as already completed
    this.entries.push({ emoji: getToolEmoji(toolName), summary: clean, status: 'done' });
  }

  render(maxVisible = TOOL_CHAIN_MAX_VISIBLE): string {
    if (this.entries.length === 0) return '';
    const visible = this.entries.length <= maxVisible
      ? this.entries
      : this.entries.slice(-maxVisible);
    const hidden = this.entries.length - visible.length;

    const lines = visible.map((e) => {
      const marker = e.status === 'done' ? ' ✓' : '…';
      return `${e.emoji} ${e.summary}${marker}`;
    });
    if (hidden > 0) lines.unshift(`*… ${hidden} earlier tools*`);
    return lines.join('\n');
  }

  get size(): number { return this.entries.length; }
  get isEmpty(): boolean { return this.entries.length === 0; }

  /** Read-only access for alternate renderers (e.g. the turn tracker). */
  snapshot(): ReadonlyArray<ToolChainEntry> {
    return this.entries;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Discord sanitizer timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function neutralizeMentions(text: string): string {
  return text
    .replace(/@everyone/gi, '@\u200beveryone')
    .replace(/@here/gi, '@\u200bhere');
}

function truncateWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function sanitizeDiscordVisibleOutputLocal(text: string): string {
  const normalized = String(text || '')
    .replace(/\[TOOL:[^\]]+\]/gi, '')
    .replace(/\[\s*ACTION:[^\]]+\]/gi, '')
    .replace(/\r\n/g, '\n')
    .trim();

  return neutralizeMentions(normalized);
}

export async function sanitizeDiscordVisibleOutput(text: string): Promise<string> {
  const local = sanitizeDiscordVisibleOutputLocal(text);
  if (!local) return local;
  if (!DISCORD_OUTPUT_SANITIZER_ENABLED) return local;
  if (!isAnthropicModel(DISCORD_OUTPUT_SANITIZER_MODEL)) return local;
  if (local.length > DISCORD_OUTPUT_SANITIZER_MAX_INPUT_CHARS) return local;
  if (local.includes('```')) return local;

  try {
    const rewritten = await withTimeout(generateAnthropicText({
      model: DISCORD_OUTPUT_SANITIZER_MODEL,
      maxTokens: 320,
      temperature: 0,
      system: [
        'You sanitize Discord-bound assistant messages.',
        'Rewrite only when needed.',
        'Preserve meaning, claims, and tone.',
        'Do not add new facts.',
        'Keep markdown light and valid.',
        'Remove leaked tool markers, leaked machine envelope text, and unsafe broadcast mentions.',
        'Return only the final sanitized message text.',
      ].join(' '),
      prompt: `Sanitize this Discord message while preserving meaning:\n\n${local}`,
    }), DISCORD_OUTPUT_SANITIZER_TIMEOUT_MS);
    const cleaned = sanitizeDiscordVisibleOutputLocal(rewritten);
    return cleaned || local;
  } catch (err) {
    console.warn('Discord output sanitizer fallback:', errMsg(err));
    return local;
  }
}

function sanitizeToolFragment(text: string): string {
  return neutralizeMentions(
    String(text || '')
      .replace(/[\[\]`]/g, '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

export function formatToolNotificationItem(toolName: string, summary: string): string {
  const cleanedTool = sanitizeToolFragment(toolName) || 'tool';
  const cleanedSummary = sanitizeToolFragment(summary);
  if (!cleanedSummary) return cleanedTool;
  return `${cleanedTool}: ${cleanedSummary}`;
}

export function buildToolNotificationLine(items: string[], maxChars = DISCORD_TOOL_LINE_MAX_CHARS): string {
  const prefix = '🔧 ';
  const cleanedItems = items
    .map((item) => sanitizeToolFragment(item))
    .filter(Boolean);

  if (cleanedItems.length === 0) return prefix.trim();

  const limit = Math.max(prefix.length + 12, maxChars);
  let body = '';
  let used = 0;

  for (let i = 0; i < cleanedItems.length; i += 1) {
    const candidate = body ? `${body} | ${cleanedItems[i]}` : cleanedItems[i];
    if ((prefix.length + candidate.length) > limit) {
      const remaining = cleanedItems.length - used;
      if (!body) {
        body = truncateWithEllipsis(cleanedItems[i], limit - prefix.length);
      } else if (remaining > 0) {
        const suffix = ` | +${remaining} more`;
        body = truncateWithEllipsis(body, limit - prefix.length - suffix.length) + suffix;
      }
      break;
    }
    body = candidate;
    used = i + 1;
  }

  return `${prefix}${body}`.replace(/[\r\n]+/g, ' ').trim();
}