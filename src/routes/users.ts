import { Router, Response } from 'express';
import pool from '../db/pool';
import { AuthRequest, requireAuth } from '../middleware/auth';

const router = Router();

// ─── Get user profile ───
router.get('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { userId, userType } = req.auth!; // req.auth is guaranteed by requireAuth middleware

    let profile;
    if (userType === 'client') {
      const result = await pool.query(
        'SELECT id, email, name, phone, avatar, address FROM clients WHERE id = $1',
        [userId]
      );
      profile = result.rows[0];
    } else if (userType === 'employee') {
      const result = await pool.query(
        'SELECT id, email, name, phone, skills, abn, location FROM employees WHERE id = $1',
        [userId]
      );
      profile = result.rows[0];
    } else {
      // Handle other user types or return an error if necessary
      return res.status(400).json({ error: 'Unsupported user type' });
    }

    if (!profile) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    res.json(profile);
  } catch (err) {
    console.error('Get user profile error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});


// ─── Update user profile ───
router.put('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { userId, userType } = req.auth!;
    const { name, phone, avatar, address, skills, abn, location } = req.body;

    if (userType === 'client') {
      const updateFields: string[] = [];
      const queryParams: any[] = [userId];
      let paramIndex = 2;

      if (name !== undefined) {
        updateFields.push(`name = ${paramIndex++}`);
        queryParams.push(name);
      }
      if (phone !== undefined) {
        updateFields.push(`phone = ${paramIndex++}`);
        queryParams.push(phone);
      }
      if (avatar !== undefined) {
        updateFields.push(`avatar = ${paramIndex++}`);
        queryParams.push(avatar);
      }
      if (address !== undefined) {
        updateFields.push(`address = ${paramIndex++}`);
        queryParams.push(address);
      }

      if (updateFields.length === 0) {
        return res.status(400).json({ error: 'No valid fields provided for update' });
      }

      const query = `UPDATE clients SET ${updateFields.join(', ')} WHERE id = $1 RETURNING id, email, name, phone, avatar, address`;
      const result = await pool.query(query, queryParams);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Client profile not found' });
      }
      res.json(result.rows[0]);

    } else if (userType === 'employee') {
      const updateFields: string[] = [];
      const queryParams: any[] = [userId];
      let paramIndex = 2;

      if (name !== undefined) {
        updateFields.push(`name = ${paramIndex++}`);
        queryParams.push(name);
      }
      if (phone !== undefined) {
        updateFields.push(`phone = ${paramIndex++}`);
        queryParams.push(phone);
      }
      if (skills !== undefined) {
        updateFields.push(`skills = ${paramIndex++}`);
        queryParams.push(skills);
      }
      if (abn !== undefined) {
        updateFields.push(`abn = ${paramIndex++}`);
        queryParams.push(abn);
      }
      if (location !== undefined) {
        updateFields.push(`location = ${paramIndex++}`);
        queryParams.push(location);
      }

      if (updateFields.length === 0) {
        return res.status(400).json({ error: 'No valid fields provided for update' });
      }

      const query = `UPDATE employees SET ${updateFields.join(', ')} WHERE id = $1 RETURNING id, email, name, phone, skills, abn, location`;
      const result = await pool.query(query, queryParams);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Employee profile not found' });
      }
      res.json(result.rows[0]);

    } else {
      return res.status(400).json({ error: 'Unsupported user type' });
    }
  } catch (err) {
    console.error('Update user profile error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to update user profile' });
  }
});

export default router;

