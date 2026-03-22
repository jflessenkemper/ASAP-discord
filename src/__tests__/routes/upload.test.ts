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

jest.mock('../../services/storage', () => ({
  uploadEvidence: jest.fn().mockResolvedValue('https://storage.example.com/evidence/file.jpg'),
}));

import uploadRoutes from '../../routes/upload';

function makeToken(userId: string, userType: 'client' | 'employee') {
  return jwt.sign({ userId, userType }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/upload', uploadRoutes);
  return app;
}

function mockAuthSession() {
  mockQuery.mockResolvedValueOnce({ rows: [{ id: 'session-id' }] });
}

describe('Upload Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  describe('POST /api/upload/evidence/:jobId', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app)
        .post('/api/upload/evidence/abc-123')
        .attach('file', Buffer.from('fake-image'), 'photo.jpg');
      expect(res.status).toBe(401);
    });

    it('returns 400 for invalid jobId format (path traversal)', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();

      const res = await request(app)
        .post('/api/upload/evidence/../../../etc/passwd')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from('fake'), { filename: 'photo.jpg', contentType: 'image/jpeg' });

      // Express will decode the URL; the route might not even match.
      // If it does match, the regex check should catch it.
      expect([400, 404]).toContain(res.status);
    });

    it('returns 404 when job does not exist', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      // Job lookup returns empty
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/upload/evidence/aaaa-bbbb-cccc')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from('fake'), { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(404);
    });

    it('returns 403 when employee has no access to job', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      // Job exists but employee_id is someone else
      mockQuery.mockResolvedValueOnce({
        rows: [{ client_id: 'client-1', employee_id: 'emp-other' }],
      });

      const res = await request(app)
        .post('/api/upload/evidence/aaa-bbb-ccc')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from('fake'), { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(403);
    });

    it('returns 400 when no file is uploaded', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [{ client_id: 'client-1', employee_id: 'emp-1' }],
      });

      const res = await request(app)
        .post('/api/upload/evidence/aaa-bbb-ccc')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    it('returns 201 with URL on successful upload', async () => {
      const token = makeToken('emp-1', 'employee');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [{ client_id: 'client-1', employee_id: 'emp-1' }],
      });

      const res = await request(app)
        .post('/api/upload/evidence/aaa-bbb-ccc')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from('fake-image-data'), { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);
      expect(res.body.url).toMatch(/^https:\/\//);
    });

    it('returns 403 when client does not own the job', async () => {
      const token = makeToken('client-1', 'client');
      mockAuthSession();
      mockQuery.mockResolvedValueOnce({
        rows: [{ client_id: 'client-other', employee_id: 'emp-1' }],
      });

      const res = await request(app)
        .post('/api/upload/evidence/aaa-bbb-ccc')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from('fake'), { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(403);
    });
  });
});
