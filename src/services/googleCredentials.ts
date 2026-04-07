import { execFileSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import os from 'os';
import path from 'path';
import { GoogleAuth } from 'google-auth-library';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCS_PROJECT_ID || '';
const SECRET_SCOPE = ['https://www.googleapis.com/auth/cloud-platform'];

let bootstrappedPath: string | null = null;
let bootstrapAttempted = false;

function maybeParseJsonPayload(raw: string): string | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  // Direct JSON payload.
  if (trimmed.startsWith('{')) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return null;
    }
  }

  // Base64 payload.
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
    if (!decoded.startsWith('{')) return null;
    JSON.parse(decoded);
    return decoded;
  } catch {
    return null;
  }
}

function writeCredentialFile(jsonText: string): string {
  const dir = path.join(os.tmpdir(), 'asap-gcp');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `adc-${process.pid}.json`);
  writeFileSync(filePath, jsonText, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
  }
  process.env.GOOGLE_APPLICATION_CREDENTIALS = filePath;
  bootstrappedPath = filePath;
  return filePath;
}

function hasUsableCredentialFile(): boolean {
  const envPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (!envPath) return false;
  return existsSync(envPath);
}

async function readSecretViaGoogleAuthAsync(projectId: string, secretName: string): Promise<string> {
  const auth = new GoogleAuth({ scopes: SECRET_SCOPE });
  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
  if (!token) throw new Error('No access token available for Secret Manager read');

  const endpoint = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(secretName)}/versions/latest:access`;
  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Secret Manager HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { payload?: { data?: string } };
  const encoded = data.payload?.data;
  if (!encoded) throw new Error(`Secret ${secretName} has no payload`);
  return Buffer.from(encoded, 'base64').toString('utf8').trim();
}

function readSecretViaGcloud(projectId: string, secretName: string): string {
  return execFileSync(
    'gcloud',
    ['secrets', 'versions', 'access', 'latest', '--secret', secretName, '--project', projectId, '--quiet'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
      },
    }
  ).trim();
}

export function getAccessTokenViaGcloud(): string | null {
  try {
    const token = execFileSync(
      'gcloud',
      ['auth', 'print-access-token', '--quiet'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
        },
      }
    ).trim();
    return token || null;
  } catch {
    return null;
  }
}

function isMissingAdcError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  return msg.toLowerCase().includes('could not load the default credentials');
}

function resolveCredentialSecretCandidates(): string[] {
  return [
    process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET_NAME,
    process.env.GOOGLE_APPLICATION_CREDENTIALS_SECRET,
    process.env.VERTEX_SERVICE_ACCOUNT_SECRET_NAME,
    process.env.GCP_VERTEX_SA_SECRET_NAME,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

export async function ensureGoogleCredentials(projectIdOverride?: string): Promise<boolean> {
  if (hasUsableCredentialFile()) return true;

  const inlineJson = maybeParseJsonPayload(String(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || ''));
  if (inlineJson) {
    writeCredentialFile(inlineJson);
    return true;
  }

  const inlineBase64 = maybeParseJsonPayload(String(process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64 || ''));
  if (inlineBase64) {
    writeCredentialFile(inlineBase64);
    return true;
  }

  const projectId = String(projectIdOverride || PROJECT_ID || '').trim();
  const candidates = resolveCredentialSecretCandidates();
  if (!projectId || candidates.length === 0) {
    bootstrapAttempted = true;
    return false;
  }

  for (const secretName of candidates) {
    try {
      const viaAuth = await readSecretViaGoogleAuthAsync(projectId, secretName);
      const payload = maybeParseJsonPayload(viaAuth);
      if (!payload) continue;
      writeCredentialFile(payload);
      return true;
    } catch (err) {
      if (!isMissingAdcError(err)) {
        continue;
      }
      try {
        const viaCli = readSecretViaGcloud(projectId, secretName);
        const payload = maybeParseJsonPayload(viaCli);
        if (!payload) continue;
        writeCredentialFile(payload);
        return true;
      } catch {
      }
    }
  }

  bootstrapAttempted = true;
  return false;
}

export function getGoogleCredentialBootstrapState(): { attempted: boolean; path: string | null } {
  return {
    attempted: bootstrapAttempted,
    path: bootstrappedPath,
  };
}
