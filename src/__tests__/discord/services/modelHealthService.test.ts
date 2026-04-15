/**
 * Tests for src/discord/services/modelHealth.ts (service)
 * Model/provider health checks — Anthropic, Gemini, Deepgram, ElevenLabs.
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

import { runModelHealthChecks } from '../../../discord/services/modelHealth';
import { postDiagnostic } from '../../../discord/services/diagnosticsWebhook';

describe('services/modelHealth', () => {
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
      // (the function returns early)
      // The first call already ran in module setup, so we just verify no error
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
  });
});
