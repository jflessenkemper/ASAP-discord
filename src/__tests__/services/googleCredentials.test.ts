/**
 * Tests for src/services/googleCredentials.ts
 */

// --- Mocks --- Define mock fns at top level so factory closures reference the same fns
const mockExecFileSync = jest.fn();
jest.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

const mockExistsSync = jest.fn().mockReturnValue(false);
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockChmodSync = jest.fn();
jest.mock('fs', () => ({
  existsSync: mockExistsSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  chmodSync: mockChmodSync,
}));

const mockGetAccessToken = jest.fn();
const mockGetClient = jest.fn().mockResolvedValue({ getAccessToken: mockGetAccessToken });
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: mockGetClient,
  })),
}));

describe('googleCredentials', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...OLD_ENV };
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET;
    delete process.env.VERTEX_SERVICE_ACCOUNT_SECRET_NAME;
    delete process.env.GCP_VERTEX_SA_SECRET_NAME;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GCS_PROJECT_ID;
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  describe('getGoogleCredentialBootstrapState', () => {
    it('returns the bootstrap state object', async () => {
      const { getGoogleCredentialBootstrapState } = await import('../../services/googleCredentials');
      const state = getGoogleCredentialBootstrapState();
      expect(state).toHaveProperty('attempted');
      expect(state).toHaveProperty('path');
      expect(typeof state.attempted).toBe('boolean');
    });
  });

  describe('getAccessTokenViaGcloud', () => {
    it('returns a token when gcloud succeeds', async () => {
      mockExecFileSync.mockReturnValue('ya29.test-token\n');
      const { getAccessTokenViaGcloud } = await import('../../services/googleCredentials');
      const token = getAccessTokenViaGcloud();
      expect(token).toBe('ya29.test-token');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gcloud',
        ['auth', 'print-access-token', '--quiet'],
        expect.objectContaining({ encoding: 'utf8' }),
      );
    });

    it('returns null when gcloud fails', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('gcloud not found'); });
      const { getAccessTokenViaGcloud } = await import('../../services/googleCredentials');
      const token = getAccessTokenViaGcloud();
      expect(token).toBeNull();
    });

    it('returns null when gcloud returns empty string', async () => {
      mockExecFileSync.mockReturnValue('  \n');
      const { getAccessTokenViaGcloud } = await import('../../services/googleCredentials');
      const token = getAccessTokenViaGcloud();
      expect(token).toBeNull();
    });
  });

  describe('ensureGoogleCredentials', () => {
    it('returns true when credential file already exists', async () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/adc.json';
      mockExistsSync.mockReturnValue(true);
      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(true);
    });

    it('writes credential file from GOOGLE_APPLICATION_CREDENTIALS_JSON (inline JSON)', async () => {
      const creds = JSON.stringify({ type: 'service_account', project_id: 'test' });
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = creds;
      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('writes credential file from GOOGLE_APPLICATION_CREDENTIALS_BASE64', async () => {
      const creds = JSON.stringify({ type: 'service_account', project_id: 'test' });
      process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64 = Buffer.from(creds).toString('base64');
      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('returns false when no project ID and no secret candidates', async () => {
      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(false);
    });

    it('returns false when project ID set but no secret candidates', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(false);
    });

    it('fetches secret via GoogleAuth and writes credential file', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME = 'my-secret';
      const secretJson = JSON.stringify({ type: 'service_account', project_id: 'test' });
      const secretB64 = Buffer.from(secretJson).toString('base64');
      mockGetAccessToken.mockResolvedValue({ token: 'ya29.test' });

      // Mock fetch for Secret Manager API
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ payload: { data: secretB64 } }),
      });
      global.fetch = mockFetch as any;

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('falls back to gcloud CLI when GoogleAuth fails with ADC error', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME = 'my-secret';
      const secretJson = JSON.stringify({ type: 'service_account', project_id: 'test' });

      mockGetAccessToken.mockRejectedValue(new Error('Could not load the default credentials'));

      // gcloud CLI returns the secret
      mockExecFileSync.mockReturnValue(secretJson);

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(true);
    });

    it('falls back to gcloud when GoogleAuth returns string token', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME = 'my-secret';
      const secretJson = JSON.stringify({ type: 'service_account', project_id: 'test' });
      const secretB64 = Buffer.from(secretJson).toString('base64');

      // Return token as plain string (alternative auth flow)
      mockGetAccessToken.mockResolvedValue('ya29.string-token');
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ payload: { data: secretB64 } }),
      });
      global.fetch = mockFetch as any;

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(true);
    });

    it('handles Secret Manager HTTP error and tries next candidate', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME = 'bad-secret';
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET = 'good-secret';
      const secretJson = JSON.stringify({ type: 'service_account', project_id: 'test' });
      const secretB64 = Buffer.from(secretJson).toString('base64');

      mockGetAccessToken.mockResolvedValue({ token: 'ya29.test' });

      let callCount = 0;
      const mockFetch = jest.fn().mockImplementation(async (url: string) => {
        callCount++;
        if (callCount === 1) {
          return { ok: false, status: 404, text: async () => 'Not found' };
        }
        return {
          ok: true,
          json: async () => ({ payload: { data: secretB64 } }),
        };
      });
      global.fetch = mockFetch as any;

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(true);
    });

    it('handles secret with no payload data', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME = 'empty-secret';

      mockGetAccessToken.mockResolvedValue({ token: 'ya29.test' });
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ payload: {} }),
      });
      global.fetch = mockFetch as any;

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(false);
    });

    it('handles accessToken returning null token', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME = 'my-secret';

      mockGetAccessToken.mockResolvedValue({ token: null });

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(false);
    });

    it('falls back to gcloud CLI when both auth and gcloud fail for one candidate', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME = 'bad-secret';

      mockGetAccessToken.mockRejectedValue(new Error('Could not load the default credentials'));
      mockExecFileSync.mockImplementation(() => { throw new Error('gcloud failed'); });

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(false);
    });

    it('tries VERTEX_SERVICE_ACCOUNT_SECRET_NAME candidate', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      process.env.VERTEX_SERVICE_ACCOUNT_SECRET_NAME = 'vertex-secret';
      const secretJson = JSON.stringify({ type: 'service_account', project_id: 'test' });
      const secretB64 = Buffer.from(secretJson).toString('base64');

      mockGetAccessToken.mockResolvedValue({ token: 'ya29.test' });
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ payload: { data: secretB64 } }),
      });
      global.fetch = mockFetch as any;

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(true);
    });

    it('tries GCP_VERTEX_SA_SECRET_NAME candidate', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      process.env.GCP_VERTEX_SA_SECRET_NAME = 'gcp-vertex-secret';
      const secretJson = JSON.stringify({ type: 'service_account', project_id: 'test' });
      const secretB64 = Buffer.from(secretJson).toString('base64');

      mockGetAccessToken.mockResolvedValue({ token: 'ya29.test' });
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ payload: { data: secretB64 } }),
      });
      global.fetch = mockFetch as any;

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(true);
    });

    it('uses projectIdOverride over env vars', async () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME = 'my-secret';
      const secretJson = JSON.stringify({ type: 'service_account', project_id: 'test' });
      const secretB64 = Buffer.from(secretJson).toString('base64');

      mockGetAccessToken.mockResolvedValue({ token: 'ya29.test' });
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ payload: { data: secretB64 } }),
      });
      global.fetch = mockFetch as any;

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials('override-project');
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('override-project'),
        expect.any(Object),
      );
    });

    it('handles non-JSON secret value from gcloud CLI', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME = 'text-secret';

      mockGetAccessToken.mockRejectedValue(new Error('Could not load the default credentials'));
      mockExecFileSync.mockReturnValue('not-json-value');

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(false);
    });

    it('handles non-ADC errors from GoogleAuth by continuing to next candidate', async () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME = 'my-secret';

      mockGetAccessToken.mockRejectedValue(new Error('network timeout'));

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(false);
    });

    it('handles base64 inline JSON from GOOGLE_APPLICATION_CREDENTIALS_JSON', async () => {
      const creds = JSON.stringify({ type: 'service_account', project_id: 'test' });
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = Buffer.from(creds).toString('base64');
      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(true);
    });

    it('handles invalid JSON in GOOGLE_APPLICATION_CREDENTIALS_JSON', async () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = 'not-valid-json-or-base64!!!';
      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      // Falls through since it's not parseable
      const result = await ensureGoogleCredentials();
      expect(result).toBe(false);
    });

    it('uses GCLOUD_PROJECT env var', async () => {
      process.env.GCLOUD_PROJECT = 'gcloud-proj';
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME = 'my-secret';
      const secretJson = JSON.stringify({ type: 'service_account', project_id: 'test' });
      const secretB64 = Buffer.from(secretJson).toString('base64');

      mockGetAccessToken.mockResolvedValue({ token: 'ya29.test' });
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ payload: { data: secretB64 } }),
      });
      global.fetch = mockFetch as any;

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(true);
    });

    it('uses GCS_PROJECT_ID env var', async () => {
      process.env.GCS_PROJECT_ID = 'gcs-proj';
      process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME = 'my-secret';
      const secretJson = JSON.stringify({ type: 'service_account', project_id: 'test' });
      const secretB64 = Buffer.from(secretJson).toString('base64');

      mockGetAccessToken.mockResolvedValue({ token: 'ya29.test' });
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ payload: { data: secretB64 } }),
      });
      global.fetch = mockFetch as any;

      const { ensureGoogleCredentials } = await import('../../services/googleCredentials');
      const result = await ensureGoogleCredentials();
      expect(result).toBe(true);
    });
  });
});
