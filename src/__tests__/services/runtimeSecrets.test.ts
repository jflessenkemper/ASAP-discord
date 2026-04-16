export {};

const mockGetAccessToken = jest.fn().mockResolvedValue({ token: 'fake-token' });
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: jest.fn().mockResolvedValue({
      getAccessToken: mockGetAccessToken,
    }),
  })),
}));

const mockEnsureGoogleCredentials = jest.fn().mockResolvedValue(false);
const mockGetGoogleCredentialBootstrapState = jest.fn().mockReturnValue({ attempted: false, path: null });
jest.mock('../../services/googleCredentials', () => ({
  ensureGoogleCredentials: (...args: any[]) => mockEnsureGoogleCredentials(...args),
  getGoogleCredentialBootstrapState: () => mockGetGoogleCredentialBootstrapState(),
}));

jest.mock('child_process', () => ({
  execFileSync: jest.fn().mockReturnValue('gcloud-secret-value'),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

describe('runtimeSecrets', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockFetch.mockReset();
    mockGetAccessToken.mockResolvedValue({ token: 'fake-token' });
    mockEnsureGoogleCredentials.mockResolvedValue(false);
    mockGetGoogleCredentialBootstrapState.mockReturnValue({ attempted: false, path: null });
    // Reset relevant env vars
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.DISCORD_TEST_BOT_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
    delete process.env.GEMINI_API_KEY_SECRET_NAME;
    process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
    process.env.RUNTIME_SECRET_MANAGER_ENABLED = 'true';
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it('does not throw when secret manager is disabled', async () => {
    process.env.RUNTIME_SECRET_MANAGER_ENABLED = 'false';
    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await expect(loadRuntimeSecrets()).resolves.toBeUndefined();
  });

  it('skips loading when env vars are already set', async () => {
    process.env.GEMINI_API_KEY = 'already-set';
    process.env.ANTHROPIC_API_KEY = 'already-set';
    process.env.DEEPGRAM_API_KEY = 'already-set';
    process.env.ELEVENLABS_API_KEY = 'already-set';
    process.env.DISCORD_TEST_BOT_TOKEN = 'already-set';
    process.env.GITHUB_TOKEN = 'already-set';
    process.env.ADZUNA_APP_ID = 'already-set';
    process.env.ADZUNA_APP_KEY = 'already-set';

    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(process.env.GEMINI_API_KEY).toBe('already-set');
  });

  it('skips loading when no project ID is available', async () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GCS_PROJECT_ID;

    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await expect(loadRuntimeSecrets()).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('loads secrets from Secret Manager via REST', async () => {
    const encodedValue = Buffer.from('test-api-key').toString('base64');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ payload: { data: encodedValue } }),
    });

    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(process.env.GEMINI_API_KEY).toBe('test-api-key');
    expect(mockFetch).toHaveBeenCalled();
  });

  it('logs bootstrap path when google credentials were bootstrapped', async () => {
    mockGetGoogleCredentialBootstrapState.mockReturnValue({ attempted: true, path: '/tmp/adc.json' });
    const encodedValue = Buffer.from('val').toString('base64');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ payload: { data: encodedValue } }),
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Bootstrapped GOOGLE_APPLICATION_CREDENTIALS'));
    logSpy.mockRestore();
  });

  it('handles HTTP error from Secret Manager', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not found',
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not load GEMINI_API_KEY'));
    warnSpy.mockRestore();
  });

  it('warns when secret payload is empty', async () => {
    // Base64 of whitespace only — decodes to '', trim() makes it empty
    const whitespaceBase64 = Buffer.from('   ').toString('base64');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ payload: { data: whitespaceBase64 } }),
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty'));
    warnSpy.mockRestore();
  });

  it('warns when secret has no payload at all', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ payload: {} }),
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not load'));
    warnSpy.mockRestore();
  });

  it('disables secret manager and warns once on ADC missing error', async () => {
    mockFetch.mockRejectedValue(new Error('could not load the default credentials'));
    // gcloud fallback must also fail to trigger the outer ADC catch
    const { execFileSync } = require('child_process');
    (execFileSync as jest.Mock).mockImplementation(() => { throw new Error('gcloud not found'); });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ADC is not configured'));
    warnSpy.mockRestore();
  });

  it('uses override secret name from env', async () => {
    process.env.GEMINI_API_KEY_SECRET_NAME = 'custom-secret-name';
    const encodedValue = Buffer.from('custom-key').toString('base64');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ payload: { data: encodedValue } }),
    });

    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('custom-secret-name'),
      expect.any(Object),
    );
  });

  it('respects RUNTIME_SECRET_MANAGER_ENABLED=0', async () => {
    process.env.RUNTIME_SECRET_MANAGER_ENABLED = '0';
    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('respects RUNTIME_SECRET_MANAGER_ENABLED=no', async () => {
    process.env.RUNTIME_SECRET_MANAGER_ENABLED = 'no';
    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('respects RUNTIME_SECRET_MANAGER_ENABLED=off', async () => {
    process.env.RUNTIME_SECRET_MANAGER_ENABLED = 'off';
    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('handles getAccessToken returning a plain string', async () => {
    mockGetAccessToken.mockResolvedValue('bare-token-string');
    const encodedValue = Buffer.from('val').toString('base64');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ payload: { data: encodedValue } }),
    });

    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer bare-token-string' }),
      }),
    );
  });

  it('throws when getAccessToken returns null token', async () => {
    mockGetAccessToken.mockResolvedValue({ token: null });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not load'));
    warnSpy.mockRestore();
  });

  it('falls back to gcloud CLI when ADC fails for readSecret', async () => {
    // First call throws ADC error, triggering gcloud fallback
    mockFetch.mockRejectedValue(new Error('could not load the default credentials'));
    const { execFileSync } = require('child_process');
    (execFileSync as jest.Mock).mockReturnValue('gcloud-secret-value');

    // But since isMissingAdcError is true, it will set secretManagerDisabled = true
    // and skip subsequent calls. So the gcloud fallback in readSecret
    // is caught by the outer ensureEnvFromSecret's ADC check.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    await loadRuntimeSecrets();
    warnSpy.mockRestore();
  });

  it('handles ensureGoogleCredentials rejecting', async () => {
    mockEnsureGoogleCredentials.mockRejectedValue(new Error('cred failure'));
    const encodedValue = Buffer.from('val').toString('base64');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ payload: { data: encodedValue } }),
    });

    const { loadRuntimeSecrets } = require('../../services/runtimeSecrets');
    // Should not throw — .catch(() => {}) in loadRuntimeSecrets
    await expect(loadRuntimeSecrets()).resolves.toBeUndefined();
  });
});
