import 'dotenv/config';

// Install global HTTP keep-alive agent BEFORE any fetch() call happens so
// outbound calls to Anthropic / Vertex / ElevenLabs can reuse TCP + TLS
// connections across LLM turns. Must come before other imports that may
// trigger fetches at module load time.
import { installGlobalHttpAgent } from './services/httpAgent';
installGlobalHttpAgent();

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import twilio from 'twilio';

import pool from './db/pool';
import { startRepoSyncLoop, stopRepoSyncLoop } from './discord/repoSync';
import {
  startBot,
  stopBot,
  verifySignature,
  handleGitHubEvent,
  captureAndPostScreenshots,
  getBotChannels,
  postAgentErrorLog,
  getInboundTwiML,
  attachTelephonyWebSocket,
  isTelephonyAvailable,
  getMetricsText,
  PROMETHEUS_CONTENT_TYPE,
  updateLlmSpend,
  getRemainingBudget,
} from './discord/bot.single';
import { loadRuntimeSecrets } from './services/runtimeSecrets';
import { errMsg } from './utils/errors';

const app = express();

app.get('/health-check', (req, res) => {
  res.status(200).send('OK');
});
const PORT = parseInt(process.env.PORT || '3001', 10);
const IS_CLOUD_RUN = !!process.env.K_SERVICE || !!process.env.K_REVISION;
const UNHANDLED_REJECTION_DEDUPE_MS = parseInt(process.env.UNHANDLED_REJECTION_DEDUPE_MS || '60000', 10);

const recentUnhandledRejections = new Map<string, { ts: number; skipped: number }>();

function normalizeErrorDetail(detail: string): string {
  return detail
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<ts>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/:\d+:\d+/g, ':<line>:<col>')
    .replace(/\s+at\s+[^(]+\([^)]*\)/g, ' at <stack-frame>')
    .replace(/\b\d{16,}\b/g, '<snowflake>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function isExpectedVoiceIpDiscoveryDisconnect(detail: string): boolean {
  const d = detail.toLowerCase();
  const ipDiscoverySocketClosed = /cannot\s+perform\s+ip\s+discovery[\s\S]{0,120}socket\s+closed/i.test(d);
  return ipDiscoverySocketClosed;
}

function shouldLogUnhandledRejection(detail: string): { shouldLog: boolean; skipped: number } {
  const key = normalizeErrorDetail(detail);
  const now = Date.now();
  const previous = recentUnhandledRejections.get(key);
  if (!previous) {
    recentUnhandledRejections.set(key, { ts: now, skipped: 0 });
    return { shouldLog: true, skipped: 0 };
  }
  if (now - previous.ts < UNHANDLED_REJECTION_DEDUPE_MS) {
    previous.skipped += 1;
    recentUnhandledRejections.set(key, previous);
    return { shouldLog: false, skipped: previous.skipped };
  }
  const skipped = previous.skipped;
  recentUnhandledRejections.set(key, { ts: now, skipped: 0 });
  return { shouldLog: true, skipped };
}

if (IS_CLOUD_RUN) {
  app.set('trust proxy', 1);
}
// Discord voice requires UDP. Cloud Run is HTTP-only, so force-disable bot there.
const DISCORD_BOT_ENABLED = !IS_CLOUD_RUN && process.env.DISCORD_BOT_ENABLED !== 'false';
const DISCORD_BOT_SKIP_LOCK_REQUESTED = process.env.DISCORD_BOT_SKIP_LOCK === 'true';
const DISCORD_BOT_ALLOW_SKIP_LOCK = process.env.DISCORD_BOT_ALLOW_SKIP_LOCK === 'true';
const DISCORD_BOT_SKIP_LOCK = DISCORD_BOT_SKIP_LOCK_REQUESTED && DISCORD_BOT_ALLOW_SKIP_LOCK;
const DISCORD_BOT_LOCK_KEY = parseInt(process.env.DISCORD_BOT_LOCK_KEY || '842021', 10);
let botLockClient: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ locked?: boolean }> }>; release: () => void } | null = null;

async function acquireDiscordBotLock(): Promise<boolean> {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [DISCORD_BOT_LOCK_KEY]);
    const locked = !!res.rows?.[0]?.locked;
    if (!locked) {
      client.release();
      return false;
    }
    botLockClient = client;
    return true;
  } catch (err) {
    client.release();
    throw err;
  }
}

async function releaseDiscordBotLock(): Promise<void> {
  if (!botLockClient) return;
  try {
    await botLockClient.query('SELECT pg_advisory_unlock($1)', [DISCORD_BOT_LOCK_KEY]);
  } catch {
  } finally {
    botLockClient.release();
    botLockClient = null;
  }
}

process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);

  if (isExpectedVoiceIpDiscoveryDisconnect(detail)) {
    const { shouldLog, skipped } = shouldLogUnhandledRejection(`voice-ip-discovery:${detail}`);
    if (shouldLog) {
      console.warn(`[VOICE] Suppressed expected transient voice disconnect rejection${skipped > 0 ? ` (repeated ${skipped}x)` : ''}`);
    }
    return;
  }

  const { shouldLog, skipped } = shouldLogUnhandledRejection(detail);
  if (!shouldLog) return;

  console.error('Unhandled rejection:', detail);
  const detailWithDedup = skipped > 0
    ? `${detail} [dedupe_skipped=${skipped}]`
    : detail;
  void postAgentErrorLog('process:unhandledRejection', 'Unhandled promise rejection', { detail: detailWithDedup });
});

process.on('uncaughtException', (err) => {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  console.error('Uncaught exception:', detail);
  void postAgentErrorLog('process:uncaughtException', 'Uncaught exception', { detail });
});

// Security
app.use(helmet());

// Defense-in-depth legacy headers for older clients/proxies.
app.use((_req, res, next) => {
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(cors());

// Body parsing with size limits
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Prometheus metrics endpoint — protected by the same AGENT_LOG_SECRET
// so it is not publicly accessible without a key.
app.get('/api/metrics', (req, res) => {
  const secret = process.env.AGENT_LOG_SECRET;
  if (!secret || req.query.key !== secret) {
    res.status(401).type('text/plain').send('Unauthorized. Use ?key=YOUR_SECRET');
    return;
  }
  const { spent } = getRemainingBudget();
  updateLlmSpend(spent);
  res.set('Content-Type', PROMETHEUS_CONTENT_TYPE).send(getMetricsText());
});

// Agent activity log — read recent agent events for debugging
// Protected by a simple secret token to prevent public access
app.get('/api/agent-log', async (req, res) => {
  const secret = process.env.AGENT_LOG_SECRET;
  if (!secret || req.query.key !== secret) {
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
    res.status(500).json({ error: errMsg(err) });
  }
});

// Agent activity log — plain text view for quick terminal reading
app.get('/api/agent-log/text', async (req, res) => {
  const secret = process.env.AGENT_LOG_SECRET;
  if (!secret || req.query.key !== secret) {
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
    res.status(500).type('text/plain').send(errMsg(err));
  }
});

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
    const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
    console.error('GitHub webhook error:', errMsg(err));
    void postAgentErrorLog('github:webhook', 'GitHub webhook error', { detail: msg });
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
  const tryCapture = async () => {
    let screenshotTarget = getBotChannels()?.screenshots;
    if (!screenshotTarget) {
      console.warn('Build-complete webhook received before screenshots channel was ready. Retrying...');
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        screenshotTarget = getBotChannels()?.screenshots;
        if (screenshotTarget) break;
      }
    }

    await captureAndPostScreenshots(appUrl, label, {
      targetChannel: screenshotTarget || undefined,
      clearTargetChannel: true,
    });
  };

  void tryCapture().catch((err) => {
    const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
    console.error('Screenshot capture error:', errMsg(err));
    void postAgentErrorLog('build-complete:webhook', 'Screenshot capture error', { detail: msg });
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
app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  void next;
  console.error('Unhandled error:', err.message);
  void postAgentErrorLog('express', 'Unhandled request error', { detail: err.stack || err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
const server = app.listen(PORT, () => {
  console.log(`ASAP server running on http://localhost:${PORT}`);

  void (async () => {
    await loadRuntimeSecrets().catch(() => {});

    // Start ASAP app repo sync loop (clone + periodic pull to origin/main)
    if (DISCORD_BOT_ENABLED) {
      startRepoSyncLoop();
    }

    // Attach Twilio WebSocket handler for phone calls
    if (isTelephonyAvailable()) {
      attachTelephonyWebSocket(server);
      console.log('Telephony WebSocket attached');
    }

    // Run the Discord bot only on the dedicated voice-capable host.
    if (DISCORD_BOT_ENABLED) {
      try {
        if (DISCORD_BOT_SKIP_LOCK_REQUESTED && !DISCORD_BOT_ALLOW_SKIP_LOCK) {
          console.warn('Ignoring DISCORD_BOT_SKIP_LOCK=true because DISCORD_BOT_ALLOW_SKIP_LOCK is not set');
        }
        const lockAcquired = DISCORD_BOT_SKIP_LOCK ? true : await acquireDiscordBotLock();
        if (!lockAcquired) {
          console.log('Discord bot startup skipped: lock held by another instance');
        } else {
          if (DISCORD_BOT_SKIP_LOCK) {
            console.log('Discord bot startup lock bypass enabled (DISCORD_BOT_SKIP_LOCK=true)');
          }
          startBot().catch((err) => {
            console.error('Discord bot startup error:', errMsg(err));
          });
        }
      } catch (err) {
        console.error('Discord bot lock acquisition failed:', errMsg(err));
      }
    } else {
      const reason = IS_CLOUD_RUN
        ? 'Cloud Run runtime detected (UDP unavailable for Discord voice)'
        : 'DISCORD_BOT_ENABLED=false';
      console.log(`Discord bot startup disabled: ${reason}`);
    }
  })();

});

function shutdown(signal: string) {
  if (shutdownInProgress) {
    console.log(`${signal} received, shutdown already in progress`);
    return;
  }
  shutdownInProgress = true;
  console.log(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    await stopBot().catch(() => {});
    stopRepoSyncLoop();
    await releaseDiscordBotLock().catch(() => {});
    await pool.end().catch((err) => {
      if (!String(errMsg(err)).includes('Called end on pool more than once')) {
        throw err;
      }
    });
    console.log('Server shut down');
    process.exit(0);
  });
  // Force exit after 10s if graceful shutdown stalls
  setTimeout(() => process.exit(1), 10_000).unref();
}
let shutdownInProgress = false;
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
