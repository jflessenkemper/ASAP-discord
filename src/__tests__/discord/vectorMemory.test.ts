jest.mock('../../discord/activityLog', () => ({
  logAgentEvent: jest.fn(),
}));

import { logAgentEvent } from '../../discord/activityLog';
import {
  cleanupOldEmbeddings,
  recordAgentDecision,
  recordAgentLearning,
  recordSmokeInsight,
  recallRelevantContext,
  searchSimilarMemories,
  storeMemoryEmbedding,
} from '../../discord/vectorMemory';

describe('vectorMemory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps memory embedding storage disabled', async () => {
    await expect(storeMemoryEmbedding('executive-assistant', 'remember this')).resolves.toBe(false);
  });

  it('returns no search results while embeddings are disabled', async () => {
    await expect(searchSimilarMemories('deploy regression')).resolves.toEqual([]);
    await expect(recallRelevantContext('deploy regression')).resolves.toBe('');
  });

  it('does not log decision or learning storage when persistence is disabled', async () => {
    await expect(recordAgentDecision('executive-assistant', 'Ship it', 'tests are green')).resolves.toBe(false);
    await expect(recordAgentLearning('executive-assistant', 'Prefer Riley-first execution')).resolves.toBe(false);
    expect(logAgentEvent).not.toHaveBeenCalled();
  });

  it('keeps smoke insights best-effort and non-throwing', async () => {
    await expect(recordSmokeInsight(['discord'], false, 'All good')).resolves.toBeUndefined();
    expect(logAgentEvent).not.toHaveBeenCalled();
  });

  it('reports zero cleanup work when embeddings are disabled', async () => {
    await expect(cleanupOldEmbeddings()).resolves.toBe(0);
  });
});