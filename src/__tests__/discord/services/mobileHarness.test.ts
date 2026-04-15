import { mobileHarnessStop } from '../../../discord/services/mobileHarness';

/* ── mocks ─────────────────────────────────────────────────── */

jest.mock('../../../discord/services/browserRuntime', () => ({
  PUPPETEER_LAUNCH_ARGS: ['--no-sandbox'],
  resolvePuppeteerExecutablePath: jest.fn().mockReturnValue('/usr/bin/chromium'),
}));

jest.mock('puppeteer', () => ({
  __esModule: true,
  default: {
    launch: jest.fn().mockResolvedValue({
      newPage: jest.fn().mockResolvedValue({
        setViewport: jest.fn(),
        setUserAgent: jest.fn(),
        goto: jest.fn(),
        screenshot: jest.fn().mockResolvedValue(Buffer.from('')),
        close: jest.fn(),
      }),
      close: jest.fn(),
    }),
  },
}));

/* ── tests ─────────────────────────────────────────────────── */

describe('mobileHarness', () => {
  describe('mobileHarnessStop', () => {
    it('returns message when no active session exists', async () => {
      const result = await mobileHarnessStop('nonexistent');
      expect(result).toContain('No active mobile harness session');
    });
  });
});
