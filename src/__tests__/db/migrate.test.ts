/**
 * Tests for src/db/migrate.ts
 * Database migration runner — mocks pg pool and filesystem.
 */

export {};

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({
  query: mockClientQuery,
  release: mockClientRelease,
});
const mockEnd = jest.fn();
const mockOn = jest.fn();

jest.mock('../../db/pool', () => ({
  __esModule: true,
  default: {
    query: mockQuery,
    connect: mockConnect,
    end: mockEnd,
    on: mockOn,
  },
}));

jest.mock('dotenv/config', () => ({}));

const mockReaddirSync = jest.fn();
const mockReadFileSync = jest.fn();
jest.mock('fs', () => ({
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
}));

describe('migrate', () => {
  const origExit = process.exit;
  const origConsoleLog = console.log;
  const origConsoleError = console.error;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    console.log = jest.fn();
    console.error = jest.fn();
    process.exit = jest.fn() as any;

    // Default: applied_migrations table exists with no rows
    mockQuery
      .mockResolvedValueOnce(undefined) // CREATE TABLE IF NOT EXISTS
      .mockResolvedValueOnce({ rows: [] }); // SELECT filename FROM applied_migrations

    // Default: no migration files
    mockReaddirSync.mockReturnValue([]);

    // Default: getMissingTables for assertRuntimeTablesReady — all tables exist.
    // Keep this in sync with REQUIRED_RUNTIME_TABLES in src/db/runtimeSchema.ts.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // agent_memory
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // agent_activity_log
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // self_improvement_jobs
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // agent_learnings
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // user_events
      .mockResolvedValueOnce({ rows: [{ exists: true }] }); // decisions
  });

  afterAll(() => {
    process.exit = origExit;
    console.log = origConsoleLog;
    console.error = origConsoleError;
  });

  it('runs with no migration files', async () => {
    mockReaddirSync.mockReturnValue([]);

    await jest.isolateModulesAsync(async () => {
      require('../../db/migrate');
      // Give the top-level migrate().catch() time to execute
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS'));
    expect(mockEnd).toHaveBeenCalled();
  });

  it('applies new migrations in a transaction', async () => {
    mockQuery
      .mockReset()
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }); // SELECT applied

    mockReaddirSync.mockReturnValue(['002_new.sql']);
    mockReadFileSync.mockReturnValue('CREATE TABLE test_table (id INT);');
    mockClientQuery.mockResolvedValue(undefined);

    // assertRuntimeTablesReady — all tables exist (mirror REQUIRED_RUNTIME_TABLES)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] });

    await jest.isolateModulesAsync(async () => {
      require('../../db/migrate');
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockConnect).toHaveBeenCalled();
    expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockClientQuery).toHaveBeenCalledWith('CREATE TABLE test_table (id INT);');
    expect(mockClientQuery).toHaveBeenCalledWith('INSERT INTO applied_migrations (filename) VALUES ($1)', ['002_new.sql']);
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it('skips already applied migrations', async () => {
    mockQuery
      .mockReset()
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [{ filename: '003_agent_memory.sql' }] }) // SELECT applied
      .mockResolvedValueOnce(undefined); // INSERT baseline row (applied.size > 0 triggers auto-mark)

    // For assertAppliedMigrationExpectations: 003_agent_memory.sql expects 'agent_memory'
    // and 000_baseline.sql (auto-marked) expects agent_memory + agent_activity_log
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // baseline: agent_memory
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // baseline: agent_activity_log
      .mockResolvedValueOnce({ rows: [{ exists: true }] }); // 003_agent_memory.sql: agent_memory

    mockReaddirSync.mockReturnValue(['003_agent_memory.sql']);

    // assertRuntimeTablesReady (mirror REQUIRED_RUNTIME_TABLES)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] });

    await jest.isolateModulesAsync(async () => {
      require('../../db/migrate');
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockConnect).not.toHaveBeenCalled(); // No transaction needed
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already applied'));
  });

  it('rolls back on migration failure', async () => {
    mockQuery
      .mockReset()
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }); // SELECT applied

    mockReaddirSync.mockReturnValue(['002_fail.sql']);
    mockReadFileSync.mockReturnValue('INVALID SQL;');
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('syntax error')); // SQL fails

    // Rollback should succeed
    mockClientQuery.mockResolvedValueOnce(undefined); // ROLLBACK

    await jest.isolateModulesAsync(async () => {
      require('../../db/migrate');
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Migration failed:', expect.any(Error));
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('detects migration drift when expected tables are missing', async () => {
    mockQuery
      .mockReset()
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [{ filename: '003_agent_memory.sql' }] }) // SELECT applied
      .mockResolvedValueOnce(undefined); // INSERT baseline row (applied.size > 0 triggers auto-mark)

    // assertAppliedMigrationExpectations iterates the expectations map. The
    // squashed baseline is auto-marked applied (applied.size > 0), so it
    // also checks agent_memory + agent_activity_log. getMissingTables runs
    // both queries before returning, then the drift error fires.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: false }] }) // baseline: agent_memory missing
      .mockResolvedValueOnce({ rows: [{ exists: true }] }); // baseline: agent_activity_log present (missing-list non-empty → throw)

    mockReaddirSync.mockReturnValue([]);

    await jest.isolateModulesAsync(async () => {
      require('../../db/migrate');
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(console.error).toHaveBeenCalledWith(
      'Migration failed:',
      expect.objectContaining({ message: expect.stringContaining('Migration drift detected') }),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('detects missing runtime tables after migration', async () => {
    mockQuery
      .mockReset()
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }); // SELECT applied

    mockReaddirSync.mockReturnValue([]);

    // assertRuntimeTablesReady: agent_memory missing, others present (mirror REQUIRED_RUNTIME_TABLES)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: false }] }) // agent_memory missing
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] });

    await jest.isolateModulesAsync(async () => {
      require('../../db/migrate');
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(console.error).toHaveBeenCalledWith(
      'Migration failed:',
      expect.objectContaining({ message: expect.stringContaining('Runtime schema incomplete') }),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('filters out non-.sql files', async () => {
    mockQuery
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] });

    mockReaddirSync.mockReturnValue(['README.md', '003_agent_memory.sql', '.gitkeep']);
    mockReadFileSync.mockReturnValue('SELECT 1;');
    mockClientQuery.mockResolvedValue(undefined);

    // assertRuntimeTablesReady (mirror REQUIRED_RUNTIME_TABLES)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] });

    await jest.isolateModulesAsync(async () => {
      require('../../db/migrate');
      await new Promise((r) => setTimeout(r, 50));
    });

    // Only 003_agent_memory.sql should have been applied
    expect(mockClientQuery).toHaveBeenCalledWith('INSERT INTO applied_migrations (filename) VALUES ($1)', ['003_agent_memory.sql']);
  });

  it('checks expectations for multiple migration entries', async () => {
    mockQuery
      .mockReset()
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({
        rows: [
          { filename: '003_agent_memory.sql' },
          { filename: '015_agent_activity_log.sql' },
        ],
      })
      .mockResolvedValueOnce(undefined); // INSERT baseline row (applied.size > 0 triggers auto-mark)

    // assertAppliedMigrationExpectations: baseline + 003 + 015 all map to agent_memory/agent_activity_log
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // baseline: agent_memory
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // baseline: agent_activity_log
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // 003: agent_memory
      .mockResolvedValueOnce({ rows: [{ exists: true }] }); // 015: agent_activity_log

    mockReaddirSync.mockReturnValue([]);

    // assertRuntimeTablesReady (mirror REQUIRED_RUNTIME_TABLES)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] });

    await jest.isolateModulesAsync(async () => {
      require('../../db/migrate');
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockEnd).toHaveBeenCalled();
  });
});
