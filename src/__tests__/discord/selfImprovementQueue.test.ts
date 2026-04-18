export {};

const mockQuery = jest.fn();

jest.mock('../../db/pool', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => mockQuery(...args) },
}));

import {
  claimNextSelfImprovementJob,
  enqueueSelfImprovementJob,
  markSelfImprovementJobCompleted,
  markSelfImprovementJobFailed,
} from '../../discord/selfImprovementQueue';

describe('selfImprovementQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('enqueues a durable self-improvement job', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 17 }] });
    const id = await enqueueSelfImprovementJob({
      packet: {
        managerAgentId: 'executive-assistant',
        stewardAgentId: 'operations-manager',
        consumerAgentId: 'opus',
        summary: 'queued',
        requests: [],
        recommendedLoopIds: [],
      },
      goal: 'Stabilize queue',
      conversationSummary: 'Summary',
      status: 'partial',
      directiveContext: 'context',
      groupchatChannelId: 'group-1',
      workspaceChannelId: 'thread-1',
    });

    expect(id).toBe(17);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO self_improvement_jobs'),
      [expect.objectContaining({ goal: 'Stabilize queue' }), expect.any(Number)],
    );
  });

  it('claims the next pending job', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 4,
        attempts: 1,
        max_attempts: 5,
        payload: {
          packet: {
            managerAgentId: 'executive-assistant',
            stewardAgentId: 'operations-manager',
            consumerAgentId: 'opus',
            summary: 'queued',
            requests: [],
            recommendedLoopIds: [],
          },
          goal: 'Stabilize queue',
          conversationSummary: 'Summary',
          status: 'partial',
          directiveContext: 'context',
          groupchatChannelId: 'group-1',
          workspaceChannelId: 'thread-1',
        },
      }],
    });

    const claimed = await claimNextSelfImprovementJob('instance-a');
    expect(claimed).toEqual(expect.objectContaining({ id: 4, attempts: 1, maxAttempts: 5 }));
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WITH next_job AS'), [expect.any(Number), 'instance-a']);
  });

  it('marks completed jobs complete', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await markSelfImprovementJobCompleted(9);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("SET status = 'completed'"), [9]);
  });

  it('marks failed jobs for retry when attempts remain', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await markSelfImprovementJobFailed(11, 2, 5, 'temporary failure');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('SET status = $2'), [11, 'retry', 'temporary failure', expect.any(Number)]);
  });
});