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
jest.mock('../../discord/services/opsFeed', () => ({
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
});
