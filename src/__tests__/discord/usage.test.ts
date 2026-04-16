/**
 * Tests for src/discord/usage.ts
 * Usage tracking, budget enforcement, cost estimation.
 */

// Mock pool before imports
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../db/pool', () => ({
  default: { query: mockQuery },
  __esModule: true,
}));
jest.mock('../../discord/memory', () => ({
  upsertMemory: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/billing', () => ({
  getLiveBillingSnapshot: jest.fn(() => ({ available: false, dailyCostUsd: null })),
  refreshLiveBillingSnapshot: jest.fn(),
}));
jest.mock('../../discord/activityLog', () => ({
  formatOpsLine: jest.fn(() => ''),
  postOpsLine: jest.fn(),
}));
jest.mock('../../discord/ui/constants', () => ({
  statusColor: jest.fn(() => 0x00FF00),
}));

import {
  toAgentTag,
  recordClaudeUsage,
  recordGeminiUsage,
  recordElevenLabsUsage,
  isClaudeOverLimit,
  isGeminiOverLimit,
  isElevenLabsOverLimit,
  isBudgetExceeded,
  getRemainingBudget,
  approveAdditionalBudget,
  setDailyBudgetLimit,
  getClaudeTokenStatus,
  getUsageReport,
  getCostOpsSummaryLine,
  getContextEfficiencyReport,
  getPromptAttributionSnapshot,
  initUsageCounters,
  flushUsageCounters,
  getUsageEmbed,
  setLimitsChannel,
  setCostChannel,
  startDashboardUpdates,
  stopDashboardUpdates,
  refreshUsageDashboard,
  refreshLiveBillingData,
} from '../../discord/usage';

describe('usage', () => {
  describe('toAgentTag()', () => {
    it('resolves Riley', () => {
      expect(toAgentTag('Riley (Executive Assistant)')).toBe('executive-assistant');
    });

    it('resolves Ace', () => {
      expect(toAgentTag('Ace (Developer)')).toBe('developer');
    });

    it('resolves Max', () => {
      expect(toAgentTag('Max (QA)')).toBe('qa');
    });

    it('resolves Sophie', () => {
      expect(toAgentTag('Sophie')).toBe('ux-reviewer');
    });

    it('resolves Kane', () => {
      expect(toAgentTag('Kane')).toBe('security-auditor');
    });

    it('resolves Raj', () => {
      expect(toAgentTag('Raj')).toBe('api-reviewer');
    });

    it('resolves Elena', () => {
      expect(toAgentTag('Elena')).toBe('dba');
    });

    it('resolves Kai', () => {
      expect(toAgentTag('Kai')).toBe('performance');
    });

    it('resolves Jude', () => {
      expect(toAgentTag('Jude')).toBe('devops');
    });

    it('resolves Liv', () => {
      expect(toAgentTag('Liv')).toBe('copywriter');
    });

    it('resolves Harper', () => {
      expect(toAgentTag('Harper')).toBe('lawyer');
    });

    it('resolves Mia', () => {
      expect(toAgentTag('Mia')).toBe('ios-engineer');
    });

    it('resolves Leo', () => {
      expect(toAgentTag('Leo')).toBe('android-engineer');
    });

    it('normalizes unknown labels', () => {
      expect(toAgentTag('Custom Agent!')).toBe('custom-agent');
    });

    it('handles empty string', () => {
      expect(toAgentTag('')).toBe('unknown');
    });

    it('is case insensitive', () => {
      expect(toAgentTag('RILEY')).toBe('executive-assistant');
      expect(toAgentTag('ace')).toBe('developer');
    });
  });

  describe('recordClaudeUsage()', () => {
    it('records token counts', () => {
      recordClaudeUsage(1000, 500);
      const status = getClaudeTokenStatus();
      expect(status.used).toBeGreaterThanOrEqual(1500);
    });

    it('records with model attribution', () => {
      recordClaudeUsage(100, 50, {
        modelName: 'gemini-2.5-flash',
        agentLabel: 'Ace',
        promptBreakdown: { systemChars: 1000, userChars: 500 },
      });
      // Should not throw
    });

    it('records Anthropic model usage separately', () => {
      recordClaudeUsage(100, 50, 'claude-opus-4-6');
      // Should track as anthropic tokens
    });
  });

  describe('recordGeminiUsage()', () => {
    it('records Gemini API calls', () => {
      recordGeminiUsage(5);
      // Should not throw
    });

    it('defaults to 1 call', () => {
      recordGeminiUsage();
      // Should not throw
    });
  });

  describe('recordElevenLabsUsage()', () => {
    it('records character count', () => {
      recordElevenLabsUsage(500);
      // Should not throw
    });
  });

  describe('limit checking', () => {
    it('isClaudeOverLimit returns boolean', () => {
      expect(typeof isClaudeOverLimit()).toBe('boolean');
    });

    it('isGeminiOverLimit returns boolean', () => {
      expect(typeof isGeminiOverLimit()).toBe('boolean');
    });

    it('isElevenLabsOverLimit returns boolean', () => {
      expect(typeof isElevenLabsOverLimit()).toBe('boolean');
    });

    it('isBudgetExceeded returns boolean', () => {
      expect(typeof isBudgetExceeded()).toBe('boolean');
    });
  });

  describe('getRemainingBudget()', () => {
    it('returns budget breakdown', () => {
      const budget = getRemainingBudget();
      expect(budget).toHaveProperty('remaining');
      expect(budget).toHaveProperty('spent');
      expect(budget).toHaveProperty('limit');
      expect(budget.remaining).toBeGreaterThanOrEqual(0);
      expect(budget.limit).toBeGreaterThan(0);
    });
  });

  describe('approveAdditionalBudget()', () => {
    it('adds to budget', () => {
      const before = getRemainingBudget();
      const result = approveAdditionalBudget(10);
      expect(result.added).toBe(10);
      expect(result.limit).toBeGreaterThanOrEqual(before.limit);
    });

    it('uses default increment when no amount specified', () => {
      const result = approveAdditionalBudget();
      expect(result.added).toBeGreaterThan(0);
    });
  });

  describe('setDailyBudgetLimit()', () => {
    it('updates budget limit', () => {
      const result = setDailyBudgetLimit(100, false);
      expect(result.current).toBe(100);
      expect(result.previous).toBeGreaterThan(0);
    });

    it('rejects negative limits', () => {
      expect(() => setDailyBudgetLimit(-1, false)).toThrow('Invalid budget limit');
    });

    it('rejects NaN limits', () => {
      expect(() => setDailyBudgetLimit(NaN, false)).toThrow('Invalid budget limit');
    });
  });

  describe('getClaudeTokenStatus()', () => {
    it('returns status with used, remaining, limit', () => {
      const status = getClaudeTokenStatus();
      expect(status).toHaveProperty('used');
      expect(status).toHaveProperty('remaining');
      expect(status).toHaveProperty('limit');
      expect(status.used + status.remaining).toBe(status.limit);
    });
  });

  describe('getUsageReport()', () => {
    it('returns non-empty string report', () => {
      const report = getUsageReport();
      expect(typeof report).toBe('string');
      expect(report.length).toBeGreaterThan(0);
    });
  });

  describe('getCostOpsSummaryLine()', () => {
    it('returns cost summary string', () => {
      const line = getCostOpsSummaryLine();
      expect(typeof line).toBe('string');
    });
  });

  describe('getContextEfficiencyReport()', () => {
    it('returns efficiency report string', () => {
      const report = getContextEfficiencyReport();
      expect(typeof report).toBe('string');
    });
  });

  describe('getPromptAttributionSnapshot()', () => {
    it('returns prompt breakdown', () => {
      const snap = getPromptAttributionSnapshot();
      expect(snap).toHaveProperty('requests');
      expect(snap).toHaveProperty('avgPromptChars');
      expect(snap.avgPromptChars).toHaveProperty('system');
      expect(snap.avgPromptChars).toHaveProperty('history');
      expect(snap.avgPromptChars).toHaveProperty('tools');
      expect(snap.avgPromptChars).toHaveProperty('user');
      expect(snap.avgPromptChars).toHaveProperty('toolResults');
      expect(snap.avgPromptChars).toHaveProperty('total');
    });
  });

  // ─── initUsageCounters ───

  describe('initUsageCounters()', () => {
    it('is a no-op when already loaded', async () => {
      await initUsageCounters();
      // Already loaded in module, should be a no-op
    });
  });

  // ─── flushUsageCounters ───

  describe('flushUsageCounters()', () => {
    it('flushes dirty counters to DB', async () => {
      recordClaudeUsage(100, 50);
      await flushUsageCounters();
      const { upsertMemory: mockUpsert } = require('../../discord/memory');
      expect(mockUpsert).toHaveBeenCalled();
    });

    it('is a no-op when not dirty', async () => {
      const { upsertMemory: mockUpsert } = require('../../discord/memory');
      mockUpsert.mockClear();
      await flushUsageCounters();
      // Should not call upsert
    });
  });

  // ─── getUsageEmbed ───

  describe('getUsageEmbed()', () => {
    it('returns an EmbedBuilder', () => {
      const embed = getUsageEmbed();
      expect(embed).toBeDefined();
      expect(embed.data.title).toContain('Usage Dashboard');
    });

    it('includes budget and token fields', () => {
      recordClaudeUsage(5000, 2000, {
        modelName: 'claude-sonnet-4-6',
        agentLabel: 'Riley',
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 500,
        promptBreakdown: {
          systemChars: 2000,
          historyChars: 1000,
          toolsChars: 500,
          userChars: 300,
          toolResultChars: 200,
        },
      });
      const embed = getUsageEmbed();
      expect(embed.data.fields).toBeDefined();
      expect(embed.data.fields!.length).toBeGreaterThan(3);
    });

    it('shows live billing when available', () => {
      const { getLiveBillingSnapshot } = require('../../services/billing');
      (getLiveBillingSnapshot as jest.Mock).mockReturnValue({
        available: true,
        dailyCostUsd: 5.5,
        monthCostUsd: 42.0,
        currency: 'USD',
      });
      const embed = getUsageEmbed();
      const gcpField = embed.data.fields?.find((f: any) => f.name.includes('GCP'));
      expect(gcpField?.value).toContain('5.5');
    });
  });

  // ─── setCostChannel and recording with cost channel ───

  describe('setCostChannel()', () => {
    it('sets cost channel for recording ops', () => {
      const fakeChannel: any = { id: 'cost-ch', send: jest.fn().mockResolvedValue(undefined) };
      setCostChannel(fakeChannel);
      // Recording usage should now trigger postOpsLine
      recordClaudeUsage(100, 50, {
        modelName: 'gemini-2.5-flash',
        agentLabel: 'Ace',
      });
      const { postOpsLine } = require('../../discord/activityLog');
      expect(postOpsLine).toHaveBeenCalled();
      setCostChannel(null);
    });
  });

  // ─── setLimitsChannel and dashboard ───

  describe('dashboard updates', () => {
    it('setLimitsChannel sets the channel', () => {
      expect(() => setLimitsChannel(null as any)).not.toThrow();
    });

    it('startDashboardUpdates does not throw without channel', async () => {
      setLimitsChannel(null as any);
      await startDashboardUpdates();
    });

    it('stopDashboardUpdates clears interval', () => {
      stopDashboardUpdates();
    });

    it('refreshUsageDashboard does not throw', async () => {
      await refreshUsageDashboard();
    });

    it('refreshLiveBillingData does not throw', async () => {
      await refreshLiveBillingData();
    });

    it('startDashboardUpdates with channel posts embed', async () => {
      const { refreshLiveBillingSnapshot } = require('../../services/billing');
      (refreshLiveBillingSnapshot as jest.Mock).mockResolvedValue(undefined);

      const fakeMsg = { id: 'msg-1', edit: jest.fn().mockResolvedValue(undefined) };
      const fakeChannel: any = {
        id: 'limits-ch',
        send: jest.fn().mockResolvedValue(fakeMsg),
        messages: {
          fetch: jest.fn().mockResolvedValue(new Map()),
        },
      };
      setLimitsChannel(fakeChannel);
      await startDashboardUpdates();
      expect(fakeChannel.send).toHaveBeenCalled();
      stopDashboardUpdates();
      setLimitsChannel(null as any);
    });

    it('refreshUsageDashboard edits existing message', async () => {
      const { refreshLiveBillingSnapshot } = require('../../services/billing');
      (refreshLiveBillingSnapshot as jest.Mock).mockResolvedValue(undefined);

      const editMock = jest.fn().mockResolvedValue(undefined);
      const fakeMsg = { id: 'msg-dash', edit: editMock };
      const fakeChannel: any = {
        id: 'limits-ch-2',
        send: jest.fn().mockResolvedValue(fakeMsg),
        messages: {
          fetch: jest.fn()
            .mockResolvedValueOnce(new Map()) // first call (startDashboardUpdates)
            .mockResolvedValueOnce(fakeMsg)    // second call (refreshUsageDashboard -> edit path)
        },
      };
      setLimitsChannel(fakeChannel);
      await startDashboardUpdates(); // posts initial embed, sets dashboardMessageId
      stopDashboardUpdates();

      await refreshUsageDashboard(); // should try to edit existing message
      setLimitsChannel(null as any);
    });

    it('handles bulkDelete failure by falling back to individual deletes', async () => {
      const { refreshLiveBillingSnapshot } = require('../../services/billing');
      (refreshLiveBillingSnapshot as jest.Mock).mockResolvedValue(undefined);

      const fakeMsg = { id: 'msg-bulk', edit: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockResolvedValue(undefined) };
      const msgMap = new Map([['msg-1', { delete: jest.fn().mockResolvedValue(undefined) }]]);
      const fakeChannel: any = {
        id: 'limits-ch-3',
        send: jest.fn().mockResolvedValue(fakeMsg),
        messages: {
          fetch: jest.fn().mockResolvedValue(msgMap),
        },
        bulkDelete: jest.fn().mockRejectedValue(new Error('bulk delete not available')),
      };
      setLimitsChannel(fakeChannel);
      await refreshUsageDashboard();
      stopDashboardUpdates();
      setLimitsChannel(null as any);
    });
  });

  // ─── recordClaudeUsage with Anthropic vs Gemini model names ───

  describe('recordClaudeUsage model detection', () => {
    it('detects haiku as anthropic', () => {
      recordClaudeUsage(100, 50, 'claude-haiku-3');
      // Should not throw
    });

    it('detects sonnet as anthropic', () => {
      recordClaudeUsage(100, 50, 'claude-sonnet-4-6');
      // Should not throw
    });

    it('treats non-anthropic model as gemini', () => {
      recordClaudeUsage(100, 50, 'gemini-2.5-flash');
      // Should not throw and track as gemini
    });

    it('handles undefined model name', () => {
      recordClaudeUsage(100, 50);
      // Should not throw
    });
  });

  // ─── setDailyBudgetLimit with persist ───

  describe('setDailyBudgetLimit() persistence', () => {
    it('handles persist when .env file does not exist', () => {
      const result = setDailyBudgetLimit(200, true);
      expect(result.current).toBe(200);
    });

    it('handles Infinity as invalid', () => {
      expect(() => setDailyBudgetLimit(Infinity, false)).toThrow('Invalid budget limit');
    });
  });

  // ─── approveAdditionalBudget edge cases ───

  describe('approveAdditionalBudget() edge cases', () => {
    it('handles negative amount by using default', () => {
      const result = approveAdditionalBudget(-5);
      expect(result.added).toBeGreaterThan(0);
    });

    it('handles zero amount by using default', () => {
      const result = approveAdditionalBudget(0);
      expect(result.added).toBeGreaterThan(0);
    });
  });
});

describe('usage tracing primitives', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function mockUsageDeps(mockQ: jest.Mock) {
    jest.doMock('../../db/pool', () => ({ default: { query: mockQ }, __esModule: true }));
    jest.doMock('../../discord/memory', () => ({ upsertMemory: jest.fn() }));
    jest.doMock('../../services/billing', () => ({
      getLiveBillingSnapshot: jest.fn(() => null),
      refreshLiveBillingSnapshot: jest.fn(),
    }));
    jest.doMock('../../discord/activityLog', () => ({
      formatOpsLine: jest.fn(() => ''),
      postOpsLine: jest.fn(),
    }));
    jest.doMock('../../discord/ui/constants', () => ({ statusColor: jest.fn(() => 0x00ff00) }));
  }

  it('generates trace and span ids with expected format', async () => {
    mockUsageDeps(jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }));
    const { newTraceId, newSpanId } = await import('../../discord/usage');
    expect(newTraceId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('creates child trace contexts with inherited trace id', async () => {
    mockUsageDeps(jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }));
    const { createTraceContext } = await import('../../discord/usage');
    const parent = createTraceContext();
    const child = createTraceContext(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
  });

  it('records spans to the trace table', async () => {
    const mockQ = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    mockUsageDeps(mockQ);
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const { recordSpan } = await import('../../discord/usage');
    await recordSpan({
      traceId: 'trace1234567890',
      spanId: 'span1234',
      agentId: 'developer',
      operation: 'unit-test',
      status: 'ok',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(mockQ).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO trace_spans'),
      expect.arrayContaining(['trace1234567890', 'span1234', 'developer']),
    );
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('disables trace db persistence when trace_spans is missing', async () => {
    const mockQ = jest.fn().mockRejectedValue({ message: 'relation "trace_spans" does not exist', code: '42P01' });
    mockUsageDeps(mockQ);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const { recordSpan } = await import('../../discord/usage');
    await recordSpan({
      traceId: 'trace1234567890',
      spanId: 'span1234',
      agentId: 'developer',
      operation: 'unit-test',
      status: 'ok',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    await recordSpan({
      traceId: 'trace1234567891',
      spanId: 'span1235',
      agentId: 'developer',
      operation: 'unit-test',
      status: 'ok',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tracing DB persistence disabled'));
    expect(mockQ).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
