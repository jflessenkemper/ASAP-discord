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

  describe('downUntil cooldown', () => {
    it('stays down while downUntil is in the future', () => {
      // Exhaust quota to set downUntil far in the future
      recordModelFailure('test-model', 'quota_exhausted');
      recordModelFailure('test-model', 'quota_exhausted');
      recordModelFailure('test-model', 'quota_exhausted');
      expect(getModelStatus('test-model')).toBe('down');
      // Even after recording a success, downUntil keeps it down
      recordModelSuccess('test-model', 50);
      expect(getModelStatus('test-model')).toBe('down');
    });
  });

  describe('MIN_SAMPLES guard', () => {
    it('reports healthy when below MIN_SAMPLES even with failures', () => {
      // Only 2 samples (below default MIN_SAMPLES of 3)
      recordModelFailure('test-model', 'error');
      recordModelSuccess('test-model', 100);
      expect(getModelStatus('test-model')).toBe('healthy');
    });
  });

  describe('all models down warning', () => {
    it('returns preferred model and logs error when entire chain is down', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const models = ['gemini-2.5-flash', 'gemini-2.5-pro', 'claude-opus-4-6'];
      for (const m of models) {
        recordModelFailure(m, 'error');
        recordModelFailure(m, 'error');
        recordModelFailure(m, 'error');
      }
      const result = resolveHealthyModel('gemini-2.5-flash');
      expect(result).toBe('gemini-2.5-flash');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('ALL MODELS DOWN'),
      );
      errorSpy.mockRestore();
    });
  });

  describe('updateStatus threshold transitions', () => {
    it('sets degraded when failureRate crosses DEGRADED_THRESHOLD', () => {
      // 1 failure + 2 successes = 33% > 0.3 → degraded
      recordModelSuccess('degrade-test', 100);
      recordModelSuccess('degrade-test', 100);
      recordModelFailure('degrade-test', 'error');
      expect(getModelStatus('degrade-test')).toBe('degraded');
      resetModelHealth('degrade-test');
    });

    it('sets down when failureRate crosses DOWN_THRESHOLD', () => {
      // 3 failures + 1 success = 75% > 0.7 → down
      recordModelSuccess('down-thresh', 100);
      recordModelFailure('down-thresh', 'error');
      recordModelFailure('down-thresh', 'error');
      recordModelFailure('down-thresh', 'error');
      expect(getModelStatus('down-thresh')).toBe('down');
      resetModelHealth('down-thresh');
    });

    it('stays down when downUntil is in the future (updateStatus early return)', () => {
      recordModelFailure('cooldown-lock', 'quota_exhausted');
      recordModelFailure('cooldown-lock', 'quota_exhausted');
      recordModelFailure('cooldown-lock', 'quota_exhausted');
      recordModelSuccess('cooldown-lock', 50);
      recordModelSuccess('cooldown-lock', 50);
      recordModelSuccess('cooldown-lock', 50);
      expect(getModelStatus('cooldown-lock')).toBe('down');
      expect(isModelAvailable('cooldown-lock')).toBe(false);
      resetModelHealth('cooldown-lock');
    });
  });

  describe('resolveHealthyModel fallback chain', () => {
    it('logs warning when routing to fallback', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      recordModelFailure('gemini-2.5-flash', 'error');
      recordModelFailure('gemini-2.5-flash', 'error');
      recordModelFailure('gemini-2.5-flash', 'error');
      const result = resolveHealthyModel('gemini-2.5-flash');
      expect(result).not.toBe('gemini-2.5-flash');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('routing to'));
      warnSpy.mockRestore();
    });

    it('walks entire chain and falls back to last healthy model', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      for (const m of ['gemini-2.5-flash', 'gemini-2.5-pro']) {
        recordModelFailure(m, 'error');
        recordModelFailure(m, 'error');
        recordModelFailure(m, 'error');
      }
      expect(resolveHealthyModel('gemini-2.5-flash')).toBe('claude-opus-4-6');
      warnSpy.mockRestore();
    });

    it('returns preferred model as last resort when entire chain is down', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      for (const m of ['gemini-2.5-flash', 'gemini-2.5-pro', 'claude-opus-4-6']) {
        recordModelFailure(m, 'error');
        recordModelFailure(m, 'error');
        recordModelFailure(m, 'error');
      }
      expect(resolveHealthyModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ALL MODELS DOWN'));
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });
});

describe('modelHealth (fresh module)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('updateStatus normal flow — downUntil <= now', async () => {
    jest.doMock('../../db/pool', () => ({
      default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
      __esModule: true,
    }));
    const {
      recordModelSuccess,
      recordModelFailure,
      getModelStatus,
      isModelAvailable,
      resetModelHealth,
    } = await import('../../discord/modelHealth');
    recordModelSuccess('fresh-model', 100);
    expect(getModelStatus('fresh-model')).toBe('healthy');
    resetModelHealth('fresh-model');
  });

  it('failureRate triggers DOWN_THRESHOLD path', async () => {
    jest.doMock('../../db/pool', () => ({
      default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
      __esModule: true,
    }));
    const {
      recordModelSuccess,
      recordModelFailure,
      getModelStatus,
      resetModelHealth,
    } = await import('../../discord/modelHealth');
    recordModelSuccess('threshold-m', 100);
    recordModelFailure('threshold-m', 'error');
    recordModelFailure('threshold-m', 'error');
    recordModelFailure('threshold-m', 'error');
    expect(getModelStatus('threshold-m')).toBe('down');
    resetModelHealth('threshold-m');
  });

  it('failureRate triggers DEGRADED_THRESHOLD path', async () => {
    jest.doMock('../../db/pool', () => ({
      default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
      __esModule: true,
    }));
    const {
      recordModelSuccess,
      recordModelFailure,
      getModelStatus,
      resetModelHealth,
    } = await import('../../discord/modelHealth');
    recordModelSuccess('degrade-m', 100);
    recordModelSuccess('degrade-m', 100);
    recordModelFailure('degrade-m', 'error');
    expect(getModelStatus('degrade-m')).toBe('degraded');
    resetModelHealth('degrade-m');
  });

  it('resolveHealthyModel walks fallback chain and logs warning', async () => {
    jest.doMock('../../db/pool', () => ({
      default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
      __esModule: true,
    }));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const {
      recordModelFailure,
      resolveHealthyModel,
      resetModelHealth,
    } = await import('../../discord/modelHealth');
    recordModelFailure('gemini-2.5-flash', 'error');
    recordModelFailure('gemini-2.5-flash', 'error');
    recordModelFailure('gemini-2.5-flash', 'error');
    const result = resolveHealthyModel('gemini-2.5-flash');
    expect(result).not.toBe('gemini-2.5-flash');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('routing to'));
    warnSpy.mockRestore();
    resetModelHealth('gemini-2.5-flash');
  });

  it('resolveHealthyModel returns preferred when entire chain down', async () => {
    jest.doMock('../../db/pool', () => ({
      default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
      __esModule: true,
    }));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const {
      recordModelFailure,
      resolveHealthyModel,
      resetModelHealth,
    } = await import('../../discord/modelHealth');
    for (const m of ['gemini-2.5-flash', 'gemini-2.5-pro', 'claude-opus-4-6']) {
      recordModelFailure(m, 'error');
      recordModelFailure(m, 'error');
      recordModelFailure(m, 'error');
    }
    expect(resolveHealthyModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ALL MODELS DOWN'));
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
