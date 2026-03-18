import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getBestPricesByType } from '../services/fuel';

const router = Router();

const fuelLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, try again shortly' },
});

// GET /api/fuel/best-prices?lat=X&lng=Y&radius=15
router.get('/best-prices', fuelLimiter, async (req: Request, res: Response) => {
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
    res.json({ prices });
  } catch (err) {
    console.error('Fuel prices error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to fetch fuel prices' });
  }
});

export default router;
