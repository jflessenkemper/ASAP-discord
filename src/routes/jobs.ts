import { Router, Response } from 'express';
import multer from 'multer';
import pool from '../db/pool';
import { AuthRequest, requireAuth, requireClient, requireEmployee } from '../middleware/auth';
import { assessJobDifficulty, transcribeAudio, categorizeJob } from '../services/gemini';
import { calculateFuelCost, haversineKm } from '../services/fuel';
import { uploadEvidence } from '../services/storage';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'video/mp4',
      'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// ─── Create a job (client) ───
router.post('/', requireAuth, requireClient, async (req: AuthRequest, res: Response) => {
  try {
    const clientId = req.auth!.userId;
    const { description } = req.body;

    if (!description || !description.trim()) {
      res.status(400).json({ error: 'Description is required' });
      return;
    }

    if (description.trim().length > 2000) {
      res.status(400).json({ error: 'Description must be 2000 characters or less' });
      return;
    }

    // Check if this is the client's first job
    const clientResult = await pool.query(
      'SELECT first_job_used FROM clients WHERE id = $1',
      [clientId]
    );
    const isFree = !clientResult.rows[0].first_job_used;
    const calloutFree = isFree;

    // Get default rate from an available employee (or use 5.00)
    const empResult = await pool.query(
      'SELECT id, rate_per_minute FROM employees WHERE is_active = TRUE LIMIT 1'
    );
    const rate = empResult.rows.length > 0 ? empResult.rows[0].rate_per_minute : 5.00;
    const assignedEmployeeId = empResult.rows.length > 0 ? empResult.rows[0].id : null;

    const jobResult = await pool.query(
      `INSERT INTO jobs (client_id, employee_id, description, status, rate_per_minute, is_free, callout_free, assigned_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        clientId,
        assignedEmployeeId,
        description.trim(),
        assignedEmployeeId ? 'assigned' : 'pending',
        isFree ? 0 : rate,
        isFree,
        calloutFree,
        assignedEmployeeId ? new Date() : null,
      ]
    );

    const job = jobResult.rows[0];

    // Add timeline entry: created
    await pool.query(
      `INSERT INTO job_timeline (job_id, event_type, description, created_by_type, created_by_id)
       VALUES ($1, 'created', $2, 'client', $3)`,
      [job.id, 'Job created', clientId]
    );

    // If auto-assigned, add timeline entry
    if (assignedEmployeeId) {
      await pool.query(
        `INSERT INTO job_timeline (job_id, event_type, description, created_by_type, created_by_id)
         VALUES ($1, 'assigned', 'Job auto-assigned to technician', 'system', $2)`,
        [job.id, assignedEmployeeId]
      );
    }

    // Mark client's first job as used
    if (isFree) {
      await pool.query('UPDATE clients SET first_job_used = TRUE WHERE id = $1', [clientId]);
    }

    // Assess difficulty via Gemini (async — don't block response)
    assessJobDifficulty(description).then(async (assessment) => {
      try {
        await pool.query(
          'UPDATE jobs SET difficulty_rating = $1, estimated_duration_minutes = $2 WHERE id = $3',
          [assessment.difficulty, assessment.estimatedMinutes, job.id]
        );
      } catch (err) {
        console.error('Failed to update job difficulty:', err instanceof Error ? err.message : 'Unknown error');
      }
    });

    res.status(201).json(job);
  } catch (err) {
    console.error('Create job error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// ─── Transcribe audio (client) ───
router.post('/transcribe', requireAuth, requireClient, upload.single('audio'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Audio file is required' });
      return;
    }

    const text = await transcribeAudio(req.file.buffer, req.file.mimetype);
    res.json({ text });
  } catch (err) {
    console.error('Transcribe error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to transcribe audio' });
  }
});

// ─── Find businesses for a job description (client) ───
router.post('/find-businesses', requireAuth, requireClient, async (req: AuthRequest, res: Response) => {
  try {
    const { description, lat, lng } = req.body;
    if (!description || !description.trim()) {
      res.status(400).json({ error: 'Description is required' });
      return;
    }
    if (!lat || !lng || isNaN(Number(lat)) || isNaN(Number(lng))) {
      res.status(400).json({ error: 'Valid lat and lng are required' });
      return;
    }

    // Step 1: Gemini categorizes the job into a search query
    const searchQuery = await categorizeJob(description.trim());

    // Step 2: Google Places text search
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

    // Sort by rating descending (preference for highly rated)
    businesses.sort((a: any, b: any) => b.rating - a.rating);

    res.json({ businesses, query: searchQuery });
  } catch (err) {
    console.error('Find businesses error:', err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Failed to find businesses' });
  }
});

// ─── Get client's jobs ───
router.get('/client', requireAuth, requireClient, async (req: AuthRequest, res: Response) => {
  try {
    const clientId = req.auth!.userId;
    const result = await pool.query(
      `SELECT j.*, e.username as employee_name
       FROM jobs j
       LEFT JOIN employees e ON j.employee_id = e.id
       WHERE j.client_id = $1
       ORDER BY j.created_at DESC`,
      [clientId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get client jobs error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// ─── Get employee's jobs (sorted by distance then difficulty) ───
router.get('/employee', requireAuth, requireEmployee, async (req: AuthRequest, res: Response) => {
  try {
    const employeeId = req.auth!.userId;

    // Get employee location
    const empLocResult = await pool.query(
      'SELECT latitude, longitude FROM employees WHERE id = $1',
      [employeeId]
    );
    const empLat = empLocResult.rows[0]?.latitude;
    const empLng = empLocResult.rows[0]?.longitude;

    // Get all jobs (assigned to this employee OR pending/unassigned — only active employees see pending)
    const empActiveResult = await pool.query(
      'SELECT is_active FROM employees WHERE id = $1',
      [employeeId]
    );
    const isActive = empActiveResult.rows[0]?.is_active;

    const result = await pool.query(
      `SELECT j.*,
              c.first_name as client_first_name, c.last_name as client_last_name,
              c.phone as client_phone, c.address as client_address,
              c.latitude as client_latitude, c.longitude as client_longitude
       FROM jobs j
       JOIN clients c ON j.client_id = c.id
       WHERE j.employee_id = $1${isActive ? " OR (j.status = 'pending' AND j.employee_id IS NULL)" : ''}
       ORDER BY j.created_at DESC`,
      [employeeId]
    );

    // Compute distance and sort
    let jobs = result.rows.map((j: any) => ({
      ...j,
      client_name: `${j.client_first_name} ${j.client_last_name}`.trim(),
    }));

    if (empLat && empLng) {
      jobs = jobs.map((j: any) => {
        const distance = (j.client_latitude && j.client_longitude)
          ? haversineKm(parseFloat(empLat), parseFloat(empLng), parseFloat(j.client_latitude), parseFloat(j.client_longitude))
          : 9999;
        return { ...j, distance_km: parseFloat(distance.toFixed(1)) };
      });

      jobs.sort((a: any, b: any) => {
        const distDiff = (a.distance_km || 9999) - (b.distance_km || 9999);
        if (Math.abs(distDiff) > 1) return distDiff;
        return (a.difficulty_rating || 5) - (b.difficulty_rating || 5);
      });
    }

    res.json(jobs);
  } catch (err) {
    console.error('Get employee jobs error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// ─── Upload photo to job (client or employee) ───
router.post('/:id/photos', requireAuth, upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const jobId = req.params.id as string;
    const { userId, userType } = req.auth!;
    const caption = (req.body.caption as string) || '';
    const file = req.file;

    // Validate jobId format
    if (!/^[a-f0-9-]+$/i.test(jobId)) {
      res.status(400).json({ error: 'Invalid job ID format' });
      return;
    }

    if (!file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    // Verify access
    const jobResult = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const job = jobResult.rows[0];
    if (userType === 'client' && job.client_id !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    if (userType === 'employee' && job.employee_id !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const originalName = String(file.originalname || 'upload');
    const mimeType = String(file.mimetype || 'application/octet-stream');
    const url = await uploadEvidence(String(jobId), file.buffer, mimeType, originalName);

    const photoResult = await pool.query(
      `INSERT INTO job_photos (job_id, photo_url, caption, uploaded_by, uploaded_by_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [jobId, url, caption, userId, userType]
    );

    await pool.query(
      `INSERT INTO job_timeline (job_id, event_type, description, evidence_url, created_by_type, created_by_id)
       VALUES ($1, 'photo', $2, $3, $4, $5)`,
      [jobId, caption || 'Photo added', url, userType, userId]
    );

    res.status(201).json(photoResult.rows[0]);
  } catch (err) {
    console.error('Upload photo error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// ─── Get job photos ───
router.get('/:id/photos', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM job_photos WHERE job_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get photos error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

// ─── Accept a job (employee) ───
router.post('/:id/accept', requireAuth, requireEmployee, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const employeeId = req.auth!.userId;

    const jobResult = await pool.query(
      "SELECT * FROM jobs WHERE id = $1 AND status = 'pending'",
      [id]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found or already assigned' });
      return;
    }

    const job = jobResult.rows[0];

    // Get employee info
    const empResult = await pool.query(
      'SELECT rate_per_minute, latitude, longitude FROM employees WHERE id = $1',
      [employeeId]
    );
    const emp = empResult.rows[0];

    // Get client location
    const clientResult = await pool.query(
      'SELECT latitude, longitude FROM clients WHERE id = $1',
      [job.client_id]
    );
    const client = clientResult.rows[0];

    // Calculate fuel cost if both locations available
    let fuelCost = null;
    let fuelDistanceKm = null;
    if (emp.latitude && emp.longitude && client.latitude && client.longitude) {
      const fuelResult = await calculateFuelCost(
        parseFloat(emp.latitude), parseFloat(emp.longitude),
        parseFloat(client.latitude), parseFloat(client.longitude)
      );
      fuelCost = fuelResult.fuelCost;
      fuelDistanceKm = fuelResult.distanceKm;
    }

    await pool.query(
      `UPDATE jobs SET employee_id = $1, status = 'assigned', rate_per_minute = $2,
       assigned_at = NOW(), fuel_cost = $3, fuel_distance_km = $4
       WHERE id = $5`,
      [employeeId, job.is_free ? 0 : emp.rate_per_minute, fuelCost, fuelDistanceKm, id]
    );

    await pool.query(
      `INSERT INTO job_timeline (job_id, event_type, description, created_by_type, created_by_id)
       VALUES ($1, 'assigned', 'Job accepted by technician', 'employee', $2)`,
      [id, employeeId]
    );

    res.json({
      message: 'Job accepted',
      fuel_cost: fuelCost,
      fuel_distance_km: fuelDistanceKm,
    });
  } catch (err) {
    console.error('Accept job error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to accept job' });
  }
});

// ─── Get single job with timeline ───
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { userId, userType } = req.auth!;

    const jobResult = await pool.query(
      `SELECT j.*,
              c.first_name as client_first_name, c.last_name as client_last_name,
              c.phone as client_phone, c.address as client_address,
              c.latitude as client_latitude, c.longitude as client_longitude,
              e.username as employee_name
       FROM jobs j
       JOIN clients c ON j.client_id = c.id
       LEFT JOIN employees e ON j.employee_id = e.id
       WHERE j.id = $1`,
      [id]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];
    job.client_name = `${job.client_first_name} ${job.client_last_name}`.trim();

    // Verify access
    if (userType === 'client' && job.client_id !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    if (userType === 'employee' && job.employee_id !== userId && job.status !== 'pending') {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const [timelineResult, photosResult] = await Promise.all([
      pool.query('SELECT * FROM job_timeline WHERE job_id = $1 ORDER BY created_at ASC', [id]),
      pool.query('SELECT * FROM job_photos WHERE job_id = $1 ORDER BY created_at ASC', [id]),
    ]);

    res.json({ ...job, timeline: timelineResult.rows, photos: photosResult.rows });
  } catch (err) {
    console.error('Get job error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// ─── Timer: Start ───
router.post('/:id/timer/start', requireAuth, requireEmployee, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const employeeId = req.auth!.userId;

    const jobResult = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND employee_id = $2',
      [id, employeeId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found or not assigned to you' });
      return;
    }

    const job = jobResult.rows[0];
    if (job.status !== 'assigned' && job.status !== 'paused') {
      res.status(400).json({ error: `Cannot start job with status: ${job.status}` });
      return;
    }

    const eventType = job.status === 'paused' ? 'resumed' : 'started';

    await pool.query(
      `UPDATE jobs SET status = 'in_progress', started_at = COALESCE(started_at, NOW()) WHERE id = $1`,
      [id]
    );

    await pool.query(
      `INSERT INTO job_timeline (job_id, event_type, description, created_by_type, created_by_id)
       VALUES ($1, $2, $3, 'employee', $4)`,
      [id, eventType, eventType === 'resumed' ? 'Timer resumed' : 'Timer started', employeeId]
    );

    res.json({ message: `Timer ${eventType}` });
  } catch (err) {
    console.error('Timer start error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to start timer' });
  }
});

// ─── Timer: Pause ───
router.post('/:id/timer/pause', requireAuth, requireEmployee, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const employeeId = req.auth!.userId;
    const { elapsed_seconds } = req.body;

    if (typeof elapsed_seconds !== 'number' || !Number.isInteger(elapsed_seconds) || elapsed_seconds < 0) {
      res.status(400).json({ error: 'elapsed_seconds must be a non-negative integer' });
      return;
    }

    const jobResult = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND employee_id = $2 AND status = \'in_progress\'',
      [id, employeeId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Active job not found' });
      return;
    }

    await pool.query(
      'UPDATE jobs SET status = \'paused\', total_seconds = $1 WHERE id = $2',
      [elapsed_seconds, id]
    );

    await pool.query(
      `INSERT INTO job_timeline (job_id, event_type, description, created_by_type, created_by_id)
       VALUES ($1, 'paused', 'Timer paused', 'employee', $2)`,
      [id, employeeId]
    );

    res.json({ message: 'Timer paused' });
  } catch (err) {
    console.error('Timer pause error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to pause timer' });
  }
});

// ─── Timer: Stop (Complete job) ───
router.post('/:id/timer/stop', requireAuth, requireEmployee, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const employeeId = req.auth!.userId;
    const { elapsed_seconds } = req.body;

    if (typeof elapsed_seconds !== 'number' || !Number.isInteger(elapsed_seconds) || elapsed_seconds < 0) {
      res.status(400).json({ error: 'elapsed_seconds must be a non-negative integer' });
      return;
    }

    // Cap elapsed_seconds to wall-clock time since job started (+ 60s grace)
    const jobResult = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND employee_id = $2',
      [id, employeeId]
    );

    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];
    if (job.status !== 'in_progress' && job.status !== 'paused') {
      res.status(400).json({ error: `Cannot stop job with status: ${job.status}` });
      return;
    }

    if (job.started_at) {
      const wallClockSeconds = Math.floor((Date.now() - new Date(job.started_at).getTime()) / 1000);
      const maxAllowed = wallClockSeconds + 60; // 60s grace
      if (elapsed_seconds > maxAllowed) {
        res.status(400).json({ error: 'elapsed_seconds exceeds wall-clock time' });
        return;
      }
    }

    // Calculate cost
    const totalCost = job.is_free ? 0 : parseFloat(((elapsed_seconds / 60) * parseFloat(job.rate_per_minute)).toFixed(2));
    const elapsedMinutes = Math.floor(elapsed_seconds / 60);

    await pool.query(
      `UPDATE jobs SET status = 'completed', total_seconds = $1, total_cost = $2, completed_at = NOW() WHERE id = $3`,
      [elapsed_seconds, totalCost, id]
    );

    // Add elapsed minutes as XP to employee's total_minutes
    await pool.query(
      'UPDATE employees SET total_minutes = total_minutes + $1 WHERE id = $2',
      [elapsedMinutes, employeeId]
    );

    await pool.query(
      `INSERT INTO job_timeline (job_id, event_type, description, created_by_type, created_by_id)
       VALUES ($1, 'completed', $2, 'employee', $3)`,
      [id, `Job completed. Duration: ${Math.floor(elapsed_seconds / 60)}m ${elapsed_seconds % 60}s. Cost: $${totalCost.toFixed(2)}`, employeeId]
    );

    res.json({ message: 'Job completed', total_seconds: elapsed_seconds, total_cost: totalCost, xp_earned: elapsedMinutes });
  } catch (err) {
    console.error('Timer stop error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to stop timer' });
  }
});

// ─── Add timeline entry (note) ───
router.post('/:id/timeline', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { userId, userType } = req.auth!;
    const { event_type, description, evidence_url } = req.body;

    if (!description) {
      res.status(400).json({ error: 'Description is required' });
      return;
    }

    // Verify access
    const jobResult = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    if (jobResult.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const job = jobResult.rows[0];
    if (userType === 'client' && job.client_id !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    if (userType === 'employee' && job.employee_id !== userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO job_timeline (job_id, event_type, description, evidence_url, created_by_type, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, event_type || 'note', description, evidence_url || null, userType, userId]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Add timeline entry error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to add timeline entry' });
  }
});

// ─── Get job timeline ───
router.get('/:id/timeline', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM job_timeline WHERE job_id = $1 ORDER BY created_at ASC',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get timeline error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to fetch timeline' });
  }
});

export default router;
