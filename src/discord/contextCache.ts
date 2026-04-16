// Anthropic does not expose a drop-in equivalent for the prior provider-side
// cache flow used here. Keep the same API surface but degrade to a no-op.

const cacheMetrics = {
  hits: 0,
  misses: 0,
  creates: 0,
  errors: 0,
};

export function getCacheMetrics(): { hits: number; misses: number; creates: number; errors: number; hitRate: number } {
  const total = cacheMetrics.hits + cacheMetrics.misses;
  return {
    ...cacheMetrics,
    hitRate: total > 0 ? cacheMetrics.hits / total : 0,
  };
}

export async function getOrCreateContentCache(
  _modelName: string,
  _systemPrompt: string,
  _toolDeclarations: any[],
  _agentId: string,
): Promise<string | null> {
  cacheMetrics.misses++;
  return null;
}

/**
 * Evict all expired caches from the local registry.
 */
export function evictExpiredCaches(): number {
  return 0;
}

/**
 * Get cache stats for monitoring.
 */
export function getCacheStats(): { active: number; totalCreated: number } {
  return {
    active: 0,
    totalCreated: cacheMetrics.creates,
  };
}
