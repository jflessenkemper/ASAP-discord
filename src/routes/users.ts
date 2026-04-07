import { Router, Response } from 'express';
import pool from '../db/pool';
import { AuthRequest, requireAuth } from '../middleware/auth';

const router = Router();

// ─── Get user profile ───
router.get('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { userId, userType } = req.auth!; // req.auth is guaranteed by requireAuth middleware

    let profile;
    if (userType === 'client') {
      const result = await pool.query(
        'SELECT id, email, name, phone, avatar, address FROM clients WHERE id = $1',
        [userId]
      );
      profile = result.rows[0];
    } else if (userType === 'employee') {
      const result = await pool.query(
        'SELECT id, email, name, phone, skills, abn, location FROM employees WHERE id = $1',
        [userId]
      );
      profile = result.rows[0];
    } else {
      // Handle other user types or return an error if necessary
      return res.status(400).json({ error: 'Unsupported user type' });
    }

    if (!profile) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    res.json(profile);
  } catch (err) {
    console.error('Get user profile error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

export default router;
