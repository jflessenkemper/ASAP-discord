const mockRequest = jest.fn();
const mockGetClient = jest.fn().mockResolvedValue({ request: mockRequest });

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: mockGetClient,
  })),
}));

jest.mock('../../services/googleCredentials', () => ({
  getAccessTokenViaGcloud: jest.fn().mockReturnValue(null),
}));

import { listRevisions, getCurrentRevision, rollbackToRevision, triggerCloudBuild } from '../../services/cloudrun';
import { getAccessTokenViaGcloud } from '../../services/googleCredentials';

const mockGetAccessToken = getAccessTokenViaGcloud as jest.Mock;

describe('cloudrun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequest.mockReset();
    mockGetClient.mockReset();
    mockGetClient.mockResolvedValue({ request: mockRequest });
    (getAccessTokenViaGcloud as jest.Mock).mockReturnValue(null);
  });

  describe('listRevisions', () => {
    it('returns parsed revision list', async () => {
      mockRequest.mockResolvedValueOnce({
        data: {
          revisions: [
            {
              name: 'projects/p/locations/l/revisions/rev-001',
              uid: 'uid-1',
              createTime: '2024-01-01T00:00:00Z',
              template: { containers: [{ image: 'gcr.io/p/app:v1' }] },
            },
          ],
        },
      });

      const revisions = await listRevisions(1);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({
        name: 'rev-001',
        uid: 'uid-1',
        image: 'gcr.io/p/app:v1',
      });
    });

    it('returns empty array when no revisions', async () => {
      mockRequest.mockResolvedValueOnce({ data: {} });
      const revisions = await listRevisions();
      expect(revisions).toEqual([]);
    });
  });

  describe('getCurrentRevision', () => {
    it('returns the active revision name', async () => {
      mockRequest.mockResolvedValueOnce({
        data: { traffic: [{ revision: 'rev-abc', percent: 100 }] },
      });
      const rev = await getCurrentRevision();
      expect(rev).toBe('rev-abc');
    });

    it('returns unknown when no 100% traffic target', async () => {
      mockRequest.mockResolvedValueOnce({ data: { traffic: [] } });
      const rev = await getCurrentRevision();
      expect(rev).toBe('unknown');
    });
  });

  describe('rollbackToRevision', () => {
    it('patches service with new traffic config', async () => {
      // GET current service
      mockRequest.mockResolvedValueOnce({ data: { traffic: [{ revision: 'old', percent: 100 }] } });
      // PATCH
      mockRequest.mockResolvedValueOnce({ data: {} });

      const result = await rollbackToRevision('rev-target');
      expect(result).toContain('rev-target');
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe('triggerCloudBuild', () => {
    it('returns buildId and logUrl', async () => {
      mockRequest.mockResolvedValueOnce({
        data: {
          metadata: {
            build: { id: 'build-123', logUrl: 'https://console.cloud.google.com/build/123' },
          },
        },
      });

      const result = await triggerCloudBuild('abc1234');
      expect(result.buildId).toBe('build-123');
      expect(result.logUrl).toContain('build/123');
    });

    it('returns fallback buildId and logUrl when metadata is sparse', async () => {
      mockRequest.mockResolvedValueOnce({
        data: {
          name: 'operations/build-456',
        },
      });

      const result = await triggerCloudBuild('def5678');
      expect(result.buildId).toBe('build-456');
      expect(result.logUrl).toContain('build-456');
    });

    it('returns unknown when no name or metadata', async () => {
      mockRequest.mockResolvedValueOnce({ data: {} });

      const result = await triggerCloudBuild('xyz');
      expect(result.buildId).toBe('unknown');
    });
  });

  describe('requestWithCloudAuth gcloud fallback', () => {
    it('falls back to gcloud token when primary auth fails', async () => {
      mockGetClient.mockRejectedValueOnce(new Error('ADC not configured'));
      mockGetAccessToken.mockReturnValueOnce('gcloud-token-123');

      const mockFetchResponse = {
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ traffic: [{ revision: 'rev-fallback', percent: 100 }] }),
      };
      global.fetch = jest.fn().mockResolvedValue(mockFetchResponse) as any;

      const rev = await getCurrentRevision();
      expect(rev).toBe('rev-fallback');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('run.googleapis.com'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer gcloud-token-123' }),
        })
      );
    });

    it('throws primary error when gcloud token is also unavailable', async () => {
      mockGetClient.mockRejectedValueOnce(new Error('ADC not configured'));
      mockGetAccessToken.mockReturnValueOnce(null);

      await expect(getCurrentRevision()).rejects.toThrow('ADC not configured');
    });

    it('throws on non-ok response from gcloud fallback', async () => {
      mockGetClient.mockRejectedValueOnce(new Error('ADC fail'));
      mockGetAccessToken.mockReturnValueOnce('gcloud-token');

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: jest.fn().mockResolvedValue('Forbidden'),
      }) as any;

      await expect(getCurrentRevision()).rejects.toThrow(/Cloud API GET .* failed \(403\)/);
    });

    it('returns empty object for 204 responses', async () => {
      mockGetClient.mockRejectedValueOnce(new Error('ADC fail'));
      mockGetAccessToken.mockReturnValueOnce('gcloud-token');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 204,
      }) as any;

      // rollbackToRevision does GET then PATCH. First call: GET succeeds normally; second: 204 fallback
      mockGetClient.mockResolvedValueOnce({ request: mockRequest });
      mockRequest.mockResolvedValueOnce({ data: { traffic: [] } });

      // For the PATCH, primary fails, gcloud succeeds with 204
      mockGetClient.mockRejectedValueOnce(new Error('ADC fail'));
      mockGetAccessToken.mockReturnValueOnce('gcloud-token');
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 }) as any;

      const result = await rollbackToRevision('rev-204');
      expect(result).toContain('rev-204');
    });

    it('handles json parse failure gracefully', async () => {
      mockGetClient.mockRejectedValueOnce(new Error('ADC fail'));
      mockGetAccessToken.mockReturnValueOnce('gcloud-token');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockRejectedValue(new Error('invalid json')),
      }) as any;

      // Should return empty object when json fails
      const rev = await getCurrentRevision();
      expect(rev).toBe('unknown');
    });

    it('sends body with Content-Type when body is provided in gcloud fallback', async () => {
      // GET current service - succeeds normally via primary auth
      mockGetClient.mockResolvedValueOnce({ request: mockRequest });
      mockRequest.mockResolvedValueOnce({ data: { traffic: [] } });
      // PATCH fails with primary, falls back to gcloud
      mockGetClient.mockRejectedValueOnce(new Error('ADC fail'));
      mockGetAccessToken.mockReturnValueOnce('gcloud-token');

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({}),
      }) as any;

      await rollbackToRevision('rev-body');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          body: expect.any(String),
        })
      );
    });

    it('handles text() failure on error response', async () => {
      mockGetClient.mockRejectedValueOnce(new Error('ADC fail'));
      mockGetAccessToken.mockReturnValueOnce('gcloud-token');

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: jest.fn().mockRejectedValue(new Error('text error')),
      }) as any;

      await expect(getCurrentRevision()).rejects.toThrow(/Cloud API GET .* failed \(500\)/);
    });
  });

  describe('listRevisions edge cases', () => {
    it('handles revisions without name or template', async () => {
      mockRequest.mockResolvedValueOnce({
        data: {
          revisions: [
            { uid: 'uid-no-name', createTime: '2024-01-01', template: {} },
          ],
        },
      });

      const revisions = await listRevisions();
      expect(revisions[0].name).toBe('uid-no-name');
      expect(revisions[0].image).toBe('unknown');
    });
  });
});
