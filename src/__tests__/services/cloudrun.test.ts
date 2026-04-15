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

describe('cloudrun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
  });
});
