jest.mock('../../discord/activityLog', () => ({
  logAgentEvent: jest.fn(),
}));

import { executeLoopAdapter } from '../../discord/loopAdapters';

describe('loopAdapters', () => {
  it('returns a partial report for unsupported event-driven loops', async () => {
    const report = await executeLoopAdapter('voice-session');
    expect(report.loopId).toBe('voice-session');
    expect(report.status).toBe('partial');
    expect(report.summary).toContain('does not have a dedicated callable adapter yet');
  });
});