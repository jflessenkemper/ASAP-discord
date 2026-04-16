jest.mock('../../db/pool', () => ({ default: { query: jest.fn() }, __esModule: true }));
jest.mock('../../services/github', () => ({
  createBranch: jest.fn(), createPR: jest.fn(), mergePR: jest.fn(),
  addPRComment: jest.fn(), listPRs: jest.fn(), searchCode: jest.fn(),
}));
jest.mock('../../services/jobSearch', () => ({ runJobScan: jest.fn() }));
jest.mock('../../discord/agents', () => ({
  getAgentConfig: jest.fn(), getAllAgentIds: jest.fn(() => []),
}));
jest.mock('../../discord/handlers/review', () => ({ getRequiredReviewers: jest.fn() }));
jest.mock('../../discord/handlers/groupchat', () => ({ setActiveSmokeTestRunning: jest.fn() }));
jest.mock('../../discord/services/mobileHarness', () => ({
  runMobileTest: jest.fn(), discoverDevices: jest.fn(),
}));
jest.mock('../../discord/services/screenshots', () => ({ captureAndPostScreenshots: jest.fn() }));
jest.mock('../../discord/services/webhooks', () => ({ getWebhook: jest.fn() }));
jest.mock('../../discord/usage', () => ({ setDailyBudgetLimit: jest.fn() }));
jest.mock('../../discord/memory', () => ({
  upsertMemory: jest.fn(), getMemory: jest.fn(),
}));
jest.mock('../../discord/ui/constants', () => ({
  SYSTEM_COLORS: {}, BUTTON_IDS: {}, jobScoreColor: jest.fn(),
}));

import { CircuitBreaker, CircuitOpenError, getCircuitBreakerForTool, getCircuitBreaker, getAllCircuitBreakerStats } from '../../discord/tools';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test-service', 3, 100, 5000);
  });

  test('starts in closed state', () => {
    expect(breaker.getStats().state).toBe('closed');
    expect(breaker.isAvailable()).toBe(true);
  });

  test('passes through calls when closed', async () => {
    const result = await breaker.call(async () => 'ok');
    expect(result).toBe('ok');
    expect(breaker.getStats().successes).toBe(1);
  });

  test('opens after reaching failure threshold', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(breaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    expect(breaker.getStats().state).toBe('open');
    expect(breaker.isAvailable()).toBe(false);
  });

  test('rejects calls when open', async () => {
    for (let i = 0; i < 3; i++) {
      await breaker.call(async () => 'ok').catch(() => {});
    }
    // Force open
    for (let i = 0; i < 3; i++) {
      await expect(breaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    await expect(breaker.call(async () => 'ok')).rejects.toThrow(CircuitOpenError);
  });

  test('transitions to half_open after cooldown', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(breaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    expect(breaker.getStats().state).toBe('open');

    // Wait for cooldown (100ms)
    await new Promise((r) => setTimeout(r, 120));
    expect(breaker.isAvailable()).toBe(true);
  });

  test('closes on successful probe after half_open', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(breaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    }

    await new Promise((r) => setTimeout(r, 120));
    const result = await breaker.call(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(breaker.getStats().state).toBe('closed');
    expect(breaker.getStats().failures).toBe(0);
  });

  test('re-opens on failed probe after half_open', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(breaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    }

    await new Promise((r) => setTimeout(r, 120));
    await expect(breaker.call(async () => { throw new Error('still broken'); })).rejects.toThrow();
    expect(breaker.getStats().state).toBe('open');
  });

  test('reset() forces circuit back to closed', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(breaker.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    expect(breaker.getStats().state).toBe('open');

    breaker.reset();
    expect(breaker.getStats().state).toBe('closed');
    expect(breaker.isAvailable()).toBe(true);
  });

  test('recordSuccess and recordFailure work externally', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getStats().failures).toBe(2);
    expect(breaker.getStats().state).toBe('closed');

    breaker.recordFailure();
    expect(breaker.getStats().state).toBe('open');

    breaker.recordSuccess(); // won't close from open without half_open transition
    // But we manually reset for the next assertion
    breaker.reset();
    breaker.recordSuccess();
    expect(breaker.getStats().successes).toBe(1);
  });

  test('CircuitOpenError has correct service name', () => {
    const err = new CircuitOpenError('github');
    expect(err.serviceName).toBe('github');
    expect(err.message).toContain('github');
    expect(err.name).toBe('CircuitOpenError');
  });

  test('throws CircuitOpenError when open and cooldown has not expired', async () => {
    // Use a long cooldown so it definitely hasn't expired
    const b = new CircuitBreaker('slow-cooldown', 2, 60_000);
    await expect(b.call(async () => { throw new Error('f1'); })).rejects.toThrow('f1');
    await expect(b.call(async () => { throw new Error('f2'); })).rejects.toThrow('f2');
    expect(b.getStats().state).toBe('open');

    // Immediate call should throw CircuitOpenError (cooldown not expired)
    await expect(b.call(async () => 'ok')).rejects.toThrow(CircuitOpenError);
    expect(b.getStats().state).toBe('open');
  });

  test('half-open probe failure re-opens circuit', async () => {
    const b = new CircuitBreaker('probe-fail', 2, 50);
    await expect(b.call(async () => { throw new Error('f1'); })).rejects.toThrow();
    await expect(b.call(async () => { throw new Error('f2'); })).rejects.toThrow();
    expect(b.getStats().state).toBe('open');

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 70));
    // Probe call should fail and re-open
    await expect(b.call(async () => { throw new Error('still down'); })).rejects.toThrow('still down');
    expect(b.getStats().state).toBe('open');
    expect(b.getStats().halfOpenProbeInFlight).toBe(false);
  });
});

describe('Service registry', () => {
  test('getCircuitBreakerForTool returns CircuitBreaker for mapped tool', () => {
    const cb = getCircuitBreakerForTool('gcp_deploy');
    expect(cb).toBeInstanceOf(CircuitBreaker);
    expect(cb!.name).toBe('gcp');
  });

  test('getCircuitBreakerForTool returns same breaker for same service', () => {
    const a = getCircuitBreakerForTool('gcp_deploy');
    const b = getCircuitBreakerForTool('gcp_build_image');
    expect(a).toBe(b);
  });

  test('getCircuitBreakerForTool returns undefined for unknown tool', () => {
    expect(getCircuitBreakerForTool('unknown_tool')).toBeUndefined();
  });

  test('getCircuitBreaker creates new breaker via registry', () => {
    const cb = getCircuitBreaker('new-unique-service');
    expect(cb).toBeInstanceOf(CircuitBreaker);
    expect(cb.name).toBe('new-unique-service');
  });

  test('getAllCircuitBreakerStats returns stats array', () => {
    // Ensure at least one breaker exists
    getCircuitBreakerForTool('gcp_deploy');
    const stats = getAllCircuitBreakerStats();
    expect(Array.isArray(stats)).toBe(true);
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0]).toHaveProperty('name');
    expect(stats[0]).toHaveProperty('state');
  });
});

describe('CircuitBreaker edge cases', () => {
  test('call() throws CircuitOpenError when open and cooldown has NOT elapsed', async () => {
    const b = new CircuitBreaker('edge-open', 2, 60_000);
    await expect(b.call(async () => { throw new Error('f1'); })).rejects.toThrow('f1');
    await expect(b.call(async () => { throw new Error('f2'); })).rejects.toThrow('f2');
    expect(b.getStats().state).toBe('open');
    await expect(b.call(async () => 'should not run')).rejects.toThrow(CircuitOpenError);
  });

  test('call() catch block calls onFailure and rethrows', async () => {
    const b = new CircuitBreaker('catch-test', 5, 100);
    await expect(b.call(async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    expect(b.getStats().failures).toBe(1);
  });

  test('onFailure in half_open re-opens circuit', async () => {
    const b = new CircuitBreaker('half-open-fail', 2, 50);
    await expect(b.call(async () => { throw new Error('f1'); })).rejects.toThrow();
    await expect(b.call(async () => { throw new Error('f2'); })).rejects.toThrow();
    expect(b.getStats().state).toBe('open');
    await new Promise((r) => setTimeout(r, 70));
    // Probe call in half_open state fails → onFailure with half_open → re-opens
    await expect(b.call(async () => { throw new Error('probe fail'); })).rejects.toThrow('probe fail');
    expect(b.getStats().state).toBe('open');
    expect(b.getStats().halfOpenProbeInFlight).toBe(false);
  });

  test('decayIfStale closes open circuit when failures decay below threshold', async () => {
    // Use a very short window so decayIfStale triggers
    const b = new CircuitBreaker('decay-close', 3, 50, 80);
    // Open the circuit
    await expect(b.call(async () => { throw new Error('f1'); })).rejects.toThrow();
    await expect(b.call(async () => { throw new Error('f2'); })).rejects.toThrow();
    await expect(b.call(async () => { throw new Error('f3'); })).rejects.toThrow();
    expect(b.getStats().state).toBe('open');
    // Wait for both cooldown AND window to expire, so decayIfStale halves failures
    await new Promise((r) => setTimeout(r, 100));
    // isAvailable() calls decayIfStale(); failures: 3 → 1 (halved), < threshold 3 → closes
    expect(b.isAvailable()).toBe(true);
    expect(b.getStats().state).toBe('closed');
  });
});

describe('CircuitBreaker (fresh module)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('open circuit rejects with CircuitOpenError before cooldown (fresh)', async () => {
    const { CircuitBreaker: CB, CircuitOpenError: COE } = await import('../../discord/tools');
    const b = new CB('fresh-open', 2, 60_000);
    await expect(b.call(async () => { throw new Error('f1'); })).rejects.toThrow('f1');
    await expect(b.call(async () => { throw new Error('f2'); })).rejects.toThrow('f2');
    expect(b.getStats().state).toBe('open');
    await expect(b.call(async () => 'nope')).rejects.toThrow(COE);
  });

  test('call catch rethrows after onFailure (fresh)', async () => {
    const { CircuitBreaker: CB } = await import('../../discord/tools');
    const b = new CB('fresh-catch', 5, 100);
    await expect(b.call(async () => { throw new Error('oops'); })).rejects.toThrow('oops');
    expect(b.getStats().failures).toBe(1);
  });

  test('onFailure in half_open re-opens (fresh)', async () => {
    const { CircuitBreaker: CB } = await import('../../discord/tools');
    const b = new CB('fresh-half', 2, 50);
    await expect(b.call(async () => { throw new Error('f1'); })).rejects.toThrow();
    await expect(b.call(async () => { throw new Error('f2'); })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 70));
    await expect(b.call(async () => { throw new Error('probe'); })).rejects.toThrow('probe');
    expect(b.getStats().state).toBe('open');
  });

  test('decayIfStale recovers open circuit (fresh)', async () => {
    const { CircuitBreaker: CB } = await import('../../discord/tools');
    const b = new CB('fresh-decay', 3, 50, 80);
    await expect(b.call(async () => { throw new Error('f1'); })).rejects.toThrow();
    await expect(b.call(async () => { throw new Error('f2'); })).rejects.toThrow();
    await expect(b.call(async () => { throw new Error('f3'); })).rejects.toThrow();
    expect(b.getStats().state).toBe('open');
    await new Promise((r) => setTimeout(r, 100));
    expect(b.isAvailable()).toBe(true);
    expect(b.getStats().state).toBe('closed');
  });
});
