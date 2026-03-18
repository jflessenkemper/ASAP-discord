import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { searchBestPrices } from '../services/gemini';

const router = Router();

const shopLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, try again shortly' },
});

// POST /api/shop/search
router.post('/search', shopLimiter, async (req: Request, res: Response) => {
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
    console.error('Shop search error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to search products' });
  }
});

export default router;
