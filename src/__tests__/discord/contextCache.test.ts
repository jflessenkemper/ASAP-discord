import {
  evictExpiredCaches,
  getCacheMetrics,
  getCacheStats,
  getOrCreateContentCache,
} from '../../discord/contextCache';

describe('contextCache', () => {
  it('always returns null for content cache requests in Anthropic-only mode', async () => {
    await expect(getOrCreateContentCache('claude-sonnet-4-20250514', 'system prompt', [], 'executive-assistant')).resolves.toBeNull();
  });

  it('tracks misses but never creates active caches', async () => {
    const before = getCacheMetrics();
    await getOrCreateContentCache('claude-opus-4-6', 'another prompt', [], 'executive-assistant');
    const after = getCacheMetrics();

    expect(after.misses).toBe(before.misses + 1);
    expect(after.creates).toBe(0);
    expect(after.hits).toBe(0);
  });

  it('has no expired caches to evict', () => {
    expect(evictExpiredCaches()).toBe(0);
    expect(getCacheStats()).toEqual({ active: 0, totalCreated: 0 });
  });
});