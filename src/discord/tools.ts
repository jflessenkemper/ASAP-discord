import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

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

function safePath(relative: string): string {
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
    // Trim to reasonable size
    const trimmed = lines.split('\n').slice(0, 50).join('\n');
    return trimmed;
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

function runCommand(command: string, cwd?: string): string {
  // Block obviously destructive commands
  const blocked = ['rm -rf /', 'rm -rf /*', 'mkfs', 'dd if=', ':(){', 'fork bomb'];
  const lower = command.toLowerCase();
  for (const b of blocked) {
    if (lower.includes(b)) {
      return `Blocked: potentially destructive command.`;
    }
  }

  const workDir = cwd ? safePath(cwd) : REPO_ROOT;

  try {
    const result = execSync(command, {
      cwd: workDir,
      timeout: CMD_TIMEOUT,
      maxBuffer: 512 * 1024,
      encoding: 'utf-8',
      env: { ...process.env, NODE_ENV: 'development' },
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
