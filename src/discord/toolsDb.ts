import { errMsg } from '../utils/errors';

type ToolCacheEntry = { result: string; expiresAt: number };

const DB_SCHEMA_CACHE_TTL_MS = Math.max(30_000, Number(process.env.DB_SCHEMA_CACHE_TTL_MS || '300000'));
const dbSchemaCache = new Map<string, ToolCacheEntry>();

const DDL_PATTERN = /\b(drop|truncate|alter|create|grant|revoke|vacuum|reindex)\b/i;

function sanitizeSql(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}

function isReadOnlySql(sql: string): boolean {
  const cleaned = sanitizeSql(sql).replace(/;\s*$/, '').trim().toLowerCase();
  if (!cleaned) return false;

  if (cleaned.includes(';')) return false;

  if (/^(select|with|explain|show)\b/.test(cleaned)) {
    if (/\b(insert|update|delete|alter|drop|create|truncate|grant|revoke|comment|vacuum|analyze|refresh|reindex|call|do|copy)\b/.test(cleaned)) {
      return false;
    }
    return true;
  }
  return false;
}

async function dbQuery(query: string, paramsStr?: string): Promise<string> {
  try {
    const cleaned = sanitizeSql(query);
    if (DDL_PATTERN.test(cleaned)) {
      return 'Blocked: db_query does not allow DDL/admin statements (DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE, VACUUM, REINDEX). Use SELECT, INSERT, UPDATE, or DELETE only.';
    }
    const pool = (await import('../db/pool')).default;
    let params: any[] = [];
    if (paramsStr) {
      try { params = JSON.parse(paramsStr); } catch { return 'Error: params must be a valid JSON array'; }
    }

    const result = await pool.query(query, params);

    if (result.command === 'SELECT' || result.rows?.length > 0) {
      const rows = result.rows || [];
      if (rows.length === 0) return 'Query returned 0 rows.';

      const cols = Object.keys(rows[0]);
      const header = cols.join(' | ');
      const separator = cols.map(() => '---').join(' | ');
      const body = rows.slice(0, 100).map((row: Record<string, any>) =>
        cols.map((c) => {
          const val = row[c];
          if (val === null) return 'NULL';
          if (typeof val === 'object') return JSON.stringify(val).slice(0, 100);
          return String(val).slice(0, 100);
        }).join(' | ')
      ).join('\n');

      const output = `${header}\n${separator}\n${body}`;
      const extra = rows.length > 100 ? `\n\n... and ${rows.length - 100} more rows` : '';
      return `${rows.length} row(s) returned:\n\n${output}${extra}`;
    }

    return `Query executed: ${result.command} — ${result.rowCount ?? 0} row(s) affected.`;
  } catch (err) {
    return `SQL Error: ${errMsg(err)}`;
  }
}

async function dbQueryReadonly(query: string, paramsStr?: string): Promise<string> {
  if (!isReadOnlySql(query)) {
    return 'Blocked: db_query_readonly only allows single-statement SELECT/WITH/EXPLAIN/SHOW queries with no write/mutation keywords.';
  }
  return dbQuery(query, paramsStr);
}

async function dbSchema(table?: string): Promise<string> {
  try {
    const cacheKey = String(table || '__all__').toLowerCase();
    const cached = dbSchemaCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return `${cached.result}\n\n(cache: hit)`;
    }

    const pool = (await import('../db/pool')).default;

    if (table) {
      const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '');
      const { rows } = await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`, [safeTable]
      );
      if (rows.length === 0) return `Table "${safeTable}" not found.`;

      const { rows: constraints } = await pool.query(
        `SELECT tc.constraint_type, kcu.column_name, ccu.table_name AS references_table, ccu.column_name AS references_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
         LEFT JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.constraint_type = 'FOREIGN KEY'
         WHERE tc.table_schema = 'public' AND tc.table_name = $1`, [safeTable]
      );

      const lines = rows.map((r: any) => {
        const nullable = r.is_nullable === 'YES' ? ' (nullable)' : '';
        const def = r.column_default ? ` default=${r.column_default}` : '';
        const constraint = constraints.find((c: any) => c.column_name === r.column_name);
        const cstr = constraint ? ` [${constraint.constraint_type}${constraint.references_table ? ` → ${constraint.references_table}.${constraint.references_column}` : ''}]` : '';
        return `  ${r.column_name}: ${r.data_type}${nullable}${def}${cstr}`;
      });

      const result = `Table: ${safeTable}\n${lines.join('\n')}`;
      dbSchemaCache.set(cacheKey, { result, expiresAt: Date.now() + DB_SCHEMA_CACHE_TTL_MS });
      return result;
    }

    const { rows } = await pool.query(
      `SELECT table_name, (SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS columns
       FROM information_schema.tables t
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );
    if (rows.length === 0) return 'No tables found in public schema.';
    const result = rows.map((r: any) => `📋 ${r.table_name} (${r.columns} columns)`).join('\n');
    dbSchemaCache.set(cacheKey, { result, expiresAt: Date.now() + DB_SCHEMA_CACHE_TTL_MS });
    return result;
  } catch (err) {
    return `Schema error: ${errMsg(err)}`;
  }
}

export { DDL_PATTERN, sanitizeSql, isReadOnlySql, dbQuery, dbQueryReadonly, dbSchema };
