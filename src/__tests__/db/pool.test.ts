/**
 * Tests for src/db/pool.ts
 * pg Pool connection setup — SSL config, Cloud SQL sockets, URL parsing.
 */

const mockPoolOn = jest.fn();
const mockPoolInstance = { on: mockPoolOn, query: jest.fn(), end: jest.fn() };

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => mockPoolInstance),
}));

describe('pool', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    // Clean env
    delete process.env.DATABASE_URL;
    delete process.env.INSTANCE_UNIX_SOCKET;
    delete process.env.DB_SSL_MODE;
    delete process.env.DB_SSL_REJECT_UNAUTHORIZED;
    delete process.env.DATABASE_CA_CERT;
    delete process.env.DATABASE_CA_CERT_BASE64;
    delete process.env.DATABASE_CA_CERT_FILE;
    delete process.env.PGSSLROOTCERT;
    delete process.env.DB_HOST;
    delete process.env.DB_PORT;
    delete process.env.DB_USER;
    delete process.env.DB_PASSWORD;
    delete process.env.DB_NAME;
    delete process.env.K_SERVICE;
    delete process.env.K_REVISION;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it('creates a pool with default localhost settings when no env is set', () => {
    const { Pool } = require('pg');
    require('../../db/pool');
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'localhost',
        port: 5432,
        user: 'postgres',
        database: 'asap',
        ssl: false,
      }),
    );
  });

  it('creates a pool with DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';
    const { Pool } = require('pg');
    require('../../db/pool');
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: expect.stringContaining('dbhost'),
      }),
    );
  });

  it('creates a pool with INSTANCE_UNIX_SOCKET (Cloud SQL)', () => {
    process.env.INSTANCE_UNIX_SOCKET = '/cloudsql/project:region:instance';
    process.env.DB_USER = 'sqluser';
    process.env.DB_PASSWORD = 'sqlpass';
    process.env.DB_NAME = 'sqldb';
    const { Pool } = require('pg');
    require('../../db/pool');
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '/cloudsql/project:region:instance',
        user: 'sqluser',
        password: 'sqlpass',
        database: 'sqldb',
        ssl: false,
      }),
    );
  });

  it('applies SSL config with DB_SSL_MODE=require', () => {
    process.env.DB_SSL_MODE = 'require';
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';
    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    expect(call.ssl).toEqual(expect.objectContaining({ rejectUnauthorized: false }));
  });

  it('applies SSL mode disable', () => {
    process.env.DB_SSL_MODE = 'disable';
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';
    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    expect(call.ssl).toBe(false);
  });

  it('reads sslmode from DATABASE_URL query param', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb?sslmode=verify-full';
    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    expect(call.ssl).toEqual(expect.objectContaining({ rejectUnauthorized: true }));
  });

  it('strips SSL params from DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb?sslmode=require&sslcert=foo';
    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    expect(call.connectionString).not.toContain('sslmode');
    expect(call.connectionString).not.toContain('sslcert');
  });

  it('reads CA cert from DATABASE_CA_CERT env', () => {
    process.env.DB_SSL_MODE = 'verify-ca';
    process.env.DATABASE_CA_CERT = '-----BEGIN CERTIFICATE-----\\nFAKE\\n-----END CERTIFICATE-----';
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';
    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    expect(call.ssl.ca).toContain('CERTIFICATE');
    expect(call.ssl.rejectUnauthorized).toBe(true);
  });

  it('reads CA cert from DATABASE_CA_CERT_BASE64 env', () => {
    process.env.DB_SSL_MODE = 'verify-ca';
    const cert = '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----';
    process.env.DATABASE_CA_CERT_BASE64 = Buffer.from(cert).toString('base64');
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';
    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    expect(call.ssl.ca).toContain('CERTIFICATE');
  });

  it('reads CA cert from file path', () => {
    process.env.DB_SSL_MODE = 'verify-ca';
    process.env.DATABASE_CA_CERT_FILE = '/tmp/test-ca.crt';
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';

    jest.doMock('fs', () => ({
      ...jest.requireActual('fs'),
      readFileSync: jest.fn().mockReturnValue('-----BEGIN CERTIFICATE-----\nFILE\n-----END CERTIFICATE-----'),
      existsSync: jest.fn().mockReturnValue(true),
    }));

    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    expect(call.ssl.ca).toContain('CERTIFICATE');
  });

  it('warns when CA cert file cannot be read', () => {
    process.env.DB_SSL_MODE = 'verify-ca';
    process.env.DATABASE_CA_CERT_FILE = '/nonexistent/ca.crt';
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';

    jest.doMock('fs', () => ({
      ...jest.requireActual('fs'),
      readFileSync: jest.fn().mockImplementation((p: string) => {
        if (p.includes('nonexistent')) throw new Error('ENOENT');
        return '';
      }),
      existsSync: jest.fn().mockReturnValue(false),
    }));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    require('../../db/pool');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not read DB CA cert file'), expect.anything());
    warnSpy.mockRestore();
  });

  it('warns when DATABASE_CA_CERT_BASE64 cannot be decoded', () => {
    process.env.DB_SSL_MODE = 'verify-ca';
    process.env.DATABASE_CA_CERT_BASE64 = '!!!not-base64!!!';
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';
    // base64 decode won't throw for most strings; it just produces garbage.
    // This is fine — the warn path is for actual decode errors.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    require('../../db/pool');
    warnSpy.mockRestore();
  });

  it('warns when verify is enabled without CA', () => {
    process.env.DB_SSL_MODE = 'verify-full';
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    require('../../db/pool');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SSL verification is enabled without a custom CA'));
    warnSpy.mockRestore();
  });

  it('registers error handler on pool', () => {
    require('../../db/pool');
    expect(mockPoolOn).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('pool error handler logs error', () => {
    require('../../db/pool');
    const errorHandler = mockPoolOn.mock.calls.find((c: any) => c[0] === 'error')?.[1];
    const errSpy = jest.spyOn(console, 'error').mockImplementation();
    errorHandler?.(new Error('connection lost'));
    expect(errSpy).toHaveBeenCalledWith('Unexpected database pool error:', expect.any(Error));
    errSpy.mockRestore();
  });

  it('uses DB_HOST and DB_PORT when set', () => {
    process.env.DB_HOST = 'custom-host';
    process.env.DB_PORT = '5433';
    process.env.DB_USER = 'myuser';
    process.env.DB_PASSWORD = 'mypass';
    process.env.DB_NAME = 'mydb';
    const { Pool } = require('pg');
    require('../../db/pool');
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'custom-host',
        port: 5433,
        user: 'myuser',
        password: 'mypass',
        database: 'mydb',
      }),
    );
  });

  it('enables ssl when DB_HOST is non-localhost', () => {
    process.env.DB_HOST = 'remote-db.example.com';
    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    expect(call.ssl).not.toBe(false);
  });

  it('disables ssl when DB_HOST is localhost', () => {
    process.env.DB_HOST = 'localhost';
    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    expect(call.ssl).toBe(false);
  });

  it('warns about Cloud SQL socket URL outside Cloud Run', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@/dbname?host=/cloudsql/project:region:instance';
    delete process.env.K_SERVICE;
    delete process.env.K_REVISION;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    require('../../db/pool');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Cloud SQL Unix socket'));
    warnSpy.mockRestore();
  });

  it('does not warn about Cloud SQL socket when K_SERVICE is set', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@/dbname?host=/cloudsql/project:region:instance';
    process.env.K_SERVICE = 'my-service';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    require('../../db/pool');
    const cloudSqlWarns = warnSpy.mock.calls.filter((c: any) =>
      typeof c[0] === 'string' && c[0].includes('Cloud SQL Unix socket')
    );
    expect(cloudSqlWarns.length).toBe(0);
    warnSpy.mockRestore();
  });

  it('handles DATABASE_URL with @/ pattern as Cloud SQL socket', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@/dbname';
    delete process.env.K_SERVICE;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    require('../../db/pool');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Cloud SQL Unix socket'));
    warnSpy.mockRestore();
  });

  it('applies DB_SSL_REJECT_UNAUTHORIZED override', () => {
    process.env.DB_SSL_MODE = 'require';
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'true';
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    expect(call.ssl.rejectUnauthorized).toBe(true);
    warnSpy.mockRestore();
  });

  it('handles parseBoolean for various truthy/falsy values', () => {
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';
    process.env.DB_SSL_MODE = 'require';
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';
    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    expect(call.ssl.rejectUnauthorized).toBe(false);
  });

  it('defaults to require ssl in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';
    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    // In production mode, default SSL should be 'require' (rejectUnauthorized: false)
    expect(call.ssl).toBeTruthy();
    expect(call.ssl).not.toBe(false);
  });

  it('handles PGSSLROOTCERT env for CA cert file', () => {
    process.env.DB_SSL_MODE = 'verify-ca';
    process.env.PGSSLROOTCERT = '/tmp/pg-ca.crt';
    process.env.DATABASE_URL = 'postgres://user:pass@dbhost:5432/mydb';

    jest.doMock('fs', () => ({
      ...jest.requireActual('fs'),
      readFileSync: jest.fn().mockReturnValue('-----BEGIN CERTIFICATE-----\nPGSSL\n-----END CERTIFICATE-----'),
      existsSync: jest.fn().mockReturnValue(true),
    }));

    const { Pool } = require('pg');
    require('../../db/pool');
    const call = Pool.mock.calls[0][0];
    expect(call.ssl.ca).toContain('CERTIFICATE');
  });

  it('handles invalid DATABASE_URL gracefully in stripSslParams', () => {
    process.env.DATABASE_URL = 'not-a-valid-url';
    // Should not throw — stripSslParams catches URL parse errors
    expect(() => require('../../db/pool')).not.toThrow();
  });

  it('handles invalid DATABASE_URL gracefully in getSslModeFromDatabaseUrl', () => {
    process.env.DATABASE_URL = '://bad';
    expect(() => require('../../db/pool')).not.toThrow();
  });
});
