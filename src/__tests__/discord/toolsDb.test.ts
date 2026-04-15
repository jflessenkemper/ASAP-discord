/**
 * Tests for src/discord/toolsDb.ts
 * SQL validation, DDL blocking, query execution.
 */

const mockQuery = jest.fn();
jest.mock('../../db/pool', () => ({
  default: { query: mockQuery },
  __esModule: true,
}));

import { DDL_PATTERN, sanitizeSql, isReadOnlySql, dbQuery, dbQueryReadonly, dbSchema } from '../../discord/toolsDb';

describe('toolsDb', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('DDL_PATTERN', () => {
    it('matches DROP', () => {
      expect(DDL_PATTERN.test('DROP TABLE users')).toBe(true);
    });

    it('matches TRUNCATE', () => {
      expect(DDL_PATTERN.test('TRUNCATE users')).toBe(true);
    });

    it('matches ALTER', () => {
      expect(DDL_PATTERN.test('ALTER TABLE users ADD COLUMN name text')).toBe(true);
    });

    it('matches CREATE', () => {
      expect(DDL_PATTERN.test('CREATE TABLE test (id int)')).toBe(true);
    });

    it('matches GRANT', () => {
      expect(DDL_PATTERN.test('GRANT SELECT ON users TO app')).toBe(true);
    });

    it('matches REVOKE', () => {
      expect(DDL_PATTERN.test('REVOKE ALL ON users FROM app')).toBe(true);
    });

    it('matches VACUUM', () => {
      expect(DDL_PATTERN.test('VACUUM users')).toBe(true);
    });

    it('matches REINDEX', () => {
      expect(DDL_PATTERN.test('REINDEX TABLE users')).toBe(true);
    });

    it('does not match SELECT', () => {
      expect(DDL_PATTERN.test('SELECT * FROM users')).toBe(false);
    });

    it('does not match INSERT', () => {
      expect(DDL_PATTERN.test('INSERT INTO users VALUES (1)')).toBe(false);
    });
  });

  describe('sanitizeSql()', () => {
    it('strips single-line comments', () => {
      expect(sanitizeSql('SELECT 1 -- comment')).toBe('SELECT 1');
    });

    it('strips multi-line comments', () => {
      expect(sanitizeSql('SELECT /* drop table */ 1')).toBe('SELECT  1');
    });

    it('trims whitespace', () => {
      expect(sanitizeSql('  SELECT 1  ')).toBe('SELECT 1');
    });
  });

  describe('isReadOnlySql()', () => {
    it('allows SELECT', () => {
      expect(isReadOnlySql('SELECT * FROM users')).toBe(true);
    });

    it('allows WITH (CTE)', () => {
      expect(isReadOnlySql('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true);
    });

    it('allows EXPLAIN', () => {
      expect(isReadOnlySql('EXPLAIN SELECT 1')).toBe(true);
    });

    it('allows SHOW', () => {
      expect(isReadOnlySql('SHOW search_path')).toBe(true);
    });

    it('blocks INSERT', () => {
      expect(isReadOnlySql('INSERT INTO users VALUES (1)')).toBe(false);
    });

    it('blocks UPDATE', () => {
      expect(isReadOnlySql('UPDATE users SET name = $1')).toBe(false);
    });

    it('blocks DELETE', () => {
      expect(isReadOnlySql('DELETE FROM users')).toBe(false);
    });

    it('blocks multiple statements', () => {
      expect(isReadOnlySql('SELECT 1; DROP TABLE users')).toBe(false);
    });

    it('blocks EXPLAIN ANALYZE', () => {
      expect(isReadOnlySql('EXPLAIN ANALYZE SELECT 1')).toBe(false);
    });

    it('blocks empty string', () => {
      expect(isReadOnlySql('')).toBe(false);
    });

    it('strips comments before checking', () => {
      expect(isReadOnlySql('SELECT 1 -- DROP TABLE')).toBe(true);
    });
  });

  describe('dbQuery()', () => {
    it('executes query and returns formatted results', async () => {
      mockQuery.mockResolvedValueOnce({
        command: 'SELECT',
        rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
        rowCount: 2,
      });
      const result = await dbQuery('SELECT * FROM users');
      expect(result).toContain('2 row(s) returned');
      expect(result).toContain('Alice');
      expect(result).toContain('Bob');
    });

    it('reports 0 rows for empty result', async () => {
      mockQuery.mockResolvedValueOnce({
        command: 'SELECT',
        rows: [],
        rowCount: 0,
      });
      const result = await dbQuery('SELECT * FROM users WHERE id = 999');
      expect(result).toContain('0 rows');
    });

    it('reports affected rows for mutations', async () => {
      mockQuery.mockResolvedValueOnce({
        command: 'UPDATE',
        rows: [],
        rowCount: 3,
      });
      const result = await dbQuery('UPDATE users SET active = true');
      expect(result).toContain('UPDATE');
      expect(result).toContain('3 row(s) affected');
    });

    it('blocks DDL statements', async () => {
      const result = await dbQuery('DROP TABLE users');
      expect(result).toContain('Blocked');
      expect(result).toContain('DDL');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('parses JSON params', async () => {
      mockQuery.mockResolvedValueOnce({
        command: 'SELECT',
        rows: [{ id: 1 }],
        rowCount: 1,
      });
      await dbQuery('SELECT * FROM users WHERE id = $1', '[1]');
      expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', [1]);
    });

    it('returns error for invalid JSON params', async () => {
      const result = await dbQuery('SELECT 1', 'not-json');
      expect(result).toContain('Error');
      expect(result).toContain('JSON');
    });

    it('handles SQL errors gracefully', async () => {
      mockQuery.mockRejectedValueOnce(new Error('relation "missing" does not exist'));
      const result = await dbQuery('SELECT * FROM missing');
      expect(result).toContain('SQL Error');
      expect(result).toContain('does not exist');
    });

    it('truncates long cell values', async () => {
      mockQuery.mockResolvedValueOnce({
        command: 'SELECT',
        rows: [{ data: 'x'.repeat(200) }],
        rowCount: 1,
      });
      const result = await dbQuery('SELECT data FROM big_table');
      expect(result).toContain('1 row(s) returned');
      // Cell values are truncated to 100 chars
      expect(result.length).toBeLessThan(500);
    });

    it('caps output at 100 rows', async () => {
      const rows = Array.from({ length: 150 }, (_, i) => ({ id: i }));
      mockQuery.mockResolvedValueOnce({ command: 'SELECT', rows, rowCount: 150 });
      const result = await dbQuery('SELECT * FROM big');
      expect(result).toContain('150 row(s) returned');
      expect(result).toContain('and 50 more rows');
    });
  });

  describe('dbQueryReadonly()', () => {
    it('allows SELECT queries', async () => {
      mockQuery.mockResolvedValueOnce({ command: 'SELECT', rows: [], rowCount: 0 });
      const result = await dbQueryReadonly('SELECT 1');
      expect(result).toContain('0 rows');
    });

    it('blocks INSERT queries', async () => {
      const result = await dbQueryReadonly('INSERT INTO users VALUES (1)');
      expect(result).toContain('Blocked');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('blocks UPDATE queries', async () => {
      const result = await dbQueryReadonly('UPDATE users SET name = $1');
      expect(result).toContain('Blocked');
    });

    it('blocks DELETE queries', async () => {
      const result = await dbQueryReadonly('DELETE FROM users');
      expect(result).toContain('Blocked');
    });
  });

  describe('dbSchema()', () => {
    it('returns all tables when no table specified', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { table_name: 'users', columns: '5' },
          { table_name: 'jobs', columns: '10' },
        ],
      });
      const result = await dbSchema();
      expect(result).toContain('users');
      expect(result).toContain('jobs');
    });

    it('returns column details for specific table', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
            { column_name: 'name', data_type: 'text', is_nullable: 'YES', column_default: null },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            { constraint_type: 'PRIMARY KEY', column_name: 'id', references_table: null, references_column: null },
          ],
        });
      const result = await dbSchema('users');
      expect(result).toContain('Table: users');
      expect(result).toContain('id: integer');
      expect(result).toContain('name: text');
      expect(result).toContain('PRIMARY KEY');
    });

    it('handles non-existent table', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await dbSchema('nonexistent');
      expect(result).toContain('not found');
    });

    it('handles DB errors gracefully', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection error'));
      const result = await dbSchema('error_trigger_table');
      expect(result).toContain('Schema error');
    });

    it('sanitizes table name', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await dbSchema('users; DROP TABLE--');
      // The sanitized name should not contain SQL injection
      const callArgs = mockQuery.mock.calls[0][1];
      expect(callArgs[0]).toBe('usersDROPTABLE');
    });
  });
});
