import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db/pool';

export interface AuthPayload {
  userId: string;
  userType: 'client' | 'employee' | 'business';
}

export interface AuthRequest extends Request {
  auth?: AuthPayload;
}

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable must be set');
}
const JWT_SECRET: string = process.env.JWT_SECRET;

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export function generateToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET) as AuthPayload;
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie('asap_token', token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? 'strict' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie('asap_token', {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? 'strict' : 'lax',
    path: '/',
  });
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  // Try Authorization header first, then fall back to httpOnly cookie
  let token: string | undefined;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7);
  } else if (req.cookies?.asap_token) {
    token = req.cookies.asap_token;
  }

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = verifyToken(token);

    // Verify session still exists in DB and hasn't expired
    try {
      const sessionResult = await pool.query(
        'SELECT id FROM sessions WHERE token = $1 AND expires_at > NOW()',
        [token]
      );
      if (sessionResult.rows.length === 0) {
        clearAuthCookie(res);
        res.status(401).json({ error: 'Session expired or invalidated' });
        return;
      }
    } catch (dbErr) {
      // DB unavailable — fail closed (deny access) rather than falling back to JWT-only
      console.error('Session DB check failed:', dbErr instanceof Error ? dbErr.message : 'Unknown');
      res.status(503).json({ error: 'Service temporarily unavailable' });
      return;
    }

    req.auth = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireClient(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.auth || req.auth.userType !== 'client') {
    res.status(403).json({ error: 'Client access required' });
    return;
  }
  next();
}

export function requireEmployee(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.auth || req.auth.userType !== 'employee') {
    res.status(403).json({ error: 'Employee access required' });
    return;
  }
  next();
}

export function requireBusiness(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.auth || req.auth.userType !== 'business') {
    res.status(403).json({ error: 'Business access required' });
    return;
  }
  next();
}

export async function createSession(userId: string, userType: 'client' | 'employee' | 'business'): Promise<string> {
  const token = generateToken({ userId, userType });
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await pool.query(
    `INSERT INTO sessions (user_id, user_type, token, expires_at) VALUES ($1, $2, $3, $4)`,
    [userId, userType, token, expiresAt]
  );
  return token;
}

export async function invalidateSession(token: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}
