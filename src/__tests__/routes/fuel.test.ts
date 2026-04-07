import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const JWT_SECRET = 'test-jwt-secret-for-testing-only';

const mockQuery = jest.fn();
jest.mock('../../db/pool', () => ({
  __esModule: true,
  default: { query: mockQuery, on: jest.fn() },
}));

jest.mock('../../services/fuel', () => ({
  getBestPricesByType: jest.fn().mockResolvedValue([
    {
      fuelType: 'P98', fuelLabel: 'Premium 98', pricePerLitre: 2.15,
      stationName: 'Shell', stationBrand: 'Shell', stationAddress: '1 Main St',
      stationLat: -33.86, stationLng: 151.20, distanceKm: 2.5,
    },
  ]),
}));

import fuelRoutes from '../../routes/fuel';

function makeToken(userId: string, userType: 'client' | 'employee') {
  return jwt.sign({ userId, userType }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/fuel', fuelRoutes);
  return app;
}

function mockAuthSession() {
  mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-id' }] });
}

describe('Fuel Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  describe('GET /api/fuel/best-prices', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/fuel/best-prices?lat=-33.8&lng=151.2');
      expect(res.status).toBe(401);
    });

    it('returns 400 for missing lat/lng', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .get('/api/fuel/best-prices')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid coordinates', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .get('/api/fuel/best-prices?lat=100&lng=151')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('returns prices for valid coordinates', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      // Non-blocking analytics insert
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/fuel/best-prices?lat=-33.8&lng=151.2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.prices).toHaveLength(1);
      expect(res.body.prices[0].fuelType).toBe('P98');
    });

    it('clamps radius to min 1 and max 50', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(app)
        .get('/api/fuel/best-prices?lat=-33.8&lng=151.2&radius=100')
        .set('Authorization', `Bearer ${token}`);

      // Verify the analytics insert used clamped radius
      const { getBestPricesByType } = require('../../services/fuel');
      expect(getBestPricesByType).toHaveBeenCalledWith(-33.8, 151.2, 50);
    });
  });
});
