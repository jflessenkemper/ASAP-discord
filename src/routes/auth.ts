import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import pool from '../db/pool';
import { createSession, invalidateSession, AuthRequest, requireAuth } from '../middleware/auth';
import { generateCode, sendTwoFactorCode } from '../services/email';

const router = Router();

// Rate limit login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Client Registration ───
router.post('/client/register', async (req: Request, res: Response) => {
  try {
    const { first_name, last_name, email, phone, password, gender, date_of_birth, latitude, longitude } = req.body;

    if (!first_name || !email || !phone || !password) {
      res.status(400).json({ error: 'First name, email, phone, and password are required' });
      return;
    }

    if (String(first_name).length > 100 || String(last_name || '').length > 100) {
      res.status(400).json({ error: 'Name must be 100 characters or less' });
      return;
    }

    if (String(email).length > 255) {
      res.status(400).json({ error: 'Email must be 255 characters or less' });
      return;
    }

    if (String(phone).length > 20) {
      res.status(400).json({ error: 'Phone must be 20 characters or less' });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    // Check if email already exists
    const existing = await pool.query('SELECT id FROM clients WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO clients (first_name, last_name, email, phone, address, password_hash, gender, date_of_birth, latitude, longitude, last_location_update)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, first_name, last_name, email, phone, address, gender, date_of_birth, latitude, longitude, first_job_used, created_at`,
      [
        first_name.trim(),
        (last_name || '').trim(),
        email.toLowerCase().trim(),
        phone.trim(),
        '', // address no longer collected at signup
        passwordHash,
        gender || null,
        date_of_birth || null,
        typeof latitude === 'number' ? latitude : null,
        typeof longitude === 'number' ? longitude : null,
        typeof latitude === 'number' ? new Date() : null,
      ]
    );

    const client = result.rows[0];
    const token = await createSession(client.id, 'client');

    res.status(201).json({ token, user: client });
  } catch (err) {
    console.error('Client registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── Client Login ───
router.post('/client/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const result = await pool.query(
      'SELECT id, first_name, last_name, email, phone, address, password_hash, gender, date_of_birth, latitude, longitude, first_job_used, created_at FROM clients WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const client = result.rows[0];
    const valid = await bcrypt.compare(password, client.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = await createSession(client.id, 'client');
    const { password_hash, ...safeClient } = client;

    res.json({ token, user: safeClient });
  } catch (err) {
    console.error('Client login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── Employee Login (Step 1: credentials → send 2FA) ───
router.post('/employee/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const result = await pool.query(
      'SELECT id, username, email, password_hash, is_active FROM employees WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const employee = result.rows[0];

    if (!employee.is_active) {
      res.status(403).json({ error: 'Account is deactivated' });
      return;
    }

    const valid = await bcrypt.compare(password, employee.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Generate 2FA code
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Invalidate any existing unused codes for this employee
    await pool.query(
      'UPDATE two_factor_codes SET used = TRUE WHERE employee_id = $1 AND used = FALSE',
      [employee.id]
    );

    await pool.query(
      'INSERT INTO two_factor_codes (employee_id, code, expires_at) VALUES ($1, $2, $3)',
      [employee.id, code, expiresAt]
    );

    // Send 2FA email
    await sendTwoFactorCode(employee.email, code);

    // Return employee_id for the 2FA verification step (not the full user)
    res.json({
      message: 'Verification code sent to your email',
      employee_id: employee.id,
    });
  } catch (err) {
    console.error('Employee login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── Employee 2FA Verification (Step 2) ───
router.post('/employee/verify-2fa', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { employee_id, code } = req.body;

    if (!employee_id || !code) {
      res.status(400).json({ error: 'Employee ID and code are required' });
      return;
    }

    const result = await pool.query(
      `SELECT id FROM two_factor_codes
       WHERE employee_id = $1 AND code = $2 AND used = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [employee_id, code]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }

    // Mark code as used
    await pool.query('UPDATE two_factor_codes SET used = TRUE WHERE id = $1', [result.rows[0].id]);

    // Get employee info
    const empResult = await pool.query(
      'SELECT id, username, email, rate_per_minute, is_active, total_minutes, profile_picture_url, banner_url, bio, latitude, longitude, created_at FROM employees WHERE id = $1',
      [employee_id]
    );

    const employee = empResult.rows[0];
    const token = await createSession(employee.id, 'employee');

    res.json({ token, user: employee });
  } catch (err) {
    console.error('2FA verification error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ─── Logout ───
router.post('/logout', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const token = req.headers.authorization!.slice(7);
    await invalidateSession(token);
    res.json({ message: 'Logged out' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ─── Get current user ───
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { userId, userType } = req.auth!;
    const table = userType === 'client' ? 'clients' : 'employees';
    const fields = userType === 'client'
      ? 'id, first_name, last_name, email, phone, address, gender, date_of_birth, latitude, longitude, first_job_used, created_at'
      : 'id, username, email, rate_per_minute, is_active, total_minutes, profile_picture_url, banner_url, bio, latitude, longitude, created_at';

    const result = await pool.query(`SELECT ${fields} FROM ${table} WHERE id = $1`, [userId]);

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid session' });
      return;
    }

    res.json({ userType, user: result.rows[0] });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

export default router;
