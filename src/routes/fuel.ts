import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getBestPricesByType } from '../services/fuel';
import { AuthRequest, requireAuth } from '../middleware/auth';
import pool from '../db/pool';

const router = Router();

const fuelLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, try again shortly' },
});

// GET /api/fuel/best-prices?lat=X&lng=Y&radius=15
router.get('/best-prices', requireAuth, fuelLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const radius = parseFloat(req.query.radius as string) || 15;

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      res.status(400).json({ error: 'Valid lat and lng are required' });
      return;
    }

    const clampedRadius = Math.min(Math.max(radius, 1), 50);
    const prices = await getBestPricesByType(lat, lng, clampedRadius);

    // Persist search for history/analytics (non-blocking)
    pool.query(
      `INSERT INTO fuel_searches (client_id, latitude, longitude, radius_km, results) VALUES ($1, $2, $3, $4, $5)`,
      [req.auth!.userId, lat, lng, clampedRadius, JSON.stringify(prices)]
    ).catch(err => console.error('Failed to log fuel search:', err instanceof Error ? err.message : 'Unknown'));

    res.json({ prices });
  } catch (err) {
    console.error('Fuel prices error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\u2019t load fuel prices. Please try again.' });
  }
});

export default router;
