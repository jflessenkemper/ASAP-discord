jest.mock('../../discord/services/opsFeed', () => ({
  postOpsLine: jest.fn().mockResolvedValue(undefined),
  formatOpsLine: jest.fn(() => 'ops-line'),
}));

const recordAgentLearning = jest.fn().mockResolvedValue(undefined);

jest.mock('../../discord/vectorMemory', () => ({
  recordAgentLearning: (...args: unknown[]) => recordAgentLearning(...args),
}));

import { postAgentErrorLog, setAgentErrorChannel } from '../../discord/services/agentErrors';

describe('agentErrors', () => {
  beforeEach(() => {
    recordAgentLearning.mockClear();
    setAgentErrorChannel({} as any);
  });

  it('records recurring system errors under operations-manager ownership', async () => {
    await postAgentErrorLog('discord:test', 'Synthetic failure', { detail: 'first' });
    await postAgentErrorLog('discord:test', 'Synthetic failure', { detail: 'second' });
    await postAgentErrorLog('discord:test', 'Synthetic failure', { detail: 'third' });

    await new Promise((resolve) => setImmediate(resolve));

    expect(recordAgentLearning).toHaveBeenCalledWith(
      'operations-manager',
      expect.stringContaining('Recurring error pattern (3x in <1h): source=discord:test, message=Synthetic failure')
    );
  });
});