import { Router, Response } from 'express';
import { AuthRequest, requireAuth } from '../middleware/auth';
import pool from '../db/pool';

const router = Router();

// GET /api/favorites — list all saved items for current client
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT id, item_type, item_data, created_at FROM saved_items WHERE client_id = $1 ORDER BY created_at DESC',
      [req.auth!.userId]
    );
    res.json({ items: result.rows });
  } catch (err) {
    console.error('Get favorites error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to load favorites' });
  }
});

// POST /api/favorites — save a new item
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { item_type, item_data } = req.body;
    if (!item_type || !item_data) {
      res.status(400).json({ error: 'item_type and item_data are required' });
      return;
    }
    if (!['fuel', 'shop', 'business'].includes(item_type)) {
      res.status(400).json({ error: 'item_type must be fuel, shop, or business' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO saved_items (client_id, item_type, item_data) VALUES ($1, $2, $3)
       RETURNING id, item_type, item_data, created_at`,
      [req.auth!.userId, item_type, JSON.stringify(item_data)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Save favorite error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to save favorite' });
  }
});

// DELETE /api/favorites/:id — remove a saved item
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM saved_items WHERE id = $1 AND client_id = $2',
      [id, req.auth!.userId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Remove favorite error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to remove favorite' });
  }
});

export default router;
