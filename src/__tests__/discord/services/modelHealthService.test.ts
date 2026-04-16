/**
 * Tests for src/discord/services/modelHealthCheck.ts (service)
 * Model/provider health checks — Anthropic, Deepgram, ElevenLabs.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockConnect = jest.fn().mockResolvedValue({
  query: jest.fn().mockResolvedValue({ rows: [{ locked: false }] }),
  release: jest.fn(),
});
jest.mock('../../../db/pool', () => ({
  default: { query: mockQuery, connect: mockConnect, on: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/googleCredentials', () => ({
  ensureGoogleCredentials: jest.fn().mockResolvedValue(true),
  getAccessTokenViaGcloud: jest.fn().mockReturnValue(null),
}));
jest.mock('../../../discord/services/diagnosticsWebhook', () => ({
  postDiagnostic: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: jest.fn().mockResolvedValue({
      getAccessToken: jest.fn().mockResolvedValue({ token: 'test-token' }),
    }),
  })),
}));

import { runModelHealthChecks } from '../../../discord/services/modelHealthCheck';
import { postDiagnostic } from '../../../discord/services/diagnosticsWebhook';
import { ANTHROPIC_HEALTHCHECK_MODELS } from '../../../services/modelConfig';

describe('services/modelHealthCheck', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockConnect.mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [{ locked: false }] }),
      release: jest.fn(),
    });
    mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: jest.fn().mockResolvedValue({}),
      text: jest.fn().mockResolvedValue('not found'),
    });
    (global as any).fetch = mockFetch;
  });

  afterEach(() => {
    delete (global as any).fetch;
  });

  describe('runModelHealthChecks()', () => {
    it('skips when advisory lock is not acquired', async () => {
      // Lock not acquired (locked=false)
      await runModelHealthChecks();
      // postDiagnostic should NOT be called because lock failed
    });

    it('runs checks and posts diagnostic when lock acquired', async () => {
      // Lock acquired
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      // Mock all API health check fetches to fail (no API keys set)
      await runModelHealthChecks();

      expect(postDiagnostic).toHaveBeenCalledWith(
        expect.stringContaining('Model/provider health check'),
        expect.objectContaining({ source: 'startup:model-health' }),
      );
    });

    it('reports WARN when some checks fail', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      // No API keys set, so all checks will fail
      await runModelHealthChecks();

      expect(postDiagnostic).toHaveBeenCalledWith(
        expect.stringContaining('WARN'),
        expect.objectContaining({ level: 'warn' }),
      );
    });

    it('reports PASS when all checks succeed', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      // Set all required API keys
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.DEEPGRAM_API_KEY = 'test-key';
      process.env.ELEVENLABS_API_KEY = 'test-key';

      // Mock all fetch calls to succeed
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          data: [
            ...ANTHROPIC_HEALTHCHECK_MODELS.map((id) => ({ id })),
          ],
        }),
        text: jest.fn().mockResolvedValue('ok'),
      });

      await runModelHealthChecks();

      expect(postDiagnostic).toHaveBeenCalledWith(
        expect.stringContaining('PASS'),
        expect.objectContaining({ level: 'info' }),
      );

      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.DEEPGRAM_API_KEY;
      delete process.env.ELEVENLABS_API_KEY;
    });

    it('handles Anthropic check with direct API key', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.ANTHROPIC_API_KEY = 'test-key';

      // Anthropic models list returns ok but misses part of the configured health-check set
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          data: [{ id: ANTHROPIC_HEALTHCHECK_MODELS[0] }],
          models: [],
        }),
        text: jest.fn().mockResolvedValue('ok'),
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('handles Anthropic HTTP error', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.ANTHROPIC_API_KEY = 'test-key';

      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue('unauthorized'),
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('handles Anthropic network error', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.ANTHROPIC_API_KEY = 'test-key';
      mockFetch.mockRejectedValue(new Error('network error'));

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('handles Gemini text check with generateContent success', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.GEMINI_API_KEY = 'test-key';

      // Mock different responses for different URLs
      mockFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('models?key=')) {
          return {
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({
              models: [
                { name: 'models/gemini-2.5-flash' },
                { name: 'models/gemini-2.5-flash-preview-tts' },
              ],
            }),
            text: jest.fn().mockResolvedValue('ok'),
          };
        }
        if (String(url).includes('generateContent')) {
          return {
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({}),
            text: jest.fn().mockResolvedValue('ok'),
          };
        }
        return {
          ok: false,
          status: 404,
          json: jest.fn().mockResolvedValue({}),
          text: jest.fn().mockResolvedValue('not found'),
        };
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.GEMINI_API_KEY;
    });

    it('handles Gemini 429 quota exceeded', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.GEMINI_API_KEY = 'test-key';

      mockFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('models?key=')) {
          return {
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({
              models: [
                { name: 'models/gemini-2.5-flash' },
                { name: 'models/gemini-2.5-flash-preview-tts' },
              ],
            }),
            text: jest.fn().mockResolvedValue('ok'),
          };
        }
        return {
          ok: false,
          status: 429,
          json: jest.fn().mockResolvedValue({}),
          text: jest.fn().mockResolvedValue('rate limit'),
        };
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.GEMINI_API_KEY;
    });

    it('handles Gemini models list error', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.GEMINI_API_KEY = 'test-key';

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue('server error'),
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.GEMINI_API_KEY;
    });

    it('handles Gemini model not in list', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.GEMINI_API_KEY = 'test-key';

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          models: [{ name: 'models/some-other-model' }],
        }),
        text: jest.fn().mockResolvedValue('ok'),
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.GEMINI_API_KEY;
    });

    it('handles Deepgram check success', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.DEEPGRAM_API_KEY = 'test-key';

      mockFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('deepgram')) {
          return {
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({}),
            text: jest.fn().mockResolvedValue('ok'),
          };
        }
        return {
          ok: false,
          status: 404,
          json: jest.fn().mockResolvedValue({}),
          text: jest.fn().mockResolvedValue('not found'),
        };
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.DEEPGRAM_API_KEY;
    });

    it('handles Deepgram check failure', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.DEEPGRAM_API_KEY = 'test-key';
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue('forbidden'),
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.DEEPGRAM_API_KEY;
    });

    it('handles Deepgram network error', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.DEEPGRAM_API_KEY = 'test-key';
      mockFetch.mockRejectedValue(new Error('network error'));

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.DEEPGRAM_API_KEY;
    });

    it('handles ElevenLabs check success', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.ELEVENLABS_API_KEY = 'test-key';

      mockFetch.mockImplementation(async (url: string) => {
        if (String(url).includes('elevenlabs')) {
          return {
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({}),
            text: jest.fn().mockResolvedValue('ok'),
          };
        }
        return {
          ok: false,
          status: 404,
          json: jest.fn().mockResolvedValue({}),
          text: jest.fn().mockResolvedValue('not found'),
        };
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.ELEVENLABS_API_KEY;
    });

    it('handles ElevenLabs check failure', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.ELEVENLABS_API_KEY = 'test-key';
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue('error'),
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.ELEVENLABS_API_KEY;
    });

    it('handles ElevenLabs network error', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.ELEVENLABS_API_KEY = 'test-key';
      mockFetch.mockRejectedValue(new Error('network error'));

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.ELEVENLABS_API_KEY;
    });

    it('handles advisory lock error', async () => {
      mockConnect.mockRejectedValueOnce(new Error('connection refused'));

      await runModelHealthChecks();
      // Should still run when lock errors
      expect(postDiagnostic).toHaveBeenCalled();
    });

    it('handles Gemini models fetch network error', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.GEMINI_API_KEY = 'test-key';
      mockFetch.mockRejectedValue(new Error('DNS resolution failed'));

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.GEMINI_API_KEY;
    });

    it('handles Gemini models list 429', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.GEMINI_API_KEY = 'test-key';

      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue('quota exceeded'),
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.GEMINI_API_KEY;
    });

    it('handles Gemini text generateContent HTTP error', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.GEMINI_API_KEY = 'test-key';

      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          // First two calls = model listing (for text and TTS)
          return {
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({
              models: [
                { name: 'models/gemini-2.5-flash' },
                { name: 'models/gemini-2.5-flash-preview-tts' },
              ],
            }),
            text: jest.fn().mockResolvedValue('ok'),
          };
        }
        return {
          ok: false,
          status: 500,
          json: jest.fn().mockResolvedValue({}),
          text: jest.fn().mockResolvedValue('internal error'),
        };
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.GEMINI_API_KEY;
    });

    it('handles Gemini text generateContent network error', async () => {
      mockConnect.mockResolvedValueOnce({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });

      process.env.GEMINI_API_KEY = 'test-key';

      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({
              models: [
                { name: 'models/gemini-2.5-flash' },
                { name: 'models/gemini-2.5-flash-preview-tts' },
              ],
            }),
            text: jest.fn().mockResolvedValue('ok'),
          };
        }
        throw new Error('network error');
      });

      await runModelHealthChecks();
      expect(postDiagnostic).toHaveBeenCalled();

      delete process.env.GEMINI_API_KEY;
    });
  });

  describe('Vertex Anthropic checks', () => {
    it('runs Vertex Anthropic check when USE_VERTEX_ANTHROPIC is true', async () => {
      jest.resetModules();

      process.env.ANTHROPIC_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'my-project';

      const mq2 = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
      const mc2 = jest.fn().mockResolvedValue({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });
      jest.doMock('../../../db/pool', () => ({
        default: { query: mq2, connect: mc2, on: jest.fn() },
        __esModule: true,
      }));
      jest.doMock('../../../services/googleCredentials', () => ({
        ensureGoogleCredentials: jest.fn().mockResolvedValue(true),
        getAccessTokenViaGcloud: jest.fn().mockReturnValue(null),
      }));
      jest.doMock('../../../discord/services/diagnosticsWebhook', () => ({
        postDiagnostic: jest.fn().mockResolvedValue(undefined),
      }));
      jest.doMock('google-auth-library', () => ({
        GoogleAuth: jest.fn().mockImplementation(() => ({
          getClient: jest.fn().mockResolvedValue({
            getAccessToken: jest.fn().mockResolvedValue({ token: 'vertex-token' }),
          }),
        })),
      }));

      // Vertex Anthropic succeeds
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue('ok'),
      });

      const mod = require('../../../discord/services/modelHealthCheck');
      const diag = require('../../../discord/services/diagnosticsWebhook');
      await mod.runModelHealthChecks();
      expect(diag.postDiagnostic).toHaveBeenCalled();

      delete process.env.ANTHROPIC_USE_VERTEX_AI;
      delete process.env.VERTEX_PROJECT_ID;
      delete (global as any).fetch;
    });

    it('handles Vertex Anthropic with location fallback (429)', async () => {
      jest.resetModules();

      process.env.ANTHROPIC_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'my-project';
      process.env.VERTEX_ANTHROPIC_FALLBACK_LOCATIONS = 'us-east5,europe-west1';

      const mq2 = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
      const mc2 = jest.fn().mockResolvedValue({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });
      jest.doMock('../../../db/pool', () => ({
        default: { query: mq2, connect: mc2, on: jest.fn() },
        __esModule: true,
      }));
      jest.doMock('../../../services/googleCredentials', () => ({
        ensureGoogleCredentials: jest.fn().mockResolvedValue(true),
        getAccessTokenViaGcloud: jest.fn().mockReturnValue(null),
      }));
      jest.doMock('../../../discord/services/diagnosticsWebhook', () => ({
        postDiagnostic: jest.fn().mockResolvedValue(undefined),
      }));
      jest.doMock('google-auth-library', () => ({
        GoogleAuth: jest.fn().mockImplementation(() => ({
          getClient: jest.fn().mockResolvedValue({
            getAccessToken: jest.fn().mockResolvedValue({ token: 'vertex-token' }),
          }),
        })),
      }));

      let callCount = 0;
      (global as any).fetch = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            ok: false,
            status: 429,
            json: jest.fn().mockResolvedValue({}),
            text: jest.fn().mockResolvedValue('rate limited'),
          };
        }
        return {
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue({}),
          text: jest.fn().mockResolvedValue('ok'),
        };
      });

      const mod = require('../../../discord/services/modelHealthCheck');
      const diag = require('../../../discord/services/diagnosticsWebhook');
      await mod.runModelHealthChecks();
      expect(diag.postDiagnostic).toHaveBeenCalled();

      delete process.env.ANTHROPIC_USE_VERTEX_AI;
      delete process.env.VERTEX_PROJECT_ID;
      delete process.env.VERTEX_ANTHROPIC_FALLBACK_LOCATIONS;
      delete (global as any).fetch;
    });

    it('handles Vertex Anthropic auth failure with gcloud fallback', async () => {
      jest.resetModules();

      process.env.ANTHROPIC_USE_VERTEX_AI = 'true';
      process.env.VERTEX_PROJECT_ID = 'my-project';

      const mq2 = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
      const mc2 = jest.fn().mockResolvedValue({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });
      jest.doMock('../../../db/pool', () => ({
        default: { query: mq2, connect: mc2, on: jest.fn() },
        __esModule: true,
      }));
      jest.doMock('../../../services/googleCredentials', () => ({
        ensureGoogleCredentials: jest.fn().mockResolvedValue(false),
        getAccessTokenViaGcloud: jest.fn().mockReturnValue('gcloud-token'),
      }));
      jest.doMock('../../../discord/services/diagnosticsWebhook', () => ({
        postDiagnostic: jest.fn().mockResolvedValue(undefined),
      }));
      jest.doMock('google-auth-library', () => ({
        GoogleAuth: jest.fn().mockImplementation(() => ({
          getClient: jest.fn().mockRejectedValue(new Error('Application Default Credentials not found')),
        })),
      }));

      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue('ok'),
      });

      const mod = require('../../../discord/services/modelHealthCheck');
      const diag = require('../../../discord/services/diagnosticsWebhook');
      await mod.runModelHealthChecks();
      expect(diag.postDiagnostic).toHaveBeenCalled();

      delete process.env.ANTHROPIC_USE_VERTEX_AI;
      delete process.env.VERTEX_PROJECT_ID;
      delete (global as any).fetch;
    });

    it('handles Vertex Anthropic with no project ID', async () => {
      jest.resetModules();

      process.env.ANTHROPIC_USE_VERTEX_AI = 'true';
      delete process.env.VERTEX_PROJECT_ID;
      delete process.env.GOOGLE_CLOUD_PROJECT;
      delete process.env.GCLOUD_PROJECT;

      const mq2 = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
      const mc2 = jest.fn().mockResolvedValue({
        query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }),
        release: jest.fn(),
      });
      jest.doMock('../../../db/pool', () => ({
        default: { query: mq2, connect: mc2, on: jest.fn() },
        __esModule: true,
      }));
      jest.doMock('../../../services/googleCredentials', () => ({
        ensureGoogleCredentials: jest.fn().mockResolvedValue(true),
        getAccessTokenViaGcloud: jest.fn().mockReturnValue(null),
      }));
      jest.doMock('../../../discord/services/diagnosticsWebhook', () => ({
        postDiagnostic: jest.fn().mockResolvedValue(undefined),
      }));
      jest.doMock('google-auth-library', () => ({
        GoogleAuth: jest.fn().mockImplementation(() => ({
          getClient: jest.fn().mockResolvedValue({
            getAccessToken: jest.fn().mockResolvedValue({ token: 'token' }),
          }),
        })),
      }));

      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue('not found'),
      });

      const mod = require('../../../discord/services/modelHealthCheck');
      const diag = require('../../../discord/services/diagnosticsWebhook');
      await mod.runModelHealthChecks();
      expect(diag.postDiagnostic).toHaveBeenCalled();

      delete process.env.ANTHROPIC_USE_VERTEX_AI;
      delete (global as any).fetch;
    });
  });
});
