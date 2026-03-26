import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
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
  deleteBranch,
  searchGitHub,
} from '../services/github';
import { getRequiredReviewers } from './handlers/review';

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

/** Max file size agents can write (256 KB) */
const MAX_WRITE_SIZE = 256 * 1024;

/** Max command execution time (30 s) */
const CMD_TIMEOUT = 30_000;

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
      'Run a shell command in the repository root. Use for: npm scripts, TypeScript type-checking, git operations, etc. Commands run in a sandboxed context with a 30s timeout.',
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

function searchFiles(pattern: string, include?: string): string {
  // Use grep for speed. Sanitize the pattern to prevent command injection.
  const safePattern = pattern.replace(/['"\\$`!]/g, '\\$&');
  const includeArg = include ? `--include='${include.replace(/'/g, '')}'` : '--include=*.ts --include=*.tsx --include=*.js --include=*.json --include=*.sql --include=*.md';

  try {
    const result = execSync(
      `grep -rn -i -E '${safePattern}' ${includeArg} --max-count=50 . 2>/dev/null || true`,
      { cwd: REPO_ROOT, timeout: 10_000, maxBuffer: 512 * 1024, encoding: 'utf-8' }
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
  } catch {
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
  { prefix: 'git merge',     description: 'Merge branches' },
  { prefix: 'git show',      description: 'Show commit details' },
  { prefix: 'git rev-parse', description: 'Resolve refs' },
  { prefix: 'git remote',    description: 'Manage remotes' },
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
  { prefix: 'node -e', description: 'Run inline JS' },
  { prefix: 'node --eval', description: 'Run inline JS' },
];

/** Patterns that are NEVER allowed, even if they match an allowed prefix. */
const HARD_BLOCKED = [
  /rm\s+(-rf?|--recursive)\s+\//,  // rm -rf /
  /mkfs/,
  /dd\s+if=/,
  /:\(\)\s*\{/,                     // fork bomb
  />\s*\/dev\/sd/,                  // write to block devices
  /curl\s.*\|\s*(ba)?sh/,          // curl | sh (pipe to shell)
  /wget\s.*\|\s*(ba)?sh/,
  /eval\s/,                         // eval in shell
  /\$\(/,                           // command substitution (prevents bypass)
  /`[^`]+`/,                        // backtick substitution
  /;\s*(rm|mkfs|dd|curl|wget|nc|ncat|python|perl|ruby)\b/,  // chained dangerous commands
  /\|\s*(ba)?sh/,                   // piping to shell
  /&&\s*(rm|mkfs|dd|curl|wget)\b/,
  /\$\{/,                           // variable expansion (prevents ${IFS} tricks)
  /\\x[0-9a-f]{2}/i,               // hex escapes
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
    return `Blocked: ${reason}. Allowed commands: npm, npx tsc/jest, git, grep, find, cat, ls, node -e, and other read-only utilities.`;
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
  const testCmd = pattern
    ? `npm test -- --testPathPattern="${pattern.replace(/"/g, '')}"`
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

async function discordSendMessage(channelName: string, message: string): Promise<string> {
  const guild = requireGuild();

  const channel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === channelName
  ) as TextChannel | undefined;
  if (!channel) return `Channel not found: #${channelName}`;

  // Respect Discord's 2000 char limit
  const chunks = message.match(/.{1,2000}/gs) || [message];
  for (const chunk of chunks) {
    await channel.send(chunk);
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
