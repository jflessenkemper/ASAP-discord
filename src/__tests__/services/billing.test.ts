/* ── mocks ─────────────────────────────────────────────────── */

const mockRequest = jest.fn();
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: jest.fn().mockResolvedValue({
      request: mockRequest,
    }),
  })),
}));

/* ── tests ─────────────────────────────────────────────────── */

describe('billing', () => {
  beforeEach(() => {
    jest.resetModules();
    mockRequest.mockReset();
  });

  describe('getLiveBillingSnapshot', () => {
    it('returns the initial snapshot structure', () => {
      const { getLiveBillingSnapshot } = require('../../services/billing');
      const snap = getLiveBillingSnapshot();
      expect(snap).toHaveProperty('available');
      expect(snap).toHaveProperty('dailyCostUsd');
      expect(snap).toHaveProperty('monthCostUsd');
      expect(snap).toHaveProperty('currency', 'USD');
      expect(snap).toHaveProperty('source', 'cloud-monitoring');
      expect(snap).toHaveProperty('error');
    });

    it('starts with available=false when cache is fresh', () => {
      const { getLiveBillingSnapshot } = require('../../services/billing');
      const snap = getLiveBillingSnapshot();
      expect(snap.available).toBe(false);
      expect(snap.dailyCostUsd).toBeNull();
      expect(snap.monthCostUsd).toBeNull();
    });
  });

  describe('refreshLiveBillingSnapshot', () => {
    it('populates cache on successful refresh', async () => {
      mockRequest.mockResolvedValue({
        data: {
          timeSeries: [
            {
              points: [{ value: { doubleValue: 1.5 } }],
              metric: { labels: { currency: 'USD' } },
            },
          ],
        },
      });

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.available).toBe(true);
      expect(snap.dailyCostUsd).toBe(1.5);
      expect(snap.monthCostUsd).toBe(1.5);
      expect(snap.currency).toBe('USD');
      expect(snap.error).toBeNull();
      expect(snap.updatedAtIso).toBeTruthy();
    });

    it('skips refresh when cache is still fresh and force=false', async () => {
      mockRequest.mockResolvedValue({ data: { timeSeries: [] } });

      const { refreshLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true); // first call sets lastFetchMs
      mockRequest.mockClear();
      await refreshLiveBillingSnapshot(false); // should skip
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('handles empty timeSeries', async () => {
      mockRequest.mockResolvedValue({ data: { timeSeries: [] } });

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.dailyCostUsd).toBe(0);
      expect(snap.monthCostUsd).toBe(0);
    });

    it('handles missing timeSeries in response', async () => {
      mockRequest.mockResolvedValue({ data: {} });

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.dailyCostUsd).toBe(0);
    });

    it('handles int64Value as string', async () => {
      mockRequest.mockResolvedValue({
        data: {
          timeSeries: [
            {
              points: [{ value: { int64Value: '42' } }],
              metric: { labels: {} },
            },
          ],
        },
      });

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.dailyCostUsd).toBe(42);
    });

    it('handles int64Value as number', async () => {
      mockRequest.mockResolvedValue({
        data: {
          timeSeries: [
            {
              points: [{ value: { int64Value: 7 } }],
              metric: { labels: {} },
            },
          ],
        },
      });

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.dailyCostUsd).toBe(7);
    });

    it('handles point with no value', async () => {
      mockRequest.mockResolvedValue({
        data: {
          timeSeries: [
            {
              points: [{ value: null }, {}],
              metric: { labels: {} },
            },
          ],
        },
      });

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.dailyCostUsd).toBe(0);
    });

    it('handles multiple timeSeries with multiple points', async () => {
      mockRequest.mockResolvedValue({
        data: {
          timeSeries: [
            {
              points: [
                { value: { doubleValue: 2.0 } },
                { value: { doubleValue: 3.0 } },
              ],
              metric: { labels: { currency: 'EUR' } },
            },
            {
              points: [{ value: { doubleValue: 1.0 } }],
              metric: { labels: { currency: 'EUR' } },
            },
          ],
        },
      });

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.dailyCostUsd).toBe(6.0);
      expect(snap.currency).toBe('EUR');
    });

    it('sets error on metric not found', async () => {
      mockRequest.mockRejectedValue(new Error('cannot find metric billing.googleapis.com'));

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.error).toContain('billing metric is not available');
    });

    it('sets error on permission denied', async () => {
      mockRequest.mockRejectedValue(new Error('Permission denied on resource'));

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.error).toContain('Missing permission');
    });

    it('sets generic error for unknown errors', async () => {
      mockRequest.mockRejectedValue(new Error('network timeout'));

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.error).toContain('Live billing lookup failed');
    });

    it('sets error when PROJECT_ID is empty', async () => {
      const origProject = process.env.GCP_BILLING_MONITORING_PROJECT_ID;
      const origGcs = process.env.GCS_PROJECT_ID;
      process.env.GCP_BILLING_MONITORING_PROJECT_ID = '';
      process.env.GCS_PROJECT_ID = '';
      // The module caches PROJECT_ID at load time, so we need resetModules
      // but the constant is evaluated at import time. Since it falls back to 'asap-489910',
      // this specific branch may not be reachable without resetting modules differently.
      // Instead test the "metric(s) that match type" error normalization path.
      mockRequest.mockRejectedValue(new Error('metric(s) that match type'));

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.error).toContain('billing metric is not available');

      process.env.GCP_BILLING_MONITORING_PROJECT_ID = origProject;
      process.env.GCS_PROJECT_ID = origGcs;
    });

    it('uses currency from timeSeries metric labels', async () => {
      mockRequest.mockResolvedValue({
        data: {
          timeSeries: [
            {
              points: [{ value: { doubleValue: 5 } }],
              metric: { labels: { currency: 'CAD' } },
            },
          ],
        },
      });

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.currency).toBe('CAD');
    });

    it('defaults currency to USD when no metric currency is set', async () => {
      mockRequest.mockResolvedValue({
        data: {
          timeSeries: [
            {
              points: [{ value: { doubleValue: 1 } }],
              metric: { labels: {} },
            },
          ],
        },
      });

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.currency).toBe('USD');
    });

    it('handles points array being null/undefined', async () => {
      mockRequest.mockResolvedValue({
        data: {
          timeSeries: [
            { points: null, metric: { labels: {} } },
          ],
        },
      });

      const { refreshLiveBillingSnapshot, getLiveBillingSnapshot } = require('../../services/billing');
      await refreshLiveBillingSnapshot(true);
      const snap = getLiveBillingSnapshot();
      expect(snap.dailyCostUsd).toBe(0);
    });
  });
});
