jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: jest.fn().mockResolvedValue({
      getAccessToken: jest.fn().mockResolvedValue({ token: 'fake-token' }),
    }),
  })),
}));

jest.mock('../../services/googleCredentials', () => ({
  ensureGoogleCredentials: jest.fn().mockResolvedValue(false),
  getGoogleCredentialBootstrapState: jest.fn().mockReturnValue({ attempted: false, path: null }),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { loadRuntimeSecrets } from '../../services/runtimeSecrets';

describe('runtimeSecrets', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset relevant env vars
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.DISCORD_TEST_BOT_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
    process.env.RUNTIME_SECRET_MANAGER_ENABLED = 'false';
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it('does not throw when secret manager is disabled', async () => {
    await expect(loadRuntimeSecrets()).resolves.toBeUndefined();
  });

  it('skips loading when env vars are already set', async () => {
    process.env.GEMINI_API_KEY = 'already-set';
    process.env.RUNTIME_SECRET_MANAGER_ENABLED = 'true';

    await loadRuntimeSecrets();
    // Should not have tried to fetch secrets for GEMINI_API_KEY
    expect(process.env.GEMINI_API_KEY).toBe('already-set');
  });

  it('skips loading when no project ID is available', async () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GCS_PROJECT_ID;
    process.env.RUNTIME_SECRET_MANAGER_ENABLED = 'true';

    await expect(loadRuntimeSecrets()).resolves.toBeUndefined();
  });
});
