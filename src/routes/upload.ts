import { Router, Response } from 'express';
import multer from 'multer';
import { AuthRequest, requireAuth, requireEmployee } from '../middleware/auth';
import { uploadEvidence } from '../services/storage';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'video/mp4'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  },
});

// ─── Upload evidence for a job ───
router.post(
  '/evidence/:jobId',
  requireAuth,
  upload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const jobId = req.params.jobId as string;

      // Validate jobId to prevent path traversal in storage
      if (!/^[a-f0-9-]+$/i.test(jobId)) {
        res.status(400).json({ error: 'Invalid job ID format' });
        return;
      }

      const file = req.file;

      if (!file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const originalName = String(file.originalname || 'upload');
      const mimeType = String(file.mimetype || 'application/octet-stream');
      const url = await uploadEvidence(jobId, file.buffer, mimeType, originalName);

      res.status(201).json({ url });
    } catch (err) {
      console.error('Upload error:', err instanceof Error ? err.message : 'Unknown error');
      res.status(500).json({ error: 'Upload failed' });
    }
  }
);

export default router;
