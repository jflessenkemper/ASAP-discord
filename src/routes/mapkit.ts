import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

// MapKit JS token endpoint
// Requires env vars: APPLE_TEAM_ID, APPLE_MAPKIT_KEY_ID, APPLE_MAPKIT_PRIVATE_KEY
router.get('/token', (_req: Request, res: Response) => {
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_MAPKIT_KEY_ID;
  const privateKey = process.env.APPLE_MAPKIT_PRIVATE_KEY;

  if (!teamId || !keyId || !privateKey) {
    res.status(503).json({ error: 'MapKit JS not configured' });
    return;
  }

  // Replace escaped newlines (from env vars) with actual newlines
  const key = privateKey.replace(/\\n/g, '\n');

  const token = jwt.sign({}, key, {
    algorithm: 'ES256',
    issuer: teamId,
    expiresIn: '1h',
    header: {
      alg: 'ES256',
      kid: keyId,
      typ: 'JWT',
    },
  });

  res.json({ token });
});

export default router;
