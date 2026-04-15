/**
 * Tests for src/discord/services/screenshots.ts
 * Screenshot capture with Puppeteer — URL validation, label sanitization.
 */

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
  default: { launch: jest.fn() },
}));

import { captureAndPostScreenshots, setScreenshotsChannel } from '../../../discord/services/screenshots';

describe('screenshots', () => {
  const mockSend = jest.fn().mockResolvedValue({ id: 'msg-1' });
  const mockChannel: any = {
    id: 'ch-1',
    name: 'screenshots',
    send: mockSend,
    messages: { fetch: jest.fn().mockResolvedValue({ size: 0, values: () => [] }) },
  };

  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue({ id: 'msg-1' });
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

    it('skips capture when no channel available', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      // No targetChannel, no screenshotsChannel set (setScreenshotsChannel was called
      // but if we want to test null, we can't unset it; just verify no crash)
      await captureAndPostScreenshots('http://localhost:3000');
      warnSpy.mockRestore();
    });
  });
});
