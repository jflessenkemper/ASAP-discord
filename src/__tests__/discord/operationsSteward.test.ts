import { deriveOperationsStewardRequests, formatOperationsStewardRequests } from '../../discord/operationsSteward';

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
});