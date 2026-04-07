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

jest.mock('../../services/gemini', () => ({
  searchBestPrices: jest.fn().mockResolvedValue([
    { title: 'iPhone 15', price: 1399, priceText: '$1,399', source: 'JB Hi-Fi', sourceUrl: 'https://jbhifi.com.au/iphone' },
  ]),
}));

import shopRoutes from '../../routes/shop';

function makeToken(userId: string, userType: 'client' | 'employee') {
  return jwt.sign({ userId, userType }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/shop', shopRoutes);
  return app;
}

function mockAuthSession() {
  mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-id' }] });
}

describe('Shop Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  describe('POST /api/shop/search', () => {
    it('returns 400 for empty query', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/shop/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: '' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for query over 200 chars', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/shop/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'x'.repeat(201) });
      expect(res.status).toBe(400);
    });

    it('returns 403 for employee', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();

      const res = await request(app)
        .post('/api/shop/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'iPhone' });
      expect(res.status).toBe(403);
    });

    it('returns search results and stores history', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      // Store search history
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/shop/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'iPhone 15' });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].title).toBe('iPhone 15');
    });
  });

  describe('GET /api/shop/history', () => {
    it('returns search history for client', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'sh-1', query: 'iPhone', results: [], created_at: '2024-01-01' },
        ],
      });

      const res = await request(app)
        .get('/api/shop/history')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.history).toHaveLength(1);
    });
  });
});
