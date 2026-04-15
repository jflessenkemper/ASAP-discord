/**
 * Tests for src/db/checkAndGrantAgentMemoryPerms.ts
 * Database permission grants — mock pg pool, child_process, process lifecycle.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockEnd = jest.fn().mockResolvedValue(undefined);
jest.mock('../../db/pool', () => ({
  default: { query: mockQuery, end: mockEnd, on: jest.fn() },
  __esModule: true,
}));

const mockExecFileSync = jest.fn();
jest.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

const mockPoolConstructorQuery = jest.fn();
const mockPoolEnd = jest.fn().mockResolvedValue(undefined);
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockPoolConstructorQuery,
    end: mockPoolEnd,
  })),
}));

describe('checkAndGrantAgentMemoryPerms', () => {
  const originalExitCode = process.exitCode;
  let mockProcessExit: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockEnd.mockReset().mockResolvedValue(undefined);
    mockExecFileSync.mockReset();
    mockPoolConstructorQuery.mockReset();
    mockPoolEnd.mockReset().mockResolvedValue(undefined);
    process.exitCode = undefined;
    delete process.env.DB_GRANT_TABLES;
    delete process.env.DB_GRANT_ROLE;
    delete process.env.DB_GRANT_DATABASE_URL;
    delete process.env.DB_GRANT_DATABASE_URL_SECRET;
    delete process.env.DB_GRANT_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    // Mock process.exit to prevent Jest from dying
    mockProcessExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    mockProcessExit.mockRestore();
  });

  async function runModule() {
    // The module runs main() on import which is async.
    // We need to wait for all microtasks and timers to settle.
    try {
      await jest.isolateModulesAsync(async () => {
        await import('../../db/checkAndGrantAgentMemoryPerms');
        // Let the promise chain fully resolve
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
    } catch {
      // Some tests cause errors in the promise chain
    }
    // Extra tick for .finally() handler
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  it('exits early when permissions already valid', async () => {
    // current_user query
    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    // tableExists checks for 3 default tables
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] }); // agent_memory
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] }); // discord_message_dedupe
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] }); // agent_activity_log
    // hasRequiredPerms for 3 tables — all OK
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });

    await runModule();
    expect(process.exitCode).toBeUndefined();
  });

  it('exits with code 1 when no target tables exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    // All tables do not exist
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });

    await runModule();
    expect(process.exitCode).toBe(1);
  });

  it('grants permissions when missing and primary grant succeeds', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    // 3 tables exist
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    // Before perms — MISSING
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: false, insert_ok: false, update_ok: false, delete_ok: false }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: false, insert_ok: false, update_ok: false, delete_ok: false }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: false, insert_ok: false, update_ok: false, delete_ok: false }] });
    // GRANT queries: 3 table GRANTs + 1 sequence GRANT
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // GRANT table 1
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // GRANT table 2
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // GRANT table 3
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // GRANT sequences
    // After perms — OK
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });

    await runModule();
    expect(process.exitCode).toBeUndefined();
  });

  it('falls back to admin URL when primary grant fails', async () => {
    process.env.DB_GRANT_DATABASE_URL = 'postgresql://admin:pass@localhost/db';

    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    // 1 table exists (custom config)
    process.env.DB_GRANT_TABLES = 'agent_memory';
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    // Before perms — MISSING
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: false, insert_ok: false, update_ok: false, delete_ok: false }] });
    // Primary GRANT fails
    mockQuery.mockRejectedValueOnce(new Error('permission denied'));
    // Admin pool GRANT succeeds
    mockPoolConstructorQuery.mockResolvedValueOnce({ rowCount: 0 }); // GRANT table
    mockPoolConstructorQuery.mockResolvedValueOnce({ rowCount: 0 }); // GRANT sequences
    // After perms — OK
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });

    await runModule();
    expect(process.exitCode).toBeUndefined();
  });

  it('falls back to admin TLS-insecure pool when TLS cert error', async () => {
    process.env.DB_GRANT_DATABASE_URL = 'postgresql://admin:pass@localhost/db';
    process.env.DB_GRANT_TABLES = 'agent_memory';

    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: false, insert_ok: false, update_ok: false, delete_ok: false }] });
    // Primary GRANT fails
    mockQuery.mockRejectedValueOnce(new Error('permission denied'));
    // Admin pool fails with TLS error
    mockPoolConstructorQuery.mockRejectedValueOnce(new Error('unable to verify the first certificate'));
    // Second admin pool (insecure) succeeds
    mockPoolConstructorQuery.mockResolvedValueOnce({ rowCount: 0 }); // GRANT table
    mockPoolConstructorQuery.mockResolvedValueOnce({ rowCount: 0 }); // GRANT sequences
    // After perms — OK
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });

    await runModule();
    expect(process.exitCode).toBeUndefined();
  });

  it('exits with code 1 when no admin URL and grant fails', async () => {
    process.env.DB_GRANT_TABLES = 'agent_memory';

    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: false, insert_ok: false, update_ok: false, delete_ok: false }] });
    // Primary GRANT fails
    mockQuery.mockRejectedValueOnce(new Error('permission denied for table'));

    await runModule();
    expect(process.exitCode).toBe(1);
  });

  it('exits with code 1 when all fallback admin grants fail', async () => {
    process.env.DB_GRANT_DATABASE_URL = 'postgresql://admin:pass@localhost/db';
    process.env.DB_GRANT_TABLES = 'agent_memory';

    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: false, insert_ok: false, update_ok: false, delete_ok: false }] });
    // Primary GRANT fails
    mockQuery.mockRejectedValueOnce(new Error('permission denied'));
    // Admin pool fails (non-TLS)
    mockPoolConstructorQuery.mockRejectedValueOnce(new Error('password authentication failed'));

    await runModule();
    expect(process.exitCode).toBe(1);
  });

  it('exits with code 1 when post-grant verification fails', async () => {
    process.env.DB_GRANT_TABLES = 'agent_memory';

    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    // Before perms — MISSING
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: false, insert_ok: false, update_ok: false, delete_ok: false }] });
    // GRANT succeeds
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // GRANT table
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // GRANT sequences
    // After perms — Still MISSING (shouldn't happen normally)
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: false, insert_ok: false, update_ok: false, delete_ok: false }] });

    await runModule();
    expect(process.exitCode).toBe(1);
  });

  it('resolves admin URL from GCP secret when env URL not set', async () => {
    process.env.DB_GRANT_DATABASE_URL_SECRET = 'db-admin-url';
    process.env.DB_GRANT_TABLES = 'agent_memory';

    mockExecFileSync.mockReturnValue('postgresql://admin:pass@localhost/db\n');

    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: false, insert_ok: false, update_ok: false, delete_ok: false }] });
    // Primary GRANT fails
    mockQuery.mockRejectedValueOnce(new Error('permission denied'));
    // Admin pool GRANT succeeds
    mockPoolConstructorQuery.mockResolvedValueOnce({ rowCount: 0 });
    mockPoolConstructorQuery.mockResolvedValueOnce({ rowCount: 0 });
    // After perms — OK
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });

    await runModule();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gcloud',
      expect.arrayContaining(['secrets', 'versions', 'access', 'latest', '--secret', 'db-admin-url']),
      expect.any(Object),
    );
  });

  it('returns null from tryReadSecret when gcloud fails', async () => {
    process.env.DB_GRANT_DATABASE_URL_SECRET = 'bad-secret';
    process.env.DB_GRANT_TABLES = 'agent_memory';

    mockExecFileSync.mockImplementation(() => { throw new Error('gcloud not found'); });

    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: false, insert_ok: false, update_ok: false, delete_ok: false }] });
    // Primary GRANT fails
    mockQuery.mockRejectedValueOnce(new Error('permission denied'));

    await runModule();
    // No admin URL resolved — should exit with code 1
    expect(process.exitCode).toBe(1);
  });

  it('uses custom DB_GRANT_ROLE from env', async () => {
    process.env.DB_GRANT_ROLE = 'custom_role';
    process.env.DB_GRANT_TABLES = 'agent_memory';

    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    // Perms already OK
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });

    await runModule();
    // Verify role was used in has_table_privilege check
    const permsCalls = mockQuery.mock.calls.filter((c: any[]) => String(c[0]).includes('has_table_privilege'));
    expect(permsCalls.length).toBe(1);
    expect(permsCalls[0][0]).toContain("'custom_role'");
  });

  it('uses custom DB_GRANT_TABLES from env', async () => {
    process.env.DB_GRANT_TABLES = 'custom_table_1,custom_table_2';

    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    // 2 tables exist
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    // Perms OK
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });

    await runModule();
    expect(process.exitCode).toBeUndefined();
  });

  it('strips SSL params from admin URL (fallback grant succeeds)', async () => {
    process.env.DB_GRANT_DATABASE_URL = 'postgresql://admin:pass@localhost/db?sslmode=require&sslcert=/path/cert';
    process.env.DB_GRANT_TABLES = 'agent_memory';

    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: false, insert_ok: false, update_ok: false, delete_ok: false }] });
    mockQuery.mockRejectedValueOnce(new Error('permission denied'));
    // Admin pool GRANT succeeds
    mockPoolConstructorQuery.mockResolvedValueOnce({ rowCount: 0 });
    mockPoolConstructorQuery.mockResolvedValueOnce({ rowCount: 0 });
    // After perms — OK
    mockQuery.mockResolvedValueOnce({ rows: [{ select_ok: true, insert_ok: true, update_ok: true, delete_ok: true }] });

    await runModule();
    // Pool was called (admin fallback) and module succeeded
    expect(process.exitCode).toBeUndefined();
    expect(mockPoolConstructorQuery).toHaveBeenCalled();
  });

  it('rejects invalid SQL identifier in quoteIdentifier', async () => {
    // quoteIdentifier is used for table names — if someone passes injection it should throw
    process.env.DB_GRANT_TABLES = 'DROP TABLE; --bad';

    mockQuery.mockResolvedValueOnce({ rows: [{ current_user: 'testuser' }] });
    // tableExists will call quoteIdentifier which throws → main catches → process.exit(1)

    await runModule();
    // The invalid identifier should cause the module to call process.exit(1)
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });
});
