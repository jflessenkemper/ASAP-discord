import {
  buildLoggingEngineReport,
  resetLoggingEngineForTests,
  summarizeActivityRows,
} from '../../discord/loggingEngine';

describe('loggingEngine', () => {
  beforeEach(() => {
    resetLoggingEngineForTests();
  });

  it('summarizes activity rows into counts and recent errors', () => {
    const summary = summarizeActivityRows([
      { agent_id: 'executive-assistant', event: 'invoke', detail: 'started', ts: new Date().toISOString() },
      { agent_id: 'developer', event: 'tool', detail: 'read_file', ts: new Date().toISOString() },
      { agent_id: 'developer', event: 'error', detail: 'Tool loop timeout after 8 calls', ts: new Date().toISOString() },
    ]);

    expect(summary.totalEvents).toBe(3);
    expect(summary.errorCount).toBe(1);
    expect(summary.topAgents[0]).toContain('developer=2');
    expect(summary.recentErrors[0]).toContain('developer: Tool loop timeout');
  });

  it('renders a readable logging-engine report', () => {
    const report = buildLoggingEngineReport({
      capturedAt: Date.now(),
      activityWindowHours: 6,
      activity: {
        totalEvents: 12,
        errorCount: 1,
        topAgents: ['developer=5', 'executive-assistant=4'],
        eventBreakdown: ['tool=5', 'response=4', 'error=1'],
        recentErrors: ['developer: Tool loop timeout after 8 calls'],
      },
      channels: [
        { channelName: 'terminal', ageMs: 30_000, preview: 'Ace ran db_query -> selected 5 rows' },
        { channelName: 'agent-errors', ageMs: 90_000, preview: 'Recurring error pattern detected' },
      ],
    });

    expect(report).toContain('Logging Engine');
    expect(report).toContain('Events: 12 | errors: 1');
    expect(report).toContain('#terminal');
    expect(report).toContain('Recurring error pattern detected');
  });
});