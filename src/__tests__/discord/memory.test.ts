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

    it('compresses when history exceeds threshold', async () => {
      const { summarizeConversation } = require('../../discord/claude');
      (summarizeConversation as jest.Mock).mockResolvedValue('A comprehensive detailed summary of the full conversation thread covering topics discussed.');

      const history: ConversationMessage[] = [];
      for (let i = 0; i < 100; i++) {
        history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message number ${i} with some content` });
      }
      saveMemory('compress-test-agent', history);
      await compressMemory('compress-test-agent');
      const loaded = loadMemory('compress-test-agent');
      // After compression, history should be smaller than original
      expect(loaded.length).toBeLessThan(100);
    });

    it('skips if compression already in progress', async () => {
      const history: ConversationMessage[] = [];
      for (let i = 0; i < 100; i++) {
        history.push({ role: 'user', content: `msg-${i}` });
      }
      saveMemory('dedup-compress-agent', history);
      // Start two compressions simultaneously
      const p1 = compressMemory('dedup-compress-agent');
      const p2 = compressMemory('dedup-compress-agent');
      await Promise.all([p1, p2]);
      // Should not throw
    });

    it('handles summarization failure gracefully', async () => {
      const { summarizeConversation } = require('../../discord/claude');
      (summarizeConversation as jest.Mock).mockRejectedValueOnce(new Error('LLM error'));

      const history: ConversationMessage[] = [];
      for (let i = 0; i < 100; i++) {
        history.push({ role: 'user', content: `msg-${i}` });
      }
      saveMemory('fail-compress-agent', history);
      await compressMemory('fail-compress-agent');
      // Should not throw, history should remain intact
      const loaded = loadMemory('fail-compress-agent');
      expect(loaded.length).toBeGreaterThan(0);
    });

    it('keeps summary when generated summary is too short', async () => {
      const { summarizeConversation } = require('../../discord/claude');
      (summarizeConversation as jest.Mock).mockResolvedValue('x');

      const history: ConversationMessage[] = [];
      for (let i = 0; i < 100; i++) {
        history.push({ role: 'user', content: `msg-${i}` });
      }
      saveMemory('short-summary-agent', history);
      await compressMemory('short-summary-agent');
      const loaded = loadMemory('short-summary-agent');
      // History should remain unchanged since summary was too short
      expect(loaded.length).toBe(100);
    });
  });

  // ─── initMemory ───

  describe('initMemory()', () => {
    it('is a no-op after already initialized', async () => {
      await initMemory();
      // Should not throw, second call is a no-op
      expect(mockQuery).not.toHaveBeenCalledWith(
        expect.stringContaining('SELECT file_name, content'),
        undefined,
      );
    });
  });

  // ─── getMemoryContext with summary ───

  describe('getMemoryContext() with summary', () => {
    it('triggers compression when history exceeds threshold', () => {
      const history: ConversationMessage[] = [];
      for (let i = 0; i < 90; i++) {
        history.push({ role: 'user', content: `msg-${i}` });
      }
      saveMemory('trigger-compress-agent', history);
      const ctx = getMemoryContext('trigger-compress-agent', 10);
      // Should return limited context
      expect(ctx.length).toBeLessThanOrEqual(11);
    });
  });

  // ─── saveMemory edge cases ───

  describe('saveMemory() edge cases', () => {
    it('trims extremely long histories', () => {
      const history: ConversationMessage[] = [];
      for (let i = 0; i < 3000; i++) {
        history.push({ role: 'user', content: `msg-${i}` });
      }
      saveMemory('huge-history-agent', history);
      const loaded = loadMemory('huge-history-agent');
      expect(loaded.length).toBeLessThanOrEqual(2000);
    });

    it('compacts persisted content with code blocks', () => {
      const codeContent = '```\n' + 'x'.repeat(2000) + '\n```';
      const messages: ConversationMessage[] = [
        { role: 'assistant', content: codeContent },
      ];
      saveMemory('code-block-agent', messages);
      const loaded = loadMemory('code-block-agent');
      expect(loaded.length).toBe(1);
    });

    it('handles permission denied on debounced write', () => {
      mockQuery.mockRejectedValueOnce({ code: '42501', message: 'permission denied for table agent_memory' });
      saveMemory('perm-denied-agent', [{ role: 'user', content: 'test' }]);
      jest.advanceTimersByTime(3000);
      // Should not throw
    });
  });

  // ─── clearMemory edge cases ───

  describe('clearMemory() edge cases', () => {
    it('handles permission denied on delete', () => {
      mockQuery.mockRejectedValueOnce({ code: '42501', message: 'permission denied' });
      clearMemory('perm-delete-agent');
      // Should not throw
    });

    it('handles generic DB error on delete', () => {
      mockQuery.mockRejectedValueOnce(new Error('connection lost'));
      clearMemory('err-delete-agent');
      // Should not throw
    });
  });

  // ─── flushPendingWrites edge cases ───

  describe('flushPendingWrites() edge cases', () => {
    it('handles permission denied during flush', async () => {
      mockQuery.mockRejectedValue({ code: '42501', message: 'permission denied' });
      saveMemory('flush-perm-agent', [{ role: 'user', content: 'test' }]);
      await flushPendingWrites();
      // Should not throw
    });

    it('handles generic error during flush', async () => {
      mockQuery.mockRejectedValue(new Error('write failure'));
      saveMemory('flush-err-agent', [{ role: 'user', content: 'test' }]);
      await flushPendingWrites();
      // Should not throw
    });
  });

  // ─── compactPersistedContent + trimMiddle ───

  describe('content compaction', () => {
    it('trims long content in messages', () => {
      const longContent = 'A'.repeat(5000);
      const messages: ConversationMessage[] = [
        { role: 'user', content: longContent },
      ];
      saveMemory('long-content-agent', messages);
      const loaded = loadMemory('long-content-agent');
      expect(loaded[0].content.length).toBeLessThan(5000);
    });

    it('strips trailing whitespace and collapses blank lines', () => {
      const messyContent = 'line1   \n\n\n\nline2\r\nline3';
      const messages: ConversationMessage[] = [
        { role: 'user', content: messyContent },
      ];
      saveMemory('messy-agent', messages);
      const loaded = loadMemory('messy-agent');
      expect(loaded[0].content).not.toContain('\r\n');
      expect(loaded[0].content).not.toMatch(/\n{3,}/);
    });

    it('handles empty content', () => {
      const messages: ConversationMessage[] = [
        { role: 'user', content: '' },
      ];
      saveMemory('empty-content-agent', messages);
      const loaded = loadMemory('empty-content-agent');
      expect(loaded[0].content).toBe('');
    });
  });

  // ─── isLowValueAck filtering ───

  describe('low-value ack filtering during compression', () => {
    it('filters out simple ack messages during compression', async () => {
      const { summarizeConversation } = require('../../discord/claude');
      (summarizeConversation as jest.Mock).mockResolvedValue('A comprehensive summary of the conversation covering all key topics discussed.');

      const history: ConversationMessage[] = [];
      for (let i = 0; i < 90; i++) {
        if (i % 3 === 0) {
          history.push({ role: 'assistant', content: 'Ok.' });
        } else {
          history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Important message ${i}` });
        }
      }
      saveMemory('ack-filter-agent', history);
      await compressMemory('ack-filter-agent');
      const loaded = loadMemory('ack-filter-agent');
      expect(loaded.length).toBeLessThan(90);
    });
  });

  // ─── staged compression path ───

  describe('staged compression', () => {
    it('uses multi-stage summarization for large histories', async () => {
      const { summarizeConversation } = require('../../discord/claude');
      (summarizeConversation as jest.Mock).mockResolvedValue('A comprehensive detailed summary covering all conversation topics and actions taken.');

      // Need >24 messages to compress (COMPRESS_STAGE_MIN_MESSAGES default) and COMPRESS_STAGE_PARTS=3
      const history: ConversationMessage[] = [];
      for (let i = 0; i < 120; i++) {
        history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Staged message ${i} with enough content to be meaningful` });
      }
      saveMemory('staged-compress-agent', history);
      await compressMemory('staged-compress-agent');
      const loaded = loadMemory('staged-compress-agent');
      expect(loaded.length).toBeLessThan(120);
      // summarizeConversation should have been called multiple times (staged)
      expect((summarizeConversation as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('falls back to single-pass when partials are empty', async () => {
      const { summarizeConversation } = require('../../discord/claude');
      // First calls return empty for stage partials, last returns valid summary
      (summarizeConversation as jest.Mock)
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('')
        .mockResolvedValue('Fallback single-pass summary covering all the key details and topics in conversation.');

      const history: ConversationMessage[] = [];
      for (let i = 0; i < 100; i++) {
        history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Fallback message ${i}` });
      }
      saveMemory('fallback-stage-agent', history);
      await compressMemory('fallback-stage-agent');
      const loaded = loadMemory('fallback-stage-agent');
      expect(loaded.length).toBeLessThan(100);
    });
  });
});
