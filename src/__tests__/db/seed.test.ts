const mockQuery = jest.fn();
const mockEnd = jest.fn();

jest.mock('dotenv/config', () => ({}));
jest.mock('../../db/pool', () => ({
  default: { query: mockQuery, end: mockEnd },
  __esModule: true,
}));
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));

describe('seed', () => {
  const origExit = process.exit;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockEnd.mockResolvedValue(undefined);
    process.exit = jest.fn() as never;
  });

  afterEach(() => {
    process.exit = origExit;
  });

  it('inserts employee when not found', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    await import('../../db/seed');
    await new Promise((r) => setTimeout(r, 100));

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toContain('INSERT INTO employees');
    expect(mockEnd).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Seeded test employee'));
    logSpy.mockRestore();
  });

  it('skips insert when employee already exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    await import('../../db/seed');
    await new Promise((r) => setTimeout(r, 100));

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    logSpy.mockRestore();
  });

  it('exits with code 1 on error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));

    const errSpy = jest.spyOn(console, 'error').mockImplementation();
    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    await import('../../db/seed');
    await new Promise((r) => setTimeout(r, 100));

    expect(errSpy).toHaveBeenCalledWith('Seed failed:', expect.any(Error));
    expect(process.exit).toHaveBeenCalledWith(1);
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});
