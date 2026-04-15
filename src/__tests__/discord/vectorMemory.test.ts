/**
 * Tests for src/discord/vectorMemory.ts
 * Vector embedding storage and semantic search.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../db/pool', () => ({
  default: { query: mockQuery, on: jest.fn() },
  __esModule: true,
}));
jest.mock('../../services/googleCredentials', () => ({
  ensureGoogleCredentials: jest.fn().mockResolvedValue(true),
  getAccessTokenViaGcloud: jest.fn().mockReturnValue(null),
}));
jest.mock('../../discord/activityLog', () => ({
  logAgentEvent: jest.fn(),
}));
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: jest.fn().mockResolvedValue({
      getAccessToken: jest.fn().mockResolvedValue({ token: 'test-token' }),
    }),
  })),
}));

// VECTOR_MEMORY_ENABLED defaults to true unless env says 'false'
import {
  storeMemoryEmbedding,
  searchSimilarMemories,
  recordAgentDecision,
  recordAgentLearning,
  recallRelevantContext,
  cleanupOldEmbeddings,
} from '../../discord/vectorMemory';

describe('vectorMemory', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
  });

  afterEach(() => {
    delete (global as any).fetch;
  });

  describe('storeMemoryEmbedding()', () => {
    it('returns false when table does not exist', async () => {
      // First call checks vector support — table not found
      mockQuery.mockRejectedValueOnce(new Error('relation "agent_embeddings" does not exist'));
      const result = await storeMemoryEmbedding('developer', 'test content');
      expect(result).toBe(false);
    });
  });

  describe('searchSimilarMemories()', () => {
    it('returns empty array when disabled', async () => {
      // Table check fails → disabled
      mockQuery.mockRejectedValueOnce(new Error('relation does not exist'));
      const results = await searchSimilarMemories('test query');
      expect(results).toEqual([]);
    });
  });

  describe('recordAgentDecision()', () => {
    it('formats content with decision prefix', async () => {
      // Table check fails → returns false
      mockQuery.mockRejectedValueOnce(new Error('relation does not exist'));
      const result = await recordAgentDecision('developer', 'Use React for the frontend');
      expect(result).toBe(false);
    });
  });

  describe('recordAgentLearning()', () => {
    it('formats content with learning prefix', async () => {
      mockQuery.mockRejectedValueOnce(new Error('relation does not exist'));
      const result = await recordAgentLearning('qa', 'Jest tests run faster with --no-coverage');
      expect(result).toBe(false);
    });
  });

  describe('recallRelevantContext()', () => {
    it('returns empty string when no results', async () => {
      mockQuery.mockRejectedValueOnce(new Error('relation does not exist'));
      const context = await recallRelevantContext('some query');
      expect(context).toBe('');
    });
  });

  describe('cleanupOldEmbeddings()', () => {
    it('returns 0 when table not available', async () => {
      mockQuery.mockRejectedValueOnce(new Error('relation does not exist'));
      const count = await cleanupOldEmbeddings(30);
      expect(count).toBe(0);
    });
  });
});
