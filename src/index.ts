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
import publicRoutes from './routes/public';
import searchRoutes from './routes/search';
import businessRoutes from './routes/business';
import pool from './db/pool';
import { startBot, stopBot } from './discord/bot';
import { verifySignature, handleGitHubEvent } from './discord/handlers/github';
import { captureAndPostScreenshots } from './discord/services/screenshots';
import { getBotChannels } from './discord/bot';
import { getInboundTwiML, attachTelephonyWebSocket, isTelephonyAvailable } from './discord/services/telephony';
import twilio from 'twilio';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const DISCORD_BOT_ENABLED = process.env.DISCORD_BOT_ENABLED !== 'false';

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

// Agent activity log — read recent agent events for debugging
// Protected by a simple secret token to prevent public access
app.get('/api/agent-log', async (req, res) => {
  const secret = process.env.AGENT_LOG_SECRET || 'asap-debug';
  if (req.query.key !== secret) {
    res.status(401).json({ error: 'Invalid key. Use ?key=YOUR_SECRET' });
    return;
  }
  try {
    const agent = typeof req.query.agent === 'string' ? req.query.agent : null;
    const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 500);
    const event = typeof req.query.event === 'string' ? req.query.event : null;

    let query = 'SELECT id, ts, agent_id, event, detail, duration_ms, tokens_in, tokens_out FROM agent_activity_log';
    const params: any[] = [];
    const conditions: string[] = [];

    if (agent) {
      params.push(agent);
      conditions.push(`agent_id = $${params.length}`);
    }
    if (event) {
      params.push(event);
      conditions.push(`event = $${params.length}`);
    }

    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY ts DESC';
    params.push(limit);
    query += ` LIMIT $${params.length}`;

    const { rows } = await pool.query(query, params);
    res.json({ count: rows.length, events: rows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown' });
  }
});

// Agent activity log — plain text view for quick terminal reading
app.get('/api/agent-log/text', async (req, res) => {
  const secret = process.env.AGENT_LOG_SECRET || 'asap-debug';
  if (req.query.key !== secret) {
    res.status(401).type('text/plain').send('Unauthorized');
    return;
  }
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
    const { rows } = await pool.query(
      `SELECT ts, agent_id, event, detail, duration_ms FROM agent_activity_log ORDER BY ts DESC LIMIT $1`,
      [limit]
    );
    const lines = rows.reverse().map((r: any) => {
      const time = new Date(r.ts).toLocaleTimeString('en-AU', { hour12: false });
      const dur = r.duration_ms ? ` (${r.duration_ms}ms)` : '';
      return `[${time}] ${r.agent_id.padEnd(20)} ${r.event.padEnd(12)} ${r.detail || ''}${dur}`;
    });
    res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    res.status(500).type('text/plain').send(err instanceof Error ? err.message : 'Unknown error');
  }
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
app.use('/api/public', publicRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/business', businessRoutes);

// GitHub webhook endpoint
app.post('/api/webhooks/github', express.json({ limit: '1mb' }), (req, res) => {
  const event = req.headers['x-github-event'] as string;
  const signature = req.headers['x-hub-signature-256'] as string | undefined;

  if (!event) {
    res.status(400).json({ error: 'Missing x-github-event header' });
    return;
  }

  if (!verifySignature(JSON.stringify(req.body), signature)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  handleGitHubEvent(event, req.body).catch((err) => {
    console.error('GitHub webhook error:', err instanceof Error ? err.message : 'Unknown');
  });

  res.status(200).json({ ok: true });
});

// Build-complete webhook — Cloud Build calls this after successful deploy to trigger screenshots
app.post('/api/webhooks/build-complete', express.json({ limit: '10kb' }), (req, res) => {
  const secret = process.env.BUILD_WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    res.status(401).json({ error: 'Invalid secret' });
    return;
  }

  const appUrl = process.env.FRONTEND_URL || `https://asap-${process.env.GCS_PROJECT_ID || 'asap-489910'}.${process.env.CLOUD_RUN_REGION || 'australia-southeast1'}.run.app`;
  const label = req.body?.commitSha?.slice(0, 7) || 'latest';

  captureAndPostScreenshots(appUrl, label).catch((err) => {
    console.error('Screenshot capture error:', err instanceof Error ? err.message : 'Unknown');
  });

  const channels = getBotChannels();
  if (channels?.url) {
    channels.url.send(`✅ **Build deployed** — app live at ${appUrl}`).catch(() => {});
  }

  res.status(200).json({ ok: true, message: 'Screenshot capture triggered' });
});

// Twilio request signature validation middleware
function twilioWebhookAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    // If no auth token configured, block the request rather than allow unauthenticated access
    res.status(500).json({ error: 'Twilio auth token not configured' });
    return;
  }
  const signature = req.headers['x-twilio-signature'] as string | undefined;
  if (!signature) {
    res.status(403).send('Forbidden');
    return;
  }
  // Build the full URL Twilio signed — prefer SERVER_URL env var, fall back to host header
  const baseUrl = process.env.SERVER_URL || `https://${req.headers.host}`;
  const fullUrl = `${baseUrl}${req.path}`;
  const params = req.body || {};
  const valid = twilio.validateRequest(authToken, signature, fullUrl, params);
  if (!valid) {
    res.status(403).send('Forbidden');
    return;
  }
  next();
}

// Twilio voice webhook — returns TwiML to connect the call to our WebSocket stream
app.post('/api/webhooks/twilio/voice', twilioWebhookAuth, (req, res) => {
  const callerNumber = req.body?.From || req.query?.From;
  res.type('text/xml').send(getInboundTwiML(callerNumber));
});

// Twilio call status callback
app.post('/api/webhooks/twilio/status', twilioWebhookAuth, (_req, res) => {
  res.sendStatus(200);
});

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

  // Attach Twilio WebSocket handler for phone calls
  if (isTelephonyAvailable()) {
    attachTelephonyWebSocket(server);
    console.log('Telephony WebSocket attached');
  }

  // Run the Discord bot only on the dedicated voice-capable host.
  if (DISCORD_BOT_ENABLED) {
    startBot().catch((err) => {
      console.error('Discord bot startup error:', err instanceof Error ? err.message : 'Unknown');
    });
  } else {
    console.log('Discord bot startup disabled by DISCORD_BOT_ENABLED=false');
  }

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
    await stopBot().catch(() => {});
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
