import { postDiagnostic, mirrorAgentResponse, mirrorVoiceTranscript } from '../../../discord/services/diagnosticsWebhook';

/* ── mocks ─────────────────────────────────────────────────── */

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

/* ── tests ─────────────────────────────────────────────────── */

describe('diagnosticsWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL;
    delete process.env.DIAGNOSTIC_WEBHOOK_VERBOSE;
  });

  describe('postDiagnostic', () => {
    it('returns early when no webhook URL is configured', async () => {
      await postDiagnostic('test message');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('posts to the webhook URL when configured', async () => {
      process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      mockFetch.mockResolvedValueOnce({ ok: true });

      await postDiagnostic('Server started');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/test',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.username).toBe('ASAP Diagnostics');
      expect(body.content).toContain('Server started');
    });

    it('uses error icon for error level', async () => {
      process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
      mockFetch.mockResolvedValueOnce({ ok: true });

      await postDiagnostic('Crash', { level: 'error' });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.content).toContain('🚨');
    });

    it('uses warn icon for warn level', async () => {
      process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
      mockFetch.mockResolvedValueOnce({ ok: true });

      await postDiagnostic('Slow', { level: 'warn' });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.content).toContain('⚠️');
    });

    it('includes source and detail in the message', async () => {
      process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
      mockFetch.mockResolvedValueOnce({ ok: true });

      await postDiagnostic('Event', { source: 'bot', detail: 'extra info' });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.content).toContain('Source: bot');
      expect(body.content).toContain('Detail:');
    });

    it('truncates detail when not verbose', async () => {
      process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
      mockFetch.mockResolvedValueOnce({ ok: true });

      const longDetail = 'x'.repeat(2000);
      await postDiagnostic('Msg', { detail: longDetail });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.content.length).toBeLessThan(2000 + 200); // some overhead allowed
    });

    it('splits long messages into chunks', async () => {
      process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
      process.env.DIAGNOSTIC_WEBHOOK_VERBOSE = 'true';
      mockFetch.mockResolvedValue({ ok: true });

      const longDetail = 'x'.repeat(5000);
      await postDiagnostic('Big', { detail: longDetail });
      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('handles fetch errors gracefully', async () => {
      process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
      mockFetch.mockRejectedValueOnce(new Error('network'));

      // Should not throw
      await expect(postDiagnostic('test')).resolves.toBeUndefined();
    });
  });

  describe('mirrorAgentResponse', () => {
    it('posts agent response via postDiagnostic', async () => {
      process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
      mockFetch.mockResolvedValueOnce({ ok: true });

      await mirrorAgentResponse('Ace', 'general', 'Hello world');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.content).toContain('agent:Ace');
      expect(body.content).toContain('channel=general');
    });
  });

  describe('mirrorVoiceTranscript', () => {
    it('posts voice transcript via postDiagnostic', async () => {
      process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
      mockFetch.mockResolvedValueOnce({ ok: true });

      await mirrorVoiceTranscript('Jordan', 'Hello bot', 'en');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.content).toContain('voice:transcript');
      expect(body.content).toContain('user=Jordan');
      expect(body.content).toContain('language=en');
    });
  });
});

describe('webhook error status handling (fresh module)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL;
    delete process.env.DIAGNOSTIC_WEBHOOK_VERBOSE;
    (global as any).fetch = mockFetch;
  });

  it('permanently disables webhook on 401', async () => {
    const { postDiagnostic: post } = require('../../../discord/services/diagnosticsWebhook');
    process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401,
      text: jest.fn().mockResolvedValue('Unauthorized'),
    });

    await post('test');
    // Should be disabled now — second call should not fetch
    mockFetch.mockClear();
    await post('test2');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('permanently disables webhook on 404', async () => {
    const { postDiagnostic: post } = require('../../../discord/services/diagnosticsWebhook');
    process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 404,
      text: jest.fn().mockResolvedValue('Not Found'),
    });

    await post('test');
    mockFetch.mockClear();
    await post('test2');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('permanently disables webhook on 410', async () => {
    const { postDiagnostic: post } = require('../../../discord/services/diagnosticsWebhook');
    process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 410,
      text: jest.fn().mockResolvedValue('Gone'),
    });

    await post('test');
    mockFetch.mockClear();
    await post('test2');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not disable webhook on 500', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const { postDiagnostic: post } = require('../../../discord/services/diagnosticsWebhook');
    process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 500,
      text: jest.fn().mockResolvedValue('Internal Server Error'),
    });

    await post('test');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Diagnostic webhook failed: 500'));

    // Should NOT be disabled — second call should still fetch
    mockFetch.mockResolvedValueOnce({ ok: true });
    await post('test2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('logs verbose warning when 401 and diagnosticsVerbose is true', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const { postDiagnostic: post } = require('../../../discord/services/diagnosticsWebhook');
    process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
    process.env.DIAGNOSTIC_WEBHOOK_VERBOSE = 'true';
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401,
      text: jest.fn().mockResolvedValue('Unauthorized'),
    });

    await post('test');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Diagnostic webhook disabled for process lifetime'));
    warnSpy.mockRestore();
  });

  it('handles res.text() rejection gracefully', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const { postDiagnostic: post } = require('../../../discord/services/diagnosticsWebhook');
    process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL = 'https://hook.test';
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 500,
      text: jest.fn().mockRejectedValue(new Error('read error')),
    });

    await post('test');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Diagnostic webhook failed: 500'));
    warnSpy.mockRestore();
  });
});
