/**
 * Tests for src/discord/services/screenshots.ts
 * Screenshot capture with Puppeteer — URL validation, label sanitization, full capture flow.
 */

const mockScreenshot = jest.fn().mockResolvedValue(Buffer.from('fake-png'));
const mockGoto = jest.fn().mockResolvedValue(undefined);
const mockWaitForSelector = jest.fn().mockResolvedValue(undefined);
const mockWaitForNetworkIdle = jest.fn().mockResolvedValue(undefined);
const mockSetViewport = jest.fn();
const mockSetUserAgent = jest.fn();
const mockPageClose = jest.fn();
const mockClick = jest.fn();
const mockDollar = jest.fn().mockResolvedValue(null);
const mockPageObj = {
  goto: mockGoto,
  waitForSelector: mockWaitForSelector,
  waitForNetworkIdle: mockWaitForNetworkIdle,
  setViewport: mockSetViewport,
  setUserAgent: mockSetUserAgent,
  screenshot: mockScreenshot,
  close: mockPageClose,
  click: mockClick,
  $: mockDollar,
};
const mockBrowserClose = jest.fn();
const mockNewPage = jest.fn().mockResolvedValue(mockPageObj);
const mockLaunch = jest.fn().mockResolvedValue({
  newPage: mockNewPage,
  close: mockBrowserClose,
});

jest.mock('../../../db/pool', () => ({
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), on: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../discord/services/agentErrors', () => ({
  postAgentErrorLog: jest.fn(),
}));
jest.mock('../../../discord/services/browserRuntime', () => ({
  PUPPETEER_LAUNCH_ARGS: ['--no-sandbox'],
  resolvePuppeteerExecutablePath: jest.fn().mockReturnValue('/usr/bin/chromium'),
}));
jest.mock('puppeteer', () => ({
  __esModule: true,
  default: { launch: mockLaunch },
}));

import { captureAndPostScreenshots, setScreenshotsChannel } from '../../../discord/services/screenshots';

describe('screenshots', () => {
  const mockSend = jest.fn().mockResolvedValue({ id: 'msg-1' });
  const mockBulkDelete = jest.fn().mockResolvedValue(undefined);
  const mockMsgDelete = jest.fn().mockResolvedValue(undefined);
  const mockFetchMessages = jest.fn();
  const mockChannel: any = {
    id: 'ch-1',
    name: 'screenshots',
    send: mockSend,
    messages: { fetch: mockFetchMessages },
    bulkDelete: mockBulkDelete,
  };

  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue({ id: 'msg-1' });
    mockFetchMessages.mockReset().mockResolvedValue({ size: 0, values: () => [] });
    mockScreenshot.mockReset().mockResolvedValue(Buffer.from('fake-png'));
    mockPageClose.mockReset().mockResolvedValue(undefined);
    mockGoto.mockReset().mockResolvedValue(undefined);
    mockWaitForSelector.mockReset().mockResolvedValue(undefined);
    mockWaitForNetworkIdle.mockReset().mockResolvedValue(undefined);
    mockDollar.mockReset().mockResolvedValue(null);
    mockBulkDelete.mockReset().mockResolvedValue(undefined);
    // Do NOT reset mockLaunch/mockNewPage — browserPool keeps a reference
  });

  describe('setScreenshotsChannel()', () => {
    it('does not throw', () => {
      expect(() => setScreenshotsChannel(mockChannel)).not.toThrow();
    });
  });

  describe('URL validation', () => {
    it('refuses URLs not in allowlist', async () => {
      await captureAndPostScreenshots('https://evil.com/steal', undefined, { targetChannel: mockChannel });
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('not in allowlist'));
    });

    it('refuses another external URL', async () => {
      await captureAndPostScreenshots('https://attacker.io/phish', undefined, { targetChannel: mockChannel });
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('not in allowlist'));
    });

    it('refuses ftp URLs', async () => {
      await captureAndPostScreenshots('ftp://files.evil.com/file', undefined, { targetChannel: mockChannel });
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('not in allowlist'));
    });
  });

  describe('capture flow', () => {
    it('captures screenshots and posts to channel for allowed URL', async () => {
      setScreenshotsChannel(mockChannel);

      await captureAndPostScreenshots('http://localhost:3000', 'test-build', {
        targetChannel: mockChannel,
        clearTargetChannel: false,
      });

      expect(mockNewPage).toHaveBeenCalled();
      expect(mockSetViewport).toHaveBeenCalled();
      expect(mockSetUserAgent).toHaveBeenCalled();
      expect(mockGoto).toHaveBeenCalled();
      expect(mockScreenshot).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('Build Screenshots'));
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('Captured'));
    }, 30000);

    it('accepts Cloud Run URLs', async () => {
      await captureAndPostScreenshots('https://asap-frontend-abc123.run.app/', 'cr-build', {
        targetChannel: mockChannel,
        clearTargetChannel: false,
      });
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('Build Screenshots'));
    }, 30000);

    it('clears channel when clearTargetChannel is true', async () => {
      mockFetchMessages
        .mockResolvedValueOnce({
          size: 2,
          values: () => [
            { delete: mockMsgDelete },
            { delete: mockMsgDelete },
          ],
        })
        .mockResolvedValueOnce({ size: 0, values: () => [] });

      await captureAndPostScreenshots('http://localhost:3000', 'test', {
        targetChannel: mockChannel,
        clearTargetChannel: true,
      });

      expect(mockFetchMessages).toHaveBeenCalled();
    }, 30000);

    it('falls back to individual delete when bulkDelete fails', async () => {
      const msgDelete = jest.fn().mockResolvedValue(undefined);
      mockFetchMessages
        .mockResolvedValueOnce({
          size: 1,
          values: () => [{ delete: msgDelete }],
        })
        .mockResolvedValueOnce({ size: 0, values: () => [] });

      mockBulkDelete.mockRejectedValueOnce(new Error('bulk delete failed'));

      await captureAndPostScreenshots('http://localhost:3000', 'test', {
        targetChannel: mockChannel,
        clearTargetChannel: true,
      });

      expect(msgDelete).toHaveBeenCalled();
    }, 30000);

    it('handles screenshot error for a screen', async () => {
      mockScreenshot.mockRejectedValueOnce(new Error('screenshot error'));

      await captureAndPostScreenshots('http://localhost:3000', 'test', {
        targetChannel: mockChannel,
        clearTargetChannel: false,
      });

      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('Could not capture'));
    }, 30000);

    it('reports capture already in progress', async () => {
      // Start first capture — it will hold the lock
      const firstCapture = captureAndPostScreenshots('http://localhost:3000', 'first', {
        targetChannel: mockChannel,
        clearTargetChannel: false,
      });

      // Immediately start second capture — should be rejected
      await captureAndPostScreenshots('http://localhost:3000', 'second', {
        targetChannel: mockChannel,
        clearTargetChannel: false,
      });

      await firstCapture;
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('already in progress'));
    }, 30000);

    it('sanitizes label to prevent mention injection', async () => {
      await captureAndPostScreenshots('http://localhost:3000', '@everyone hack', {
        targetChannel: mockChannel,
        clearTargetChannel: false,
      });

      const calls = mockSend.mock.calls.map((c: any) => (typeof c[0] === 'string' ? c[0] : ''));
      const buildMsg = calls.find((s: string) => s.includes('Build Screenshots'));
      expect(buildMsg).toBeDefined();
      expect(buildMsg).not.toContain('@everyone');
    }, 30000);

    it('uses fallback label when none provided', async () => {
      await captureAndPostScreenshots('http://localhost:3000', undefined, {
        targetChannel: mockChannel,
        clearTargetChannel: false,
      });

      const calls = mockSend.mock.calls.map((c: any) => (typeof c[0] === 'string' ? c[0] : ''));
      const buildMsg = calls.find((s: string) => s.includes('Build Screenshots'));
      expect(buildMsg).toBeTruthy();
    }, 30000);

    it('handles navigation timeout by retrying with load', async () => {
      mockGoto
        .mockRejectedValueOnce(new Error('Navigation timeout exceeded'))
        .mockResolvedValue(undefined);

      await captureAndPostScreenshots('http://localhost:3000', 'test', {
        targetChannel: mockChannel,
        clearTargetChannel: false,
      });

      // Initial goto + retry + SCREENS goto calls
      expect(mockGoto.mock.calls.length).toBeGreaterThanOrEqual(2);
    }, 30000);

    it('handles non-timeout navigation error', async () => {
      mockGoto.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));

      await captureAndPostScreenshots('http://localhost:3000', 'test', {
        targetChannel: mockChannel,
        clearTargetChannel: false,
      });

      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('capture failed'));
    }, 30000);

    it('clears channel by default when targetChannel matches screenshotsChannel', async () => {
      setScreenshotsChannel(mockChannel);
      mockFetchMessages.mockResolvedValue({ size: 0, values: () => [] });

      await captureAndPostScreenshots('http://localhost:3000', 'test', {
        targetChannel: mockChannel,
      });

      expect(mockFetchMessages).toHaveBeenCalled();
    }, 30000);

    it('reuses browser pool on second capture', async () => {
      await captureAndPostScreenshots('http://localhost:3000', 'first', {
        targetChannel: mockChannel,
        clearTargetChannel: false,
      });
      const launchCount = mockLaunch.mock.calls.length;

      await captureAndPostScreenshots('http://localhost:3000', 'second', {
        targetChannel: mockChannel,
        clearTargetChannel: false,
      });

      // Browser pool reuses the browser from first call
      expect(mockLaunch.mock.calls.length).toBe(launchCount);
    }, 30000);
  });
});
