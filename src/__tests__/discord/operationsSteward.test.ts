import {
  buildSelfImprovementOpsUpdates,
  buildSelfImprovementPacket,
  deriveOperationsStewardRequests,
  formatOperationsStewardRequests,
} from '../../discord/operationsSteward';

describe('operationsSteward', () => {
  it('derives memory, logging, test, and loop-health stewardship requests from Opus issues', () => {
    const requests = deriveOperationsStewardRequests({
      goal: 'Stabilize deployment reporting',
      status: 'partial',
      summary: 'Deployment finished but reporting remained noisy.',
      issues: [
        { scope: 'runtime', severity: 'error', message: 'Ops channel updates were inconsistent', source: 'opus' },
      ],
    });

    expect(requests.some((request) => request.kind === 'remember')).toBe(true);
    expect(requests.some((request) => request.kind === 'logging')).toBe(true);
    expect(requests.some((request) => request.kind === 'test')).toBe(true);
    expect(requests.some((request) => request.kind === 'loop-health')).toBe(true);
  });

  it('formats steward requests for handoff prompts', () => {
    const text = formatOperationsStewardRequests([
      {
        kind: 'logging',
        summary: 'Refresh logging for deploy path',
        detail: 'deploy finished without enough evidence',
        recommendedLoopIds: ['logging-engine'],
      },
    ]);
    expect(text).toContain('[logging] Refresh logging for deploy path');
    expect(text).toContain('loops=logging-engine');
  });

  it('builds a Riley-managed self-improvement packet and ops updates', () => {
    const packet = buildSelfImprovementPacket({
      goal: 'Stabilize deployment reporting',
      status: 'partial',
      summary: 'Deployment finished but reporting remained noisy.',
      issues: [
        { scope: 'runtime', severity: 'warn', message: 'Ops channel updates were inconsistent', source: 'opus' },
      ],
    });

    expect(packet.managerAgentId).toBe('executive-assistant');
    expect(packet.consumerAgentId).toBe('opus');
    expect(packet.recommendedLoopIds).toEqual(expect.arrayContaining(['logging-engine', 'thread-status-reporter', 'memory-consolidation']));

    const updates = buildSelfImprovementOpsUpdates(packet, [
      {
        loopId: 'logging-engine',
        status: 'completed',
        summary: 'Logging engine snapshot refreshed.',
      },
    ]);

    expect(updates.map((update) => update.channelKey)).toEqual(expect.arrayContaining(['thread-status', 'loops', 'upgrades']));
  });
});