import { execSync, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

import {
  Guild,
  ChannelType,
  TextChannel,
  CategoryChannel,
} from 'discord.js';

import {
  createBranch,
  createPullRequest,
  mergePullRequest,
  addPRComment,
  listPullRequests,
  searchGitHub,
} from '../services/github';

import { getAgent, AgentId } from './agents';
import { getRequiredReviewers } from './handlers/review';
import { mobileHarnessStart, mobileHarnessStep, mobileHarnessSnapshot, mobileHarnessStop } from './services/mobileHarness';
import { captureAndPostScreenshots } from './services/screenshots';
import { getWebhook } from './services/webhooks';
import { setDailyBudgetLimit } from './usage';


let discordGuild: Guild | null = null;
let agentChannelResolver: ((agentId: string) => TextChannel | null) | null = null;

export function setDiscordGuild(guild: Guild): void {
  discordGuild = guild;
}

export function setAgentChannelResolver(cb: (agentId: string) => TextChannel | null): void {
  agentChannelResolver = cb;
}

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

/**
 * Safe repository root — resolved at startup.
 * In Docker: /app, in local dev: the repo root.
 */
const REPO_ROOT = fs.existsSync('/app/package.json')
  ? '/app'
  : path.resolve(__dirname, '..', '..', '..');
const SERVER_ROOT = fs.existsSync(path.join(REPO_ROOT, 'server', 'package.json'))
  ? path.join(REPO_ROOT, 'server')
  : REPO_ROOT;

/** Directories agents are never allowed to touch */
const BLOCKED_PATHS = [
  '.env',
  'node_modules',
  '.git/objects',
  '.git/refs',
  '.git/HEAD',
];

/** Max file size agents can write (2 MB) */
const MAX_WRITE_SIZE = 2 * 1024 * 1024;

/** Max command execution time (2 min) */
const CMD_TIMEOUT = 120_000;
const AUTO_REPO_MEMORY_UPDATE = String(process.env.AUTO_REPO_MEMORY_UPDATE ?? 'true').toLowerCase() !== 'false';
const TOOL_RESULT_CACHE_TTL_MS = Math.max(1_000, Number(process.env.TOOL_RESULT_CACHE_TTL_MS || '45000'));
const TOOL_RESULT_CACHE_MAX_ENTRIES = Math.max(200, Number(process.env.TOOL_RESULT_CACHE_MAX_ENTRIES || '2000'));
const HOT_SEARCH_INDEX_TTL_MS = Math.max(5_000, Number(process.env.HOT_SEARCH_INDEX_TTL_MS || '120000'));
const HOT_SEARCH_INDEX_MAX_CHUNKS = Math.max(200, Number(process.env.HOT_SEARCH_INDEX_MAX_CHUNKS || '5000'));
const DB_SCHEMA_CACHE_TTL_MS = Math.max(30_000, Number(process.env.DB_SCHEMA_CACHE_TTL_MS || '300000'));

type ToolCacheEntry = { result: string; expiresAt: number };
const toolResultCache = new Map<string, ToolCacheEntry>();
const toolInFlight = new Map<string, Promise<string>>();
const dbSchemaCache = new Map<string, ToolCacheEntry>();

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


export const REPO_TOOLS = [
  {
    name: 'read_file',
    description:
      'Read the contents of a file in the ASAP-discord repository. Use relative paths from the repo root (e.g. "src/index.ts", "src/discord/tools.ts").',
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
      'Create or overwrite a file in the ASAP-discord repository. Use relative paths. Parent directories are created automatically.',
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
      'Replace an exact string in a file with a new string. The old_string must appear exactly once. Include surrounding context lines to be unambiguous.',
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
      'Run a shell command in the repository root. Use for: npm scripts, TypeScript type-checking, git operations, etc. Commands run in a sandboxed context with a 2-minute timeout.',
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
      'List open pull requests on the ASAP-discord repository.',
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
          description: 'Max commits to return (default: 10, max: 30)',
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
      'Run the Discord smoke-test suite through ASAPTester. Use this after important routing or orchestration changes to verify agents still respond correctly end-to-end.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent: {
          type: 'string',
          description: 'Optional agent filter, e.g. "developer", "qa", or "executive-assistant". Leave empty to run the whole suite.',
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
      'List workspace threads under the groupchat channel, including idle time and a ready-to-close heuristic. Useful for Riley to manage stale or completed threads.',
    input_schema: {
      type: 'object' as const,
      properties: {
        include_archived: {
          type: 'string',
          description: 'Set to "true" to also include recently archived threads.',
        },
        limit: {
          type: 'number',
          description: 'Max threads to show (default: 10, max: 25).',
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
      'Permanently delete a Discord channel by name. Cannot delete protected core/operations channels (groupchat, voice, thread-status, decisions, github, upgrades, tools, call-log, limits, cost, screenshots, url, terminal, voice-errors, agent-errors). NEVER use this for "reset/clear" requests — use RESET_CHANNELS workflow instead.',
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
      'Search the ASAP GitHub repository for code, issues/PRs, or commits. Use this to find things across the repo history, open issues, or specific code patterns on GitHub.',
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
      'Run TypeScript type-checking (tsc --noEmit) on the client app, server, or both. Returns any type errors found. Use this after making code changes to verify correctness.',
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
      'Apply multiple file edits in a single tool call. More efficient than calling edit_file multiple times. Each edit replaces an exact string in a file (old_string must appear exactly once). Edits are applied sequentially — later edits see the results of earlier ones.',
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
      'Capture screenshots of the live app and post them to Discord. Defaults to the invoking agent channel, or #screenshots if no agent channel is available. Uses headless Chromium sized to iPhone 17 Pro Max.',
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
      'Start an interactive iPhone 17 Pro Max web harness session for this agent. Opens a live page in headless mobile emulation and posts a snapshot to Discord.',
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
      'Query Cloud Logging across any GCP service using a full filter expression. More powerful than read_logs — supports any resource type (cloud_run_revision, gce_instance, cloudsql_database, etc.), severity filters, and time ranges.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filter: {
          type: 'string',
          description: 'Cloud Logging filter, e.g. "resource.type=cloud_run_revision severity>=ERROR" or "resource.type=gce_instance"',
        },
        limit: {
          type: 'number',
          description: 'Max log lines (default: 50, max: 200)',
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
          description: 'Max images to show (default: 20)',
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
      'Run a validated command on the GCE VM (asap-bot-vm) via gcloud SSH. Use to restart the Discord bot, pull code, check PM2 status, or inspect VM health. Commands must match the safe allowlist.',
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
      'Set the daily Gemini/AI spend cap (in USD) for ALL agents. Call this when agents are being blocked by the budget gate or when Jordan has authorised a higher limit. The new limit takes effect immediately (no restart needed) and is persisted to the .env file so it survives restarts. Riley is the primary user of this tool — use it proactively rather than letting agents stall.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit_usd: {
          type: 'number',
          description: 'New daily hard budget cap in USD (e.g. 150 for $150/day). Must be ≥ 0.',
        },
        reason: {
          type: 'string',
          description: 'Brief reason for the change, e.g. "Jordan approved $150 limit for today\'s sprint".',
        },
      },
      required: ['limit_usd'],
    },
  },
  {
    name: 'fetch_url',
    description:
      'Fetch the content of any URL (web pages, APIs, npm registry, documentation, JSON endpoints). Returns the response body as text. Use this to research libraries, read docs, check APIs, or fetch any web resource. Supports GET and POST.',
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
      'Build or refresh a persistent searchable index of repository files in PostgreSQL. Use this before deep implementation work to reduce repeated file reads across agents.',
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
      'Search the persistent repo/OSS knowledge index using full-text retrieval. Returns the most relevant chunks with source paths so agents can target reads.',
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
      'Execute a read-only SQL query (SELECT/CTE/EXPLAIN/SHOW) against the ASAP PostgreSQL database. Any write/mutation SQL is blocked.',
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
      'Execute a SQL query against the ASAP PostgreSQL database (Cloud SQL). Returns results as formatted text. Use for SELECT queries to inspect data, debug issues, or analyze the database. Write queries (INSERT, UPDATE, DELETE, CREATE, ALTER, DROP) are also allowed but use with care.',
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
] as const;

/**
 * Tool subset for review/advisory agents (QA, security, UX, etc.).
 * Keeps codebase write operations locked down, while allowing operational testing:
 * GCP inspect tools, screenshots, and mobile harness interactions.
 */
const REVIEW_TOOL_NAMES = new Set([
  'read_file', 'search_files', 'list_directory', 'check_file_exists', 'fetch_url',
  'db_query_readonly', 'db_schema', 'memory_read', 'memory_list',
  'repo_memory_index', 'repo_memory_search', 'repo_memory_add_oss',
  'run_tests', 'typecheck', 'git_file_history', 'smoke_test_agents', 'list_threads',
  'send_channel_message',
  'capture_screenshots',
  'mobile_harness_start', 'mobile_harness_step', 'mobile_harness_snapshot', 'mobile_harness_stop',
  'gcp_preflight', 'gcp_get_env', 'gcp_list_revisions', 'gcp_secret_list', 'gcp_build_status',
  'gcp_logs_query', 'gcp_run_describe', 'gcp_storage_ls', 'gcp_artifact_list', 'gcp_sql_describe', 'gcp_project_info',
]);
export const REVIEW_TOOLS = REPO_TOOLS.filter((t) => REVIEW_TOOL_NAMES.has(t.name));

/**
 * Riley keeps a leaner coordination/ops-only surface so orchestration stays focused.
 * She can inspect state, run smoke checks, and communicate, but large code/deploy mutations
 * are delegated to the specialist agents.
 */
const RILEY_TOOL_NAMES = new Set([
  'read_file', 'search_files', 'list_directory', 'check_file_exists', 'fetch_url',
  'memory_read', 'memory_write', 'memory_append', 'memory_list',
  'repo_memory_index', 'repo_memory_search', 'repo_memory_add_oss',
  'run_tests', 'typecheck', 'git_file_history', 'smoke_test_agents',
  'list_threads', 'list_channels', 'send_channel_message', 'clear_channel_messages',
  'read_logs', 'github_search', 'capture_screenshots',
  'mobile_harness_start', 'mobile_harness_step', 'mobile_harness_snapshot', 'mobile_harness_stop',
  'gcp_preflight', 'gcp_get_env', 'gcp_list_revisions', 'gcp_secret_list', 'gcp_build_status',
  'gcp_logs_query', 'gcp_run_describe', 'gcp_storage_ls', 'gcp_artifact_list', 'gcp_sql_describe', 'gcp_project_info',
  'set_daily_budget', 'db_query_readonly', 'db_schema',
]);
export const RILEY_TOOLS = REPO_TOOLS.filter((t) => RILEY_TOOL_NAMES.has(t.name));

type PromptTool = {
  name: string;
  description: string;
  input_schema: any;
};

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
export const PROMPT_RILEY_TOOLS: PromptTool[] = RILEY_TOOLS.map(compactToolForPrompt);

const STRICT_AGENT_TOOL_ACCESS = String(process.env.STRICT_AGENT_TOOL_ACCESS ?? 'true').toLowerCase() !== 'false';
const RILEY_AGENT_ID = 'executive-assistant';
const FULL_TOOL_ACCESS_AGENT_IDS = new Set(['developer', 'devops', 'ios-engineer', 'android-engineer']);
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

function getRawToolsForAgent(agentId: string): readonly (typeof REPO_TOOLS[number])[] {
  const id = String(agentId || '').trim().toLowerCase();
  if (!STRICT_AGENT_TOOL_ACCESS) return REPO_TOOLS;
  if (FULL_TOOL_ACCESS_AGENT_IDS.has(id)) return REPO_TOOLS;
  if (id === RILEY_AGENT_ID) return RILEY_TOOLS;
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
  input: Record<string, string>,
  context?: { agentId?: string; threadKey?: string }
): Promise<string> {
  const scope = context?.threadKey || context?.agentId || 'global';
  const key = buildToolCacheKey(scope, toolName, input);
  const cacheable = isCacheableTool(toolName);

  if (context?.agentId && !agentCanUseTool(context.agentId, toolName)) {
    return `Error: Tool "${toolName}" is not allowed for agent "${context.agentId}".`;
  }

  if (cacheable) {
    const cached = getCachedToolResult(key);
    if (cached !== null) return cached;

    const inFlight = toolInFlight.get(key);
    if (inFlight) return inFlight;
  }

  const runPromise = executeToolInternal(toolName, input, context);
  if (cacheable) toolInFlight.set(key, runPromise);

  try {
    const result = await runPromise;
    if (cacheable && !/^Error:/i.test(String(result || '').trim())) {
      setCachedToolResult(key, result);
    }
    return result;
  } finally {
    if (cacheable) toolInFlight.delete(key);
  }
}

async function executeToolInternal(
  toolName: string,
  input: Record<string, string>,
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
        return await gitCreateBranch(input.branch_name, input.base_branch);
      case 'create_pull_request':
        return await ghCreatePR(input.title, input.body, input.head, input.base);
      case 'merge_pull_request':
        return await ghMergePR(parseInt(input.pr_number, 10), input.commit_title);
      case 'add_pr_comment':
        return await ghAddComment(parseInt(input.pr_number, 10), input.body);
      case 'list_pull_requests':
        return await ghListPRs();
      case 'run_tests':
        clearToolResultCache(scope);
        return runTests(input.test_pattern);
      case 'git_file_history':
        return gitFileHistory(input.path, parseInt(input.limit, 10) || 10, input.line_range);
      case 'smoke_test_agents':
        return smokeTestAgents(input.agent, parseInt(input.timeout_ms, 10) || 90_000);
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
      case 'clear_channel_messages':
        return await discordClearChannelMessages(input.channel_name, parseInt(input.limit, 10) || 500);
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
        await captureAndPostScreenshots(url, label, { targetChannel: target, clearTargetChannel: false });
        const destination = target ? `#${target.name}` : '#screenshots';
        return `Screenshots captured and posted to ${destination}. URL: ${url}`;
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
      case 'gcp_deploy':
        return await gcpDeploy(input.tag);
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
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }
}

function normalizeToolInput(input: Record<string, string>): string {
  const entries = Object.entries(input || {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function buildToolCacheKey(scope: string, toolName: string, input: Record<string, string>): string {
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
  const count = content.split(oldString).length - 1;
  if (count === 0) {
    return `old_string not found in ${relativePath}. Check whitespace and exact content.`;
  }
  if (count > 1) {
    return `old_string found ${count} times in ${relativePath}. It must appear exactly once. Add more surrounding context to be unambiguous.`;
  }
  const updated = content.replace(oldString, newString);
  fs.writeFileSync(abs, updated, 'utf-8');
  scheduleRepoMemoryAutoUpsert(relativePath);
  return `Edited ${relativePath} successfully.`;
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
  { prefix: 'node ',          description: 'Run node scripts' },
  { prefix: 'curl ',          description: 'HTTP requests' },
  { prefix: 'wget ',          description: 'Download files' },
  { prefix: 'jq ',            description: 'JSON processing' },
  { prefix: 'sed ',           description: 'Stream editing' },
  { prefix: 'awk ',           description: 'Text processing' },
  { prefix: 'xargs ',         description: 'Build and execute commands' },
  { prefix: 'env ',           description: 'Environment variables' },
  { prefix: 'printenv',       description: 'Print environment' },
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
  { prefix: 'docker ',        description: 'Docker operations' },
];

/** Patterns that are NEVER allowed — only truly catastrophic operations. */
const HARD_BLOCKED = [
  /rm\s+(-rf?|--recursive)\s+\//,  // rm -rf / (root filesystem)
  /git\s+reset\s+--hard\b/,        // destructive reset
  /git\s+clean\s+-[^\n]*f[^\n]*/, // force clean (-f / -fd / -ffdx)
  /git\s+checkout\s+--\b/,         // discard file changes
  /mkfs/,                           // format disk
  /dd\s+if=/,                       // raw disk operations
  /:\(\)\s*\{/,                     // fork bomb
  />\s*\/dev\/sd/,                  // write to block devices
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
      env: { ...process.env, NODE_ENV: 'development' },
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
    return `Error creating branch: ${err instanceof Error ? err.message : 'Unknown'}`;
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
    return `Error creating PR: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function ghMergePR(prNumber: number, commitTitle?: string): Promise<string> {
  const testResult = runTests();
  if (testResult.includes('FAIL') || testResult.includes('Command failed')) {
    return `❌ Cannot merge PR #${prNumber} — tests failed:\n${testResult.slice(0, 1000)}`;
  }

  try {
    const result = await mergePullRequest(prNumber, commitTitle);
    return `✅ ${result}`;
  } catch (err) {
    return `Error merging PR: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function ghAddComment(prNumber: number, body: string): Promise<string> {
  try {
    await addPRComment(prNumber, body);
    return `Comment added to PR #${prNumber}`;
  } catch (err) {
    return `Error adding comment: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function ghListPRs(): Promise<string> {
  try {
    const prs = await listPullRequests();
    if (prs.length === 0) return 'No open pull requests.';
    return prs.map((pr) => `#${pr.number} [${pr.head}] ${pr.title}`).join('\n');
  } catch (err) {
    return `Error listing PRs: ${err instanceof Error ? err.message : 'Unknown'}`;
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

function smokeTestAgents(agent?: string, timeoutMs = 90_000): string {
  if (!process.env.DISCORD_TEST_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) {
    return 'Smoke-test bot is not configured here. Set DISCORD_TEST_BOT_TOKEN and DISCORD_GUILD_ID to enable end-to-end Discord smoke tests.';
  }

  const safeAgent = String(agent || '').replace(/[^a-z0-9-]/gi, '').trim();
  const safeTimeout = Math.max(15_000, Math.min(timeoutMs, 180_000));
  const cmd = safeAgent
    ? `npm run discord:test:dist -- --agent=${safeAgent}`
    : 'npm run discord:test:dist';

  try {
    const output = execSync(cmd, {
      cwd: SERVER_ROOT,
      timeout: Math.max(safeTimeout * 2, 120_000),
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      env: { ...process.env, DISCORD_TEST_TIMEOUT_MS: String(safeTimeout), CI: 'true' },
      shell: '/bin/sh',
    }).trim();

    return output.length > 4000
      ? '... (output trimmed)\n' + output.slice(-4000)
      : output || 'Smoke test completed with no output.';
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = `${execErr.stdout || ''}\n${execErr.stderr || ''}`.trim();
    return `Smoke test finished with failures:\n${(output || execErr.message || 'Unknown error').slice(-4000)}`;
  }
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}


function requireGuild(): Guild {
  if (!discordGuild) throw new Error('Discord guild not available');
  return discordGuild;
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

  if (agentId && agentChannelResolver) {
    const resolved = agentChannelResolver(agentId);
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
    const ownAgentChannel = agentChannelResolver ? agentChannelResolver(normalizedAgentId) : null;
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
    const msg = err instanceof Error ? err.message : String(err || 'Unknown');
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
    return `GitHub search error: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}


function runTypecheck(target: 'client' | 'server' | 'both'): string {
  const results: string[] = [];

  if (target === 'client' || target === 'both') {
    try {
      execSync('npx tsc --noEmit', {
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
      execSync('npx tsc --noEmit', {
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


const GCP_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.GCS_PROJECT_ID ||
  'asap-489910';
const GCP_REGION = process.env.CLOUD_RUN_REGION || 'australia-southeast1';
const GCP_SERVICE = process.env.CLOUD_RUN_SERVICE || 'asap';
const GCP_TIMEOUT = 120_000;

function gcpExec(cmd: string): string {
  try {
    return execSync(cmd, {
      cwd: REPO_ROOT,
      timeout: GCP_TIMEOUT,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      env: { ...process.env },
      shell: '/bin/sh',
    }).trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error((e.stderr || e.stdout || e.message || 'Command failed').trim().slice(0, 2000));
  }
}

async function gcpDeploy(tag?: string): Promise<string> {
  const built = await gcpBuildImage(tag);
  if (!built.startsWith('✅')) return built;
  const imageMatch = built.match(/Image:\s*(\S+)/);
  const imageRef = imageMatch?.[1];
  if (!imageRef) return `❌ Deploy failed: built image reference was not returned.`;

  try {
    gcpExec(
      `gcloud run deploy ${GCP_SERVICE} --image=${imageRef} --project=${GCP_PROJECT} --region=${GCP_REGION} --platform=managed --quiet`
    );
    const status = gcpExec(
      `gcloud run services describe ${GCP_SERVICE} --region=${GCP_REGION} --project=${GCP_PROJECT} --format="yaml(status.url,status.latestReadyRevisionName,status.traffic)"`
    );
    return `✅ Deployed ${imageRef} to Cloud Run service ${GCP_SERVICE}.\n\n${status}`;
  } catch (err) {
    return `❌ Deploy failed after image build (${imageRef}): ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpBuildImage(tag?: string): Promise<string> {
  const nowTag = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const safeTag = tag ? tag.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 50) : `agent-${nowTag}`;
  const imageRef = `gcr.io/${GCP_PROJECT}/${GCP_SERVICE}:${safeTag}`;

  try {
    const result = gcpExec(
      `gcloud builds submit --project=${GCP_PROJECT} --region=${GCP_REGION} --tag=${imageRef} --timeout=600`
    );
    return `✅ Built and pushed image.\nImage: ${imageRef}\n\n${result.slice(-1000)}`;
  } catch (err) {
    return `❌ Image build failed: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpPreflight(): Promise<string> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const runCheck = (name: string, cmd: string, required = true) => {
    try {
      const out = gcpExec(cmd);
      checks.push({ name, ok: true, detail: out.split('\n')[0] || 'ok' });
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : 'Unknown error';
      checks.push({ name, ok: !required, detail: required ? detail : `Optional check failed: ${detail}` });
    }
  };

  runCheck('gcloud available', 'gcloud --version');
  runCheck('active project', 'gcloud config get-value project');
  runCheck('authenticated account', 'gcloud auth list --filter=status:ACTIVE --format="value(account)"');
  runCheck('Cloud Run API', `gcloud services list --enabled --project=${GCP_PROJECT} --filter="name:run.googleapis.com" --format="value(name)"`);
  runCheck('Cloud Build API', `gcloud services list --enabled --project=${GCP_PROJECT} --filter="name:cloudbuild.googleapis.com" --format="value(name)"`);
  runCheck('Secret Manager API', `gcloud services list --enabled --project=${GCP_PROJECT} --filter="name:secretmanager.googleapis.com" --format="value(name)"`);
  runCheck('Cloud Run service', `gcloud run services describe ${GCP_SERVICE} --project=${GCP_PROJECT} --region=${GCP_REGION} --format="value(status.url)"`);

  const failed = checks.filter((c) => !c.ok);
  const lines = checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail || 'ok'}`);
  lines.unshift(`Project: ${GCP_PROJECT} | Region: ${GCP_REGION} | Service: ${GCP_SERVICE}`);
  lines.unshift(failed.length === 0 ? '✅ GCP preflight passed.' : `❌ GCP preflight failed (${failed.length} check${failed.length === 1 ? '' : 's'}).`);
  return lines.join('\n');
}

async function gcpSetEnv(variables: string): Promise<string> {
  const safeVars = variables
    .split(',')
    .map(v => v.trim())
    .filter(v => /^[A-Z_][A-Z0-9_]*=.+$/.test(v))
    .join(',');
  if (!safeVars) return 'Invalid format. Use KEY=VALUE pairs separated by commas.';

  try {
    execFileSync('gcloud', [
      'run', 'services', 'update', GCP_SERVICE,
      `--project=${GCP_PROJECT}`,
      `--region=${GCP_REGION}`,
      `--update-env-vars=${safeVars}`,
    ], {
      cwd: REPO_ROOT,
      timeout: GCP_TIMEOUT,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      env: { ...process.env },
    }).trim();
    return `✅ Environment variables updated: ${safeVars.replace(/=.*/g, '=***').split(',').join(', ')}`;
  } catch (err) {
    return `❌ Failed to update env vars: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpGetEnv(): Promise<string> {
  try {
    const result = gcpExec(
      `gcloud run services describe ${GCP_SERVICE} --project=${GCP_PROJECT} --region=${GCP_REGION} --format="yaml(spec.template.spec.containers[0].env)"`
    );
    return result || 'No environment variables set.';
  } catch (err) {
    return `❌ Failed to get env vars: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpListRevisions(limit: number): Promise<string> {
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  try {
    const result = gcpExec(
      `gcloud run revisions list --service=${GCP_SERVICE} --project=${GCP_PROJECT} --region=${GCP_REGION} --limit=${safeLimit} --format="table(name,active,creationTimestamp.date(),status.conditions[0].type)"`
    );
    return result || 'No revisions found.';
  } catch (err) {
    return `❌ Failed to list revisions: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpRollback(revision: string): Promise<string> {
  const safeRevision = revision.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100);
  if (!safeRevision) return 'Invalid revision name.';

  try {
    gcpExec(
      `gcloud run services update-traffic ${GCP_SERVICE} --project=${GCP_PROJECT} --region=${GCP_REGION} --to-revisions=${safeRevision}=100`
    );
    return `✅ Rolled back to revision: ${safeRevision}`;
  } catch (err) {
    return `❌ Rollback failed: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpSecretSet(name: string, value: string): Promise<string> {
  const safeName = name.replace(/[^A-Z0-9_-]/gi, '').slice(0, 100);
  if (!safeName) return 'Invalid secret name. Use alphanumeric characters, hyphens, and underscores.';

  try {
    let exists = false;
    try {
      gcpExec(`gcloud secrets describe ${safeName} --project=${GCP_PROJECT}`);
      exists = true;
    } catch { /* doesn't exist */ }

    const args = exists
      ? ['secrets', 'versions', 'add', safeName, `--project=${GCP_PROJECT}`, '--data-file=-']
      : ['secrets', 'create', safeName, `--project=${GCP_PROJECT}`, '--data-file=-'];

    execFileSync('gcloud', args, {
      cwd: REPO_ROOT,
      timeout: GCP_TIMEOUT,
      encoding: 'utf-8',
      input: value,
    });

    return `✅ Secret "${safeName}" set successfully in Secret Manager. Bind it to Cloud Run with gcp_secret_bind if the app should consume it.`;
  } catch (err) {
    return `❌ Failed to set secret: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpSecretBind(bindings: string): Promise<string> {
  const normalized = bindings
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (normalized.length === 0) {
    return '❌ Invalid bindings. Use comma-separated ENV_VAR=SECRET_NAME[:VERSION] pairs.';
  }

  const parsed: string[] = [];
  for (const item of normalized) {
    const match = item.match(/^([A-Z_][A-Z0-9_]*)=([A-Za-z0-9_-]+)(?::([A-Za-z0-9._-]+))?$/);
    if (!match) {
      return `❌ Invalid binding "${item}". Expected ENV_VAR=SECRET_NAME[:VERSION].`;
    }
    const [, envVar, secretName, version] = match;
    parsed.push(`${envVar}=${secretName}:${version || 'latest'}`);
  }

  try {
    gcpExec(
      `gcloud run services update ${GCP_SERVICE} --project=${GCP_PROJECT} --region=${GCP_REGION} --update-secrets=${parsed.join(',')}`
    );
    return `✅ Bound ${parsed.length} secret mapping${parsed.length === 1 ? '' : 's'} to Cloud Run service ${GCP_SERVICE}: ${parsed.join(', ')}`;
  } catch (err) {
    return `❌ Failed to bind secrets: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpSecretList(): Promise<string> {
  try {
    const result = gcpExec(
      `gcloud secrets list --project=${GCP_PROJECT} --format="table(name,createTime.date(),replication.automatic)"`
    );
    return result || 'No secrets found.';
  } catch (err) {
    return `❌ Failed to list secrets: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpBuildStatus(limit: number): Promise<string> {
  const safeLimit = Math.min(Math.max(limit, 1), 20);
  try {
    const result = gcpExec(
      `gcloud builds list --project=${GCP_PROJECT} --region=${GCP_REGION} --limit=${safeLimit} --format="table(id.slice(0:8),status,createTime.date(),duration,source.storageSource.bucket)"`
    );
    return result || 'No builds found.';
  } catch (err) {
    return `❌ Failed to get build status: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

const GCP_SQL_INSTANCE = 'asap-db';
const GCP_BOT_VM = 'asap-bot-vm';
const GCP_BOT_ZONE = 'australia-southeast1-c';

/** Safe command prefixes allowed to run on the GCE VM via gcp_vm_ssh */
const VM_ALLOWED_PREFIXES = [
  'pm2 status', 'pm2 restart', 'pm2 logs', 'pm2 list',
  'git pull', 'git log', 'git status', 'git rev-parse', 'git fetch',
  'npm run build', 'npm ci', 'npm install',
  'node --version',
  'df -h', 'free -h', 'uptime', 'cat /proc/loadavg',
];

async function gcpLogsQuery(filter: string, limit: number): Promise<string> {
  const safeLimit = Math.min(Math.max(limit || 50, 1), 200);
  if (/[`$\\]/.test(filter)) return '❌ Invalid characters in filter expression.';
  try {
    const result = gcpExec(
      `gcloud logging read "${filter.replace(/"/g, '\\"')}" --project=${GCP_PROJECT} --limit=${safeLimit} --format="table(timestamp.date(),resource.type,severity,textPayload.slice(0:120))"`
    );
    return result || 'No log entries matched.';
  } catch (err) {
    return `❌ Failed to query logs: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpRunDescribe(): Promise<string> {
  try {
    const result = gcpExec(
      `gcloud run services describe ${GCP_SERVICE} --region=${GCP_REGION} --project=${GCP_PROJECT} --format="yaml(status.url,status.conditions,status.traffic,spec.template.metadata.name,spec.template.spec.containers[0].resources)"`
    );
    return result || 'No service info returned.';
  } catch (err) {
    return `❌ Failed to describe Cloud Run service: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpStorageLs(bucket: string, prefix?: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/i.test(bucket)) return '❌ Invalid bucket name.';
  if (prefix && !/^[a-zA-Z0-9_./-]+$/.test(prefix)) return '❌ Invalid prefix.';
  const path = prefix ? `gs://${bucket}/${prefix}` : `gs://${bucket}/`;
  try {
    const result = gcpExec(`gcloud storage ls "${path}"`);
    return result || 'Empty bucket or prefix.';
  } catch (err) {
    return `❌ Failed to list bucket: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpArtifactList(limit: number): Promise<string> {
  const safeLimit = Math.min(Math.max(limit || 20, 1), 100);
  try {
    const result = gcpExec(
      `gcloud artifacts docker images list ${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/asap --include-tags --limit=${safeLimit} --sort-by="~create_time" --format="table(package.basename(),tags,create_time.date())"`
    );
    return result || 'No images found.';
  } catch (err) {
    return `❌ Failed to list artifacts: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpSqlDescribe(): Promise<string> {
  try {
    const result = gcpExec(
      `gcloud sql instances describe ${GCP_SQL_INSTANCE} --project=${GCP_PROJECT} --format="table(name,state,databaseVersion,settings.tier,ipAddresses[0].ipAddress,connectionName)"`
    );
    return result || 'No SQL instance info returned.';
  } catch (err) {
    return `❌ Failed to describe Cloud SQL: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpVmSsh(command: string): Promise<string> {
  const trimmed = command.trim();
  const allowed = VM_ALLOWED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  if (!allowed) {
    return `❌ Command not in VM allowlist. Allowed: pm2 status/restart/logs/list, git pull/log/status/rev-parse/fetch, npm run build/ci/install, node --version, df -h, free -h, uptime.`;
  }
  if (/[;&|`$<>()\n\\]/.test(trimmed)) {
    return '❌ Command contains disallowed characters.';
  }
  try {
    const escaped = trimmed.replace(/"/g, '\\"');
    const result = gcpExec(
      `gcloud compute ssh ${GCP_BOT_VM} --zone=${GCP_BOT_ZONE} --project=${GCP_PROJECT} --quiet --command="${escaped}"`
    );
    return result || '(no output)';
  } catch (err) {
    return `❌ SSH command failed: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpProjectInfo(): Promise<string> {
  try {
    const info = gcpExec(
      `gcloud projects describe ${GCP_PROJECT} --format="yaml(name,projectId,projectNumber,lifecycleState)"`
    );
    const apis = gcpExec(
      `gcloud services list --enabled --project=${GCP_PROJECT} --format="table(name,title)" --limit=60`
    );
    return `## Project\n${info}\n\n## Enabled APIs\n${apis}`;
  } catch (err) {
    return `❌ Failed to get project info: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}


function fetchUrl(url: string, method?: string, headersStr?: string, body?: string): Promise<string> {
  const MAX_REDIRECTS = 5;

  /** Block SSRF — reject private, loopback, link-local, and metadata IPs */
  function isBlockedHostname(hostname: string): boolean {
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return true;
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 0) return true;
      if (a === 169 && b === 254) return true; // link-local
    }
    return false;
  }

  function doFetch(targetUrl: string, redirectCount: number): Promise<string> {
    return new Promise((resolve) => {
      if (!targetUrl || (!targetUrl.startsWith('https://') && !targetUrl.startsWith('http://'))) {
        resolve('Error: URL must start with https:// or http://');
        return;
      }

      const httpMethod = (method || 'GET').toUpperCase();
      let parsedHeaders: Record<string, string> = {};
      if (headersStr) {
        try { parsedHeaders = JSON.parse(headersStr); } catch { /* ignore */ }
      }

      const parsedUrl = new URL(targetUrl);

      if (isBlockedHostname(parsedUrl.hostname)) {
        resolve('Error: Access to internal/private addresses is not allowed.');
        return;
      }
      const lib = parsedUrl.protocol === 'https:' ? https : http;

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
          res.resume(); // drain the response
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
    const pool = (await import('../db/pool')).default;
    const { rows } = await pool.query('SELECT content FROM agent_memory WHERE file_name = $1', [name]);
    if (rows.length === 0) {
      return `Memory file "${file}" does not exist. Use memory_list to see available files, or memory_write to create one.`;
    }
    return rows[0].content;
  } catch (err) {
    return `Error reading memory: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function memoryWrite(file: string, content: string): Promise<string> {
  try {
    const name = safeMemoryName(file);
    const pool = (await import('../db/pool')).default;
    await pool.query(
      `INSERT INTO agent_memory (file_name, content, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (file_name) DO UPDATE SET content = $2, updated_at = NOW()`,
      [name, content]
    );
    return `Memory saved to "${file}" (${content.length} bytes)`;
  } catch (err) {
    return `Error writing memory: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function memoryAppend(file: string, content: string): Promise<string> {
  try {
    const name = safeMemoryName(file);
    const pool = (await import('../db/pool')).default;
    const { rows } = await pool.query(
      `INSERT INTO agent_memory (file_name, content, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (file_name) DO UPDATE SET content = agent_memory.content || E'\\n' || $2, updated_at = NOW()
       RETURNING length(content) AS total_len`,
      [name, content]
    );
    const totalLen = rows[0]?.total_len || content.length;
    return `Appended to "${file}" (now ${totalLen} bytes)`;
  } catch (err) {
    return `Error appending to memory: ${err instanceof Error ? err.message : 'Unknown'}`;
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
    return `Error listing memory: ${err instanceof Error ? err.message : 'Unknown'}`;
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

async function repoMemoryIndex(modeRaw?: string, maxFilesRaw?: number): Promise<string> {
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


async function dbQuery(query: string, paramsStr?: string): Promise<string> {
  try {
    const pool = (await import('../db/pool')).default;
    let params: any[] = [];
    if (paramsStr) {
      try { params = JSON.parse(paramsStr); } catch { return 'Error: params must be a valid JSON array'; }
    }

    const result = await pool.query(query, params);

    if (result.command === 'SELECT' || result.rows?.length > 0) {
      const rows = result.rows || [];
      if (rows.length === 0) return 'Query returned 0 rows.';

      const cols = Object.keys(rows[0]);
      const header = cols.join(' | ');
      const separator = cols.map(() => '---').join(' | ');
      const body = rows.slice(0, 100).map((row: Record<string, any>) =>
        cols.map((c) => {
          const val = row[c];
          if (val === null) return 'NULL';
          if (typeof val === 'object') return JSON.stringify(val).slice(0, 100);
          return String(val).slice(0, 100);
        }).join(' | ')
      ).join('\n');

      const output = `${header}\n${separator}\n${body}`;
      const extra = rows.length > 100 ? `\n\n... and ${rows.length - 100} more rows` : '';
      return `${rows.length} row(s) returned:\n\n${output}${extra}`;
    }

    return `Query executed: ${result.command} — ${result.rowCount ?? 0} row(s) affected.`;
  } catch (err) {
    return `SQL Error: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

function sanitizeSql(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}

function isReadOnlySql(sql: string): boolean {
  const cleaned = sanitizeSql(sql).replace(/;\s*$/, '').trim().toLowerCase();
  if (!cleaned) return false;

  if (cleaned.includes(';')) return false;

  if (/^(select|with|explain|show)\b/.test(cleaned)) {
    if (/\b(insert|update|delete|alter|drop|create|truncate|grant|revoke|comment|vacuum|analyze|refresh|reindex|call|do|copy)\b/.test(cleaned)) {
      return false;
    }
    return true;
  }
  return false;
}

async function dbQueryReadonly(query: string, paramsStr?: string): Promise<string> {
  if (!isReadOnlySql(query)) {
    return 'Blocked: db_query_readonly only allows single-statement SELECT/WITH/EXPLAIN/SHOW queries with no write/mutation keywords.';
  }
  return dbQuery(query, paramsStr);
}

async function dbSchema(table?: string): Promise<string> {
  try {
    const cacheKey = String(table || '__all__').toLowerCase();
    const cached = dbSchemaCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return `${cached.result}\n\n(cache: hit)`;
    }

    const pool = (await import('../db/pool')).default;

    if (table) {
      const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '');
      const { rows } = await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`, [safeTable]
      );
      if (rows.length === 0) return `Table "${safeTable}" not found.`;

      const { rows: constraints } = await pool.query(
        `SELECT tc.constraint_type, kcu.column_name, ccu.table_name AS references_table, ccu.column_name AS references_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
         LEFT JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.constraint_type = 'FOREIGN KEY'
         WHERE tc.table_schema = 'public' AND tc.table_name = $1`, [safeTable]
      );

      const lines = rows.map((r: any) => {
        const nullable = r.is_nullable === 'YES' ? ' (nullable)' : '';
        const def = r.column_default ? ` default=${r.column_default}` : '';
        const constraint = constraints.find((c: any) => c.column_name === r.column_name);
        const cstr = constraint ? ` [${constraint.constraint_type}${constraint.references_table ? ` → ${constraint.references_table}.${constraint.references_column}` : ''}]` : '';
        return `  ${r.column_name}: ${r.data_type}${nullable}${def}${cstr}`;
      });

      const result = `Table: ${safeTable}\n${lines.join('\n')}`;
      dbSchemaCache.set(cacheKey, { result, expiresAt: Date.now() + DB_SCHEMA_CACHE_TTL_MS });
      return result;
    }

    const { rows } = await pool.query(
      `SELECT table_name, (SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS columns
       FROM information_schema.tables t
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );
    if (rows.length === 0) return 'No tables found in public schema.';
    const result = rows.map((r: any) => `📋 ${r.table_name} (${r.columns} columns)`).join('\n');
    dbSchemaCache.set(cacheKey, { result, expiresAt: Date.now() + DB_SCHEMA_CACHE_TTL_MS });
    return result;
  } catch (err) {
    return `Schema error: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}
