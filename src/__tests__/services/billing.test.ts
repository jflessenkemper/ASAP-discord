import { getLiveBillingSnapshot } from '../../services/billing';

/* ── mocks ─────────────────────────────────────────────────── */

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: jest.fn().mockResolvedValue({
      request: jest.fn().mockResolvedValue({ data: { timeSeries: [] } }),
    }),
  })),
}));

/* ── tests ─────────────────────────────────────────────────── */

describe('billing', () => {
  describe('getLiveBillingSnapshot', () => {
    it('returns the initial snapshot structure', () => {
      const snap = getLiveBillingSnapshot();
      expect(snap).toHaveProperty('available');
      expect(snap).toHaveProperty('dailyCostUsd');
      expect(snap).toHaveProperty('monthCostUsd');
      expect(snap).toHaveProperty('currency', 'USD');
      expect(snap).toHaveProperty('source', 'cloud-monitoring');
      expect(snap).toHaveProperty('error');
    });

    it('starts with available=false when cache is fresh', () => {
      const snap = getLiveBillingSnapshot();
      expect(snap.available).toBe(false);
      expect(snap.dailyCostUsd).toBeNull();
      expect(snap.monthCostUsd).toBeNull();
    });
  });
});
