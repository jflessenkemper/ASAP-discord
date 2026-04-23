/**
 * Postgres advisory-lock helper. Ensures exclusive execution of a named
 * critical section across process instances that share the same DB.
 *
 * Key hashing via pg's hashtext() so human-readable keys are safe (no need
 * to compute a bigint client-side).
 *
 * Previously duplicated in handlers/callSession.ts + handlers/groupchat.ts.
 */

import pool from '../db/pool';

export async function withPgAdvisoryLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
    client.release();
  }
}
