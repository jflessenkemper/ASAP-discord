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

import favoritesRoutes from '../../routes/favorites';

function makeToken(userId: string, userType: 'client' | 'employee') {
  return jwt.sign({ userId, userType }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/favorites', favoritesRoutes);
  return app;
}

function mockAuthSession() {
  mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-id' }] });
}

describe('Favorites Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  describe('GET /api/favorites', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/favorites');
      expect(res.status).toBe(401);
    });

    it('returns 403 for employee', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();

      const res = await request(app)
        .get('/api/favorites')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('returns saved items for client', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'item-1', item_type: 'fuel', item_data: { stationName: 'Shell' }, created_at: '2024-01-01' },
        ],
      });

      const res = await request(app)
        .get('/api/favorites')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
    });
  });

  describe('POST /api/favorites', () => {
    it('returns 400 for missing item_type', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/favorites')
        .set('Authorization', `Bearer ${token}`)
        .send({ item_data: { name: 'test' } });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid item_type', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/favorites')
        .set('Authorization', `Bearer ${token}`)
        .send({ item_type: 'malicious', item_data: { name: 'test' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/must be/i);
    });

    it('returns 400 for oversized item_data', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/favorites')
        .set('Authorization', `Bearer ${token}`)
        .send({ item_type: 'fuel', item_data: { large: 'x'.repeat(10001) } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/too large/i);
    });

    it('saves item successfully', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'new-id', item_type: 'fuel', item_data: { stationName: 'Shell' }, created_at: '2024-01-01' }],
      });

      const res = await request(app)
        .post('/api/favorites')
        .set('Authorization', `Bearer ${token}`)
        .send({ item_type: 'fuel', item_data: { stationName: 'Shell' } });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('new-id');
    });
  });

  describe('DELETE /api/favorites/:id', () => {
    it('returns 404 when item not found or not owned', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request(app)
        .delete('/api/favorites/nonexistent-id')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it('deletes item successfully', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request(app)
        .delete('/api/favorites/item-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('ensures client can only delete their own items via parameterized query', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await request(app)
        .delete('/api/favorites/item-1')
        .set('Authorization', `Bearer ${token}`);

      // Verify the DELETE query includes client_id check
      const deleteCall = mockQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM saved_items')
      );
      expect(deleteCall![0]).toContain('client_id = $2');
      expect(deleteCall![1]).toEqual(['item-1', 'client-1']);
    });
  });
});
