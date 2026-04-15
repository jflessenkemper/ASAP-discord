/**
 * Tests for src/discord/vectorMemory.ts
 * Vector embedding storage and semantic search.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../db/pool', () => ({
  default: { query: mockQuery, on: jest.fn() },
  __esModule: true,
}));
const mockEnsureGoogleCredentials = jest.fn().mockResolvedValue(true);
const mockGetAccessTokenViaGcloud = jest.fn().mockReturnValue(null);
jest.mock('../../services/googleCredentials', () => ({
  ensureGoogleCredentials: mockEnsureGoogleCredentials,
  getAccessTokenViaGcloud: mockGetAccessTokenViaGcloud,
}));
const mockLogAgentEvent = jest.fn();
jest.mock('../../discord/activityLog', () => ({
  logAgentEvent: mockLogAgentEvent,
}));

let mockGetClient: jest.Mock;
let mockGetAccessToken: jest.Mock;
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => {
    mockGetAccessToken = jest.fn().mockResolvedValue({ token: 'test-token' });
    mockGetClient = jest.fn().mockResolvedValue({ getAccessToken: mockGetAccessToken });
    return { getClient: mockGetClient };
  }),
}));

describe('vectorMemory', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockLogAgentEvent.mockReset();
    mockEnsureGoogleCredentials.mockReset().mockResolvedValue(true);
    mockGetAccessTokenViaGcloud.mockReset().mockReturnValue(null);
    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
    // Reset env for each test
    delete process.env.VECTOR_MEMORY_ENABLED;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_USE_VERTEX_AI;
    delete process.env.VERTEX_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });

  afterEach(() => {
    delete (global as any).fetch;
  });

  describe('when VECTOR_MEMORY_ENABLED=false', () => {
    it('storeMemoryEmbedding returns false', async () => {
      process.env.VECTOR_MEMORY_ENABLED = 'false';
      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      const result = await storeMemoryEmbedding('dev', 'content');
      expect(result).toBe(false);
    });

    it('searchSimilarMemories returns empty', async () => {
      process.env.VECTOR_MEMORY_ENABLED = 'false';
      const { searchSimilarMemories } = await import('../../discord/vectorMemory');
      expect(await searchSimilarMemories('q')).toEqual([]);
    });

    it('recallRelevantContext returns empty string', async () => {
      process.env.VECTOR_MEMORY_ENABLED = 'false';
      const { recallRelevantContext } = await import('../../discord/vectorMemory');
      expect(await recallRelevantContext('q')).toBe('');
    });
  });

  describe('checkVectorSupport', () => {
    it('disables when agent_embeddings table does not exist', async () => {
      mockQuery.mockRejectedValueOnce(new Error('relation "agent_embeddings" does not exist'));
      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      expect(await storeMemoryEmbedding('dev', 'content')).toBe(false);
    });

    it('caches DB availability after first check', async () => {
      // First call: table exists
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      // No embedding API → false
      expect(await storeMemoryEmbedding('dev', 'content')).toBe(false);
      // Second call should NOT re-query the table check
      expect(await storeMemoryEmbedding('dev', 'content2')).toBe(false);
      // Only one SELECT 1 FROM agent_embeddings call (first check)
      expect(mockQuery.mock.calls.filter((c: any[]) => String(c[0]).includes('agent_embeddings LIMIT 0')).length).toBe(1);
    });
  });

  describe('generateEmbedding via Vertex AI', () => {
    it('returns embedding via Vertex when configured', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1, 0.2, 0.3] } }] }),
        text: async () => '',
      });

      // Table exists
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT succeeds
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      const result = await storeMemoryEmbedding('dev', 'test content');
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('aiplatform.googleapis.com'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('returns null when VERTEX_PROJECT_ID is empty', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      delete process.env.VERTEX_PROJECT_ID;
      delete process.env.GOOGLE_CLOUD_PROJECT;

      // Table exists
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      expect(await storeMemoryEmbedding('dev', 'content')).toBe(false);
    });

    it('returns null when Vertex embedding API returns error', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      expect(await storeMemoryEmbedding('dev', 'content')).toBe(false);
    });

    it('returns null when Vertex embedding response has no values', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      expect(await storeMemoryEmbedding('dev', 'content')).toBe(false);
    });

    it('returns null when Vertex fetch throws', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockRejectedValue(new Error('network error'));
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      expect(await storeMemoryEmbedding('dev', 'content')).toBe(false);
    });
  });

  describe('generateEmbedding via Google AI Studio', () => {
    it('returns null when no GEMINI_API_KEY', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      expect(await storeMemoryEmbedding('dev', 'content')).toBe(false);
    });

    it('generates embedding via API key', async () => {
      process.env.GEMINI_API_KEY = 'test-key';

      jest.doMock('@google/generative-ai', () => ({
        GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
          getGenerativeModel: jest.fn().mockReturnValue({
            embedContent: jest.fn().mockResolvedValue({
              embedding: { values: [0.1, 0.2, 0.3] },
            }),
          }),
        })),
      }));

      mockQuery.mockResolvedValueOnce({ rows: [] }); // table check
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      const result = await storeMemoryEmbedding('dev', 'test content');
      expect(result).toBe(true);
    });

    it('returns null when embedContent throws', async () => {
      process.env.GEMINI_API_KEY = 'test-key';

      jest.doMock('@google/generative-ai', () => ({
        GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
          getGenerativeModel: jest.fn().mockReturnValue({
            embedContent: jest.fn().mockRejectedValue(new Error('API error')),
          }),
        })),
      }));

      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      expect(await storeMemoryEmbedding('dev', 'content')).toBe(false);
    });

    it('returns null when embedContent returns empty values', async () => {
      process.env.GEMINI_API_KEY = 'test-key';

      jest.doMock('@google/generative-ai', () => ({
        GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
          getGenerativeModel: jest.fn().mockReturnValue({
            embedContent: jest.fn().mockResolvedValue({
              embedding: { values: [] },
            }),
          }),
        })),
      }));

      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      expect(await storeMemoryEmbedding('dev', 'content')).toBe(false);
    });
  });

  describe('getVertexAccessToken', () => {
    it('recovers from default credentials error via ensureGoogleCredentials', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      // Make first getClient throw ADC error, then succeed after recovery
      const { GoogleAuth } = require('google-auth-library');
      let callCount = 0;
      (GoogleAuth as jest.Mock).mockImplementation(() => ({
        getClient: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) throw new Error('Application Default Credentials are not set');
          return { getAccessToken: jest.fn().mockResolvedValue({ token: 'recovered-token' }) };
        }),
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      const result = await storeMemoryEmbedding('dev', 'test');
      expect(result).toBe(true);
    });

    it('falls back to gcloud CLI token when recovery fails', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      const { GoogleAuth } = require('google-auth-library');
      (GoogleAuth as jest.Mock).mockImplementation(() => ({
        getClient: jest.fn().mockRejectedValue(new Error('Application Default Credentials are not set')),
      }));
      mockEnsureGoogleCredentials.mockResolvedValue(false);
      mockGetAccessTokenViaGcloud.mockReturnValue('cli-token');

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      const result = await storeMemoryEmbedding('dev', 'test');
      expect(result).toBe(true);
    });

    it('throws when ADC recovery and gcloud CLI both fail', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      const { GoogleAuth } = require('google-auth-library');
      (GoogleAuth as jest.Mock).mockImplementation(() => ({
        getClient: jest.fn().mockRejectedValue(new Error('Application Default Credentials are not set')),
      }));
      mockEnsureGoogleCredentials.mockResolvedValue(false);
      mockGetAccessTokenViaGcloud.mockReturnValue(null);

      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      // Should return false due to embedding failure
      expect(await storeMemoryEmbedding('dev', 'test')).toBe(false);
    });

    it('re-throws non-ADC errors', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      const { GoogleAuth } = require('google-auth-library');
      (GoogleAuth as jest.Mock).mockImplementation(() => ({
        getClient: jest.fn().mockRejectedValue(new Error('network timeout')),
      }));

      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      // Returns false because embedding generation catches the error
      expect(await storeMemoryEmbedding('dev', 'test')).toBe(false);
    });

    it('handles access token as string', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      const { GoogleAuth } = require('google-auth-library');
      (GoogleAuth as jest.Mock).mockImplementation(() => ({
        getClient: jest.fn().mockResolvedValue({
          getAccessToken: jest.fn().mockResolvedValue('string-token'),
        }),
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      expect(await storeMemoryEmbedding('dev', 'test')).toBe(true);
    });

    it('throws when access token is null/empty', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      const { GoogleAuth } = require('google-auth-library');
      (GoogleAuth as jest.Mock).mockImplementation(() => ({
        getClient: jest.fn().mockResolvedValue({
          getAccessToken: jest.fn().mockResolvedValue({ token: '' }),
        }),
      }));

      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      expect(await storeMemoryEmbedding('dev', 'test')).toBe(false);
    });
  });

  describe('storeMemoryEmbedding()', () => {
    it('returns false when table does not exist', async () => {
      mockQuery.mockRejectedValueOnce(new Error('relation "agent_embeddings" does not exist'));
      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      const result = await storeMemoryEmbedding('developer', 'test content');
      expect(result).toBe(false);
    });

    it('stores embedding with metadata', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1, 0.2] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // table check
      mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      const result = await storeMemoryEmbedding('dev', 'test', { type: 'test' });
      expect(result).toBe(true);
      // Verify INSERT query includes metadata
      const insertCall = mockQuery.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT'));
      expect(insertCall).toBeDefined();
      expect(insertCall![1]).toContain(JSON.stringify({ type: 'test' }));
    });

    it('stores embedding without metadata (null)', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1, 0.2] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      const result = await storeMemoryEmbedding('dev', 'no meta content');
      expect(result).toBe(true);
      const insertCall = mockQuery.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT'));
      expect(insertCall![1][4]).toBeNull();
    });

    it('returns false when INSERT fails', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1, 0.2] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // table check
      mockQuery.mockRejectedValueOnce(new Error('DB write error')); // INSERT fails

      const { storeMemoryEmbedding } = await import('../../discord/vectorMemory');
      expect(await storeMemoryEmbedding('dev', 'content')).toBe(false);
    });
  });

  describe('searchSimilarMemories()', () => {
    it('returns empty array when table not available', async () => {
      mockQuery.mockRejectedValueOnce(new Error('relation does not exist'));
      const { searchSimilarMemories } = await import('../../discord/vectorMemory');
      const results = await searchSimilarMemories('test query');
      expect(results).toEqual([]);
    });

    it('returns results with agentId filter', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1, 0.2] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // table check
      mockQuery.mockResolvedValueOnce({
        rows: [
          { content: 'result 1', agent_id: 'dev', similarity: '0.85', metadata: { type: 'decision' } },
        ],
      });

      const { searchSimilarMemories } = await import('../../discord/vectorMemory');
      const results = await searchSimilarMemories('query', 'dev', 3);
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('result 1');
      expect(results[0].similarity).toBeCloseTo(0.85);
      expect(results[0].agentId).toBe('dev');
      expect(results[0].metadata).toEqual({ type: 'decision' });
    });

    it('returns results without agentId filter', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1, 0.2] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // table check
      mockQuery.mockResolvedValueOnce({
        rows: [{ content: 'global result', agent_id: 'dev', similarity: '0.9', metadata: null }],
      });

      const { searchSimilarMemories } = await import('../../discord/vectorMemory');
      const results = await searchSimilarMemories('query');
      expect(results).toHaveLength(1);
      expect(results[0].metadata).toBeUndefined();
    });

    it('returns empty when embedding is null', async () => {
      // No API key, no Vertex → embedding returns null
      mockQuery.mockResolvedValueOnce({ rows: [] }); // table check
      const { searchSimilarMemories } = await import('../../discord/vectorMemory');
      expect(await searchSimilarMemories('q')).toEqual([]);
    });

    it('returns empty array when query throws', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1, 0.2] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // table check
      mockQuery.mockRejectedValueOnce(new Error('query error')); // search fails

      const { searchSimilarMemories } = await import('../../discord/vectorMemory');
      expect(await searchSimilarMemories('query', 'dev')).toEqual([]);
    });
  });

  describe('recordAgentDecision()', () => {
    it('formats content with decision prefix and logs on success', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // table check
      mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT

      const { recordAgentDecision } = await import('../../discord/vectorMemory');
      const result = await recordAgentDecision('dev', 'Use React', 'Frontend framework choice');
      expect(result).toBe(true);
      expect(mockLogAgentEvent).toHaveBeenCalledWith('dev', 'memory', expect.stringContaining('decision'));
    });

    it('includes context in content when provided', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const { recordAgentDecision } = await import('../../discord/vectorMemory');
      await recordAgentDecision('dev', 'Use React', 'Frontend choice');
      const insertCall = mockQuery.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT'));
      expect(insertCall![1][1]).toContain('Context: Frontend choice');
    });

    it('does not log when store fails', async () => {
      mockQuery.mockRejectedValueOnce(new Error('no table'));
      const { recordAgentDecision } = await import('../../discord/vectorMemory');
      await recordAgentDecision('dev', 'decision');
      expect(mockLogAgentEvent).not.toHaveBeenCalled();
    });
  });

  describe('recordAgentLearning()', () => {
    it('stores with learning prefix and logs on success', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const { recordAgentLearning } = await import('../../discord/vectorMemory');
      const result = await recordAgentLearning('qa', 'Tests run faster with --no-coverage');
      expect(result).toBe(true);
      expect(mockLogAgentEvent).toHaveBeenCalledWith('qa', 'memory', expect.stringContaining('learning'));
    });

    it('does not log when store fails', async () => {
      mockQuery.mockRejectedValueOnce(new Error('no table'));
      const { recordAgentLearning } = await import('../../discord/vectorMemory');
      await recordAgentLearning('qa', 'learning');
      expect(mockLogAgentEvent).not.toHaveBeenCalled();
    });
  });

  describe('recallRelevantContext()', () => {
    it('returns empty string when no results', async () => {
      mockQuery.mockRejectedValueOnce(new Error('relation does not exist'));
      const { recallRelevantContext } = await import('../../discord/vectorMemory');
      const context = await recallRelevantContext('some query');
      expect(context).toBe('');
    });

    it('returns formatted context when results exist', async () => {
      process.env.GEMINI_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'test-project';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ predictions: [{ embeddings: { values: [0.1] } }] }),
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // table check
      mockQuery.mockResolvedValueOnce({
        rows: [
          { content: 'past decision', agent_id: 'dev', similarity: '0.9', metadata: null },
          { content: 'another item', agent_id: 'qa', similarity: '0.8', metadata: null },
        ],
      });

      const { recallRelevantContext } = await import('../../discord/vectorMemory');
      const context = await recallRelevantContext('query', 'dev');
      expect(context).toContain('Relevant past context');
      expect(context).toContain('past decision');
      expect(context).toContain('90%');
    });
  });

  describe('cleanupOldEmbeddings()', () => {
    it('returns 0 when table not available', async () => {
      mockQuery.mockRejectedValueOnce(new Error('relation does not exist'));
      const { cleanupOldEmbeddings } = await import('../../discord/vectorMemory');
      const count = await cleanupOldEmbeddings(30);
      expect(count).toBe(0);
    });

    it('returns deleted count when successful', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // table check
      mockQuery.mockResolvedValueOnce({ rowCount: 5 }); // DELETE

      const { cleanupOldEmbeddings } = await import('../../discord/vectorMemory');
      const count = await cleanupOldEmbeddings(90);
      expect(count).toBe(5);
    });

    it('returns 0 when DELETE fails', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // table check
      mockQuery.mockRejectedValueOnce(new Error('DB error')); // DELETE fails

      const { cleanupOldEmbeddings } = await import('../../discord/vectorMemory');
      expect(await cleanupOldEmbeddings()).toBe(0);
    });

    it('returns 0 when rowCount is null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // table check
      mockQuery.mockResolvedValueOnce({ rowCount: null }); // DELETE with null count

      const { cleanupOldEmbeddings } = await import('../../discord/vectorMemory');
      expect(await cleanupOldEmbeddings()).toBe(0);
    });
  });
});
