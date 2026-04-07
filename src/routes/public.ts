import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getBestPricesByType } from '../services/fuel';
import { summarizeFuelPrices, searchBestPrices, categorizeJob } from '../services/gemini';
import { haversineKm } from '../services/fuel';

const router = Router();

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, try again shortly' },
});

// Simple in-memory cache for fuel summaries (5 min TTL)
const summaryCache = new Map<string, { summary: string; ts: number }>();
const SUMMARY_TTL_MS = 5 * 60 * 1000;

// ─── GET /api/public/fuel?lat=X&lng=Y&radius=15 ───
router.get('/fuel', publicLimiter, async (req: Request, res: Response) => {
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

    const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)},${clampedRadius}`;
    let summary = '';
    const cached = summaryCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SUMMARY_TTL_MS) {
      summary = cached.summary;
    } else if (prices.length > 0) {
      summary = await summarizeFuelPrices(prices);
      summaryCache.set(cacheKey, { summary, ts: Date.now() });
    }

    res.json({ prices, summary });
  } catch (err) {
    console.error('Public fuel error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\'t load fuel prices. Please try again.' });
  }
});

// ─── POST /api/public/shop ───
router.post('/shop', publicLimiter, async (req: Request, res: Response) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }
    if (query.trim().length > 200) {
      res.status(400).json({ error: 'Query must be 200 characters or less' });
      return;
    }

    const results = await searchBestPrices(query.trim());
    res.json({ results });
  } catch (err) {
    console.error('Public shop error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\'t search products. Please try again.' });
  }
});

// ─── POST /api/public/businesses ───
router.post('/businesses', publicLimiter, async (req: Request, res: Response) => {
  try {
    const { description, lat, lng } = req.body;
    if (!description || !description.trim()) {
      res.status(400).json({ error: 'Description is required' });
      return;
    }
    if (description.trim().length > 2000) {
      res.status(400).json({ error: 'Description must be 2000 characters or less' });
      return;
    }
    if (lat == null || lng == null || isNaN(Number(lat)) || isNaN(Number(lng))) {
      res.status(400).json({ error: 'Valid lat and lng are required' });
      return;
    }

    const searchQuery = await categorizeJob(description.trim());

    const placesKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!placesKey) {
      res.json({ businesses: [], query: searchQuery });
      return;
    }

    const placesUrl = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    placesUrl.searchParams.set('query', searchQuery);
    placesUrl.searchParams.set('location', `${lat},${lng}`);
    placesUrl.searchParams.set('radius', '15000');
    placesUrl.searchParams.set('key', placesKey);

    const placesRes = await fetch(placesUrl.toString());
    const placesData = await placesRes.json() as any;
    const results = (placesData.results || []).slice(0, 10);

    const businesses = results.map((p: any) => ({
      name: p.name || '',
      rating: p.rating || 0,
      totalRatings: p.user_ratings_total || 0,
      address: p.formatted_address || '',
      lat: p.geometry?.location?.lat || 0,
      lng: p.geometry?.location?.lng || 0,
      distanceKm: parseFloat(
        haversineKm(Number(lat), Number(lng), p.geometry?.location?.lat || 0, p.geometry?.location?.lng || 0).toFixed(1)
      ),
      placeId: p.place_id || '',
      icon: p.icon || '',
      openNow: p.opening_hours?.open_now ?? null,
    }));

    businesses.sort((a: any, b: any) => b.rating - a.rating);
    res.json({ businesses, query: searchQuery });
  } catch (err) {
    console.error('Public businesses error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\'t find businesses. Please try again.' });
  }
});

// ─── GET /api/public/geocode?q=suburb ───
router.get('/geocode', publicLimiter, async (req: Request, res: Response) => {
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
    console.error('Public geocode error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Location search failed. Please try again.' });
  }
});

// Health ping for uptime probes.
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', message: 'Service is healthy' });
});

export default router;
