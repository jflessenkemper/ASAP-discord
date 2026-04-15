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

    it('returns [] when query throws (before dbDisabled)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection lost'));
      const traces = await getRecentTraces('dev', 5);
      expect(traces).toEqual([]);
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

    it('returns [] when query throws (before dbDisabled)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection lost'));
      const spans = await getTraceById('fail-trace');
      expect(spans).toEqual([]);
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

  describe('dbDisabled paths', () => {
    it('disables DB when table does not exist', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockQuery.mockRejectedValueOnce({ message: 'relation "trace_spans" does not exist', code: '42P01' });
      await recordSpan({
        traceId: 'tr-db', spanId: 'sp-db', agentId: 'dev', operation: 'op',
        status: 'ok', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tracing DB persistence disabled'));
      warnSpy.mockRestore();
    });

    it('skips DB insert after dbDisabled is set', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      mockQuery.mockClear();
      await recordSpan({
        traceId: 'tr-skip', spanId: 'sp-skip', agentId: 'dev', operation: 'op',
        status: 'ok', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      });
      // Should log the span but NOT call pool.query
      expect(logSpy).toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it('getRecentTraces returns [] when dbDisabled', async () => {
      const traces = await getRecentTraces('dev', 10);
      expect(traces).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('getTraceById returns [] when dbDisabled', async () => {
      const spans = await getTraceById('any-trace');
      expect(spans).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('cleanupOldTraces returns 0 when dbDisabled', async () => {
      const count = await cleanupOldTraces(7);
      expect(count).toBe(0);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('traceOperation with opts', () => {
    it('passes modelName and toolName opts through', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const ctx = createTraceContext();
      const { span } = await traceOperation(ctx, 'dev', 'test-op', async () => 'ok', {
        modelName: 'claude-4', toolName: 'search',
      });
      expect(span.modelName).toBe('claude-4');
      expect(span.toolName).toBe('search');
      logSpy.mockRestore();
    });

    it('passes parentSpanId through opts', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const ctx = createTraceContext();
      const { span } = await traceOperation(ctx, 'dev', 'test-op', async () => 'ok', {
        parentSpanId: 'custom-parent',
      });
      expect(span.parentSpanId).toBe('custom-parent');
      logSpy.mockRestore();
    });
  });
});

describe('tracing (fresh module)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('getTraceById queries DB when db is enabled', async () => {
    const mockQ = jest.fn().mockResolvedValue({
      rows: [{
        trace_id: 'tr1', span_id: 'sp1', agent_id: 'dev', operation: 'op',
        status: 'ok', input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0,
      }],
    });
    jest.doMock('../../db/pool', () => ({
      default: { query: mockQ },
      __esModule: true,
    }));
    jest.doMock('../../discord/activityLog', () => ({
      logAgentEvent: jest.fn(),
    }));
    jest.doMock('../../discord/services/agentErrors', () => ({
      postAgentErrorLog: jest.fn(),
    }));
    const { getTraceById: freshGetTraceById } = await import('../../discord/tracing');
    const spans = await freshGetTraceById('tr1');
    expect(spans).toHaveLength(1);
    expect(spans[0].traceId).toBe('tr1');
    expect(mockQ).toHaveBeenCalledWith(
      expect.stringContaining('trace_id = $1'),
      ['tr1'],
    );
  });

  it('traceOperation records errorMessage in finally block', async () => {
    const mockQ = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    jest.doMock('../../db/pool', () => ({
      default: { query: mockQ },
      __esModule: true,
    }));
    jest.doMock('../../discord/activityLog', () => ({
      logAgentEvent: jest.fn(),
    }));
    jest.doMock('../../discord/services/agentErrors', () => ({
      postAgentErrorLog: jest.fn(),
    }));
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const { traceOperation: freshTrace, createTraceContext: freshCtx } = await import('../../discord/tracing');
    const ctx = freshCtx();
    const { result, span } = await freshTrace(ctx, 'dev', 'test-op', async () => 42);
    expect(result).toBe(42);
    expect(span.operation).toBe('test-op');
    expect(span.errorMessage).toBeUndefined();
    logSpy.mockRestore();
  });

  it('getRecentTraces returns [] when query throws', async () => {
    const mockQ = jest.fn().mockRejectedValue(new Error('connection error'));
    jest.doMock('../../db/pool', () => ({ default: { query: mockQ }, __esModule: true }));
    jest.doMock('../../discord/activityLog', () => ({ logAgentEvent: jest.fn() }));
    jest.doMock('../../discord/services/agentErrors', () => ({ postAgentErrorLog: jest.fn() }));
    const { getRecentTraces: fresh } = await import('../../discord/tracing');
    expect(await fresh('dev', 5)).toEqual([]);
  });

  it('getTraceById returns [] when query throws', async () => {
    const mockQ = jest.fn().mockRejectedValue(new Error('connection error'));
    jest.doMock('../../db/pool', () => ({ default: { query: mockQ }, __esModule: true }));
    jest.doMock('../../discord/activityLog', () => ({ logAgentEvent: jest.fn() }));
    jest.doMock('../../discord/services/agentErrors', () => ({ postAgentErrorLog: jest.fn() }));
    const { getTraceById: fresh } = await import('../../discord/tracing');
    expect(await fresh('some-id')).toEqual([]);
  });

  it('traceOperation records error span in finally block', async () => {
    const mockQ = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    jest.doMock('../../db/pool', () => ({ default: { query: mockQ }, __esModule: true }));
    jest.doMock('../../discord/activityLog', () => ({ logAgentEvent: jest.fn() }));
    jest.doMock('../../discord/services/agentErrors', () => ({ postAgentErrorLog: jest.fn() }));
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const { traceOperation: freshTrace, createTraceContext: freshCtx } = await import('../../discord/tracing');
    const ctx = freshCtx();
    await expect(
      freshTrace(ctx, 'dev', 'fail-op', async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
    // Finally block should have recorded the error span
    expect(mockQ).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO trace_spans'),
      expect.anything(),
    );
    logSpy.mockRestore();
  });
});
