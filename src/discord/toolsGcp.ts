import { execFileSync } from 'child_process';
import { errMsg } from '../utils/errors';
import fs from 'fs';
import path from 'path';
import { buildGcpSafeEnv } from './envSandbox';

const DEFAULT_REPO_ROOT = fs.existsSync('/app/package.json')
  ? '/app'
  : path.resolve(__dirname, '..', '..');
const REPO_ROOT = process.env.AGENT_REPO_ROOT
  ? path.resolve(process.env.AGENT_REPO_ROOT)
  : DEFAULT_REPO_ROOT;

export const GCP_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.GCS_PROJECT_ID ||
  'asap-489910';
export const GCP_REGION = process.env.CLOUD_RUN_REGION || 'australia-southeast1';
export const GCP_SERVICE = process.env.CLOUD_RUN_SERVICE || 'asap';
export const GCP_TIMEOUT = 120_000;

export const GCP_SQL_INSTANCE = 'asap-db';
export const GCP_BOT_VM = 'asap-bot-vm';
export const GCP_BOT_ZONE = 'australia-southeast1-c';

/** Safe command prefixes allowed to run on the GCE VM via gcp_vm_ssh */
export const VM_ALLOWED_PREFIXES = [
  'pm2 status', 'pm2 restart', 'pm2 logs', 'pm2 list',
  'git pull', 'git log', 'git status', 'git rev-parse', 'git fetch',
  'npm run build', 'npm ci', 'npm install',
  'node --version',
  'df -h', 'free -h', 'uptime', 'cat /proc/loadavg',
];

/**
 * Execute a gcloud command with argument array (no shell interpolation).
 * Uses execFileSync to prevent shell injection.
 */
export function gcpExecArgs(args: string[]): string {
  try {
    return execFileSync('gcloud', args, {
      cwd: REPO_ROOT,
      timeout: GCP_TIMEOUT,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      env: buildGcpSafeEnv(),
    }).trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error((e.stderr || e.stdout || e.message || 'Command failed').trim().slice(0, 2000));
  }
}

export async function gcpDeploy(tag?: string): Promise<string> {
  const built = await gcpBuildImage(tag);
  if (!built.startsWith('✅')) return built;
  const imageMatch = built.match(/Image:\s*(\S+)/);
  const imageRef = imageMatch?.[1];
  if (!imageRef) return `❌ Deploy failed: built image reference was not returned.`;

  try {
    gcpExecArgs([
      'run', 'deploy', GCP_SERVICE,
      `--image=${imageRef}`, `--project=${GCP_PROJECT}`, `--region=${GCP_REGION}`,
      '--platform=managed', '--quiet',
    ]);
    const status = gcpExecArgs([
      'run', 'services', 'describe', GCP_SERVICE,
      `--region=${GCP_REGION}`, `--project=${GCP_PROJECT}`,
      '--format=yaml(status.url,status.latestReadyRevisionName,status.traffic)',
    ]);
    return `✅ Deployed ${imageRef} to Cloud Run service ${GCP_SERVICE}.\n\n${status}`;
  } catch (err) {
    return `❌ Deploy failed after image build (${imageRef}): ${errMsg(err)}`;
  }
}

export async function gcpBuildImage(tag?: string): Promise<string> {
  const nowTag = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const safeTag = tag ? tag.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 50) : `agent-${nowTag}`;
  const imageRef = `gcr.io/${GCP_PROJECT}/${GCP_SERVICE}:${safeTag}`;

  try {
    const result = gcpExecArgs([
      'builds', 'submit',
      `--project=${GCP_PROJECT}`, `--region=${GCP_REGION}`,
      `--tag=${imageRef}`, '--timeout=600',
    ]);
    return `✅ Built and pushed image.\nImage: ${imageRef}\n\n${result.slice(-1000)}`;
  } catch (err) {
    return `❌ Image build failed: ${errMsg(err)}`;
  }
}

export async function gcpPreflight(): Promise<string> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const runCheck = (name: string, args: string[], required = true) => {
    try {
      const out = gcpExecArgs(args);
      checks.push({ name, ok: true, detail: out.split('\n')[0] || 'ok' });
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : 'Unknown error';
      checks.push({ name, ok: !required, detail: required ? detail : `Optional check failed: ${detail}` });
    }
  };

  runCheck('gcloud available', ['--version']);
  runCheck('active project', ['config', 'get-value', 'project']);
  runCheck('authenticated account', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  runCheck('Cloud Run API', ['services', 'list', '--enabled', `--project=${GCP_PROJECT}`, '--filter=name:run.googleapis.com', '--format=value(name)']);
  runCheck('Cloud Build API', ['services', 'list', '--enabled', `--project=${GCP_PROJECT}`, '--filter=name:cloudbuild.googleapis.com', '--format=value(name)']);
  runCheck('Secret Manager API', ['services', 'list', '--enabled', `--project=${GCP_PROJECT}`, '--filter=name:secretmanager.googleapis.com', '--format=value(name)']);
  runCheck('Cloud Run service', ['run', 'services', 'describe', GCP_SERVICE, `--project=${GCP_PROJECT}`, `--region=${GCP_REGION}`, '--format=value(status.url)']);

  const failed = checks.filter((c) => !c.ok);
  const lines = checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail || 'ok'}`);
  lines.unshift(`Project: ${GCP_PROJECT} | Region: ${GCP_REGION} | Service: ${GCP_SERVICE}`);
  lines.unshift(failed.length === 0 ? '✅ GCP preflight passed.' : `❌ GCP preflight failed (${failed.length} check${failed.length === 1 ? '' : 's'}).`);
  return lines.join('\n');
}

export async function gcpSetEnv(variables: string): Promise<string> {
  const safeVars = variables
    .split(',')
    .map(v => v.trim())
    .filter(v => /^[A-Z_][A-Z0-9_]*=.+$/.test(v))
    .join(',');
  if (!safeVars) return 'Invalid format. Use KEY=VALUE pairs separated by commas.';

  try {
    execFileSync('gcloud', [
      'run', 'services', 'update', GCP_SERVICE,
      `--project=${GCP_PROJECT}`,
      `--region=${GCP_REGION}`,
      `--update-env-vars=${safeVars}`,
    ], {
      cwd: REPO_ROOT,
      timeout: GCP_TIMEOUT,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      env: buildGcpSafeEnv(),
    }).trim();
    return `✅ Environment variables updated: ${safeVars.replace(/=.*/g, '=***').split(',').join(', ')}`;
  } catch (err) {
    return `❌ Failed to update env vars: ${errMsg(err)}`;
  }
}

export async function gcpGetEnv(): Promise<string> {
  try {
    const result = gcpExecArgs([
      'run', 'services', 'describe', GCP_SERVICE,
      `--project=${GCP_PROJECT}`, `--region=${GCP_REGION}`,
      '--format=yaml(spec.template.spec.containers[0].env)',
    ]);
    return result || 'No environment variables set.';
  } catch (err) {
    return `❌ Failed to get env vars: ${errMsg(err)}`;
  }
}

export async function gcpListRevisions(limit: number): Promise<string> {
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  try {
    const result = gcpExecArgs([
      'run', 'revisions', 'list',
      `--service=${GCP_SERVICE}`, `--project=${GCP_PROJECT}`, `--region=${GCP_REGION}`,
      `--limit=${safeLimit}`,
      '--format=table(name,active,creationTimestamp.date(),status.conditions[0].type)',
    ]);
    return result || 'No revisions found.';
  } catch (err) {
    return `❌ Failed to list revisions: ${errMsg(err)}`;
  }
}

export async function gcpRollback(revision: string): Promise<string> {
  const safeRevision = revision.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100);
  if (!safeRevision) return 'Invalid revision name.';

  try {
    gcpExecArgs([
      'run', 'services', 'update-traffic', GCP_SERVICE,
      `--project=${GCP_PROJECT}`, `--region=${GCP_REGION}`,
      `--to-revisions=${safeRevision}=100`,
    ]);
    return `✅ Rolled back to revision: ${safeRevision}`;
  } catch (err) {
    return `❌ Rollback failed: ${errMsg(err)}`;
  }
}

export async function gcpSecretSet(name: string, value: string): Promise<string> {
  const safeName = name.replace(/[^A-Z0-9_-]/gi, '').slice(0, 100);
  if (!safeName) return 'Invalid secret name. Use alphanumeric characters, hyphens, and underscores.';

  try {
    let exists = false;
    try {
      gcpExecArgs(['secrets', 'describe', safeName, `--project=${GCP_PROJECT}`]);
      exists = true;
    } catch { /* doesn't exist */ }

    const args = exists
      ? ['secrets', 'versions', 'add', safeName, `--project=${GCP_PROJECT}`, '--data-file=-']
      : ['secrets', 'create', safeName, `--project=${GCP_PROJECT}`, '--data-file=-'];

    execFileSync('gcloud', args, {
      cwd: REPO_ROOT,
      timeout: GCP_TIMEOUT,
      encoding: 'utf-8',
      input: value,
      env: buildGcpSafeEnv(),
    });

    return `✅ Secret "${safeName}" set successfully in Secret Manager. Bind it to Cloud Run with gcp_secret_bind if the app should consume it.`;
  } catch (err) {
    return `❌ Failed to set secret: ${errMsg(err)}`;
  }
}

export async function gcpSecretBind(bindings: string): Promise<string> {
  const normalized = bindings
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (normalized.length === 0) {
    return '❌ Invalid bindings. Use comma-separated ENV_VAR=SECRET_NAME[:VERSION] pairs.';
  }

  const parsed: string[] = [];
  for (const item of normalized) {
    const match = item.match(/^([A-Z_][A-Z0-9_]*)=([A-Za-z0-9_-]+)(?::([A-Za-z0-9._-]+))?$/);
    if (!match) {
      return `❌ Invalid binding "${item}". Expected ENV_VAR=SECRET_NAME[:VERSION].`;
    }
    const [, envVar, secretName, version] = match;
    parsed.push(`${envVar}=${secretName}:${version || 'latest'}`);
  }

  try {
    gcpExecArgs([
      'run', 'services', 'update', GCP_SERVICE,
      `--project=${GCP_PROJECT}`, `--region=${GCP_REGION}`,
      `--update-secrets=${parsed.join(',')}`,
    ]);
    return `✅ Bound ${parsed.length} secret mapping${parsed.length === 1 ? '' : 's'} to Cloud Run service ${GCP_SERVICE}: ${parsed.join(', ')}`;
  } catch (err) {
    return `❌ Failed to bind secrets: ${errMsg(err)}`;
  }
}

export async function gcpSecretList(): Promise<string> {
  try {
    const result = gcpExecArgs([
      'secrets', 'list', `--project=${GCP_PROJECT}`,
      '--format=table(name,createTime.date(),replication.automatic)',
    ]);
    return result || 'No secrets found.';
  } catch (err) {
    return `❌ Failed to list secrets: ${errMsg(err)}`;
  }
}

export async function gcpBuildStatus(limit: number): Promise<string> {
  const safeLimit = Math.min(Math.max(limit, 1), 20);
  try {
    const result = gcpExecArgs([
      'builds', 'list',
      `--project=${GCP_PROJECT}`, `--region=${GCP_REGION}`,
      `--limit=${safeLimit}`,
      '--format=table(id.slice(0:8),status,createTime.date(),duration,source.storageSource.bucket)',
    ]);
    return result || 'No builds found.';
  } catch (err) {
    return `❌ Failed to get build status: ${errMsg(err)}`;
  }
}

export async function gcpLogsQuery(filter: string, limit: number): Promise<string> {
  const safeLimit = Math.min(Math.max(limit || 50, 1), 200);
  try {
    const result = gcpExecArgs([
      'logging', 'read', filter,
      `--project=${GCP_PROJECT}`, `--limit=${safeLimit}`,
      '--format=table(timestamp.date(),resource.type,severity,textPayload.slice(0:120))',
    ]);
    return result || 'No log entries matched.';
  } catch (err) {
    return `❌ Failed to query logs: ${errMsg(err)}`;
  }
}

export async function gcpRunDescribe(): Promise<string> {
  try {
    const result = gcpExecArgs([
      'run', 'services', 'describe', GCP_SERVICE,
      `--region=${GCP_REGION}`, `--project=${GCP_PROJECT}`,
      '--format=yaml(status.url,status.conditions,status.traffic,spec.template.metadata.name,spec.template.spec.containers[0].resources)',
    ]);
    return result || 'No service info returned.';
  } catch (err) {
    return `❌ Failed to describe Cloud Run service: ${errMsg(err)}`;
  }
}

export async function gcpStorageLs(bucket: string, prefix?: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/i.test(bucket)) return '❌ Invalid bucket name.';
  if (prefix && !/^[a-zA-Z0-9_./-]+$/.test(prefix)) return '❌ Invalid prefix.';
  const p = prefix ? `gs://${bucket}/${prefix}` : `gs://${bucket}/`;
  try {
    const result = gcpExecArgs(['storage', 'ls', p]);
    return result || 'Empty bucket or prefix.';
  } catch (err) {
    return `❌ Failed to list bucket: ${errMsg(err)}`;
  }
}

export async function gcpArtifactList(limit: number): Promise<string> {
  const safeLimit = Math.min(Math.max(limit || 20, 1), 100);
  try {
    const result = gcpExecArgs([
      'artifacts', 'docker', 'images', 'list',
      `${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/asap`,
      '--include-tags', `--limit=${safeLimit}`,
      '--sort-by=~create_time',
      '--format=table(package.basename(),tags,create_time.date())',
    ]);
    return result || 'No images found.';
  } catch (err) {
    return `❌ Failed to list artifacts: ${errMsg(err)}`;
  }
}

export async function gcpSqlDescribe(): Promise<string> {
  try {
    const result = gcpExecArgs([
      'sql', 'instances', 'describe', GCP_SQL_INSTANCE,
      `--project=${GCP_PROJECT}`,
      '--format=table(name,state,databaseVersion,settings.tier,ipAddresses[0].ipAddress,connectionName)',
    ]);
    return result || 'No SQL instance info returned.';
  } catch (err) {
    return `❌ Failed to describe Cloud SQL: ${errMsg(err)}`;
  }
}

export async function gcpVmSsh(command: string): Promise<string> {
  const trimmed = command.trim();
  const allowed = VM_ALLOWED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  if (!allowed) {
    return `❌ Command not in VM allowlist. Allowed: pm2 status/restart/logs/list, git pull/log/status/rev-parse/fetch, npm run build/ci/install, node --version, df -h, free -h, uptime.`;
  }
  if (/[;&|`$<>()\n\\]/.test(trimmed)) {
    return '❌ Command contains disallowed characters.';
  }
  try {
    const result = gcpExecArgs([
      'compute', 'ssh', GCP_BOT_VM,
      `--zone=${GCP_BOT_ZONE}`, `--project=${GCP_PROJECT}`,
      '--quiet', `--command=${trimmed}`,
    ]);
    return result || '(no output)';
  } catch (err) {
    return `❌ SSH command failed: ${errMsg(err)}`;
  }
}

export async function gcpProjectInfo(): Promise<string> {
  try {
    const info = gcpExecArgs([
      'projects', 'describe', GCP_PROJECT,
      '--format=yaml(name,projectId,projectNumber,lifecycleState)',
    ]);
    const apis = gcpExecArgs([
      'services', 'list', '--enabled', `--project=${GCP_PROJECT}`,
      '--format=table(name,title)', '--limit=60',
    ]);
    return `## Project\n${info}\n\n## Enabled APIs\n${apis}`;
  } catch (err) {
    return `❌ Failed to get project info: ${errMsg(err)}`;
  }
}
