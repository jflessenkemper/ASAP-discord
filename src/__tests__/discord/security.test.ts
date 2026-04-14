/**
 * Unit tests for security-critical functions in tools.ts.
 * These are the guardrails preventing SQL injection, path traversal, and DDL abuse.
 */

// Must mock pool and github before importing tools
jest.mock('../../db/pool', () => ({ default: { query: jest.fn() }, __esModule: true }));
jest.mock('../../services/github', () => ({
  createBranch: jest.fn(),
  createPullRequest: jest.fn(),
  mergePullRequest: jest.fn(),
  addPRComment: jest.fn(),
  listPullRequests: jest.fn(),
  searchGitHub: jest.fn(),
}));
jest.mock('../../services/jobSearch', () => ({}));
jest.mock('../../discord/agents', () => ({ getAgent: jest.fn() }));
jest.mock('../../discord/handlers/review', () => ({ getRequiredReviewers: jest.fn() }));
jest.mock('../../discord/handlers/groupchat', () => ({ setActiveSmokeTestRunning: jest.fn() }));
jest.mock('../../discord/services/mobileHarness', () => ({}));
jest.mock('../../discord/services/screenshots', () => ({}));
jest.mock('../../discord/services/webhooks', () => ({}));
jest.mock('../../discord/usage', () => ({ setDailyBudgetLimit: jest.fn() }));
jest.mock('../../discord/memory', () => ({
  upsertMemory: jest.fn(),
  appendMemoryRow: jest.fn(),
  readMemoryRow: jest.fn(),
}));
jest.mock('../../discord/ui/constants', () => ({
  jobScoreColor: jest.fn(),
  SYSTEM_COLORS: {},
  BUTTON_IDS: {},
}));

import { sanitizeSql, isReadOnlySql, DDL_PATTERN, safePath, BLOCKED_PATHS } from '../../discord/tools';
import path from 'path';

describe('sanitizeSql', () => {
  test('strips single-line comments', () => {
    expect(sanitizeSql('SELECT 1 -- drop table')).toBe('SELECT 1');
  });

  test('strips multi-line comments', () => {
    expect(sanitizeSql('SELECT /* DROP TABLE users */ 1')).toBe('SELECT  1');
  });

  test('strips nested comment-like patterns', () => {
    expect(sanitizeSql('SELECT 1 /* comment\nwith newlines */')).toBe('SELECT 1');
  });

  test('trims whitespace', () => {
    expect(sanitizeSql('  SELECT 1  ')).toBe('SELECT 1');
  });

  test('handles empty string', () => {
    expect(sanitizeSql('')).toBe('');
  });
});

describe('isReadOnlySql', () => {
  // ── Should PASS (read-only) ──
  test('allows simple SELECT', () => {
    expect(isReadOnlySql('SELECT * FROM users')).toBe(true);
  });

  test('allows SELECT with WHERE', () => {
    expect(isReadOnlySql('SELECT id, name FROM users WHERE id = 1')).toBe(true);
  });

  test('allows WITH (CTE) queries', () => {
    expect(isReadOnlySql('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true);
  });

  test('allows EXPLAIN', () => {
    expect(isReadOnlySql('EXPLAIN SELECT * FROM users')).toBe(true);
  });

  test('blocks EXPLAIN ANALYZE (analyze is a write keyword)', () => {
    expect(isReadOnlySql('EXPLAIN ANALYZE SELECT * FROM users')).toBe(false);
  });

  test('allows SHOW', () => {
    expect(isReadOnlySql('SHOW search_path')).toBe(true);
  });

  test('allows trailing semicolon', () => {
    expect(isReadOnlySql('SELECT 1;')).toBe(true);
  });

  // ── Should BLOCK (mutations) ──
  test('blocks INSERT', () => {
    expect(isReadOnlySql('INSERT INTO users VALUES (1)')).toBe(false);
  });

  test('blocks UPDATE', () => {
    expect(isReadOnlySql('UPDATE users SET name = $1')).toBe(false);
  });

  test('blocks DELETE', () => {
    expect(isReadOnlySql('DELETE FROM users WHERE id = 1')).toBe(false);
  });

  test('blocks DROP TABLE', () => {
    expect(isReadOnlySql('DROP TABLE users')).toBe(false);
  });

  test('blocks TRUNCATE', () => {
    expect(isReadOnlySql('TRUNCATE users')).toBe(false);
  });

  test('blocks ALTER TABLE', () => {
    expect(isReadOnlySql('ALTER TABLE users ADD COLUMN email TEXT')).toBe(false);
  });

  test('blocks CREATE TABLE', () => {
    expect(isReadOnlySql('CREATE TABLE evil (id INT)')).toBe(false);
  });

  // ── Injection attempts ──
  test('blocks SELECT with hidden INSERT', () => {
    expect(isReadOnlySql('SELECT 1; INSERT INTO users VALUES (1)')).toBe(false);
  });

  test('blocks SELECT with hidden DROP in body', () => {
    expect(isReadOnlySql('SELECT drop FROM users')).toBe(false);
  });

  test('blocks SELECT with UPDATE keyword', () => {
    expect(isReadOnlySql('SELECT * FROM users WHERE update = true')).toBe(false);
  });

  test('blocks comment-smuggled mutations', () => {
    expect(isReadOnlySql('SELECT 1 -- \n; DROP TABLE users')).toBe(false);
  });

  test('blocks empty string', () => {
    expect(isReadOnlySql('')).toBe(false);
  });

  test('blocks whitespace only', () => {
    expect(isReadOnlySql('   ')).toBe(false);
  });
});

describe('DDL_PATTERN', () => {
  test.each([
    'DROP TABLE users',
    'TRUNCATE users',
    'ALTER TABLE users ADD COLUMN x TEXT',
    'CREATE TABLE evil (id INT)',
    'GRANT ALL ON users TO hacker',
    'REVOKE SELECT ON users FROM public',
    'VACUUM users',
    'REINDEX TABLE users',
  ])('blocks DDL: %s', (sql) => {
    expect(DDL_PATTERN.test(sql)).toBe(true);
  });

  test.each([
    'SELECT * FROM users',
    'INSERT INTO users (name) VALUES ($1)',
    'UPDATE users SET name = $1',
    'DELETE FROM users WHERE id = $1',
  ])('allows DML: %s', (sql) => {
    expect(DDL_PATTERN.test(sql)).toBe(false);
  });
});

describe('safePath', () => {
  test('resolves relative path within repo', () => {
    const result = safePath('src/index.ts');
    expect(result).toContain('src/index.ts');
    expect(path.isAbsolute(result)).toBe(true);
  });

  test('blocks path traversal (..)', () => {
    expect(() => safePath('../../etc/passwd')).toThrow(/escapes repository root/i);
  });

  test('blocks absolute path outside repo', () => {
    expect(() => safePath('/etc/passwd')).toThrow(/escapes repository root/i);
  });

  test('blocks .env access', () => {
    expect(() => safePath('.env')).toThrow(/access denied/i);
  });

  test('blocks node_modules access', () => {
    expect(() => safePath('node_modules/foo/index.js')).toThrow(/access denied/i);
  });

  test('blocks .git/objects access', () => {
    expect(() => safePath('.git/objects/abc123')).toThrow(/access denied/i);
  });

  test('blocks .git/HEAD access', () => {
    expect(() => safePath('.git/HEAD')).toThrow(/access denied/i);
  });

  test('allows normal source files', () => {
    expect(() => safePath('src/discord/tools.ts')).not.toThrow();
  });

  test('allows package.json', () => {
    expect(() => safePath('package.json')).not.toThrow();
  });

  test('allows .github directory', () => {
    expect(() => safePath('.github/REPO_MAP.md')).not.toThrow();
  });

  test('BLOCKED_PATHS includes critical paths', () => {
    expect(BLOCKED_PATHS).toContain('.env');
    expect(BLOCKED_PATHS).toContain('node_modules');
    expect(BLOCKED_PATHS).toContain('.git/objects');
  });
});
