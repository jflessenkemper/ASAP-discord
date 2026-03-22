import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth';
import jobRoutes from './routes/jobs';
import employeeRoutes from './routes/employees';
import locationRoutes from './routes/location';
import mapkitRoutes from './routes/mapkit';
import fuelRoutes from './routes/fuel';
import shopRoutes from './routes/shop';
import favoritesRoutes from './routes/favorites';
import pool from './db/pool';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Validate required production env vars
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
  throw new Error('FRONTEND_URL environment variable is required in production');
}

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
app.use('/api/employees', employeeRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/mapkit', mapkitRoutes);
app.use('/api/fuel', fuelRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/favorites', favoritesRoutes);

// API 404 handler — must come after routes but before SPA fallback
app.use('/api/*', (_req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Serve Expo web build in production
const clientDir = path.join(__dirname, '..', '..', 'dist');
app.use(express.static(clientDir));
// SPA fallback: any non-API route serves index.html
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

// Graceful shutdown
let cleanupInterval: ReturnType<typeof setInterval>;
const server = app.listen(PORT, () => {
  console.log(`ASAP server running on http://localhost:${PORT}`);

  // Clean up expired sessions and 2FA codes every hour
  cleanupInterval = setInterval(async () => {
    try {
      const sessions = await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
      const codes = await pool.query('DELETE FROM two_factor_codes WHERE expires_at < NOW()');
      const fuelSearches = await pool.query('DELETE FROM fuel_searches WHERE created_at < NOW() - INTERVAL \'90 days\'');
      const priceSearches = await pool.query('DELETE FROM price_searches WHERE created_at < NOW() - INTERVAL \'90 days\'');
      const authEvents = await pool.query('DELETE FROM auth_events WHERE created_at < NOW() - INTERVAL \'90 days\'');
      const removedCount = (sessions.rowCount ?? 0) + (codes.rowCount ?? 0) + (fuelSearches.rowCount ?? 0) + (priceSearches.rowCount ?? 0) + (authEvents.rowCount ?? 0);
      if (removedCount > 0) {
        console.log(`Cleanup: removed ${sessions.rowCount} sessions, ${codes.rowCount} 2FA codes, ${fuelSearches.rowCount} fuel searches, ${priceSearches.rowCount} price searches, ${authEvents.rowCount} auth events`);
      }
    } catch (err) {
      console.error('Session cleanup error:', err instanceof Error ? err.message : 'Unknown');
    }
  }, 60 * 60 * 1000);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down gracefully`);
  clearInterval(cleanupInterval);
  server.close(async () => {
    await pool.end();
    console.log('Server shut down');
    process.exit(0);
  });
  // Force exit after 10s if graceful shutdown stalls
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
