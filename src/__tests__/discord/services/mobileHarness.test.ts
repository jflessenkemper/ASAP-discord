/* ── mocks ─────────────────────────────────────────────────── */

const mockKeyboardPress = jest.fn().mockResolvedValue(undefined);
const mockPage: any = {
  goto: jest.fn().mockResolvedValue(undefined),
  waitForSelector: jest.fn().mockResolvedValue(undefined),
  click: jest.fn().mockResolvedValue(undefined),
  type: jest.fn().mockResolvedValue(undefined),
  keyboard: { press: mockKeyboardPress },
  goBack: jest.fn().mockResolvedValue(undefined),
  evaluate: jest.fn().mockResolvedValue(undefined),
  screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-png')),
  close: jest.fn().mockResolvedValue(undefined),
  setViewport: jest.fn().mockResolvedValue(undefined),
  setUserAgent: jest.fn().mockResolvedValue(undefined),
};

const mockBrowserClose = jest.fn().mockResolvedValue(undefined);
const mockBrowser: any = {
  newPage: jest.fn().mockResolvedValue(mockPage),
  close: mockBrowserClose,
};

jest.mock('../../../discord/services/browserRuntime', () => ({
  PUPPETEER_LAUNCH_ARGS: ['--no-sandbox'],
  resolvePuppeteerExecutablePath: jest.fn().mockReturnValue('/usr/bin/chromium'),
}));

jest.mock('puppeteer', () => ({
  __esModule: true,
  default: {
    launch: jest.fn().mockImplementation(() => Promise.resolve(mockBrowser)),
  },
}));

import {
  mobileHarnessStart,
  mobileHarnessStep,
  mobileHarnessSnapshot,
  mobileHarnessStop,
} from '../../../discord/services/mobileHarness';

/* ── tests ─────────────────────────────────────────────────── */

describe('mobileHarness', () => {
  const mockSend = jest.fn().mockResolvedValue({ id: 'msg-1' });
  const mockChannel: any = {
    id: 'ch-1',
    send: mockSend,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReset().mockResolvedValue({ id: 'msg-1' });
    mockPage.goto.mockResolvedValue(undefined);
    mockPage.screenshot.mockResolvedValue(Buffer.from('fake-png'));
    mockPage.goBack.mockResolvedValue(undefined);
    mockPage.waitForSelector.mockResolvedValue(undefined);
    mockPage.click.mockResolvedValue(undefined);
    mockPage.type.mockResolvedValue(undefined);
    mockKeyboardPress.mockResolvedValue(undefined);
    mockPage.evaluate.mockResolvedValue(undefined);
    mockBrowser.newPage.mockResolvedValue(mockPage);
  });

  afterEach(async () => {
    await mobileHarnessStop('test-session').catch(() => {});
  });

  describe('mobileHarnessStop', () => {
    it('returns message when no active session exists', async () => {
      const result = await mobileHarnessStop('nonexistent');
      expect(result).toContain('No active mobile harness session');
    });

    it('stops an active session and reports runtime', async () => {
      await mobileHarnessStart('stop-test', 'http://localhost:3000', mockChannel);
      const result = await mobileHarnessStop('stop-test');
      expect(result).toContain('Mobile harness stopped');
      expect(result).toContain('stop-test');
      expect(mockBrowserClose).toHaveBeenCalled();
    });
  });

  describe('mobileHarnessStart', () => {
    it('starts a session and posts a snapshot', async () => {
      const result = await mobileHarnessStart('test-session', 'http://localhost:3000', mockChannel);
      expect(result).toContain('Mobile harness started');
      expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:3000', expect.any(Object));
      expect(mockPage.setViewport).toHaveBeenCalled();
      expect(mockPage.setUserAgent).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalled();
    });

    it('rejects disallowed URLs', async () => {
      await expect(
        mobileHarnessStart('test-session', 'https://evil.com/hack', mockChannel),
      ).rejects.toThrow('URL not allowed');
    });

    it('accepts Cloud Run URLs', async () => {
      const result = await mobileHarnessStart('cr-session', 'https://asap-frontend-abc.run.app/', mockChannel);
      expect(result).toContain('Mobile harness started');
      await mobileHarnessStop('cr-session');
    });

    it('accepts 127.0.0.1 URLs', async () => {
      const result = await mobileHarnessStart('local-session', 'http://127.0.0.1:8080', mockChannel);
      expect(result).toContain('Mobile harness started');
      await mobileHarnessStop('local-session');
    });

    it('stops existing session before starting new one', async () => {
      await mobileHarnessStart('reuse-session', 'http://localhost:3000', mockChannel);
      await mobileHarnessStart('reuse-session', 'http://localhost:3001', mockChannel);
      const result = await mobileHarnessStop('reuse-session');
      expect(result).toContain('Mobile harness stopped');
    });

    it('uses custom label for snapshot', async () => {
      await mobileHarnessStart('label-session', 'http://localhost:3000', mockChannel, 'custom-label');
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('custom-label'),
        }),
      );
      await mobileHarnessStop('label-session');
    });

    it('works without channel', async () => {
      const result = await mobileHarnessStart('no-channel', 'http://localhost:3000');
      expect(result).toContain('Mobile harness started');
      expect(mockSend).not.toHaveBeenCalled();
      await mobileHarnessStop('no-channel');
    });
  });

  describe('mobileHarnessStep', () => {
    beforeEach(async () => {
      await mobileHarnessStart('step-session', 'http://localhost:3000', mockChannel);
      mockSend.mockClear();
    });

    afterEach(async () => {
      await mobileHarnessStop('step-session').catch(() => {});
    });

    it('throws when no session exists', async () => {
      await expect(
        mobileHarnessStep('nonexistent', { action: 'tap', selector: '#btn' }),
      ).rejects.toThrow('No active mobile harness session');
    });

    it('taps an element', async () => {
      const result = await mobileHarnessStep(
        'step-session',
        { action: 'tap', selector: '#btn' },
        mockChannel,
      );
      expect(result).toContain('tap');
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('#btn', { timeout: 8000 });
      expect(mockPage.click).toHaveBeenCalledWith('#btn');
    });

    it('throws when tap has no selector', async () => {
      await expect(
        mobileHarnessStep('step-session', { action: 'tap' }),
      ).rejects.toThrow('tap action requires selector');
    });

    it('types text into a field', async () => {
      const result = await mobileHarnessStep(
        'step-session',
        { action: 'type', selector: '#input', text: 'hello' },
        mockChannel,
      );
      expect(result).toContain('type');
      expect(mockPage.click).toHaveBeenCalledWith('#input', { clickCount: 3 });
      expect(mockKeyboardPress).toHaveBeenCalledWith('Backspace');
      expect(mockPage.type).toHaveBeenCalledWith('#input', 'hello', { delay: 20 });
    });

    it('throws when type has no selector', async () => {
      await expect(
        mobileHarnessStep('step-session', { action: 'type', text: 'hello' }),
      ).rejects.toThrow('type action requires selector');
    });

    it('types empty text (clear field)', async () => {
      const result = await mobileHarnessStep(
        'step-session',
        { action: 'type', selector: '#input', text: '' },
        mockChannel,
      );
      expect(result).toContain('type');
      expect(mockPage.type).not.toHaveBeenCalled();
    });

    it('types with undefined text (defaults to empty)', async () => {
      const result = await mobileHarnessStep(
        'step-session',
        { action: 'type', selector: '#input' },
        mockChannel,
      );
      expect(result).toContain('type');
    });

    it('waits for specified ms', async () => {
      const result = await mobileHarnessStep(
        'step-session',
        { action: 'wait', ms: 500 },
        mockChannel,
      );
      expect(result).toContain('wait');
    });

    it('clamps wait time to min 100ms', async () => {
      const start = Date.now();
      await mobileHarnessStep(
        'step-session',
        { action: 'wait', ms: 10 },
        mockChannel,
      );
      expect(Date.now() - start).toBeGreaterThanOrEqual(90);
    });

    it('defaults wait ms to 500 when not provided', async () => {
      const result = await mobileHarnessStep(
        'step-session',
        { action: 'wait' },
        mockChannel,
      );
      expect(result).toContain('wait');
    });

    it('navigates with goto', async () => {
      const result = await mobileHarnessStep(
        'step-session',
        { action: 'goto', url: 'http://localhost:3001/page' },
        mockChannel,
      );
      expect(result).toContain('goto');
      expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:3001/page', expect.any(Object));
    });

    it('goto rejects disallowed URLs', async () => {
      await expect(
        mobileHarnessStep('step-session', { action: 'goto', url: 'https://evil.com' }),
      ).rejects.toThrow('URL not allowed');
    });

    it('goto uses last URL when no URL provided', async () => {
      mockPage.goto.mockClear();
      await mobileHarnessStep(
        'step-session',
        { action: 'goto' },
        mockChannel,
      );
      expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:3000', expect.any(Object));
    });

    it('presses a key', async () => {
      const result = await mobileHarnessStep(
        'step-session',
        { action: 'key', key: 'Escape' },
        mockChannel,
      );
      expect(result).toContain('key');
      expect(mockKeyboardPress).toHaveBeenCalledWith('Escape');
    });

    it('defaults key to Enter when not specified', async () => {
      await mobileHarnessStep(
        'step-session',
        { action: 'key' },
        mockChannel,
      );
      expect(mockKeyboardPress).toHaveBeenCalledWith('Enter');
    });

    it('navigates back', async () => {
      const result = await mobileHarnessStep(
        'step-session',
        { action: 'back' },
        mockChannel,
      );
      expect(result).toContain('back');
      expect(mockPage.goBack).toHaveBeenCalled();
    });

    it('falls back to history.back when page.goBack fails', async () => {
      mockPage.goBack.mockRejectedValueOnce(new Error('nav error'));
      await mobileHarnessStep(
        'step-session',
        { action: 'back' },
        mockChannel,
      );
      expect(mockPage.evaluate).toHaveBeenCalled();
    });

    it('throws on unsupported action', async () => {
      await expect(
        mobileHarnessStep('step-session', { action: 'swipe' as any }),
      ).rejects.toThrow('Unsupported harness action');
    });

    it('posts snapshot with custom label', async () => {
      await mobileHarnessStep(
        'step-session',
        { action: 'wait', ms: 100 },
        mockChannel,
        'my-custom-label',
      );
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('my-custom-label'),
        }),
      );
    });
  });

  describe('mobileHarnessSnapshot', () => {
    it('throws when no session exists', async () => {
      await expect(
        mobileHarnessSnapshot('nonexistent'),
      ).rejects.toThrow('No active mobile harness session');
    });

    it('captures a snapshot of active session', async () => {
      await mobileHarnessStart('snap-session', 'http://localhost:3000', mockChannel);
      mockSend.mockClear();
      const result = await mobileHarnessSnapshot('snap-session', mockChannel, 'test-snap');
      expect(result).toContain('snapshot captured');
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('test-snap'),
        }),
      );
      await mobileHarnessStop('snap-session');
    });

    it('works without channel', async () => {
      await mobileHarnessStart('snap-no-ch', 'http://localhost:3000');
      const result = await mobileHarnessSnapshot('snap-no-ch');
      expect(result).toContain('snapshot captured');
      await mobileHarnessStop('snap-no-ch');
    });

    it('uses default label when none provided', async () => {
      await mobileHarnessStart('snap-default', 'http://localhost:3000', mockChannel);
      mockSend.mockClear();
      await mobileHarnessSnapshot('snap-default', mockChannel);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('harness-snapshot'),
        }),
      );
      await mobileHarnessStop('snap-default');
    });
  });

  describe('sanitizeLabel', () => {
    it('sanitizes @everyone in labels', async () => {
      await mobileHarnessStart('sanitize-test', 'http://localhost:3000', mockChannel);
      mockSend.mockClear();
      await mobileHarnessSnapshot('sanitize-test', mockChannel, '@everyone hack');
      const call = mockSend.mock.calls[0];
      expect(call[0].content).not.toContain('@everyone');
      await mobileHarnessStop('sanitize-test');
    });

    it('sanitizes @here in labels', async () => {
      await mobileHarnessStart('sanitize-here', 'http://localhost:3000', mockChannel);
      mockSend.mockClear();
      await mobileHarnessSnapshot('sanitize-here', mockChannel, '@here alert');
      const call = mockSend.mock.calls[0];
      expect(call[0].content).not.toContain('@here');
      await mobileHarnessStop('sanitize-here');
    });

    it('sanitizes user mentions in labels', async () => {
      await mobileHarnessStart('sanitize-mention', 'http://localhost:3000', mockChannel);
      mockSend.mockClear();
      await mobileHarnessSnapshot('sanitize-mention', mockChannel, '<@12345678> test');
      const call = mockSend.mock.calls[0];
      expect(call[0].content).not.toContain('<@12345678>');
      await mobileHarnessStop('sanitize-mention');
    });
  });
});
