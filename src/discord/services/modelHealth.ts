import { postDiagnostic } from './diagnosticsWebhook';
import pool from '../../db/pool';
import type { PoolClient } from 'pg';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const ANTHROPIC_MODELS = ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'];
const GEMINI_TEXT_MODEL = 'gemini-2.0-flash';
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
let lockClient: PoolClient | null = null;

export async function runModelHealthChecks(): Promise<void> {
  const shouldRun = await acquireRevisionHealthLock();
  if (!shouldRun) return;

  const results: CheckResult[] = [];

  results.push(await checkAnthropic());
  results.push(await checkGeminiText());
  results.push(await checkGeminiTTS());
  results.push(await checkDeepgram());
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
    console.warn('Health lock unavailable, running anyway:', err instanceof Error ? err.message : 'Unknown');
    return true;
  }
}

async function checkAnthropic(): Promise<CheckResult> {
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
    const missing = ANTHROPIC_MODELS.filter((id) => !ids.has(id));
    if (missing.length > 0) {
      return { name: 'Anthropic', ok: false, detail: `missing models: ${missing.join(', ')}` };
    }
    return { name: 'Anthropic', ok: true, detail: `models available: ${ANTHROPIC_MODELS.join(', ')}` };
  } catch (err) {
    return { name: 'Anthropic', ok: false, detail: err instanceof Error ? err.message : 'request failed' };
  }
}

async function checkGeminiText(): Promise<CheckResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { name: 'Gemini text', ok: false, detail: 'GEMINI_API_KEY missing' };

  const models = await getGeminiModels(key);
  if (!models.ok) return { name: 'Gemini text', ok: false, detail: models.detail };
  if (!models.names.has(`models/${GEMINI_TEXT_MODEL}`)) {
    return { name: 'Gemini text', ok: false, detail: `${GEMINI_TEXT_MODEL} not listed for this API key/project` };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'health check: respond with ok' }] }],
        generationConfig: { maxOutputTokens: 8 },
      }),
    }, 15000);

    if (!res.ok) {
      const body = await safeText(res);
      if (res.status === 429) {
        return { name: 'Gemini text', ok: false, detail: 'quota exceeded or billing disabled for generateContent' };
      }
      return { name: 'Gemini text', ok: false, detail: `HTTP ${res.status} ${body.slice(0, 120)}` };
    }
    return { name: 'Gemini text', ok: true, detail: `${GEMINI_TEXT_MODEL} reachable` };
  } catch (err) {
    return { name: 'Gemini text', ok: false, detail: err instanceof Error ? err.message : 'request failed' };
  }
}

async function checkGeminiTTS(): Promise<CheckResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { name: 'Gemini TTS', ok: false, detail: 'GEMINI_API_KEY missing' };

  const models = await getGeminiModels(key);
  if (!models.ok) return { name: 'Gemini TTS', ok: false, detail: models.detail };
  if (!models.names.has(`models/${GEMINI_TTS_MODEL}`)) {
    return { name: 'Gemini TTS', ok: false, detail: `${GEMINI_TTS_MODEL} not listed for this API key/project` };
  }
  return { name: 'Gemini TTS', ok: true, detail: `${GEMINI_TTS_MODEL} enabled` };
}

async function getGeminiModels(key: string): Promise<{ ok: true; names: Set<string> } | { ok: false; detail: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, 15000);
    if (!res.ok) {
      const body = await safeText(res);
      if (res.status === 429) {
        return { ok: false, detail: 'quota exceeded or billing disabled for Gemini API key' };
      }
      return { ok: false, detail: `HTTP ${res.status} ${body.slice(0, 120)}` };
    }
    const data = await res.json() as { models?: Array<{ name?: string }> };
    return {
      ok: true,
      names: new Set((data.models || []).map((m) => m.name).filter(Boolean) as string[]),
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'request failed' };
  }
}

async function checkDeepgram(): Promise<CheckResult> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return { name: 'Deepgram', ok: false, detail: 'DEEPGRAM_API_KEY missing' };

  try {
    const res = await fetchWithTimeout('https://api.deepgram.com/v1/projects', {
      method: 'GET',
      headers: { Authorization: `Token ${key}` },
    }, 12000);

    if (!res.ok) {
      const body = await safeText(res);
      return { name: 'Deepgram', ok: false, detail: `HTTP ${res.status} ${body.slice(0, 120)}` };
    }
    return { name: 'Deepgram', ok: true, detail: 'API reachable' };
  } catch (err) {
    return { name: 'Deepgram', ok: false, detail: err instanceof Error ? err.message : 'request failed' };
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
    return { name: 'ElevenLabs', ok: false, detail: err instanceof Error ? err.message : 'request failed' };
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
