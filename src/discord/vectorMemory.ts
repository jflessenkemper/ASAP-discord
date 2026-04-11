import { createHash } from 'crypto';

import { GoogleAuth } from 'google-auth-library';

import pool from '../db/pool';
import { ensureGoogleCredentials, getAccessTokenViaGcloud } from '../services/googleCredentials';

import { logAgentEvent } from './activityLog';

// ─── Vector Memory (Semantic Search via pgvector) ───
// Stores key decisions, outcomes, and learnings as embeddings.
// Agents can query past context semantically before broad searches.

const VECTOR_MEMORY_ENABLED = process.env.VECTOR_MEMORY_ENABLED !== 'false';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-004';
const EMBEDDING_DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS || '768', 10);
const VECTOR_SEARCH_LIMIT = parseInt(process.env.VECTOR_SEARCH_LIMIT || '5', 10);
const VECTOR_SIMILARITY_THRESHOLD = parseFloat(process.env.VECTOR_SIMILARITY_THRESHOLD || '0.6');
const USE_VERTEX_AI = process.env.GEMINI_USE_VERTEX_AI === 'true';
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';

let vertexAuth: GoogleAuth | null = null;
let dbAvailable: boolean | null = null;

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
        if (tokenViaCli) return tokenViaCli;
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

async function checkVectorSupport(): Promise<boolean> {
  if (dbAvailable !== null) return dbAvailable;
  try {
    await pool.query('SELECT 1 FROM agent_embeddings LIMIT 0');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    console.warn('agent_embeddings table not available — vector memory disabled');
  }
  return dbAvailable;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

// ─── Embedding Generation ───

async function generateEmbeddingVertex(text: string): Promise<number[] | null> {
  if (!VERTEX_PROJECT_ID) return null;

  try {
    const token = await getVertexAccessToken();
    const endpoint = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${encodeURIComponent(EMBEDDING_MODEL)}:predict`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: [{ content: text.slice(0, 2000) }] }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`Vertex embedding ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const json: any = await res.json();
    const values = json?.predictions?.[0]?.embeddings?.values;
    if (Array.isArray(values) && values.length > 0) return values;
    return null;
  } catch (err) {
    console.warn('Vertex embedding failed:', err instanceof Error ? err.message : 'Unknown');
    return null;
  }
}

async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!VECTOR_MEMORY_ENABLED) return null;

  // Prefer Vertex AI (avoids Google AI Studio billing cap)
  if (USE_VERTEX_AI) {
    return generateEmbeddingVertex(text);
  }

  // Fallback: Google AI Studio (API key)
  if (!process.env.GEMINI_API_KEY) return null;

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const result = await (model as any).embedContent(text.slice(0, 2000));
    const values = result?.embedding?.values;
    if (Array.isArray(values) && values.length > 0) return values;
    return null;
  } catch (err) {
    console.warn('Embedding generation failed:', err instanceof Error ? err.message : 'Unknown');
    return null;
  }
}

// ─── Store ───

export async function storeMemoryEmbedding(
  agentId: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  if (!VECTOR_MEMORY_ENABLED) return false;
  if (!(await checkVectorSupport())) return false;

  const hash = contentHash(content);
  const embedding = await generateEmbedding(content);
  if (!embedding) return false;

  try {
    const embeddingStr = `[${embedding.join(',')}]`;
    await pool.query(
      `INSERT INTO agent_embeddings (agent_id, content, content_hash, embedding, metadata)
       VALUES ($1, $2, $3, $4::vector, $5)
       ON CONFLICT (agent_id, content_hash) DO UPDATE SET
         embedding = EXCLUDED.embedding,
         metadata = EXCLUDED.metadata`,
      [agentId, content.slice(0, 5000), hash, embeddingStr, metadata ? JSON.stringify(metadata) : null],
    );
    return true;
  } catch (err) {
    console.warn('Vector memory store failed:', err instanceof Error ? err.message : 'Unknown');
    return false;
  }
}

// ─── Search ───

export interface VectorSearchResult {
  content: string;
  similarity: number;
  agentId: string;
  metadata?: Record<string, unknown>;
}

export async function searchSimilarMemories(
  query: string,
  agentId?: string,
  limit?: number,
): Promise<VectorSearchResult[]> {
  if (!VECTOR_MEMORY_ENABLED) return [];
  if (!(await checkVectorSupport())) return [];

  const embedding = await generateEmbedding(query);
  if (!embedding) return [];

  try {
    const embeddingStr = `[${embedding.join(',')}]`;
    const maxResults = limit || VECTOR_SEARCH_LIMIT;

    const queryText = agentId
      ? `SELECT content, agent_id, metadata,
           1 - (embedding <=> $1::vector) AS similarity
         FROM agent_embeddings
         WHERE agent_id = $2
           AND 1 - (embedding <=> $1::vector) >= $3
         ORDER BY embedding <=> $1::vector
         LIMIT $4`
      : `SELECT content, agent_id, metadata,
           1 - (embedding <=> $1::vector) AS similarity
         FROM agent_embeddings
         WHERE 1 - (embedding <=> $1::vector) >= $2
         ORDER BY embedding <=> $1::vector
         LIMIT $3`;

    const params = agentId
      ? [embeddingStr, agentId, VECTOR_SIMILARITY_THRESHOLD, maxResults]
      : [embeddingStr, VECTOR_SIMILARITY_THRESHOLD, maxResults];

    const res = await pool.query(queryText, params);
    return res.rows.map((row: any) => ({
      content: row.content,
      similarity: parseFloat(row.similarity) || 0,
      agentId: row.agent_id,
      metadata: row.metadata || undefined,
    }));
  } catch (err) {
    console.warn('Vector memory search failed:', err instanceof Error ? err.message : 'Unknown');
    return [];
  }
}

// ─── Store a key decision or learning ───

export async function recordAgentDecision(
  agentId: string,
  decision: string,
  context?: string,
): Promise<boolean> {
  const content = context ? `Decision: ${decision}\nContext: ${context}` : `Decision: ${decision}`;
  const stored = await storeMemoryEmbedding(agentId, content, {
    type: 'decision',
    timestamp: new Date().toISOString(),
  });
  if (stored) {
    logAgentEvent(agentId, 'memory', `Stored decision embedding: ${decision.slice(0, 100)}`);
  }
  return stored;
}

export async function recordAgentLearning(
  agentId: string,
  learning: string,
): Promise<boolean> {
  const stored = await storeMemoryEmbedding(agentId, `Learning: ${learning}`, {
    type: 'learning',
    timestamp: new Date().toISOString(),
  });
  if (stored) {
    logAgentEvent(agentId, 'memory', `Stored learning embedding: ${learning.slice(0, 100)}`);
  }
  return stored;
}

// ─── Recall relevant context for a task ───

export async function recallRelevantContext(
  query: string,
  agentId?: string,
): Promise<string> {
  const results = await searchSimilarMemories(query, agentId);
  if (results.length === 0) return '';

  const formatted = results
    .map((r, i) => `[${i + 1}] (${(r.similarity * 100).toFixed(0)}% match) ${r.content.slice(0, 300)}`)
    .join('\n');

  return `\n[Relevant past context]\n${formatted}\n`;
}

// ─── Cleanup ───

export async function cleanupOldEmbeddings(retentionDays = 90): Promise<number> {
  if (!(await checkVectorSupport())) return 0;
  try {
    const res = await pool.query(
      `DELETE FROM agent_embeddings WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
      [retentionDays],
    );
    return res.rowCount || 0;
  } catch {
    return 0;
  }
}
