/**
 * Tests for src/discord/memory.ts
 * Persistent memory — DB wrappers, cache, init, compression trigger.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../db/pool', () => ({
  __esModule: true,
  default: { query: mockQuery, on: jest.fn() },
}));
jest.mock('../../discord/activityLog', () => ({
  logAgentEvent: jest.fn(),
}));
jest.mock('../../discord/claude', () => ({
  summarizeConversation: jest.fn().mockResolvedValue('summary of conversation'),
}));

import {
  upsertMemory,
  appendMemoryRow,
  readMemoryRow,
  initMemory,
  loadMemory,
  saveMemory,
  appendToMemory,
  clearMemory,
  getMemoryContext,
  flushPendingWrites,
  compressMemory,
} from '../../discord/memory';
import type { ConversationMessage } from '../../discord/claude';

describe('memory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── DB Wrapper Functions ───

  describe('upsertMemory()', () => {
    it('calls pool.query with upsert SQL', async () => {
      await upsertMemory('test-file', 'test content');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agent_memory'),
        ['test-file', 'test content'],
      );
    });

    it('uses ON CONFLICT DO UPDATE', async () => {
      await upsertMemory('key', 'value');
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('ON CONFLICT');
      expect(sql).toContain('DO UPDATE');
    });
  });

  describe('appendMemoryRow()', () => {
    it('appends content and returns total length', async () => {
      mockQuery.mockResolvedValue({ rows: [{ total_len: 42 }] });
      const len = await appendMemoryRow('log-file', 'new line');
      expect(len).toBe(42);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agent_memory'),
        ['log-file', 'new line'],
      );
    });

    it('returns content length when no rows returned', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const len = await appendMemoryRow('log-file', 'twelve chars');
      expect(len).toBe('twelve chars'.length);
    });
  });

  describe('readMemoryRow()', () => {
    it('returns content when row exists', async () => {
      mockQuery.mockResolvedValue({ rows: [{ content: 'stored data' }] });
      const result = await readMemoryRow('test-file');
      expect(result).toBe('stored data');
    });

    it('returns null when row does not exist', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const result = await readMemoryRow('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ─── Cache Functions ───

  describe('loadMemory()', () => {
    it('returns empty array for unknown agent', () => {
      const result = loadMemory('unknown-agent-xyz');
      expect(result).toEqual([]);
    });

    it('returns same array reference on repeated calls', () => {
      const a = loadMemory('cache-test-agent');
      const b = loadMemory('cache-test-agent');
      expect(a).toBe(b);
    });
  });

  describe('saveMemory()', () => {
    it('stores messages in cache immediately', () => {
      const messages: ConversationMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];
      saveMemory('save-test-agent', messages);
      const loaded = loadMemory('save-test-agent');
      expect(loaded).toHaveLength(2);
      expect(loaded[0].content).toBe('Hello');
    });

    it('debounces DB write (does not write immediately)', () => {
      saveMemory('debounce-agent', [{ role: 'user', content: 'test' }]);
      // Should not have called upsertMemory (via pool.query) yet
      const upsertCalls = mockQuery.mock.calls.filter(
        (c: any[]) => String(c[0]).includes('INSERT INTO agent_memory') && String(c[1]?.[0]).startsWith('conv-'),
      );
      expect(upsertCalls).toHaveLength(0);
    });

    it('writes to DB after debounce timeout', () => {
      saveMemory('flush-agent', [{ role: 'user', content: 'hello' }]);
      jest.advanceTimersByTime(3000);
      const upsertCalls = mockQuery.mock.calls.filter(
        (c: any[]) => String(c[0]).includes('INSERT INTO agent_memory') && String(c[1]?.[0]).startsWith('conv-'),
      );
      expect(upsertCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('appendToMemory()', () => {
    it('appends messages to existing history', () => {
      const initial: ConversationMessage[] = [{ role: 'user', content: 'First' }];
      saveMemory('append-agent', initial);

      appendToMemory('append-agent', [{ role: 'assistant', content: 'Second' }]);
      const loaded = loadMemory('append-agent');
      expect(loaded.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('clearMemory()', () => {
    it('removes agent from cache', () => {
      saveMemory('clear-agent', [{ role: 'user', content: 'bye' }]);
      clearMemory('clear-agent');
      const loaded = loadMemory('clear-agent');
      expect(loaded).toEqual([]);
    });

    it('issues DB delete', () => {
      clearMemory('db-clear-agent');
      const deleteCalls = mockQuery.mock.calls.filter(
        (c: any[]) => String(c[0]).includes('DELETE FROM agent_memory'),
      );
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── getMemoryContext ───

  describe('getMemoryContext()', () => {
    it('returns history up to maxMessages', () => {
      const history: ConversationMessage[] = [];
      for (let i = 0; i < 30; i++) {
        history.push({ role: 'user', content: `msg-${i}` });
      }
      saveMemory('context-agent', history);

      const ctx = getMemoryContext('context-agent', 10);
      expect(ctx.length).toBeLessThanOrEqual(11); // max 10 + possible summary
    });

    it('returns full history when under maxMessages', () => {
      const history: ConversationMessage[] = [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ];
      saveMemory('small-agent', history);
      const ctx = getMemoryContext('small-agent', 20);
      expect(ctx).toHaveLength(2);
    });
  });

  // ─── flushPendingWrites ───

  describe('flushPendingWrites()', () => {
    it('resolves without error', async () => {
      await expect(flushPendingWrites()).resolves.not.toThrow();
    });

    it('flushes pending debounced writes', async () => {
      saveMemory('pending-agent', [{ role: 'user', content: 'pending' }]);
      await flushPendingWrites();
      // After flush, the DB write should have been issued
      const upsertCalls = mockQuery.mock.calls.filter(
        (c: any[]) => String(c[0]).includes('INSERT INTO agent_memory') && String(c[1]?.[0]).startsWith('conv-'),
      );
      expect(upsertCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── compressMemory ───

  describe('compressMemory()', () => {
    it('does nothing when history is below threshold', async () => {
      saveMemory('short-agent', [{ role: 'user', content: 'just one' }]);
      await compressMemory('short-agent');
      // No compression should happen
      const loaded = loadMemory('short-agent');
      expect(loaded.length).toBeLessThanOrEqual(2);
    });
  });
});
