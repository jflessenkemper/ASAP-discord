import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import pool from '../db/pool';
import { AuthRequest, requireAuth, requireEmployee } from '../middleware/auth';
import { uploadEvidence } from '../services/storage';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images are allowed'));
  },
});

function computeLevel(totalMinutes: number) {
  const level = Math.min(1000, Math.floor(totalMinutes / 1000));
  const xpInLevel = totalMinutes % 1000;
  const taxRate = Math.max(10, 25 - level * 0.015);
  return { level, xp: xpInLevel, xpToNext: 1000, totalMinutes, taxRate: parseFloat(taxRate.toFixed(2)) };
}

// ─── Get employee profile ───
router.get('/profile', requireAuth, requireEmployee, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, rate_per_minute, is_active, total_minutes,
              profile_picture_url, banner_url, bio, latitude, longitude, created_at
       FROM employees WHERE id = $1`,
      [req.auth!.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }
    const emp = result.rows[0];
    const levelInfo = computeLevel(emp.total_minutes || 0);
    res.json({ ...emp, ...levelInfo });
  } catch (err) {
    console.error('Get profile error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Couldn\u2019t load your profile. Please try again.' });
  }
});

// ─── Update profile (bio, pictures) ───
router.patch('/profile', requireAuth, requireEmployee, upload.fields([
  { name: 'profile_picture', maxCount: 1 },
  { name: 'banner', maxCount: 1 },
]), async (req: AuthRequest, res: Response) => {
  try {
    const employeeId = req.auth!.userId;
    const { bio } = req.body;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    const updates: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (bio !== undefined) {
      if (String(bio).length > 500) {
        res.status(400).json({ error: 'Bio must be 500 characters or less' });
        return;
      }
      updates.push(`bio = $${paramIdx++}`);
      values.push(String(bio));
    }

    if (files?.profile_picture?.[0]) {
      const f = files.profile_picture[0];
      const url = await uploadEvidence(employeeId, f.buffer, String(f.mimetype), 'profile-picture');
      updates.push(`profile_picture_url = $${paramIdx++}`);
      values.push(url);
    }

    if (files?.banner?.[0]) {
      const f = files.banner[0];
      const url = await uploadEvidence(employeeId, f.buffer, String(f.mimetype), 'banner');
      updates.push(`banner_url = $${paramIdx++}`);
      values.push(url);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(employeeId);
    const result = await pool.query(
      `UPDATE employees SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING profile_picture_url, banner_url, bio`,
      values
    );

    res.json({ message: 'Profile updated', ...result.rows[0] });
  } catch (err) {
    console.error('Update profile error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Couldn\u2019t update your profile. Please try again.' });
  }
});

// ─── Update rate ───
router.patch('/rate', requireAuth, requireEmployee, async (req: AuthRequest, res: Response) => {
  try {
    const { rate_per_minute } = req.body;
    if (typeof rate_per_minute !== 'number' || rate_per_minute <= 0 || rate_per_minute > 10) {
      res.status(400).json({ error: 'Rate must be between $0.01 and $10.00 per minute' });
      return;
    }

    await pool.query(
      'UPDATE employees SET rate_per_minute = $1 WHERE id = $2',
      [rate_per_minute, req.auth!.userId]
    );

    res.json({ message: 'Rate updated', rate_per_minute });
  } catch (err) {
    console.error('Update rate error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Couldn\u2019t update the rate. Please try again.' });
  }
});

// ─── Change password ───
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many password change attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/change-password', requireAuth, requireEmployee, changePasswordLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      res.status(400).json({ error: 'Both passwords are required' });
      return;
    }

    if (new_password.length < 8 || new_password.length > 128) {
      res.status(400).json({ error: 'New password must be between 8 and 128 characters' });
      return;
    }

    const result = await pool.query(
      'SELECT password_hash FROM employees WHERE id = $1',
      [req.auth!.userId]
    );

    const valid = await bcrypt.compare(current_password, result.rows[0].password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    const newHash = await bcrypt.hash(new_password, 12);
    await pool.query(
      'UPDATE employees SET password_hash = $1 WHERE id = $2',
      [newHash, req.auth!.userId]
    );

    res.json({ message: 'Password changed' });
  } catch (err) {
    console.error('Change password error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Couldn\u2019t change your password. Please try again.' });
  }
});

// ─── Get earnings/profit with tax breakdown ───
router.get('/earnings', requireAuth, requireEmployee, async (req: AuthRequest, res: Response) => {
  try {
    const employeeId = req.auth!.userId;

    // Run independent queries in parallel: employee info, aggregated earnings, recent jobs
    const [empResult, earningsResult, recentResult] = await Promise.all([
      pool.query(
        'SELECT total_minutes FROM employees WHERE id = $1',
        [employeeId]
      ),
      // Single query with conditional aggregation replaces 4 separate SUM queries
      pool.query(
        `SELECT
           COALESCE(SUM(total_cost), 0) as all_time_total,
           COUNT(*) as job_count,
           COALESCE(SUM(CASE WHEN completed_at >= CURRENT_DATE THEN total_cost ELSE 0 END), 0) as today,
           COALESCE(SUM(CASE WHEN completed_at >= date_trunc('week', CURRENT_DATE) THEN total_cost ELSE 0 END), 0) as this_week,
           COALESCE(SUM(CASE WHEN completed_at >= date_trunc('month', CURRENT_DATE) THEN total_cost ELSE 0 END), 0) as this_month
         FROM jobs
         WHERE employee_id = $1 AND status = 'completed'`,
        [employeeId]
      ),
      pool.query(
        `SELECT j.id, j.description, j.total_seconds, j.total_cost, j.is_free,
                j.completed_at, j.fuel_cost, j.difficulty_rating,
                c.first_name as client_first_name, c.last_name as client_last_name
         FROM jobs j
         JOIN clients c ON j.client_id = c.id
         WHERE j.employee_id = $1 AND j.status = 'completed'
         ORDER BY j.completed_at DESC
         LIMIT 20`,
        [employeeId]
      ),
    ]);

    const levelInfo = computeLevel(empResult.rows[0]?.total_minutes || 0);
    const taxRate = levelInfo.taxRate / 100;
    const earnings = earningsResult.rows[0];
    const allTimeGross = parseFloat(earnings.all_time_total);

    const recentJobs = recentResult.rows.map((j: any) => {
      const gross = parseFloat(j.total_cost) || 0;
      const tax = parseFloat((gross * taxRate).toFixed(2));
      return {
        ...j,
        client_name: `${j.client_first_name} ${j.client_last_name}`.trim(),
        tax_amount: tax,
        net_earnings: parseFloat((gross - tax).toFixed(2)),
      };
    });

    res.json({
      today: parseFloat(earnings.today),
      this_week: parseFloat(earnings.this_week),
      this_month: parseFloat(earnings.this_month),
      all_time_gross: allTimeGross,
      all_time_tax: parseFloat((allTimeGross * taxRate).toFixed(2)),
      all_time_net: parseFloat((allTimeGross * (1 - taxRate)).toFixed(2)),
      tax_rate_percent: levelInfo.taxRate,
      total_jobs: parseInt(earnings.job_count, 10),
      level: levelInfo.level,
      recent_jobs: recentJobs,
    });
  } catch (err) {
    console.error('Get earnings error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

export default router;
