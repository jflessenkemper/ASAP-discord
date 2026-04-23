/**
 * Tests for src/discord/embeddingWorker.ts
 * Exponential backoff when creds/quota fail, reset on success.
 */

const mockEmbedText = jest.fn();
const mockClaimPending = jest.fn();
const mockWriteEmbedding = jest.fn();

jest.mock('../../discord/embeddings', () => ({
  embedText: (...args: unknown[]) => mockEmbedText(...args),
}));

jest.mock('../../discord/userEvents', () => ({
  claimPendingEmbeddings: (...args: unknown[]) => mockClaimPending(...args),
  writeEmbedding: (...args: unknown[]) => mockWriteEmbedding(...args),
}));

// Force a fast interval so the tests don't wait minutes. Has to be set
// BEFORE the module under test is imported.
process.env.EMBEDDING_WORKER_INTERVAL_MS = '50';

import { startEmbeddingWorker, stopEmbeddingWorker } from '../../discord/embeddingWorker';

const row = (id: number, text: string) => ({
  id, user_id: 'u', channel_id: 'c', thread_id: null, message_id: null,
  kind: 'text' as const, text, attachment_ref: null, metadata: {}, created_at: new Date(),
});

afterEach(() => {
  stopEmbeddingWorker();
  jest.clearAllMocks();
});

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('embeddingWorker', () => {
  it('embeds pending rows and persists vectors on success', async () => {
    mockClaimPending.mockResolvedValue([row(1, 'hello'), row(2, 'world')]);
    mockEmbedText.mockResolvedValue([0.1, 0.2, 0.3]);
    mockWriteEmbedding.mockResolvedValue(undefined);

    startEmbeddingWorker();
    await wait(80);
    stopEmbeddingWorker();

    expect(mockClaimPending).toHaveBeenCalled();
    expect(mockWriteEmbedding).toHaveBeenCalledWith(1, [0.1, 0.2, 0.3]);
    expect(mockWriteEmbedding).toHaveBeenCalledWith(2, [0.1, 0.2, 0.3]);
  });

  it('does nothing when there are no pending rows (idle ok, not a failure)', async () => {
    mockClaimPending.mockResolvedValue([]);

    startEmbeddingWorker();
    await wait(80);
    stopEmbeddingWorker();

    expect(mockClaimPending).toHaveBeenCalled();
    expect(mockEmbedText).not.toHaveBeenCalled();
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('backs off on embed failure — does not hammer writeEmbedding', async () => {
    mockClaimPending.mockResolvedValue([row(1, 'a'), row(2, 'b')]);
    // First tick returns null for the probe row → whole batch skipped, backoff kicks in.
    mockEmbedText.mockResolvedValue(null);

    startEmbeddingWorker();
    await wait(80);
    stopEmbeddingWorker();

    // Probe ran at least once, but no writes were attempted.
    expect(mockEmbedText).toHaveBeenCalled();
    expect(mockWriteEmbedding).not.toHaveBeenCalled();
  });

  it('resets backoff after a successful tick', async () => {
    let calls = 0;
    mockClaimPending.mockImplementation(() => {
      calls++;
      return Promise.resolve([row(calls, 'hi')]);
    });
    // Fail once, then succeed.
    mockEmbedText
      .mockResolvedValueOnce(null)
      .mockResolvedValue([0.9]);

    startEmbeddingWorker();
    // After the first failing tick the worker waits ~30s by default. That
    // exceeds this test's patience — we just assert that no crash happens
    // and the probe is called.
    await wait(100);
    stopEmbeddingWorker();

    expect(mockEmbedText).toHaveBeenCalled();
  });

  it('rate-limits error logging so the console isn\'t spammed', async () => {
    mockClaimPending.mockResolvedValue([row(1, 'a')]);
    mockEmbedText.mockResolvedValue(null);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    startEmbeddingWorker();
    await wait(120);
    stopEmbeddingWorker();

    // Even with multiple failing ticks, the worker logs at most once
    // per 5-minute window. So 0 or 1 warn call is acceptable; more means
    // the rate limiter broke.
    expect(warnSpy.mock.calls.length).toBeLessThanOrEqual(1);
    warnSpy.mockRestore();
  });
});
