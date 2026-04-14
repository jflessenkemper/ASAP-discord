import { CircuitBreaker, CircuitOpenError } from '../../discord/circuitBreaker';

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
});
