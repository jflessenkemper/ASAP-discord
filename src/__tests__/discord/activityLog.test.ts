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
  });
});
