jest.mock('../../db/pool', () => ({
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  __esModule: true,
}));

import {
  getAllModelHealth,
  getModelStatus,
  isModelAvailable,
  isOnFallbackModel,
  recordModelFailure,
  recordModelSuccess,
  resetModelHealth,
  resolveHealthyModel,
} from '../../discord/modelHealth';
import {
  DEFAULT_CODING_MODEL,
  DEFAULT_FAST_MODEL,
  SECONDARY_FAST_MODEL,
  getFallbackChain,
} from '../../services/modelConfig';

describe('modelHealth', () => {
  const trackedModels = [DEFAULT_FAST_MODEL, DEFAULT_CODING_MODEL, SECONDARY_FAST_MODEL, 'test-model'];

  beforeEach(() => {
    for (const model of trackedModels) {
      resetModelHealth(model);
    }
  });

  it('treats unknown models as healthy and available', () => {
    expect(getModelStatus('unknown-model')).toBe('healthy');
    expect(isModelAvailable('unknown-model')).toBe(true);
  });

  it('records success latency without degrading the model', () => {
    recordModelSuccess('test-model', 200);
    recordModelSuccess('test-model', 100);

    const health = getAllModelHealth().find((item) => item.modelName === 'test-model');
    expect(health?.lastLatencyMs).toBe(100);
    expect(health?.avgLatencyMs).toBeGreaterThan(0);
    expect(getModelStatus('test-model')).toBe('healthy');
  });

  it('marks a model down after repeated failures', () => {
    recordModelFailure('test-model', 'error');
    recordModelFailure('test-model', 'error');
    recordModelFailure('test-model', 'error');

    expect(getModelStatus('test-model')).toBe('down');
    expect(isModelAvailable('test-model')).toBe(false);
  });

  it('falls back through the configured Anthropic chain', () => {
    const fallbackChain = getFallbackChain(DEFAULT_FAST_MODEL);
    expect(fallbackChain.length).toBeGreaterThan(0);

    recordModelFailure(DEFAULT_FAST_MODEL, 'error');
    recordModelFailure(DEFAULT_FAST_MODEL, 'error');
    recordModelFailure(DEFAULT_FAST_MODEL, 'error');

    const resolved = resolveHealthyModel(DEFAULT_FAST_MODEL);
    expect(fallbackChain).toContain(resolved);
    expect(isOnFallbackModel(DEFAULT_FAST_MODEL)).toBe(true);
  });

  it('returns the preferred model as a last resort when the whole chain is down', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const models = [DEFAULT_FAST_MODEL, ...getFallbackChain(DEFAULT_FAST_MODEL)];

    for (const model of models) {
      recordModelFailure(model, 'error');
      recordModelFailure(model, 'error');
      recordModelFailure(model, 'error');
    }

    expect(resolveHealthyModel(DEFAULT_FAST_MODEL)).toBe(DEFAULT_FAST_MODEL);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ALL MODELS DOWN'));
    errorSpy.mockRestore();
  });

  it('normalizes model names case-insensitively', () => {
    recordModelSuccess(DEFAULT_FAST_MODEL.toUpperCase(), 50);
    expect(getModelStatus(DEFAULT_FAST_MODEL.toLowerCase())).toBe('healthy');
  });
});
