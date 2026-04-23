/**
 * Tests for src/discord/userEvents.ts
 * Unified capture DAO — text, voice, image, reaction, button, edit, decision.
 */

const mockQuery = jest.fn();
jest.mock('../../db/pool', () => ({
  default: { query: mockQuery },
  __esModule: true,
}));

import {
  recordUserEvent,
  getRecentUserEvents,
  searchUserEventsByEmbedding,
  claimPendingEmbeddings,
  writeEmbedding,
} from '../../discord/userEvents';

describe('userEvents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('recordUserEvent()', () => {
    it('inserts a minimal text event and returns the new id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });

      const id = await recordUserEvent({
        userId: 'user_123',
        channelId: 'chan_456',
        kind: 'text',
        text: 'hello',
      });

      expect(id).toBe(42);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_events'),
        expect.arrayContaining(['user_123', 'chan_456', null, null, 'text', 'hello', null]),
      );
    });

    it('serializes metadata as JSON', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 });

      await recordUserEvent({
        userId: 'u',
        channelId: 'c',
        kind: 'reaction',
        metadata: { emoji: '👍', targetAuthorId: 'x' },
      });

      const params = (mockQuery.mock.calls[0] as unknown[])[1] as unknown[];
      const metadata = params[7];
      expect(typeof metadata).toBe('string');
      expect(JSON.parse(metadata as string)).toEqual({ emoji: '👍', targetAuthorId: 'x' });
    });

    it('defaults metadata to empty object when omitted', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      await recordUserEvent({ userId: 'u', channelId: 'c', kind: 'text' });

      const params = (mockQuery.mock.calls[0] as unknown[])[1] as unknown[];
      expect(JSON.parse(params[7] as string)).toEqual({});
    });

    it('returns null and logs when the insert fails — never throws', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection reset'));
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const id = await recordUserEvent({ userId: 'u', channelId: 'c', kind: 'text' });

      expect(id).toBeNull();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('[userEvents] recordUserEvent failed'),
        expect.any(String),
      );
      errSpy.mockRestore();
    });

    it('passes all optional fields through to the query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 });

      await recordUserEvent({
        userId: 'u',
        channelId: 'c',
        threadId: 't',
        messageId: 'm',
        kind: 'image',
        text: '[Image: foo.png]',
        attachmentRef: 'https://cdn.discord/foo.png',
      });

      const params = (mockQuery.mock.calls[0] as unknown[])[1] as unknown[];
      expect(params).toEqual([
        'u', 'c', 't', 'm', 'image', '[Image: foo.png]', 'https://cdn.discord/foo.png', '{}',
      ]);
    });
  });

  describe('getRecentUserEvents()', () => {
    it('queries newest-first with the requested limit', async () => {
      const row = {
        id: 1, user_id: 'u', channel_id: 'c', thread_id: null, message_id: null,
        kind: 'text', text: 'hi', attachment_ref: null, metadata: {}, created_at: new Date(),
      };
      mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

      const out = await getRecentUserEvents('u', 5);

      expect(out).toEqual([row]);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringMatching(/ORDER BY created_at DESC\s+LIMIT/),
        ['u', 5],
      );
    });

    it('defaults to a limit of 20', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await getRecentUserEvents('u');

      expect((mockQuery.mock.calls[0] as unknown[])[1]).toEqual(['u', 20]);
    });

    it('returns [] on query failure, never throws', async () => {
      mockQuery.mockRejectedValueOnce(new Error('boom'));
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const out = await getRecentUserEvents('u');

      expect(out).toEqual([]);
      errSpy.mockRestore();
    });
  });

  describe('searchUserEventsByEmbedding()', () => {
    it('returns [] for empty embedding without hitting the DB', async () => {
      const out = await searchUserEventsByEmbedding('u', []);
      expect(out).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('formats the embedding as a pgvector literal', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await searchUserEventsByEmbedding('u', [0.1, 0.2, 0.3], 3);

      const params = (mockQuery.mock.calls[0] as unknown[])[1] as unknown[];
      expect(params[0]).toBe('u');
      expect(params[1]).toBe('[0.1,0.2,0.3]');
      expect(params[2]).toBe(3);
      expect((mockQuery.mock.calls[0] as unknown[])[0]).toMatch(/embedding <=> \$2::vector/);
    });

    it('returns matching rows including similarity', async () => {
      const row = {
        id: 1, user_id: 'u', channel_id: 'c', thread_id: null, message_id: null,
        kind: 'text', text: 'hi', attachment_ref: null, metadata: {},
        created_at: new Date(), similarity: 0.9,
      };
      mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

      const out = await searchUserEventsByEmbedding('u', [1, 2]);
      expect(out).toEqual([row]);
    });
  });

  describe('embedding worker helpers', () => {
    it('claimPendingEmbeddings selects only rows without embeddings but with text', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await claimPendingEmbeddings(25);

      const sql = (mockQuery.mock.calls[0] as unknown[])[0] as string;
      expect(sql).toMatch(/WHERE embedding IS NULL AND text IS NOT NULL/);
      expect((mockQuery.mock.calls[0] as unknown[])[1]).toEqual([25]);
    });

    it('writeEmbedding sets embedding + embedded_at and ignores empty vectors', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await writeEmbedding(9, [0.5, 0.6]);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringMatching(/embedded_at = NOW\(\)/),
        [9, '[0.5,0.6]'],
      );

      mockQuery.mockClear();
      await writeEmbedding(10, []);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
