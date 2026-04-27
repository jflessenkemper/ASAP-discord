import { execSync, execFileSync, exec } from 'child_process';
import { createHash } from 'crypto';
import dns from 'dns';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { promisify } from 'util';

import {
  Guild,
  ChannelType,
  TextChannel,
  CategoryChannel,
  EmbedBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
} from 'discord.js';

import {
  createBranch,
  createPullRequest,
  mergePullRequest,
  addPRComment,
  listPullRequests,
  searchGitHub,
} from '../services/github';

import { getAgent, AgentId, createDynamicAgent, destroyDynamicAgent, listDynamicAgents, getAgents, getOwnerName } from './agents';
import { getRequiredReviewers } from './handlers/review';
import { setActiveSmokeTestRunning } from './handlers/groupchat';
import { mobileHarnessStart, mobileHarnessStep, mobileHarnessSnapshot, mobileHarnessStop } from './services/mobileHarness';
import { captureAndPostScreenshots } from './services/screenshots';
import { getWebhook } from './services/webhooks';
import { clearConversationTokens, getConversationTokenUsage, setConversationTokenLimit, setDailyBudgetLimit, setDailyClaudeTokenLimit } from './usage';
import { upsertMemory, appendMemoryRow, readMemoryRow } from './memory';
import {
  toolJobScan,
  toolJobEvaluate,
  toolJobTracker,
  toolJobProfileUpdate,
  toolJobPostApprovals,
  toolJobDraftApplication,
  toolJobSubmitApplication,
} from './tools/jobTools';
import { runReportBlocker } from './tools/blockerTool';
import { jobScoreColor, SYSTEM_COLORS, BUTTON_IDS } from './ui/constants';
import { errMsg } from '../utils/errors';
import { formatAge } from '../utils/time';
import { gcpDeploy, gcpBuildImage, gcpPreflight, gcpSetEnv, gcpGetEnv, gcpListRevisions, gcpRollback, gcpSecretSet, gcpSecretBind, gcpSecretList, gcpBuildStatus, gcpLogsQuery, gcpRunDescribe, gcpStorageLs, gcpArtifactList, gcpSqlDescribe, gcpVmSsh, gcpRedeployBotVm, gcpProjectInfo } from './toolsGcp';
import { buildSafeCommandEnv } from './envSandbox';
import { DDL_PATTERN, sanitizeSql, isReadOnlySql, dbQuery, dbQueryReadonly, dbSchema } from './toolsDb';

// ── Circuit Breaker (inlined) ──────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitOpenError extends Error {
  constructor(public readonly serviceName: string) {
    super(`Circuit breaker OPEN for "${serviceName}" — service is temporarily unavailable. Will retry after cooldown.`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private lastFailureAt = 0;
  private lastSuccessAt = 0;
  private openedAt = 0;
  private halfOpenProbeInFlight = false;

  constructor(
    public readonly name: string,
    private readonly failureThreshold: number = 5,
    private readonly cooldownMs: number = 60_000,
    private readonly windowMs: number = 120_000,
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.decayIfStale();

    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half_open';
      } else {
        throw new CircuitOpenError(this.name);
      }
    }

    if (this.state === 'half_open') {
      if (this.halfOpenProbeInFlight) {
        throw new CircuitOpenError(this.name);
      }
      this.halfOpenProbeInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  isAvailable(): boolean {
    this.decayIfStale();
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      return Date.now() - this.openedAt >= this.cooldownMs;
    }
    return !this.halfOpenProbeInFlight;
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.halfOpenProbeInFlight = false;
  }

  recordSuccess(): void { this.onSuccess(); }
  recordFailure(): void { this.onFailure(); }

  getStats() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      openedAt: this.openedAt,
      halfOpenProbeInFlight: this.halfOpenProbeInFlight,
    };
  }

  private onSuccess(): void {
    this.successes++;
    this.lastSuccessAt = Date.now();
    this.halfOpenProbeInFlight = false;
    if (this.state === 'half_open') {
      this.state = 'closed';
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureAt = Date.now();
    this.halfOpenProbeInFlight = false;
    if (this.state === 'half_open') {
      this.state = 'open';
      this.openedAt = Date.now();
      return;
    }
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      console.warn(`[circuit-breaker] ${this.name}: OPEN after ${this.failures} failures. Cooldown ${this.cooldownMs / 1000}s.`);
    }
  }

  private decayIfStale(): void {
    const lastEvent = Math.max(this.lastFailureAt, this.lastSuccessAt);
    if (lastEvent > 0 && Date.now() - lastEvent > this.windowMs) {
      this.failures = Math.floor(this.failures / 2);
      this.successes = Math.floor(this.successes / 2);
      if (this.state === 'open' && this.failures < this.failureThreshold) {
        this.state = 'closed';
      }
    }
  }
}

const TOOL_SERVICE_MAP: Record<string, string> = {
  git_create_branch: 'github', create_pull_request: 'github', merge_pull_request: 'github',
  add_pr_comment: 'github', list_pull_requests: 'github', github_search: 'github',
  gcp_preflight: 'gcp', gcp_build_image: 'gcp', gcp_deploy: 'gcp', gcp_set_env: 'gcp',
  gcp_get_env: 'gcp', gcp_list_revisions: 'gcp', gcp_rollback: 'gcp', gcp_secret_set: 'gcp',
  gcp_secret_bind: 'gcp', gcp_secret_list: 'gcp', gcp_build_status: 'gcp', gcp_logs_query: 'gcp',
  gcp_run_describe: 'gcp', gcp_storage_ls: 'gcp', gcp_artifact_list: 'gcp', gcp_sql_describe: 'gcp',
  gcp_vm_ssh: 'gcp', gcp_redeploy_bot_vm: 'gcp', gcp_project_info: 'gcp',
  deploy_app: 'gcp',
  fetch_url: 'fetch', capture_screenshots: 'screenshots', job_scan: 'job_search',
};

const breakers = new Map<string, CircuitBreaker>();

function getOrCreateBreaker(service: string): CircuitBreaker {
  let breaker = breakers.get(service);
  if (!breaker) {
    breaker = new CircuitBreaker(service);
    breakers.set(service, breaker);
  }
  return breaker;
}

export function getCircuitBreakerForTool(toolName: string): CircuitBreaker | undefined {
  const service = TOOL_SERVICE_MAP[toolName];
  if (!service) return undefined;
  return getOrCreateBreaker(service);
}

export function getCircuitBreaker(serviceName: string): CircuitBreaker {
  return getOrCreateBreaker(serviceName);
}

export function getAllCircuitBreakerStats() {
  return Array.from(breakers.values()).map((b) => b.getStats());
}


// Discord Guild + per-agent channel resolver now live in ./guildRegistry so
// other module splits can share them without risking a cycle through tools.ts.
export { setDiscordGuild, setAgentChannelResolver } from './guildRegistry';
import { getDiscordGuild, requireGuild as requireGuildShared, resolveAgentChannel } from './guildRegistry';

/** Channels that must never be deleted by agents (canonical key form). */
const PROTECTED_CHANNEL_KEYS = [
  'groupchat',
  'voice',
  'thread-status',
  'decisions',
  'github',
  'upgrades',
  'tools',
  'call-log',
  'limits',
  'cost',
  'screenshots',
  'url',
  'terminal',
  'voice-errors',
  'agent-errors',
];

function toChannelProtectionKey(name: string): string {
  return String(name || '').toLowerCase().replace(/^[^a-z0-9]+/, '');
}

/** Callback for triggering auto-review on PR creation — set from bot.ts */
let prReviewCallback: ((prNumber: number, prTitle: string, changedFiles: string[], diffSummary: string) => Promise<void>) | null = null;

export function setPRReviewCallback(
  cb: (prNumber: number, prTitle: string, changedFiles: string[], diffSummary: string) => Promise<void>
): void {
  prReviewCallback = cb;
}

/** Callback for triggering smoke tests after PR merge — set from bot.ts */
let smokeTestCallback: ((prNumber: number, changedFiles: string[]) => Promise<void>) | null = null;

export function setSmokeTestCallback(
  cb: ((prNumber: number, changedFiles: string[]) => Promise<void>) | null
): void {
  smokeTestCallback = cb;
}

/**
 * Safe repository root for agent code tools.
 * AGENT_REPO_ROOT can point tools at a different checkout (e.g., /opt/asap-app)
 * while the bot runtime itself lives in ASAP-discord.
 */
const DEFAULT_REPO_ROOT = fs.existsSync('/app/package.json')
  ? '/app'
  : path.resolve(__dirname, '..', '..');
const REPO_ROOT = process.env.AGENT_REPO_ROOT
  ? path.resolve(process.env.AGENT_REPO_ROOT)
  : DEFAULT_REPO_ROOT;
const SERVER_ROOT = fs.existsSync(path.join(REPO_ROOT, 'server', 'package.json'))
  ? path.join(REPO_ROOT, 'server')
  : REPO_ROOT;

/**
 * "Self" repository root — the bot's own source code (asap-bot).
 *
 * REPO_ROOT typically points at the user-facing app (e.g., /opt/asap-app)
 * so specialists work on user features. SELF_REPO_ROOT lets Cortana and
 * the operations-manager read+edit the bot's own code via the *_self_*
 * tool family, which is how she fixes things like voice-chat bugs in her
 * own runtime.
 *
 * Defaults to the directory the running process was launched from
 * (process.cwd) — that's /opt/asap-bot in production. Override via
 * SELF_REPO_ROOT env var.
 */
const SELF_REPO_ROOT = process.env.SELF_REPO_ROOT
  ? path.resolve(process.env.SELF_REPO_ROOT)
  : process.cwd();

/** Directories agents are never allowed to touch */
const BLOCKED_PATHS = [
  '.env',
  'node_modules',
  '.git/objects',
  '.git/refs',
  '.git/HEAD',
];

/** Argus file size agents can write (2 MB) */
const MAX_WRITE_SIZE = 2 * 1024 * 1024;

/** Argus command execution time (2 min) */
const CMD_TIMEOUT = 120_000;
const AUTO_REPO_MEMORY_UPDATE = String(process.env.AUTO_REPO_MEMORY_UPDATE ?? 'true').toLowerCase() !== 'false';
const TOOL_RESULT_CACHE_TTL_MS = Math.max(1_000, Number(process.env.TOOL_RESULT_CACHE_TTL_MS || '45000'));
const TOOL_RESULT_CACHE_MAX_ENTRIES = Math.max(200, Number(process.env.TOOL_RESULT_CACHE_MAX_ENTRIES || '2000'));
const HOT_SEARCH_INDEX_TTL_MS = Math.max(5_000, Number(process.env.HOT_SEARCH_INDEX_TTL_MS || '120000'));
const HOT_SEARCH_INDEX_MAX_CHUNKS = Math.max(200, Number(process.env.HOT_SEARCH_INDEX_MAX_CHUNKS || '5000'));

type ToolCacheEntry = { result: string; expiresAt: number };
const toolResultCache = new Map<string, ToolCacheEntry>();
const toolInFlight = new Map<string, Promise<string>>();

type HotSearchChunk = { path: string; text: string; textLower: string; tokens: Set<string> };
let hotSearchIndexBuiltAt = 0;
let hotSearchIndex: HotSearchChunk[] = [];


/** Cache validated paths to avoid re-resolving. LRU-like with size cap. */
const safePathCache = new Map<string, string>();
const SAFE_PATH_CACHE_MAX = 500;

function safePath(relative: string): string {
  const cached = safePathCache.get(relative);
  if (cached) return cached;

  const resolved = path.resolve(REPO_ROOT, relative);

  if (!resolved.startsWith(REPO_ROOT)) {
    throw new Error(`Path escapes repository root: ${relative}`);
  }

  const rel = path.relative(REPO_ROOT, resolved);
  for (const blocked of BLOCKED_PATHS) {
    if (rel === blocked || rel.startsWith(blocked + '/') || rel.startsWith(blocked + path.sep)) {
      throw new Error(`Access denied: ${relative}`);
    }
  }

  if (safePathCache.size >= SAFE_PATH_CACHE_MAX) {
    const firstKey = safePathCache.keys().next().value;
    if (firstKey !== undefined) safePathCache.delete(firstKey);
  }
  safePathCache.set(relative, resolved);
  return resolved;
}

/**
 * Like safePath, but resolves against SELF_REPO_ROOT (the bot's own code).
 * Used by the *_self_* tool family that lets Cortana and ops-manager read
 * and edit the asap-bot codebase for self-repair.
 */
function safePathSelf(relative: string): string {
  const resolved = path.resolve(SELF_REPO_ROOT, relative);
  if (!resolved.startsWith(SELF_REPO_ROOT)) {
    throw new Error(`Path escapes self-repo root: ${relative}`);
  }
  const rel = path.relative(SELF_REPO_ROOT, resolved);
  for (const blocked of BLOCKED_PATHS) {
    if (rel === blocked || rel.startsWith(blocked + '/') || rel.startsWith(blocked + path.sep)) {
      throw new Error(`Access denied: ${relative}`);
    }
  }

  return resolved;
}


export const REPO_TOOLS = [
  {
    name: 'read_file',
    description:
      'Read the contents of a file in the target repository. Use relative paths from the repo root.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path from repo root',
        },
        offset: {
          type: 'number',
          description: 'Optional character offset to start reading from for paged reads',
        },
        max_bytes: {
          type: 'number',
          description: 'Optional maximum characters to return for this read page',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a file in the target repository. Use relative paths. Parent directories are created automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path from repo root',
        },
        content: {
          type: 'string',
          description: 'Full file content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must appear exactly once. Always read_file first, copy old_string verbatim, include 2-3 context lines.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path from repo root',
        },
        old_string: {
          type: 'string',
          description: 'Exact text to find (must appear exactly once)',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'search_files',
    description:
      'Search for a text pattern (regex) across files in the repository. Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for (case-insensitive)',
        },
        include: {
          type: 'string',
          description: 'Optional glob to filter files, e.g. "server/src/**/*.ts"',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_directory',
    description:
      'List files and subdirectories in a directory. Directories end with /.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative directory path from repo root (use "." for root)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'check_file_exists',
    description:
      'Check whether a file or directory exists without reading full contents. Useful to avoid redundant scans and save tokens.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from repo root',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the repo root. 2-minute timeout, sandboxed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory relative to repo root (default: repo root)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'git_create_branch',
    description:
      'Create a new git branch from main (or specified base). Use this before making changes for a PR workflow.',
    input_schema: {
      type: 'object' as const,
      properties: {
        branch_name: {
          type: 'string',
          description: 'New branch name (e.g. "feat/add-fuel-tab")',
        },
        base_branch: {
          type: 'string',
          description: 'Base branch to branch from (default: main)',
        },
      },
      required: ['branch_name'],
    },
  },
  {
    name: 'create_pull_request',
    description:
      'Create a GitHub pull request. Commits must be pushed to the branch first using run_command with git commands.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'PR title',
        },
        body: {
          type: 'string',
          description: 'PR description (markdown)',
        },
        head: {
          type: 'string',
          description: 'Source branch name',
        },
        base: {
          type: 'string',
          description: 'Target branch (default: main)',
        },
      },
      required: ['title', 'body', 'head'],
    },
  },
  {
    name: 'merge_pull_request',
    description:
      'Merge a pull request by number. Uses squash merge. Tests must pass first (enforced).',
    input_schema: {
      type: 'object' as const,
      properties: {
        pr_number: {
          type: 'number',
          description: 'Pull request number to merge',
        },
        commit_title: {
          type: 'string',
          description: 'Optional custom commit title for the squash merge',
        },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'add_pr_comment',
    description:
      'Add a comment to a pull request. Useful for posting review results, test output, or status updates.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pr_number: {
          type: 'number',
          description: 'Pull request number',
        },
        body: {
          type: 'string',
          description: 'Comment body (markdown)',
        },
      },
      required: ['pr_number', 'body'],
    },
  },
  {
    name: 'list_pull_requests',
    description:
      'List open pull requests on the target repository.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'run_tests',
    description:
      'Run the test suite (npm test). Returns pass/fail with output. Use this before merging PRs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        test_pattern: {
          type: 'string',
          description: 'Optional test file pattern to match (e.g. "auth" to run auth-related tests)',
        },
      },
      required: [],
    },
  },
  {
    name: 'git_file_history',
    description:
      'Show recent git commits affecting a file or folder, with optional line blame. Use this to identify regressions, who changed a screen, or when a behavior was introduced.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative file or folder path from repo root, e.g. "app/_layout.tsx"',
        },
        limit: {
          type: 'number',
          description: 'Argus commits to return (default: 10, max: 30)',
        },
        line_range: {
          type: 'string',
          description: 'Optional line range for blame, e.g. "20-40"',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'smoke_test_agents',
    description:
      'Run the Discord smoke-test suite. Supports agent/capability/profile filters and rerun-failed mode.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent: {
          type: 'string',
          description: 'Optional agent filter, e.g. "developer", "qa", or "executive-assistant". Leave empty to run the whole suite.',
        },
        tests: {
          type: 'string',
          description: 'Optional comma-separated capability filter, e.g. "read-and-summarize,memory-write". Only runs tests matching these capability names.',
        },
        profile: {
          type: 'string',
          description: 'Optional test profile: "readiness" (18 critical gate tests), "matrix" (full 155-test matrix). Default runs all tests.',
          enum: ['readiness', 'matrix'],
        },
        rerun_failed: {
          type: 'boolean',
          description: 'If true, only re-run tests that failed in the most recent smoke report.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional per-agent timeout in milliseconds (default: 90000, max: 180000).',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_threads',
    description:
      'List workspace threads under the groupchat channel, including idle time and a ready-to-close heuristic. Useful for Cortana to manage stale or completed threads.',
    input_schema: {
      type: 'object' as const,
      properties: {
        include_archived: {
          type: 'string',
          description: 'Set to "true" to also include recently archived threads.',
        },
        limit: {
          type: 'number',
          description: 'Argus threads to show (default: 10, max: 25).',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_channels',
    description:
      'List all channels in the Discord server, grouped by category. Shows channel name, type (text/voice/category), and topic.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'delete_channel',
    description:
      'Delete a Discord channel by name. Protected core channels cannot be deleted. Use clear_channel_messages for reset/clear.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel_name: {
          type: 'string',
          description: 'Exact channel name to delete',
        },
        reason: {
          type: 'string',
          description: 'Reason for deletion (logged in audit)',
        },
      },
      required: ['channel_name', 'reason'],
    },
  },
  {
    name: 'create_channel',
    description:
      'Create a new text channel in the Discord server, optionally under a category.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel_name: {
          type: 'string',
          description: 'Channel name (lowercase, hyphens for spaces)',
        },
        category: {
          type: 'string',
          description: 'Category name to place the channel under (optional)',
        },
        topic: {
          type: 'string',
          description: 'Channel topic/description',
        },
      },
      required: ['channel_name'],
    },
  },
  {
    name: 'rename_channel',
    description:
      'Rename a Discord channel.',
    input_schema: {
      type: 'object' as const,
      properties: {
        old_name: {
          type: 'string',
          description: 'Current channel name',
        },
        new_name: {
          type: 'string',
          description: 'New channel name',
        },
      },
      required: ['old_name', 'new_name'],
    },
  },
  {
    name: 'set_channel_topic',
    description:
      'Update the topic/description of a Discord channel.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel_name: {
          type: 'string',
          description: 'Channel name',
        },
        topic: {
          type: 'string',
          description: 'New topic text',
        },
      },
      required: ['channel_name', 'topic'],
    },
  },
  {
    name: 'send_channel_message',
    description:
      'Send a message to a specific Discord channel. Useful for posting announcements, updates, or summaries.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel_name: {
          type: 'string',
          description: 'Channel name to send to',
        },
        message: {
          type: 'string',
          description: 'Message content (supports Discord markdown)',
        },
      },
      required: ['channel_name', 'message'],
    },
  },
  {
    name: 'clear_channel_messages',
    description:
      'Delete messages inside a text channel without deleting the channel itself. Use this when asked to reset/clear a channel.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel_name: {
          type: 'string',
          description: 'Channel name to clear',
        },
        limit: {
          type: 'string',
          description: 'Optional max messages to delete (default 500, max 2000)',
        },
      },
      required: ['channel_name'],
    },
  },
  {
    name: 'read_channel_messages',
    description:
      'Read recent messages from a Discord channel. Supports text search filtering.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel_name: {
          type: 'string',
          description: 'Channel name to read from (e.g. "agent-errors", "agent-audit", "model-health", "smoke-tests")',
        },
        limit: {
          type: 'number',
          description: 'Number of recent messages to fetch (default 20, max 100)',
        },
        search: {
          type: 'string',
          description: 'Optional text filter — only return messages containing this string (case-insensitive)',
        },
      },
      required: ['channel_name'],
    },
  },
  {
    name: 'delete_category',
    description:
      'Delete an empty Discord category. Fails if the category still has channels.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category_name: {
          type: 'string',
          description: 'Category name to delete',
        },
      },
      required: ['category_name'],
    },
  },
  {
    name: 'move_channel',
    description:
      'Move a channel to a different category.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel_name: {
          type: 'string',
          description: 'Channel name to move',
        },
        category: {
          type: 'string',
          description: 'Target category name',
        },
      },
      required: ['channel_name', 'category'],
    },
  },
  {
    name: 'read_logs',
    description:
      'Read recent Cloud Run runtime logs (stdout/stderr). Use this to diagnose production errors, crashes, or unexpected behaviour after deployments. Returns the most recent log entries.',
    input_schema: {
      type: 'object' as const,
      properties: {
        severity: {
          type: 'string',
          description: 'Minimum log severity: DEFAULT, INFO, WARNING, ERROR. Default: WARNING',
        },
        limit: {
          type: 'number',
          description: 'Max number of log entries to return (default: 30, max: 100)',
        },
        query: {
          type: 'string',
          description: 'Optional text filter — only return logs containing this string',
        },
      },
      required: [],
    },
  },
  {
    name: 'github_search',
    description:
      'Search the GitHub repo for code, issues/PRs, or commits.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query (GitHub search syntax supported)',
        },
        type: {
          type: 'string',
          description: 'What to search: "code", "issues", or "commits". Default: code',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'typecheck',
    description:
      'Run TypeScript type-checking (tsc --noEmit). Returns any type errors found.',
    input_schema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Which codebase to check: "client", "server", or "both". Default: both',
        },
      },
      required: [],
    },
  },
  {
    name: 'batch_edit',
    description:
      'Apply multiple file edits in one call. Each edit replaces an exact string (must appear once). Always read_file first. Edits apply sequentially.',
    input_schema: {
      type: 'object' as const,
      properties: {
        edits: {
          type: 'array',
          description: 'Array of edit operations',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative file path from repo root' },
              old_string: { type: 'string', description: 'Exact text to find (must appear exactly once)' },
              new_string: { type: 'string', description: 'Replacement text' },
            },
            required: ['path', 'old_string', 'new_string'],
          },
        },
      },
      required: ['edits'],
    },
  },
  {
    name: 'capture_screenshots',
    description:
      'Capture screenshots of the live app and post to Discord. Uses headless mobile Chromium.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'App URL to screenshot. Defaults to the deployed ASAP app.',
        },
        label: {
          type: 'string',
          description: 'Label for this screenshot batch (e.g. "after login fix", "new dashboard")',
        },
        channel_name: {
          type: 'string',
          description: 'Optional Discord text channel name to post screenshots into (without #).',
        },
      },
      required: [],
    },
  },
  {
    name: 'mobile_harness_start',
    description:
      'Start an interactive iPhone 17 Pro Argus web harness session for this agent. Opens a live page in headless mobile emulation and posts a snapshot to Discord.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'App URL to open. Defaults to deployed ASAP app URL.',
        },
        label: {
          type: 'string',
          description: 'Snapshot label for the start state.',
        },
        channel_name: {
          type: 'string',
          description: 'Optional Discord text channel name for snapshots.',
        },
      },
      required: [],
    },
  },
  {
    name: 'mobile_harness_step',
    description:
      'Perform one interactive action in the active mobile harness session, then post a fresh snapshot.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          description: 'Action type: tap | type | wait | goto | key | back',
        },
        selector: {
          type: 'string',
          description: 'CSS selector used by tap/type actions.',
        },
        text: {
          type: 'string',
          description: 'Text payload for type action.',
        },
        ms: {
          type: 'number',
          description: 'Delay in milliseconds for wait action.',
        },
        url: {
          type: 'string',
          description: 'URL for goto action.',
        },
        key: {
          type: 'string',
          description: 'Keyboard key for key action (for example Enter, Tab, Escape).',
        },
        label: {
          type: 'string',
          description: 'Snapshot label for this step.',
        },
        channel_name: {
          type: 'string',
          description: 'Optional Discord text channel name for snapshots.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'mobile_harness_snapshot',
    description:
      'Post a snapshot from the active mobile harness session without taking any action.',
    input_schema: {
      type: 'object' as const,
      properties: {
        label: {
          type: 'string',
          description: 'Snapshot label.',
        },
        channel_name: {
          type: 'string',
          description: 'Optional Discord text channel name for snapshots.',
        },
      },
      required: [],
    },
  },
  {
    name: 'mobile_harness_stop',
    description:
      'Close the active mobile harness session for this agent and free browser resources.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'gcp_preflight',
    description:
      'Run a GCP readiness check before mutating actions. Verifies active project/account, required APIs, and Cloud Run service visibility.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'gcp_build_image',
    description:
      'Build and push a Docker image via Cloud Build only (no Cloud Run deploy). Use when you need an image artifact without changing live traffic.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tag: {
          type: 'string',
          description: 'Optional image tag/label for tracking (e.g. "feat-fuel-tab")',
        },
      },
      required: [],
    },
  },
  {
    name: 'gcp_deploy',
    description:
      'Build a Docker image with Cloud Build, deploy it to Cloud Run, and verify the latest revision/service URL. Use after merging PRs or pushing to main.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tag: {
          type: 'string',
          description: 'Optional build tag/label for tracking (e.g. "feat-fuel-tab")',
        },
      },
      required: [],
    },
  },
  {
    name: 'deploy_app',
    description:
      'Deploy the ASAP app to Cloud Run via Cloud Build (uses cloudbuild.yaml in the app repo). Optionally commits and pushes pending changes first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        commit_message: {
          type: 'string',
          description: 'If provided, git add + commit + push changes with this message before deploying.',
        },
      },
      required: [],
    },
  },
  {
    name: 'gcp_set_env',
    description:
      'Set or update environment variables on the Cloud Run service. Changes take effect on the next deployment or by forcing a new revision.',
    input_schema: {
      type: 'object' as const,
      properties: {
        variables: {
          type: 'string',
          description: 'Comma-separated KEY=VALUE pairs, e.g. "LOG_LEVEL=debug,FEATURE_FLAG=true"',
        },
      },
      required: ['variables'],
    },
  },
  {
    name: 'gcp_get_env',
    description:
      'Get all current environment variables set on the Cloud Run service. Useful for debugging configuration issues.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'gcp_list_revisions',
    description:
      'List Cloud Run revisions (deployments). Shows revision name, traffic allocation, creation time, and status. Use this to find a revision to rollback to.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Number of revisions to list (default: 10)',
        },
      },
      required: [],
    },
  },
  {
    name: 'gcp_rollback',
    description:
      'Rollback Cloud Run to a specific revision by routing 100% of traffic to it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        revision: {
          type: 'string',
          description: 'Revision name to rollback to (e.g. "asap-00042-abc")',
        },
      },
      required: ['revision'],
    },
  },
  {
    name: 'gcp_secret_set',
    description:
      'Create or update a secret in GCP Secret Manager. This does NOT attach the secret to Cloud Run by itself.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Secret name (e.g. "STRIPE_API_KEY")',
        },
        value: {
          type: 'string',
          description: 'Secret value',
        },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'gcp_secret_bind',
    description:
      'Bind Secret Manager secrets into the Cloud Run service via env vars using --update-secrets. Example: "DISCORD_BOT_TOKEN=DISCORD_BOT_TOKEN:latest"',
    input_schema: {
      type: 'object' as const,
      properties: {
        bindings: {
          type: 'string',
          description: 'Comma-separated ENV_VAR=SECRET_NAME[:VERSION] pairs',
        },
      },
      required: ['bindings'],
    },
  },
  {
    name: 'gcp_secret_list',
    description:
      'List all secrets in GCP Secret Manager. Does NOT show values, only names and metadata.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'gcp_build_status',
    description:
      'Get the status of recent Cloud Build builds. Shows build ID, status, duration, and trigger info.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Number of builds to show (default: 5)',
        },
      },
      required: [],
    },
  },
  {
    name: 'gcp_logs_query',
    description:
      'Query Cloud Logging with a full filter expression. Supports any resource type, severity, and time ranges.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filter: {
          type: 'string',
          description: 'Cloud Logging filter, e.g. "resource.type=cloud_run_revision severity>=ERROR" or "resource.type=gce_instance"',
        },
        limit: {
          type: 'number',
          description: 'Argus log lines (default: 50, max: 200)',
        },
      },
      required: ['filter'],
    },
  },
  {
    name: 'gcp_run_describe',
    description:
      'Get detailed status of the Cloud Run service: URL, latest revision, traffic splits, and environment variable names. Use to verify a deployment went live.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'gcp_storage_ls',
    description:
      'List files and folders in a GCS bucket. Use to browse uploaded evidence, build artifacts, or other GCS content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bucket: {
          type: 'string',
          description: 'Bucket name without gs:// prefix, e.g. "asap-evidence"',
        },
        prefix: {
          type: 'string',
          description: 'Optional path prefix to list a sub-folder, e.g. "jobs/2024/"',
        },
      },
      required: ['bucket'],
    },
  },
  {
    name: 'gcp_artifact_list',
    description:
      'List Docker images and tags in Artifact Registry. Useful for identifying rollback targets or confirming a build was pushed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Argus images to show (default: 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'gcp_sql_describe',
    description:
      'Get Cloud SQL instance details: connection name, IP address, database version, tier, and state. Use for DBA work or debugging connection issues.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'gcp_vm_ssh',
    description:
      'Run a validated command on the bot VM via SSH. Commands must match the safe allowlist.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'Command to run on the VM. Allowed prefixes: pm2 status/restart/logs/list, git pull/log/status/rev-parse/fetch, npm run build/ci/install, node --version, df -h, free -h, uptime',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'gcp_redeploy_bot_vm',
    description:
      'Redeploy the VM-hosted Discord bot in the background. Fetches git, resets to a ref, installs deps, builds, and restarts PM2 without requiring arbitrary SSH commands.',
    input_schema: {
      type: 'object' as const,
      properties: {
        ref: {
          type: 'string',
          description: 'Optional git ref to deploy on the bot VM (default: origin/main)',
        },
      },
      required: [],
    },
  },
  {
    name: 'gcp_project_info',
    description:
      'Get a high-level overview of the GCP project: enabled APIs, project ID, and region. Use to confirm what services are active or debug "API not enabled" errors.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'set_daily_budget',
    description:
      'Set the daily AI spend cap in USD. Takes effect immediately and persists across restarts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit_usd: {
          type: 'number',
          description: 'New daily hard budget cap in USD (e.g. 150 for $150/day). Must be ≥ 0.',
        },
        reason: {
          type: 'string',
          description: 'Brief reason for the change, e.g. "Owner approved $150 limit for today\'s sprint".',
        },
      },
      required: ['limit_usd'],
    },
  },
  {
    name: 'set_daily_claude_token_limit',
    description:
      'Set the daily Claude token cap. Takes effect immediately and persists across restarts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit_tokens: {
          type: 'number',
          description: 'New daily Claude token cap, e.g. 12000000. Must be greater than 0.',
        },
        reason: {
          type: 'string',
          description: 'Brief reason for the change, e.g. "Owner approved higher token ceiling for self-improvement".',
        },
      },
      required: ['limit_tokens'],
    },
  },
  {
    name: 'set_conversation_token_limit',
    description:
      'Set the per-conversation token window used to keep long Discord threads healthy. Takes effect immediately and persists across restarts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit_tokens: {
          type: 'number',
          description: 'New per-conversation hard token cap. Must be greater than 1.',
        },
        warn_tokens: {
          type: 'number',
          description: 'Optional warning threshold below the hard cap. Defaults to about 60% of the limit.',
        },
        reason: {
          type: 'string',
          description: 'Brief reason for the change.',
        },
      },
      required: ['limit_tokens'],
    },
  },
  {
    name: 'reset_conversation_token_window',
    description:
      'Clear the token window for the current Discord conversation thread so Cortana can continue without opening a fresh workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {
        thread_key: {
          type: 'string',
          description: 'Optional explicit thread key. If omitted, uses the active conversation thread key.',
        },
        reason: {
          type: 'string',
          description: 'Brief reason for the reset.',
        },
      },
      required: [],
    },
  },
  {
    name: 'fetch_url',
    description:
      'Fetch any URL content (web pages, APIs, docs). Returns response body as text. Supports GET and POST.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch (must start with https:// or http://)',
        },
        method: {
          type: 'string',
          description: 'HTTP method: GET or POST (default: GET)',
        },
        headers: {
          type: 'string',
          description: 'Optional JSON string of headers, e.g. \'{"Authorization": "Bearer token"}\'',
        },
        body: {
          type: 'string',
          description: 'Optional request body for POST requests',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'memory_read',
    description:
      'Read a persistent memory file. Memory persists across conversations and bot restarts. Use this to recall context, plans, decisions, preferences, and lessons learned. Files are stored in the PostgreSQL database.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: {
          type: 'string',
          description: 'Memory file name (e.g. "plans.md", "lessons.md", "jordan-prefs.md")',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'memory_write',
    description:
      'Write to a persistent memory file. Creates or overwrites the file. Use this to store plans, decisions, lessons learned, user preferences, task context, or anything you want to remember across conversations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: {
          type: 'string',
          description: 'Memory file name (e.g. "plans.md", "lessons.md", "jordan-prefs.md")',
        },
        content: {
          type: 'string',
          description: 'Content to write',
        },
      },
      required: ['file', 'content'],
    },
  },
  {
    name: 'memory_append',
    description:
      'Append to a persistent memory file without overwriting existing content. Use this to add new notes, log entries, or incremental updates.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: {
          type: 'string',
          description: 'Memory file name',
        },
        content: {
          type: 'string',
          description: 'Content to append (added on a new line)',
        },
      },
      required: ['file', 'content'],
    },
  },
  {
    name: 'memory_list',
    description:
      'List all persistent memory files. Use this to see what memories exist before reading.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'repo_memory_index',
    description:
      'Build or refresh the persistent searchable repo index in PostgreSQL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        mode: {
          type: 'string',
          description: 'Indexing mode: "incremental" (default) or "full".',
        },
        max_files: {
          type: 'number',
          description: 'Optional file cap for one run (default: 1200, max: 4000).',
        },
      },
      required: [],
    },
  },
  {
    name: 'repo_memory_search',
    description:
      'Search the persistent repo/OSS knowledge index. Returns relevant chunks with source paths.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language or keyword query.',
        },
        limit: {
          type: 'number',
          description: 'Optional result limit (default: 8, max: 20).',
        },
        source: {
          type: 'string',
          description: 'Optional source filter: "repo", "oss", or "all" (default: all).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'repo_memory_add_oss',
    description:
      'Persist external/open-source knowledge notes into the searchable index so agents can reuse them later.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Short OSS note title, e.g. "discordjs-rate-limits".',
        },
        content: {
          type: 'string',
          description: 'Knowledge content to store.',
        },
        tags: {
          type: 'string',
          description: 'Optional comma-separated tags, e.g. "discord.js,rate-limit,webhooks".',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'db_query_readonly',
    description:
      'Execute a read-only SQL query against the PostgreSQL database. Writes are blocked.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Read-only SQL query to execute.',
        },
        params: {
          type: 'string',
          description: 'Optional JSON array of query parameters, e.g. ["value1", 42]',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'db_query',
    description:
      'Execute a SQL query against the PostgreSQL database. Read and write queries supported.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'SQL query to execute. Use parameterized queries with $1, $2 etc for values.',
        },
        params: {
          type: 'string',
          description: 'Optional JSON array of query parameters, e.g. \'["value1", 42]\'',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'db_schema',
    description:
      'Inspect the database schema. Lists all tables and their columns, types, and constraints. Use this to understand the data model before writing queries.',
    input_schema: {
      type: 'object' as const,
      properties: {
        table: {
          type: 'string',
          description: 'Optional: specific table name to inspect. If omitted, lists all tables.',
        },
      },
      required: [],
    },
  },
  {
    name: 'job_scan',
    description:
      'Scan for job listings in Australia/NSW. Searches Adzuna API and tracked company portals (Greenhouse/Ashby/Lever). Returns new listings matching your profile. Deduplicates automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        keywords: {
          type: 'string',
          description: 'Optional search keywords to override profile target roles, e.g. "typescript react"',
        },
        source: {
          type: 'string',
          description: 'Optional: "adzuna", "portals", or "all" (default). Which sources to scan.',
        },
      },
      required: [],
    },
  },
  {
    name: 'job_evaluate',
    description:
      'Evaluate a job listing against the user profile. Pass the listing ID to score it 1-5 on role match, skills gap, comp alignment, and location fit.',
    input_schema: {
      type: 'object' as const,
      properties: {
        listing_id: {
          type: 'string',
          description: 'The job_listings.id to evaluate',
        },
      },
      required: ['listing_id'],
    },
  },
  {
    name: 'job_tracker',
    description:
      'View and manage your job application pipeline. Lists jobs by status with counts. Use action "list" (default), "summary", or "update".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          description: '"list" to list jobs (optionally filtered by status), "summary" for status counts, "update" to change a listing status',
        },
        status: {
          type: 'string',
          description: 'For list: filter by status (scanned|evaluated|approved|rejected|applied|interview|offer|discarded). For update: new status.',
        },
        listing_id: {
          type: 'string',
          description: 'For update: the job_listings.id to update',
        },
      },
      required: [],
    },
  },
  {
    name: 'job_profile_update',
    description:
      'Create or update the job search profile. Store CV text, target roles, keyword filters, salary range, location, contact details, deal-breakers. Also seeds default AU company portals on first use.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cv_text: { type: 'string', description: 'CV/resume in markdown format' },
        target_roles: { type: 'string', description: 'Comma-separated target role titles, e.g. "Software Engineer,Full Stack Developer"' },
        keywords_pos: { type: 'string', description: 'Comma-separated positive title keywords, e.g. "engineer,developer,architect"' },
        keywords_neg: { type: 'string', description: 'Comma-separated negative title keywords to exclude, e.g. "intern,junior,graduate"' },
        salary_min: { type: 'string', description: 'Minimum annual salary in AUD' },
        salary_max: { type: 'string', description: 'Maximum annual salary in AUD' },
        location: { type: 'string', description: 'Target location, default "New South Wales"' },
        remote_ok: { type: 'string', description: '"true" or "false" — whether remote Australian jobs are acceptable' },
        deal_breakers: { type: 'string', description: 'Freeform deal-breaker notes' },
        preferences: { type: 'string', description: 'Freeform preference notes' },
        first_name: { type: 'string', description: 'First name for job applications' },
        last_name: { type: 'string', description: 'Last name for job applications' },
        email: { type: 'string', description: 'Email for job applications' },
        phone: { type: 'string', description: 'Phone number for job applications' },
      },
      required: [],
    },
  },
  {
    name: 'job_post_approvals',
    description:
      'Post evaluated job listings as approval cards to the #job-applications channel. Each card gets ✅/❌ reactions for the user to approve or reject. Only posts listings with status "evaluated" and score >= 3.0.',
    input_schema: {
      type: 'object' as const,
      properties: {
        min_score: {
          type: 'string',
          description: 'Minimum score to include, default 3.0',
        },
        limit: {
          type: 'string',
          description: 'Max listings to post, default 10',
        },
      },
      required: [],
    },
  },
  {
    name: 'job_draft_application',
    description:
      'Draft a tailored cover letter and resume highlights for a specific job listing using the user profile. Posts the draft in #career-ops. Use this to manually trigger or re-draft an application.',
    input_schema: {
      type: 'object' as const,
      properties: {
        listing_id: {
          type: 'string',
          description: 'The job_listings.id to draft an application for',
        },
      },
      required: ['listing_id'],
    },
  },
  {
    name: 'job_submit_application',
    description:
      'Submit a drafted application to a Greenhouse job board. Requires listing to have a draft (cover letter + resume) and the portal to have a board_api_key configured. Only works for Greenhouse-sourced listings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        listing_id: {
          type: 'string',
          description: 'The job_listings.id to submit',
        },
      },
      required: ['listing_id'],
    },
  },
  {
    name: 'create_agent',
    description:
      'Create a dynamic agent at runtime. Only Cortana (executive-assistant) can use this tool. The agent exists for the current session only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Unique agent ID (must not conflict with static agents)' },
        name: { type: 'string', description: 'Display name, e.g. "Alex (Data Analyst)"' },
        handle: { type: 'string', description: 'Short handle for mentions, e.g. "alex"' },
        emoji: { type: 'string', description: 'Emoji for the agent channel, e.g. "📊"' },
        system_prompt: { type: 'string', description: 'System prompt defining the agent personality and capabilities' },
      },
      required: ['id', 'name', 'handle', 'emoji', 'system_prompt'],
    },
  },
  {
    name: 'remove_agent',
    description:
      'Remove a dynamic agent created at runtime. Cannot remove static/built-in agents. Only Cortana (executive-assistant) can use this tool.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'ID of the dynamic agent to remove' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'list_agents',
    description:
      'List all agents (static and dynamic) with their ID, name, emoji, and status.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'error_patterns',
    description:
      'Query recent error patterns from the agent activity log. Shows recurring errors grouped by frequency. Useful for diagnosing systemic issues and learning from past failures.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'Optional agent ID to filter errors for. Leave empty for all agents.' },
        hours: { type: 'number', description: 'How many hours back to look. Default 24.' },
      },
      required: [],
    },
  },
  {
    name: 'recover_agent_memory',
    description:
      'Recover archived memory for a previously destroyed dynamic agent. Restores conversation history and learnings. Only works if the agent was previously created and then destroyed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_id: { type: 'string', description: 'The agent ID to recover memory for.' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'recall_user_memory',
    description:
      "Search the user's own past activity (messages, voice transcripts, images they sent, reactions, button clicks) by semantic similarity. Use this before responding when the current request references prior context (\"like I mentioned\", \"the screenshot from yesterday\", \"remember when\") to ground your answer in what actually happened. Returns the most relevant events with timestamps.",
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural-language search query describing what to recall.' },
        user_id: { type: 'string', description: 'Discord user id to search for. Omit to use the current conversation owner.' },
        limit: { type: 'number', description: 'Argus results to return (default 5, max 15).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_self_file',
    description:
      'Read a file from the BOT\'s own source repo (asap-bot, /opt/asap-bot) — your own runtime code. Use this for self-repair on voice chat, tool dispatch, message handling, etc. Path is relative to the bot repo root.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to the bot repo root (e.g., "src/discord/voice/connection.ts").' },
        offset: { type: 'number', description: 'Byte offset to start reading from. Optional.' },
        max_bytes: { type: 'number', description: 'Maximum bytes to return. Optional.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_self_files',
    description:
      'Search across the BOT\'s own source repo (asap-bot) — your own code. Same as search_files but scoped to your runtime, not the user-facing app.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for.' },
        include: { type: 'string', description: 'Optional file glob (e.g., "*.ts").' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'edit_self_file',
    description:
      'Edit a file in the BOT\'s own source repo (asap-bot). Replaces a UNIQUE occurrence of old_string with new_string. Use this to patch bugs in your own runtime — voice chat, message routing, tool dispatch. Changes apply on next deploy.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to the bot repo root.' },
        old_string: { type: 'string', description: 'The exact text to replace. Must appear exactly once.' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_self_directory',
    description: 'List contents of a directory in the BOT\'s own source repo (asap-bot).',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path relative to bot repo root. Use "." for the root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'check_self_file_exists',
    description: 'Check whether a file or directory exists in the BOT\'s own source repo (asap-bot).',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path relative to bot repo root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_self_typecheck',
    description: 'Run `tsc --noEmit` on the BOT repo (asap-bot). Use after edit_self_file to confirm types still check before opening a PR.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'run_self_tests',
    description: 'Run `jest` on the BOT repo (asap-bot). Use after edit_self_file to verify the change. Optional pattern narrows test paths.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Optional --testPathPatterns string (e.g. "voice|callSession").' },
      },
      required: [],
    },
  },
  {
    name: 'commit_self_changes',
    description: 'Stage + commit + push your edit_self_file changes to a feature branch on the BOT repo. Branch must start with "cortana/". Run typecheck + tests first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        branch: { type: 'string', description: 'Branch name, must start with "cortana/" (e.g. "cortana/voice-wav-fix").' },
        message: { type: 'string', description: 'Commit message — explain WHY, not just WHAT. 10–5000 chars.' },
      },
      required: ['branch', 'message'],
    },
  },
  {
    name: 'open_self_pull_request',
    description: 'Open a PR against the BOT repo main branch from a Cortana feature branch. Call after commit_self_changes succeeds.',
    input_schema: {
      type: 'object' as const,
      properties: {
        branch: { type: 'string', description: 'Source branch (must already exist remotely).' },
        title: { type: 'string', description: 'PR title (≥10 chars, summary of the fix).' },
        body: { type: 'string', description: 'Optional PR body. Default explains it\'s a Cortana self-repair PR.' },
      },
      required: ['branch', 'title'],
    },
  },
  {
    name: 'deploy_self',
    description: 'Pull origin/main on the VM, build, run migrations, restart the bot. Only run after Jordan merges your PR — pre-merge code is NOT deployed.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'report_blocker',
    description:
      'Report a blocker that is preventing you from completing a task — a missing tool, missing capability, unclear scope, or an external dependency you can\'t satisfy. Posts a structured upgrade request to #🆙-upgrades so Cortana can draft a proposal for Jordan to approve. Use this instead of silently giving up.',
    input_schema: {
      type: 'object' as const,
      properties: {
        issue: {
          type: 'string',
          description: 'What\'s blocking you, concrete and specific. One or two sentences.',
        },
        suggested_fix: {
          type: 'string',
          description: 'Optional: the capability or change that would unblock you (e.g., "a new tool that lets me X", "access to Y").',
        },
        impact: {
          type: 'string',
          description: 'Optional: what you can\'t deliver because of this blocker.',
        },
      },
      required: ['issue'],
    },
  },
] as const;

/**
 * Tool subset for review/advisory agents (QA, security, UX, etc.).
 * Keeps codebase write operations locked down, while allowing operational testing:
 * GCP inspect tools, screenshots, and mobile harness interactions.
 */
const REVIEW_TOOL_NAMES = new Set([
  'read_file', 'search_files', 'list_directory', 'check_file_exists', 'fetch_url',
  'db_query_readonly', 'db_schema', 'memory_read', 'memory_write', 'memory_append', 'memory_list',
  'repo_memory_index', 'repo_memory_search', 'repo_memory_add_oss',
  'recall_user_memory',
  'report_blocker',
  'run_tests', 'typecheck', 'git_file_history', 'smoke_test_agents', 'list_threads',
  'send_channel_message',
  'capture_screenshots',
  'mobile_harness_start', 'mobile_harness_step', 'mobile_harness_snapshot', 'mobile_harness_stop',
  'gcp_preflight', 'gcp_get_env', 'gcp_list_revisions', 'gcp_secret_list', 'gcp_build_status',
  'gcp_logs_query', 'gcp_run_describe', 'gcp_storage_ls', 'gcp_artifact_list', 'gcp_sql_describe', 'gcp_project_info',
]);
export const REVIEW_TOOLS = REPO_TOOLS.filter((t) => REVIEW_TOOL_NAMES.has(t.name));

/**
 * Cortana keeps a leaner coordination/ops-only surface so orchestration stays focused.
 * She can inspect state, run smoke checks, and communicate, but large code/deploy mutations
 * are delegated to the specialist agents.
 *
 * As EA she also has code mutation, PR workflow, and deploy tools so she can
 * self-improve, review open PRs, and implement upgrades autonomously.
 * Deploy and merge are gated by tests+typecheck enforcement at the tool level.
 */
const CORTANA_TOOL_NAMES = new Set([
  'read_file', 'search_files', 'list_directory', 'check_file_exists', 'fetch_url',
  'memory_read', 'memory_write', 'memory_append', 'memory_list',
  'repo_memory_index', 'repo_memory_search', 'repo_memory_add_oss',
  'run_tests', 'typecheck', 'git_file_history', 'smoke_test_agents',
  'list_threads', 'list_channels', 'send_channel_message', 'clear_channel_messages', 'read_channel_messages',
  'read_logs', 'github_search', 'capture_screenshots',
  'mobile_harness_start', 'mobile_harness_step', 'mobile_harness_snapshot', 'mobile_harness_stop',
  'gcp_preflight', 'gcp_get_env', 'gcp_list_revisions', 'gcp_secret_list', 'gcp_build_status',
  'gcp_logs_query', 'gcp_run_describe', 'gcp_storage_ls', 'gcp_artifact_list', 'gcp_sql_describe', 'gcp_project_info',
  'set_daily_budget', 'set_daily_claude_token_limit', 'set_conversation_token_limit', 'reset_conversation_token_window', 'db_query_readonly', 'db_schema',
  'job_scan', 'job_evaluate', 'job_tracker', 'job_profile_update', 'job_post_approvals',
  // ── Cortana autonomy: code mutation, PR workflow, deploy ──
  'write_file', 'edit_file', 'batch_edit', 'run_command',
  'git_create_branch', 'create_pull_request', 'merge_pull_request', 'add_pr_comment', 'list_pull_requests',
  'gcp_deploy', 'gcp_rollback', 'gcp_redeploy_bot_vm', 'deploy_app',
  // ── Cortana agent lifecycle ──
  'create_agent', 'remove_agent', 'list_agents',
  // ── Cortana ops & error analysis ──
  'error_patterns', 'recover_agent_memory',
  // ── Cortana self-repair: read + edit her own bot codebase ──
  'read_self_file', 'search_self_files', 'edit_self_file', 'list_self_directory', 'check_self_file_exists',
]);
export const CORTANA_TOOLS = REPO_TOOLS;

type PromptTool = {
  name: string;
  description: string;
  input_schema: any;
};

/**
 * Tool input as parsed from the AI model's JSON.
 * Values are typically strings, but can be objects/arrays for tools like batch_edit.
 */
export type ToolInput = Record<string, any>;

function compactSchemaNode(node: any): any {
  if (Array.isArray(node)) return node.map((item) => compactSchemaNode(item));
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description') continue;
    out[key] = compactSchemaNode(value);
  }
  return out;
}

function compactToolForPrompt(tool: any): PromptTool {
  const rawDescription = String(tool.description || tool.name).replace(/\s+/g, ' ').trim();
  const shortDescription = rawDescription.split(/(?<=[.!?])\s+/)[0]?.slice(0, 140) || tool.name;
  return {
    name: tool.name,
    description: shortDescription,
    input_schema: compactSchemaNode(tool.input_schema),
  };
}

/**
 * Compact prompt-facing tool definitions to reduce input tokens while
 * preserving the same executable tool surface.
 */
export const PROMPT_REPO_TOOLS: PromptTool[] = REPO_TOOLS.map(compactToolForPrompt);
export const PROMPT_REVIEW_TOOLS: PromptTool[] = REVIEW_TOOLS.map(compactToolForPrompt);
export const PROMPT_CORTANA_TOOLS: PromptTool[] = PROMPT_REPO_TOOLS;

const STRICT_AGENT_TOOL_ACCESS = String(process.env.STRICT_AGENT_TOOL_ACCESS ?? 'true').toLowerCase() !== 'false';
const CORTANA_AGENT_ID = 'executive-assistant';
const FULL_TOOL_ACCESS_AGENT_IDS = new Set(['executive-assistant', 'operations-manager', 'devops', 'ios-engineer', 'android-engineer']);
const REVIEW_TOOL_ACCESS_AGENT_IDS = new Set([
  'qa',
  'ux-reviewer',
  'security-auditor',
  'api-reviewer',
  'dba',
  'performance',
  'copywriter',
  'lawyer',
]);

/**
 * Self-repair tools (read/edit the bot's own code) are gated to Cortana
 * and the operations-manager only. Everyone else who has FULL_TOOL_ACCESS
 * still gets every other tool, just not the keys to the bot's own runtime.
 */
const SELF_REPAIR_AGENT_IDS = new Set(['executive-assistant', 'operations-manager']);
const SELF_REPAIR_TOOL_NAMES = new Set([
  'read_self_file', 'search_self_files', 'edit_self_file', 'list_self_directory', 'check_self_file_exists',
  'run_self_typecheck', 'run_self_tests', 'commit_self_changes', 'open_self_pull_request', 'deploy_self',
]);

function filterSelfRepairTools(
  tools: readonly (typeof REPO_TOOLS[number])[],
  agentId: string,
): readonly (typeof REPO_TOOLS[number])[] {
  if (SELF_REPAIR_AGENT_IDS.has(agentId)) return tools;
  return tools.filter((t) => !SELF_REPAIR_TOOL_NAMES.has(t.name));
}

function getRawToolsForAgent(agentId: string): readonly (typeof REPO_TOOLS[number])[] {
  const id = String(agentId || '').trim().toLowerCase();
  if (!STRICT_AGENT_TOOL_ACCESS) return filterSelfRepairTools(REPO_TOOLS, id);
  if (id === 'developer' || id === 'dev' || id === 'ace') return filterSelfRepairTools(REPO_TOOLS, id);
  if (FULL_TOOL_ACCESS_AGENT_IDS.has(id)) return filterSelfRepairTools(REPO_TOOLS, id);
  if (id === CORTANA_AGENT_ID) return REPO_TOOLS;
  if (REVIEW_TOOL_ACCESS_AGENT_IDS.has(id)) return REVIEW_TOOLS;
  // Unknown agents default to review-grade least privilege.
  return REVIEW_TOOLS;
}

export function getToolsForAgent(agentId: string, compactPrompt = false): readonly any[] {
  const rawTools = getRawToolsForAgent(agentId);
  if (!compactPrompt) return rawTools;
  const names = new Set<string>(rawTools.map((tool) => String(tool.name)));
  return PROMPT_REPO_TOOLS.filter((tool) => names.has(tool.name));
}

export function getAllowedToolNamesForAgent(agentId: string): Set<string> {
  return new Set(getRawToolsForAgent(agentId).map((tool) => tool.name));
}

export function agentCanUseTool(agentId: string, toolName: string): boolean {
  if (!STRICT_AGENT_TOOL_ACCESS) return true;
  return getAllowedToolNamesForAgent(agentId).has(toolName);
}


export async function executeTool(
  toolName: string,
  input: ToolInput,
  context?: { agentId?: string; threadKey?: string }
): Promise<string> {
  const scope = context?.threadKey || context?.agentId || 'global';
  const key = buildToolCacheKey(scope, toolName, input);
  const cacheable = isCacheableTool(toolName);

  if (context?.agentId && !agentCanUseTool(context.agentId, toolName)) {
    return `Error: Tool "${toolName}" is not allowed for agent "${context.agentId}".`;
  }

  // Circuit breaker check — short-circuit if service is persistently failing
  const breaker = getCircuitBreakerForTool(toolName);
  if (breaker && !breaker.isAvailable()) {
    return `Error: Service for "${toolName}" is temporarily unavailable (circuit breaker open). Will auto-recover after cooldown.`;
  }

  if (cacheable) {
    const cached = getCachedToolResult(key);
    if (cached !== null) return cached;

    const inFlight = toolInFlight.get(key);
    if (inFlight) return inFlight;
  }

  // Transient-error tool retry set (network-dependent tools worth retrying once)
  const RETRYABLE_TOOLS = new Set([
    'fetch_url', 'capture_screenshots', 'job_scan',
    'gcp_vm_ssh', 'gcp_logs_query', 'gcp_run_describe', 'gcp_build_status',
    'gcp_list_revisions', 'gcp_artifact_list', 'gcp_sql_describe',
  ]);

  const runPromise = executeToolInternal(toolName, input, context);
  if (cacheable) toolInFlight.set(key, runPromise);

  // Fire audit at entry so [TOOL:name] appears even if the tool throws
  if (toolAuditCallback && context?.agentId) {
    toolAuditCallback(context.agentId, toolName, '(started)');
  }

  try {
    let result = await runPromise;
    // One automatic retry for transient tool failures (network errors, timeouts)
    const isTransientError = RETRYABLE_TOOLS.has(toolName) && /^Error:.*(?:ECONNREFUSED|ETIMEDOUT|ENOTFOUND|timeout|socket hang up|503|502|500)/i.test(String(result || ''));
    if (isTransientError) {
      console.warn(`[tool-retry] ${toolName} transient failure, retrying once...`);
      result = await executeToolInternal(toolName, input, context);
    }
    // Track success/failure in circuit breaker
    if (breaker) {
      if (/^Error:/i.test(String(result || '').trim())) {
        breaker.recordFailure();
      } else {
        breaker.recordSuccess();
      }
    }
    if (cacheable && !/^Error:/i.test(String(result || '').trim())) {
      setCachedToolResult(key, result);
    }
    // Post completion audit with result summary
    if (toolAuditCallback && context?.agentId) {
      const summary = String(result || '').slice(0, 200);
      toolAuditCallback(context.agentId, toolName, summary);
    }
    return result;
  } finally {
    if (cacheable) toolInFlight.delete(key);
  }
}

const GITHUB_TOOL_TIMEOUT_MS = 120_000;

async function withGitHubTimeout(promise: Promise<string>, toolName: string): Promise<string> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<string>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`GitHub operation "${toolName}" timed out after ${GITHUB_TOOL_TIMEOUT_MS / 1000}s`)), GITHUB_TOOL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function executeToolInternal(
  toolName: string,
  input: ToolInput,
  context?: { agentId?: string; threadKey?: string }
): Promise<string> {
  try {
    const scope = context?.threadKey || context?.agentId;
    switch (toolName) {
      case 'read_file':
        return readFile(input.path, Number(input.offset), Number(input.max_bytes));
      case 'write_file':
        clearToolResultCache(scope);
        return writeFile(input.path, input.content);
      case 'edit_file':
        clearToolResultCache(scope);
        return editFile(input.path, input.old_string, input.new_string);
      case 'search_files':
        return searchFiles(input.pattern, input.include);
      case 'list_directory':
        return listDirectory(input.path);
      case 'check_file_exists':
        return checkFileExists(input.path);
      case 'run_command':
        return runCommand(input.command, input.cwd);
      case 'git_create_branch':
        return await withGitHubTimeout(gitCreateBranch(input.branch_name, input.base_branch), toolName);
      case 'create_pull_request':
        return await withGitHubTimeout(ghCreatePR(input.title, input.body, input.head, input.base), toolName);
      case 'merge_pull_request':
        return await withGitHubTimeout(ghMergePR(parseInt(input.pr_number, 10), input.commit_title, context?.agentId), toolName);
      case 'add_pr_comment':
        return await withGitHubTimeout(ghAddComment(parseInt(input.pr_number, 10), input.body), toolName);
      case 'list_pull_requests':
        return await withGitHubTimeout(ghListPRs(), toolName);
      case 'run_tests':
        clearToolResultCache(scope);
        return runTests(input.test_pattern);
      case 'git_file_history':
        return gitFileHistory(input.path, parseInt(input.limit, 10) || 10, input.line_range);
      case 'smoke_test_agents':
        return await smokeTestAgents({
          agent: input.agent,
          tests: input.tests,
          profile: input.profile,
          rerunFailed: String(input.rerun_failed) === 'true',
          timeoutMs: parseInt(input.timeout_ms, 10) || 90_000,
        });
      case 'list_channels':
        return await discordListChannels();
      case 'list_threads':
        return await discordListThreads(String(input.include_archived || '').toLowerCase() === 'true', parseInt(input.limit, 10) || 10);
      case 'delete_channel':
        return await discordDeleteChannel(input.channel_name, input.reason);
      case 'create_channel':
        return await discordCreateChannel(input.channel_name, input.category, input.topic);
      case 'rename_channel':
        return await discordRenameChannel(input.old_name, input.new_name);
      case 'set_channel_topic':
        return await discordSetTopic(input.channel_name, input.topic);
      case 'send_channel_message':
        return await discordSendMessage(input.channel_name, input.message, undefined, context?.agentId);
      case 'report_blocker':
        return await runReportBlocker(context?.agentId, {
          issue: input.issue,
          suggested_fix: input.suggested_fix,
          impact: input.impact,
        });
      case 'read_self_file':
        return readSelfFile(input.path, parseInt(input.offset, 10), parseInt(input.max_bytes, 10));
      case 'search_self_files':
        return searchSelfFiles(input.pattern, input.include);
      case 'edit_self_file':
        return editSelfFile(input.path, input.old_string, input.new_string);
      case 'list_self_directory':
        return listSelfDirectory(input.path);
      case 'check_self_file_exists':
        return checkSelfFileExists(input.path);
      case 'run_self_typecheck':
        return runSelfTypecheck();
      case 'run_self_tests':
        return runSelfTests(input.pattern);
      case 'commit_self_changes':
        return commitSelfChanges(input.branch, input.message);
      case 'open_self_pull_request':
        return await openSelfPullRequest(input.branch, input.title, input.body);
      case 'deploy_self':
        return deploySelf();
      case 'clear_channel_messages':
        return await discordClearChannelMessages(input.channel_name, parseInt(input.limit, 10) || 500);
      case 'read_channel_messages':
        return await discordReadChannelMessages(input.channel_name, parseInt(input.limit, 10) || 20, input.search);
      case 'delete_category':
        return await discordDeleteCategory(input.category_name);
      case 'move_channel':
        return await discordMoveChannel(input.channel_name, input.category);
      case 'read_logs':
        return await readRuntimeLogs(input.severity, parseInt(input.limit, 10) || 30, input.query);
      case 'github_search':
        return await ghSearch(input.query, (input.type as 'code' | 'issues' | 'commits') || 'code');
      case 'typecheck':
        clearToolResultCache(scope);
        return runTypecheck((input.target as 'client' | 'server' | 'both') || 'both');
      case 'batch_edit':
        clearToolResultCache(scope);
        return batchEdit(input.edits as any);
      case 'capture_screenshots': {
        const url = input.url || process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
        const label = (input.label || 'tool-invoked').slice(0, 100);
        const target = await resolveDiscordTextChannel(input.channel_name, context?.agentId);
        const results = await captureAndPostScreenshots(url, label, { targetChannel: target, clearTargetChannel: false });
        const destination = target ? `#${target.name}` : '#screenshots';
        const screenList = results.map((r) => r.name).join(', ');
        return `Screenshots captured and posted to ${destination}. URL: ${url}. Screens: ${screenList || 'none'}. ${results.length} image(s) captured on iPhone 17 Pro Argus viewport.`;
      }
      case 'mobile_harness_start': {
        const url = input.url || process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
        const target = await resolveDiscordTextChannel(input.channel_name, context?.agentId);
        const sessionId = context?.agentId || 'shared';
        return await mobileHarnessStart(sessionId, url, target, input.label);
      }
      case 'mobile_harness_step': {
        const target = await resolveDiscordTextChannel(input.channel_name, context?.agentId);
        const sessionId = context?.agentId || 'shared';
        return await mobileHarnessStep(
          sessionId,
          {
            action: (input.action as any) || 'wait',
            selector: input.selector,
            text: input.text,
            ms: input.ms ? Number(input.ms) : undefined,
            url: input.url,
            key: input.key,
          },
          target,
          input.label
        );
      }
      case 'mobile_harness_snapshot': {
        const target = await resolveDiscordTextChannel(input.channel_name, context?.agentId);
        const sessionId = context?.agentId || 'shared';
        return await mobileHarnessSnapshot(sessionId, target, input.label);
      }
      case 'mobile_harness_stop': {
        const sessionId = context?.agentId || 'shared';
        return await mobileHarnessStop(sessionId);
      }
      case 'gcp_preflight':
        return await gcpPreflight();
      case 'gcp_build_image':
        return await gcpBuildImage(input.tag);
      case 'gcp_deploy': {
        // Cortana gets tests+typecheck gate before deploy + audit notification
        if (context?.agentId === 'executive-assistant') {
          const testResult = runTests();
          if (testResult.includes('FAIL') || testResult.includes('Command failed')) {
            return `❌ Deploy blocked — tests failed:\n${testResult.slice(0, 1000)}`;
          }
          const tcResult = runTypecheck('server');
          if (tcResult.includes('❌')) {
            return `❌ Deploy blocked — typecheck failed:\n${tcResult.slice(0, 1000)}`;
          }
        }
        const deployResult = await gcpDeploy(input.tag);
        if (context?.agentId === 'executive-assistant' && deployResult.startsWith('✅')) {
          const auditCb = getToolAuditCallback();
          if (auditCb) auditCb(context.agentId, 'gcp_deploy', `Cortana self-deployed: ${input.tag || 'latest'}`);
          // Notify groupchat via send_channel_message
          const notifyMsg = `🚀 **Cortana self-deployed** to Cloud Run: ${input.tag || 'latest'}. Tests + typecheck passed. @${getOwnerName().toLowerCase()}`;
          await discordSendMessage('groupchat', notifyMsg, undefined, context.agentId).catch(e => console.error('[deploy] groupchat notify failed:', errMsg(e)));
          await discordSendMessage('upgrades', `🚀 Cortana self-deployed revision: ${input.tag || 'latest'}`, undefined, context.agentId).catch(e => console.error('[deploy] upgrades notify failed:', errMsg(e)));
          // Post-deploy: kick off readiness smoke tests automatically
          smokeTestAgents({ profile: 'readiness', timeoutMs: 90_000 })
            .then(async (smokeResult) => {
              const passed = smokeResult.includes('100%') || (smokeResult.includes('pass') && !smokeResult.includes('FAIL'));
              const emoji = passed ? '✅' : '⚠️';
              const summary = smokeResult.length > 1500 ? smokeResult.slice(-1500) : smokeResult;
              await discordSendMessage('operations', `${emoji} **Post-deploy readiness smoke** (${input.tag || 'latest'}):\n${summary}`, undefined, context.agentId).catch(e => console.error('[deploy] ops smoke-post failed:', errMsg(e)));
            })
            .catch(e => console.error('[deploy] post-deploy smoke failed:', errMsg(e)));
        }
        return deployResult;
      }
      case 'deploy_app': {
        const { deployApp: deployAppFn } = await import('./toolsGcp');
        const result = await deployAppFn(input.commit_message);
        if (result.startsWith('✅')) {
          await discordSendMessage('groupchat', `🚀 **App deploy submitted** to Cloud Run via Cloud Build.`, undefined, context?.agentId).catch(() => {});
        }
        return result;
      }
      case 'gcp_set_env':
        return await gcpSetEnv(input.variables);
      case 'gcp_get_env':
        return await gcpGetEnv();
      case 'gcp_list_revisions':
        return await gcpListRevisions(parseInt(input.limit, 10) || 10);
      case 'gcp_rollback':
        return await gcpRollback(input.revision);
      case 'gcp_secret_set':
        return await gcpSecretSet(input.name, input.value);
      case 'gcp_secret_bind':
        return await gcpSecretBind(input.bindings);
      case 'gcp_secret_list':
        return await gcpSecretList();
      case 'gcp_build_status':
        return await gcpBuildStatus(parseInt(input.limit, 10) || 5);
      case 'gcp_logs_query':
        return await gcpLogsQuery(input.filter, parseInt(input.limit, 10) || 50);
      case 'gcp_run_describe':
        return await gcpRunDescribe();
      case 'gcp_storage_ls':
        return await gcpStorageLs(input.bucket, input.prefix);
      case 'gcp_artifact_list':
        return await gcpArtifactList(parseInt(input.limit, 10) || 20);
      case 'gcp_sql_describe':
        return await gcpSqlDescribe();
      case 'gcp_vm_ssh':
        return await gcpVmSsh(input.command);
      case 'gcp_redeploy_bot_vm': {
        if (context?.agentId === 'executive-assistant') {
          const testResult = runTests();
          if (testResult.includes('FAIL') || testResult.includes('Command failed')) {
            return `❌ Bot VM redeploy blocked — tests failed:\n${testResult.slice(0, 1000)}`;
          }
          const tcResult = runTypecheck('server');
          if (tcResult.includes('❌')) {
            return `❌ Bot VM redeploy blocked — typecheck failed:\n${tcResult.slice(0, 1000)}`;
          }
        }
        const redeployResult = await gcpRedeployBotVm(input.ref);
        if (context?.agentId === 'executive-assistant' && redeployResult.startsWith('✅')) {
          const auditCb = getToolAuditCallback();
          if (auditCb) auditCb(context.agentId, 'gcp_redeploy_bot_vm', `Cortana self-redeployed bot VM: ${input.ref || 'origin/main'}`);
          const notifyMsg = `🤖 **Cortana started a bot VM redeploy** using ${input.ref || 'origin/main'}. Tests + typecheck passed. @${getOwnerName().toLowerCase()}`;
          await discordSendMessage('groupchat', notifyMsg, undefined, context.agentId).catch(e => console.error('[bot-redeploy] groupchat notify failed:', errMsg(e)));
          await discordSendMessage('upgrades', `🤖 Cortana started bot VM redeploy: ${input.ref || 'origin/main'}`, undefined, context.agentId).catch(e => console.error('[bot-redeploy] upgrades notify failed:', errMsg(e)));
        }
        return redeployResult;
      }
      case 'gcp_project_info':
        return await gcpProjectInfo();
      case 'set_daily_budget': {
        const limitUsd = Number(input.limit_usd);
        if (!Number.isFinite(limitUsd) || limitUsd < 0) {
          return `❌ Invalid budget limit: ${input.limit_usd}. Must be a non-negative number.`;
        }
        const result = setDailyBudgetLimit(limitUsd, true);
        const reason = input.reason ? ` Reason: ${input.reason}` : '';
        return `✅ Daily budget updated: $${result.previous.toFixed(2)} → $${result.current.toFixed(2)}/day.${reason}\nSpent today: $${result.spent.toFixed(4)} | Remaining: $${result.remaining.toFixed(2)}\nChange is effective immediately and persisted to .env.`;
      }
      case 'set_daily_claude_token_limit': {
        const limitTokens = Number(input.limit_tokens);
        if (!Number.isFinite(limitTokens) || limitTokens <= 0) {
          return `❌ Invalid Claude token limit: ${input.limit_tokens}. Must be a positive number.`;
        }
        const result = setDailyClaudeTokenLimit(limitTokens, true);
        const reason = input.reason ? ` Reason: ${input.reason}` : '';
        return `✅ Daily Claude token limit updated: ${result.previous} → ${result.current}.${reason}\nUsed today: ${result.used} | Remaining: ${result.remaining}\nChange is effective immediately and persisted to .env.`;
      }
      case 'set_conversation_token_limit': {
        const limitTokens = Number(input.limit_tokens);
        const warnTokens = input.warn_tokens === undefined ? undefined : Number(input.warn_tokens);
        if (!Number.isFinite(limitTokens) || limitTokens <= 1) {
          return `❌ Invalid conversation token limit: ${input.limit_tokens}. Must be greater than 1.`;
        }
        if (warnTokens !== undefined && (!Number.isFinite(warnTokens) || warnTokens < 1 || warnTokens >= limitTokens)) {
          return `❌ Invalid conversation warning threshold: ${input.warn_tokens}. It must be at least 1 and less than the hard limit.`;
        }
        const result = setConversationTokenLimit(limitTokens, true, warnTokens);
        const reason = input.reason ? ` Reason: ${input.reason}` : '';
        return `✅ Conversation token limit updated: ${result.previous} → ${result.current} with warn threshold ${result.warn}.${reason}\nChange is effective immediately and persisted to .env.`;
      }
      case 'reset_conversation_token_window': {
        const targetKey = String(input.thread_key || context?.threadKey || '').trim();
        if (!targetKey) {
          return '❌ No conversation thread key is available to reset. Run this from an active Discord thread or provide thread_key explicitly.';
        }
        const before = getConversationTokenUsage(targetKey);
        clearConversationTokens(targetKey);
        const after = getConversationTokenUsage(targetKey);
        const reason = input.reason ? ` Reason: ${input.reason}` : '';
        return `✅ Conversation token window reset for ${targetKey}.${reason}\nBefore: used=${before.used} warn=${before.warn} limit=${before.limit}\nAfter: used=${after.used} warn=${after.warn} limit=${after.limit}`;
      }
      case 'fetch_url':
        return await fetchUrl(input.url, input.method, input.headers, input.body);
      case 'memory_read':
        return await memoryRead(input.file);
      case 'memory_write':
        return await memoryWrite(input.file, input.content);
      case 'memory_append':
        return await memoryAppend(input.file, input.content);
      case 'memory_list':
        return await memoryList();
      case 'repo_memory_index':
        return await repoMemoryIndex(input.mode, parseInt(input.max_files, 10) || 1200);
      case 'repo_memory_search':
        return await repoMemorySearch(input.query, parseInt(input.limit, 10) || 8, input.source);
      case 'repo_memory_add_oss':
        return await repoMemoryAddOss(input.title, input.content, input.tags);
      case 'db_query_readonly':
        return await dbQueryReadonly(input.query, input.params);
      case 'db_query':
        return await dbQuery(input.query, input.params);
      case 'db_schema':
        return await dbSchema(input.table);
      case 'job_scan':
        return await toolJobScan(input.keywords, input.source);
      case 'job_evaluate':
        return await toolJobEvaluate(parseInt(input.listing_id, 10));
      case 'job_tracker':
        return await toolJobTracker(input.action, input.status, input.listing_id ? parseInt(input.listing_id, 10) : undefined);
      case 'job_profile_update':
        return await toolJobProfileUpdate(input);
      case 'job_post_approvals':
        return await toolJobPostApprovals(parseFloat(input.min_score) || 3.0, parseInt(input.limit, 10) || 10);
      case 'job_draft_application':
        return await toolJobDraftApplication(parseInt(input.listing_id, 10));
      case 'job_submit_application':
        return await toolJobSubmitApplication(parseInt(input.listing_id, 10));
      case 'create_agent': {
        if (context?.agentId !== 'executive-assistant') {
          return 'Error: Only Cortana (executive-assistant) can create dynamic agents.';
        }
        try {
          const agent = createDynamicAgent({
            id: String(input.id),
            name: String(input.name),
            handle: String(input.handle),
            emoji: String(input.emoji),
            systemPrompt: String(input.system_prompt),
          });
          return `✅ Dynamic agent created: ${agent.name} (${agent.id}) ${agent.emoji}`;
        } catch (err) {
          return `Error: ${errMsg(err)}`;
        }
      }
      case 'remove_agent': {
        if (context?.agentId !== 'executive-assistant') {
          return 'Error: Only Cortana (executive-assistant) can remove dynamic agents.';
        }
        try {
          const removed = destroyDynamicAgent(String(input.agent_id));
          return removed
            ? `✅ Dynamic agent "${input.agent_id}" removed.`
            : `Agent "${input.agent_id}" not found among dynamic agents.`;
        } catch (err) {
          return `Error: ${errMsg(err)}`;
        }
      }
      case 'list_agents': {
        const allAgents = getAgents();
        const dynamic = listDynamicAgents();
        const dynamicIds = new Set(dynamic.map(a => a.id));
        const lines: string[] = [];
        for (const [, agent] of allAgents) {
          const tag = dynamicIds.has(agent.id) ? ' [dynamic]' : ' [static]';
          lines.push(`${agent.emoji} ${agent.name} (${agent.id})${tag}`);
        }
        return lines.join('\n') || 'No agents found.';
      }
      case 'error_patterns': {
        const { getRecentErrorPatterns } = await import('./services/agentErrors');
        return await getRecentErrorPatterns(input.agent_id, parseInt(input.hours, 10) || 24);
      }
      case 'recall_user_memory': {
        const query = String(input.query || '').trim();
        if (!query) return 'Error: query is required.';
        const userId = String(input.user_id || process.env.DISCORD_OWNER_USER_ID || '').trim();
        if (!userId) {
          return 'Error: no user_id available. Pass user_id explicitly or set DISCORD_OWNER_USER_ID.';
        }
        const rawLimit = parseInt(input.limit, 10);
        const limit = Math.max(1, Math.min(15, Number.isFinite(rawLimit) ? rawLimit : 5));
        const { embedQuery } = await import('./embeddings');
        const { searchUserEventsByEmbedding, getRecentUserEvents } = await import('./userEvents');
        const vec = await embedQuery(query);
        const rows = vec
          ? await searchUserEventsByEmbedding(userId, vec, limit)
          : (await getRecentUserEvents(userId, limit)).map((r) => ({ ...r, similarity: 0 }));
        if (!rows.length) return 'No matching events found.';
        const formatted = rows.map((r) => {
          const when = new Date(r.created_at as unknown as string).toISOString();
          const sim = typeof r.similarity === 'number' && r.similarity > 0
            ? ` sim=${r.similarity.toFixed(2)}`
            : '';
          const text = (r.text || '').replace(/\s+/g, ' ').slice(0, 300);
          return `[${when}] (${r.kind}${sim}) ${text}`;
        }).join('\n');
        return `Recalled ${rows.length} event(s):\n${formatted}`;
      }
      case 'recover_agent_memory': {
        if (context?.agentId !== 'executive-assistant') {
          return 'Error: Only Cortana can recover agent memory.';
        }
        const agentId = String(input.agent_id);
        try {
          const pool = (await import('../db/pool')).default;
          const res = await pool.query(
            `UPDATE agent_memory SET file_name = REPLACE(file_name, 'archived-', ''), updated_at = NOW()
             WHERE file_name IN ($1, $2)
             RETURNING file_name`,
            [`archived-conv-${agentId}`, `archived-summary-${agentId}`]
          );
          if (!res.rows || res.rows.length === 0) {
            return `No archived memory found for agent "${agentId}".`;
          }
          return `✅ Recovered ${res.rows.length} memory record(s) for "${agentId}": ${res.rows.map((r: any) => r.file_name).join(', ')}`;
        } catch (err) {
          return `Error recovering memory: ${errMsg(err)}`;
        }
      }
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    return `Error: ${errMsg(err)}`;
  }
}

function normalizeToolInput(input: ToolInput): string {
  const entries = Object.entries(input || {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function buildToolCacheKey(scope: string, toolName: string, input: ToolInput): string {
  const raw = `${scope}::${toolName}::${normalizeToolInput(input)}`;
  return createHash('sha1').update(raw).digest('hex');
}

function isCacheableTool(toolName: string): boolean {
  return new Set([
    'search_files',
    'list_directory',
    'check_file_exists',
    'list_channels',
    'list_threads',
    'github_search',
    'fetch_url',
    'memory_read',
    'memory_list',
    'repo_memory_search',
    'db_schema',
  ]).has(toolName);
}

function clearToolResultCache(scope?: string): void {
  if (!scope) {
    toolResultCache.clear();
    return;
  }
  // Keys are hashed; scope-targeted invalidation is not possible without reverse indexing.
  // Prefer correctness over stale responses.
  toolResultCache.clear();
}

function getCachedToolResult(key: string): string | null {
  const cached = toolResultCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    toolResultCache.delete(key);
    return null;
  }
  return cached.result;
}

function setCachedToolResult(key: string, result: string): void {
  toolResultCache.set(key, { result, expiresAt: Date.now() + TOOL_RESULT_CACHE_TTL_MS });
  while (toolResultCache.size > TOOL_RESULT_CACHE_MAX_ENTRIES) {
    const oldest = toolResultCache.keys().next().value;
    if (!oldest) break;
    toolResultCache.delete(oldest);
  }
}

function readFile(relativePath: string, offsetRaw?: number, maxBytesRaw?: number): string {
  const abs = safePath(relativePath);
  if (!fs.existsSync(abs)) {
    return `File not found: ${relativePath}`;
  }
  const stat = fs.statSync(abs);
  if (stat.size > MAX_WRITE_SIZE) {
    return `File too large (${Math.round(stat.size / 1024)} KB). Read specific sections or use search_files instead.`;
  }
  const content = fs.readFileSync(abs, 'utf-8');
  const offset = Number.isFinite(offsetRaw as number) && (offsetRaw as number) > 0
    ? Math.min(content.length, Math.floor(offsetRaw as number))
    : 0;
  const maxBytes = resolveAdaptiveReadMaxBytes(maxBytesRaw);

  if (offset >= content.length) {
    return `[Reached end of file. Size=${content.length} chars. offset=${offset}]`;
  }

  const end = Math.min(content.length, offset + maxBytes);
  const page = content.slice(offset, end);
  if (end >= content.length) {
    return page;
  }

  const remaining = content.length - end;
  return `${page}\n\n[Showing chars ${offset}-${end} of ${content.length}. ${remaining} chars remaining. Use offset=${end} to continue.]`;
}

function writeFile(relativePath: string, content: string): string {
  if (content.length > MAX_WRITE_SIZE) {
    return `Content too large (${Math.round(content.length / 1024)} KB). Maximum is ${MAX_WRITE_SIZE / 1024} KB.`;
  }
  const abs = safePath(relativePath);
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  scheduleRepoMemoryAutoUpsert(relativePath);
  return `Wrote ${content.length} bytes to ${relativePath}`;
}

function editFile(relativePath: string, oldString: string, newString: string): string {
  const abs = safePath(relativePath);
  if (!fs.existsSync(abs)) {
    return `File not found: ${relativePath}`;
  }
  const content = fs.readFileSync(abs, 'utf-8');

  // 1. Try exact match first
  const count = content.split(oldString).length - 1;
  if (count === 1) {
    const updated = content.replace(oldString, newString);
    fs.writeFileSync(abs, updated, 'utf-8');
    scheduleRepoMemoryAutoUpsert(relativePath);
    return `Edited ${relativePath} successfully.`;
  }
  if (count > 1) {
    return `old_string found ${count} times in ${relativePath}. It must appear exactly once. Add more surrounding context to be unambiguous.`;
  }

  // 2. Fallback: normalize line endings and trailing whitespace per line
  const normalizeWs = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n');
  const contentNorm = normalizeWs(content);
  const oldNorm = normalizeWs(oldString);
  const normCount = contentNorm.split(oldNorm).length - 1;
  if (normCount === 1) {
    // Find the original range by locating normalized match position
    const normIdx = contentNorm.indexOf(oldNorm);
    // Map normalized index back to original by counting chars line-by-line
    const contentLines = content.split('\n');
    const normLines = contentNorm.split('\n');
    let origStart = 0;
    let normPos = 0;
    let foundStart = -1;
    let foundEnd = -1;
    for (let i = 0; i < contentLines.length; i++) {
      const lineEnd = normPos + normLines[i].length;
      if (foundStart === -1 && normIdx >= normPos && normIdx <= lineEnd) {
        foundStart = origStart + (normIdx - normPos);
      }
      const endTarget = normIdx + oldNorm.length;
      if (foundEnd === -1 && endTarget >= normPos && endTarget <= lineEnd) {
        foundEnd = origStart + (endTarget - normPos);
      }
      normPos += normLines[i].length + 1; // +1 for \n
      origStart += contentLines[i].length + 1;
    }
    if (foundStart >= 0 && foundEnd > foundStart) {
      const originalOld = content.slice(foundStart, foundEnd);
      const updated = content.replace(originalOld, newString);
      fs.writeFileSync(abs, updated, 'utf-8');
      scheduleRepoMemoryAutoUpsert(relativePath);
      return `Edited ${relativePath} successfully (matched after normalizing trailing whitespace).`;
    }
  }

  // 3. Show helpful context: find the closest matching lines
  const oldLines = oldString.split('\n');
  const firstNonEmpty = oldLines.find(l => l.trim().length > 0)?.trim() || oldLines[0].trim();
  const fileLines = content.split('\n');
  const matchingLineNums: number[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].includes(firstNonEmpty)) {
      matchingLineNums.push(i + 1);
    }
  }

  let hint = `old_string not found in ${relativePath}.`;
  if (matchingLineNums.length > 0) {
    const lineNum = matchingLineNums[0];
    const start = Math.max(0, lineNum - 2);
    const end = Math.min(fileLines.length, lineNum + oldLines.length + 1);
    const snippet = fileLines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
    hint += ` The first line of old_string ("${firstNonEmpty.slice(0, 60)}") was found at line ${lineNum}. Actual content around that area:\n${snippet}\nUse read_file to see the exact content, then retry with the correct old_string.`;
  } else {
    hint += ` None of the lines in old_string were found. The file may have changed. Use read_file to see the current content.`;
  }
  return hint;
}

function batchEdit(edits: Array<{ path: string; old_string: string; new_string: string }>): string {
  if (!Array.isArray(edits) || edits.length === 0) {
    return 'No edits provided. Pass an array of {path, old_string, new_string} objects.';
  }
  const results: string[] = [];
  let succeeded = 0;
  for (let i = 0; i < edits.length; i++) {
    const { path: p, old_string, new_string } = edits[i];
    const result = editFile(p, old_string, new_string);
    if (result.includes('successfully')) {
      succeeded++;
    } else {
      results.push(`Edit ${i + 1} (${p}): ${result}`);
    }
  }
  if (results.length === 0) {
    return `All ${succeeded} edits applied successfully.`;
  }
  return `${succeeded}/${edits.length} edits succeeded.\nFailed:\n${results.join('\n')}`;
}

function searchFiles(pattern: string, include?: string): string {
  const includeGlobs = include
    ? [include]
    : ['*.ts', '*.tsx', '*.js', '*.json', '*.sql', '*.md'];
  const hotPaths = searchFilesHotIndexPaths(pattern, 25);

  try {
    let result = '';
    if (hotPaths.length > 0) {
      result = runRgSearch(pattern, includeGlobs, hotPaths);
    }
    if (!result.trim()) {
      result = runRgSearch(pattern, includeGlobs);
    }

    const lines = result.trim();
    if (!lines) return `No matches found for pattern: ${pattern}`;
    const seen = new Set<string>();
    const deduped = lines.split('\n').filter((line) => {
      const key = line.split(':').slice(0, 2).join(':');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 50);
    return deduped.join('\n');
  } catch (err: unknown) {
    const execErr = err as { status?: number };
    if (execErr.status === 1) return `No matches found for pattern: ${pattern}`;
    return `Search failed for pattern: ${pattern}`;
  }
}

function runRgSearch(pattern: string, includeGlobs: string[], targetPaths?: string[]): string {
  const rgArgs = [
    '-n',
    '-i',
    '-e',
    pattern,
    '--max-count',
    '50',
    '--glob',
    '!node_modules/**',
    '--glob',
    '!.git/**',
    '--glob',
    '!dist/**',
    ...includeGlobs.flatMap((g) => ['--glob', g]),
  ];

  if (targetPaths && targetPaths.length > 0) {
    rgArgs.push(...targetPaths);
  } else {
    rgArgs.push('.');
  }

  return execFileSync(
    'rg',
    rgArgs,
    { cwd: REPO_ROOT, timeout: 10_000, maxBuffer: 512 * 1024, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

function tokenizeHotSearch(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 40);
}

function rebuildHotSearchIndexIfNeeded(): void {
  const now = Date.now();
  if (hotSearchIndex.length > 0 && now - hotSearchIndexBuiltAt < HOT_SEARCH_INDEX_TTL_MS) return;

  ensureRepoMemoryCacheLoaded();
  const next: HotSearchChunk[] = [];
  for (const [key, content] of repoMemoryChunkCache.entries()) {
    if (!key.startsWith('repoidx:repo:')) continue;
    const pathPart = key.replace(/^repoidx:repo:/, '').replace(/:\d+$/, '');
    const compact = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 900);
    if (!compact) continue;
    const tokens = new Set(tokenizeHotSearch(`${pathPart} ${compact}`));
    if (tokens.size === 0) continue;
    next.push({
      path: pathPart,
      text: compact,
      textLower: compact.toLowerCase(),
      tokens,
    });
    if (next.length >= HOT_SEARCH_INDEX_MAX_CHUNKS) break;
  }

  hotSearchIndex = next;
  hotSearchIndexBuiltAt = now;
}

function searchFilesHotIndexPaths(pattern: string, limit: number): string[] {
  const query = String(pattern || '').trim();
  if (!query) return [];
  if (['[', ']', '{', '}', '(', ')', '*', '+', '?', '|', '\\'].some((ch) => query.includes(ch))) return [];

  rebuildHotSearchIndexIfNeeded();
  if (hotSearchIndex.length === 0) return [];

  const qLower = query.toLowerCase();
  const qTokens = tokenizeHotSearch(query);
  if (qTokens.length === 0) return [];

  const scored: Array<{ path: string; score: number }> = [];
  for (const chunk of hotSearchIndex) {
    let overlap = 0;
    for (const token of qTokens) {
      if (chunk.tokens.has(token)) overlap += 1;
    }
    if (overlap === 0 && !chunk.textLower.includes(qLower) && !chunk.path.toLowerCase().includes(qLower)) continue;
    const phraseBoost = chunk.textLower.includes(qLower) ? 3 : 0;
    const pathBoost = chunk.path.toLowerCase().includes(qLower) ? 2 : 0;
    scored.push({
      path: chunk.path,
      score: overlap + phraseBoost + pathBoost,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const byPath = new Set<string>();
  for (const row of scored) {
    byPath.add(row.path);
    if (byPath.size >= limit) break;
  }

  return [...byPath.values()].slice(0, limit);
}

function listDirectory(relativePath: string): string {
  const abs = safePath(relativePath);
  if (!fs.existsSync(abs)) {
    return `Directory not found: ${relativePath}`;
  }
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  return entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .join('\n');
}

function checkFileExists(relativePath: string): string {
  const target = String(relativePath || '').trim();
  if (!target) return 'Path is required.';
  const abs = safePath(target);
  if (!fs.existsSync(abs)) return `NOT_FOUND ${target}`;
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return `EXISTS dir ${target}`;
  if (stat.isFile()) return `EXISTS file ${target} (${stat.size} bytes)`;
  return `EXISTS other ${target}`;
}

// ── Self-repair tools (asap-bot's own code) ──────────────────────────────
//
// Cortana and the operations-manager use these to read + edit the bot's
// own source. REPO_ROOT points at the user-facing app (asap-app) for
// specialists; SELF_REPO_ROOT points at the bot's own checkout. The
// duplicate small wrappers stay narrow on purpose — same file ops, just
// resolved against the bot repo root.

function readSelfFile(relativePath: string, offsetRaw?: number, maxBytesRaw?: number): string {
  const abs = safePathSelf(relativePath);
  if (!fs.existsSync(abs)) return `File not found: ${relativePath}`;
  const stat = fs.statSync(abs);
  if (stat.size > MAX_WRITE_SIZE) {
    return `File too large (${Math.round(stat.size / 1024)} KB). Read specific sections or use search_self_files instead.`;
  }
  const content = fs.readFileSync(abs, 'utf-8');
  const offset = Number.isFinite(offsetRaw as number) && (offsetRaw as number) > 0
    ? Math.min(content.length, Math.floor(offsetRaw as number))
    : 0;
  const maxBytes = resolveAdaptiveReadMaxBytes(maxBytesRaw);
  if (offset >= content.length) return `[Reached end of file. Size=${content.length} chars. offset=${offset}]`;
  const end = Math.min(content.length, offset + maxBytes);
  const page = content.slice(offset, end);
  if (end >= content.length) return page;
  const remaining = content.length - end;
  return `${page}\n\n[Showing chars ${offset}-${end} of ${content.length}. ${remaining} chars remaining. Use offset=${end} to continue.]`;
}

function editSelfFile(relativePath: string, oldString: string, newString: string): string {
  const abs = safePathSelf(relativePath);
  if (!fs.existsSync(abs)) return `File not found: ${relativePath}`;
  const content = fs.readFileSync(abs, 'utf-8');
  const count = content.split(oldString).length - 1;
  if (count === 0) return `String not found in ${relativePath}: "${oldString.slice(0, 80)}${oldString.length > 80 ? '…' : ''}"`;
  if (count > 1) return `String appears ${count} times in ${relativePath}; provide more surrounding context to make it unique.`;
  const updated = content.replace(oldString, newString);
  fs.writeFileSync(abs, updated, 'utf-8');
  return `Edited ${relativePath} (1 replacement, ${updated.length} bytes total).`;
}

function searchSelfFiles(pattern: string, include?: string): string {
  if (!pattern) return 'Pattern is required.';
  const includeGlobs = include ? [include] : [];
  const rgArgs = [
    '-n', '-i', '-e', pattern, '--max-count', '50',
    '--glob', '!node_modules/**',
    '--glob', '!.git/**',
    '--glob', '!dist/**',
    ...includeGlobs.flatMap((g) => ['--glob', g]),
    '.',
  ];
  try {
    const out = execFileSync('rg', rgArgs, {
      cwd: SELF_REPO_ROOT, timeout: 10_000, maxBuffer: 512 * 1024, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const trimmed = String(out || '').trim();
    return trimmed ? trimmed.split('\n').slice(0, 200).join('\n') : `No matches in asap-bot for: ${pattern}`;
  } catch (err: any) {
    if (err?.status === 1) return `No matches in asap-bot for: ${pattern}`;
    return `search_self_files failed: ${err?.message || err}`;
  }
}

function listSelfDirectory(relativePath: string): string {
  const abs = safePathSelf(relativePath || '.');
  if (!fs.existsSync(abs)) return `Directory not found: ${relativePath}`;
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  return entries
    .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
    .sort()
    .join('\n') || '(empty)';
}

function checkSelfFileExists(relativePath: string): string {
  const target = String(relativePath || '').trim();
  if (!target) return 'Path is required.';
  const abs = safePathSelf(target);
  if (!fs.existsSync(abs)) return `NOT_FOUND ${target}`;
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return `EXISTS dir ${target}`;
  if (stat.isFile()) return `EXISTS file ${target} (${stat.size} bytes)`;
  return `EXISTS other ${target}`;
}

// ── Self-repair: shell-out tools (build / test / commit / PR / deploy) ──
//
// Closes the autonomous loop: Cortana edits her own code with
// edit_self_file, then verifies + ships without a human in the loop.
// Each tool runs in SELF_REPO_ROOT so it never touches the user-app
// checkout. Output is trimmed for prompt-friendliness.

const SELF_SHELL_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.SELF_SHELL_TIMEOUT_MS || '180000', 10));
const SELF_SHELL_MAX_BUFFER = 4 * 1024 * 1024;

function runInSelfRepo(cmd: string, args: readonly string[], timeoutMs = SELF_SHELL_TIMEOUT_MS): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, {
      cwd: SELF_REPO_ROOT,
      timeout: timeoutMs,
      maxBuffer: SELF_SHELL_MAX_BUFFER,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeCommandEnv(),
    });
    return { code: 0, out: String(out || '') };
  } catch (err: any) {
    const out = String((err?.stdout || '') + (err?.stderr || '') || err?.message || 'unknown error');
    return { code: typeof err?.status === 'number' ? err.status : 1, out };
  }
}

function trimOut(text: string, max = 3500): string {
  const s = String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
  return s.length <= max ? s : `${s.slice(0, Math.floor(max * 0.55))}\n…(${s.length - max} chars trimmed)…\n${s.slice(-Math.floor(max * 0.4))}`;
}

function runSelfTypecheck(): string {
  const r = runInSelfRepo('npx', ['tsc', '--noEmit', '--project', './tsconfig.json'], 240_000);
  if (r.code === 0) return '✅ self typecheck clean.';
  return `❌ self typecheck failed (exit ${r.code}):\n\n${trimOut(r.out)}`;
}

function runSelfTests(pattern?: string): string {
  const args = ['jest', '--colors=false'];
  if (pattern && pattern.trim()) args.push('--testPathPatterns', pattern.trim());
  const r = runInSelfRepo('npx', args, 360_000);
  // Jest prints summary at the end; we return tail of output.
  if (r.code === 0) return `✅ self tests passed.\n\n${trimOut(r.out, 2000)}`;
  return `❌ self tests failed (exit ${r.code}):\n\n${trimOut(r.out)}`;
}

function commitSelfChanges(branch: string, message: string): string {
  const cleanBranch = String(branch || '').trim().replace(/[^A-Za-z0-9_./-]/g, '-').slice(0, 80);
  if (!cleanBranch) return 'Error: branch is required (e.g. "cortana/voice-wav-fix").';
  if (!cleanBranch.startsWith('cortana/')) return 'Error: branch must start with "cortana/" (so PRs are visibly Cortana-authored).';
  const cleanMsg = String(message || '').trim();
  if (cleanMsg.length < 10) return 'Error: commit message must be at least 10 chars.';
  if (cleanMsg.length > 5000) return 'Error: commit message too long (>5000 chars).';

  // 1) Make sure we're up to date with origin/main
  const fetch = runInSelfRepo('git', ['fetch', 'origin', 'main'], 60_000);
  if (fetch.code !== 0) return `Error: git fetch origin main failed:\n${trimOut(fetch.out, 800)}`;

  // 2) Branch from origin/main (idempotent — overwrite if exists)
  const checkout = runInSelfRepo('git', ['checkout', '-B', cleanBranch, 'origin/main'], 30_000);
  if (checkout.code !== 0) return `Error: git checkout -B ${cleanBranch} failed:\n${trimOut(checkout.out, 800)}`;

  // 3) Stage everything in src/, .github/, scripts/ — restrict so we never
  // accidentally commit secrets or build artifacts.
  for (const path of ['src', '.github', 'scripts', 'package.json', 'package-lock.json']) {
    runInSelfRepo('git', ['add', '--', path], 30_000);
  }

  // 4) Verify there's actually something staged.
  const diff = runInSelfRepo('git', ['diff', '--cached', '--stat'], 15_000);
  if (!diff.out.trim()) return 'Error: nothing staged. Use edit_self_file first, then call commit_self_changes.';

  // 5) Commit with a Cortana co-author footer.
  const fullMsg = `${cleanMsg}\n\nCo-Authored-By: Cortana (self-repair) <noreply@anthropic.com>`;
  const commit = runInSelfRepo('git', ['commit', '-m', fullMsg], 30_000);
  if (commit.code !== 0) return `Error: git commit failed:\n${trimOut(commit.out, 800)}`;

  // 6) Push.
  const push = runInSelfRepo('git', ['push', '-u', 'origin', cleanBranch, '--force-with-lease'], 60_000);
  if (push.code !== 0) return `Error: git push failed:\n${trimOut(push.out, 800)}`;

  return `✅ Committed + pushed branch \`${cleanBranch}\`.\n\n${trimOut(diff.out, 800)}\n\n${trimOut(commit.out.split('\n').slice(0, 3).join('\n'), 200)}`;
}

async function openSelfPullRequest(branch: string, title: string, body?: string): Promise<string> {
  const cleanBranch = String(branch || '').trim();
  if (!cleanBranch) return 'Error: branch is required.';
  const cleanTitle = String(title || '').trim();
  if (cleanTitle.length < 10) return 'Error: title must be at least 10 chars.';
  const cleanBody = String(body || '').trim() || `Self-repair PR opened by Cortana.\n\nReview the diff, then merge — vm-deploy-bot.sh will pull origin/main on the next deploy.`;

  // The VM's `gh` CLI isn't installed, so call the GitHub REST API
  // directly. Token comes from GITHUB_TOKEN env (Secret Manager) or, as
  // a fallback, the embedded x-access-token in the git remote URL —
  // whichever the operator has wired up.
  let token = String(process.env.GITHUB_TOKEN || '').trim();
  if (!token) {
    const remote = runInSelfRepo('git', ['remote', 'get-url', 'origin'], 5_000);
    const m = remote.out.match(/x-access-token:([^@]+)@/);
    if (m) token = m[1].trim();
  }
  if (!token) return 'Error: GITHUB_TOKEN not configured and remote URL has no embedded token. Cannot open PR.';

  // Determine owner/repo from the remote URL.
  const remote = runInSelfRepo('git', ['remote', 'get-url', 'origin'], 5_000);
  const repoMatch = remote.out.match(/github\.com[/:]([^/]+)\/([^/.\n]+)(?:\.git)?/);
  if (!repoMatch) return `Error: could not parse owner/repo from origin URL:\n${trimOut(remote.out, 200)}`;
  const owner = repoMatch[1];
  const repo = repoMatch[2].replace(/\.git$/, '');

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'asap-bot-self-repair',
      },
      body: JSON.stringify({ title: cleanTitle, body: cleanBody, head: cleanBranch, base: 'main' }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return `Error: GitHub API ${res.status}:\n${trimOut(JSON.stringify(json), 800)}`;
    }
    const url = String((json as any)?.html_url || '');
    const number = (json as any)?.number;
    return `✅ Opened PR #${number} for \`${cleanBranch}\`: ${url}`;
  } catch (err) {
    return `Error: GitHub API request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function deploySelf(): string {
  // Pulls origin/main on the VM, npm ci, tsc, npm run migrate, pm2 restart.
  // Only main is deployed — Cortana's branches don't deploy until merged.
  const r = runInSelfRepo('bash', ['scripts/vm-deploy-bot.sh'], 600_000);
  if (r.code !== 0) return `❌ Deploy failed (exit ${r.code}):\n\n${trimOut(r.out)}`;
  return `🚀 Deploy completed.\n\n${trimOut(r.out, 1200)}`;
}

/**
 * Allowlist of command prefixes agents may run.
 * Everything else is blocked by default.
 */
const ALLOWED_COMMANDS: Array<{ prefix: string; description: string }> = [
  { prefix: 'npm ',         description: 'npm scripts and installs' },
  { prefix: 'npx tsc',      description: 'TypeScript type-checking' },
  { prefix: 'npx jest',     description: 'Run tests via jest' },
  { prefix: 'npx prettier', description: 'Code formatting' },
  { prefix: 'npx eslint',   description: 'Linting' },
  { prefix: 'git status',    description: 'Working tree status' },
  { prefix: 'git diff',      description: 'Show diffs' },
  { prefix: 'git log',       description: 'Commit history' },
  { prefix: 'git branch',    description: 'List/create branches' },
  { prefix: 'git checkout',  description: 'Switch branches' },
  { prefix: 'git switch',    description: 'Switch branches' },
  { prefix: 'git add',       description: 'Stage files' },
  { prefix: 'git commit',    description: 'Commit staged changes' },
  { prefix: 'git push',      description: 'Push commits' },
  { prefix: 'git pull',      description: 'Pull remote changes' },
  { prefix: 'git fetch',     description: 'Fetch remote refs' },
  { prefix: 'git stash',     description: 'Stash changes' },
  { prefix: 'git merge',      description: 'Merge branches' },
  { prefix: 'git show',       description: 'Show commit details' },
  { prefix: 'git rev-parse',  description: 'Resolve refs' },
  { prefix: 'git remote',     description: 'Manage remotes' },
  { prefix: 'git rebase',     description: 'Rebase branches' },
  { prefix: 'git cherry-pick', description: 'Cherry-pick commits' },
  { prefix: 'git tag',        description: 'Manage tags' },
  { prefix: 'git blame',      description: 'Line-by-line authorship' },
  { prefix: 'git reflog',     description: 'Reference log' },
  { prefix: 'grep ',   description: 'Search file contents' },
  { prefix: 'find ',   description: 'Find files' },
  { prefix: 'cat ',    description: 'Read files' },
  { prefix: 'head ',   description: 'Read file head' },
  { prefix: 'tail ',   description: 'Read file tail' },
  { prefix: 'ls ',     description: 'List directory' },
  { prefix: 'ls\n',    description: 'List directory' },
  { prefix: 'wc ',     description: 'Count lines/words' },
  { prefix: 'sort ',   description: 'Sort output' },
  { prefix: 'uniq ',   description: 'Deduplicate output' },
  { prefix: 'echo ',   description: 'Echo text' },
  { prefix: 'pwd',     description: 'Print working directory' },
  { prefix: 'which ',  description: 'Locate commands' },
  { prefix: 'jq ',            description: 'JSON processing' },
  { prefix: 'date',           description: 'Date/time' },
  { prefix: 'mkdir ',         description: 'Create directories' },
  { prefix: 'cp ',            description: 'Copy files' },
  { prefix: 'mv ',            description: 'Move/rename files' },
  { prefix: 'touch ',         description: 'Create empty files' },
  { prefix: 'chmod ',         description: 'File permissions' },
  { prefix: 'tar ',           description: 'Archive operations' },
  { prefix: 'zip ',           description: 'Compress files' },
  { prefix: 'unzip ',         description: 'Decompress files' },
  { prefix: 'diff ',          description: 'Compare files' },
  { prefix: 'basename ',      description: 'Strip directory' },
  { prefix: 'dirname ',       description: 'Strip filename' },
  { prefix: 'realpath ',      description: 'Resolve path' },
  { prefix: 'tee ',           description: 'Pipe and write' },
  { prefix: 'tree ',          description: 'Directory tree' },
  { prefix: 'du ',            description: 'Disk usage' },
  { prefix: 'df ',            description: 'Filesystem info' },
  { prefix: 'gcloud secrets', description: 'Manage GCP secrets' },
  { prefix: 'gcloud run',     description: 'Cloud Run operations' },
  { prefix: 'gcloud builds',  description: 'Cloud Build operations' },
  { prefix: 'gcloud services', description: 'GCP service management' },
  { prefix: 'gcloud projects', description: 'GCP project info' },
  { prefix: 'gcloud auth',    description: 'GCP authentication' },
  { prefix: 'gcloud sql',     description: 'Cloud SQL operations' },
  { prefix: 'gcloud logging', description: 'GCP log operations' },
  { prefix: 'gcloud iam',     description: 'IAM management' },
  { prefix: 'gcloud artifacts', description: 'Artifact Registry' },
  { prefix: 'gcloud config',  description: 'GCP config' },
  { prefix: 'gcloud compute', description: 'Compute Engine' },
];

/** Patterns that are NEVER allowed — catastrophic or escape-to-shell operations. */
const HARD_BLOCKED = [
  /rm\s+(-rf?|--recursive)\s+\//,    // rm -rf / (root filesystem)
  /git\s+reset\s+--hard\b/,          // destructive reset
  /git\s+clean\s+-[^\n]*f[^\n]*/,   // force clean (-f / -fd / -ffdx)
  /git\s+checkout\s+--(?:\s|$)/,           // discard file changes
  /mkfs/,                             // format disk
  /dd\s+if=/,                         // raw disk operations
  /:\(\)\s*\{/,                       // fork bomb
  />\s*\/dev\/sd/,                    // write to block devices
  /\bsudo\b/,                         // privilege escalation
  /\|\s*(sh|bash|zsh)\b/,            // pipe-to-shell
  /\b(sh|bash|zsh)\s+-[ce]\b/,       // direct shell invocation
  /\beval\s/,                         // shell eval
  /\bnohup\b/,                        // background escape
  /\bchmod\s+[+0-9]*[sx]/,           // setuid / execute bits
  /\bcrontab\b/,                      // scheduled tasks
];

const DEFAULT_READ_PAGE_MAX_BYTES = parseInt(process.env.DEFAULT_READ_PAGE_MAX_BYTES || '50000', 10);
const MAX_ADAPTIVE_READ_MAX_BYTES = parseInt(process.env.MAX_ADAPTIVE_READ_MAX_BYTES || '512000', 10);
const ADAPTIVE_READ_CONTEXT_SHARE = parseFloat(process.env.ADAPTIVE_READ_CONTEXT_SHARE || '0.20');
const READ_CONTEXT_TOKENS = parseInt(process.env.READ_CONTEXT_TOKENS || '200000', 10);
const CHARS_PER_TOKEN_ESTIMATE = parseFloat(process.env.READ_CHARS_PER_TOKEN_ESTIMATE || '4');

function resolveAdaptiveReadMaxBytes(requested?: number): number {
  const contextBased = Math.floor(
    Math.max(1, READ_CONTEXT_TOKENS) *
    Math.max(1, CHARS_PER_TOKEN_ESTIMATE) *
    Math.max(0.01, ADAPTIVE_READ_CONTEXT_SHARE)
  );
  const baseline = Math.max(4096, Math.min(MAX_ADAPTIVE_READ_MAX_BYTES, contextBased, DEFAULT_READ_PAGE_MAX_BYTES));
  if (!Number.isFinite(requested as number) || (requested as number) <= 0) {
    return baseline;
  }
  return Math.max(1024, Math.min(MAX_ADAPTIVE_READ_MAX_BYTES, Math.floor(requested as number)));
}

/** Command audit log callback — set externally to post to Discord */
let auditCallback: ((command: string, allowed: boolean, reason: string) => void) | null = null;

export function setCommandAuditCallback(
  cb: (command: string, allowed: boolean, reason: string) => void
): void {
  auditCallback = cb;
}

/** Tool audit log callback — posts every tool invocation to #terminal */
let toolAuditCallback: ((agentName: string, toolName: string, summary: string) => void) | null = null;

export function setToolAuditCallback(
  cb: (agentName: string, toolName: string, summary: string) => void
): void {
  toolAuditCallback = cb;
}

export function getToolAuditCallback() { return toolAuditCallback; }

function runCommand(command: string, cwd?: string): string {
  const trimmed = command.trim();

  for (const pattern of HARD_BLOCKED) {
    if (pattern.test(trimmed)) {
      const reason = 'Hard-blocked pattern detected';
      auditCallback?.(trimmed, false, reason);
      return `Blocked: ${reason}. This command is not allowed.`;
    }
  }

  const allowed = ALLOWED_COMMANDS.find((rule) =>
    trimmed.startsWith(rule.prefix) || trimmed === rule.prefix.trim()
  );

  if (!allowed) {
    const reason = 'Command not in allowlist';
    auditCallback?.(trimmed, false, reason);
    return `Blocked: ${reason}. Allowed commands: npm, npx tsc/jest, git, grep, find, cat, ls, head, tail, wc, and other read-only utilities.`;
  }

  auditCallback?.(trimmed, true, allowed.description);

  const workDir = cwd ? safePath(cwd) : REPO_ROOT;

  try {
    const result = execSync(trimmed, {
      cwd: workDir,
      timeout: CMD_TIMEOUT,
      maxBuffer: 512 * 1024,
      encoding: 'utf-8',
      env: buildSafeCommandEnv(),
      shell: '/bin/sh',
    });
    const output = result.trim();
    if (output.length > 4000) {
      return output.slice(0, 4000) + '\n... (output truncated)';
    }
    return output || '(command completed with no output)';
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const stderr = execErr.stderr?.trim() || '';
    const stdout = execErr.stdout?.trim() || '';
    return `Command failed:\n${stderr || stdout || execErr.message || 'Unknown error'}`.slice(0, 4000);
  }
}


async function gitCreateBranch(branchName: string, baseBranch?: string): Promise<string> {
  try {
    return await createBranch(branchName, baseBranch || 'main');
  } catch (err) {
    return `Error creating branch: ${errMsg(err)}`;
  }
}

async function ghCreatePR(title: string, body: string, head: string, base?: string): Promise<string> {
  try {
    const pr = await createPullRequest(title, body, head, base || 'main');

    try {
      const diffOutput = execSync(`git diff --name-only ${base || 'main'}...${head}`, {
        cwd: REPO_ROOT, timeout: 10_000, encoding: 'utf-8',
      }).trim();
      const changedFiles = diffOutput.split('\n').filter(Boolean);

      const reviewers = getRequiredReviewers(changedFiles);
      if (reviewers.size > 0 && prReviewCallback) {
        const diffSummary = execSync(`git diff --stat ${base || 'main'}...${head}`, {
          cwd: REPO_ROOT, timeout: 10_000, encoding: 'utf-8',
        }).trim();
        prReviewCallback(pr.number, title, changedFiles, diffSummary).catch(() => {});
      }
    } catch {
    }

    return `✅ PR #${pr.number} created: ${pr.url}`;
  } catch (err) {
    return `Error creating PR: ${errMsg(err)}`;
  }
}

async function ghMergePR(prNumber: number, commitTitle?: string, agentId?: string): Promise<string> {
  const testResult = runTests();
  if (testResult.includes('FAIL') || testResult.includes('Command failed')) {
    return `❌ Cannot merge PR #${prNumber} — tests failed:\n${testResult.slice(0, 1000)}`;
  }

  // Cortana gets an extra typecheck gate on merge
  if (agentId === 'executive-assistant') {
    const tcResult = runTypecheck('server');
    if (tcResult.includes('❌')) {
      return `❌ Cannot merge PR #${prNumber} — typecheck failed:\n${tcResult.slice(0, 1000)}`;
    }
  }

  try {
    const result = await mergePullRequest(prNumber, commitTitle);
    const auditCb = getToolAuditCallback();
    if (auditCb && agentId) {
      auditCb(agentId, 'merge_pull_request', `Merged PR #${prNumber} — tests+typecheck passed`);
    }

    // Trigger smoke tests after successful merge
    if (smokeTestCallback) {
      try {
        const diffOut = execSync('git diff --name-only HEAD~1', {
          cwd: REPO_ROOT, timeout: 10_000, encoding: 'utf-8',
        }).trim();
        const changedFiles = diffOut.split('\n').filter(Boolean);
        if (changedFiles.length > 0) {
          smokeTestCallback(prNumber, changedFiles).catch((err) => {
            console.warn(`[smoke-test] callback error after PR #${prNumber} merge:`, errMsg(err));
          });
        }
      } catch {
        // Non-blocking — don't fail the merge response
      }
    }

    return `✅ ${result}`;
  } catch (err) {
    return `Error merging PR: ${errMsg(err)}`;
  }
}

async function ghAddComment(prNumber: number, body: string): Promise<string> {
  try {
    await addPRComment(prNumber, body);
    return `Comment added to PR #${prNumber}`;
  } catch (err) {
    return `Error adding comment: ${errMsg(err)}`;
  }
}

async function ghListPRs(): Promise<string> {
  try {
    const prs = await listPullRequests();
    if (prs.length === 0) return 'No open pull requests.';
    return prs.map((pr) => `#${pr.number} [${pr.head}] ${pr.title}`).join('\n');
  } catch (err) {
    return `Error listing PRs: ${errMsg(err)}`;
  }
}


function runTests(pattern?: string): string {
  const safePattern = pattern ? pattern.replace(/[^a-zA-Z0-9_./\-*?]/g, '') : undefined;
  const testCmd = safePattern
    ? `npm test -- --testPathPattern="${safePattern}"`
    : 'npm test';

  try {
    const result = execSync(testCmd, {
      cwd: SERVER_ROOT,
      timeout: 120_000, // 2 minutes for test suite
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      env: { ...process.env, NODE_ENV: 'test', CI: 'true' },
      shell: '/bin/sh',
    });
    const output = result.trim();
    return output.length > 4000
      ? '... (output trimmed)\n' + output.slice(-4000)
      : output || 'All tests passed (no output)';
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = (execErr.stdout || '') + '\n' + (execErr.stderr || '');
    return `Test run completed with failures:\n${output.trim().slice(-4000)}`;
  }
}

function gitFileHistory(relativePath: string, limit = 10, lineRange?: string): string {
  const target = String(relativePath || '').trim();
  if (!target) return 'Provide a file or folder path, e.g. "app/_layout.tsx".';

  safePath(target);
  const safeLimit = Math.max(1, Math.min(limit, 30));

  try {
    const history = execFileSync('git', ['log', '--follow', '--oneline', '--decorate', '-n', String(safeLimit), '--', target], {
      cwd: REPO_ROOT,
      timeout: 20_000,
      maxBuffer: 512 * 1024,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const sections = [`Recent commits for ${target}:\n${history || '(no matching commits found)'}`];
    const match = String(lineRange || '').match(/^(\d+)\s*-\s*(\d+)$/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
        const blame = execFileSync('git', ['blame', '-L', `${start},${end}`, '--', target], {
          cwd: REPO_ROOT,
          timeout: 20_000,
          maxBuffer: 512 * 1024,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        sections.push(`Blame for ${target}:${start}-${end}\n${blame || '(no blame output)'}`);
      }
    }

    return sections.join('\n\n').slice(0, 4000);
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    return `Git history lookup failed for ${target}: ${(execErr.stderr || execErr.stdout || execErr.message || 'Unknown error').trim().slice(0, 2000)}`;
  }
}

interface SmokeTestOptions {
  agent?: string;
  tests?: string;
  profile?: string;
  rerunFailed?: boolean;
  timeoutMs?: number;
}

export async function smokeTestAgents(opts: SmokeTestOptions = {}): Promise<string> {
  if (!process.env.DISCORD_TEST_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) {
    return 'Smoke-test bot is not configured here. Set DISCORD_TEST_BOT_TOKEN and DISCORD_GUILD_ID to enable end-to-end Discord smoke tests.';
  }

  const perTestTimeout = Math.max(15_000, Math.min(opts.timeoutMs || 90_000, 180_000));
  // Allow up to 15 minutes for the full suite to complete (18 tests with retries)
  const execTimeout = Math.max(perTestTimeout * 10, 900_000);
  const args: string[] = [];

  // Agent filter
  const safeAgent = String(opts.agent || '').replace(/[^a-z0-9-]/gi, '').trim();
  if (safeAgent) args.push(`--agent=${safeAgent}`);

  // Capability filter
  const safeTests = String(opts.tests || '').replace(/[^a-z0-9-,]/gi, '').trim();
  if (safeTests) args.push(`--tests=${safeTests}`);

  // Rerun failed
  if (opts.rerunFailed) args.push('--rerun-failed');

  const cmd = args.length
    ? `npm run discord:test:dist -- ${args.join(' ')}`
    : 'npm run discord:test:dist';

  // Profile → set DISCORD_SMOKE_PROFILE env override
  const profileEnv = opts.profile === 'readiness' ? 'readiness' : '';

  const execAsync = promisify(exec);
  setActiveSmokeTestRunning(true);
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: SERVER_ROOT,
      timeout: execTimeout,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        DISCORD_TEST_TIMEOUT_MS: String(perTestTimeout),
        CI: 'true',
        ...(profileEnv ? { DISCORD_SMOKE_PROFILE: profileEnv } : {}),
      },
      shell: '/bin/sh',
    });

    const output = (stdout || '').trim();
    // Write full subprocess output to a log file for diagnostics
    try {
      const fs = await import('fs');
      const logPath = `${SERVER_ROOT}/smoke-reports/tester-output-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
      fs.writeFileSync(logPath, `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n`);
    } catch { /* ignore log write errors */ }
    return output.length > 4000
      ? '... (output trimmed)\n' + output.slice(-4000)
      : output || 'Smoke test completed with no output.';
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = `${execErr.stdout || ''}\n${execErr.stderr || ''}`.trim();
    // Write full subprocess output to a log file for diagnostics
    try {
      const fs = await import('fs');
      const logPath = `${SERVER_ROOT}/smoke-reports/tester-output-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
      fs.writeFileSync(logPath, `STDOUT:\n${execErr.stdout || ''}\n\nSTDERR:\n${execErr.stderr || ''}\n`);
    } catch { /* ignore log write errors */ }
    return `Smoke test finished with failures:\n${(output || execErr.message || 'Unknown error').slice(-4000)}`;
  } finally {
    setActiveSmokeTestRunning(false);
  }
}


function requireGuild(): Guild {
  return requireGuildShared();
}

function findGroupchatChannel(guild: Guild): TextChannel | null {
  const channel = guild.channels.cache.find(
    (candidate) => candidate.type === ChannelType.GuildText && candidate.name.includes('groupchat')
  );
  return channel ? channel as TextChannel : null;
}

function findTextChannelByFlexibleName(guild: Guild, channelName: string): TextChannel | undefined {
  const raw = String(channelName || '').trim();
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  const key = toChannelProtectionKey(normalized);

  const exact = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name.toLowerCase() === normalized
  ) as TextChannel | undefined;
  if (exact) return exact;

  const byKey = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && toChannelProtectionKey(c.name) === key
  ) as TextChannel | undefined;
  if (byKey) return byKey;

  return undefined;
}

async function discordListChannels(): Promise<string> {
  const guild = requireGuild();
  await guild.channels.fetch();

  const categories = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => ((a as CategoryChannel).position ?? 0) - ((b as CategoryChannel).position ?? 0));

  const uncategorized = guild.channels.cache.filter(
    (c) => !c.parentId && c.type !== ChannelType.GuildCategory
  );

  const lines: string[] = [];

  for (const cat of categories.values()) {
    lines.push(`📁 ${cat.name.toUpperCase()}`);
    const children = guild.channels.cache
      .filter((c) => c.parentId === cat.id)
      .sort((a, b) => ((a as TextChannel).position ?? 0) - ((b as TextChannel).position ?? 0));
    for (const ch of children.values()) {
      const type = ch.type === ChannelType.GuildVoice ? '🔊' : '#';
      const topic = (ch as TextChannel).topic ? ` — ${(ch as TextChannel).topic}` : '';
      lines.push(`  ${type} ${ch.name}${topic}`);
    }
  }

  if (uncategorized.size > 0) {
    lines.push('📁 (uncategorized)');
    for (const ch of uncategorized.values()) {
      const type = ch.type === ChannelType.GuildVoice ? '🔊' : '#';
      lines.push(`  ${type} ${ch.name}`);
    }
  }

  return lines.join('\n') || 'No channels found.';
}

async function discordListThreads(includeArchived = false, limit = 10): Promise<string> {
  const guild = requireGuild();
  await guild.channels.fetch();
  const groupchat = findGroupchatChannel(guild);
  if (!groupchat) return 'Could not find the groupchat channel.';

  const safeLimit = Math.max(1, Math.min(limit, 25));
  const active = await groupchat.threads.fetchActive();
  const activeThreads = [...active.threads.values()]
    .sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0))
    .slice(0, safeLimit);

  const now = Date.now();
  const describe = async (thread: any, archived: boolean): Promise<string> => {
    const recent = await thread.messages.fetch({ limit: 1 }).catch(() => null);
    const last = recent?.first();
    const lastTs = last?.createdTimestamp || thread.createdTimestamp || now;
    const idle = formatAge(now - lastTs);
    const state = archived ? 'archived' : (now - lastTs > 120_000 ? 'ready for review' : 'active');
    return `- ${thread.name} (${state}, idle ${idle})`;
  };

  const lines: string[] = [`#${groupchat.name} threads`];

  if (activeThreads.length === 0) {
    lines.push('No active threads.');
  } else {
    lines.push('Active:');
    lines.push(...(await Promise.all(activeThreads.map((thread) => describe(thread, false)))));
  }

  if (includeArchived) {
    const archived = await groupchat.threads.fetchArchived({ limit: safeLimit }).catch(() => null);
    const archivedThreads = [...(archived?.threads.values() || [])].slice(0, safeLimit);
    if (archivedThreads.length > 0) {
      lines.push('', 'Recently archived:');
      lines.push(...(await Promise.all(archivedThreads.map((thread) => describe(thread, true)))));
    }
  }

  return lines.join('\n').slice(0, 4000);
}

async function resolveDiscordTextChannel(channelName?: string, agentId?: string): Promise<TextChannel | undefined> {
  const guild = requireGuild();
  await guild.channels.fetch();

  if (channelName) {
    const byName = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name.toLowerCase() === channelName.toLowerCase()
    ) as TextChannel | undefined;
    if (byName) return byName;
  }

  if (agentId) {
    const resolved = resolveAgentChannel(agentId);
    if (resolved) return resolved;
  }

  return undefined;
}

async function discordDeleteChannel(channelName: string, reason: string): Promise<string> {
  const guild = requireGuild();

  const key = toChannelProtectionKey(channelName);
  if (PROTECTED_CHANNEL_KEYS.includes(key)) {
    return `Cannot delete protected channel: #${channelName}`;
  }

  const channel = findTextChannelByFlexibleName(guild, channelName);
  if (!channel) return `Channel not found: #${channelName}`;

  await channel.delete(reason);
  return `Deleted channel #${channelName} — ${reason}`;
}

async function discordCreateChannel(
  channelName: string,
  categoryName?: string,
  topic?: string
): Promise<string> {
  const guild = requireGuild();

  let parent: CategoryChannel | undefined;
  if (categoryName) {
    parent = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
    ) as CategoryChannel | undefined;
    if (!parent) return `Category not found: ${categoryName}`;
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent,
    topic,
  });
  return `Created channel #${channel.name}${parent ? ` under ${parent.name}` : ''}`;
}

async function discordRenameChannel(oldName: string, newName: string): Promise<string> {
  const guild = requireGuild();

  const channel = guild.channels.cache.find(
    (c) => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice) && c.name === oldName
  );
  if (!channel) return `Channel not found: #${oldName}`;

  await channel.setName(newName);
  return `Renamed #${oldName} → #${newName}`;
}

async function discordSetTopic(channelName: string, topic: string): Promise<string> {
  const guild = requireGuild();

  const channel = findTextChannelByFlexibleName(guild, channelName);
  if (!channel) return `Channel not found: #${channelName}`;

  await channel.setTopic(topic);
  return `Updated topic for #${channelName}`;
}

async function discordSendMessage(channelName: string, message: string, agentName?: string, agentId?: string): Promise<string> {
  const guild = requireGuild();

  const channel = findTextChannelByFlexibleName(guild, channelName);
  if (!channel) return `Channel not found: #${channelName}`;

  const normalizedAgentId = String(agentId || '').trim().toLowerCase();
  if (
    normalizedAgentId
    && STRICT_AGENT_TOOL_ACCESS
    && REVIEW_TOOL_ACCESS_AGENT_IDS.has(normalizedAgentId)
  ) {
    const channelKey = toChannelProtectionKey(channel.name);
    const ownAgentChannel = resolveAgentChannel(normalizedAgentId);
    const isOwnChannel = !!ownAgentChannel && ownAgentChannel.id === channel.id;
    const canPost = channelKey === 'upgrades' || isOwnChannel;
    if (!canPost) {
      return `Error: Review agent "${normalizedAgentId}" can only send messages to #upgrades or its own channel.`;
    }
  }

  const agent = agentId ? getAgent(agentId as AgentId) : null;
  const resolvedUsername = agentName || (agent ? `${agent.emoji} ${agent.name}` : 'ASAP Agent');
  const resolvedAvatarUrl = agent?.avatarUrl;

  const chunks = message.match(/.{1,2000}/gs) || [message];
  try {
    const wh = await getWebhook(channel);
    for (const chunk of chunks) {
      await wh.send({
        content: chunk,
        username: resolvedUsername,
        avatarURL: resolvedAvatarUrl,
      });
    }
  } catch {
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }
  return `Sent message to #${channelName} (${message.length} chars)`;
}

async function discordReadChannelMessages(channelName: string, limit = 20, search?: string): Promise<string> {
  const guild = requireGuild();
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const key = channelName.replace(/^#/, '').replace(/[^\w-]/g, '').toLowerCase();
  const channel = guild.channels.cache.find((c) => {
    const name = c.name.replace(/[^\w-]/g, '').toLowerCase();
    return name === key || name.endsWith(key);
  });
  if (!channel || !channel.isTextBased()) return `Channel #${channelName} not found or not text-based.`;
  const textChannel = channel as import('discord.js').TextChannel;
  const messages = await textChannel.messages.fetch({ limit: safeLimit });
  let sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  if (search) {
    const lowerSearch = search.toLowerCase();
    sorted = sorted.filter((m) => m.content.toLowerCase().includes(lowerSearch));
  }
  if (sorted.length === 0) return `No messages found in #${channel.name}${search ? ` matching "${search}"` : ''}.`;
  const lines = sorted.map((m) => {
    const ts = m.createdAt.toISOString().slice(0, 19).replace('T', ' ');
    const author = m.author.bot ? `[BOT] ${m.author.username}` : m.author.username;
    const content = m.content.slice(0, 500) || (m.embeds.length ? `[embed: ${m.embeds[0].title || 'untitled'}]` : '[no content]');
    return `[${ts}] ${author}: ${content}`;
  });
  const header = `#${channel.name} — ${sorted.length} message(s)${search ? ` matching "${search}"` : ''}`;
  const body = lines.join('\n');
  return body.length > 3800 ? `${header}\n...(trimmed)\n${body.slice(-3700)}` : `${header}\n${body}`;
}

async function discordClearChannelMessages(channelName: string, limit = 500): Promise<string> {
  const guild = requireGuild();
  const maxDelete = Math.min(Math.max(limit, 1), 2000);
  const key = toChannelProtectionKey(channelName);
  if (PROTECTED_CHANNEL_KEYS.includes(key)) {
    return `Cannot clear protected channel: #${channelName}`;
  }

  const channel = findTextChannelByFlexibleName(guild, channelName);
  if (!channel) return `Channel not found: #${channelName}`;

  let deleted = 0;
  let remaining = maxDelete;

  while (remaining > 0) {
    const batchSize = Math.min(100, remaining);
    const fetched = await channel.messages.fetch({ limit: batchSize });
    if (fetched.size === 0) break;

    try {
      await channel.bulkDelete(fetched, true);
      deleted += fetched.size;
    } catch {
      for (const msg of fetched.values()) {
        try {
          await msg.delete();
          deleted += 1;
        } catch {
        }
      }
    }

    remaining -= fetched.size;
    if (fetched.size < batchSize) break;
  }

  return `Cleared ${deleted} message(s) from #${channelName}`;
}

async function discordDeleteCategory(categoryName: string): Promise<string> {
  const guild = requireGuild();

  const cat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
  );
  if (!cat) return `Category not found: ${categoryName}`;

  const children = guild.channels.cache.filter((c) => c.parentId === cat.id);
  if (children.size > 0) {
    return `Cannot delete category "${categoryName}" — it still has ${children.size} channel(s). Move or delete them first.`;
  }

  await cat.delete('Removed by agent');
  return `Deleted category: ${categoryName}`;
}

async function discordMoveChannel(channelName: string, categoryName: string): Promise<string> {
  const guild = requireGuild();

  const channel = guild.channels.cache.find(
    (c) => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice) && c.name === channelName
  ) as TextChannel | undefined;
  if (!channel) return `Channel not found: #${channelName}`;

  const category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
  ) as CategoryChannel | undefined;
  if (!category) return `Category not found: ${categoryName}`;

  await channel.setParent(category, { lockPermissions: false });
  return `Moved #${channelName} to ${categoryName}`;
}


async function readRuntimeLogs(severity?: string, limit = 30, query?: string): Promise<string> {
  const { GoogleAuth } = await import('google-auth-library');
  const projectId = process.env.GCS_PROJECT_ID || 'asap-489910';
  const serviceName = process.env.CLOUD_RUN_SERVICE || 'asap';
  const region = process.env.CLOUD_RUN_REGION || 'australia-southeast1';

  let client: any;
  try {
    const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/logging.read' });
    client = await auth.getClient();
  } catch (err) {
    const msg = errMsg(err);
    if (msg.toLowerCase().includes('could not load the default credentials')) {
      return 'Cloud Logging access is unavailable on this host because Google ADC is not configured. Run `gcloud auth application-default login`, set GOOGLE_APPLICATION_CREDENTIALS, or use gcp_logs_query if gcloud CLI auth is already active.';
    }
    return `Cloud Logging auth failed: ${msg}`;
  }

  const safeSeverity = ['DEFAULT', 'INFO', 'WARNING', 'ERROR'].includes((severity || '').toUpperCase())
    ? (severity || 'WARNING').toUpperCase()
    : 'WARNING';
  const safeLimit = Math.min(Math.max(limit, 1), 100);

  let filter = `resource.type="cloud_run_revision" AND resource.labels.service_name="${serviceName}" AND resource.labels.location="${region}" AND severity>="${safeSeverity}"`;
  if (query) {
    const safeQuery = query.replace(/["\\\n]/g, '');
    filter += ` AND textPayload=~"${safeQuery}"`;
  }

  const res = await client.request({
    url: `https://logging.googleapis.com/v2/entries:list`,
    method: 'POST',
    data: {
      resourceNames: [`projects/${projectId}`],
      filter,
      orderBy: 'timestamp desc',
      pageSize: safeLimit,
    },
    headers: { 'Content-Type': 'application/json' },
  });

  const entries = (res.data as any).entries || [];
  if (entries.length === 0) return `No log entries found (severity >= ${safeSeverity}).`;

  const lines = entries.map((e: any) => {
    const ts = e.timestamp ? new Date(e.timestamp).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }) : '?';
    const sev = (e.severity || 'DEFAULT').padEnd(7);
    const text = e.textPayload || e.jsonPayload?.message || JSON.stringify(e.jsonPayload || {}).slice(0, 200);
    return `[${ts}] ${sev} ${text}`;
  });

  return lines.join('\n');
}


async function ghSearch(query: string, type: 'code' | 'issues' | 'commits'): Promise<string> {
  try {
    return await searchGitHub(query, type);
  } catch (err) {
    return `GitHub search error: ${errMsg(err)}`;
  }
}


function runTypecheck(target: 'client' | 'server' | 'both'): string {
  const results: string[] = [];

  if (target === 'client' || target === 'both') {
    try {
      execSync('node_modules/.bin/tsc --noEmit', {
        cwd: REPO_ROOT,
        timeout: 60_000,
        maxBuffer: 512 * 1024,
        encoding: 'utf-8',
      });
      results.push('✅ Client: No type errors');
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string };
      const output = (execErr.stdout || execErr.stderr || '').trim();
      results.push(`❌ Client type errors:\n${output.slice(0, 3000)}`);
    }
  }

  if (target === 'server' || target === 'both') {
    try {
      execSync('node_modules/.bin/tsc --noEmit', {
        cwd: SERVER_ROOT,
        timeout: 60_000,
        maxBuffer: 512 * 1024,
        encoding: 'utf-8',
      });
      results.push('✅ Server: No type errors');
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string };
      const output = (execErr.stdout || execErr.stderr || '').trim();
      results.push(`❌ Server type errors:\n${output.slice(0, 3000)}`);
    }
  }

  return results.join('\n\n');
}


// GCP operations → ./toolsGcp.ts

function fetchUrl(url: string, method?: string, headersStr?: string, body?: string): Promise<string> {
  const MAX_REDIRECTS = 5;
  const dnsLookup = promisify(dns.lookup);

  /** Block SSRF — reject private, loopback, link-local, metadata, and IPv6 private IPs */
  function isBlockedIP(ip: string): boolean {
    // IPv4 checks
    const ipv4Match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      if (a === 10) return true;                          // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
      if (a === 192 && b === 168) return true;             // 192.168.0.0/16
      if (a === 127) return true;                          // 127.0.0.0/8
      if (a === 0) return true;                            // 0.0.0.0/8
      if (a === 169 && b === 254) return true;             // link-local
      return false;
    }
    // IPv6 checks
    if (net.isIPv6(ip)) {
      const normalized = ip.toLowerCase();
      if (normalized === '::1') return true;                              // loopback
      if (normalized.startsWith('fe80')) return true;                     // link-local
      if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
      if (normalized === '::') return true;                               // unspecified
      // IPv4-mapped IPv6 (::ffff:x.x.x.x)
      const v4mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      if (v4mapped) return isBlockedIP(v4mapped[1]);
      return false;
    }
    return false;
  }

  function isBlockedHostname(hostname: string): boolean {
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return true;
    return isBlockedIP(hostname);
  }

  async function doFetch(targetUrl: string, redirectCount: number): Promise<string> {
    if (!targetUrl || (!targetUrl.startsWith('https://') && !targetUrl.startsWith('http://'))) {
      return 'Error: URL must start with https:// or http://';
    }

    const httpMethod = (method || 'GET').toUpperCase();
    let parsedHeaders: Record<string, string> = {};
    if (headersStr) {
      try { parsedHeaders = JSON.parse(headersStr); } catch { /* ignore */ }
    }

    const parsedUrl = new URL(targetUrl);

    if (isBlockedHostname(parsedUrl.hostname)) {
      return 'Error: Access to internal/private addresses is not allowed.';
    }

    // DNS rebinding protection: resolve hostname and check resolved IP
    try {
      const { address } = await dnsLookup(parsedUrl.hostname);
      if (isBlockedIP(address)) {
        return 'Error: Access to internal/private addresses is not allowed.';
      }
    } catch {
      return 'Error: DNS resolution failed for the given hostname.';
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http;

    return new Promise((resolve) => {
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: httpMethod,
        headers: {
          'User-Agent': 'ASAP-Agent/1.0',
          ...parsedHeaders,
        },
        timeout: 30_000,
      };

      const req = lib.request(options, (res) => {
        const status = res.statusCode || 0;

        if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && res.headers.location) {
          if (redirectCount >= MAX_REDIRECTS) {
            resolve(`Error: Too many redirects (max ${MAX_REDIRECTS})`);
            return;
          }
          const location = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, targetUrl).toString();
          res.resume();
          resolve(doFetch(location, redirectCount + 1));
          return;
        }

        let data = '';
        const maxSize = 100_000;

        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          if (data.length > maxSize) {
            res.destroy();
          }
        });

        res.on('end', () => {
          const header = `HTTP ${status} ${res.statusMessage || ''}\n`;
          if (data.length > maxSize) {
            resolve(header + data.slice(0, maxSize) + '\n\n[Response truncated at 100KB]');
          } else {
            resolve(header + data);
          }
        });
      });

      req.on('error', (err) => {
        resolve(`Fetch error: ${err.message}`);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve('Fetch error: Request timed out (30s)');
      });

      if (body && (httpMethod === 'POST' || httpMethod === 'PUT' || httpMethod === 'PATCH')) {
        req.write(body);
      }

      req.end();
    });
  }

  return doFetch(url, 0);
}


function safeMemoryName(file: string): string {
  const safe = path.basename(file).replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe) throw new Error('Invalid memory file name');
  return safe;
}

async function memoryRead(file: string): Promise<string> {
  try {
    const name = safeMemoryName(file);
    const content = await readMemoryRow(name);
    if (content === null) {
      return `Memory file "${file}" does not exist. Use memory_list to see available files, or memory_write to create one.`;
    }
    return content;
  } catch (err) {
    return `Error reading memory: ${errMsg(err)}`;
  }
}

async function memoryWrite(file: string, content: string): Promise<string> {
  try {
    const name = safeMemoryName(file);
    await upsertMemory(name, content);
    return `Memory saved to "${file}" (${content.length} bytes)`;
  } catch (err) {
    return `Error writing memory: ${errMsg(err)}`;
  }
}

async function memoryAppend(file: string, content: string): Promise<string> {
  try {
    const name = safeMemoryName(file);
    const totalLen = await appendMemoryRow(name, content);
    return `Appended to "${file}" (now ${totalLen} bytes)`;
  } catch (err) {
    return `Error appending to memory: ${errMsg(err)}`;
  }
}

async function memoryList(): Promise<string> {
  try {
    const pool = (await import('../db/pool')).default;
    const { rows } = await pool.query(
      `SELECT file_name, length(content) AS size_bytes, updated_at FROM agent_memory ORDER BY updated_at DESC`
    );
    if (rows.length === 0) return 'No memory files yet. Use memory_write to create one.';
    return rows.map((r: any) => {
      const kb = (r.size_bytes / 1024).toFixed(1);
      const modified = new Date(r.updated_at).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
      return `📄 ${r.file_name} (${kb} KB, modified ${modified})`;
    }).join('\n');
  } catch (err) {
    return `Error listing memory: ${errMsg(err)}`;
  }
}

const REPO_MEMORY_DEFAULT_MAX_FILES = 1200;
const REPO_MEMORY_MAX_FILES_HARD = 4000;
const REPO_MEMORY_MAX_FILE_BYTES = 220_000;
const REPO_MEMORY_CHUNK_CHARS = 2400;
const REPO_MEMORY_DEFAULT_LIMIT = 8;
const REPO_MEMORY_LIMIT_HARD = 20;
let repoMemoryDbDisabled = false;
const repoMemoryFileHashCache = new Map<string, string>();
const repoMemoryChunkCache = new Map<string, string>();
const repoMemoryStateCache = new Map<string, string>();
let repoMemoryCacheLoaded = false;
const REPO_MEMORY_CACHE_DIR = path.join(REPO_ROOT, '.agent-memory-repo');
const REPO_MEMORY_CACHE_FILE = path.join(REPO_MEMORY_CACHE_DIR, 'repo-memory-cache.json');
const REPO_MEMORY_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.expo', '.turbo', 'coverage', '.cache', '.idea', '.vscode', 'ios/build', 'android/build',
]);
const REPO_MEMORY_SKIP_FILE_RE = /\.(png|jpg|jpeg|gif|webp|ico|bmp|tiff|woff2?|ttf|otf|eot|mp3|wav|ogg|m4a|mp4|mov|avi|zip|gz|tar|pdf|jar|keystore|db|sqlite)$/i;
const REPO_MEMORY_INCLUDE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.sql', '.sh', '.txt', '.env.example', '.tf', '.toml', '.ini', '.xml', '.html', '.css', '.scss',
]);
const repoMemoryAutoUpdateTimers = new Map<string, NodeJS.Timeout>();

function normalizeRepoPath(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function repoMemoryRemovePathCaches(relPath: string): void {
  repoMemoryFileHashCache.delete(relPath);
  const prefix = `repoidx:repo:${relPath}:`;
  for (const key of repoMemoryChunkCache.keys()) {
    if (key.startsWith(prefix)) repoMemoryChunkCache.delete(key);
  }
}

function scheduleRepoMemoryAutoUpsert(relativePath: string): void {
  if (!AUTO_REPO_MEMORY_UPDATE) return;
  const relPath = String(relativePath || '').trim().replace(/^\.\//, '');
  if (!relPath) return;

  const existing = repoMemoryAutoUpdateTimers.get(relPath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    repoMemoryAutoUpdateTimers.delete(relPath);
    void repoMemoryUpsertPath(relPath).catch(() => {});
  }, 300);

  repoMemoryAutoUpdateTimers.set(relPath, timer);
}

async function repoMemoryUpsertPath(relPathRaw: string): Promise<void> {
  const relPath = String(relPathRaw || '').trim().replace(/^\.\//, '');
  if (!relPath) return;

  let absPath: string;
  try {
    absPath = safePath(relPath);
  } catch {
    return;
  }

  ensureRepoMemoryCacheLoaded();

  if (!fs.existsSync(absPath)) {
    repoMemoryRemovePathCaches(relPath);
    flushRepoMemoryCacheToDisk();
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return;
  }

  if (!shouldIndexRepoFile(relPath, stat)) {
    repoMemoryRemovePathCaches(relPath);
    flushRepoMemoryCacheToDisk();
    return;
  }

  let content = '';
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return;
  }

  const fileHash = hashText(content);
  const prevHash = repoMemoryFileHashCache.get(relPath);
  if (prevHash && prevHash === fileHash) return;

  repoMemoryRemovePathCaches(relPath);
  const chunks = chunkTextBySize(content, REPO_MEMORY_CHUNK_CHARS);
  for (let i = 0; i < chunks.length; i++) {
    repoMemoryChunkCache.set(`repoidx:repo:${relPath}:${i}`, chunks[i]);
  }
  repoMemoryFileHashCache.set(relPath, fileHash);
  flushRepoMemoryCacheToDisk();

  if (repoMemoryDbDisabled) return;

  const pool = (await import('../db/pool')).default;
  const fileKey = `repoidx:file:repo:${relPath}`;
  const chunkPrefix = `repoidx:repo:${relPath}:`;
  let client: any | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`DELETE FROM agent_memory WHERE file_name LIKE $1`, [`${chunkPrefix}%`]);
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO agent_memory (file_name, content, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (file_name)
         DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
        [`repoidx:repo:${relPath}:${i}`, chunks[i]]
      );
    }
    await client.query(
      `INSERT INTO agent_memory (file_name, content, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (file_name)
       DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
      [fileKey, fileHash]
    );
    await client.query('COMMIT');
  } catch {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    repoMemoryDbDisabled = true;
  } finally {
    if (client) client.release();
  }
}

function shouldIndexRepoFile(relPath: string, stat: fs.Stats): boolean {
  if (!stat.isFile()) return false;
  if (stat.size <= 0 || stat.size > REPO_MEMORY_MAX_FILE_BYTES) return false;
  if (REPO_MEMORY_SKIP_FILE_RE.test(relPath)) return false;
  const base = path.basename(relPath).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return false;
  const ext = path.extname(relPath).toLowerCase();
  if (REPO_MEMORY_INCLUDE_EXT.has(ext)) return true;
  if (base === 'dockerfile' || base.endsWith('.mdx')) return true;
  return false;
}

function listRepoFilesForIndex(maxFiles: number): string[] {
  const out: string[] = [];
  const stack: string[] = [REPO_ROOT];

  while (stack.length > 0 && out.length < maxFiles) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const abs = path.join(cur, entry.name);
      const rel = normalizeRepoPath(abs);
      if (!rel || rel.startsWith('..')) continue;

      if (entry.isDirectory()) {
        if (REPO_MEMORY_SKIP_DIRS.has(rel) || REPO_MEMORY_SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        stack.push(abs);
        continue;
      }

      if (!entry.isFile()) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!shouldIndexRepoFile(rel, stat)) continue;
      out.push(abs);
    }
  }

  return out.sort((a, b) => a.localeCompare(b));
}

function chunkTextBySize(text: string, maxChars: number): string[] {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) return [];
  const lines = normalized.split('\n');
  const chunks: string[] = [];
  let buf = '';

  for (const line of lines) {
    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length <= maxChars) {
      buf = candidate;
      continue;
    }

    if (buf.trim()) chunks.push(buf.trim());
    if (line.length <= maxChars) {
      buf = line;
    } else {
      for (let i = 0; i < line.length; i += maxChars) {
        const part = line.slice(i, i + maxChars).trim();
        if (part) chunks.push(part);
      }
      buf = '';
    }
  }

  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function normalizeOssTags(raw?: string): string[] {
  return String(raw || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 16);
}

function ensureRepoMemoryCacheLoaded(): void {
  if (repoMemoryCacheLoaded) return;
  repoMemoryCacheLoaded = true;

  try {
    if (!fs.existsSync(REPO_MEMORY_CACHE_FILE)) return;
    const raw = fs.readFileSync(REPO_MEMORY_CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as {
      fileHashes?: Record<string, string>;
      chunks?: Record<string, string>;
      state?: Record<string, string>;
    };
    for (const [k, v] of Object.entries(parsed.fileHashes || {})) {
      repoMemoryFileHashCache.set(k, String(v));
    }
    for (const [k, v] of Object.entries(parsed.chunks || {})) {
      repoMemoryChunkCache.set(k, String(v));
    }
    for (const [k, v] of Object.entries(parsed.state || {})) {
      repoMemoryStateCache.set(k, String(v));
    }
  } catch {
  }
}

function flushRepoMemoryCacheToDisk(): void {
  try {
    fs.mkdirSync(REPO_MEMORY_CACHE_DIR, { recursive: true });
    const payload = {
      fileHashes: Object.fromEntries(repoMemoryFileHashCache.entries()),
      chunks: Object.fromEntries(repoMemoryChunkCache.entries()),
      state: Object.fromEntries(repoMemoryStateCache.entries()),
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(REPO_MEMORY_CACHE_FILE, JSON.stringify(payload), 'utf-8');
  } catch {
  }
}

function repoMemoryIndexCache(mode: 'incremental' | 'full', maxFiles: number): string {
  ensureRepoMemoryCacheLoaded();
  const started = Date.now();
  const files = listRepoFilesForIndex(maxFiles);
  const seen = new Set<string>();
  let scanned = 0;
  let changed = 0;
  let skipped = 0;
  let chunksUpserted = 0;

  for (const absPath of files) {
    const relPath = normalizeRepoPath(absPath);
    seen.add(relPath);
    scanned += 1;

    let content = '';
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      skipped += 1;
      continue;
    }

    const fileHash = hashText(content);
    const prevHash = repoMemoryFileHashCache.get(relPath);
    if (mode !== 'full' && prevHash && prevHash === fileHash) {
      skipped += 1;
      continue;
    }

    changed += 1;
    const prefix = `repoidx:repo:${relPath}:`;
    for (const key of repoMemoryChunkCache.keys()) {
      if (key.startsWith(prefix)) repoMemoryChunkCache.delete(key);
    }

    const chunks = chunkTextBySize(content, REPO_MEMORY_CHUNK_CHARS);
    for (let i = 0; i < chunks.length; i++) {
      repoMemoryChunkCache.set(`repoidx:repo:${relPath}:${i}`, chunks[i]);
      chunksUpserted += 1;
    }

    repoMemoryFileHashCache.set(relPath, fileHash);
  }

  let removed = 0;
  for (const oldPath of Array.from(repoMemoryFileHashCache.keys())) {
    if (seen.has(oldPath)) continue;
    removed += 1;
    repoMemoryFileHashCache.delete(oldPath);
    const prefix = `repoidx:repo:${oldPath}:`;
    for (const key of repoMemoryChunkCache.keys()) {
      if (key.startsWith(prefix)) repoMemoryChunkCache.delete(key);
    }
  }

  repoMemoryStateCache.set('repoidx:state', JSON.stringify({
    mode,
    scanned,
    changed,
    skipped,
    removed,
    chunksUpserted,
    completedAt: new Date().toISOString(),
    storage: 'in-memory-fallback',
  }));
  flushRepoMemoryCacheToDisk();

  const elapsed = Date.now() - started;
  return `Repo index updated (${mode}, fallback-cache): scanned=${scanned}, changed=${changed}, skipped=${skipped}, removed=${removed}, chunks=${chunksUpserted}, elapsed=${elapsed}ms.`;
}

function repoMemorySearchCache(query: string, limit: number, source: 'repo' | 'oss' | 'all'): string {
  ensureRepoMemoryCacheLoaded();
  const q = query.toLowerCase();
  const rows: Array<{ key: string; snippet: string; score: number }> = [];

  for (const [key, content] of repoMemoryChunkCache.entries()) {
    const isRepo = key.startsWith('repoidx:repo:');
    const isOss = key.startsWith('repoidx:oss:');
    if (source === 'repo' && !isRepo) continue;
    if (source === 'oss' && !isOss) continue;
    const hay = `${key}\n${content}`.toLowerCase();
    if (!hay.includes(q)) continue;
    const score = (content.toLowerCase().match(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length + (key.toLowerCase().includes(q) ? 2 : 0);
    rows.push({ key, snippet: content.slice(0, 420), score });
  }

  rows.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const top = rows.slice(0, limit);
  if (top.length === 0) return 'No repo memory hits found. Run repo_memory_index first, or broaden the query.';

  const lines = top.map((r, idx) => {
    const sourceType = r.key.startsWith('repoidx:oss:') ? 'oss' : 'repo';
    const shortKey = r.key.replace(/^repoidx:(repo|oss):/, '');
    const snippet = r.snippet.replace(/\s+/g, ' ').trim();
    return `${idx + 1}. [${sourceType}] ${shortKey} (rank=${r.score.toFixed(3)})\n   ${snippet}`;
  });
  return `Repo memory results for "${query}":\n${lines.join('\n')}`.slice(0, 4000);
}

function repoMemoryAddOssCache(title: string, content: string, tagsRaw?: string): string {
  ensureRepoMemoryCacheLoaded();
  const sourcePath = title.toLowerCase().replace(/\s+/g, '-');
  const chunks = chunkTextBySize(content, REPO_MEMORY_CHUNK_CHARS);
  const tags = normalizeOssTags(tagsRaw);
  const prefix = `repoidx:oss:${sourcePath}:`;

  for (const key of repoMemoryChunkCache.keys()) {
    if (key.startsWith(prefix)) repoMemoryChunkCache.delete(key);
  }
  for (let i = 0; i < chunks.length; i++) {
    const withTags = tags.length > 0 ? `[tags:${tags.join(', ')}]\n${chunks[i]}` : chunks[i];
    repoMemoryChunkCache.set(`repoidx:oss:${sourcePath}:${i}`, withTags);
  }
  flushRepoMemoryCacheToDisk();

  return `Stored OSS knowledge: ${sourcePath} (${chunks.length} chunk(s), fallback-cache).`;
}

export async function repoMemoryIndex(modeRaw?: string, maxFilesRaw?: number): Promise<string> {
  const mode = String(modeRaw || 'incremental').toLowerCase() === 'full' ? 'full' : 'incremental';
  const maxFiles = Math.min(REPO_MEMORY_MAX_FILES_HARD, Math.max(100, Number(maxFilesRaw) || REPO_MEMORY_DEFAULT_MAX_FILES));
  if (repoMemoryDbDisabled) {
    return repoMemoryIndexCache(mode, maxFiles);
  }

  const pool = (await import('../db/pool')).default;
  const started = Date.now();
  const files = listRepoFilesForIndex(maxFiles);

  const repoFileKey = (relPath: string): string => `repoidx:file:repo:${relPath}`;
  const repoChunkPrefix = (relPath: string): string => `repoidx:repo:${relPath}:`;
  const stateKey = 'repoidx:state';

  let client: any | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const existingRes = await client.query(
      `SELECT file_name, content FROM agent_memory WHERE file_name LIKE 'repoidx:file:repo:%'`
    );
    const existing = new Map<string, string>();
    for (const row of existingRes.rows) {
      const relPath = row.file_name.replace(/^repoidx:file:repo:/, '');
      existing.set(relPath, String(row.content || ''));
    }
    const seen = new Set<string>();

    let scanned = 0;
    let changed = 0;
    let chunksUpserted = 0;
    let skipped = 0;

    for (const absPath of files) {
      const relPath = normalizeRepoPath(absPath);
      seen.add(relPath);
      scanned += 1;

      let content = '';
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        skipped += 1;
        continue;
      }

      const fileHash = hashText(content);
      const prevHash = existing.get(relPath);
      if (mode !== 'full' && prevHash && prevHash === fileHash) {
        skipped += 1;
        continue;
      }

      changed += 1;
      const chunks = chunkTextBySize(content, REPO_MEMORY_CHUNK_CHARS);
      await client.query(
        `DELETE FROM agent_memory WHERE file_name LIKE $1`,
        [`${repoChunkPrefix(relPath)}%`]
      );

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        await client.query(
          `INSERT INTO agent_memory (file_name, content, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (file_name)
           DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
          [`repoidx:repo:${relPath}:${i}`, chunk]
        );
        chunksUpserted += 1;
      }

      await client.query(
        `INSERT INTO agent_memory (file_name, content, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (file_name)
         DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
        [repoFileKey(relPath), fileHash]
      );
    }

    let removed = 0;
    for (const oldPath of existing.keys()) {
      if (seen.has(oldPath)) continue;
      removed += 1;
      await client.query(`DELETE FROM agent_memory WHERE file_name LIKE $1`, [`${repoChunkPrefix(oldPath)}%`]);
      await client.query(`DELETE FROM agent_memory WHERE file_name = $1`, [repoFileKey(oldPath)]);
    }

    await client.query(
      `INSERT INTO agent_memory (file_name, content, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (file_name)
       DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
      [
        stateKey,
        JSON.stringify({
        mode,
        scanned,
        changed,
        skipped,
        removed,
        chunksUpserted,
        completedAt: new Date().toISOString(),
        }),
      ]
    );

    await client.query('COMMIT');
    const elapsed = Date.now() - started;
    return `Repo index updated (${mode}): scanned=${scanned}, changed=${changed}, skipped=${skipped}, removed=${removed}, chunks=${chunksUpserted}, elapsed=${elapsed}ms.`;
  } catch {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    repoMemoryDbDisabled = true;
    return repoMemoryIndexCache(mode, maxFiles);
  } finally {
    if (client) client.release();
  }
}

async function repoMemorySearch(query: string, limitRaw?: number, sourceRaw?: string): Promise<string> {
  const q = String(query || '').trim();
  if (!q) return 'Query is required.';

  const safeLimit = Math.min(REPO_MEMORY_LIMIT_HARD, Math.max(1, Number(limitRaw) || REPO_MEMORY_DEFAULT_LIMIT));
  const source = String(sourceRaw || 'all').toLowerCase();
  const sourceFilter: 'repo' | 'oss' | 'all' = source === 'repo' || source === 'oss' ? source : 'all';
  if (repoMemoryDbDisabled) {
    return repoMemorySearchCache(q, safeLimit, sourceFilter);
  }

  const pool = (await import('../db/pool')).default;

  try {
    const prefixFilter = sourceFilter === 'repo'
      ? `file_name LIKE 'repoidx:repo:%'`
      : sourceFilter === 'oss'
        ? `file_name LIKE 'repoidx:oss:%'`
        : `(file_name LIKE 'repoidx:repo:%' OR file_name LIKE 'repoidx:oss:%')`;

    const { rows } = await pool.query(
      `SELECT file_name,
              LEFT(content, 420) AS snippet,
              ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', $1)) AS rank,
              updated_at
       FROM agent_memory
       WHERE ${prefixFilter}
         AND (
           to_tsvector('english', content) @@ plainto_tsquery('english', $1)
           OR content ILIKE '%' || $1 || '%'
           OR file_name ILIKE '%' || $1 || '%'
         )
       ORDER BY rank DESC NULLS LAST, updated_at DESC
       LIMIT $2`,
      [q, safeLimit]
    );

    if (rows.length === 0) {
      return 'No repo memory hits found. Run repo_memory_index first, or broaden the query.';
    }

    const lines = rows.map((r: any, idx: number) => {
      const snippet = String(r.snippet || '').replace(/\s+/g, ' ').trim();
      const rank = Number(r.rank || 0).toFixed(3);
      const key = String(r.file_name || '');
      const sourceType = key.startsWith('repoidx:oss:') ? 'oss' : 'repo';
      const shortKey = key.replace(/^repoidx:(repo|oss):/, '');
      return `${idx + 1}. [${sourceType}] ${shortKey} (rank=${rank})\n   ${snippet}`;
    });
    return `Repo memory results for "${q}":\n${lines.join('\n')}`.slice(0, 4000);
  } catch {
    repoMemoryDbDisabled = true;
    return repoMemorySearchCache(q, safeLimit, sourceFilter);
  }
}

async function repoMemoryAddOss(title: string, content: string, tagsRaw?: string): Promise<string> {
  const cleanTitle = String(title || '').trim().slice(0, 120).replace(/[^a-zA-Z0-9_.:/ -]/g, '');
  const cleanContent = String(content || '').trim();
  if (!cleanTitle) return 'Title is required.';
  if (!cleanContent) return 'Content is required.';

  if (repoMemoryDbDisabled) {
    return repoMemoryAddOssCache(cleanTitle, cleanContent, tagsRaw);
  }

  const pool = (await import('../db/pool')).default;

  const sourcePath = cleanTitle.toLowerCase().replace(/\s+/g, '-');
  const chunks = chunkTextBySize(cleanContent, REPO_MEMORY_CHUNK_CHARS);
  if (chunks.length === 0) return 'Content is empty after normalization.';
  const fileHash = hashText(cleanContent);
  const tags = normalizeOssTags(tagsRaw);
  const metaPrefix = `repoidx:ossmeta:${sourcePath}`;
  const chunkPrefix = `repoidx:oss:${sourcePath}:`;
  const metaKey = `${metaPrefix}:file`;

  let client: any | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`DELETE FROM agent_memory WHERE file_name LIKE $1`, [`${chunkPrefix}%`]);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const withTags = tags.length > 0 ? `[tags:${tags.join(', ')}]\n${chunk}` : chunk;
      await client.query(
        `INSERT INTO agent_memory (file_name, content, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (file_name)
         DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
        [`repoidx:oss:${sourcePath}:${i}`, withTags]
      );
    }

    await client.query(
      `INSERT INTO agent_memory (file_name, content, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (file_name)
       DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
      [metaKey, JSON.stringify({ title: cleanTitle, tags, fileHash, chunks: chunks.length })]
    );

    await client.query('COMMIT');
    return `Stored OSS knowledge: ${sourcePath} (${chunks.length} chunk(s)).`;
  } catch {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    repoMemoryDbDisabled = true;
    return repoMemoryAddOssCache(cleanTitle, cleanContent, tagsRaw);
  } finally {
    if (client) client.release();
  }
}


// DB operations → ./toolsDb.ts

// Re-export security functions for testing + path safety for testing
export { DDL_PATTERN, sanitizeSql, isReadOnlySql } from './toolsDb';
export { safePath, BLOCKED_PATHS, HARD_BLOCKED, ALLOWED_COMMANDS };

