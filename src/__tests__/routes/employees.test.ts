import bcrypt from 'bcryptjs';
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

jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn().mockResolvedValue('new-hash'),
}));

jest.mock('../../services/storage', () => ({
  uploadEvidence: jest.fn().mockResolvedValue('https://storage.example.com/pic.jpg'),
}));

import employeeRoutes from '../../routes/employees';

function makeToken(userId: string, userType: 'client' | 'employee') {
  return jwt.sign({ userId, userType }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/employees', employeeRoutes);
  return app;
}

function mockAuthSession() {
  mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-id' }] });
}

describe('Employee Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  // ─── GET /api/employees/profile ───
  describe('GET /api/employees/profile', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await request(app).get('/api/employees/profile');
      expect(res.status).toBe(401);
    });

    it('returns 403 for client user', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .get('/api/employees/profile')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('returns profile with computed level info', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'emp-1', username: 'admin', email: 'a@b.com',
          rate_per_minute: 5, is_active: true, total_minutes: 3500,
          profile_picture_url: null, banner_url: null, bio: 'Hi',
          latitude: null, longitude: null, created_at: '2024-01-01',
        }],
      });

      const res = await request(app)
        .get('/api/employees/profile')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.level).toBe(3);
      expect(res.body.xp).toBe(500);
      expect(res.body.taxRate).toBeCloseTo(24.955, 1);
    });
  });

  // ─── PATCH /api/employees/rate ───
  describe('PATCH /api/employees/rate', () => {
    it('returns 400 for rate <= 0', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();

      const res = await request(app)
        .patch('/api/employees/rate')
        .set('Authorization', `Bearer ${token}`)
        .send({ rate_per_minute: 0 });
      expect(res.status).toBe(400);
    });

    it('returns 400 for rate > 10', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();

      const res = await request(app)
        .patch('/api/employees/rate')
        .set('Authorization', `Bearer ${token}`)
        .send({ rate_per_minute: 15 });
      expect(res.status).toBe(400);
    });

    it('returns 400 for non-number rate', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();

      const res = await request(app)
        .patch('/api/employees/rate')
        .set('Authorization', `Bearer ${token}`)
        .send({ rate_per_minute: 'five' });
      expect(res.status).toBe(400);
    });

    it('updates rate successfully', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .patch('/api/employees/rate')
        .set('Authorization', `Bearer ${token}`)
        .send({ rate_per_minute: 7.50 });

      expect(res.status).toBe(200);
      expect(res.body.rate_per_minute).toBe(7.50);
    });
  });

  // ─── POST /api/employees/change-password ───
  describe('POST /api/employees/change-password', () => {
    it('returns 400 when passwords missing', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();

      const res = await request(app)
        .post('/api/employees/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 for too-short new password', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();

      const res = await request(app)
        .post('/api/employees/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ current_password: 'old', new_password: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/8 and 128/);
    });

    it('returns 401 for incorrect current password', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({ rows: [{ password_hash: 'old-hash' }] });
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);

      const res = await request(app)
        .post('/api/employees/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ current_password: 'wrong', new_password: 'newpassword123' });
      expect(res.status).toBe(401);
    });

    it('changes password on valid request', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({ rows: [{ password_hash: 'old-hash' }] });
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/employees/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ current_password: 'correct', new_password: 'newpassword123' });
      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/changed/i);
    });
  });

  // ─── GET /api/employees/earnings ───
  describe('GET /api/employees/earnings', () => {
    it('returns earnings with tax breakdown', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      // Employee info
      mockQuery.mockResolvedValueOnce({ rows: [{ total_minutes: 5000 }] });
      // Earnings aggregate
      mockQuery.mockResolvedValueOnce({
        rows: [{
          all_time_total: '1000.00', job_count: '20',
          today: '50.00', this_week: '200.00', this_month: '400.00',
        }],
      });
      // Recent jobs
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'j1', description: 'Fix PC', total_seconds: 3600, total_cost: '300',
          is_free: false, completed_at: '2024-01-15', fuel_cost: null,
          difficulty_rating: 5, client_first_name: 'Test', client_last_name: 'User',
        }],
      });

      const res = await request(app)
        .get('/api/employees/earnings')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.total_jobs).toBe(20);
      expect(res.body.all_time_gross).toBe(1000);
      expect(res.body.level).toBe(5);
      expect(res.body.recent_jobs[0].client_name).toBe('Test User');
      expect(res.body.recent_jobs[0].net_earnings).toBeDefined();
    });
  });

  // ─── PATCH /api/employees/profile ───
  describe('PATCH /api/employees/profile', () => {
    it('returns 400 when no fields to update', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();

      const res = await request(app)
        .patch('/api/employees/profile')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no fields/i);
    });

    it('returns 400 for bio over 500 chars', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();

      const res = await request(app)
        .patch('/api/employees/profile')
        .set('Authorization', `Bearer ${token}`)
        .field('bio', 'x'.repeat(501));
      expect(res.status).toBe(400);
    });

    it('updates bio successfully', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [{ profile_picture_url: null, banner_url: null, bio: 'New bio' }],
      });

      const res = await request(app)
        .patch('/api/employees/profile')
        .set('Authorization', `Bearer ${token}`)
        .field('bio', 'New bio');

      expect(res.status).toBe(200);
      expect(res.body.bio).toBe('New bio');
    });
  });
});
