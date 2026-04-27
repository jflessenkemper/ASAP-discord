/**
 * Deterministic code-health lint tests.
 *
 * These enforce the helper extraction rules documented in .github/HELPER_PATTERNS.md.
 * Unlike LLM-based smoke tests, these are exact counts that fail CI if drift occurs.
 */
import { execSync } from 'child_process';
import path from 'path';

const SRC = path.resolve(__dirname, '../../');

function grepLines(pattern: string, dir: string): string[] {
  try {
    const result = execSync(
      `grep -rn '${pattern}' '${dir}' --include='*.ts'`,
      { encoding: 'utf-8', timeout: 10_000 }
    );
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function filterLines(lines: string[], excludePatterns: string[]): string[] {
  return lines.filter(line =>
    !excludePatterns.some(p => line.includes(p))
  );
}

describe('Code Health Lint', () => {
  test('raw "err instanceof Error" occurrences stay within limit (max 40)', () => {
    // Only count in src/, exclude test files and the errMsg helper itself
    const lines = grepLines('err instanceof Error', SRC);
    const filtered = filterLines(lines, ['__tests__/', 'utils/errors.ts', 'test-definitions.ts']);
    expect(filtered.length).toBeLessThanOrEqual(40);
  });

  test('no raw INSERT INTO agent_memory outside allowed files', () => {
    const lines = grepLines('INSERT INTO agent_memory', SRC);
    // Allowed: memory.ts (helpers), tools.ts (tool-backed persistence),
    // agents.ts (dynamic agent persistence), test files
    const filtered = filterLines(lines, [
      'memory.ts', 'tools.ts', 'agents.ts', '__tests__/'
    ]);
    expect(filtered.length).toBe(0);
  });

  test('no hardcoded fallback secrets in index.ts', () => {
    const lines = grepLines('asap-debug', path.join(SRC, 'index.ts'));
    expect(lines.length).toBe(0);
  });

  test('typecheck uses node_modules/.bin/tsc, not npx tsc', () => {
    const lines = grepLines('npx tsc --noEmit', path.join(SRC, 'discord/tools.ts'));
    expect(lines.length).toBe(0);
  });

  test('db_query blocks DDL statements', () => {
    const lines = grepLines('DDL_PATTERN', path.join(SRC, 'discord/tools.ts'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});
