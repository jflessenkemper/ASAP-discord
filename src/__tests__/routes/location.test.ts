import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret-for-testing-only';

const mockQuery = jest.fn();
jest.mock('../../db/pool', () => ({
  __esModule: true,
  default: { query: mockQuery, on: jest.fn() },
}));

import locationRoutes from '../../routes/location';

function makeToken(userId: string, userType: 'client' | 'employee') {
  return jwt.sign({ userId, userType }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/location', locationRoutes);
  return app;
}

function mockAuthSession() {
  mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-id' }] });
}

describe('Location Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  describe('POST /api/location', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/location')
        .send({ latitude: -33.8, longitude: 151.2 });
      expect(res.status).toBe(401);
    });

    it('returns 400 for non-number coordinates', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/location')
        .set('Authorization', `Bearer ${token}`)
        .send({ latitude: 'abc', longitude: 151 });
      expect(res.status).toBe(400);
    });

    it('returns 400 for out-of-range latitude', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/location')
        .set('Authorization', `Bearer ${token}`)
        .send({ latitude: 91, longitude: 151 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid/i);
    });

    it('returns 400 for out-of-range longitude', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/location')
        .set('Authorization', `Bearer ${token}`)
        .send({ latitude: -33.8, longitude: 200 });
      expect(res.status).toBe(400);
    });

    it('updates client location', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/location')
        .set('Authorization', `Bearer ${token}`)
        .send({ latitude: -33.8688, longitude: 151.2093 });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/updated/i);
    });

    it('updates employee location', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/location')
        .set('Authorization', `Bearer ${token}`)
        .send({ latitude: -33.8, longitude: 151.2 });

      expect(res.status).toBe(200);
      // Verify it updated employees table (not clients)
      const updateCall = mockQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE employees')
      );
      expect(updateCall).toBeDefined();
    });
  });

  describe('GET /api/location/geocode', () => {
    it('returns 400 for empty query', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .get('/api/location/geocode?q=')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('returns 400 for query over 100 chars', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .get('/api/location/geocode?q=' + 'a'.repeat(101))
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });
  });
});
