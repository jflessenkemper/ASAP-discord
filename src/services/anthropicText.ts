import { GoogleAuth } from 'google-auth-library';

import { ensureGoogleCredentials, getAccessTokenViaGcloud } from './googleCredentials';
import {
  DEFAULT_FAST_MODEL,
  USE_VERTEX_ANTHROPIC,
  VERTEX_PROJECT_ID,
  VERTEX_ANTHROPIC_LOCATION,
  VERTEX_ANTHROPIC_VERSION,
} from './modelConfig';

import { errMsg } from '../utils/errors';

type AnthropicTextOptions = {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

const DEFAULT_MODEL = DEFAULT_FAST_MODEL;

let vertexAuth: GoogleAuth | null = null;

function extractTextFromAnthropicPayload(payload: any): string {
  const text = Array.isArray(payload?.content)
    ? payload.content
      .filter((part: any) => part?.type === 'text' && typeof part?.text === 'string')
      .map((part: any) => part.text)
      .join('')
    : '';
  return text.trim();
}

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
        throw new Error('Vertex Anthropic auth unavailable');
      }
    } else {
      throw err;
    }
  }

  const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;
  if (!token) throw new Error('Failed to obtain Vertex Anthropic access token');
  return token;
}

async function generateViaVertex(options: Required<AnthropicTextOptions>): Promise<string> {
  if (!VERTEX_PROJECT_ID) {
    throw new Error('VERTEX_PROJECT_ID is required for Vertex Anthropic mode');
  }
  const token = await getVertexAccessToken();
  const endpoint = `https://${VERTEX_ANTHROPIC_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_ANTHROPIC_LOCATION}/publishers/anthropic/models/${encodeURIComponent(options.model)}:rawPredict`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      anthropic_version: VERTEX_ANTHROPIC_VERSION,
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      system: options.system || undefined,
      messages: [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Vertex Anthropic HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  return extractTextFromAnthropicPayload(json);
}

async function generateDirect(options: Required<AnthropicTextOptions>): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      system: options.system || undefined,
      messages: [{ role: 'user', content: options.prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  return extractTextFromAnthropicPayload(json);
}

export async function generateAnthropicText(options: AnthropicTextOptions): Promise<string> {
  const resolved: Required<AnthropicTextOptions> = {
    prompt: String(options.prompt || '').trim(),
    system: String(options.system || '').trim(),
    model: String(options.model || DEFAULT_MODEL).trim(),
    maxTokens: options.maxTokens ?? 800,
    temperature: options.temperature ?? 0,
  };

  if (!resolved.prompt) throw new Error('Prompt is required');

  try {
    if (USE_VERTEX_ANTHROPIC) {
      return await generateViaVertex(resolved);
    }
    return await generateDirect(resolved);
  } catch (err) {
    throw new Error(`Anthropic text generation failed: ${errMsg(err)}`);
  }
}