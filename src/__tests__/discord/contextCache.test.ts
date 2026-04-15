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
  });

  describe('evictExpiredCaches', () => {
    it('runs without error', () => {
      expect(() => evictExpiredCaches()).not.toThrow();
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
