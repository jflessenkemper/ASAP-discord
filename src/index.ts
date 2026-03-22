import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth';
import jobRoutes from './routes/jobs';
import uploadRoutes from './routes/upload';
import employeeRoutes from './routes/employees';
import locationRoutes from './routes/location';
import mapkitRoutes from './routes/mapkit';
import fuelRoutes from './routes/fuel';
import shopRoutes from './routes/shop';
import favoritesRoutes from './routes/favorites';
import pool from './db/pool';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com", "https://apis.google.com", "https://maps.googleapis.com", "https://connect.facebook.net", "https://cdn.apple-mapkit.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "blob:", "data:", "https://storage.googleapis.com", "https://maps.googleapis.com", "https://maps.gstatic.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "https://accounts.google.com", "https://maps.googleapis.com", "https://www.googleapis.com", "https://graph.facebook.com", "https://ipapi.co", "https://cdn.apple-mapkit.com"],
      frameSrc: ["'self'", "https://accounts.google.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));
const CORS_ORIGIN: cors.CorsOptions['origin'] = process.env.NODE_ENV === 'production'
  ? process.env.FRONTEND_URL || false
  : /^http:\/\/localhost:(8081|19000|19006|3000|3001)$/;

app.use(cors({
  origin: CORS_ORIGIN,
  credentials: true,
}));

// Body parsing with size limits
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());

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
app.use('/api/fuel', fuelRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/favorites', favoritesRoutes);

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

  // Clean up expired sessions and 2FA codes every hour
  setInterval(async () => {
    try {
      const sessions = await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
      const codes = await pool.query('DELETE FROM two_factor_codes WHERE expires_at < NOW()');
      if ((sessions.rowCount ?? 0) > 0 || (codes.rowCount ?? 0) > 0) {
        console.log(`Cleanup: removed ${sessions.rowCount} expired sessions, ${codes.rowCount} expired 2FA codes`);
      }
    } catch (err) {
      console.error('Session cleanup error:', err instanceof Error ? err.message : 'Unknown');
    }
  }, 60 * 60 * 1000);
});

export default app;
