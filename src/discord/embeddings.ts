/**
 * Vertex AI text-embedding-004 client — 768-dim embeddings for user_events.
 *
 * Stays off the hot path: the embedding worker calls this in the background.
 */

import { GoogleAuth } from 'google-auth-library';

import { ensureGoogleCredentials } from '../services/googleCredentials';
import { VERTEX_PROJECT_ID, VERTEX_LOCATION } from '../services/modelConfig';
import { errMsg } from '../utils/errors';

const MODEL = 'text-embedding-004';
const MAX_CHARS = 3000;

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

async function getAccessToken(): Promise<string | null> {
  await ensureGoogleCredentials(VERTEX_PROJECT_ID).catch(() => false);
  try {
    const client = await auth.getClient();
    const tokenResult = await client.getAccessToken();
    return typeof tokenResult === 'string' ? tokenResult : tokenResult?.token ?? null;
  } catch (err) {
    console.error('[embeddings] failed to acquire access token:', errMsg(err));
    return null;
  }
}

/**
 * Returns a 768-dim embedding, or null if embeddings are unavailable (no creds,
 * no project, API failure). Callers should treat null as "skip for now."
 */
export async function embedText(text: string): Promise<number[] | null> {
  if (!text?.trim()) return null;
  if (!VERTEX_PROJECT_ID) return null;

  const token = await getAccessToken();
  if (!token) return null;

  const location = VERTEX_LOCATION || 'us-central1';
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${location}/publishers/google/models/${MODEL}:predict`;

  const trimmed = text.slice(0, MAX_CHARS);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instances: [{ content: trimmed, task_type: 'RETRIEVAL_DOCUMENT' }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[embeddings] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = await res.json() as {
      predictions?: { embeddings?: { values?: number[] } }[];
    };
    const values = data.predictions?.[0]?.embeddings?.values;
    return Array.isArray(values) && values.length > 0 ? values : null;
  } catch (err) {
    console.error('[embeddings] embedText failed:', errMsg(err));
    return null;
  }
}

/**
 * Query-time embedding (uses RETRIEVAL_QUERY task type for better recall).
 */
export async function embedQuery(text: string): Promise<number[] | null> {
  if (!text?.trim()) return null;
  if (!VERTEX_PROJECT_ID) return null;

  const token = await getAccessToken();
  if (!token) return null;

  const location = VERTEX_LOCATION || 'us-central1';
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${location}/publishers/google/models/${MODEL}:predict`;

  const trimmed = text.slice(0, MAX_CHARS);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instances: [{ content: trimmed, task_type: 'RETRIEVAL_QUERY' }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      predictions?: { embeddings?: { values?: number[] } }[];
    };
    const values = data.predictions?.[0]?.embeddings?.values;
    return Array.isArray(values) && values.length > 0 ? values : null;
  } catch (err) {
    console.error('[embeddings] embedQuery failed:', errMsg(err));
    return null;
  }
}
