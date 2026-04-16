import {
  buildLoopHealthCompactSummary,
  buildLoopHealthDetailedReport,
  recordLoopHealth,
  resetLoopHealthForTests,
} from '../../discord/loopHealth';

describe('loopHealth', () => {
  beforeEach(() => {
    resetLoopHealthForTests();
  });

  it('shows idle loops before anything has run', () => {
    const summary = buildLoopHealthCompactSummary();
    expect(summary).toContain('channel-heartbeat: never');
    expect(summary).toContain('database-audit: never');
  });

  it('records loop statuses and includes details in the detailed report', () => {
    recordLoopHealth('channel-heartbeat', 'ok', 'feeds healthy');
    recordLoopHealth('database-audit', 'warn', 'legacy=2 | drop=pending');

    const report = buildLoopHealthDetailedReport();
    expect(report).toContain('✅ Channel Heartbeat');
    expect(report).toContain('feeds healthy');
    expect(report).toContain('⚠️ Database Audit');
    expect(report).toContain('legacy=2 | drop=pending');
  });
});