import { randomBytes } from 'crypto';

import bcrypt from 'bcryptjs';
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';


import pool from '../db/pool';
import { AuthRequest, requireAuth, requireBusiness, createSession, setAuthCookie } from '../middleware/auth';
import { sendBusinessWelcome } from '../services/email';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts, try again later' },
});

function generateAccessCode(): string {
  return randomBytes(3).toString('hex').toUpperCase(); // 6-char hex code
}

// ─── POST /api/business/register ───
router.post('/register', authLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, phone, abn, address, latitude, longitude, service_categories, place_id } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Business name is required' });
      return;
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Valid email is required' });
      return;
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    // Check for existing business
    const existing = await pool.query('SELECT id FROM businesses WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'A business with this email already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const accessCode = generateAccessCode();

    const categories = Array.isArray(service_categories)
      ? service_categories.filter((c: unknown) => typeof c === 'string').map((c: string) => c.slice(0, 50)).slice(0, 20)
      : [];

    const result = await pool.query(
      `INSERT INTO businesses (name, email, phone, abn, address, latitude, longitude, service_categories, password_hash, access_code, place_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, name, email, phone, abn, address, access_code, service_categories, created_at`,
      [
        name.trim().slice(0, 200),
        email.toLowerCase().trim().slice(0, 200),
        typeof phone === 'string' ? phone.slice(0, 20) : '',
        typeof abn === 'string' ? abn.replace(/\s/g, '').slice(0, 11) : '',
        typeof address === 'string' ? address.slice(0, 500) : '',
        latitude != null ? Number(latitude) : null,
        longitude != null ? Number(longitude) : null,
        categories,
        passwordHash,
        accessCode,
        typeof place_id === 'string' ? place_id.slice(0, 200) : null,
      ]
    );

    const business = result.rows[0];

    // Create session
    const token = await createSession(business.id, 'business');
    setAuthCookie(res, token);

    // Send welcome email (async, don't block response)
    sendBusinessWelcome(business.email, business.name, business.access_code).catch(err => {
      console.error('Failed to send business welcome email:', err instanceof Error ? err.message : 'Unknown');
    });

    res.status(201).json({ token, business });
  } catch (err) {
    console.error('Business register error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─── POST /api/business/login ───
router.post('/login', authLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const result = await pool.query(
      'SELECT id, name, email, phone, abn, address, access_code, service_categories, password_hash, created_at FROM businesses WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const business = result.rows[0];
    const valid = await bcrypt.compare(password, business.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = await createSession(business.id, 'business');
    setAuthCookie(res, token);

    const safeBusiness = { ...business };
    delete safeBusiness.password_hash;
    res.json({ token, business: safeBusiness });
  } catch (err) {
    console.error('Business login error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: "We couldn't verify your login details. Please double-check them and try again." });
  }
});

// ─── GET /api/business/profile ───
router.get('/profile', requireAuth, requireBusiness, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, phone, abn, address, latitude, longitude, service_categories, access_code, is_verified, place_id, created_at FROM businesses WHERE id = $1',
      [req.auth!.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get business profile error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\'t load profile.' });
  }
});

// ─── PATCH /api/business/profile ───
router.patch('/profile', requireAuth, requireBusiness, async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone, abn, address, latitude, longitude, service_categories, place_id } = req.body;
    const businessId = req.auth!.userId;

    const updates: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (name && typeof name === 'string') { updates.push(`name = $${paramIdx++}`); values.push(name.trim().slice(0, 200)); }
    if (phone !== undefined) { updates.push(`phone = $${paramIdx++}`); values.push(String(phone || '').slice(0, 20)); }
    if (abn !== undefined) { updates.push(`abn = $${paramIdx++}`); values.push(String(abn || '').replace(/\s/g, '').slice(0, 11)); }
    if (address !== undefined) { updates.push(`address = $${paramIdx++}`); values.push(String(address || '').slice(0, 500)); }
    if (latitude != null) { updates.push(`latitude = $${paramIdx++}`); values.push(Number(latitude)); }
    if (longitude != null) { updates.push(`longitude = $${paramIdx++}`); values.push(Number(longitude)); }
    if (place_id !== undefined) { updates.push(`place_id = $${paramIdx++}`); values.push(typeof place_id === 'string' ? place_id.slice(0, 200) : null); }
    if (Array.isArray(service_categories)) {
      const cats = service_categories.filter((c: unknown) => typeof c === 'string').map((c: string) => c.slice(0, 50)).slice(0, 20);
      updates.push(`service_categories = $${paramIdx++}`);
      values.push(cats);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(businessId);
    const result = await pool.query(
      `UPDATE businesses SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING id, name, email, phone, abn, address, latitude, longitude, service_categories, access_code, place_id, created_at`,
      values
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update business profile error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\'t update profile.' });
  }
});

// ─── GET /api/business/quotes ───
router.get('/quotes', requireAuth, requireBusiness, async (req: AuthRequest, res: Response) => {
  try {
    const businessId = req.auth!.userId;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const result = await pool.query(
      `SELECT qr.*, 
              q.id as quote_id, q.price as quote_price, q.estimated_hours as quote_hours, q.notes as quote_notes, q.created_at as quote_created_at
       FROM quote_requests qr
       LEFT JOIN quotes q ON q.request_id = qr.id AND q.business_id = qr.business_id
       WHERE qr.business_id = $1
       ORDER BY qr.created_at DESC
       LIMIT $2 OFFSET $3`,
      [businessId, limit, offset]
    );

    res.json({ quoteRequests: result.rows });
  } catch (err) {
    console.error('Get business quotes error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\'t load quote requests.' });
  }
});

// ─── POST /api/business/quotes/:id/respond ───
router.post('/quotes/:id/respond', requireAuth, requireBusiness, async (req: AuthRequest, res: Response) => {
  try {
    const requestId = req.params.id;
    const businessId = req.auth!.userId;
    const { price, estimated_hours, notes } = req.body;

    if (price == null || typeof price !== 'number' || price < 0) {
      res.status(400).json({ error: 'Valid price is required' });
      return;
    }

    // Verify the quote request belongs to this business
    const qrResult = await pool.query(
      'SELECT id, status FROM quote_requests WHERE id = $1 AND business_id = $2',
      [requestId, businessId]
    );

    if (qrResult.rows.length === 0) {
      res.status(404).json({ error: 'Quote request not found' });
      return;
    }

    if (qrResult.rows[0].status !== 'pending') {
      res.status(400).json({ error: 'This request has already been responded to' });
      return;
    }

    // Create quote
    const quoteResult = await pool.query(
      `INSERT INTO quotes (request_id, business_id, price, estimated_hours, notes, valid_until)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days') RETURNING *`,
      [
        requestId,
        businessId,
        price,
        typeof estimated_hours === 'number' && estimated_hours > 0 ? estimated_hours : null,
        typeof notes === 'string' ? notes.slice(0, 1000) : '',
      ]
    );

    // Update request status
    await pool.query(
      "UPDATE quote_requests SET status = 'quoted' WHERE id = $1",
      [requestId]
    );

    res.status(201).json(quoteResult.rows[0]);
  } catch (err) {
    console.error('Respond to quote error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\'t submit quote.' });
  }
});

// ─── POST /api/business/code-lookup ───
router.post('/code-lookup', async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string' || code.trim().length < 4) {
      res.status(400).json({ error: 'Access code is required' });
      return;
    }

    const result = await pool.query(
      'SELECT id, name, email, phone, address, service_categories, is_verified FROM businesses WHERE access_code = $1',
      [code.trim().toUpperCase()]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'No business found with this code' });
      return;
    }

    res.json({ business: result.rows[0] });
  } catch (err) {
    console.error('Code lookup error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

export default router;
