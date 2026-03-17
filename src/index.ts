import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './routes/auth';
import jobRoutes from './routes/jobs';
import uploadRoutes from './routes/upload';
import employeeRoutes from './routes/employees';
import locationRoutes from './routes/location';
import mapkitRoutes from './routes/mapkit';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Security
app.use(helmet({
  contentSecurityPolicy: false, // Expo web needs inline scripts
}));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:8081',
  credentials: true,
}));

// Body parsing with size limits
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/mapkit', mapkitRoutes);

// Serve Expo web build in production
const clientDir = path.join(__dirname, '..', '..', 'dist');
app.use(express.static(clientDir));
// SPA fallback: any non-API route serves index.html
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`ASAP server running on http://localhost:${PORT}`);
});

export default app;
