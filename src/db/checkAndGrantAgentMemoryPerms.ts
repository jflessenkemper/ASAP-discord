import 'dotenv/config';
import { execFileSync } from 'node:child_process';

import { Pool } from 'pg';

import pool from './pool';
import { errMsg } from '../utils/errors';

const DEFAULT_TARGET_TABLES = ['agent_memory', 'discord_message_dedupe', 'agent_activity_log'];

function parseTargetTables(): string[] {
  const raw = String(process.env.DB_GRANT_TABLES || '').trim();
  if (!raw) return DEFAULT_TARGET_TABLES;
  const parsed = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_TARGET_TABLES;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function hasRequiredPerms(
  role: string,
  tableName: string
): Promise<{ selectOk: boolean; insertOk: boolean; updateOk: boolean; deleteOk: boolean }> {
  const tableRef = `public.${quoteIdentifier(tableName)}`;
  const roleLit = quoteLiteral(role);
  const sql = `
    SELECT
      has_table_privilege(${roleLit}, ${quoteLiteral(tableRef)}, 'SELECT') AS select_ok,
      has_table_privilege(${roleLit}, ${quoteLiteral(tableRef)}, 'INSERT') AS insert_ok,
      has_table_privilege(${roleLit}, ${quoteLiteral(tableRef)}, 'UPDATE') AS update_ok,
      has_table_privilege(${roleLit}, ${quoteLiteral(tableRef)}, 'DELETE') AS delete_ok
  `;
  const res = await pool.query(sql);
  const row = res.rows[0] || {};
  return {
    selectOk: !!row.select_ok,
    insertOk: !!row.insert_ok,
    updateOk: !!row.update_ok,
    deleteOk: !!row.delete_ok,
  };
}

async function tableExists(tableName: string): Promise<boolean> {
  const tableRef = `public.${quoteIdentifier(tableName)}`;
  const res = await pool.query(
    `SELECT to_regclass(${quoteLiteral(tableRef)}) IS NOT NULL AS exists`
  );
  return !!res.rows[0]?.exists;
}

function tryReadSecret(secretName: string, projectId?: string): string | null {
  try {
    const args = [
      'secrets',
      'versions',
      'access',
      'latest',
      '--secret',
      secretName,
      ...(projectId ? ['--project', projectId] : []),
    ];
    return execFileSync('gcloud', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || null;
  } catch {
    return null;
  }
}

function getAdminDatabaseUrl(): string | null {
  const fromEnv = String(process.env.DB_GRANT_DATABASE_URL || '').trim();
  if (fromEnv) return fromEnv;

  const secretName = String(process.env.DB_GRANT_DATABASE_URL_SECRET || '').trim();
  if (!secretName) return null;

  const projectId = String(process.env.DB_GRANT_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '').trim() || undefined;
  return tryReadSecret(secretName, projectId);
}

function stripSslParams(url: string): string {
  try {
    const parsed = new URL(url);
    ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl'].forEach((p) => parsed.searchParams.delete(p));
    return parsed.toString();
  } catch {
    return url;
  }
}

function isTlsCertError(err: unknown): boolean {
  const msg = errMsg(err);
  return /certificate|unable to verify the first certificate|self signed certificate|tls/i.test(msg);
}

async function grantPerms(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  role: string,
  tableNames: string[]
): Promise<void> {
  const roleIdent = quoteIdentifier(role);
  for (const tableName of tableNames) {
    const tableIdent = quoteIdentifier(tableName);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${tableIdent} TO ${roleIdent}`);
  }
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleIdent}`);
}

async function main(): Promise<void> {
  const who = await pool.query('SELECT current_user AS current_user');
  const currentUser = String(who.rows[0]?.current_user || '').trim();
  const targetRole = String(process.env.DB_GRANT_ROLE || currentUser).trim();

  if (!targetRole) {
    throw new Error('Could not resolve target role. Set DB_GRANT_ROLE explicitly.');
  }

  const targetTables = parseTargetTables();
  const existingTables: string[] = [];
  for (const tableName of targetTables) {
    if (await tableExists(tableName)) {
      existingTables.push(tableName);
    }
  }

  if (existingTables.length === 0) {
    console.error(`None of the target tables exist: ${targetTables.join(', ')}`);
    console.error('Run migrations first (npm run migrate).');
    process.exitCode = 1;
    return;
  }

  const beforeByTable: Record<string, { selectOk: boolean; insertOk: boolean; updateOk: boolean; deleteOk: boolean }> = {};
  for (const tableName of existingTables) {
    beforeByTable[tableName] = await hasRequiredPerms(targetRole, tableName);
  }
  const alreadyOk = existingTables.every((tableName) => {
    const perms = beforeByTable[tableName];
    return perms.selectOk && perms.insertOk && perms.updateOk && perms.deleteOk;
  });
  if (alreadyOk) {
    console.log(`Permissions already valid for role ${targetRole} on: ${existingTables.join(', ')}`);
    return;
  }

  console.log(`Missing permissions for role ${targetRole}:`, beforeByTable);
  try {
    await grantPerms(pool, targetRole, existingTables);
  } catch (err) {
    const adminUrl = getAdminDatabaseUrl();
    if (!adminUrl) {
      const msg = errMsg(err);
      console.error(`Automatic grant failed (${msg}).`);
      console.error('No privileged DB connection configured for fallback.');
      console.error('Set one of these and rerun:');
      console.error('- DB_GRANT_DATABASE_URL=postgresql://<owner-or-admin>@...');
      console.error('- DB_GRANT_DATABASE_URL_SECRET=<gcp-secret-name> (optional DB_GRANT_PROJECT_ID)');
      console.error('Run this as DB owner/admin if doing it manually:');
      for (const tableName of existingTables) {
        console.error(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${tableName} TO ${targetRole};`);
      }
      console.error(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${targetRole};`);
      process.exitCode = 1;
      return;
    }

    const sanitizedAdminUrl = stripSslParams(adminUrl);
    let fallbackGranted = false;
    let lastAdminError: unknown;

    const adminPool = new Pool({ connectionString: sanitizedAdminUrl });
    try {
      await grantPerms(adminPool, targetRole, existingTables);
      fallbackGranted = true;
    } catch (adminErr) {
      lastAdminError = adminErr;
    } finally {
      await adminPool.end();
    }

    if (!fallbackGranted && isTlsCertError(lastAdminError)) {
      const insecureAdminPool = new Pool({
        connectionString: sanitizedAdminUrl,
        ssl: { rejectUnauthorized: false },
      });
      try {
        await grantPerms(insecureAdminPool, targetRole, existingTables);
        fallbackGranted = true;
        console.warn('Fallback admin grant succeeded with rejectUnauthorized=false. Consider configuring DB CA trust for stricter TLS verification.');
      } catch (adminErr) {
        lastAdminError = adminErr;
      } finally {
        await insecureAdminPool.end();
      }
    }

    if (!fallbackGranted) {
      const msg = lastAdminError instanceof Error ? lastAdminError.message : String(lastAdminError);
      console.error(`Fallback admin grant failed (${msg}).`);
      console.error('Run this as DB owner/admin:');
      for (const tableName of existingTables) {
        console.error(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${tableName} TO ${targetRole};`);
      }
      console.error(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${targetRole};`);
      process.exitCode = 1;
      return;
    }

    console.log('Primary grant failed, but fallback admin grant succeeded.');
  }

  const afterByTable: Record<string, { selectOk: boolean; insertOk: boolean; updateOk: boolean; deleteOk: boolean }> = {};
  for (const tableName of existingTables) {
    afterByTable[tableName] = await hasRequiredPerms(targetRole, tableName);
  }
  const ok = existingTables.every((tableName) => {
    const perms = afterByTable[tableName];
    return perms.selectOk && perms.insertOk && perms.updateOk && perms.deleteOk;
  });
  if (ok) {
    console.log(`Permissions granted successfully for role ${targetRole} on: ${existingTables.join(', ')}`);
    return;
  }

  console.error(`Grant attempted but permissions are still incomplete for ${targetRole}:`, afterByTable);
  process.exitCode = 1;
}

void main()
  .catch((err) => {
    console.error(errMsg(err));
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
