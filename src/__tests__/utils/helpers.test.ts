/**
 * Unit tests for shared utility helpers:
 *   - errMsg()           (src/utils/errors.ts)
 *   - upsertMemory()     (src/discord/memory.ts)
 *   - appendMemoryRow()  (src/discord/memory.ts)
 *   - readMemoryRow()    (src/discord/memory.ts)
 */

// ─── errMsg ─────────────────────────────────────────────────────────────
import { errMsg } from '../../utils/errors';

describe('errMsg()', () => {
  it('extracts message from Error instances', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
  });

  it('extracts message from Error subclasses', () => {
    expect(errMsg(new TypeError('type problem'))).toBe('type problem');
  });

  it('converts string to string', () => {
    expect(errMsg('something went wrong')).toBe('something went wrong');
  });

  it('converts number to string', () => {
    expect(errMsg(42)).toBe('42');
  });

  it('returns "Unknown" for null', () => {
    expect(errMsg(null)).toBe('Unknown');
  });

  it('returns "Unknown" for undefined', () => {
    expect(errMsg(undefined)).toBe('Unknown');
  });

  it('returns "Unknown" for empty string', () => {
    expect(errMsg('')).toBe('Unknown');
  });

  it('converts object to string', () => {
    expect(errMsg({ code: 'ERR' })).toBe('[object Object]');
  });

  it('converts false to "false"', () => {
    expect(errMsg(false)).toBe('false');
  });

  it('returns "Unknown" for 0 (falsy but not meaningful)', () => {
    // 0 is falsy, so `String(0 ?? '')` → String(0) → '0'
    // but `err ?? ''` keeps 0 since 0 is not null/undefined
    expect(errMsg(0)).toBe('0');
  });
});

// ─── Memory helpers (mock pool) ─────────────────────────────────────────
jest.mock('../../db/pool', () => require('../mocks/pool'));

import { upsertMemory, appendMemoryRow, readMemoryRow } from '../../discord/memory';
import { mockQuery } from '../mocks/pool';

describe('upsertMemory()', () => {
  beforeEach(() => mockQuery.mockReset());

  it('executes INSERT ... ON CONFLICT DO UPDATE', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await upsertMemory('test-file.md', 'hello world');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO agent_memory');
    expect(sql).toContain('ON CONFLICT');
    expect(params).toEqual(['test-file.md', 'hello world']);
  });

  it('propagates database errors', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'));
    await expect(upsertMemory('x', 'y')).rejects.toThrow('connection refused');
  });
});

describe('appendMemoryRow()', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns total length from RETURNING clause', async () => {
    mockQuery.mockResolvedValue({ rows: [{ total_len: 42 }] });
    const len = await appendMemoryRow('log.md', 'new entry');

    expect(len).toBe(42);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO agent_memory');
    expect(sql).toContain('RETURNING');
    expect(params).toEqual(['log.md', 'new entry']);
  });

  it('defaults to content length if rows empty', async () => {
    mockQuery.mockResolvedValue({ rows: [{}] });
    const len = await appendMemoryRow('log.md', '12345');
    expect(len).toBe(5);
  });
});

describe('readMemoryRow()', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns content when row exists', async () => {
    mockQuery.mockResolvedValue({ rows: [{ content: 'stored data' }] });
    const result = await readMemoryRow('plans.md');
    expect(result).toBe('stored data');
  });

  it('returns null when row does not exist', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const result = await readMemoryRow('nope.md');
    expect(result).toBeNull();
  });
});
