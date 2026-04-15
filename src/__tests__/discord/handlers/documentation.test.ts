jest.mock('../../../discord/services/opsFeed', () => ({
  postOpsLine: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../utils/errors', () => ({
  errMsg: jest.fn((e: unknown) => String(e)),
}));

import { setBotChannels, documentToChannel } from '../../../discord/handlers/documentation';
import { postOpsLine } from '../../../discord/services/opsFeed';

const mockPostOpsLine = postOpsLine as jest.MockedFunction<typeof postOpsLine>;

describe('documentation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setBotChannels(null as any);
  });

  describe('documentToChannel', () => {
    it('does nothing when channels not set', async () => {
      await documentToChannel('developer', 'Did stuff');
      expect(mockPostOpsLine).not.toHaveBeenCalled();
    });

    it('does nothing when terminal channel is missing', async () => {
      setBotChannels({ terminal: null } as any);
      await documentToChannel('developer', 'Did stuff');
      expect(mockPostOpsLine).not.toHaveBeenCalled();
    });

    it('posts ops line when channels are set', async () => {
      const mockChannel = { id: 'test-channel' };
      setBotChannels({ terminal: mockChannel } as any);
      await documentToChannel('developer', 'Did some work');
      expect(mockPostOpsLine).toHaveBeenCalledWith(mockChannel, expect.objectContaining({
        actor: 'developer',
        scope: 'agent-doc',
        metric: 'summary',
        severity: 'info',
      }));
    });

    it('truncates summary to 600 chars', async () => {
      const mockChannel = { id: 'test-channel' };
      setBotChannels({ terminal: mockChannel } as any);
      const longSummary = 'x'.repeat(1000);
      await documentToChannel('qa', longSummary);
      expect(mockPostOpsLine).toHaveBeenCalledWith(mockChannel, expect.objectContaining({
        delta: expect.any(String),
      }));
      const call = mockPostOpsLine.mock.calls[0][1];
      expect(call.delta.length).toBeLessThanOrEqual(600);
    });

    it('handles postOpsLine errors gracefully', async () => {
      const mockChannel = { id: 'test-channel' };
      setBotChannels({ terminal: mockChannel } as any);
      mockPostOpsLine.mockRejectedValueOnce(new Error('Discord error'));
      const spy = jest.spyOn(console, 'error').mockImplementation();
      await expect(documentToChannel('dev', 'test')).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
