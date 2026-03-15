import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import pool from '../db/pool';
import { AuthRequest, requireAuth } from '../middleware/auth';

const router = Router();

const locationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many location updates. Try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Update location (client or employee) ───
router.post('/', requireAuth, locationLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { userId, userType } = req.auth!;
    const { latitude, longitude } = req.body;

    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      res.status(400).json({ error: 'latitude and longitude are required' });
      return;
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      res.status(400).json({ error: 'Invalid coordinates' });
      return;
    }

    const table = userType === 'client' ? 'clients' : 'employees';
    await pool.query(
      `UPDATE ${table} SET latitude = $1, longitude = $2, last_location_update = NOW() WHERE id = $3`,
      [latitude, longitude, userId]
    );

    res.json({ message: 'Location updated' });
  } catch (err) {
    console.error('Location update error:', err);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

export default router;
