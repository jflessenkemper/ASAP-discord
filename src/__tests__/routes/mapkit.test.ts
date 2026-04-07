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

import mapkitRoutes from '../../routes/mapkit';

function makeToken(userId: string, userType: 'client' | 'employee') {
  return jwt.sign({ userId, userType }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/mapkit', mapkitRoutes);
  return app;
}

function mockAuthSession() {
  mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-id' }] });
}

describe('MapKit Routes', () => {
  let app: express.Express;
  const origEnv = process.env;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
    mockQuery.mockReset();
    process.env = { ...origEnv, JWT_SECRET };
  });

  afterAll(() => {
    process.env = origEnv;
  });

  describe('GET /api/mapkit/token', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).get('/api/mapkit/token');
      expect(res.status).toBe(401);
    });

    it('returns 503 when MapKit env vars are not configured', async () => {
      delete process.env.APPLE_TEAM_ID;
      delete process.env.APPLE_MAPKIT_KEY_ID;
      delete process.env.APPLE_MAPKIT_PRIVATE_KEY;

      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .get('/api/mapkit/token')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/i);
    });

    it('returns 503 when only partial env vars are set', async () => {
      process.env.APPLE_TEAM_ID = 'TEAM123';
      delete process.env.APPLE_MAPKIT_KEY_ID;
      delete process.env.APPLE_MAPKIT_PRIVATE_KEY;

      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .get('/api/mapkit/token')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(503);
    });
  });
});
