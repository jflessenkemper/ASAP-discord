import { execFileSync } from 'child_process';

import { GoogleAuth } from 'google-auth-library';

import { ensureGoogleCredentials, getGoogleCredentialBootstrapState } from './googleCredentials';
import { errMsg } from '../utils/errors';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCS_PROJECT_ID || '';
const SECRET_SCOPE = ['https://www.googleapis.com/auth/cloud-platform'];
let secretManagerDisabled = false;
let missingAdcWarned = false;

function isSecretManagerEnabled(): boolean {
  const raw = String(process.env.RUNTIME_SECRET_MANAGER_ENABLED ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function isMissingAdcError(err: unknown): boolean {
  const msg = errMsg(err);
  return msg.toLowerCase().includes('could not load the default credentials');
}

function resolveSecretName(envVar: string): string {
  const override = process.env[`${envVar}_SECRET_NAME`];
  if (override && override.trim()) return override.trim();
  return envVar;
}

async function getAccessToken(): Promise<string> {
  const auth = new GoogleAuth({ scopes: SECRET_SCOPE });
  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
  if (!token) throw new Error('Failed to acquire Google access token for Secret Manager');
  return token;
}

async function readSecret(projectId: string, secretName: string): Promise<string> {
  try {
    const token = await getAccessToken();
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
      throw new Error(`Secret Manager HTTP ${res.status} for ${secretName}: ${body.slice(0, 120)}`);
    }

    const data = await res.json() as { payload?: { data?: string } };
    const encoded = data.payload?.data;
    if (!encoded) throw new Error(`Secret ${secretName} has no payload`);
    return Buffer.from(encoded, 'base64').toString('utf8').trim();
  } catch (err) {
    if (!isMissingAdcError(err)) throw err;
    try {
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
    } catch {
      throw err;
    }
  }
}

async function ensureEnvFromSecret(envVar: 'DEEPGRAM_API_KEY' | 'ELEVENLABS_API_KEY' | 'DISCORD_TEST_BOT_TOKEN' | 'GEMINI_API_KEY' | 'ANTHROPIC_API_KEY' | 'GITHUB_TOKEN' | 'ADZUNA_APP_ID' | 'ADZUNA_APP_KEY'): Promise<void> {
  if (process.env[envVar]) return;
  if (!PROJECT_ID) return;
  if (!isSecretManagerEnabled()) return;
  if (secretManagerDisabled) return;

  const secretName = resolveSecretName(envVar);
  try {
    const value = await readSecret(PROJECT_ID, secretName);
    if (!value) {
      console.warn(`Secret ${secretName} is empty; ${envVar} remains unset`);
      return;
    }
    process.env[envVar] = value;
    console.log(`Loaded ${envVar} from Secret Manager (${secretName})`);
  } catch (err) {
    if (isMissingAdcError(err)) {
      secretManagerDisabled = true;
      if (!missingAdcWarned) {
        missingAdcWarned = true;
        console.warn('Skipping Secret Manager runtime loads: ADC is not configured on this host.');
      }
      return;
    }
    const msg = errMsg(err);
    console.warn(`Could not load ${envVar} from Secret Manager: ${msg}`);
  }
}

export async function loadRuntimeSecrets(): Promise<void> {
  await ensureGoogleCredentials(PROJECT_ID).catch(() => {});
  const state = getGoogleCredentialBootstrapState();
  if (state.path) {
    console.log(`Bootstrapped GOOGLE_APPLICATION_CREDENTIALS from runtime secret (${state.path})`);
  }
  await ensureEnvFromSecret('GEMINI_API_KEY');
  await ensureEnvFromSecret('ANTHROPIC_API_KEY');
  await ensureEnvFromSecret('DEEPGRAM_API_KEY');
  await ensureEnvFromSecret('ELEVENLABS_API_KEY');
  await ensureEnvFromSecret('DISCORD_TEST_BOT_TOKEN');
  await ensureEnvFromSecret('GITHUB_TOKEN');
  await ensureEnvFromSecret('ADZUNA_APP_ID');
  await ensureEnvFromSecret('ADZUNA_APP_KEY');
}
