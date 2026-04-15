/**
 * Tests for src/discord/modelHealth.ts
 * Model health state machine — fallback chains, degradation, recovery.
 */

jest.mock('../../db/pool', () => ({
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  __esModule: true,
}));

import {
  recordModelSuccess,
  recordModelFailure,
  getModelStatus,
  isModelAvailable,
  resolveHealthyModel,
  resetModelHealth,
  getAllModelHealth,
  isOnFallbackModel,
} from '../../discord/modelHealth';

describe('modelHealth', () => {
  beforeEach(() => {
    // Reset all model state between tests
    resetModelHealth('gemini-2.5-flash');
    resetModelHealth('gemini-2.5-pro');
    resetModelHealth('claude-opus-4-6');
    resetModelHealth('claude-sonnet-4-6');
    resetModelHealth('test-model');
  });

  describe('initial state', () => {
    it('reports healthy for unknown models', () => {
      expect(getModelStatus('test-model')).toBe('healthy');
    });

    it('reports available for unknown models', () => {
      expect(isModelAvailable('test-model')).toBe(true);
    });
  });

  describe('recordModelSuccess()', () => {
    it('keeps model healthy after success', () => {
      recordModelSuccess('test-model', 100);
      expect(getModelStatus('test-model')).toBe('healthy');
    });

    it('tracks latency', () => {
      recordModelSuccess('test-model', 500);
      recordModelSuccess('test-model', 300);
      const health = getAllModelHealth();
      const model = health.find(h => h.modelName === 'test-model');
      expect(model).toBeDefined();
      expect(model!.lastLatencyMs).toBe(300);
      expect(model!.avgLatencyMs).toBeGreaterThan(0);
    });
  });

  describe('recordModelFailure()', () => {
    it('degrades model after enough failures', () => {
      // Need MIN_SAMPLES (3) to classify
      recordModelSuccess('test-model', 100);
      recordModelFailure('test-model', 'error');
      recordModelFailure('test-model', 'error');
      // 2 failures + 1 success = 66% failure rate → should be degraded or down
      const status = getModelStatus('test-model');
      expect(['degraded', 'down']).toContain(status);
    });

    it('marks model down after high failure rate', () => {
      recordModelFailure('test-model', 'error');
      recordModelFailure('test-model', 'error');
      recordModelFailure('test-model', 'error');
      // 3 failures, 0 successes = 100% failure rate → down
      expect(getModelStatus('test-model')).toBe('down');
      expect(isModelAvailable('test-model')).toBe(false);
    });

    it('marks model down immediately on quota exhaustion', () => {
      recordModelFailure('test-model', 'quota_exhausted');
      recordModelFailure('test-model', 'quota_exhausted');
      recordModelFailure('test-model', 'quota_exhausted');
      expect(getModelStatus('test-model')).toBe('down');
    });

    it('tracks rate limit counts', () => {
      recordModelFailure('test-model', 'rate_limited');
      const health = getAllModelHealth();
      const model = health.find(h => h.modelName === 'test-model');
      expect(model!.rateLimitCount).toBeGreaterThan(0);
    });
  });

  describe('resolveHealthyModel()', () => {
    it('returns preferred model when healthy', () => {
      expect(resolveHealthyModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    });

    it('falls back when preferred model is down', () => {
      // Kill gemini-2.5-flash
      recordModelFailure('gemini-2.5-flash', 'error');
      recordModelFailure('gemini-2.5-flash', 'error');
      recordModelFailure('gemini-2.5-flash', 'error');
      const resolved = resolveHealthyModel('gemini-2.5-flash');
      expect(resolved).not.toBe('gemini-2.5-flash');
      // Should be one of the fallbacks
      expect(['gemini-2.5-pro', 'claude-opus-4-6']).toContain(resolved);
    });

    it('returns preferred model as last resort when all are down', () => {
      const models = ['gemini-2.5-flash', 'gemini-2.5-pro', 'claude-opus-4-6'];
      for (const m of models) {
        recordModelFailure(m, 'error');
        recordModelFailure(m, 'error');
        recordModelFailure(m, 'error');
      }
      // Should return the preferred model as last resort
      expect(resolveHealthyModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    });
  });

  describe('isOnFallbackModel()', () => {
    it('returns false when preferred is healthy', () => {
      expect(isOnFallbackModel('gemini-2.5-flash')).toBe(false);
    });

    it('returns true when preferred is down', () => {
      recordModelFailure('gemini-2.5-flash', 'error');
      recordModelFailure('gemini-2.5-flash', 'error');
      recordModelFailure('gemini-2.5-flash', 'error');
      expect(isOnFallbackModel('gemini-2.5-flash')).toBe(true);
    });
  });

  describe('resetModelHealth()', () => {
    it('resets model to healthy', () => {
      recordModelFailure('test-model', 'error');
      recordModelFailure('test-model', 'error');
      recordModelFailure('test-model', 'error');
      expect(getModelStatus('test-model')).toBe('down');
      resetModelHealth('test-model');
      expect(getModelStatus('test-model')).toBe('healthy');
    });
  });

  describe('getAllModelHealth()', () => {
    it('returns array of all tracked models', () => {
      recordModelSuccess('model-a', 100);
      recordModelSuccess('model-b', 200);
      const health = getAllModelHealth();
      expect(health.length).toBeGreaterThanOrEqual(2);
      expect(health.some(h => h.modelName === 'model-a')).toBe(true);
      expect(health.some(h => h.modelName === 'model-b')).toBe(true);
    });

    it('returns copies (not references)', () => {
      recordModelSuccess('test-model', 100);
      const health1 = getAllModelHealth();
      const model = health1.find(h => h.modelName === 'test-model')!;
      model.successCount = 999;
      const health2 = getAllModelHealth();
      const model2 = health2.find(h => h.modelName === 'test-model')!;
      expect(model2.successCount).not.toBe(999);
    });
  });

  describe('case insensitivity', () => {
    it('normalizes model names to lowercase', () => {
      recordModelSuccess('Gemini-2.5-Flash', 100);
      expect(getModelStatus('gemini-2.5-flash')).toBe('healthy');
    });
  });
});
