jest.mock('../../../discord/services/opsFeed', () => ({
  postOpsLine: jest.fn().mockResolvedValue(undefined),
}));

import { setAgentErrorChannel, postAgentErrorLog } from '../../../discord/services/agentErrors';
import { postOpsLine } from '../../../discord/services/opsFeed';

const mockPostOpsLine = postOpsLine as jest.MockedFunction<typeof postOpsLine>;

describe('agentErrors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAgentErrorChannel(null);
  });

  describe('postAgentErrorLog', () => {
    it('does nothing when channel not set', async () => {
      await postAgentErrorLog('test-source', 'something broke');
      expect(mockPostOpsLine).not.toHaveBeenCalled();
    });

    it('posts error-level ops line by default', async () => {
      const chan = { id: 'ch-1' } as any;
      setAgentErrorChannel(chan);
      await postAgentErrorLog('claude', 'model timeout');
      expect(mockPostOpsLine).toHaveBeenCalledWith(chan, expect.objectContaining({
        scope: expect.stringContaining('agent-error:claude'),
        severity: 'error',
        action: 'inspect stack trace and recover service',
      }));
    });

    it('posts warn-level when extra.level is warn', async () => {
      const chan = { id: 'ch-1' } as any;
      setAgentErrorChannel(chan);
      await postAgentErrorLog('tools', 'retry needed', { level: 'warn' });
      expect(mockPostOpsLine).toHaveBeenCalledWith(chan, expect.objectContaining({
        severity: 'warn',
        action: 'monitor and retry if recurring',
      }));
    });

    it('posts info-level with action none', async () => {
      const chan = { id: 'ch-1' } as any;
      setAgentErrorChannel(chan);
      await postAgentErrorLog('system', 'startup complete', { level: 'info' });
      expect(mockPostOpsLine).toHaveBeenCalledWith(chan, expect.objectContaining({
        severity: 'info',
        action: 'none',
      }));
    });

    it('includes agentId as actor', async () => {
      const chan = { id: 'ch-1' } as any;
      setAgentErrorChannel(chan);
      await postAgentErrorLog('source', 'msg', { agentId: 'developer' });
      expect(mockPostOpsLine).toHaveBeenCalledWith(chan, expect.objectContaining({
        actor: 'developer',
      }));
    });

    it('uses "system" as default actor when no agentId', async () => {
      const chan = { id: 'ch-1' } as any;
      setAgentErrorChannel(chan);
      await postAgentErrorLog('source', 'msg');
      expect(mockPostOpsLine).toHaveBeenCalledWith(chan, expect.objectContaining({
        actor: 'system',
      }));
    });

    it('sanitizes @everyone/@here mentions', async () => {
      const chan = { id: 'ch-1' } as any;
      setAgentErrorChannel(chan);
      await postAgentErrorLog('src', '@everyone broke it', { detail: '@here is bad' });
      const call = mockPostOpsLine.mock.calls[0][1];
      expect(call.metric).not.toContain('@everyone');
      expect(call.delta).not.toContain('@here');
    });

    it('sanitizes user mentions', async () => {
      const chan = { id: 'ch-1' } as any;
      setAgentErrorChannel(chan);
      await postAgentErrorLog('src', '<@!123456> caused error');
      const call = mockPostOpsLine.mock.calls[0][1];
      expect(call.metric).not.toContain('<@!123456>');
    });

    it('sanitizes triple backticks', async () => {
      const chan = { id: 'ch-1' } as any;
      setAgentErrorChannel(chan);
      await postAgentErrorLog('src', 'code ```block``` error');
      const call = mockPostOpsLine.mock.calls[0][1];
      expect(call.metric).not.toContain('```');
    });

    it('truncates long messages', async () => {
      const chan = { id: 'ch-1' } as any;
      setAgentErrorChannel(chan);
      await postAgentErrorLog('src', 'x'.repeat(500));
      const call = mockPostOpsLine.mock.calls[0][1];
      expect(call.metric.length).toBeLessThanOrEqual(180);
    });

    it('truncates long detail', async () => {
      const chan = { id: 'ch-1' } as any;
      setAgentErrorChannel(chan);
      await postAgentErrorLog('src', 'msg', { detail: 'y'.repeat(1000) });
      const call = mockPostOpsLine.mock.calls[0][1];
      // delta includes "instance=... detail=..." prefix, but full detail is truncated to 420 chars
      expect(call.delta.length).toBeLessThanOrEqual(600);
    });
  });
});
