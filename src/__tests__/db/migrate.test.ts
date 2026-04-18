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

    // Default: getMissingTables for assertRuntimeTablesReady — all tables exist
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // agent_memory
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // agent_activity_log
      .mockResolvedValueOnce({ rows: [{ exists: true }] }); // self_improvement_jobs
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

    // assertRuntimeTablesReady — all tables exist
    mockQuery
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
      .mockResolvedValueOnce({ rows: [{ filename: '003_agent_memory.sql' }] }); // SELECT applied

    // For assertAppliedMigrationExpectations: 003_agent_memory.sql expects 'agent_memory'
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] }); // agent_memory exists

    mockReaddirSync.mockReturnValue(['003_agent_memory.sql']);

    // assertRuntimeTablesReady
    mockQuery
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
      .mockResolvedValueOnce({ rows: [{ filename: '003_agent_memory.sql' }] }); // SELECT applied

    // assertAppliedMigrationExpectations: 003_agent_memory.sql expects 'agent_memory' — missing!
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }] }); // agent_memory missing

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

    // assertRuntimeTablesReady: agent_memory missing
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: false }] }) // agent_memory missing
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

    // assertRuntimeTablesReady
    mockQuery
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
      });

    // assertAppliedMigrationExpectations checks: agent_memory, agent_activity_log
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // agent_memory
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // agent_activity_log
      .mockResolvedValueOnce({ rows: [{ exists: true }] }); // self_improvement_jobs

    mockReaddirSync.mockReturnValue([]);

    // assertRuntimeTablesReady
    mockQuery
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
