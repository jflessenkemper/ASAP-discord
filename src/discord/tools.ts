import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import https from 'https';
import http from 'http';
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
import { getRequiredReviewers } from './handlers/review';
import { captureAndPostScreenshots } from './services/screenshots';
import { getWebhook } from './services/webhooks';

// ────────────────────────────────────────────
// Discord guild reference — set from bot.ts
// ────────────────────────────────────────────

let discordGuild: Guild | null = null;

export function setDiscordGuild(guild: Guild): void {
  discordGuild = guild;
}

/** Channels that must never be deleted by agents */
const PROTECTED_CHANNELS = ['groupchat', 'command', 'github', 'call-log', 'limits'];

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
const REPO_ROOT = fs.existsSync('/app/server')
  ? '/app'
  : path.resolve(__dirname, '..', '..', '..');

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

// ────────────────────────────────────────────
// Path safety
// ────────────────────────────────────────────

/** Cache validated paths to avoid re-resolving. LRU-like with size cap. */
const safePathCache = new Map<string, string>();
const SAFE_PATH_CACHE_MAX = 500;

function safePath(relative: string): string {
  const cached = safePathCache.get(relative);
  if (cached) return cached;

  // Normalize and resolve to absolute
  const resolved = path.resolve(REPO_ROOT, relative);

  // Must stay inside repo root
  if (!resolved.startsWith(REPO_ROOT)) {
    throw new Error(`Path escapes repository root: ${relative}`);
  }

  // Block sensitive paths
  const rel = path.relative(REPO_ROOT, resolved);
  for (const blocked of BLOCKED_PATHS) {
    if (rel === blocked || rel.startsWith(blocked + '/') || rel.startsWith(blocked + path.sep)) {
      throw new Error(`Access denied: ${relative}`);
    }
  }

  // Cache result (evict oldest if full)
  if (safePathCache.size >= SAFE_PATH_CACHE_MAX) {
    const firstKey = safePathCache.keys().next().value;
    if (firstKey !== undefined) safePathCache.delete(firstKey);
  }
  safePathCache.set(relative, resolved);

  return resolved;
}

// ────────────────────────────────────────────
// Tool definitions for Claude tool_use
// ────────────────────────────────────────────

export const REPO_TOOLS = [
  {
    name: 'read_file',
    description:
      'Read the contents of a file in the ASAP repository. Use relative paths from the repo root (e.g. "server/src/index.ts", "components/ClientDashboard.tsx").',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path from repo root',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a file in the ASAP repository. Use relative paths. Parent directories are created automatically.',
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
      'List open pull requests on the ASAP repository.',
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
  // ── Discord management tools ──
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
      'Delete a Discord channel by name. Cannot delete protected channels (groupchat, command, github, call-log, limits). Use with caution.',
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
  // ── Observability tools ──
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
      'Capture screenshots of the live app and post them to the #screenshots Discord channel. Uses headless Chromium sized to iPhone 17 Pro Max. Takes ~15-20 seconds. Use this to visually verify deployed changes, test UI, or generate visual documentation. Screenshots are posted automatically to Discord.',
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
      },
      required: [],
    },
  },
  // ── GCP Infrastructure tools ──
  {
    name: 'gcp_deploy',
    description:
      'Trigger a Cloud Build deployment of the ASAP app to Cloud Run. This builds a Docker image and deploys it. Equivalent to `gcloud builds submit`. Use after merging PRs or pushing to main.',
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
      'Create or update a secret in GCP Secret Manager. The secret is automatically available to the Cloud Run service.',
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
  // ── Web Access ──
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
  // ── Persistent Memory ──
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
  // ── Database Access ──
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

// ────────────────────────────────────────────
// Tool execution
// ────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  input: Record<string, string>
): Promise<string> {
  try {
    switch (toolName) {
      case 'read_file':
        return readFile(input.path);
      case 'write_file':
        return writeFile(input.path, input.content);
      case 'edit_file':
        return editFile(input.path, input.old_string, input.new_string);
      case 'search_files':
        return searchFiles(input.pattern, input.include);
      case 'list_directory':
        return listDirectory(input.path);
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
        return runTests(input.test_pattern);
      // Discord management
      case 'list_channels':
        return await discordListChannels();
      case 'delete_channel':
        return await discordDeleteChannel(input.channel_name, input.reason);
      case 'create_channel':
        return await discordCreateChannel(input.channel_name, input.category, input.topic);
      case 'rename_channel':
        return await discordRenameChannel(input.old_name, input.new_name);
      case 'set_channel_topic':
        return await discordSetTopic(input.channel_name, input.topic);
      case 'send_channel_message':
        return await discordSendMessage(input.channel_name, input.message);
      case 'delete_category':
        return await discordDeleteCategory(input.category_name);
      case 'move_channel':
        return await discordMoveChannel(input.channel_name, input.category);
      case 'read_logs':
        return await readRuntimeLogs(input.severity, parseInt(input.limit, 10) || 30, input.query);
      case 'github_search':
        return await ghSearch(input.query, (input.type as 'code' | 'issues' | 'commits') || 'code');
      case 'typecheck':
        return runTypecheck((input.target as 'client' | 'server' | 'both') || 'both');
      case 'batch_edit':
        return batchEdit(input.edits as any);
      case 'capture_screenshots': {
        const url = input.url || process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
        const label = (input.label || 'tool-invoked').slice(0, 100);
        await captureAndPostScreenshots(url, label);
        return `Screenshots captured and posted to #screenshots channel. URL: ${url}`;
      }
      // GCP infrastructure tools
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
      case 'gcp_secret_list':
        return await gcpSecretList();
      case 'gcp_build_status':
        return await gcpBuildStatus(parseInt(input.limit, 10) || 5);
      // Web access
      case 'fetch_url':
        return await fetchUrl(input.url, input.method, input.headers, input.body);
      // Memory
      case 'memory_read':
        return await memoryRead(input.file);
      case 'memory_write':
        return await memoryWrite(input.file, input.content);
      case 'memory_append':
        return await memoryAppend(input.file, input.content);
      case 'memory_list':
        return await memoryList();
      // Database
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

function readFile(relativePath: string): string {
  const abs = safePath(relativePath);
  if (!fs.existsSync(abs)) {
    return `File not found: ${relativePath}`;
  }
  const stat = fs.statSync(abs);
  if (stat.size > MAX_WRITE_SIZE) {
    return `File too large (${Math.round(stat.size / 1024)} KB). Read specific sections or use search_files instead.`;
  }
  return fs.readFileSync(abs, 'utf-8');
}

function writeFile(relativePath: string, content: string): string {
  if (content.length > MAX_WRITE_SIZE) {
    return `Content too large (${Math.round(content.length / 1024)} KB). Maximum is ${MAX_WRITE_SIZE / 1024} KB.`;
  }
  const abs = safePath(relativePath);
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
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
  // Use execFileSync with argument array to prevent command injection.
  const includeArgs = include
    ? ['--include=' + include]
    : ['--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.json', '--include=*.sql', '--include=*.md'];

  try {
    const result = execFileSync(
      'grep',
      ['-rn', '-i', '-E', pattern, ...includeArgs, '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--max-count=50', '.'],
      { cwd: REPO_ROOT, timeout: 10_000, maxBuffer: 512 * 1024, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const lines = result.trim();
    if (!lines) return `No matches found for pattern: ${pattern}`;
    // Deduplicate lines (same file+line can match multiple patterns)
    const seen = new Set<string>();
    const deduped = lines.split('\n').filter((line) => {
      const key = line.split(':').slice(0, 2).join(':');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 50);
    return deduped.join('\n');
  } catch (err: unknown) {
    // grep exits with code 1 when no matches found — not an error
    const execErr = err as { status?: number; stdout?: string };
    if (execErr.status === 1) return `No matches found for pattern: ${pattern}`;
    return `Search failed for pattern: ${pattern}`;
  }
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

/**
 * Allowlist of command prefixes agents may run.
 * Everything else is blocked by default.
 */
const ALLOWED_COMMANDS: Array<{ prefix: string; description: string }> = [
  // Package management
  { prefix: 'npm ',         description: 'npm scripts and installs' },
  { prefix: 'npx tsc',      description: 'TypeScript type-checking' },
  { prefix: 'npx jest',     description: 'Run tests via jest' },
  { prefix: 'npx prettier', description: 'Code formatting' },
  { prefix: 'npx eslint',   description: 'Linting' },
  // Git (read + safe write operations)
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
  { prefix: 'git reset',      description: 'Reset HEAD/staging' },
  { prefix: 'git tag',        description: 'Manage tags' },
  { prefix: 'git blame',      description: 'Line-by-line authorship' },
  { prefix: 'git reflog',     description: 'Reference log' },
  { prefix: 'git clean',      description: 'Clean untracked files' },
  // Read-only system commands
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
  // Process & scripting
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
  { prefix: 'rm ',            description: 'Remove files (not rm -rf /)' },
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
  // GCP operations
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
  // Docker
  { prefix: 'docker ',        description: 'Docker operations' },
];

/** Patterns that are NEVER allowed — only truly catastrophic operations. */
const HARD_BLOCKED = [
  /rm\s+(-rf?|--recursive)\s+\//,  // rm -rf / (root filesystem)
  /mkfs/,                           // format disk
  /dd\s+if=/,                       // raw disk operations
  /:\(\)\s*\{/,                     // fork bomb
  />\s*\/dev\/sd/,                  // write to block devices
];

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

  // Check hard blocks first
  for (const pattern of HARD_BLOCKED) {
    if (pattern.test(trimmed)) {
      const reason = 'Hard-blocked pattern detected';
      auditCallback?.(trimmed, false, reason);
      return `Blocked: ${reason}. This command is not allowed.`;
    }
  }

  // Check allowlist
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

// ────────────────────────────────────────────
// GitHub tools
// ────────────────────────────────────────────

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

    // Get changed files for auto-review
    try {
      const diffOutput = execSync(`git diff --name-only ${base || 'main'}...${head}`, {
        cwd: REPO_ROOT, timeout: 10_000, encoding: 'utf-8',
      }).trim();
      const changedFiles = diffOutput.split('\n').filter(Boolean);

      // Check if auto-review is needed
      const reviewers = getRequiredReviewers(changedFiles);
      if (reviewers.size > 0 && prReviewCallback) {
        const diffSummary = execSync(`git diff --stat ${base || 'main'}...${head}`, {
          cwd: REPO_ROOT, timeout: 10_000, encoding: 'utf-8',
        }).trim();
        // Fire and forget — don't block PR creation
        prReviewCallback(pr.number, title, changedFiles, diffSummary).catch(() => {});
      }
    } catch {
      // Git diff might fail if branches aren't fetched locally — that's OK
    }

    return `✅ PR #${pr.number} created: ${pr.url}`;
  } catch (err) {
    return `Error creating PR: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function ghMergePR(prNumber: number, commitTitle?: string): Promise<string> {
  // Run tests first — refuse to merge if tests fail
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

// ────────────────────────────────────────────
// Test runner tool
// ────────────────────────────────────────────

function runTests(pattern?: string): string {
  // Sanitize pattern: allow only safe characters for test path patterns
  const safePattern = pattern ? pattern.replace(/[^a-zA-Z0-9_./\-*?]/g, '') : undefined;
  const testCmd = safePattern
    ? `npm test -- --testPathPattern="${safePattern}"`
    : 'npm test';

  try {
    const result = execSync(testCmd, {
      cwd: path.join(REPO_ROOT, 'server'),
      timeout: 120_000, // 2 minutes for test suite
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      env: { ...process.env, NODE_ENV: 'test', CI: 'true' },
      shell: '/bin/sh',
    });
    // Cap output to last 4000 chars to avoid flooding Claude context
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

// ────────────────────────────────────────────
// Discord management tools
// ────────────────────────────────────────────

function requireGuild(): Guild {
  if (!discordGuild) throw new Error('Discord guild not available');
  return discordGuild;
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

async function discordDeleteChannel(channelName: string, reason: string): Promise<string> {
  const guild = requireGuild();

  if (PROTECTED_CHANNELS.includes(channelName)) {
    return `Cannot delete protected channel: #${channelName}`;
  }

  const channel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === channelName
  );
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

  const channel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === channelName
  ) as TextChannel | undefined;
  if (!channel) return `Channel not found: #${channelName}`;

  await channel.setTopic(topic);
  return `Updated topic for #${channelName}`;
}

async function discordSendMessage(channelName: string, message: string, agentName?: string): Promise<string> {
  const guild = requireGuild();

  const channel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === channelName
  ) as TextChannel | undefined;
  if (!channel) return `Channel not found: #${channelName}`;

  // Respect Discord's 2000 char limit
  const chunks = message.match(/.{1,2000}/gs) || [message];
  try {
    const wh = await getWebhook(channel);
    for (const chunk of chunks) {
      await wh.send({
        content: chunk,
        username: agentName || 'ASAP Agent',
      });
    }
  } catch {
    // Fallback to bot identity if webhook fails
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }
  return `Sent message to #${channelName} (${message.length} chars)`;
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

// ────────────────────────────────────────────
// Cloud Run runtime logs
// ────────────────────────────────────────────

async function readRuntimeLogs(severity?: string, limit = 30, query?: string): Promise<string> {
  const { GoogleAuth } = await import('google-auth-library');
  const projectId = process.env.GCS_PROJECT_ID || 'asap-489910';
  const serviceName = process.env.CLOUD_RUN_SERVICE || 'asap';
  const region = process.env.CLOUD_RUN_REGION || 'australia-southeast1';

  const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/logging.read' });
  const client = await auth.getClient();

  const safeSeverity = ['DEFAULT', 'INFO', 'WARNING', 'ERROR'].includes((severity || '').toUpperCase())
    ? (severity || 'WARNING').toUpperCase()
    : 'WARNING';
  const safeLimit = Math.min(Math.max(limit, 1), 100);

  let filter = `resource.type="cloud_run_revision" AND resource.labels.service_name="${serviceName}" AND resource.labels.location="${region}" AND severity>="${safeSeverity}"`;
  if (query) {
    // Sanitize query to prevent filter injection
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

// ────────────────────────────────────────────
// GitHub search
// ────────────────────────────────────────────

async function ghSearch(query: string, type: 'code' | 'issues' | 'commits'): Promise<string> {
  try {
    return await searchGitHub(query, type);
  } catch (err) {
    return `GitHub search error: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

// ────────────────────────────────────────────
// Typecheck tool
// ────────────────────────────────────────────

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
        cwd: path.join(REPO_ROOT, 'server'),
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

// ────────────────────────────────────────────
// GCP Infrastructure tools
// ────────────────────────────────────────────

const GCP_PROJECT = process.env.GCS_PROJECT_ID || 'asap-489910';
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
  const safeTag = tag ? tag.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 50) : 'agent-deploy';
  try {
    const result = gcpExec(
      `gcloud builds submit --project=${GCP_PROJECT} --region=${GCP_REGION} --tag=gcr.io/${GCP_PROJECT}/${GCP_SERVICE}:${safeTag} --timeout=600`
    );
    return `✅ Build submitted (tag: ${safeTag})\n${result.slice(-1000)}`;
  } catch (err) {
    return `❌ Deploy failed: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

async function gcpSetEnv(variables: string): Promise<string> {
  // Validate format: KEY=VALUE pairs
  const safeVars = variables
    .split(',')
    .map(v => v.trim())
    .filter(v => /^[A-Z_][A-Z0-9_]*=.+$/.test(v))
    .join(',');
  if (!safeVars) return 'Invalid format. Use KEY=VALUE pairs separated by commas.';

  try {
    // Use execFileSync to avoid shell injection via env var values
    const result = execFileSync('gcloud', [
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
  // Validate revision name format
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
  // Validate secret name
  const safeName = name.replace(/[^A-Z0-9_-]/gi, '').slice(0, 100);
  if (!safeName) return 'Invalid secret name. Use alphanumeric characters, hyphens, and underscores.';

  try {
    // Check if secret exists
    let exists = false;
    try {
      gcpExec(`gcloud secrets describe ${safeName} --project=${GCP_PROJECT}`);
      exists = true;
    } catch { /* doesn't exist */ }

    // Use execFileSync with stdin to avoid shell injection
    const action = exists ? 'versions add' : 'create';
    const args = exists
      ? ['secrets', 'versions', 'add', safeName, `--project=${GCP_PROJECT}`, '--data-file=-']
      : ['secrets', 'create', safeName, `--project=${GCP_PROJECT}`, '--data-file=-'];

    execFileSync('gcloud', args, {
      cwd: REPO_ROOT,
      timeout: GCP_TIMEOUT,
      encoding: 'utf-8',
      input: value,
    });

    return `✅ Secret "${safeName}" set successfully.`;
  } catch (err) {
    return `❌ Failed to set secret: ${err instanceof Error ? err.message : 'Unknown'}`;
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

// ────────────────────────────────────────────
// Web fetch tool
// ────────────────────────────────────────────

function fetchUrl(url: string, method?: string, headersStr?: string, body?: string): Promise<string> {
  const MAX_REDIRECTS = 5;

  /** Block SSRF — reject private, loopback, link-local, and metadata IPs */
  function isBlockedHostname(hostname: string): boolean {
    // Block cloud metadata endpoints
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') return true;
    // Block localhost variants
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return true;
    // Block private IP ranges (10.x, 172.16-31.x, 192.168.x)
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

        // Handle redirects
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

// ────────────────────────────────────────────
// Persistent memory tools (database-backed)
// ────────────────────────────────────────────

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

// ────────────────────────────────────────────
// Database query tools
// ────────────────────────────────────────────

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

      // Format as table
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

async function dbSchema(table?: string): Promise<string> {
  try {
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

      // Also get constraints
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

      return `Table: ${safeTable}\n${lines.join('\n')}`;
    }

    // List all tables
    const { rows } = await pool.query(
      `SELECT table_name, (SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS columns
       FROM information_schema.tables t
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );
    if (rows.length === 0) return 'No tables found in public schema.';
    return rows.map((r: any) => `📋 ${r.table_name} (${r.columns} columns)`).join('\n');
  } catch (err) {
    return `Schema error: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}
