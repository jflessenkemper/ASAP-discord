import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pool from './pool';

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

  console.log(`Migrations complete. ${appliedCount} new, ${applied.size} previously applied.`);
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
