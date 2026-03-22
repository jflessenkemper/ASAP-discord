import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret-for-testing-only';

// Mock pool
const mockQuery = jest.fn();
jest.mock('../../db/pool', () => ({
  __esModule: true,
  default: { query: mockQuery, on: jest.fn() },
}));

// Mock gemini
jest.mock('../../services/gemini', () => ({
  assessJobDifficulty: jest.fn().mockResolvedValue({ difficulty: 5, estimatedMinutes: 60 }),
  transcribeAudio: jest.fn().mockResolvedValue('transcribed text'),
  categorizeJob: jest.fn().mockResolvedValue('plumber'),
}));

// Mock fuel
jest.mock('../../services/fuel', () => ({
  calculateFuelCost: jest.fn().mockResolvedValue({ distanceKm: 10.5, fuelCost: 3.20, pricePerLitre: 2.30, stationName: 'Shell' }),
  haversineKm: jest.fn().mockReturnValue(5.0),
}));

// Mock storage
jest.mock('../../services/storage', () => ({
  uploadEvidence: jest.fn().mockResolvedValue('https://storage.example.com/photo.jpg'),
}));

import jobRoutes from '../../routes/jobs';

function makeToken(userId: string, userType: 'client' | 'employee') {
  return jwt.sign({ userId, userType }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/jobs', jobRoutes);
  return app;
}

// Helper to setup auth mock (session check in requireAuth)
function mockAuthSession() {
  // Session exists
  mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-id' }] });
}

describe('Jobs Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  // ─── POST /api/jobs (Create job) ───
  describe('POST /api/jobs', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await request(app).post('/api/jobs').send({ description: 'Fix my PC' });
      expect(res.status).toBe(401);
    });

    it('returns 403 when employee tries to create job', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      const res = await request(app)
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'Fix my PC' });
      expect(res.status).toBe(403);
    });

    it('returns 400 when description is empty', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      const res = await request(app)
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({ description: '' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/description/i);
    });

    it('returns 400 when description exceeds 2000 chars', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      const res = await request(app)
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'x'.repeat(2001) });
      expect(res.status).toBe(400);
    });

    it('creates job and returns 201 with auto-assignment', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      // Active employee
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'emp-1', rate_per_minute: 5 }] });
      // INSERT job
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'job-uuid', client_id: 'client-1', employee_id: 'emp-1',
          description: 'Fix my PC', status: 'assigned', rate_per_minute: 5,
        }],
      });
      // Timeline: created
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Timeline: assigned
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'Fix my PC' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('job-uuid');
      expect(res.body.status).toBe('assigned');
    });

    it('creates pending job when no employees available', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      // No active employees
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // INSERT job
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'job-uuid', client_id: 'client-1', employee_id: null,
          description: 'Fix my PC', status: 'pending',
        }],
      });
      // Timeline: created
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'Fix my PC' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');
    });
  });

  // ─── GET /api/jobs/client ───
  describe('GET /api/jobs/client', () => {
    it('returns client jobs with pagination', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'j1', description: 'Job 1', status: 'completed' },
          { id: 'j2', description: 'Job 2', status: 'assigned' },
        ],
      });

      const res = await request(app)
        .get('/api/jobs/client?limit=10&offset=0')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.jobs).toHaveLength(2);
    });

    it('clamps limit to 100 maximum', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(app)
        .get('/api/jobs/client?limit=500')
        .set('Authorization', `Bearer ${token}`);

      // Verify the LIMIT param passed to query is 100
      const queryCall = mockQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('LIMIT')
      );
      expect(queryCall).toBeDefined();
      expect(queryCall![1][1]).toBe(100); // limit param
    });
  });

  // ─── POST /api/jobs/:id/accept ───
  describe('POST /api/jobs/:id/accept', () => {
    it('returns 404 for non-pending job', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({ rows: [] }); // No pending job

      const res = await request(app)
        .post('/api/jobs/job-123/accept')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('returns 409 when job was already accepted (race condition fix)', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      // Job found as pending
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'job-123', client_id: 'c1', status: 'pending', is_free: false }],
      });
      // Employee info
      mockQuery.mockResolvedValueOnce({
        rows: [{ rate_per_minute: 5, latitude: '-33.8', longitude: '151.2' }],
      });
      // Client info
      mockQuery.mockResolvedValueOnce({
        rows: [{ latitude: '-33.9', longitude: '151.1' }],
      });
      // UPDATE returns 0 rows (already taken by another employee)
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request(app)
        .post('/api/jobs/job-123/accept')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already accepted/i);
    });

    it('accepts pending job successfully', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      // Pending job
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'job-123', client_id: 'c1', status: 'pending', is_free: false }],
      });
      // Employee info
      mockQuery.mockResolvedValueOnce({
        rows: [{ rate_per_minute: 5, latitude: null, longitude: null }],
      });
      // Client info
      mockQuery.mockResolvedValueOnce({
        rows: [{ latitude: null, longitude: null }],
      });
      // UPDATE succeeds
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      // Timeline
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/jobs/job-123/accept')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/accepted/i);
    });
  });

  // ─── GET /api/jobs/:id ───
  describe('GET /api/jobs/:id', () => {
    it('returns 404 for non-existent job', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/jobs/nonexistent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('returns 403 when client tries to view another clients job', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'job-1', client_id: 'client-2', employee_id: 'emp-1',
          status: 'assigned', client_first_name: 'Other', client_last_name: 'User',
        }],
      });

      const res = await request(app)
        .get('/api/jobs/job-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('returns job with timeline and photos for authorized client', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      // Job belongs to this client
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'job-1', client_id: 'client-1', employee_id: 'emp-1',
          status: 'assigned', client_first_name: 'Test', client_last_name: 'User',
        }],
      });
      // Timeline
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'tl-1', description: 'Job created' }] });
      // Photos
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/jobs/job-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.timeline).toHaveLength(1);
    });
  });

  // ─── Timer routes ───
  describe('POST /api/jobs/:id/timer/start', () => {
    it('returns 400 when status is not assigned or paused', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'job-1', employee_id: 'emp-1', status: 'completed' }],
      });

      const res = await request(app)
        .post('/api/jobs/job-1/timer/start')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/status/i);
    });

    it('starts timer for assigned job', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'job-1', employee_id: 'emp-1', status: 'assigned' }],
      });
      // UPDATE status
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Timeline
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/jobs/job-1/timer/start')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/started/i);
    });
  });

  describe('POST /api/jobs/:id/timer/pause', () => {
    it('returns 400 for non-integer elapsed_seconds', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();

      const res = await request(app)
        .post('/api/jobs/job-1/timer/pause')
        .set('Authorization', `Bearer ${token}`)
        .send({ elapsed_seconds: 'abc' });

      expect(res.status).toBe(400);
    });

    it('returns 400 for negative elapsed_seconds', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();

      const res = await request(app)
        .post('/api/jobs/job-1/timer/pause')
        .set('Authorization', `Bearer ${token}`)
        .send({ elapsed_seconds: -5 });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/jobs/:id/timer/stop', () => {
    it('returns 400 for non-completable status', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'job-1', employee_id: 'emp-1', status: 'completed', started_at: new Date().toISOString() }],
      });

      const res = await request(app)
        .post('/api/jobs/job-1/timer/stop')
        .set('Authorization', `Bearer ${token}`)
        .send({ elapsed_seconds: 300 });

      expect(res.status).toBe(400);
    });

    it('completes job with correct cost calculation', async () => {
      const now = new Date();
      const startedAt = new Date(now.getTime() - 600 * 1000); // 10 min ago
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'job-1', employee_id: 'emp-1', status: 'in_progress',
          started_at: startedAt.toISOString(), rate_per_minute: 5, is_free: false,
        }],
      });
      // UPDATE job
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // UPDATE employee XP
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Timeline
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/jobs/job-1/timer/stop')
        .set('Authorization', `Bearer ${token}`)
        .send({ elapsed_seconds: 600 });

      expect(res.status).toBe(200);
      expect(res.body.total_seconds).toBe(600);
      // 600 sec = 10 min, rate = $5/min → $50
      expect(res.body.total_cost).toBe(50);
      expect(res.body.xp_earned).toBe(10);
    });

    it('returns $0 cost for free jobs', async () => {
      const now = new Date();
      const startedAt = new Date(now.getTime() - 300 * 1000);
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'job-1', employee_id: 'emp-1', status: 'in_progress',
          started_at: startedAt.toISOString(), rate_per_minute: 5, is_free: true,
        }],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/jobs/job-1/timer/stop')
        .set('Authorization', `Bearer ${token}`)
        .send({ elapsed_seconds: 300 });

      expect(res.status).toBe(200);
      expect(res.body.total_cost).toBe(0);
    });
  });

  // ─── POST /api/jobs/:id/timeline ───
  describe('POST /api/jobs/:id/timeline', () => {
    it('returns 400 when description is missing', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/jobs/job-1/timeline')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 400 for non-HTTPS evidence_url', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/jobs/job-1/timeline')
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'Note', evidence_url: 'http://evil.com/xss' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/HTTPS/i);
    });

    it('sanitizes event_type to safe values', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      // Job access check
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'job-1', client_id: 'client-1', employee_id: null }],
      });
      // INSERT
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'tl-1', event_type: 'note', description: 'Test' }],
      });

      const res = await request(app)
        .post('/api/jobs/job-1/timeline')
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'Test', event_type: 'malicious_injection' });

      expect(res.status).toBe(201);
      // Verify the event_type was sanitized to 'note'
      const insertCall = mockQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO job_timeline')
      );
      expect(insertCall![1][1]).toBe('note');
    });
  });

  // ─── Photo upload ───
  describe('POST /api/jobs/:id/photos', () => {
    it('returns 400 for invalid job ID format', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/jobs/INVALID$ID!/photos')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid job id/i);
    });

    it('returns 400 when no file uploaded', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/jobs/abc123-def456/photos')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });
  });

  // ─── Find businesses ───
  describe('POST /api/jobs/find-businesses', () => {
    it('returns 400 when description is empty', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/jobs/find-businesses')
        .set('Authorization', `Bearer ${token}`)
        .send({ description: '', lat: -33.8, lng: 151.2 });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing coordinates', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/jobs/find-businesses')
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'plumber' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/lat and lng/i);
    });

    it('returns 400 for invalid coordinates', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();

      const res = await request(app)
        .post('/api/jobs/find-businesses')
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'plumber', lat: 'abc', lng: 151 });

      expect(res.status).toBe(400);
    });
  });
});
