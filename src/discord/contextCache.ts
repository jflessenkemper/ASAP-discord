import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAuth } from 'google-auth-library';

import { logAgentEvent } from './activityLog';
import { errMsg } from '../utils/errors';

// ─── Gemini Explicit Context Caching ───
// Caches system prompts + tool schemas at the API level.
// Saves 50-75% of input tokens by reusing cached content across requests.

const CONTEXT_CACHE_ENABLED = process.env.CONTEXT_CACHE_ENABLED !== 'false';
const CONTEXT_CACHE_TTL_SECONDS = parseInt(process.env.CONTEXT_CACHE_TTL_SECONDS || '3600', 10);
const CONTEXT_CACHE_MIN_TOKENS = parseInt(process.env.CONTEXT_CACHE_MIN_TOKENS || '4096', 10);
const USE_VERTEX_AI = process.env.GEMINI_USE_VERTEX_AI === 'true';
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';

interface CachedContentEntry {
  cacheId: string;
  modelName: string;
  contentHash: string;
  createdAt: number;
  expiresAt: number;
}

const cacheRegistry = new Map<string, CachedContentEntry>();
let vertexAuth: GoogleAuth | null = null;

// ── Cache Hit/Miss Metrics ──
const cacheMetrics = {
  hits: 0,
  misses: 0,
  creates: 0,
  errors: 0,
};

export function getCacheMetrics(): { hits: number; misses: number; creates: number; errors: number; hitRate: number } {
  const total = cacheMetrics.hits + cacheMetrics.misses;
  return {
    ...cacheMetrics,
    hitRate: total > 0 ? cacheMetrics.hits / total : 0,
  };
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function hashContent(systemPrompt: string, toolSchemas: string): string {
  const combined = `${systemPrompt}|||${toolSchemas}`;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const chr = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(36);
}

// ─── Vertex AI Caching ───

async function getVertexToken(): Promise<string> {
  if (!vertexAuth) {
    vertexAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  const client = await vertexAuth.getClient();
  const accessToken = await client.getAccessToken();
  const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;
  if (!token) throw new Error('Failed to get Vertex access token for caching');
  return token;
}

async function createVertexCache(
  modelName: string,
  systemPrompt: string,
  toolDeclarations: any[],
): Promise<string | null> {
  if (!VERTEX_PROJECT_ID) return null;

  try {
    const token = await getVertexToken();
    const endpoint = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/cachedContents`;

    const body = {
      model: `projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${modelName}`,
      displayName: `asap-agent-${Date.now()}`,
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      tools: toolDeclarations.length > 0 ? [{ functionDeclarations: toolDeclarations }] : undefined,
      expireTime: new Date(Date.now() + CONTEXT_CACHE_TTL_SECONDS * 1000).toISOString(),
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`Vertex cache creation failed (${res.status}): ${errText.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as { name?: string };
    return data.name || null;
  } catch (err) {
    console.warn('Vertex cache creation error:', errMsg(err));
    return null;
  }
}

// ─── API Key Caching (GoogleGenerativeAI) ───

async function createApiKeyCache(
  modelName: string,
  systemPrompt: string,
  toolDeclarations: any[],
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    // Use the REST API directly since @google/generative-ai doesn't expose caching yet
    const body: any = {
      model: `models/${modelName}`,
      displayName: `asap-agent-${Date.now()}`,
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      ttl: `${CONTEXT_CACHE_TTL_SECONDS}s`,
    };

    if (toolDeclarations.length > 0) {
      body.tools = [{ functionDeclarations: toolDeclarations }];
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`API key cache creation failed (${res.status}): ${errText.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as { name?: string };
    return data.name || null;
  } catch (err) {
    console.warn('API key cache creation error:', errMsg(err));
    return null;
  }
}

// ─── Public API ───

/**
 * Get or create a cached content resource for the given system prompt + tools.
 * Returns a cache ID that can be passed to generateContent requests.
 */
export async function getOrCreateContentCache(
  modelName: string,
  systemPrompt: string,
  toolDeclarations: any[],
  agentId: string,
): Promise<string | null> {
  if (!CONTEXT_CACHE_ENABLED) return null;

  const toolSchemaStr = JSON.stringify(toolDeclarations);
  const totalTokens = estimateTokenCount(systemPrompt) + estimateTokenCount(toolSchemaStr);

  if (totalTokens < CONTEXT_CACHE_MIN_TOKENS) {
    return null;
  }

  const cacheKey = `${modelName}:${hashContent(systemPrompt, toolSchemaStr)}`;
  const existing = cacheRegistry.get(cacheKey);

  if (existing && existing.expiresAt > Date.now() + 60_000) {
    cacheMetrics.hits++;
    return existing.cacheId;
  }

  // Create new cache
  cacheMetrics.misses++;
  let cacheId: string | null = null;

  if (USE_VERTEX_AI) {
    cacheId = await createVertexCache(modelName, systemPrompt, toolDeclarations);
  }

  if (!cacheId) {
    cacheId = await createApiKeyCache(modelName, systemPrompt, toolDeclarations);
  }

  if (cacheId) {
    cacheMetrics.creates++;
    cacheRegistry.set(cacheKey, {
      cacheId,
      modelName,
      contentHash: hashContent(systemPrompt, toolSchemaStr),
      createdAt: Date.now(),
      expiresAt: Date.now() + CONTEXT_CACHE_TTL_SECONDS * 1000,
    });
    logAgentEvent(agentId, 'cache', `Created context cache: ${cacheId.slice(-20)} (~${totalTokens} tokens, TTL ${CONTEXT_CACHE_TTL_SECONDS}s, hitRate=${(getCacheMetrics().hitRate * 100).toFixed(0)}%)`);
  } else {
    cacheMetrics.errors++;
  }

  return cacheId;
}

/**
 * Evict all expired caches from the local registry.
 */
export function evictExpiredCaches(): number {
  let evicted = 0;
  const now = Date.now();
  for (const [key, entry] of cacheRegistry.entries()) {
    if (entry.expiresAt <= now) {
      cacheRegistry.delete(key);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Get cache stats for monitoring.
 */
export function getCacheStats(): { active: number; totalCreated: number } {
  evictExpiredCaches();
  return {
    active: cacheRegistry.size,
    totalCreated: cacheRegistry.size,
  };
}
