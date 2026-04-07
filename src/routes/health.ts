import { Router, Response, Request } from 'express';

import pool from '../db/pool';

const router = Router();

// Health check endpoint
router.get('/', async (req: Request, res: Response) => {
  try {
    // For now, we'll assume the service is always healthy.
    // In a real scenario, you'd check database connection,
    // external services, etc., and return 503 if unhealthy.
    try {
      await pool.query('SELECT 1'); // Attempt to connect to the database
      res.status(200).json({ status: 'healthy', message: 'Service is running and database is connected.' });
    } catch (dbError) {
      console.error('Database health check failed:', dbError);
      res.status(503).json({ status: 'unhealthy', message: 'Service dependencies (database) are unhealthy.' });
    }
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ status: 'error', message: 'Internal server error during health check.' });
  }
});

export default router;
