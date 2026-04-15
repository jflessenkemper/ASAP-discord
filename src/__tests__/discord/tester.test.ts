/**
 * Tests for src/discord/tester.ts
 * Pure function unit tests for the smoke test engine internals.
 */

// Mock heavy deps so tester.ts can be imported without Discord/dotenv/fs side-effects
jest.mock('dotenv/config', () => ({}));
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, existsSync: actual.existsSync, readFileSync: actual.readFileSync };
});
jest.mock('discord.js', () => ({
  Client: jest.fn(),
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 3 },
  ChannelType: { GuildText: 0 },
  Events: {},
  Partials: {},
}));
jest.mock('../../discord/agents', () => ({
  getAgent: jest.fn((id: string) => ({
    id, name: `Agent ${id}`, handle: id, systemPrompt: '',
    aliases: [], channelName: '', emoji: '', color: 0, voice: '', avatarUrl: '', roleName: '',
  })),
  getAgentAliases: jest.fn(() => []),
  resolveAgentId: jest.fn((id: string) => id),
}));
jest.mock('../../discord/setup', () => ({
  setupChannels: jest.fn(),
}));

import {
  categorizeFailure,
  validateReplyShape,
  makeToken,
  buildPrompt,
  normalizeRoleLabel,
  buildReadinessSummary,
  suggestFix,
  type FailureCategory,
  type TestResult,
  type ExtraCheckResult,
} from '../../discord/tester';
import type { AgentCapabilityTest, Category } from '../../discord/test-definitions';

// ── categorizeFailure ──────────────────────────────────────────────────

describe('categorizeFailure', () => {
  it('returns TIMEOUT for undefined reason', () => {
    expect(categorizeFailure()).toBe('TIMEOUT');
    expect(categorizeFailure(undefined)).toBe('TIMEOUT');
  });

  it('returns TIMEOUT for idle timeout', () => {
    expect(categorizeFailure('idle timeout: no replies')).toBe('TIMEOUT');
  });

  it('returns TIMEOUT for hard ceiling', () => {
    expect(categorizeFailure('hard ceiling reached after 120s')).toBe('TIMEOUT');
  });

  it('returns TIMEOUT for generic timed out', () => {
    expect(categorizeFailure('request timed out waiting for reply')).toBe('TIMEOUT');
  });

  it('returns TOKEN_ECHO_MISSING', () => {
    expect(categorizeFailure('missing token echo')).toBe('TOKEN_ECHO_MISSING');
  });

  it('returns TOOL_AUDIT_MISSING', () => {
    expect(categorizeFailure('missing tool-audit evidence for read_file')).toBe('TOOL_AUDIT_MISSING');
  });

  it('returns PATTERN_MISMATCH for expected pattern', () => {
    expect(categorizeFailure('missing expected pattern /foo/i')).toBe('PATTERN_MISMATCH');
  });

  it('returns PATTERN_MISMATCH for any-of expected patterns', () => {
    expect(categorizeFailure('missing any-of expected patterns')).toBe('PATTERN_MISMATCH');
  });

  it('returns SEND_FAILED', () => {
    expect(categorizeFailure('send failed: HTTP 403')).toBe('SEND_FAILED');
  });

  it('returns BOT_UNAVAILABLE', () => {
    expect(categorizeFailure('expected at least 2 bot/webhook replies')).toBe('BOT_UNAVAILABLE');
  });

  it('returns QUALITY_CHECK_FAILED', () => {
    expect(categorizeFailure('capacity or limit error')).toBe('QUALITY_CHECK_FAILED');
  });

  it('returns PATTERN_MISMATCH for unknown reason', () => {
    expect(categorizeFailure('something else happened')).toBe('PATTERN_MISMATCH');
  });

  it('prioritizes TIMEOUT over pattern when both present', () => {
    // When a test times out but also has pattern info in the reason
    expect(categorizeFailure('idle timeout: missing expected pattern /foo/i')).toBe('TIMEOUT');
    expect(categorizeFailure('hard ceiling: missing tool-audit evidence')).toBe('TIMEOUT');
  });
});

// ── makeToken ──────────────────────────────────────────────────────────

describe('makeToken', () => {
  it('creates SMOKE_ prefixed token', () => {
    const token = makeToken('developer', 'evidence-format-contract');
    expect(token).toMatch(/^SMOKE_/);
  });

  it('includes sanitized agent ID and capability', () => {
    const token = makeToken('developer', 'code-review');
    expect(token).toMatch(/^SMOKE_DEVELOPE_CODEREVI_\d{6}$/);
  });

  it('handles special characters in agent ID', () => {
    const token = makeToken('executive-assistant', 'routing-and-next-step');
    expect(token).toMatch(/^SMOKE_/);
    // Hyphens are stripped
    expect(token).not.toContain('-');
  });

  it('uses fallback for empty values', () => {
    const token = makeToken('', '');
    expect(token).toMatch(/^SMOKE_AGENT_CAP_\d{6}$/);
  });

  it('truncates to 8 chars per segment', () => {
    const token = makeToken('executive-assistant', 'very-long-capability-name');
    const parts = token.split('_');
    // SMOKE + left + right + timestamp
    expect(parts[1].length).toBeLessThanOrEqual(8);
    expect(parts[2].length).toBeLessThanOrEqual(8);
  });

  it('ends with 6-digit timestamp suffix', () => {
    const token = makeToken('qa', 'test');
    expect(token).toMatch(/_\d{6}$/);
  });
});

// ── buildPrompt ────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  it('includes mention, capability tag, prompt, and token', () => {
    const test: AgentCapabilityTest = {
      id: 'developer',
      category: 'core',
      capability: 'test-cap',
      prompt: 'Do the thing.',
      expectAny: [/thing/i],
    };
    const result = buildPrompt(test, '<@&123>', 'SMOKE_TOKEN_123456');
    expect(result).toContain('<@&123>');
    expect(result).toContain('[smoke test:test-cap]');
    expect(result).toContain('Do the thing.');
    expect(result).toContain('SMOKE_TOKEN_123456');
  });

  it('includes token echo instruction', () => {
    const test: AgentCapabilityTest = {
      id: 'qa',
      category: 'specialist',
      capability: 'regression',
      prompt: 'Name a test.',
      expectAny: [/test/i],
    };
    const result = buildPrompt(test, '@qa', 'TOKEN');
    expect(result).toContain('Include this exact token in your reply: TOKEN');
  });
});

// ── normalizeRoleLabel ─────────────────────────────────────────────────

describe('normalizeRoleLabel', () => {
  it('lowercases and strips non-alphanumeric', () => {
    expect(normalizeRoleLabel('Riley (Executive Assistant)')).toBe('riley');
  });

  it('strips parenthetical content', () => {
    expect(normalizeRoleLabel('Ace (Developer)')).toBe('ace');
  });

  it('handles empty string', () => {
    expect(normalizeRoleLabel('')).toBe('');
  });

  it('handles null-ish input', () => {
    expect(normalizeRoleLabel(undefined as any)).toBe('');
    expect(normalizeRoleLabel(null as any)).toBe('');
  });

  it('collapses spaces and hyphens', () => {
    expect(normalizeRoleLabel('security-auditor')).toBe('securityauditor');
  });

  it('handles emoji prefixed labels', () => {
    expect(normalizeRoleLabel('🤖 Bot Name')).toBe('botname');
  });
});

// ── validateReplyShape ─────────────────────────────────────────────────

describe('validateReplyShape', () => {
  const makeTest = (overrides: Partial<AgentCapabilityTest> = {}): AgentCapabilityTest => ({
    id: 'developer',
    category: 'core',
    capability: 'test',
    prompt: 'test prompt',
    ...overrides,
  });

  it('passes with matching expectAny', () => {
    const test = makeTest({ expectAny: [/hello/i, /world/i] });
    const result = validateReplyShape(test, 'Hello there', 'TOKEN');
    expect(result.ok).toBe(true);
  });

  it('fails when no expectAny matches', () => {
    const test = makeTest({ expectAny: [/unicorn/i] });
    const result = validateReplyShape(test, 'No match here', 'TOKEN');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('missing any-of expected patterns');
  });

  it('passes when all expectAll patterns match', () => {
    const test = makeTest({ expectAll: [/hello/i, /world/i] });
    const result = validateReplyShape(test, 'Hello world', 'TOKEN');
    expect(result.ok).toBe(true);
  });

  it('fails when one expectAll pattern missing', () => {
    const test = makeTest({ expectAll: [/hello/i, /world/i] });
    const result = validateReplyShape(test, 'Hello there', 'TOKEN');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('missing expected pattern');
  });

  it('passes when expectNone patterns do not match', () => {
    const test = makeTest({ expectAny: [/good/i], expectNone: [/bad/i] });
    const result = validateReplyShape(test, 'This is good', 'TOKEN');
    expect(result.ok).toBe(true);
  });

  it('fails when expectNone pattern matches', () => {
    const test = makeTest({ expectAny: [/good/i], expectNone: [/bad/i] });
    const result = validateReplyShape(test, 'Good and bad', 'TOKEN');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('matched forbidden pattern');
  });

  it('passes without token echo when requireTokenEcho is undefined', () => {
    const test = makeTest({ expectAny: [/hello/i] });
    const result = validateReplyShape(test, 'Hello', 'TOKEN_ABC');
    expect(result.ok).toBe(true);
  });

  it('fails when requireTokenEcho=true and token missing', () => {
    const test = makeTest({ expectAny: [/hello/i], requireTokenEcho: true });
    const result = validateReplyShape(test, 'Hello', 'TOKEN_ABC');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('missing token echo');
  });

  it('passes when requireTokenEcho=true and token present', () => {
    const test = makeTest({ expectAny: [/hello/i], requireTokenEcho: true });
    const result = validateReplyShape(test, 'Hello TOKEN_ABC', 'TOKEN_ABC');
    expect(result.ok).toBe(true);
  });

  it('strips markdown before pattern matching', () => {
    const test = makeTest({ expectAny: [/result/i] });
    // Text wrapped in markdown bold
    const result = validateReplyShape(test, '**Result**: done', 'TOKEN');
    expect(result.ok).toBe(true);
  });

  it('strips code blocks before pattern matching', () => {
    const test = makeTest({ expectAny: [/setupChannels/i] });
    const result = validateReplyShape(test, '```ts\nsetupChannels()\n```', 'TOKEN');
    // After stripping code blocks, the text is gone — test against raw text too
    expect(result.ok).toBe(true);
  });

  it('passes with empty expectAny array (no assertion)', () => {
    const test = makeTest({ expectAny: [] });
    const result = validateReplyShape(test, 'anything', 'TOKEN');
    expect(result.ok).toBe(true);
  });

  it('passes with no pattern fields at all', () => {
    const test = makeTest({});
    const result = validateReplyShape(test, 'anything', 'TOKEN');
    expect(result.ok).toBe(true);
  });

  it('handles combined expectAll and expectAny', () => {
    const test = makeTest({
      expectAll: [/auth/i, /security/i],
      expectAny: [/review|audit/i],
    });
    const result = validateReplyShape(test, 'Auth security review complete', 'TOKEN');
    expect(result.ok).toBe(true);
  });

  it('fails combined when expectAll fails even if expectAny passes', () => {
    const test = makeTest({
      expectAll: [/auth/i, /security/i],
      expectAny: [/review/i],
    });
    const result = validateReplyShape(test, 'Auth review complete', 'TOKEN');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('missing expected pattern');
  });
});

// ── buildReadinessSummary ──────────────────────────────────────────────

describe('buildReadinessSummary', () => {
  const makeResult = (overrides: Partial<TestResult> = {}): TestResult => ({
    agent: 'Riley',
    capability: 'test',
    category: 'core',
    passed: true,
    elapsed: 1000,
    snippet: 'ok',
    ...overrides,
  });

  it('returns score, criticalPassed, and detail', () => {
    const results = [makeResult()];
    const summary = buildReadinessSummary(results, []);
    expect(typeof summary.score).toBe('number');
    expect(typeof summary.criticalPassed).toBe('boolean');
    expect(typeof summary.detail).toBe('string');
  });

  it('returns 100% score when all pass', () => {
    const categories: Category[] = ['core', 'specialist', 'tool-proof', 'orchestration', 'upgrades', 'memory', 'ux', 'self-improvement', 'infrastructure', 'discord-management'];
    const results = categories.map((cat) => makeResult({ category: cat }));
    const summary = buildReadinessSummary(results, []);
    expect(summary.score).toBe(100);
    expect(summary.criticalPassed).toBe(true);
  });

  it('returns criticalPassed=false when core test fails', () => {
    const results = [makeResult({ category: 'core', passed: false })];
    const summary = buildReadinessSummary(results, []);
    expect(summary.criticalPassed).toBe(false);
  });

  it('returns criticalPassed=false when orchestration test fails', () => {
    const results = [makeResult({ category: 'orchestration', passed: false })];
    const summary = buildReadinessSummary(results, []);
    expect(summary.criticalPassed).toBe(false);
  });

  it('returns criticalPassed=false when upgrades test fails', () => {
    const results = [makeResult({ category: 'upgrades', passed: false })];
    const summary = buildReadinessSummary(results, []);
    expect(summary.criticalPassed).toBe(false);
  });

  it('returns criticalPassed=false with critical extra check failure', () => {
    const results = [makeResult()];
    const extras: ExtraCheckResult[] = [
      { name: 'elevenlabs_api', passed: false, detail: 'key missing', critical: true },
    ];
    const summary = buildReadinessSummary(results, extras);
    expect(summary.criticalPassed).toBe(false);
  });

  it('criticalPassed ignores non-critical extra failures', () => {
    const results = [makeResult()];
    const extras: ExtraCheckResult[] = [
      { name: 'voice_bridge', passed: false, detail: 'no call', critical: false },
    ];
    const summary = buildReadinessSummary(results, extras);
    expect(summary.criticalPassed).toBe(true);
  });

  it('criticalPassed ignores non-critical test failures (critical=false)', () => {
    const results = [makeResult({ category: 'core', passed: false, critical: false })];
    const summary = buildReadinessSummary(results, []);
    expect(summary.criticalPassed).toBe(true);
  });

  it('score is 0 when all tests fail', () => {
    const categories: Category[] = ['core', 'specialist', 'tool-proof', 'orchestration', 'upgrades', 'memory', 'ux', 'self-improvement', 'infrastructure', 'discord-management'];
    const results = categories.map((cat) => makeResult({ category: cat, passed: false }));
    const summary = buildReadinessSummary(results, []);
    expect(summary.score).toBe(0);
  });

  it('uses matrix weights when profile is matrix', () => {
    const results = [
      makeResult({ category: 'core', passed: true }),
      makeResult({ category: 'specialist', passed: false }),
    ];
    const full = buildReadinessSummary(results, [], 'full');
    const matrix = buildReadinessSummary(results, [], 'matrix');
    // Different weights produce different scores
    expect(full.score).not.toBe(matrix.score);
  });

  it('handles empty results', () => {
    const summary = buildReadinessSummary([], []);
    expect(summary.score).toBe(0);
    expect(summary.criticalPassed).toBe(true);
  });

  it('detail includes failure counts', () => {
    const results = [
      makeResult({ category: 'core', passed: false }),
      makeResult({ category: 'core', passed: false }),
    ];
    const summary = buildReadinessSummary(results, []);
    expect(summary.detail).toContain('core_fail=2');
  });
});

// ── suggestFix ─────────────────────────────────────────────────────────

describe('suggestFix', () => {
  const makeResult = (overrides: Partial<TestResult> = {}): TestResult => ({
    agent: 'Riley',
    capability: 'test',
    category: 'core',
    passed: false,
    elapsed: 1000,
    snippet: 'some snippet',
    ...overrides,
  });

  it('suggests broadening regex for PATTERN_MISMATCH', () => {
    const result = makeResult({ failureCategory: 'PATTERN_MISMATCH' });
    const fix = suggestFix(result);
    expect(fix).toContain('Broaden');
    expect(fix).toContain('expectAny');
  });

  it('suggests tool verification for TOOL_AUDIT_MISSING', () => {
    const result = makeResult({ failureCategory: 'TOOL_AUDIT_MISSING' });
    const fix = suggestFix(result);
    expect(fix).toContain('tool');
    expect(fix).toContain('agent');
  });

  it('suggests PM2 logs for TIMEOUT', () => {
    const result = makeResult({ failureCategory: 'TIMEOUT' });
    const fix = suggestFix(result);
    expect(fix).toContain('PM2');
  });

  it('suggests checking truncation for TOKEN_ECHO_MISSING', () => {
    const result = makeResult({ failureCategory: 'TOKEN_ECHO_MISSING' });
    const fix = suggestFix(result);
    expect(fix).toContain('token');
  });

  it('suggests checking bot status for BOT_UNAVAILABLE', () => {
    const result = makeResult({ failureCategory: 'BOT_UNAVAILABLE' });
    const fix = suggestFix(result);
    expect(fix).toContain('bot');
  });

  it('suggests checking quota for QUALITY_CHECK_FAILED', () => {
    const result = makeResult({ failureCategory: 'QUALITY_CHECK_FAILED' });
    const fix = suggestFix(result);
    expect(fix).toContain('quota');
  });

  it('suggests checking permissions for SEND_FAILED', () => {
    const result = makeResult({ failureCategory: 'SEND_FAILED' });
    const fix = suggestFix(result);
    expect(fix).toContain('permission');
  });

  it('handles unknown failure category', () => {
    const result = makeResult({ failureCategory: undefined });
    // Falls through to categorizeFailure which returns TIMEOUT for undefined reason
    const fix = suggestFix(result);
    expect(typeof fix).toBe('string');
    expect(fix.length).toBeGreaterThan(0);
  });
});
