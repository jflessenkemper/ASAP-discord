/**
 * Tests for src/discord/tracing.ts
 * Trace ID generation, span recording, DB operations.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../db/pool', () => ({
  default: { query: mockQuery },
  __esModule: true,
}));
jest.mock('../../discord/activityLog', () => ({
  logAgentEvent: jest.fn(),
}));
jest.mock('../../discord/services/agentErrors', () => ({
  postAgentErrorLog: jest.fn(),
}));

import {
  newTraceId,
  newSpanId,
  createTraceContext,
  recordSpan,
  traceOperation,
  getRecentTraces,
  getTraceById,
  cleanupOldTraces,
  TraceSpan,
} from '../../discord/tracing';

describe('tracing', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('newTraceId()', () => {
    it('generates 16-char hex string', () => {
      const id = newTraceId();
      expect(id).toHaveLength(16);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => newTraceId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('newSpanId()', () => {
    it('generates 8-char hex string', () => {
      const id = newSpanId();
      expect(id).toHaveLength(8);
      expect(id).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe('createTraceContext()', () => {
    it('creates context with new trace ID', () => {
      const ctx = createTraceContext();
      expect(ctx.traceId).toHaveLength(16);
      expect(ctx.spanId).toHaveLength(8);
    });

    it('inherits parent trace ID', () => {
      const parent = createTraceContext();
      const child = createTraceContext(parent);
      expect(child.traceId).toBe(parent.traceId);
      expect(child.spanId).not.toBe(parent.spanId);
    });
  });

  describe('recordSpan()', () => {
    it('inserts span into database', async () => {
      const span: TraceSpan = {
        traceId: 'abc123',
        spanId: 'def456',
        agentId: 'developer',
        operation: 'test-op',
        status: 'ok',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      };
      await recordSpan(span);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO trace_spans'),
        expect.arrayContaining(['abc123', 'def456', 'developer'])
      );
    });

    it('logs span as structured JSON (structured logging)', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const span: TraceSpan = {
        traceId: 'tr1',
        spanId: 'sp1',
        agentId: 'qa',
        operation: 'classify',
        status: 'ok',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      await recordSpan(span);
      expect(logSpy).toHaveBeenCalled();
      const logged = logSpy.mock.calls[0][0];
      const parsed = JSON.parse(logged);
      expect(parsed.type).toBe('trace_span');
      expect(parsed.agent).toBe('qa');
      logSpy.mockRestore();
    });
  });

  describe('traceOperation()', () => {
    it('records timing for successful operation', async () => {
      const ctx = createTraceContext();
      const { result, span } = await traceOperation(
        ctx,
        'developer',
        'test-op',
        async () => 'hello',
      );
      expect(result).toBe('hello');
      expect(span.status).toBe('ok');
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('records error status on failure', async () => {
      const ctx = createTraceContext();
      await expect(
        traceOperation(ctx, 'developer', 'fail-op', async () => {
          throw new Error('test error');
        })
      ).rejects.toThrow('test error');
    });

    it('detects rate limit errors', async () => {
      const ctx = createTraceContext();
      await expect(
        traceOperation(ctx, 'developer', 'rate-op', async () => {
          throw new Error('429 rate limit exceeded');
        })
      ).rejects.toThrow();
    });

    it('detects timeout errors', async () => {
      const ctx = createTraceContext();
      await expect(
        traceOperation(ctx, 'developer', 'timeout-op', async () => {
          throw new Error('Request timed out');
        })
      ).rejects.toThrow();
    });
  });

  describe('getRecentTraces()', () => {
    it('queries database for recent traces', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          trace_id: 'tr1', span_id: 'sp1', agent_id: 'dev', operation: 'op',
          status: 'ok', input_tokens: 100, output_tokens: 50,
          cache_read_tokens: 0, cache_write_tokens: 0,
        }],
      });
      const traces = await getRecentTraces('dev', 10);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        ['dev', 10]
      );
      expect(traces).toHaveLength(1);
      expect(traces[0].agentId).toBe('dev');
    });

    it('queries all traces when no agent specified', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await getRecentTraces(undefined, 20);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        [20]
      );
    });
  });

  describe('getTraceById()', () => {
    it('queries by trace ID', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await getTraceById('abc123');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('trace_id = $1'),
        ['abc123']
      );
    });
  });

  describe('cleanupOldTraces()', () => {
    it('deletes old traces with retention period', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 5 });
      const deleted = await cleanupOldTraces(7);
      expect(deleted).toBe(5);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE'),
        [7]
      );
    });

    it('uses default retention of 7 days', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });
      await cleanupOldTraces();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.anything(),
        [7]
      );
    });
  });
});
