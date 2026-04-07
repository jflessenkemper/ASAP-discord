import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';

import pool from '../db/pool';
import { AuthRequest, requireAuth, requireClient } from '../middleware/auth';
import { searchBestPrices } from '../services/gemini';

const router = Router();

const shopLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, try again shortly' },
});

// POST /api/shop/search
router.post('/search', requireAuth, requireClient, shopLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const clientId = req.auth!.userId;
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

    // Store search + results linked to the client
    await pool.query(
      `INSERT INTO price_searches (client_id, query, results) VALUES ($1, $2, $3)`,
      [clientId, query.trim(), JSON.stringify(results)]
    );

    res.json({ results });
  } catch (err) {
    console.error('Shop search error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\u2019t search products. Please try again.' });
  }
});

// GET /api/shop/history — retrieve past searches for the logged-in client
router.get('/history', requireAuth, requireClient, async (req: AuthRequest, res: Response) => {
  try {
    const clientId = req.auth!.userId;
    const result = await pool.query(
      `SELECT id, query, results, created_at FROM price_searches
       WHERE client_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [clientId]
    );
    res.json({ history: result.rows });
  } catch (err) {
    console.error('Shop history error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Couldn\u2019t load search history. Please try again.' });
  }
});

export default router;
