/* ── mocks ─────────────────────────────────────────────────── */

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn(),
}));

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: jest.fn().mockResolvedValue({
      getAccessToken: jest.fn().mockResolvedValue({ token: 'fake-token' }),
    }),
  })),
}));

jest.mock('../../discord/activityLog', () => ({
  logAgentEvent: jest.fn(),
}));

// Mock global.fetch for the REST API calls the module makes
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { getOrCreateContentCache, evictExpiredCaches, getCacheStats } from '../../discord/contextCache';

/*
 * Module-level constants read from env at import time:
 * - CONTEXT_CACHE_ENABLED: true (process.env.CONTEXT_CACHE_ENABLED !== 'false')
 * - CONTEXT_CACHE_MIN_TOKENS: 4096
 * - createApiKeyCache checks process.env.GEMINI_API_KEY at call time
 */
const LONG_PROMPT = 'x'.repeat(20_000); // ~5000 tokens, above 4096 threshold

describe('contextCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-api-key';
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'cachedContents/abc123' }),
      text: async () => '',
    });
  });

  describe('getOrCreateContentCache', () => {
    it('returns null when system prompt is below minimum token threshold', async () => {
      const result = await getOrCreateContentCache('gemini-1.5-pro', 'short', [], 'ace');
      expect(result).toBeNull();
    });

    it('creates cache entry for long prompts via API-key REST call', async () => {
      const result = await getOrCreateContentCache('gemini-1.5-pro', LONG_PROMPT, [], 'ace');
      expect(result).toBe('cachedContents/abc123');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('generativelanguage.googleapis.com'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('returns cached entry on hash match without REST call', async () => {
      // Use a unique prompt so no prior test pollutes the cache
      const uniquePrompt = 'y'.repeat(20_000);
      const first = await getOrCreateContentCache('gemini-2.0-flash', uniquePrompt, [], 'ace');
      expect(first).toBeTruthy();
      const fetchCallsBefore = mockFetch.mock.calls.length;

      const second = await getOrCreateContentCache('gemini-2.0-flash', uniquePrompt, [], 'ace');
      expect(second).toBe(first);
      // Should NOT make another fetch — reused from internal cache
      expect(mockFetch.mock.calls.length).toBe(fetchCallsBefore);
    });

    it('returns null when GEMINI_API_KEY is not set and not using Vertex', async () => {
      delete process.env.GEMINI_API_KEY;
      const uniquePrompt = 'w'.repeat(20_000);
      const result = await getOrCreateContentCache('gemini-1.5-pro', uniquePrompt, [], 'ace');
      expect(result).toBeNull();
    });

    it('returns null and logs on REST API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });
      const spy = jest.spyOn(console, 'warn').mockImplementation();
      const uniquePrompt = 'q'.repeat(20_000);
      const result = await getOrCreateContentCache('gemini-1.5-pro', uniquePrompt, [], 'ace');
      expect(result).toBeNull();
      spy.mockRestore();
    });

    it('includes tool declarations in API key cache body', async () => {
      const tools = [{ name: 'test_tool', parameters: { type: 'object' } }];
      const uniquePrompt = 't'.repeat(20_000);
      await getOrCreateContentCache('gemini-1.5-pro', uniquePrompt, tools, 'ace');
      const lastIdx = mockFetch.mock.calls.length - 1;
      const fetchBody = JSON.parse(mockFetch.mock.calls[lastIdx][1].body);
      expect(fetchBody.tools).toBeDefined();
      expect(fetchBody.tools[0].functionDeclarations).toEqual(tools);
    });

    it('returns null when API key fetch throws exception', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network fail'));
      const spy = jest.spyOn(console, 'warn').mockImplementation();
      const uniquePrompt = 'e'.repeat(20_000);
      const result = await getOrCreateContentCache('gemini-1.5-pro', uniquePrompt, [], 'ace');
      expect(result).toBeNull();
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('cache creation error'),
        expect.any(String),
      );
      spy.mockRestore();
    });
  });

  describe('evictExpiredCaches', () => {
    it('runs without error', () => {
      expect(() => evictExpiredCaches()).not.toThrow();
    });

    it('evicts expired entries and returns count', async () => {
      jest.resetModules();
      process.env.CONTEXT_CACHE_TTL_SECONDS = '1';
      process.env.GEMINI_API_KEY = 'test-api-key';
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ name: 'evict-test-id' }),
        text: async () => '',
      });

      const mod = await import('../../discord/contextCache');
      const prompt = 'z'.repeat(20_000);
      await mod.getOrCreateContentCache('gemini-1.5-pro', prompt, [], 'ace');

      const origNow = Date.now;
      try {
        Date.now = () => origNow() + 60_000;
        const evicted = mod.evictExpiredCaches();
        expect(evicted).toBeGreaterThanOrEqual(1);
      } finally {
        Date.now = origNow;
      }
    });
  });

  describe('getCacheStats', () => {
    it('returns an object with active and totalCreated properties', () => {
      const stats = getCacheStats();
      expect(stats).toHaveProperty('active');
      expect(stats).toHaveProperty('totalCreated');
      expect(typeof stats.active).toBe('number');
    });
  });
});

describe('contextCache — Vertex AI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_USE_VERTEX_AI = 'true';
    process.env.VERTEX_PROJECT_ID = 'test-project';
    process.env.VERTEX_LOCATION = 'us-central1';
    process.env.GEMINI_API_KEY = 'test-api-key';
    process.env.CONTEXT_CACHE_TTL_SECONDS = '3600';
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env.GEMINI_USE_VERTEX_AI;
    delete process.env.VERTEX_PROJECT_ID;
    delete process.env.VERTEX_LOCATION;
    delete process.env.CONTEXT_CACHE_TTL_SECONDS;
  });

  const LONG = 'v'.repeat(20_000);

  it('creates cache via Vertex AI when configured', async () => {
    jest.resetModules();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ name: 'projects/test-project/cachedContents/xyz' }),
      text: async () => '',
    });

    const { getOrCreateContentCache } = await import('../../discord/contextCache');
    const result = await getOrCreateContentCache('gemini-1.5-pro', LONG, [], 'ace');
    expect(result).toContain('cachedContents/xyz');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('aiplatform.googleapis.com'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('falls back to API key cache when Vertex create fails', async () => {
    jest.resetModules();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'vertex error' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'fallback-id' }), text: async () => '' });

    const prompt = 'f'.repeat(20_000);
    const { getOrCreateContentCache } = await import('../../discord/contextCache');
    const result = await getOrCreateContentCache('gemini-1.5-pro', prompt, [], 'ace');
    expect(result).toBe('fallback-id');
    warnSpy.mockRestore();
  });

  it('handles Vertex fetch throwing an exception', async () => {
    jest.resetModules();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    mockFetch
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'after-throw-id' }), text: async () => '' });

    const prompt = 'g'.repeat(20_000);
    const { getOrCreateContentCache } = await import('../../discord/contextCache');
    const result = await getOrCreateContentCache('gemini-1.5-pro', prompt, [], 'ace');
    expect(result).toBe('after-throw-id');
    warnSpy.mockRestore();
  });

  it('includes tool declarations in Vertex cache body', async () => {
    jest.resetModules();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ name: 'vertex-tools-cache' }),
      text: async () => '',
    });

    const tools = [{ name: 'search', parameters: {} }];
    const prompt = 'h'.repeat(20_000);
    const { getOrCreateContentCache } = await import('../../discord/contextCache');
    await getOrCreateContentCache('gemini-1.5-pro', prompt, tools, 'ace');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools).toBeDefined();
    expect(body.tools[0].functionDeclarations).toEqual(tools);
  });
});
