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
    const { latitude, longitude, privacyPolicyVersion, consentGiven } = req.body;

    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      res.status(400).json({ error: 'latitude and longitude are required' });
      return;
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      res.status(400).json({ error: 'Invalid coordinates' });
      return;
    }

    const consentUpdateQuery = consentGiven
      ? 'location_consent_at = NOW(), privacy_policy_version = $4'
      : 'privacy_policy_version = $4';

    const queryParams = [latitude, longitude, userId, privacyPolicyVersion || '1.0'];

    if (userType === 'client') {
      await pool.query(
        `UPDATE clients SET latitude = $1, longitude = $2, last_location_update = NOW(), ${consentUpdateQuery} WHERE id = $3`,
        queryParams
      );
    } else if (userType === 'employee') {
      await pool.query(
        `UPDATE employees SET latitude = $1, longitude = $2, last_location_update = NOW(), ${consentUpdateQuery} WHERE id = $3`,
        queryParams
      );
    } else {
      res.status(400).json({ error: 'Invalid user type' });
      return;
    }

    res.json({ message: 'Location updated' });
  } catch (err) {
    console.error('Location update error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Couldn\u2019t update your location. Please try again.' });
  }
});

// ─── Geocode suburb/postcode → lat/lng (AU only) ───
const geocodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many geocode requests. Try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/geocode', requireAuth, geocodeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q || q.length > 100) {
      res.status(400).json({ error: 'A search query is required (max 100 chars)' });
      return;
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Geocoding service unavailable' });
      return;
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&components=country:AU&key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url);
    const data = await resp.json() as { status: string; results?: Array<{ formatted_address: string; geometry: { location: { lat: number; lng: number } } }> };

    if (data.status !== 'OK' || !data.results?.length) {
      res.json({ results: [] });
      return;
    }

    const results = data.results.slice(0, 3).map((r: any) => ({
      formatted_address: r.formatted_address,
      latitude: r.geometry.location.lat,
      longitude: r.geometry.location.lng,
    }));

    res.json({ results });
  } catch (err) {
    console.error('Geocode error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Location search failed. Please try again.' });
  }
});

export default router;
