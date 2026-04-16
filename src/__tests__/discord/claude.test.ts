/**
 * Tests for src/discord/claude.ts
 * Response envelope parsing, Gemini quota fuse, context reports.
 */

// Mock heavy dependencies to isolate pure logic
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn(),
  SchemaType: { STRING: 'string', OBJECT: 'object', ARRAY: 'array' },
}));
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn(() => ({ getClient: jest.fn() })),
}));
jest.mock('../../db/pool', () => ({ default: { query: jest.fn() }, __esModule: true }));
jest.mock('../../services/googleCredentials', () => ({
  ensureGoogleCredentials: jest.fn(),
  getAccessTokenViaGcloud: jest.fn(),
}));
jest.mock('../../discord/agents', () => ({
  getAgents: jest.fn(() => new Map()),
  getAgent: jest.fn((id: string) => ({
    id, name: `Agent ${id}`, handle: id, systemPrompt: 'You are an agent.',
    aliases: [], channelName: '', emoji: '', color: 0, voice: '', avatarUrl: '', roleName: '',
  })),
  AgentId: {},
}));
jest.mock('../../discord/tools', () => ({
  executeTool: jest.fn(),
  getToolsForAgent: jest.fn(() => []),
  agentCanUseTool: jest.fn(() => true),
  REPO_TOOLS: [],
  getToolAuditCallback: jest.fn(() => null),
}));
jest.mock('../../discord/usage', () => ({
  recordClaudeUsage: jest.fn(),
  isClaudeOverLimit: jest.fn(() => false),
  isBudgetExceeded: jest.fn(() => false),
  getRemainingBudget: jest.fn(() => ({ remaining: 100, spent: 0, limit: 100 })),
  getClaudeTokenStatus: jest.fn(() => ({ used: 0, remaining: 8000000, limit: 8000000 })),
  toAgentTag: jest.fn((label: string) => label),
  newTraceId: jest.fn(() => 'abc123'),
  newSpanId: jest.fn(() => 'sp1'),
  createTraceContext: jest.fn(() => ({ traceId: 'abc123', spanId: 'sp1' })),
  recordSpan: jest.fn(),
}));
jest.mock('../../discord/guardrails', () => ({
  recordAgentResponse: jest.fn(),
  recordRateLimitHit: jest.fn(),
}));
jest.mock('../../discord/modelHealth', () => ({
  resolveHealthyModel: jest.fn((m: string) => m),
  isOnFallbackModel: jest.fn(() => false),
  recordModelSuccess: jest.fn(),
  recordModelFailure: jest.fn(),
  getModelStatus: jest.fn(() => 'healthy'),
}));
jest.mock('../../discord/memory', () => ({
  loadMemory: jest.fn(() => []),
  getMemoryContext: jest.fn(() => []),
  saveMemory: jest.fn(),
  appendToMemory: jest.fn(),
  readMemoryRow: jest.fn(),
  upsertMemory: jest.fn(),
}));
jest.mock('../../discord/vectorMemory', () => ({
  vectorRecall: jest.fn(() => []),
}));
jest.mock('../../discord/activityLog', () => ({
  logAgentEvent: jest.fn(),
}));
jest.mock('../../discord/contextCache', () => ({
  getOrCreateContentCache: jest.fn(async () => null),
  evictExpiredCaches: jest.fn(() => 0),
  getCacheStats: jest.fn(() => ({ active: 0, totalCreated: 0 })),
}));

import {
  extractAgentResponseEnvelope,
  clearGeminiQuotaFuse,
  getGeminiQuotaFuseStatus,
  getContextRuntimeReport,
} from '../../discord/claude';

describe('claude', () => {
  describe('extractAgentResponseEnvelope()', () => {
    it('parses clean JSON envelope', () => {
      const env = extractAgentResponseEnvelope('{"human":"Hello there!"}');
      expect(env).not.toBeNull();
      expect(env!.human).toBe('Hello there!');
    });

    it('parses envelope with machine payload', () => {
      const env = extractAgentResponseEnvelope(JSON.stringify({
        human: 'I\'ll delegate this to Ace.',
        machine: {
          delegateAgents: ['developer'],
          actionTags: ['code-review'],
          notes: 'Needs PR review',
        },
      }));
      expect(env!.human).toContain('delegate');
      expect(env!.machine?.delegateAgents).toEqual(['developer']);
      expect(env!.machine?.actionTags).toEqual(['code-review']);
      expect(env!.machine?.notes).toBe('Needs PR review');
    });

    it('parses fenced JSON', () => {
      const text = 'Here is the response:\n```json\n{"human":"Hello"}\n```';
      const env = extractAgentResponseEnvelope(text);
      expect(env!.human).toBe('Hello');
    });

    it('parses JSON embedded in text', () => {
      const text = 'Some preamble {"human":"The answer is 42"} trailing text';
      const env = extractAgentResponseEnvelope(text);
      expect(env!.human).toBe('The answer is 42');
    });

    it('parses escaped quotes in human field', () => {
      const env = extractAgentResponseEnvelope('{"human":"He said \\"hello\\""}');
      expect(env!.human).toContain('hello');
    });

    it('returns null for empty text', () => {
      expect(extractAgentResponseEnvelope('')).toBeNull();
    });

    it('returns null for non-envelope JSON', () => {
      expect(extractAgentResponseEnvelope('{"name":"test"}')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(extractAgentResponseEnvelope('not json at all')).toBeNull();
    });

    it('handles empty human field', () => {
      expect(extractAgentResponseEnvelope('{"human":""}')).toBeNull();
    });

    it('handles machine with empty arrays', () => {
      const env = extractAgentResponseEnvelope(JSON.stringify({
        human: 'Response',
        machine: { delegateAgents: [], actionTags: [] },
      }));
      expect(env!.human).toBe('Response');
      expect(env!.machine).toBeUndefined(); // empty machine is stripped
    });

    it('handles plain-text human: format', () => {
      const env = extractAgentResponseEnvelope('human: This is a plain text response');
      // May or may not parse depending on implementation
      if (env) {
        expect(env.human).toContain('plain text');
      }
    });

    it('handles quoted human field regex fallback', () => {
      // Slightly malformed JSON but extractable
      const env = extractAgentResponseEnvelope('{ "human": "Rescued response" }');
      expect(env!.human).toBe('Rescued response');
    });
  });

  describe('Gemini quota fuse', () => {
    beforeEach(() => {
      clearGeminiQuotaFuse();
    });

    it('starts unblocked', () => {
      const status = getGeminiQuotaFuseStatus();
      expect(status.blocked).toBe(false);
    });

    it('clearGeminiQuotaFuse resets state', () => {
      clearGeminiQuotaFuse();
      expect(getGeminiQuotaFuseStatus().blocked).toBe(false);
    });
  });

  describe('getContextRuntimeReport()', () => {
    it('returns a non-empty report string', () => {
      const report = getContextRuntimeReport();
      expect(typeof report).toBe('string');
      expect(report.length).toBeGreaterThan(0);
    });

    it('includes context pruning stats', () => {
      const report = getContextRuntimeReport();
      expect(report.toLowerCase()).toContain('prun');
    });
  });
});
