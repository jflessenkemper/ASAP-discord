import { Pool } from 'pg';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// In production, validate SSL certificates. Only skip validation in local dev.
const sslConfig = IS_PRODUCTION
  ? { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT } : {}) }
  : { rejectUnauthorized: false };

// Cloud SQL via Unix socket (Cloud Run): INSTANCE_UNIX_SOCKET=/cloudsql/project:region:instance
const instanceSocket = process.env.INSTANCE_UNIX_SOCKET;

const pool = instanceSocket
  ? new Pool({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'asap',
      host: instanceSocket,
    })
  : process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
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
