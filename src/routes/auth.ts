import appleSignin from 'apple-signin-auth';
import bcrypt from 'bcryptjs';
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';

import pool from '../db/pool';
import { createSession, invalidateSession, AuthRequest, requireAuth, setAuthCookie, clearAuthCookie } from '../middleware/auth';
import { generateCode, sendTwoFactorCode } from '../services/email';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const router = Router();

// Non-blocking auth event logger
function logAuthEvent(req: Request, event: string, userId?: string, userType?: string, provider?: string) {
  const ip = req.ip || req.socket.remoteAddress || null;
  const ua = req.headers['user-agent'] || null;
  pool.query(
    `INSERT INTO auth_events (user_id, user_type, event, provider, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId || null, userType || null, event, provider || null, ip, ua]
  ).catch(err => console.error('Failed to log auth event:', err instanceof Error ? err.message : 'Unknown'));
}

// Rate limit login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Social Auth (Apple / Google / Facebook) ───
router.post('/social', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { provider, id_token, access_token } = req.body;

    if (!provider || (!id_token && !access_token)) {
      res.status(400).json({ error: 'Provider and id_token or access_token are required' });
      return;
    }

    if (provider !== 'apple' && provider !== 'google' && provider !== 'facebook') {
      res.status(400).json({ error: 'Provider must be "apple", "google", or "facebook"' });
      return;
    }

    let email: string | undefined;
    let firstName: string | undefined;
    let lastName: string | undefined;
    let providerSub: string | undefined;

    // ── Verify token with the appropriate provider ──
    if (provider === 'google' && access_token) {
      // Web flow: verify access_token via Google userinfo endpoint
      const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!userinfoRes.ok) {
        res.status(401).json({ error: 'Invalid Google access token' });
        return;
      }
      const userinfo = await userinfoRes.json() as { email?: string; given_name?: string; family_name?: string; sub?: string };
      if (!userinfo.email) {
        res.status(401).json({ error: 'Invalid Google token' });
        return;
      }
      email = userinfo.email;
      firstName = userinfo.given_name || '';
      lastName = userinfo.family_name || '';
      providerSub = userinfo.sub;
    } else if (provider === 'google') {
      const ticket = await googleClient.verifyIdToken({
        idToken: id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      if (!payload || !payload.email) {
        res.status(401).json({ error: 'Invalid Google token' });
        return;
      }
      email = payload.email;
      firstName = payload.given_name || '';
      lastName = payload.family_name || '';
      providerSub = payload.sub;
    } else if (provider === 'facebook' && access_token) {
      // Facebook: verify access token via Graph API
      const fbRes = await fetch(`https://graph.facebook.com/me?fields=id,first_name,last_name,email&access_token=${encodeURIComponent(access_token)}`);
      if (!fbRes.ok) {
        res.status(401).json({ error: 'Invalid Facebook access token' });
        return;
      }
      const fbUser = await fbRes.json() as { id?: string; first_name?: string; last_name?: string; email?: string };
      if (!fbUser.id) {
        res.status(401).json({ error: 'Invalid Facebook token' });
        return;
      }
      email = fbUser.email;
      firstName = fbUser.first_name || '';
      lastName = fbUser.last_name || '';
      providerSub = fbUser.id;
    } else {
      // Apple
      const payload = await appleSignin.verifyIdToken(id_token, {
        audience: process.env.APPLE_SERVICE_ID,
        ignoreExpiration: false,
      });
      if (!payload || !payload.email) {
        res.status(401).json({ error: 'Invalid Apple token' });
        return;
      }
      email = payload.email;
      providerSub = payload.sub;
      // Apple only sends name on first authorization — handled via optional name fields from client
      firstName = String(req.body.first_name || '').slice(0, 100);
      lastName = String(req.body.last_name || '').slice(0, 100);
    }

    if (!email || !providerSub) {
      res.status(401).json({ error: 'Could not verify identity' });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();

    // ── Look up existing account by provider + provider_id ──
    let clientResult = await pool.query(
      'SELECT id, first_name, last_name, email, phone, address, gender, date_of_birth, latitude, longitude, first_job_used, created_at FROM clients WHERE auth_provider = $1 AND auth_provider_id = $2',
      [provider, providerSub]
    );

    if (clientResult.rows.length > 0) {
      // Existing social account — log in
      const client = clientResult.rows[0];
      const token = await createSession(client.id, 'client');
      setAuthCookie(res, token);
      logAuthEvent(req, 'login', client.id, 'client', provider);
      res.json({ token, user: client });
      return;
    }

    // ── Fall back to email match (link existing account to social) ──
    // Only auto-link if the existing account already has a verified social provider.
    // If the account was created via email-only signup (no auth_provider), do NOT link —
    // this prevents an attacker from pre-registering an email and hijacking via social login.
    clientResult = await pool.query(
      `SELECT id, first_name, last_name, email, phone, address, gender, date_of_birth, latitude, longitude, first_job_used, created_at, auth_provider
       FROM clients WHERE email = $1`,
      [normalizedEmail]
    );

    if (clientResult.rows.length > 0) {
      const existingClient = clientResult.rows[0];
      if (existingClient.auth_provider && existingClient.auth_provider !== 'test') {
        // Existing social account with different provider — link and log in
        await pool.query(
          'UPDATE clients SET auth_provider = $1, auth_provider_id = $2 WHERE id = $3',
          [provider, providerSub, existingClient.id]
        );
        const token = await createSession(existingClient.id, 'client');
        setAuthCookie(res, token);
        logAuthEvent(req, 'login', existingClient.id, 'client', provider);
        res.json({ token, user: existingClient });
        return;
      }
      // Email-only account exists — don't auto-link, create a separate social account
      // (The user can manually link later via account settings if they own both)
    }

    // ── Create new account ──
    const newResult = await pool.query(
      `INSERT INTO clients (first_name, last_name, email, phone, address, auth_provider, auth_provider_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, first_name, last_name, email, phone, address, gender, date_of_birth, latitude, longitude, first_job_used, created_at`,
      [
        (firstName || 'ASAP').trim(),
        (lastName || 'User').trim(),
        normalizedEmail,
        '',
        '',
        provider,
        providerSub,
      ]
    );

    const client = newResult.rows[0];
    const token = await createSession(client.id, 'client');
    setAuthCookie(res, token);
    logAuthEvent(req, 'login', client.id, 'client', provider);
    res.status(201).json({ token, user: client });
  } catch (err: any) {
    logAuthEvent(req, 'login_failed', undefined, 'client', req.body?.provider);
    console.error('Social auth error:', err instanceof Error ? err.message : 'Unknown error');
    if (err.message?.includes('Token used too late') || err.message?.includes('Invalid')) {
      res.status(401).json({ error: "We couldn't verify your login details. Please double-check them and try again." });
      return;
    }
    res.status(500).json({ error: "We couldn't verify your login details. Please double-check them and try again." });
  }
});

// ─── Email Sign-Up ───
router.post('/email-signup', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { first_name, last_name, email, address, latitude, longitude } = req.body;

    if (!first_name || !last_name || !email) {
      res.status(400).json({ error: 'First name, last name, and email are required' });
      return;
    }

    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Please enter a valid email address' });
      return;
    }

    if (typeof first_name !== 'string' || first_name.trim().length > 100 || typeof last_name !== 'string' || last_name.trim().length > 100) {
      res.status(400).json({ error: 'Name fields must be 100 characters or less' });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists
    const existing = await pool.query(
      'SELECT id FROM clients WHERE email = $1',
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      // Do NOT auto-login — that would let anyone claim an existing account without email verification
      res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' });
      return;
    }

    // Create new account
    const newResult = await pool.query(
      `INSERT INTO clients (first_name, last_name, email, phone, address, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, first_name, last_name, email, phone, address, gender, date_of_birth, latitude, longitude, first_job_used, created_at`,
      [first_name.trim(), last_name.trim(), normalizedEmail, '', address?.trim() || '', latitude || null, longitude || null]
    );

    const client = newResult.rows[0];
    const token = await createSession(client.id, 'client');
    setAuthCookie(res, token);
    res.status(201).json({ token, user: client });
  } catch (err: any) {
    console.error('Email signup error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Sign-up failed. Please try again.' });
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
      logAuthEvent(req, 'login_failed', undefined, 'employee', 'password');
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const employee = result.rows[0];

    if (!employee.is_active) {
      logAuthEvent(req, 'login_failed', employee.id, 'employee', 'password');
      res.status(403).json({ error: 'Account is deactivated' });
      return;
    }

    const valid = await bcrypt.compare(password, employee.password_hash);
    if (!valid) {
      logAuthEvent(req, 'login_failed', employee.id, 'employee', 'password');
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

    logAuthEvent(req, '2fa_sent', employee.id, 'employee', 'password');

    // Return employee_id for the 2FA verification step (not the full user)
    res.json({
      message: 'Verification code sent to your email',
      employee_id: employee.id,
    });
  } catch (err) {
    console.error('Employee login error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: "We couldn't verify your login details. Please double-check them and try again." });
  }
});

// Rate limit 2FA verification (stricter than general login limiter)
const twoFactorLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5, // 5 attempts per 10 minutes
  message: { error: 'Too many verification attempts. Try again in 10 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Employee 2FA Verification (Step 2) ───
router.post('/employee/verify-2fa', twoFactorLimiter, async (req: Request, res: Response) => {
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
      logAuthEvent(req, '2fa_failed', employee_id, 'employee', 'password');

      // Count recent failed attempts and invalidate all codes after 3 failures
      const failCount = await pool.query(
        `SELECT COUNT(*) as cnt FROM auth_events
         WHERE user_id = $1 AND event = '2fa_failed' AND created_at > NOW() - INTERVAL '10 minutes'`,
        [employee_id]
      );
      if (parseInt(failCount.rows[0].cnt, 10) >= 3) {
        await pool.query(
          'UPDATE two_factor_codes SET used = TRUE WHERE employee_id = $1 AND used = FALSE',
          [employee_id]
        );
      }

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

    // Compute level info so client gets full EmployeeUser shape
    const totalMinutes = employee.total_minutes || 0;
    const level = Math.min(1000, Math.floor(totalMinutes / 1000));
    const xp = totalMinutes % 1000;
    const taxRate = parseFloat(Math.max(10, 25 - level * 0.015).toFixed(2));

    const token = await createSession(employee.id, 'employee');

    setAuthCookie(res, token);
    logAuthEvent(req, 'login', employee.id, 'employee', 'password');
    res.json({ token, user: { ...employee, level, xp, xpToNext: 1000, taxRate } });
  } catch (err) {
    console.error('2FA verification error:', err instanceof Error ? (err as Error).message : 'Unknown error');
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ─── Logout ───
router.post('/logout', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    // Get token from header or cookie
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.asap_token;
    if (token) await invalidateSession(token);
    clearAuthCookie(res);
    logAuthEvent(req, 'logout', req.auth?.userId, req.auth?.userType);
    res.json({ message: 'Logged out' });
  } catch (err) {
    console.error('Logout error:', err instanceof Error ? (err as Error).message : 'Unknown error');
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Allowlist for user-type → table/fields (prevents SQL interpolation)
const USER_TYPE_CONFIG = {
  client: {
    table: 'clients',
    fields: 'id, first_name, last_name, email, phone, address, gender, date_of_birth, latitude, longitude, first_job_used, created_at',
  },
  employee: {
    table: 'employees',
    fields: 'id, username, email, rate_per_minute, is_active, total_minutes, profile_picture_url, banner_url, bio, latitude, longitude, created_at',
  },
  business: {
    table: 'businesses',
    fields: 'id, name, email, phone, abn, address, access_code, service_categories, latitude, longitude, created_at',
  },
} as const;

// ─── Get current user ───
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { userId, userType } = req.auth!;
    const config = USER_TYPE_CONFIG[userType];
    if (!config) {
      res.status(400).json({ error: 'Invalid user type' });
      return;
    }

    const result = await pool.query(`SELECT ${config.fields} FROM ${config.table} WHERE id = $1`, [userId]);

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid session' });
      return;
    }

    res.json({ userType, user: result.rows[0] });
  } catch (err) {
    console.error('Get user error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ─── Test Login (dev/QA only — DISABLED in production) ───
router.post('/test-login', loginLimiter, async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  try {
    const { username, password } = req.body;
    if (username !== 'testuser' || password !== 'testpass') {
      res.status(401).json({ error: 'Invalid test credentials' });
      return;
    }

    const testEmail = 'test@asap.dev';
    // Upsert test client
    let clientResult = await pool.query(
      'SELECT id, first_name, last_name, email, phone, address, gender, date_of_birth, latitude, longitude, first_job_used, created_at FROM clients WHERE email = $1',
      [testEmail]
    );

    if (clientResult.rows.length === 0) {
      clientResult = await pool.query(
        `INSERT INTO clients (first_name, last_name, email, phone, address, auth_provider, auth_provider_id, latitude, longitude)
         VALUES ('Test', 'User', $1, '', '', 'test', 'test-user-001', -33.8688, 151.2093)
         RETURNING id, first_name, last_name, email, phone, address, gender, date_of_birth, latitude, longitude, first_job_used, created_at`,
        [testEmail]
      );
    }

    const client = clientResult.rows[0];
    const token = await createSession(client.id, 'client');
    setAuthCookie(res, token);
    logAuthEvent(req, 'login', client.id, 'client', 'test');
    res.json({ token, user: client });
  } catch (err) {
    console.error('Test login error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Test login failed' });
  }
});

// ─── Update Client Profile ───
const profileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, try again shortly' },
});

router.patch('/profile', requireAuth, profileLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (req.auth!.userType !== 'client') {
      res.status(403).json({ error: 'Only clients can update their profile here' });
      return;
    }

    const { first_name, last_name, phone } = req.body;
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (typeof first_name === 'string') {
      const trimmed = first_name.trim();
      if (!trimmed || trimmed.length > 100) {
        res.status(400).json({ error: 'First name must be 1-100 characters' });
        return;
      }
      updates.push(`first_name = $${idx++}`);
      values.push(trimmed);
    }

    if (typeof last_name === 'string') {
      const trimmed = last_name.trim();
      if (trimmed.length > 100) {
        res.status(400).json({ error: 'Last name must be 100 characters or less' });
        return;
      }
      updates.push(`last_name = $${idx++}`);
      values.push(trimmed);
    }

    if (typeof phone === 'string') {
      const trimmed = phone.trim();
      if (trimmed.length > 20) {
        res.status(400).json({ error: 'Phone number must be 20 characters or less' });
        return;
      }
      updates.push(`phone = $${idx++}`);
      values.push(trimmed);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    values.push(req.auth!.userId);
    const result = await pool.query(
      `UPDATE clients SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, first_name, last_name, email, phone, address, gender, date_of_birth, latitude, longitude, first_job_used, created_at`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    logAuthEvent(req, 'profile_update', req.auth!.userId, 'client');
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Profile update error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\u2019t update profile. Please try again.' });
  }
});

// ─── Delete Client Account ───
router.delete('/account', requireAuth, profileLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (req.auth!.userType !== 'client') {
      res.status(403).json({ error: 'Only clients can delete their account here' });
      return;
    }

    const clientId = req.auth!.userId;

    // Cascade delete: sessions, auth_events, fuel_searches, price_searches, saved_items, job_timeline, jobs
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [clientId]);
    await pool.query('DELETE FROM auth_events WHERE user_id = $1', [clientId]);
    await pool.query('DELETE FROM fuel_searches WHERE client_id = $1', [clientId]);
    await pool.query('DELETE FROM price_searches WHERE client_id = $1', [clientId]);
    await pool.query('DELETE FROM saved_items WHERE client_id = $1', [clientId]);
    // Delete job-related data
    await pool.query(
      `DELETE FROM job_timeline WHERE job_id IN (SELECT id FROM jobs WHERE client_id = $1)`,
      [clientId]
    );
    await pool.query(
      `DELETE FROM job_photos WHERE job_id IN (SELECT id FROM jobs WHERE client_id = $1)`,
      [clientId]
    );
    await pool.query('DELETE FROM jobs WHERE client_id = $1', [clientId]);
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);

    clearAuthCookie(res);
    logAuthEvent(req, 'account_deleted', clientId, 'client');
    res.json({ message: 'Account deleted' });
  } catch (err) {
    console.error('Account deletion error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\u2019t delete account. Please try again.' });
  }
});


// --- GET /api/auth/status ---
// A basic endpoint to indicate the authentication service is active.
// Does not confirm user authentication status without additional middleware.
router.get('/status', (req: Request, res: Response) => {
  res.status(200).json({ authenticated: false, message: 'Auth service active' });
});

export default router;

