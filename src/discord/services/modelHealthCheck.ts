import { GoogleAuth } from 'google-auth-library';
import type { PoolClient } from 'pg';

import pool from '../../db/pool';
import { ensureGoogleCredentials, getAccessTokenViaGcloud } from '../../services/googleCredentials';
import {
  ANTHROPIC_HEALTHCHECK_MODELS,
  DEFAULT_CODING_MODEL,
  USE_VERTEX_ANTHROPIC,
  VERTEX_PROJECT_ID,
  VERTEX_LOCATION,
  VERTEX_ANTHROPIC_LOCATION,
  VERTEX_ANTHROPIC_FALLBACK_LOCATIONS,
  VERTEX_ANTHROPIC_VERSION,
  getPreferredAnthropicLocations,
  shouldTryAnotherAnthropicLocation,
} from '../../services/modelConfig';

import { postDiagnostic } from './diagnosticsWebhook';
import { errMsg } from '../../utils/errors';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

let vertexAuth: GoogleAuth | null = null;
let lockClient: PoolClient | null = null;

async function getVertexAccessToken(): Promise<string> {
  await ensureGoogleCredentials(VERTEX_PROJECT_ID).catch(() => false);

  if (!vertexAuth) {
    vertexAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }

  let authClient: any;
  let accessToken: any;
  try {
    authClient = await vertexAuth.getClient();
    accessToken = await authClient.getAccessToken();
  } catch (err) {
    const msg = String((err as any)?.message || err || '').toLowerCase();
    if (msg.includes('default credentials') || msg.includes('application default credentials')) {
      const recovered = await ensureGoogleCredentials(VERTEX_PROJECT_ID).catch(() => false);
      if (recovered) {
        vertexAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        authClient = await vertexAuth.getClient();
        accessToken = await authClient.getAccessToken();
      } else {
        const tokenViaCli = getAccessTokenViaGcloud();
        if (tokenViaCli) {
          return tokenViaCli;
        }
        throw new Error('Vertex auth unavailable: Application Default Credentials are not configured');
      }
    } else {
      throw err;
    }
  }

  const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;
  if (!token) throw new Error('Vertex auth failed: could not obtain access token');
  return token;
}

export async function runModelHealthChecks(): Promise<void> {
  const shouldRun = await acquireRevisionHealthLock();
  if (!shouldRun) return;

  const results: CheckResult[] = [];

  results.push(await checkAnthropic());
  results.push(await checkElevenLabs());

  const okCount = results.filter((r) => r.ok).length;
  const status = okCount === results.length ? 'PASS' : 'WARN';
  const detail = results.map((r) => `${r.ok ? 'OK' : 'FAIL'} ${r.name}: ${r.detail}`).join('\n');

  await postDiagnostic(`Model/provider health check: ${status} (${okCount}/${results.length})`, {
    level: okCount === results.length ? 'info' : 'warn',
    source: 'startup:model-health',
    detail,
  });
}

async function acquireRevisionHealthLock(): Promise<boolean> {
  if (lockClient) {
    return true;
  }

  const revision = process.env.K_REVISION || 'local';
  const lockId = hashLockKey(`startup-health:${revision}`);

  try {
    const client = await pool.connect();
    const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockId]);
    if (result.rows[0]?.locked) {
      lockClient = client; // Keep lock for process lifetime so only one instance posts per revision
      return true;
    }
    client.release();
    return false;
  } catch (err) {
    console.warn('Health lock unavailable, running anyway:', errMsg(err));
    return true;
  }
}

async function checkAnthropic(): Promise<CheckResult> {
  if (USE_VERTEX_ANTHROPIC) {
    if (!VERTEX_PROJECT_ID) {
      return { name: 'Anthropic', ok: false, detail: 'Vertex Anthropic enabled but VERTEX_PROJECT_ID is missing' };
    }

    const modelName = DEFAULT_CODING_MODEL;
    try {
      const token = await getVertexAccessToken();
      const locations = getPreferredAnthropicLocations(modelName);
      let lastFailure = 'request failed';

      for (let index = 0; index < locations.length; index += 1) {
        const location = locations[index];
        const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${location}/publishers/anthropic/models/${encodeURIComponent(modelName)}:rawPredict`;
        const res = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            anthropic_version: VERTEX_ANTHROPIC_VERSION,
            model: modelName,
            max_tokens: 8,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'health check: respond with ok' }] }],
          }),
        }, 15000);

        if (res.ok) {
          return { name: 'Anthropic', ok: true, detail: `Vertex partner model reachable: ${modelName} in ${location}` };
        }

        const body = await safeText(res);
        lastFailure = `Vertex HTTP ${res.status} (${location}) ${body.slice(0, 120)}`;
        if (index < locations.length - 1 && shouldTryAnotherAnthropicLocation(res.status, body)) {
          continue;
        }
        return { name: 'Anthropic', ok: false, detail: lastFailure };
      }
      return { name: 'Anthropic', ok: false, detail: lastFailure };
    } catch (err) {
      return { name: 'Anthropic', ok: false, detail: errMsg(err) };
    }
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { name: 'Anthropic', ok: false, detail: 'ANTHROPIC_API_KEY missing' };

  try {
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }, 12000);

    if (!res.ok) {
      const body = await safeText(res);
      return { name: 'Anthropic', ok: false, detail: `HTTP ${res.status} ${body.slice(0, 120)}` };
    }

    const data = await res.json() as { data?: Array<{ id?: string }> };
    const ids = new Set((data.data || []).map((m) => m.id).filter(Boolean) as string[]);
    const missing = ANTHROPIC_HEALTHCHECK_MODELS.filter((id) => !ids.has(id));
    if (missing.length > 0) {
      return { name: 'Anthropic', ok: false, detail: `missing models: ${missing.join(', ')}` };
    }
    return { name: 'Anthropic', ok: true, detail: `models available: ${ANTHROPIC_HEALTHCHECK_MODELS.join(', ')}` };
  } catch (err) {
    return { name: 'Anthropic', ok: false, detail: errMsg(err) };
  }
}

async function checkElevenLabs(): Promise<CheckResult> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { name: 'ElevenLabs', ok: false, detail: 'ELEVENLABS_API_KEY missing' };

  try {
    const res = await fetchWithTimeout('https://api.elevenlabs.io/v1/voices', {
      method: 'GET',
      headers: { 'xi-api-key': key },
    }, 12000);

    if (!res.ok) {
      const body = await safeText(res);
      return { name: 'ElevenLabs', ok: false, detail: `HTTP ${res.status} ${body.slice(0, 120)}` };
    }
    return { name: 'ElevenLabs', ok: true, detail: 'API reachable' };
  } catch (err) {
    return { name: 'ElevenLabs', ok: false, detail: errMsg(err) };
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function hashLockKey(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash || 1);
}
