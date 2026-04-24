import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import pool from './pool';
import { REQUIRED_RUNTIME_TABLES, TABLE_EXPECTATIONS_BY_MIGRATION } from './runtimeSchema';

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

const BASELINE_FILENAME = '000_baseline.sql';

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

  // Baseline handling: the squashed 000_baseline.sql represents the cumulative
  // effect of legacy migrations 001–020. On an existing DB those rows are
  // already in applied_migrations, so we mark the baseline as applied
  // without running its SQL (which contains non-idempotent ALTER TABLE
  // ADD CONSTRAINT statements). On a fresh DB the baseline runs normally
  // and creates the core schema in one shot.
  if (!applied.has(BASELINE_FILENAME) && applied.size > 0) {
    console.log(`  ⏭ ${BASELINE_FILENAME} (marking applied — DB predates squash)`);
    await pool.query(
      'INSERT INTO applied_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
      [BASELINE_FILENAME],
    );
    applied.add(BASELINE_FILENAME);
  }

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
