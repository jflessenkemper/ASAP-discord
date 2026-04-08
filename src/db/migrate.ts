import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import pool from './pool';

const TABLE_EXPECTATIONS_BY_MIGRATION: Record<string, string[]> = {
  '001_initial.sql': ['clients', 'employees', 'jobs', 'sessions'],
  '003_agent_memory.sql': ['agent_memory'],
  '015_agent_activity_log.sql': ['agent_activity_log'],
};

const REQUIRED_RUNTIME_TABLES = ['sessions', 'agent_memory', 'agent_activity_log'];

async function getMissingTables(tables: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const table of tables) {
    const res = await pool.query(
      `SELECT to_regclass($1) IS NOT NULL AS exists`,
      [`public.${table}`]
    );
    if (!res.rows?.[0]?.exists) {
      missing.push(table);
    }
  }
  return missing;
}

async function assertAppliedMigrationExpectations(applied: Set<string>): Promise<void> {
  for (const [filename, expectedTables] of Object.entries(TABLE_EXPECTATIONS_BY_MIGRATION)) {
    if (!applied.has(filename)) continue;
    const missing = await getMissingTables(expectedTables);
    if (missing.length > 0) {
      throw new Error(
        `Migration drift detected: ${filename} is marked applied but missing table(s): ${missing.join(', ')}.`
        + ' Restore schema before continuing (run DB repair or manual CREATE TABLE statements), then re-run migrations.'
      );
    }
  }
}

async function assertRuntimeTablesReady(): Promise<void> {
  const missing = await getMissingTables(REQUIRED_RUNTIME_TABLES);
  if (missing.length > 0) {
    throw new Error(
      `Runtime schema incomplete after migration. Missing table(s): ${missing.join(', ')}.`
      + ' Bot runtime may fail until these are created.'
    );
  }
}

async function migrate() {
  // Create tracking table if it doesn't exist (safe for first run)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  // Get already-applied migrations
  const appliedResult = await pool.query('SELECT filename FROM applied_migrations');
  const applied = new Set(appliedResult.rows.map((r: { filename: string }) => r.filename));

  // Detect historical drift before running new migrations.
  await assertAppliedMigrationExpectations(applied);

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  ⏭ ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    console.log(`Running migration: ${file}`);
    // Wrap migration + tracking in a transaction so they succeed or fail atomically.
    // If the process crashes between SQL and INSERT, re-running won't skip a half-applied migration.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO applied_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  ✓ ${file} applied`);
      appliedCount++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  await assertRuntimeTablesReady();

  console.log(`Migrations complete. ${appliedCount} new, ${applied.size} previously applied.`);
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
