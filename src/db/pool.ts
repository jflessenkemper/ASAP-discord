import fs from 'fs';

import { Pool } from 'pg';
import { errMsg } from '../utils/errors';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const IS_CLOUD_RUN = Boolean(process.env.K_SERVICE || process.env.K_REVISION);

function warnIfCloudRunSocketUrlOutsideCloudRun(): void {
  const rawUrl = String(process.env.DATABASE_URL || '');
  if (!rawUrl) return;
  if (IS_CLOUD_RUN) return;

  const looksLikeCloudSqlSocket =
    rawUrl.includes('host=/cloudsql/')
    || rawUrl.includes('@/');
  if (!looksLikeCloudSqlSocket) return;

  console.warn(
    'DATABASE_URL appears to use a Cloud SQL Unix socket path (/cloudsql/...) outside Cloud Run. '
    + 'Use TCP host/port DATABASE_URL on VM targets to avoid ENOENT socket failures.'
  );
}

warnIfCloudRunSocketUrlOutsideCloudRun();

type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

function getSslModeFromDatabaseUrl(): SslMode | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const mode = parsed.searchParams.get('sslmode')?.toLowerCase() as SslMode | undefined;
    if (!mode) return null;
    if (['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(mode)) {
      return mode;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveSslMode(): SslMode {
  const explicit = process.env.DB_SSL_MODE?.toLowerCase() as SslMode | undefined;
  if (explicit && ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(explicit)) {
    return explicit;
  }

  const fromUrl = getSslModeFromDatabaseUrl();
  if (fromUrl) return fromUrl;

  // Preserve dev ergonomics while keeping prod encrypted by default.
  return IS_PRODUCTION ? 'require' : 'prefer';
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return undefined;
}

function normalizePemText(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}

function getCaCertFromEnv(): string | undefined {
  const inlineCert = process.env.DATABASE_CA_CERT;
  if (inlineCert && inlineCert.trim()) {
    return normalizePemText(inlineCert);
  }

  const base64Cert = process.env.DATABASE_CA_CERT_BASE64;
  if (base64Cert && base64Cert.trim()) {
    try {
      return Buffer.from(base64Cert, 'base64').toString('utf8').trim();
    } catch (err) {
      console.warn('DATABASE_CA_CERT_BASE64 could not be decoded:', errMsg(err));
    }
  }

  const caPath = process.env.DATABASE_CA_CERT_FILE || process.env.PGSSLROOTCERT;
  if (caPath && caPath.trim()) {
    try {
      return fs.readFileSync(caPath.trim(), 'utf8').trim();
    } catch (err) {
      console.warn(`Could not read DB CA cert file at ${caPath.trim()}:`, errMsg(err));
    }
  }

  return undefined;
}

function buildSslConfig(): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode = resolveSslMode();
  if (mode === 'disable') return false;

  const ca = getCaCertFromEnv();
  const verifyByMode = mode === 'verify-ca' || mode === 'verify-full';
  const verifyOverride = parseBoolean(process.env.DB_SSL_REJECT_UNAUTHORIZED);
  const rejectUnauthorized = verifyOverride ?? verifyByMode;

  if (rejectUnauthorized && !ca) {
    console.warn(
      'DB SSL verification is enabled without a custom CA. If your provider uses a private CA, set DATABASE_CA_CERT, DATABASE_CA_CERT_BASE64, or DATABASE_CA_CERT_FILE.'
    );
  }

  return {
    rejectUnauthorized,
    ...(ca ? { ca } : {}),
  };
}

const sslConfig = buildSslConfig();

/**
 * Strip SSL-related query parameters from DATABASE_URL so pg-connection-string
 * doesn't apply its own (potentially stricter) SSL handling.  Our explicit
 * `ssl` option passed to the Pool constructor is the single source of truth.
 */
function stripSslParams(url: string): string {
  try {
    const parsed = new URL(url);
    ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl'].forEach((p) => parsed.searchParams.delete(p));
    return parsed.toString();
  } catch {
    return url;
  }
}

// Cloud SQL via Unix socket (Cloud Run): INSTANCE_UNIX_SOCKET=/cloudsql/project:region:instance
const instanceSocket = process.env.INSTANCE_UNIX_SOCKET;

// Pool sizing — the bot does many concurrent reads (memory recall, learnings,
// user_events embedding, activity log writes, turn tracker state) plus the
// background embedding worker and SI job worker. Default pg pool max of 10 is
// tight under load. Override via DB_POOL_MAX for larger deploys.
const POOL_MAX = Math.max(10, parseInt(process.env.DB_POOL_MAX || '25', 10));
const POOL_IDLE_TIMEOUT_MS = Math.max(10_000, parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS || '30000', 10));
const POOL_CONNECTION_TIMEOUT_MS = Math.max(1000, parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT_MS || '5000', 10));

const sharedPoolOptions = {
  max: POOL_MAX,
  idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
  // Keep TCP connection alive across idle spans so we don't pay a new
  // 3-way handshake + TLS (when enabled) on each reconnect.
  keepAlive: true,
  keepAliveInitialDelayMillis: 5_000,
};

const pool = instanceSocket
  ? new Pool({
      ...sharedPoolOptions,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'asap',
      host: instanceSocket,
      ssl: false,
    })
  : process.env.DATABASE_URL
    ? new Pool({
        ...sharedPoolOptions,
        connectionString: stripSslParams(process.env.DATABASE_URL),
        ssl: sslConfig,
      })
    : new Pool({
        ...sharedPoolOptions,
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'asap',
        ssl: process.env.DB_HOST && process.env.DB_HOST !== 'localhost' ? sslConfig : false,
      });

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

export default pool;
