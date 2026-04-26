import {
  createAgentExecutionReport,
  createExecutionMilestone,
  executeOpusPlan,
} from '../../discord/opusExecution';

describe('opusExecution', () => {
  it('creates agent execution reports with evidence and progress', () => {
    const report = createAgentExecutionReport({
      agentId: 'qa',
      summary: 'Checked regression coverage',
      durationMs: 1200,
      evidence: [{ kind: 'test', value: 'checkout.spec.ts' }],
    });

    expect(report.agentId).toBe('qa');
    expect(report.status).toBe('completed');
    expect(report.evidence).toEqual([{ kind: 'test', value: 'checkout.spec.ts' }]);
    expect(report.progress?.[0]).toEqual({
      stage: 'completed',
      message: 'Checked regression coverage',
      source: 'qa',
    });
  });

  it('aggregates specialist reports into an Opus summary', async () => {
    const milestones = [createExecutionMilestone('planned', 'Plan accepted', 'opus', 5)];
    const summary = await executeOpusPlan({
      executionId: 'exec-1',
      goal: 'Ship checkout fix',
      requestedBy: 'cortana',
      specialistReports: [
        {
          agentId: 'developer',
          status: 'completed',
          summary: 'Implemented the checkout fix',
          filesModified: ['src/checkout.ts'],
          toolsUsed: ['edit_file'],
          progress: milestones,
          issues: [],
          evidence: [{ kind: 'file', value: 'src/checkout.ts' }],
          loopReports: [],
          durationMs: 5000,
        },
        {
          agentId: 'qa',
          status: 'partial',
          summary: 'Regression checks still running',
          filesModified: [],
          toolsUsed: ['run_tests'],
          progress: [createExecutionMilestone('executing', 'Running regression tests', 'qa', 70)],
          issues: [{ scope: 'agent', message: 'Waiting for final assertions', severity: 'warn', source: 'qa' }],
          evidence: [{ kind: 'test', value: 'checkout.spec.ts' }],
          loopReports: [],
          durationMs: 2100,
        },
      ],
    });

    expect(summary.executionId).toBe('exec-1');
    expect(summary.status).toBe('partial');
    expect(summary.summary).toContain('developer: Implemented the checkout fix');
    expect(summary.summary).toContain('qa: Regression checks still running');
    expect(summary.recommendedUserUpdate).toContain('made progress');
    expect(summary.progress.some((item) => item.message.includes('Running regression tests'))).toBe(true);
    expect(summary.evidence).toEqual(
      expect.arrayContaining([
        { kind: 'file', value: 'src/checkout.ts' },
        { kind: 'test', value: 'checkout.spec.ts' },
      ]),
    );
  });

  it('becomes blocked when any report contains an error issue', async () => {
    const summary = await executeOpusPlan({
      executionId: 'exec-2',
      goal: 'Recover deployment',
      requestedBy: 'cortana',
      specialistReports: [
        createAgentExecutionReport({
          agentId: 'devops',
          summary: 'Deployment rollback failed',
          status: 'blocked',
          durationMs: 1800,
          issues: [{ scope: 'tool', message: 'Rollback command failed', severity: 'error', source: 'devops' }],
        }),
      ],
    });

    expect(summary.status).toBe('blocked');
    expect(summary.recommendedUserUpdate).toContain('blocker');
    expect(summary.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Rollback command failed', severity: 'error' }),
      ]),
    );
  });
});