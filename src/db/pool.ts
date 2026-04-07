import fs from 'fs';

import { Pool } from 'pg';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

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
      console.warn('DATABASE_CA_CERT_BASE64 could not be decoded:', err instanceof Error ? err.message : 'Unknown');
    }
  }

  const caPath = process.env.DATABASE_CA_CERT_FILE || process.env.PGSSLROOTCERT;
  if (caPath && caPath.trim()) {
    try {
      return fs.readFileSync(caPath.trim(), 'utf8').trim();
    } catch (err) {
      console.warn(`Could not read DB CA cert file at ${caPath.trim()}:`, err instanceof Error ? err.message : 'Unknown');
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

const pool = instanceSocket
  ? new Pool({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'asap',
      host: instanceSocket,
      ssl: false,
    })
  : process.env.DATABASE_URL
    ? new Pool({
        connectionString: stripSslParams(process.env.DATABASE_URL),
        ssl: sslConfig,
      })
    : new Pool({
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
