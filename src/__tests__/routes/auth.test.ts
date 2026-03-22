import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// Bypass rate limiters in tests
jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock pool before importing routes
jest.mock('../../db/pool', () => {
  const mockQuery = jest.fn();
  return {
    __esModule: true,
    default: { query: mockQuery, on: jest.fn(), connect: jest.fn() },
    mockQuery,
  };
});

// Mock email service
jest.mock('../../services/email', () => ({
  generateCode: jest.fn().mockReturnValue('123456'),
  sendTwoFactorCode: jest.fn().mockResolvedValue(undefined),
}));

// Mock google-auth-library
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: jest.fn().mockResolvedValue({
      getPayload: () => ({
        email: 'test@google.com',
        given_name: 'Test',
        family_name: 'User',
        sub: 'google-sub-123',
      }),
    }),
  })),
}));

// Mock apple-signin-auth
jest.mock('apple-signin-auth', () => ({
  verifyIdToken: jest.fn().mockResolvedValue({
    email: 'test@apple.com',
    sub: 'apple-sub-123',
  }),
}));

// Mock bcryptjs
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));

import pool from '../../db/pool';
import authRoutes from '../../routes/auth';
import bcrypt from 'bcryptjs';

const mockPool = pool as any;
const mockPoolQuery = mockPool.query as jest.Mock;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  return app;
}

describe('Auth Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
    mockPoolQuery.mockReset();
  });

  // ─── POST /api/auth/social ───
  describe('POST /api/auth/social', () => {
    it('returns 400 when provider is missing', async () => {
      const res = await request(app)
        .post('/api/auth/social')
        .send({ id_token: 'some-token' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Provider/i);
    });

    it('returns 400 when id_token and access_token are both missing', async () => {
      const res = await request(app)
        .post('/api/auth/social')
        .send({ provider: 'google' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/id_token or access_token/i);
    });

    it('returns 400 for invalid provider', async () => {
      const res = await request(app)
        .post('/api/auth/social')
        .send({ provider: 'github', id_token: 'token' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/must be/i);
    });

    it('creates new account for Google id_token login', async () => {
      // No existing account by provider
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // No existing account by email
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT new client
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'client-uuid',
          first_name: 'Test',
          last_name: 'User',
          email: 'test@google.com',
        }],
      });
      // INSERT session
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Auth event log (non-blocking)
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/social')
        .send({ provider: 'google', id_token: 'valid-google-token' });

      expect(res.status).toBe(201);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.email).toBe('test@google.com');
    });

    it('logs in existing account by provider + provider_id', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'existing-client-uuid',
          first_name: 'Test',
          last_name: 'User',
          email: 'test@google.com',
        }],
      });
      // INSERT session
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Auth event log
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/social')
        .send({ provider: 'google', id_token: 'valid-google-token' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.id).toBe('existing-client-uuid');
    });
  });

  // ─── POST /api/auth/email-signup ───
  describe('POST /api/auth/email-signup', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/auth/email-signup')
        .send({ email: 'a@b.com' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/required/i);
    });

    it('returns 400 for invalid email format', async () => {
      const res = await request(app)
        .post('/api/auth/email-signup')
        .send({ first_name: 'A', last_name: 'B', email: 'not-an-email' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/valid email/i);
    });

    it('returns 400 for excessively long name', async () => {
      const res = await request(app)
        .post('/api/auth/email-signup')
        .send({ first_name: 'A'.repeat(101), last_name: 'B', email: 'a@b.com' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/100 characters/i);
    });

    it('returns 409 when email already exists', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }] });

      const res = await request(app)
        .post('/api/auth/email-signup')
        .send({ first_name: 'Test', last_name: 'User', email: 'existing@test.com' });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already exists/i);
    });

    it('creates account and returns token for valid signup', async () => {
      // No existing
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'new-uuid', first_name: 'Test', last_name: 'User', email: 'new@test.com' }],
      });
      // Session
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/email-signup')
        .send({ first_name: 'Test', last_name: 'User', email: 'new@test.com' });

      expect(res.status).toBe(201);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.first_name).toBe('Test');
    });
  });

  // ─── POST /api/auth/employee/login ───
  describe('POST /api/auth/employee/login', () => {
    it('returns 400 when username or password is missing', async () => {
      const res = await request(app)
        .post('/api/auth/employee/login')
        .send({ username: 'admin' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/required/i);
    });

    it('returns 401 for non-existent employee', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Auth event
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/employee/login')
        .send({ username: 'nobody', password: 'pass' });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/credentials/i);
    });

    it('returns 403 for deactivated employee', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'emp-1', username: 'admin', email: 'a@b.com', password_hash: 'hash', is_active: false }],
      });
      // Auth event
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/employee/login')
        .send({ username: 'admin', password: 'pass' });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/deactivated/i);
    });

    it('returns 401 for wrong password', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'emp-1', username: 'admin', email: 'a@b.com', password_hash: 'hash', is_active: true }],
      });
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
      // Auth event
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/employee/login')
        .send({ username: 'admin', password: 'wrong' });

      expect(res.status).toBe(401);
    });

    it('sends 2FA code on valid credentials', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'emp-1', username: 'admin', email: 'admin@asap.com', password_hash: 'hash', is_active: true }],
      });
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
      // Invalidate old codes
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Insert new 2FA code
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Auth event
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/employee/login')
        .send({ username: 'admin', password: 'correct' });

      expect(res.status).toBe(200);
      expect(res.body.employee_id).toBe('emp-1');
      expect(res.body.message).toMatch(/verification code/i);
    });
  });

  // ─── POST /api/auth/employee/verify-2fa ───
  describe('POST /api/auth/employee/verify-2fa', () => {
    it('returns 400 when employee_id or code is missing', async () => {
      const res = await request(app)
        .post('/api/auth/employee/verify-2fa')
        .send({ employee_id: 'emp-1' });
      expect(res.status).toBe(400);
    });

    it('returns 401 for invalid/expired code', async () => {
      // No matching code
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Auth event
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Fail count
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ cnt: '1' }] });

      const res = await request(app)
        .post('/api/auth/employee/verify-2fa')
        .send({ employee_id: 'emp-1', code: '000000' });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid or expired/i);
    });

    it('invalidates all codes after 3 failed attempts', async () => {
      // Code not found
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // logAuthEvent (fire-and-forget)
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Fail count >= 3
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ cnt: '3' }] });
      // Invalidate all codes
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/employee/verify-2fa')
        .send({ employee_id: 'emp-1', code: '000000' });

      expect(res.status).toBe(401);

      // Allow fire-and-forget logAuthEvent to settle
      await new Promise(r => setTimeout(r, 50));

      // Verify invalidation query was called
      const calls = mockPoolQuery.mock.calls;
      const invalidationCall = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('UPDATE two_factor_codes SET used = TRUE')
      );
      expect(invalidationCall).toBeDefined();
    });

    it('logs in employee on valid code', async () => {
      // Valid code found
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'code-id' }] });
      // Mark code as used
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Get employee info
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'emp-1', username: 'admin', email: 'a@b.com',
          rate_per_minute: 5, is_active: true, total_minutes: 2500,
          profile_picture_url: null, banner_url: null, bio: '',
          latitude: null, longitude: null, created_at: new Date().toISOString(),
        }],
      });
      // Create session
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Auth event
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/employee/verify-2fa')
        .send({ employee_id: 'emp-1', code: '123456' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.username).toBe('admin');
      // Verify level computation
      expect(res.body.user.level).toBe(2);
      expect(res.body.user.xp).toBe(500);
    });
  });

  // ─── GET /api/auth/me ───
  describe('GET /api/auth/me', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });
  });

  // ─── POST /api/auth/test-login ───
  describe('POST /api/auth/test-login', () => {
    it('returns 401 for wrong test credentials', async () => {
      const res = await request(app)
        .post('/api/auth/test-login')
        .send({ username: 'wrong', password: 'wrong' });
      expect(res.status).toBe(401);
    });

    it('creates/returns test user with correct credentials', async () => {
      // Existing test user
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'test-uuid', first_name: 'Test', last_name: 'User', email: 'test@asap.dev' }],
      });
      // Session
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      // Auth event
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/test-login')
        .send({ username: 'testuser', password: 'testpass' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
    });
  });
});
