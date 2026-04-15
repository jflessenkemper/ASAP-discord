/**
 * Tests for src/discord/activityLog.ts
 * Agent activity logging, error deduplication, permission handling.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../db/pool', () => ({
  default: { query: mockQuery },
  __esModule: true,
}));
jest.mock('../../discord/services/agentErrors', () => ({
  postAgentErrorLog: jest.fn(),
}));

import { logAgentEvent } from '../../discord/activityLog';
import { postAgentErrorLog } from '../../discord/services/agentErrors';

describe('activityLog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('logAgentEvent()', () => {
    it('exercises shouldPostAgentError for a fresh agent', () => {
      // Use unique ids to ensure shouldPostAgentError code-path is fresh
      logAgentEvent('freshAgent1', 'error', 'brand new error msg 1');
      expect(postAgentErrorLog).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalled();
    });

    it('logs invoke events to database', () => {
      logAgentEvent('developer', 'invoke', 'Handling user message');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agent_activity_log'),
        expect.arrayContaining(['developer', 'invoke', 'Handling user message'])
      );
    });

    it('logs tool events', () => {
      logAgentEvent('developer', 'tool', 'read_file: src/app.ts');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT'),
        expect.arrayContaining(['developer', 'tool'])
      );
    });

    it('logs response events', () => {
      logAgentEvent('qa', 'response', 'Test results: 275 passed', { durationMs: 5000 });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT'),
        expect.arrayContaining(['qa', 'response', 'Test results: 275 passed', 5000])
      );
    });

    it('logs error events and posts to agent error channel', () => {
      logAgentEvent('developer', 'error', 'Connection refused');
      expect(postAgentErrorLog).toHaveBeenCalledWith(
        'agent:developer',
        'Connection refused',
        expect.objectContaining({ agentId: 'developer', level: 'error' })
      );
    });

    it('classifies rate limit errors as warn level', () => {
      logAgentEvent('developer', 'error', 'Rate limit exceeded');
      expect(postAgentErrorLog).toHaveBeenCalledWith(
        'agent:developer',
        'Rate limit exceeded',
        expect.objectContaining({ level: 'warn' })
      );
    });

    it('classifies quota exhausted as warn level', () => {
      logAgentEvent('developer', 'error', 'Quota exhausted for model');
      expect(postAgentErrorLog).toHaveBeenCalledWith(
        'agent:developer',
        'Quota exhausted for model',
        expect.objectContaining({ level: 'warn' })
      );
    });

    it('classifies daily token limit as warn level', () => {
      logAgentEvent('developer', 'error', 'Daily token limit reached');
      expect(postAgentErrorLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ level: 'warn' })
      );
    });

    it('classifies daily dollar budget as warn level', () => {
      logAgentEvent('developer', 'error', 'Daily dollar budget exceeded');
      expect(postAgentErrorLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ level: 'warn' })
      );
    });

    it('does not post error for user interrupts', () => {
      logAgentEvent('developer', 'error', 'Request interrupted by user');
      expect(postAgentErrorLog).not.toHaveBeenCalled();
    });

    it('deduplicates rapid error posts', () => {
      logAgentEvent('qa', 'error', 'Unique error message A');
      logAgentEvent('qa', 'error', 'Unique error message A');
      // Second call should be deduplicated
      expect(postAgentErrorLog).toHaveBeenCalledTimes(1);
    });

    it('logs with extra metadata', () => {
      logAgentEvent('developer', 'response', 'Done', {
        durationMs: 2000,
        tokensIn: 1000,
        tokensOut: 500,
      });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([2000, 1000, 500])
      );
    });

    it('truncates long detail strings', () => {
      const longDetail = 'x'.repeat(3000);
      logAgentEvent('developer', 'response', longDetail);
      // Should be called with truncated detail (max 2000 chars)
      const callArgs = mockQuery.mock.calls[0][1];
      expect(callArgs[2].length).toBeLessThanOrEqual(2000);
    });

    it('does not post for non-error events', () => {
      logAgentEvent('developer', 'invoke', 'Starting');
      logAgentEvent('developer', 'tool', 'read_file');
      logAgentEvent('developer', 'response', 'Done');
      logAgentEvent('developer', 'rate_limit', 'Limited');
      logAgentEvent('developer', 'cache', 'Hit');
      expect(postAgentErrorLog).not.toHaveBeenCalled();
    });

    it('includes meta details when extra params provided on error', () => {
      logAgentEvent('qa', 'error', 'Some new error X', {
        durationMs: 1234,
        tokensIn: 100,
        tokensOut: 50,
      });
      expect(postAgentErrorLog).toHaveBeenCalledWith(
        'agent:qa',
        'Some new error X',
        expect.objectContaining({ detail: 'durationMs=1234 tokensIn=100 tokensOut=50' })
      );
    });

    it('passes undefined detail when no extra meta', () => {
      logAgentEvent('qa', 'error', 'Another distinct error Q');
      expect(postAgentErrorLog).toHaveBeenCalledWith(
        'agent:qa',
        'Another distinct error Q',
        expect.objectContaining({ detail: undefined })
      );
    });

    it('uses "Agent error" as default when detail is undefined', () => {
      logAgentEvent('qa', 'error', undefined);
      expect(postAgentErrorLog).toHaveBeenCalledWith(
        'agent:qa',
        'Agent error',
        expect.anything()
      );
    });

    it('classifies resource_exhausted as warn', () => {
      logAgentEvent('qa', 'error', 'resource_exhausted for project');
      expect(postAgentErrorLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ level: 'warn' })
      );
    });

    it('classifies empty detail as error level', () => {
      logAgentEvent('dev', 'error', '');
      // empty detail → shouldPostAgentError returns true with empty key, classifyAgentErrorLevel('') returns 'error'
      // but empty string is falsy so 'Agent error' is used as message
      expect(postAgentErrorLog).toHaveBeenCalledWith(
        'agent:dev',
        'Agent error',
        expect.objectContaining({ level: 'error' })
      );
    });

    it('logs console.error for non-permission, non-42P01 errors', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockQuery.mockRejectedValueOnce(new Error('connection timeout'));

      logAgentEvent('dev2', 'memory', 'test memory event');
      await new Promise((r) => setImmediate(r));

      expect(spy).toHaveBeenCalledWith('Activity log write error:', 'connection timeout');
      spy.mockRestore();
    });

    it('silently ignores 42P01 (undefined table) errors', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const err = new Error('relation "agent_activity_log" does not exist');
      (err as any).code = '42P01';
      mockQuery.mockRejectedValueOnce(err);

      logAgentEvent('dev2', 'guardrail', 'test');
      await new Promise((r) => setImmediate(r));

      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('Activity log write error'), expect.anything());
      spy.mockRestore();
    });

    it('silently ignores pool-ended errors', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockQuery.mockRejectedValueOnce(new Error('Cannot use a pool after calling end on the pool'));

      logAgentEvent('dev2', 'memory', 'event');
      await new Promise((r) => setImmediate(r));

      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('Activity log write error'), expect.anything());
      spy.mockRestore();
    });

    it('cleans up stale entries when dedup map exceeds 2000', () => {
      // Freeze Date.now for the bulk inserts
      const baseTime = 1000000000;
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTime);

      // Fill the dedup map with > 2000 unique entries
      for (let i = 0; i < 2002; i++) {
        logAgentEvent(`cleanup-agent-${i}`, 'error', `unique-err-${i}`);
      }

      // Now advance time past the dedup window * 2 and add one more entry
      // The module uses Math.max(30000, ...) so AGENT_ERROR_DEDUPE_WINDOW_MS >= 30000
      // Cleanup threshold = AGENT_ERROR_DEDUPE_WINDOW_MS * 2 (at least 60000ms)
      dateNowSpy.mockReturnValue(baseTime + 400_000);
      logAgentEvent('cleanup-final', 'error', 'trigger-cleanup');

      dateNowSpy.mockRestore();
    });

    // This test MUST be last because it permanently sets activityLogDbDisabled=true in the module
    it('disables DB logging on permission denied error', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const permError = new Error('permission denied for relation agent_activity_log');
      (permError as any).code = '42501';
      mockQuery.mockRejectedValueOnce(permError);

      logAgentEvent('dev2', 'invoke', 'Starting fresh');
      // Flush microtask queue so .catch runs
      await new Promise((r) => setImmediate(r));

      expect(warnSpy).toHaveBeenCalledWith('Activity log DB persistence disabled due to permission error.');
      warnSpy.mockRestore();

      // Now the DB should be disabled — next call should NOT call mockQuery
      mockQuery.mockClear();
      logAgentEvent('dev2', 'invoke', 'After disable');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
