import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI, Content, Part, FunctionDeclaration, Tool } from '@google/generative-ai';
import { GoogleAuth } from 'google-auth-library';
import { readFileSync } from 'fs';
import { extname, join } from 'path';
import { AgentConfig } from './agents';
import { REPO_TOOLS, REVIEW_TOOLS, RILEY_TOOLS, PROMPT_REPO_TOOLS, PROMPT_REVIEW_TOOLS, PROMPT_RILEY_TOOLS, executeTool, getToolAuditCallback } from './tools';
import { recordClaudeUsage, isClaudeOverLimit, isBudgetExceeded, getRemainingBudget, getClaudeTokenStatus, approveAdditionalBudget, type PromptBreakdown } from './usage';
import { logAgentEvent } from './activityLog';
import { recordAgentResponse, recordRateLimitHit } from './metrics';

// Load project context once at startup — shared by all agents
let PROJECT_CONTEXT = '';
try {
  PROJECT_CONTEXT = readFileSync(join(__dirname, '../../../.github/PROJECT_CONTEXT.md'), 'utf-8');
} catch {
  console.warn('PROJECT_CONTEXT.md not found — agents will lack project context');
}

// Keep shared project context lean; agents should pull details from tools only when needed.
const PROJECT_CONTEXT_MAX_CHARS = parseInt(process.env.PROJECT_CONTEXT_MAX_CHARS || '1800', 10);
if (PROJECT_CONTEXT.length > PROJECT_CONTEXT_MAX_CHARS) {
  PROJECT_CONTEXT = PROJECT_CONTEXT.slice(0, PROJECT_CONTEXT_MAX_CHARS) + '\n\n[Project context truncated for token efficiency]';
}
const PROJECT_CONTEXT_LIGHT_MAX_CHARS = parseInt(process.env.PROJECT_CONTEXT_LIGHT_MAX_CHARS || '500', 10);
const PROJECT_CONTEXT_LIGHT = PROJECT_CONTEXT.slice(0, PROJECT_CONTEXT_LIGHT_MAX_CHARS);

// Model identifiers (env-overridable for fast runtime switching).
const GEMINI_FLASH = process.env.GEMINI_FLASH_MODEL || 'gemini-flash-latest';
const GEMINI_PRO = process.env.GEMINI_PRO_MODEL || 'gemini-2.5-pro';
const ANTHROPIC_OPUS = process.env.ANTHROPIC_CODING_MODEL || 'claude-opus-4-20250514';
// Prefer Opus for real coding work; short/status asks stay on the fast path.
const DEFAULT_CODING_MODEL = process.env.CODING_AGENT_MODEL || ANTHROPIC_OPUS;
const DEFAULT_FAST_MODEL = process.env.FAST_AGENT_MODEL || GEMINI_FLASH;
const VOICE_FAST_MODEL = process.env.VOICE_FAST_MODEL || DEFAULT_FAST_MODEL;
const FORCE_OPUS_FOR_CODE_WORK = process.env.FORCE_OPUS_FOR_CODE_WORK !== 'false';
const ANTHROPIC_AUTO_CACHE = process.env.ANTHROPIC_AUTO_CACHE !== 'false';
const COMPACT_RUNTIME_TOOL_PROMPTS = process.env.COMPACT_RUNTIME_TOOL_PROMPTS !== 'false';
const CODE_HEAVY_AGENT_IDS = new Set(['developer', 'devops', 'ios-engineer', 'android-engineer']);
const CODE_WORK_RE = /\b(?:code|coding|implement|implementation|fix|bug|debug|refactor|build|compile|lint|typecheck|test(?:s|ing)?|deploy|migration|schema|sql|query|api|endpoint|component|screen|tsx|jsx|react|expo|node|frontend|backend|repo|commit|branch|diff|patch|pull request|pr)\b/i;
const TOOL_ACTION_RE = /\b(?:run|read|search|grep|inspect|check|verify|edit|change|update|deploy|build|test|commit|push|rollback|migrate|open)\b/i;
const SIMPLE_FAST_PATH_RE = /^(?:ok(?:ay)?|yes|no|thanks?|thank you|status|summary|summari[sz]e|what happened|why|how|help|ping|continue|proceed|looks good|sounds good)\b/i;
const DIRECT_ANSWER_ONLY_RE = /^(?:ok(?:ay)?|yes|no|thanks?|thank you|understood|sounds good|what does|what is|why is|how does|explain|summari[sz]e|clarify)\b/i;

/**
 * High-stakes prompts for Ace where Pro quality is worth the cost.
 * Everything else defaults to Flash for cost efficiency.
 */
const HIGH_STAKES_RE = /(high[-\s]?stakes|critical|prod(?:uction)?|hotfix|incident|security|auth|migration|rollback|data\s+loss|schema|deploy)/i;
function isHighStakesPrompt(userMessage: string): boolean {
  return HIGH_STAKES_RE.test(userMessage);
}

function isCodeWorkPrompt(userMessage: string): boolean {
  return CODE_WORK_RE.test(userMessage);
}

function isSimpleFastPathPrompt(userMessage: string): boolean {
  const trimmed = userMessage.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > 220) return false;
  if (TOOL_ACTION_RE.test(trimmed) || isCodeWorkPrompt(trimmed)) return false;
  return SIMPLE_FAST_PATH_RE.test(trimmed) || trimmed.split(/\s+/).length <= 10;
}

function isDirectAnswerOnlyPrompt(userMessage: string): boolean {
  const trimmed = userMessage.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > 240) return false;
  if (TOOL_ACTION_RE.test(trimmed) || isCodeWorkPrompt(trimmed)) return false;
  return DIRECT_ANSWER_ONLY_RE.test(trimmed) || /^(?:who|what|why|how)\b/i.test(trimmed);
}

/** Detect failed tests/typecheck outputs that warrant escalation to Pro. */
function hasValidationFailure(toolName: string, result: string): boolean {
  if (toolName !== 'run_tests' && toolName !== 'typecheck') return false;
  return /(\bFAIL\b|failing|failed|Type error|not assignable|Compilation error|[1-9]\d*\s+errors?\b|Tests?:\s*[1-9]\d*\s+failed)/i.test(result);
}

/**
 * Model policy:
 * - Voice and other short/status asks stay on the fast model.
 * - Code-heavy prompts escalate to the coding model when warranted.
 * - Riley still escalates to Pro for non-code high-stakes ops prompts.
 */
function modelForAgent(agentId: string, userMessage: string): string {
  if (isSimpleFastPathPrompt(userMessage)) {
    return DEFAULT_FAST_MODEL;
  }
  if (CODE_HEAVY_AGENT_IDS.has(agentId) && isCodeWorkPrompt(userMessage)) {
    return DEFAULT_CODING_MODEL;
  }
  if (FORCE_OPUS_FOR_CODE_WORK && isCodeWorkPrompt(userMessage)) {
    return DEFAULT_CODING_MODEL;
  }
  if (agentId === 'executive-assistant' && isHighStakesPrompt(userMessage)) {
    return GEMINI_PRO;
  }
  return DEFAULT_FAST_MODEL;
}

/**
 * Riley gets a deliberately smaller coordination/ops tool surface.
 * Everyone else defaults to full repo tools; set LIMIT_NON_RILEY_AGENTS_TO_REVIEW_TOOLS=true
 * to restore the older review-only restriction for non-core agents.
 */
const LEGACY_FULL_TOOL_AGENTS = new Set(['developer', 'devops', 'executive-assistant']);
const LIMIT_NON_RILEY_AGENTS_TO_REVIEW_TOOLS = process.env.LIMIT_NON_RILEY_AGENTS_TO_REVIEW_TOOLS === 'true';

// Resilience toggles: default ON so Riley can complete fire-and-forget requests.
const RILEY_AUTO_APPROVE_BUDGET = process.env.RILEY_AUTO_APPROVE_BUDGET !== 'false';
const RILEY_AUTO_APPROVE_BUDGET_INCREMENT = parseFloat(process.env.RILEY_AUTO_APPROVE_BUDGET_INCREMENT_USD || '5');
const RILEY_AUTO_APPROVE_BUDGET_MAX_PASSES = parseInt(process.env.RILEY_AUTO_APPROVE_BUDGET_MAX_PASSES || '4', 10);
const RILEY_TOKEN_OVERRUN_ALLOWANCE = parseInt(process.env.RILEY_TOKEN_OVERRUN_ALLOWANCE || '2000000', 10);

type AnyTool = { name: string; description: string; input_schema: any };

function hasFullRepoToolAccess(agentId: string): boolean {
  return agentId !== 'executive-assistant'
    && (!LIMIT_NON_RILEY_AGENTS_TO_REVIEW_TOOLS || LEGACY_FULL_TOOL_AGENTS.has(agentId));
}

function toolsForAgent(agentId: string): AnyTool[] {
  const repoTools = (COMPACT_RUNTIME_TOOL_PROMPTS ? PROMPT_REPO_TOOLS : REPO_TOOLS) as unknown as AnyTool[];
  const reviewTools = (COMPACT_RUNTIME_TOOL_PROMPTS ? PROMPT_REVIEW_TOOLS : REVIEW_TOOLS) as unknown as AnyTool[];
  const rileyTools = (COMPACT_RUNTIME_TOOL_PROMPTS ? PROMPT_RILEY_TOOLS : RILEY_TOOLS) as unknown as AnyTool[];

  if (agentId === 'executive-assistant') {
    return rileyTools;
  }
  if (LIMIT_NON_RILEY_AGENTS_TO_REVIEW_TOOLS) {
    return hasFullRepoToolAccess(agentId) ? repoTools : reviewTools;
  }
  return repoTools;
}

function toolsForPrompt(agentId: string, userMessage: string): AnyTool[] {
  if (isDirectAnswerOnlyPrompt(userMessage)) {
    return [];
  }

  if (isSimpleFastPathPrompt(userMessage) && agentId !== 'executive-assistant') {
    return (COMPACT_RUNTIME_TOOL_PROMPTS ? PROMPT_REVIEW_TOOLS : REVIEW_TOOLS) as unknown as AnyTool[];
  }

  return toolsForAgent(agentId);
}

/**
 * Convert Anthropic input_schema (lowercase types, input_schema key) to
 * Gemini FunctionDeclaration parameters (uppercase types, parameters key).
 */
function convertSchemaNode(node: any): any {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(convertSchemaNode);

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' && typeof value === 'string') {
      out[key] = value.toUpperCase();
    } else if (key === 'properties' && value && typeof value === 'object') {
      out[key] = {};
      for (const [prop, schema] of Object.entries(value as Record<string, any>)) {
        out[key][prop] = convertSchemaNode(schema);
      }
    } else if (key === 'items') {
      out[key] = convertSchemaNode(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeSchemaNode(node: any): any {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sanitizeSchemaNode);

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(node)) {
    // Drop verbose/non-essential JSON-schema fields to reduce tool-schema token load.
    if (key === 'title' || key === 'default' || key === 'examples' || key === '$schema') {
      continue;
    }
    if (key === 'description') {
      out[key] = String(value || '').slice(0, 180);
      continue;
    }
    if (key === 'anyOf' || key === 'allOf' || key === 'oneOf') {
      const candidates = Array.isArray(value) ? value.map(sanitizeSchemaNode).slice(0, 3) : [];
      if (candidates.length > 0) {
        out[key] = candidates;
      }
      continue;
    }
    if (key === 'nullable') {
      continue;
    }

    out[key] = sanitizeSchemaNode(value);
  }
  return out;
}

function toGeminiTools(tools: AnyTool[]): Tool[] {
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: String(tool.description || tool.name).slice(0, 180),
      parameters: convertSchemaNode(sanitizeSchemaNode(tool.input_schema)),
    } as FunctionDeclaration)),
  }];
}

function toAnthropicTools(tools: AnyTool[]): Array<{ name: string; description: string; input_schema: any }> {
  return tools.map((tool) => ({
    name: tool.name,
    description: String(tool.description || tool.name).slice(0, 180),
    input_schema: sanitizeSchemaNode(tool.input_schema),
  }));
}

let client: GoogleGenerativeAI | null = null;
let anthropicClient: Anthropic | null = null;
let vertexAuth: GoogleAuth | null = null;
let vertexTokenCache: { token: string; expiresAtMs: number } | null = null;

const USE_VERTEX_AI = process.env.GEMINI_USE_VERTEX_AI === 'true';
const USE_VERTEX_ANTHROPIC = process.env.ANTHROPIC_USE_VERTEX_AI === 'true' || process.env.OPUS_USE_VERTEX_AI === 'true';
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const VERTEX_ANTHROPIC_VERSION = process.env.VERTEX_ANTHROPIC_VERSION || 'vertex-2023-10-16';
const PARTNER_MODEL_CACHE_ENABLED = process.env.PARTNER_MODEL_CACHE_ENABLED !== 'false';

type ToolCallLike = { name: string; args: object; id?: string };

type ModelResponseLike = {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    cachedContentTokenCount?: number;
  };
  text: () => string;
  functionCalls: () => ToolCallLike[];
};

type ModelResultLike = { response: ModelResponseLike };

type ChatLike = {
  sendMessage: (payload: string | Part[], requestOptions?: { signal?: AbortSignal }) => Promise<ModelResultLike>;
  sendMessageStream?: (payload: string | Part[], requestOptions?: { signal?: AbortSignal }) => Promise<any>;
  getHistory: () => Promise<Content[]>;
};

export interface ReusableAgentChatSession {
  chat: ChatLike | null;
  modelName: string | null;
}

type ModelLike = {
  startChat: (options: { history: Content[] }) => ChatLike;
  generateContent: (payload: string, requestOptions?: { signal?: AbortSignal }) => Promise<ModelResultLike>;
};

function cloneHistory(history: Content[]): Content[] {
  return JSON.parse(JSON.stringify(history || []));
}

function asVertexSystemInstruction(systemInstruction?: string): { parts: Array<{ text: string }> } | undefined {
  if (!systemInstruction) return undefined;
  return { parts: [{ text: systemInstruction }] };
}

function userContentFromPayload(payload: string | Part[]): Content {
  if (typeof payload === 'string') {
    return { role: 'user', parts: [{ text: payload }] } as Content;
  }
  return { role: 'user', parts: payload as any } as Content;
}

function makeVertexError(status: number, bodyText: string): Error & { status: number; statusCode: number } {
  const err = new Error(`Vertex Gemini error: HTTP ${status} ${bodyText.slice(0, 400)}`) as Error & { status: number; statusCode: number };
  err.status = status;
  err.statusCode = status;
  return err;
}

function makeVertexAnthropicError(status: number, bodyText: string): Error & { status: number; statusCode: number } {
  const err = new Error(`Vertex Anthropic error: HTTP ${status} ${bodyText.slice(0, 400)}`) as Error & { status: number; statusCode: number };
  err.status = status;
  err.statusCode = status;
  return err;
}

async function getVertexAccessToken(): Promise<string> {
  const now = Date.now();
  if (vertexTokenCache && vertexTokenCache.expiresAtMs - now > 60_000) {
    return vertexTokenCache.token;
  }

  if (!vertexAuth) {
    vertexAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }

  const authClient = await vertexAuth.getClient();
  const accessToken = await authClient.getAccessToken();
  const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;
  if (!token) {
    throw new Error('Vertex auth failed: could not obtain access token');
  }

  vertexTokenCache = {
    token,
    // Conservative cache window; refreshed frequently enough for long-running bot process.
    expiresAtMs: now + 45 * 60_000,
  };

  return token;
}

async function callVertexGenerateContent(
  modelName: string,
  body: Record<string, any>,
  signal?: AbortSignal,
): Promise<any> {
  if (!VERTEX_PROJECT_ID) {
    throw new Error('Vertex AI is enabled but VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set');
  }

  const token = await getVertexAccessToken();
  const endpoint = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${encodeURIComponent(modelName)}:generateContent`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const bodyText = await res.text();
    throw makeVertexError(res.status, bodyText);
  }

  return res.json();
}

async function callVertexAnthropicRawPredict(
  modelName: string,
  body: Record<string, any>,
  signal?: AbortSignal,
): Promise<any> {
  if (!VERTEX_PROJECT_ID) {
    throw new Error('Vertex Anthropic is enabled but VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set');
  }

  const token = await getVertexAccessToken();
  const endpoint = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/anthropic/models/${encodeURIComponent(modelName)}:rawPredict`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const bodyText = await res.text();
    throw makeVertexAnthropicError(res.status, bodyText);
  }

  return res.json();
}

function makeResponseLikeFromVertex(raw: any): ModelResponseLike {
  const firstCandidate = raw?.candidates?.[0] || {};
  const parts: any[] = firstCandidate?.content?.parts || [];

  const response: ModelResponseLike = {
    usageMetadata: raw?.usageMetadata || {},
    text: () => parts.filter((part) => typeof part?.text === 'string').map((part) => String(part.text)).join(''),
    functionCalls: () =>
      parts
        .filter((part) => part?.functionCall?.name)
        .map((part) => ({
          name: String(part.functionCall.name),
          args: (part.functionCall.args || {}) as object,
        })),
  };
  (response as any).__raw = raw;
  return response;
}

function createVertexModel(modelName: string, options: { systemInstruction?: string; tools?: Tool[]; generationConfig?: Record<string, any> }): ModelLike {
  const invoke = async (contents: Content[], signal?: AbortSignal): Promise<ModelResultLike> => {
    const raw = await callVertexGenerateContent(
      modelName,
      {
        contents,
        tools: options.tools,
        systemInstruction: asVertexSystemInstruction(options.systemInstruction),
        generationConfig: options.generationConfig,
      },
      signal,
    );
    return { response: makeResponseLikeFromVertex(raw) };
  };

  return {
    startChat: ({ history }) => {
      let workingHistory = cloneHistory(history || []);
      return {
        sendMessage: async (payload, requestOptions) => {
          const userContent = userContentFromPayload(payload);
          const requestContents = [...workingHistory, userContent];
          const result = await invoke(requestContents, requestOptions?.signal);

          workingHistory = [...requestContents];
          const candidateParts = (result.response as any)?.__raw?.candidates?.[0]?.content?.parts;
          const candidateContent = (candidateParts && candidateParts.length)
            ? ({ role: 'model', parts: candidateParts } as Content)
            : null;

          if (candidateContent) {
            workingHistory.push(candidateContent);
          }

          return result;
        },
        getHistory: async () => cloneHistory(workingHistory),
      };
    },
    generateContent: async (payload: string, requestOptions?: { signal?: AbortSignal }) => {
      return invoke([{ role: 'user', parts: [{ text: payload }] } as Content], requestOptions?.signal);
    },
  };
}

type ResponseCacheEntry = { value: string; ts: number };
const responseCache = new Map<string, ResponseCacheEntry>();
const RESPONSE_CACHE_TTL_MS = parseInt(process.env.RESPONSE_CACHE_TTL_MS || '120000', 10);
const RESPONSE_CACHE_MAX_ENTRIES = parseInt(process.env.RESPONSE_CACHE_MAX_ENTRIES || '128', 10);
const RESPONSE_CACHE_ALLOW_TOOL_AGENTS = process.env.RESPONSE_CACHE_ALLOW_TOOL_AGENTS === 'true';

function getClient(): GoogleGenerativeAI {
  if (!client) {
    client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
  }
  return client;
}

function getAnthropicClient(): Anthropic {
  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  const authToken = String(process.env.ANTHROPIC_AUTH_TOKEN || '').trim();
  if (!apiKey && !authToken) {
    throw new Error('Anthropic credentials missing: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN');
  }

  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      ...(authToken ? { authToken } : {}),
    } as any);
  }
  return anthropicClient;
}

function hasAnthropicCredentials(): boolean {
  return Boolean(String(process.env.ANTHROPIC_API_KEY || '').trim())
    || Boolean(String(process.env.ANTHROPIC_AUTH_TOKEN || '').trim());
}

function isAnthropicModel(modelName: string): boolean {
  const key = String(modelName || '').trim().toLowerCase();
  return key.includes('claude') || key.includes('opus') || key.includes('sonnet');
}

function toAnthropicBlocks(parts: any[]): any[] {
  const blocks: any[] = [];
  for (const part of parts || []) {
    if (typeof part?.text === 'string' && part.text.trim()) {
      blocks.push({ type: 'text', text: part.text });
    }
    const functionResponse = part?.functionResponse;
    if (functionResponse) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: String(functionResponse.toolUseId || functionResponse.name || 'tool'),
        content: typeof functionResponse.response?.output === 'string'
          ? functionResponse.response.output
          : JSON.stringify(functionResponse.response?.output ?? ''),
      });
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

function withAnthropicCacheControl(blocks: any[]): any[] {
  if (!PARTNER_MODEL_CACHE_ENABLED || !Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') return block;
    if (block.type !== 'text') return block;
    const text = String(block.text || '');
    if (text.length < 120) return block;
    return { ...block, cache_control: { type: 'ephemeral' } };
  });
}

function asAnthropicSystemInstruction(systemInstruction?: string): string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> | undefined {
  if (!systemInstruction) return undefined;
  if (!PARTNER_MODEL_CACHE_ENABLED) return systemInstruction;
  return [{ type: 'text', text: systemInstruction, cache_control: { type: 'ephemeral' } }];
}

function geminiHistoryToAnthropicMessages(history: Content[]): Array<{ role: 'user' | 'assistant'; content: any[] }> {
  return history
    .map((entry) => ({
      role: entry.role === 'model' ? 'assistant' as const : 'user' as const,
      content: toAnthropicBlocks(entry.parts as any[]),
    }))
    .filter((entry) => entry.content.length > 0);
}

function anthropicHistoryToGemini(history: Array<{ role: 'user' | 'assistant'; content: any[] }>): Content[] {
  return history.map((entry) => ({
    role: entry.role === 'assistant' ? 'model' : 'user',
    parts: (entry.content || [])
      .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: any) => ({ text: String(block.text) })),
  } as Content));
}

function makeResponseLikeFromAnthropic(raw: any): ModelResponseLike {
  const blocks: any[] = raw?.content || [];
  const response: ModelResponseLike = {
    usageMetadata: {
      promptTokenCount:
        (raw?.usage?.input_tokens || 0) +
        (raw?.usage?.cache_creation_input_tokens || 0) +
        (raw?.usage?.cache_read_input_tokens || 0),
      candidatesTokenCount: raw?.usage?.output_tokens || 0,
      cacheCreationInputTokens: raw?.usage?.cache_creation_input_tokens || 0,
      cacheReadInputTokens: raw?.usage?.cache_read_input_tokens || 0,
    },
    text: () => blocks.filter((block) => block?.type === 'text').map((block) => String(block.text || '')).join(''),
    functionCalls: () => blocks
      .filter((block) => block?.type === 'tool_use' && block?.name)
      .map((block) => ({
        name: String(block.name),
        args: (block.input || {}) as object,
        id: typeof block.id === 'string' ? block.id : undefined,
      })),
  };
  (response as any).__raw = raw;
  return response;
}

function createAnthropicModel(
  modelName: string,
  options: { systemInstruction?: string; rawTools?: AnyTool[]; generationConfig?: Record<string, any> }
): ModelLike {
  const anthropic = getAnthropicClient();
  const anthropicTools = toAnthropicTools(options.rawTools || []);
  const maxTokens = Math.max(64, Number(options.generationConfig?.maxOutputTokens || 1024));

  const invoke = async (
    messages: Array<{ role: 'user' | 'assistant'; content: any[] }>,
    signal?: AbortSignal,
  ): Promise<ModelResultLike> => {
    const cachedMessages = PARTNER_MODEL_CACHE_ENABLED
      ? messages.map((msg) => ({ ...msg, content: withAnthropicCacheControl(msg.content || []) }))
      : messages;
    const raw = await anthropic.messages.create({
      model: modelName,
      max_tokens: maxTokens,
      system: asAnthropicSystemInstruction(options.systemInstruction),
      messages: cachedMessages,
      tools: anthropicTools.length > 0 ? anthropicTools as any : undefined,
    } as any, signal ? { signal } as any : undefined);

    return { response: makeResponseLikeFromAnthropic(raw) };
  };

  return {
    startChat: ({ history }) => {
      let workingHistory = geminiHistoryToAnthropicMessages(history || []);
      return {
        sendMessage: async (payload, requestOptions) => {
          const nextMessage = typeof payload === 'string'
            ? { role: 'user' as const, content: [{ type: 'text', text: payload }] }
            : { role: 'user' as const, content: toAnthropicBlocks(payload as any[]) };

          const requestMessages = [...workingHistory, nextMessage];
          const result = await invoke(requestMessages, requestOptions?.signal);
          const assistantContent = ((result.response as any)?.__raw?.content || (result as any)?.content || []) as any[];
          workingHistory = [...requestMessages, { role: 'assistant' as const, content: assistantContent }];
          return result;
        },
        getHistory: async () => anthropicHistoryToGemini(workingHistory),
      };
    },
    generateContent: async (payload: string, requestOptions?: { signal?: AbortSignal }) => {
      return invoke([{ role: 'user', content: [{ type: 'text', text: payload }] }], requestOptions?.signal);
    },
  };
}

function createVertexAnthropicModel(
  modelName: string,
  options: { systemInstruction?: string; rawTools?: AnyTool[]; generationConfig?: Record<string, any> }
): ModelLike {
  const anthropicTools = toAnthropicTools(options.rawTools || []);
  const maxTokens = Math.max(64, Number(options.generationConfig?.maxOutputTokens || 1024));

  const invoke = async (
    messages: Array<{ role: 'user' | 'assistant'; content: any[] }>,
    signal?: AbortSignal,
  ): Promise<ModelResultLike> => {
    const cachedMessages = PARTNER_MODEL_CACHE_ENABLED
      ? messages.map((msg) => ({ ...msg, content: withAnthropicCacheControl(msg.content || []) }))
      : messages;

    const raw = await callVertexAnthropicRawPredict(
      modelName,
      {
        anthropic_version: VERTEX_ANTHROPIC_VERSION,
        model: modelName,
        max_tokens: maxTokens,
        system: asAnthropicSystemInstruction(options.systemInstruction),
        messages: cachedMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      },
      signal,
    );

    return { response: makeResponseLikeFromAnthropic(raw) };
  };

  return {
    startChat: ({ history }) => {
      let workingHistory = geminiHistoryToAnthropicMessages(history || []);
      return {
        sendMessage: async (payload, requestOptions) => {
          const nextMessage = typeof payload === 'string'
            ? { role: 'user' as const, content: [{ type: 'text', text: payload }] }
            : { role: 'user' as const, content: toAnthropicBlocks(payload as any[]) };

          const requestMessages = [...workingHistory, nextMessage];
          const result = await invoke(requestMessages, requestOptions?.signal);
          const assistantContent = ((result.response as any)?.__raw?.content || []) as any[];
          workingHistory = [...requestMessages, { role: 'assistant' as const, content: assistantContent }];
          return result;
        },
        getHistory: async () => anthropicHistoryToGemini(workingHistory),
      };
    },
    generateContent: async (payload: string, requestOptions?: { signal?: AbortSignal }) => {
      return invoke([{ role: 'user', content: [{ type: 'text', text: payload }] }], requestOptions?.signal);
    },
  };
}

function createModel(modelName: string, options: { systemInstruction?: string; tools?: Tool[]; rawTools?: AnyTool[]; generationConfig?: Record<string, any> }): ModelLike {
  if (isAnthropicModel(modelName)) {
    if (USE_VERTEX_ANTHROPIC) {
      return createVertexAnthropicModel(modelName, options);
    }
    if (!hasAnthropicCredentials()) {
      // Fall back when Anthropic env is unavailable at runtime.
      return createModel(GEMINI_PRO, options);
    }
    return createAnthropicModel(modelName, options);
  }

  if (USE_VERTEX_AI) {
    return createVertexModel(modelName, options);
  }

  const genAI = getClient();
  return genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: options.systemInstruction,
    tools: options.tools,
    generationConfig: options.generationConfig,
  }) as unknown as ModelLike;
}

function trimMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(80, Math.floor(maxChars * 0.65));
  const tail = Math.max(40, maxChars - head - 24);
  return `${text.slice(0, head)}\n…[trimmed for context]…\n${text.slice(-tail)}`;
}

function compactHistoryContent(role: 'user' | 'assistant', content: string): string {
  let normalized = normalizeHistoryContentForModel(content)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return '';

  if (
    role === 'assistant' &&
    normalized.length <= 160 &&
    /^(?:ok(?:ay)?|got it|working on it|looking into it|checking(?: now)?|done|thanks|noted|understood|will do)[.!]?$/i.test(normalized)
  ) {
    return '';
  }

  normalized = normalized.replace(/```([\s\S]*?)```/g, (_match, block) => {
    const clipped = trimMiddle(String(block || '').trim(), MAX_CONTEXT_CODE_BLOCK_CHARS);
    return `\`\`\`\n${clipped}\n\`\`\``;
  });

  const maxChars = normalized.startsWith('[Conversation Summary')
    ? MAX_CONTEXT_SUMMARY_CHARS
    : MAX_CONTEXT_MESSAGE_CHARS;

  return trimMiddle(normalized, maxChars);
}

function trimConversationHistory(conversationHistory: ConversationMessage[]): ConversationMessage[] {
  if (conversationHistory.length === 0) return conversationHistory;

  // Keep summarized long-term context if present, then recent detailed messages.
  const summaryMsg = conversationHistory.find(
    (m) => m.role === 'user' && m.content.startsWith('[Conversation Summary')
  );

  const recent: ConversationMessage[] = [];
  let chars = 0;
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i];
    if (summaryMsg && msg === summaryMsg) continue;
    const compactContent = compactHistoryContent(msg.role, msg.content);
    if (!compactContent) continue;
    const msgLen = compactContent.length;
    if (recent.length >= MAX_CONTEXT_MESSAGES || chars + msgLen > MAX_CONTEXT_CHARS) break;
    recent.push({ ...msg, content: compactContent });
    chars += msgLen;
  }

  recent.reverse();
  const compactSummary = summaryMsg ? compactHistoryContent(summaryMsg.role, summaryMsg.content) : '';
  const merged = compactSummary ? [{ ...summaryMsg!, content: compactSummary }, ...recent] : recent;

  // Gemini chat history must start with a user message.
  // Groupchat edge cases can occasionally leave an assistant-first history.
  while (merged.length > 0 && merged[0].role !== 'user') {
    merged.shift();
  }

  return merged;
}

function normalizeHistoryContentForModel(content: string): string {
  return content
    .replace(/^\[([^\]\r\n]{1,40})\]:\s*/u, '$1: ')
    .replace(/^\[Decision response from ([^\]]+) in #decisions\]:\s*/u, 'Decision reply from $1: ')
    .replace(/^\[Conversation Summary[^\]]*\]\s*/u, '[Conversation Summary] ')
    .trim();
}

function truncateToolResult(result: string, maxChars = DEFAULT_TOOL_RESULT_TRUNCATE_CHARS): string {
  if (result.length <= maxChars) return result;
  const importantTail = /(error|exception|traceback|stack|failed|failure|ENOENT|EACCES|ECONN|timeout|SyntaxError|TypeError|ReferenceError)/i.test(result);
  const headRatio = importantTail ? 0.60 : 0.75;
  const head = Math.max(120, Math.floor(maxChars * headRatio));
  const tail = Math.max(80, maxChars - head);
  return (
    result.slice(0, head) +
    `\n\n[Output truncated — original was ${result.length} chars]\n\n` +
    result.slice(-tail)
  );
}

function getProjectContextForAgent(agentId: string): string {
  return hasFullRepoToolAccess(agentId) ? PROJECT_CONTEXT : PROJECT_CONTEXT_LIGHT;
}

function isCacheablePrompt(agentId: string, userMessage: string, history: ConversationMessage[]): boolean {
  if (!RESPONSE_CACHE_ALLOW_TOOL_AGENTS && (agentId === 'executive-assistant' || hasFullRepoToolAccess(agentId))) return false;
  if (userMessage.length > 120) return false;
  if (history.length > 4) return false;
  if (/\b(status|latest|current|deploy|build|screenshot|usage|budget|review|fix|run|test|voice|call|log|today|now)\b/i.test(userMessage)) {
    return false;
  }
  if (/```|\n/.test(userMessage)) return false;
  return true;
}

function makeResponseCacheKey(agentId: string, userMessage: string, history: ConversationMessage[]): string {
  const normalizedMessage = userMessage.replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedHistory = history
    .slice(-2)
    .map((msg) => `${msg.role}:${normalizeHistoryContentForModel(msg.content).slice(0, 120)}`)
    .join('|');
  return `${agentId}::${normalizedMessage}::${normalizedHistory}`;
}

function getCachedResponse(key: string): string | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > RESPONSE_CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.value;
}

function setCachedResponse(key: string, value: string): void {
  responseCache.set(key, { value, ts: Date.now() });
  while (responseCache.size > RESPONSE_CACHE_MAX_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (!oldest) break;
    responseCache.delete(oldest);
  }
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Max tool-use iterations before forcing a text response. Lower defaults help stop runaway loops. */
const MAX_TOOL_ROUNDS = parseInt(process.env.MAX_TOOL_ROUNDS || '18', 10);
const MAX_TOOL_ROUNDS_DEVELOPER = parseInt(process.env.MAX_TOOL_ROUNDS_DEVELOPER || '28', 10);
const MAX_TOOL_ROUNDS_EXECUTIVE = parseInt(process.env.MAX_TOOL_ROUNDS_EXECUTIVE || '12', 10);
/** Optional one-time extra Riley pass. Default OFF to avoid runaway tool loops. */
const RILEY_AUTO_TOOL_EXTENSION = parseInt(process.env.RILEY_AUTO_TOOL_EXTENSION || '0', 10);
/** Maximum history messages to send per request (excludes current user message) */
const MAX_CONTEXT_MESSAGES = parseInt(process.env.MAX_CONTEXT_MESSAGES || '12', 10);
/** Soft cap for history character volume sent per request */
const MAX_CONTEXT_CHARS = parseInt(process.env.MAX_CONTEXT_CHARS || '4200', 10);
/** Per-message history cap so one long dump does not crowd out the rest of the context */
const MAX_CONTEXT_MESSAGE_CHARS = parseInt(process.env.MAX_CONTEXT_MESSAGE_CHARS || '750', 10);
const MAX_CONTEXT_SUMMARY_CHARS = parseInt(process.env.MAX_CONTEXT_SUMMARY_CHARS || '1000', 10);
const MAX_CONTEXT_CODE_BLOCK_CHARS = parseInt(process.env.MAX_CONTEXT_CODE_BLOCK_CHARS || '350', 10);
/**
 * Max total time for a tool loop (ms).
 * Defaults to 6 minutes to stop fire-and-forget runaway runs; set to 0 only when you explicitly want no wall-clock cap.
 */
const TOOL_LOOP_TIMEOUT = parseInt(process.env.TOOL_LOOP_TIMEOUT_MS || '360000', 10);
/** Max concurrent Gemini requests (global and per-model caps) */
const MAX_CONCURRENT = parseInt(process.env.GEMINI_MAX_CONCURRENT || '5', 10);
const MAX_CONCURRENT_FLASH = parseInt(process.env.GEMINI_MAX_CONCURRENT_FLASH || '4', 10);
const MAX_CONCURRENT_PRO = parseInt(process.env.GEMINI_MAX_CONCURRENT_PRO || '1', 10);
const VOICE_DEDICATED_LANE_ENABLED = process.env.GEMINI_VOICE_DEDICATED_LANE !== 'false';
const MAX_CONCURRENT_VOICE = parseInt(process.env.GEMINI_MAX_CONCURRENT_VOICE || '2', 10);
const MAX_CONCURRENT_BACKGROUND = parseInt(process.env.GEMINI_MAX_CONCURRENT_BACKGROUND || '1', 10);
const MAX_CONCURRENT_FLASH_VOICE = parseInt(process.env.GEMINI_MAX_CONCURRENT_FLASH_VOICE || '2', 10);
const MAX_CONCURRENT_PRO_VOICE = parseInt(process.env.GEMINI_MAX_CONCURRENT_PRO_VOICE || '1', 10);
const MAX_CONCURRENT_FLASH_BACKGROUND = parseInt(process.env.GEMINI_MAX_CONCURRENT_FLASH_BACKGROUND || '1', 10);
const MAX_CONCURRENT_PRO_BACKGROUND = parseInt(process.env.GEMINI_MAX_CONCURRENT_PRO_BACKGROUND || '1', 10);
const RESERVED_FLASH_PRIORITY_SLOTS = parseInt(process.env.GEMINI_RESERVED_FLASH_PRIORITY_SLOTS || '1', 10);
/** Base queue release delay between parallel requests (lower = faster) */
const QUEUE_RELEASE_DELAY_MS = parseInt(process.env.QUEUE_RELEASE_DELAY_MS || '120', 10);
/** Additional delay when we are inside/just after a 429 window */
const QUEUE_RELEASE_DELAY_RATE_LIMIT_MS = parseInt(process.env.QUEUE_RELEASE_DELAY_RATE_LIMIT_MS || '3000', 10);
/** Minimum delay between sends per model to avoid bursty RPM spikes */
const MODEL_PACE_FLASH_MS = parseInt(process.env.GEMINI_MODEL_PACE_FLASH_MS || '180', 10);
const MODEL_PACE_PRO_MS = parseInt(process.env.GEMINI_MODEL_PACE_PRO_MS || '700', 10);
const MODEL_PACE_FLASH_PRIORITY_MS = parseInt(process.env.GEMINI_MODEL_PACE_FLASH_PRIORITY_MS || '0', 10);
const MODEL_PACE_FLASH_VOICE_MS = parseInt(process.env.GEMINI_MODEL_PACE_FLASH_VOICE_MS || '0', 10);
const MODEL_PACE_PRO_VOICE_MS = parseInt(process.env.GEMINI_MODEL_PACE_PRO_VOICE_MS || '300', 10);

/** Lower default output tokens for faster first responses. */
const DEFAULT_MAX_OUTPUT_TOKENS = parseInt(process.env.DEFAULT_MAX_OUTPUT_TOKENS || '1000', 10);
const DEFAULT_MAX_OUTPUT_TOKENS_DEVELOPER = parseInt(process.env.DEFAULT_MAX_OUTPUT_TOKENS_DEVELOPER || '2000', 10);
const DISABLE_GEMINI_QUOTA_FUSE = process.env.DISABLE_GEMINI_QUOTA_FUSE === 'true';
const GEMINI_QUOTA_FUSE_MS = parseInt(process.env.GEMINI_QUOTA_FUSE_MS || '300000', 10);
const GEMINI_MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || '1', 10);
const GEMINI_RETRY_BASE_DELAY_MS = parseInt(process.env.GEMINI_RETRY_BASE_DELAY_MS || '1500', 10);
const GEMINI_429_PAUSE_MS = parseInt(process.env.GEMINI_429_PAUSE_MS || '25000', 10);
const GEMINI_429_JITTER_MS = parseInt(process.env.GEMINI_429_JITTER_MS || '5000', 10);
const RATE_LIMIT_FAST_FAIL_ON_429 = process.env.RATE_LIMIT_FAST_FAIL_ON_429 !== 'false';
const GEMINI_RATE_LIMIT_FUSE_HITS = parseInt(process.env.GEMINI_RATE_LIMIT_FUSE_HITS || '6', 10);
const GEMINI_RATE_LIMIT_FUSE_WINDOW_MS = parseInt(process.env.GEMINI_RATE_LIMIT_FUSE_WINDOW_MS || '180000', 10);
const GEMINI_RATE_LIMIT_FUSE_COOLDOWN_MS = parseInt(process.env.GEMINI_RATE_LIMIT_FUSE_COOLDOWN_MS || '600000', 10);
const CONTEXT_PRUNING_ENABLED = process.env.CONTEXT_PRUNING_ENABLED !== 'false';
const CONTEXT_PRUNING_TTL_MS = parseInt(process.env.CONTEXT_PRUNING_TTL_MS || '300000', 10);
const CONTEXT_PRUNING_SOFT_RATIO = parseFloat(process.env.CONTEXT_PRUNING_SOFT_RATIO || '0.30');
const CONTEXT_PRUNING_HARD_RATIO = parseFloat(process.env.CONTEXT_PRUNING_HARD_RATIO || '0.50');
const CONTEXT_PRUNING_KEEP_LAST_ASSISTANTS = parseInt(process.env.CONTEXT_PRUNING_KEEP_LAST_ASSISTANTS || '3', 10);
const CONTEXT_PRUNING_MIN_TOOL_CHARS = parseInt(process.env.CONTEXT_PRUNING_MIN_TOOL_CHARS || '50000', 10);
const CONTEXT_PRUNING_SOFT_MAX_CHARS = parseInt(process.env.CONTEXT_PRUNING_SOFT_MAX_CHARS || '4000', 10);
const CONTEXT_PRUNING_SOFT_HEAD_CHARS = parseInt(process.env.CONTEXT_PRUNING_SOFT_HEAD_CHARS || '1500', 10);
const CONTEXT_PRUNING_SOFT_TAIL_CHARS = parseInt(process.env.CONTEXT_PRUNING_SOFT_TAIL_CHARS || '1500', 10);
const CONTEXT_PRUNING_HARD_CLEAR_ENABLED = process.env.CONTEXT_PRUNING_HARD_CLEAR !== 'false';
const CONTEXT_PRUNING_HARD_PLACEHOLDER = process.env.CONTEXT_PRUNING_HARD_PLACEHOLDER || '[Old tool result content cleared]';
const CONTEXT_WINDOW_TOKENS_DEFAULT = parseInt(process.env.CONTEXT_WINDOW_TOKENS_DEFAULT || '200000', 10);
const CONTEXT_WINDOW_TOKENS_FLASH = parseInt(process.env.CONTEXT_WINDOW_TOKENS_FLASH || String(CONTEXT_WINDOW_TOKENS_DEFAULT), 10);
const CONTEXT_WINDOW_TOKENS_PRO = parseInt(process.env.CONTEXT_WINDOW_TOKENS_PRO || String(CONTEXT_WINDOW_TOKENS_DEFAULT), 10);
const CONTEXT_WINDOW_TOKENS_ANTHROPIC = parseInt(process.env.CONTEXT_WINDOW_TOKENS_ANTHROPIC || String(CONTEXT_WINDOW_TOKENS_DEFAULT), 10);
const CONTEXT_CHARS_PER_TOKEN_ESTIMATE = parseFloat(process.env.CONTEXT_CHARS_PER_TOKEN_ESTIMATE || '4');
const CONTEXT_PRUNING_TOOL_ALLOW = (process.env.CONTEXT_PRUNING_TOOL_ALLOW || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
const CONTEXT_PRUNING_TOOL_DENY = (process.env.CONTEXT_PRUNING_TOOL_DENY || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
const CONTEXT_OVERFLOW_MAX_RECOVERY_ATTEMPTS = parseInt(process.env.CONTEXT_OVERFLOW_MAX_RECOVERY_ATTEMPTS || '1', 10);
const CONTEXT_OVERFLOW_MAX_OUTPUT_REDUCTION = parseFloat(process.env.CONTEXT_OVERFLOW_MAX_OUTPUT_REDUCTION || '0.65');
const CONTEXT_OVERFLOW_MAX_TOOL_RESULT_REDUCTION = parseFloat(process.env.CONTEXT_OVERFLOW_MAX_TOOL_RESULT_REDUCTION || '0.65');
const MIN_TOOL_RESULT_TRUNCATE_CHARS = parseInt(process.env.MIN_TOOL_RESULT_TRUNCATE_CHARS || '600', 10);
const DEFAULT_TOOL_RESULT_TRUNCATE_CHARS = parseInt(process.env.DEFAULT_TOOL_RESULT_TRUNCATE_CHARS || '1800', 10);
const CONTEXT_PREEMPTIVE_GUARD_RATIO = parseFloat(process.env.CONTEXT_PREEMPTIVE_GUARD_RATIO || '0.90');
const CONTEXT_PREEMPTIVE_GUARD_ENABLED = process.env.CONTEXT_PREEMPTIVE_GUARD !== 'false';
const CACHE_TOUCH_HEARTBEAT_MS = parseInt(process.env.CACHE_TOUCH_HEARTBEAT_MS || '3300000', 10);
const CACHE_TOUCH_HEARTBEAT_ENABLED = process.env.CACHE_TOUCH_HEARTBEAT !== 'false';
let activeClaude = 0;
const claudeQueue: Array<() => void> = [];
const activeByModel = new Map<string, number>();
const modelQueues = new Map<string, Array<() => void>>();
const priorityClaudeQueue: Array<() => void> = [];
const priorityModelQueues = new Map<string, Array<() => void>>();
const modelNextAllowedAt = new Map<string, number>();
let activeVoiceClaude = 0;
const voiceClaudeQueue: Array<() => void> = [];
const activeVoiceByModel = new Map<string, number>();
const voiceModelQueues = new Map<string, Array<() => void>>();
const voiceModelNextAllowedAt = new Map<string, number>();
let activeBackgroundClaude = 0;
const backgroundClaudeQueue: Array<() => void> = [];
const activeBackgroundByModel = new Map<string, number>();
const backgroundModelQueues = new Map<string, Array<() => void>>();
const backgroundModelNextAllowedAt = new Map<string, number>();
let rateLimitNotifyCallback: ((message: string) => void | Promise<void>) | null = null;
let quotaFuseNotifyCallback: ((message: string) => void | Promise<void>) | null = null;
let lastRateLimitNotificationAt = 0;
let lastQuotaFuseNotificationAt = 0;

/**
 * Global rate-limit gate — when ANY request gets 429'd, ALL requests
 * pause until the retry-after window passes. This prevents a cascade
 * of failed requests that burn through retries for nothing.
 */
let rateLimitedUntil = 0;
let creditsExhaustedUntil = 0;
let rateLimitFuseUntil = 0;
let recentRateLimitHits: number[] = [];
const lastContextPruneAt = new Map<string, number>();
const lastCacheTouchAt = new Map<string, number>();
const laneOverflowPenalty = new Map<string, { outputPenalty: number; toolPenalty: number; observedAt: number }>();

const contextRuntimeStats = {
  prunePasses: 0,
  softTrimmedToolResults: 0,
  hardClearedToolResults: 0,
  charsSaved: 0,
  overflowRecoveries: 0,
  preemptiveGuards: 0,
  cacheHeartbeats: 0,
};

type ContextPruneStats = {
  changed: boolean;
  trimmedToolResults: number;
  hardClearedToolResults: number;
  charsBefore: number;
  charsAfter: number;
};

function formatRecoveryTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

type UsageTelemetry = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

function readUsageInt(...values: unknown[]): number {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.round(num);
  }
  return 0;
}

function extractUsageTelemetry(response: ModelResponseLike): UsageTelemetry {
  const meta = (response.usageMetadata || {}) as Record<string, unknown>;
  const raw = (response as any).__raw || {};
  const rawUsage = raw?.usage || raw?.usageMetadata || raw?.usage_metadata || {};

  return {
    inputTokens: readUsageInt(meta.promptTokenCount, rawUsage.promptTokenCount, rawUsage.input_tokens),
    outputTokens: readUsageInt(meta.candidatesTokenCount, rawUsage.candidatesTokenCount, rawUsage.output_tokens),
    cacheCreationInputTokens: readUsageInt(
      meta.cacheCreationInputTokens,
      rawUsage.cacheCreationInputTokens,
      rawUsage.cache_creation_input_tokens,
    ),
    cacheReadInputTokens: readUsageInt(
      meta.cacheReadInputTokens,
      meta.cachedContentTokenCount,
      rawUsage.cacheReadInputTokens,
      rawUsage.cache_read_input_tokens,
      rawUsage.cachedContentTokenCount,
      rawUsage.cached_content_token_count,
    ),
  };
}

function estimateHistoryChars(history: Content[]): number {
  return history.reduce((sum, entry) => sum + (entry.parts || []).reduce((partSum, part: any) => partSum + String(part?.text || '').length, 0), 0);
}

function estimateToolSchemaChars(tools: AnyTool[]): number {
  return tools.reduce(
    (sum, tool) => sum + JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.input_schema }).length,
    0,
  );
}

function estimateToolResultChars(parts: Part[]): number {
  return (parts || []).reduce((sum, part: any) => {
    const output = part?.functionResponse?.response?.output;
    return sum + String(output || '').length;
  }, 0);
}

function formatPromptBreakdownForLog(breakdown: PromptBreakdown): string {
  return `chars(sys=${breakdown.systemChars || 0},tools=${breakdown.toolsChars || 0},hist=${breakdown.historyChars || 0},user=${breakdown.userChars || 0},tool=${breakdown.toolResultChars || 0})`;
}

function buildRuntimeStatusMessage(
  userMessage: string,
  budget: { remaining: number; spent: number; limit: number },
  tokens: { used: number; remaining: number; limit: number },
): string {
  const lowBudget = budget.remaining < 0.5;
  const lowTokens = tokens.remaining < Math.max(200_000, Math.round(tokens.limit * 0.15));

  // Keep the prompt prefix stable for better cache reuse unless headroom is genuinely low.
  if (!lowBudget && !lowTokens) {
    return userMessage;
  }

  const notes = ['[Runtime status]'];
  notes.push(lowBudget
    ? `Budget is low: $${budget.remaining.toFixed(2)} remaining from a $${budget.limit.toFixed(2)} daily limit.`
    : 'Budget is healthy.');
  notes.push(lowTokens
    ? `Token headroom is low: ${tokens.remaining.toLocaleString()} remaining.`
    : 'Token headroom is healthy.');

  if (lowBudget) {
    notes.push('Keep tool use minimal and avoid broad scans.');
  }
  if (lowTokens) {
    notes.push('Prefer targeted reads, short summaries, and one-agent execution paths.');
  }

  return `${notes.join('\n')}\n\n[User request]\n${userMessage}`;
}

export function setRateLimitNotifyCallback(callback: ((message: string) => void | Promise<void>) | null): void {
  rateLimitNotifyCallback = callback;
}

export function setQuotaFuseNotifyCallback(callback: ((message: string) => void | Promise<void>) | null): void {
  quotaFuseNotifyCallback = callback;
}

function isAbortError(err: any): boolean {
  const code = String(err?.code || '');
  const name = String(err?.name || '');
  const msg = String(err?.message || err || '').toLowerCase();
  return code === 'ABORT_ERR' || name === 'AbortError' || msg.includes('aborted') || msg.includes('aborterror');
}

function isGeminiQuotaError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.statusCode;
  return (
    status === 403 ||
    msg.includes('quota') ||
    msg.includes('resource_exhausted') ||
    msg.includes('billing') ||
    msg.includes('api key not valid') ||
    msg.includes('invalid api key')
  );
}

function isGeminiRateLimitError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.statusCode;
  return status === 429 || msg.includes('rate limit') || msg.includes('too many requests');
}

function isContextOverflowError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('context window') ||
    msg.includes('maximum context length') ||
    msg.includes('prompt too long') ||
    msg.includes('prompt is too long') ||
    msg.includes('context length exceeded') ||
    msg.includes('request_too_large') ||
    msg.includes('exceeds model context') ||
    msg.includes('input token limit')
  );
}

function extractObservedOverflowTokenCount(err: any): number | undefined {
  const msg = String(err?.message || err || '');
  const patterns = [
    /prompt is too long:\s*([\d,]+)\s+tokens/i,
    /resulted in\s+([\d,]+)\s+tokens/i,
    /requested\s+([\d,]+)\s+tokens/i,
    /context window exceeded:\s*requested\s*([\d,]+)/i,
  ];
  for (const pattern of patterns) {
    const match = msg.match(pattern);
    if (!match?.[1]) continue;
    const parsed = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function getLaneOverflowPenalty(laneKey: string): { outputPenalty: number; toolPenalty: number } {
  const penalty = laneOverflowPenalty.get(laneKey);
  if (!penalty) return { outputPenalty: 0, toolPenalty: 0 };

  const ageMs = Date.now() - penalty.observedAt;
  if (ageMs > 20 * 60_000) {
    laneOverflowPenalty.delete(laneKey);
    return { outputPenalty: 0, toolPenalty: 0 };
  }

  const decay = Math.max(0, 1 - ageMs / (20 * 60_000));
  return {
    outputPenalty: penalty.outputPenalty * decay,
    toolPenalty: penalty.toolPenalty * decay,
  };
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesAnyWildcard(value: string, patterns: string[]): boolean {
  if (!value || patterns.length === 0) return false;
  return patterns.some((pattern) => wildcardToRegExp(pattern).test(value));
}

function isToolNamePrunable(toolName: string): boolean {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (!normalized) return false;
  if (CONTEXT_PRUNING_TOOL_ALLOW.length > 0 && !matchesAnyWildcard(normalized, CONTEXT_PRUNING_TOOL_ALLOW)) {
    return false;
  }
  if (CONTEXT_PRUNING_TOOL_DENY.length > 0 && matchesAnyWildcard(normalized, CONTEXT_PRUNING_TOOL_DENY)) {
    return false;
  }
  return true;
}

function getToolResultOutput(part: any): string {
  const output = part?.functionResponse?.response?.output;
  return typeof output === 'string' ? output : String(output || '');
}

function setToolResultOutput(part: any, output: string): void {
  if (!part?.functionResponse) return;
  if (!part.functionResponse.response || typeof part.functionResponse.response !== 'object') {
    part.functionResponse.response = { output };
    return;
  }
  part.functionResponse.response.output = output;
}

function estimateContextCharsWithToolResults(history: Content[]): number {
  let total = 0;
  for (const entry of history || []) {
    const parts = (entry?.parts || []) as any[];
    for (const part of parts) {
      total += String(part?.text || '').length;
      total += getToolResultOutput(part).length;
    }
  }
  return total;
}

function resolveContextWindowTokensForModel(modelName: string): number {
  const key = normalizeModelKey(modelName);
  if (key.includes('claude') || key.includes('opus') || key.includes('sonnet')) {
    return Math.max(1, CONTEXT_WINDOW_TOKENS_ANTHROPIC);
  }
  if (key.includes('pro')) {
    return Math.max(1, CONTEXT_WINDOW_TOKENS_PRO);
  }
  return Math.max(1, CONTEXT_WINDOW_TOKENS_FLASH);
}

function softTrimToolOutput(output: string): string {
  if (output.length <= CONTEXT_PRUNING_SOFT_MAX_CHARS) return output;
  const head = Math.min(Math.max(32, CONTEXT_PRUNING_SOFT_HEAD_CHARS), output.length);
  const tail = Math.min(Math.max(32, CONTEXT_PRUNING_SOFT_TAIL_CHARS), Math.max(0, output.length - head));
  const bodyTail = tail > 0 ? output.slice(-tail) : '';
  return `${output.slice(0, head)}\n\n…[tool result trimmed for context]…\n\n${bodyTail}`;
}

function findAssistantCutoffIndex(history: Content[], keepLastAssistants: number): number | null {
  if (keepLastAssistants <= 0) return history.length;
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'model') {
      seen++;
      if (seen >= keepLastAssistants) {
        return i;
      }
    }
  }
  return null;
}

function pruneContextToolResults(history: Content[], modelName: string): { history: Content[]; stats: ContextPruneStats } {
  const charsBefore = estimateContextCharsWithToolResults(history);
  const charWindow = Math.max(1, Math.floor(resolveContextWindowTokensForModel(modelName) * CONTEXT_CHARS_PER_TOKEN_ESTIMATE));
  let totalChars = charsBefore;
  const stats: ContextPruneStats = {
    changed: false,
    trimmedToolResults: 0,
    hardClearedToolResults: 0,
    charsBefore,
    charsAfter: charsBefore,
  };

  if (!history.length || totalChars / charWindow < CONTEXT_PRUNING_SOFT_RATIO) {
    return { history, stats };
  }

  const cutoffIndex = findAssistantCutoffIndex(history, CONTEXT_PRUNING_KEEP_LAST_ASSISTANTS);
  if (cutoffIndex === null) {
    return { history, stats };
  }

  const nextHistory = cloneHistory(history);
  const candidates: Array<{ part: any; output: string }> = [];

  for (let i = 0; i < cutoffIndex; i++) {
    const entry = nextHistory[i];
    if (!entry || entry.role !== 'user') continue;
    const parts = (entry.parts || []) as any[];
    for (const part of parts) {
      const toolName = String(part?.functionResponse?.name || '').trim();
      if (!toolName || !isToolNamePrunable(toolName)) continue;
      const output = getToolResultOutput(part);
      if (!output) continue;
      candidates.push({ part, output });
    }
  }

  candidates.sort((a, b) => b.output.length - a.output.length);

  for (const candidate of candidates) {
    if (candidate.output.length < CONTEXT_PRUNING_MIN_TOOL_CHARS) continue;
    const currentOutput = getToolResultOutput(candidate.part);
    const trimmed = softTrimToolOutput(currentOutput);
    if (trimmed === currentOutput) continue;
    setToolResultOutput(candidate.part, trimmed);
    totalChars -= (currentOutput.length - trimmed.length);
    stats.trimmedToolResults++;
    stats.changed = true;
    if (totalChars / charWindow < CONTEXT_PRUNING_SOFT_RATIO) {
      break;
    }
  }

  if (CONTEXT_PRUNING_HARD_CLEAR_ENABLED && totalChars / charWindow >= CONTEXT_PRUNING_HARD_RATIO) {
    for (const candidate of candidates) {
      const currentOutput = getToolResultOutput(candidate.part);
      if (!currentOutput || currentOutput === CONTEXT_PRUNING_HARD_PLACEHOLDER) continue;
      setToolResultOutput(candidate.part, CONTEXT_PRUNING_HARD_PLACEHOLDER);
      totalChars -= (currentOutput.length - CONTEXT_PRUNING_HARD_PLACEHOLDER.length);
      stats.hardClearedToolResults++;
      stats.changed = true;
      if (totalChars / charWindow < CONTEXT_PRUNING_HARD_RATIO) {
        break;
      }
    }
  }

  stats.charsAfter = Math.max(0, totalChars);
  return { history: stats.changed ? nextHistory : history, stats };
}

function applyContextPruningIfDue(params: {
  history: Content[];
  modelName: string;
  laneKey: string;
  force?: boolean;
}): { history: Content[]; stats: ContextPruneStats; applied: boolean } {
  const now = Date.now();
  const lastTouch = lastCacheTouchAt.get(params.laneKey) || 0;
  if (!params.force && (!CONTEXT_PRUNING_ENABLED || CONTEXT_PRUNING_TTL_MS <= 0 || !lastTouch || (now - lastTouch) < CONTEXT_PRUNING_TTL_MS)) {
    return {
      history: params.history,
      applied: false,
      stats: {
        changed: false,
        trimmedToolResults: 0,
        hardClearedToolResults: 0,
        charsBefore: estimateContextCharsWithToolResults(params.history),
        charsAfter: estimateContextCharsWithToolResults(params.history),
      },
    };
  }
  const result = pruneContextToolResults(params.history, params.modelName);
  lastContextPruneAt.set(params.laneKey, now);
  if (result.stats.changed) {
    contextRuntimeStats.prunePasses += 1;
    contextRuntimeStats.softTrimmedToolResults += result.stats.trimmedToolResults;
    contextRuntimeStats.hardClearedToolResults += result.stats.hardClearedToolResults;
    contextRuntimeStats.charsSaved += Math.max(0, result.stats.charsBefore - result.stats.charsAfter);
  }
  return { ...result, applied: true };
}

function markCacheTouched(laneKey: string): void {
  const now = Date.now();
  const last = lastCacheTouchAt.get(laneKey) || 0;
  if (CACHE_TOUCH_HEARTBEAT_ENABLED && CACHE_TOUCH_HEARTBEAT_MS > 0 && last > 0 && (now - last) >= CACHE_TOUCH_HEARTBEAT_MS) {
    contextRuntimeStats.cacheHeartbeats += 1;
  }
  lastCacheTouchAt.set(laneKey, now);
}

function applyPreemptiveContextGuard(params: {
  history: Content[];
  modelName: string;
  laneKey: string;
}): { history: Content[]; changed: boolean } {
  if (!CONTEXT_PREEMPTIVE_GUARD_ENABLED) {
    return { history: params.history, changed: false };
  }
  const charWindow = Math.max(1, Math.floor(resolveContextWindowTokensForModel(params.modelName) * CONTEXT_CHARS_PER_TOKEN_ESTIMATE));
  const chars = estimateContextCharsWithToolResults(params.history);
  if (chars / charWindow < CONTEXT_PREEMPTIVE_GUARD_RATIO) {
    return { history: params.history, changed: false };
  }

  const guarded = applyContextPruningIfDue({
    history: params.history,
    modelName: params.modelName,
    laneKey: params.laneKey,
    force: true,
  });
  if (guarded.stats.changed) {
    contextRuntimeStats.preemptiveGuards += 1;
  }
  return { history: guarded.history, changed: guarded.stats.changed };
}

function isAnthropicAuthError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.statusCode;
  return status === 401 || msg.includes('invalid x-api-key') || msg.includes('authentication_error');
}

function isCreditsExhaustedNow(): boolean {
  if (DISABLE_GEMINI_QUOTA_FUSE) return false;
  return creditsExhaustedUntil > Date.now();
}

function triggerGeminiQuotaFuse(): void {
  if (DISABLE_GEMINI_QUOTA_FUSE) {
    creditsExhaustedUntil = 0;
    return;
  }
  creditsExhaustedUntil = Date.now() + GEMINI_QUOTA_FUSE_MS;
  if (quotaFuseNotifyCallback && Date.now() - lastQuotaFuseNotificationAt > 10_000) {
    lastQuotaFuseNotificationAt = Date.now();
    void quotaFuseNotifyCallback(
      `⚠️ Gemini quota is exhausted. Automatic retries resume at ${formatRecoveryTime(creditsExhaustedUntil)}.`
    );
  }
}

function registerRateLimitHit(): void {
  const now = Date.now();
  recentRateLimitHits = recentRateLimitHits.filter((ts) => now - ts <= GEMINI_RATE_LIMIT_FUSE_WINDOW_MS);
  recentRateLimitHits.push(now);

  if (recentRateLimitHits.length < GEMINI_RATE_LIMIT_FUSE_HITS) return;

  rateLimitFuseUntil = Math.max(rateLimitFuseUntil, now + GEMINI_RATE_LIMIT_FUSE_COOLDOWN_MS);
  if (!DISABLE_GEMINI_QUOTA_FUSE) {
    creditsExhaustedUntil = Math.max(creditsExhaustedUntil, rateLimitFuseUntil);
  }

  if (quotaFuseNotifyCallback && now - lastQuotaFuseNotificationAt > 10_000) {
    lastQuotaFuseNotificationAt = now;
    void quotaFuseNotifyCallback(
      `⚠️ Gemini is heavily rate-limited. Fast-fail mode is active until ${formatRecoveryTime(rateLimitFuseUntil)}.`
    );
  }
}

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const blockedUntil = Math.max(rateLimitedUntil, rateLimitFuseUntil);
  if (blockedUntil > now) {
    const waitMs = blockedUntil - now;
    console.warn(`Rate-limited: pausing all Claude requests for ${Math.ceil(waitMs / 1000)}s`);
    if (rateLimitNotifyCallback && waitMs > 2000 && now - lastRateLimitNotificationAt > 10_000) {
      lastRateLimitNotificationAt = now;
      void rateLimitNotifyCallback(`⏳ Gemini API is busy — retrying in ${Math.ceil(waitMs / 1000)} seconds.`);
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

function normalizeModelKey(modelName: string): string {
  return String(modelName || '').trim().toLowerCase();
}

function getModelConcurrencyCap(modelName: string): number {
  const key = normalizeModelKey(modelName);
  return key.includes('pro') ? MAX_CONCURRENT_PRO : MAX_CONCURRENT_FLASH;
}

function getVoiceModelConcurrencyCap(modelName: string): number {
  const key = normalizeModelKey(modelName);
  return key.includes('pro') ? MAX_CONCURRENT_PRO_VOICE : MAX_CONCURRENT_FLASH_VOICE;
}

function getBackgroundModelConcurrencyCap(modelName: string): number {
  const key = normalizeModelKey(modelName);
  return key.includes('pro') ? MAX_CONCURRENT_PRO_BACKGROUND : MAX_CONCURRENT_FLASH_BACKGROUND;
}

function getModelPaceMs(modelName: string): number {
  const key = normalizeModelKey(modelName);
  return key.includes('pro') ? MODEL_PACE_PRO_MS : MODEL_PACE_FLASH_MS;
}

function getPriorityModelPaceMs(modelName: string): number {
  const key = normalizeModelKey(modelName);
  return key.includes('pro') ? MODEL_PACE_PRO_MS : MODEL_PACE_FLASH_PRIORITY_MS;
}

function getVoiceModelPaceMs(modelName: string): number {
  const key = normalizeModelKey(modelName);
  return key.includes('pro') ? MODEL_PACE_PRO_VOICE_MS : MODEL_PACE_FLASH_VOICE_MS;
}

function getBackgroundModelQueue(modelKey: string): Array<() => void> {
  const existing = backgroundModelQueues.get(modelKey);
  if (existing) return existing;
  const created: Array<() => void> = [];
  backgroundModelQueues.set(modelKey, created);
  return created;
}

function getModelQueue(modelKey: string): Array<() => void> {
  const existing = modelQueues.get(modelKey);
  if (existing) return existing;
  const created: Array<() => void> = [];
  modelQueues.set(modelKey, created);
  return created;
}

function getPriorityModelQueue(modelKey: string): Array<() => void> {
  const existing = priorityModelQueues.get(modelKey);
  if (existing) return existing;
  const created: Array<() => void> = [];
  priorityModelQueues.set(modelKey, created);
  return created;
}

function getVoiceModelQueue(modelKey: string): Array<() => void> {
  const existing = voiceModelQueues.get(modelKey);
  if (existing) return existing;
  const created: Array<() => void> = [];
  voiceModelQueues.set(modelKey, created);
  return created;
}

async function waitForModelPace(modelName: string, priority = false, lane: 'text' | 'voice' | 'background' = 'text'): Promise<void> {
  const modelKey = normalizeModelKey(modelName);
  const now = Date.now();
  const nextAllowed = lane === 'voice'
    ? (voiceModelNextAllowedAt.get(modelKey) || 0)
    : lane === 'background'
      ? (backgroundModelNextAllowedAt.get(modelKey) || 0)
      : (modelNextAllowedAt.get(modelKey) || 0);
  if (nextAllowed > now) {
    await new Promise((resolve) => setTimeout(resolve, nextAllowed - now));
  }
}

function releaseNextQueued(modelKey: string, lane: 'text' | 'voice' | 'background' = 'text'): void {
  const releaseDelay = rateLimitedUntil > Date.now()
    ? QUEUE_RELEASE_DELAY_RATE_LIMIT_MS
    : QUEUE_RELEASE_DELAY_MS;

  if (lane === 'voice') {
    const sameVoiceQueue = getVoiceModelQueue(modelKey);
    const sameVoice = sameVoiceQueue.shift();
    if (sameVoice) {
      setTimeout(sameVoice, releaseDelay);
      return;
    }

    const globalVoiceNext = voiceClaudeQueue.shift();
    if (globalVoiceNext) {
      setTimeout(globalVoiceNext, releaseDelay);
      return;
    }

    for (const queue of voiceModelQueues.values()) {
      const next = queue.shift();
      if (next) {
        setTimeout(next, releaseDelay);
        return;
      }
    }
    return;
  }

  if (lane === 'background') {
    const sameBackgroundQueue = getBackgroundModelQueue(modelKey);
    const sameBackground = sameBackgroundQueue.shift();
    if (sameBackground) {
      setTimeout(sameBackground, releaseDelay);
      return;
    }

    const globalBackgroundNext = backgroundClaudeQueue.shift();
    if (globalBackgroundNext) {
      setTimeout(globalBackgroundNext, releaseDelay);
      return;
    }

    for (const queue of backgroundModelQueues.values()) {
      const next = queue.shift();
      if (next) {
        setTimeout(next, releaseDelay);
        return;
      }
    }
    return;
  }

  const samePriorityQueue = getPriorityModelQueue(modelKey);
  const samePriority = samePriorityQueue.shift();
  if (samePriority) {
    setTimeout(samePriority, releaseDelay);
    return;
  }

  const globalPriorityNext = priorityClaudeQueue.shift();
  if (globalPriorityNext) {
    setTimeout(globalPriorityNext, releaseDelay);
    return;
  }

  // Prefer waking requests waiting on the same model first.
  const sameQueue = getModelQueue(modelKey);
  const same = sameQueue.shift();
  if (same) {
    setTimeout(same, releaseDelay);
    return;
  }

  // Fall back to global queue, then any other model queue.
  const globalNext = claudeQueue.shift();
  if (globalNext) {
    setTimeout(globalNext, releaseDelay);
    return;
  }

  for (const queue of modelQueues.values()) {
    const next = queue.shift();
    if (next) {
      setTimeout(next, releaseDelay);
      return;
    }
  }
}

async function withConcurrencyLimit<T>(
  modelName: string,
  fn: () => Promise<T>,
  lane: 'normal' | 'voice' | 'background' = 'normal',
): Promise<T> {
  const modelKey = normalizeModelKey(modelName);

  if (lane === 'voice' && VOICE_DEDICATED_LANE_ENABLED) {
    const modelCap = Math.max(1, getVoiceModelConcurrencyCap(modelName));
    const globalCap = Math.max(1, MAX_CONCURRENT_VOICE);

    await waitForRateLimit();
    while (activeVoiceClaude >= globalCap || (activeVoiceByModel.get(modelKey) || 0) >= modelCap) {
      if (activeVoiceClaude >= globalCap) {
        await new Promise<void>((resolve) => voiceClaudeQueue.push(resolve));
      } else {
        await new Promise<void>((resolve) => getVoiceModelQueue(modelKey).push(resolve));
      }
      await waitForRateLimit();
    }

    await waitForModelPace(modelName, true, 'voice');
    activeVoiceClaude++;
    activeVoiceByModel.set(modelKey, (activeVoiceByModel.get(modelKey) || 0) + 1);

    try {
      return await fn();
    } finally {
      activeVoiceClaude--;
      const remaining = Math.max(0, (activeVoiceByModel.get(modelKey) || 0) - 1);
      if (remaining === 0) {
        activeVoiceByModel.delete(modelKey);
      } else {
        activeVoiceByModel.set(modelKey, remaining);
      }
      voiceModelNextAllowedAt.set(modelKey, Date.now() + getVoiceModelPaceMs(modelName));
      releaseNextQueued(modelKey, 'voice');
    }
  }

  if (lane === 'background') {
    const modelCap = Math.max(1, getBackgroundModelConcurrencyCap(modelName));
    const globalCap = Math.max(1, MAX_CONCURRENT_BACKGROUND);

    await waitForRateLimit();
    while (activeBackgroundClaude >= globalCap || (activeBackgroundByModel.get(modelKey) || 0) >= modelCap) {
      if (activeBackgroundClaude >= globalCap) {
        await new Promise<void>((resolve) => backgroundClaudeQueue.push(resolve));
      } else {
        await new Promise<void>((resolve) => getBackgroundModelQueue(modelKey).push(resolve));
      }
      await waitForRateLimit();
    }

    await waitForModelPace(modelName, false, 'background');
    activeBackgroundClaude++;
    activeBackgroundByModel.set(modelKey, (activeBackgroundByModel.get(modelKey) || 0) + 1);

    try {
      return await fn();
    } finally {
      activeBackgroundClaude--;
      const remaining = Math.max(0, (activeBackgroundByModel.get(modelKey) || 0) - 1);
      if (remaining === 0) {
        activeBackgroundByModel.delete(modelKey);
      } else {
        activeBackgroundByModel.set(modelKey, remaining);
      }
      backgroundModelNextAllowedAt.set(modelKey, Date.now() + getModelPaceMs(modelName));
      releaseNextQueued(modelKey, 'background');
    }
  }

  const modelCap = getModelConcurrencyCap(modelName);
  const isFlash = !modelKey.includes('pro');
  const reservedSlots = !isFlash ? 0 : Math.max(0, RESERVED_FLASH_PRIORITY_SLOTS);
  const globalCap = Math.max(1, MAX_CONCURRENT - reservedSlots);
  const effectiveModelCap = Math.max(1, modelCap - reservedSlots);

  await waitForRateLimit();
  while (activeClaude >= globalCap || (activeByModel.get(modelKey) || 0) >= effectiveModelCap) {
    if (activeClaude >= globalCap) {
      await new Promise<void>((resolve) => claudeQueue.push(resolve));
    } else {
      await new Promise<void>((resolve) => getModelQueue(modelKey).push(resolve));
    }
    await waitForRateLimit();
  }

  await waitForModelPace(modelName, false, 'text');
  activeClaude++;
  activeByModel.set(modelKey, (activeByModel.get(modelKey) || 0) + 1);

  try {
    return await fn();
  } finally {
    activeClaude--;
    const remaining = Math.max(0, (activeByModel.get(modelKey) || 0) - 1);
    if (remaining === 0) {
      activeByModel.delete(modelKey);
    } else {
      activeByModel.set(modelKey, remaining);
    }
    modelNextAllowedAt.set(modelKey, Date.now() + getModelPaceMs(modelName));
    releaseNextQueued(modelKey, 'text');
  }
}

function estimateMaxOutputTokens(agentId: string, userMessage: string, explicit?: number): number {
  if (explicit && explicit > 0) return explicit;

  const base = agentId === 'developer'
    ? DEFAULT_MAX_OUTPUT_TOKENS_DEVELOPER
    : DEFAULT_MAX_OUTPUT_TOKENS;

  // Fast-path: short user asks usually don't need large output budgets.
  const shortPrompt = userMessage.length <= 180;
  const appearsSimple = /^(ok|yes|no|status|ping|why|what|how|help|fix|run|test)\b/i.test(userMessage.trim());
  if (shortPrompt || appearsSimple) {
    return Math.min(base, 900);
  }

  return base;
}

function resolveAdaptiveMaxOutputTokens(params: {
  agentId: string;
  userMessage: string;
  explicit?: number;
  modelName: string;
  promptCharsEstimate: number;
  laneKey?: string;
}): number {
  const requested = estimateMaxOutputTokens(params.agentId, params.userMessage, params.explicit);
  const contextWindowTokens = resolveContextWindowTokensForModel(params.modelName);
  const promptTokensEstimate = Math.ceil(Math.max(0, params.promptCharsEstimate) / Math.max(1, CONTEXT_CHARS_PER_TOKEN_ESTIMATE));

  // Keep healthy headroom for provider framing + tool wrappers.
  const reservedTokens = Math.max(512, Math.floor(contextWindowTokens * 0.15));
  const available = Math.max(128, contextWindowTokens - promptTokensEstimate - reservedTokens);
  const overflowPenalty = params.laneKey
    ? getLaneOverflowPenalty(params.laneKey).outputPenalty
    : 0;
  const penaltyFactor = Math.max(0.35, 1 - Math.min(CONTEXT_OVERFLOW_MAX_OUTPUT_REDUCTION, overflowPenalty));
  const capped = Math.min(requested, Math.max(128, Math.floor(contextWindowTokens * 0.30)), available);
  return Math.max(128, Math.floor(capped * penaltyFactor));
}

async function withRetry<T>(fn: () => Promise<T>, retries = GEMINI_MAX_RETRIES, delayMs = GEMINI_RETRY_BASE_DELAY_MS): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      // User interruption/cancellation should stop immediately without retries
      if (isAbortError(err)) throw err;
      if (i === retries) throw err;
      const status = err?.status || err?.statusCode;
      // Only retry on transient errors (5xx, network, 429 rate limit)
      if (status && status < 500 && status !== 429) throw err;

      let delay: number;
      if (status === 429) {
        recordRateLimitHit();
        registerRateLimitHit();
        const halfJitter = Math.max(0, Math.floor(GEMINI_429_JITTER_MS / 2));
        const jitter = Math.floor(Math.random() * (halfJitter * 2 + 1)) - halfJitter;
        delay = Math.max(5000, GEMINI_429_PAUSE_MS + jitter);
        // Global gate uses the upper bound (without negative jitter) so it's conservative.
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + Math.max(5000, GEMINI_429_PAUSE_MS + halfJitter));
        console.warn(`429 rate limited — pausing ${Math.ceil(delay / 1000)}s (±jitter, retry ${i + 1}/${retries})`);
        logAgentEvent('system', 'rate_limit', `429 — pausing ${Math.ceil(delay / 1000)}s`);
        if (RATE_LIMIT_FAST_FAIL_ON_429) throw err;
      } else {
        delay = delayMs * Math.pow(2, i);
        console.warn(`Gemini retry ${i + 1}/${retries} after ${delay}ms: ${err?.message || 'Unknown'}`);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

function mergeStreamedText(previous: string, incoming: string): string {
  if (!incoming) return previous;
  if (!previous) return incoming;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.endsWith(incoming)) return previous;
  return previous + incoming;
}

async function sendMessageWithOptionalStream(
  chat: any,
  payload: string | Part[],
  signal?: AbortSignal,
  onPartialText?: (partialText: string) => Promise<void>
): Promise<any> {
  const requestOptions = signal ? { signal } : undefined;
  const canStreamText = typeof payload === 'string';
  if (!onPartialText || !canStreamText || typeof chat?.sendMessageStream !== 'function') {
    return chat.sendMessage(payload, requestOptions);
  }

  const streamResult = await chat.sendMessageStream(payload, requestOptions);
  let accumulated = '';

  for await (const chunk of streamResult.stream) {
    if (signal?.aborted) break;
    let text = '';
    try {
      text = typeof chunk?.text === 'function' ? String(chunk.text() || '') : '';
    } catch {
      text = '';
    }
    if (!text) continue;
    accumulated = mergeStreamedText(accumulated, text);
    await onPartialText(accumulated);
  }

  const finalResponse = await streamResult.response;
  return { response: finalResponse };
}

/**
 * Send a message to Claude as a specific agent and get a response.
 * The agent has access to repo tools (read, write, search, execute) and will
 * loop using tool_use until it produces a final text response.
 * onToolUse callback is called each time the agent invokes a tool — useful for
 * posting live updates to Discord.
 */
export async function agentRespond(
  agent: AgentConfig,
  conversationHistory: ConversationMessage[],
  userMessage: string,
  onToolUse?: (toolName: string, summary: string) => Promise<void>,
  options?: {
    modelOverride?: string;
    maxTokens?: number;
    signal?: AbortSignal;
    onPartialText?: (partialText: string) => Promise<void>;
    toolRoundBoost?: number;
    rileyAutoToolApprovalUsed?: boolean;
    disableTools?: boolean;
    priority?: 'normal' | 'voice' | 'background';
    chatSession?: ReusableAgentChatSession;
  }
): Promise<string> {
  const cacheEligible = isCacheablePrompt(agent.id, userMessage, conversationHistory);
  const lane = options?.priority || 'normal';
  const isVoiceLane = lane === 'voice';
  const pruneLaneKey = `${agent.id}:${lane}`;
  const cacheKey = cacheEligible ? makeResponseCacheKey(agent.id, userMessage, conversationHistory) : null;
  if (cacheKey) {
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      logAgentEvent(agent.id, 'response', `cache-hit response="${cached.slice(0, 200)}"`);
      return cached;
    }
  }

  const baseToolRounds = agent.id === 'developer'
    ? MAX_TOOL_ROUNDS_DEVELOPER
    : agent.id === 'executive-assistant'
      ? MAX_TOOL_ROUNDS_EXECUTIVE
      : MAX_TOOL_ROUNDS;
  const maxToolRounds = baseToolRounds + Math.max(0, options?.toolRoundBoost || 0);
  let autoBudgetPassesUsed = 0;

  if (isCreditsExhaustedNow()) {
    const recoveryTime = formatRecoveryTime(creditsExhaustedUntil);
    return agent.id === 'executive-assistant'
      ? `⚠️ Gemini quota is exhausted right now. Automatic retries resume at ${recoveryTime}. Pause the team and ask Jordan to check Google Cloud billing before more work continues.`
      : `⚠️ Gemini quota is exhausted right now. Automatic retries resume at ${recoveryTime}. Ask Riley to request Jordan approval for more credits before continuing.`;
  }

  // Hard budget gate — auto-extend when enabled, else stop.
  if (isBudgetExceeded()) {
    if (RILEY_AUTO_APPROVE_BUDGET && autoBudgetPassesUsed < RILEY_AUTO_APPROVE_BUDGET_MAX_PASSES) {
      const approved = approveAdditionalBudget(RILEY_AUTO_APPROVE_BUDGET_INCREMENT);
      autoBudgetPassesUsed += 1;
      logAgentEvent(
        agent.id,
        'response',
        `Auto-approved budget +$${approved.added.toFixed(2)} (new limit $${approved.limit.toFixed(2)}, remaining $${approved.remaining.toFixed(2)})`
      );
    }
  }

  if (isBudgetExceeded()) {
    const { spent, limit } = getRemainingBudget();
    logAgentEvent(agent.id, 'error', `Budget exceeded: $${spent.toFixed(2)}/$${limit.toFixed(2)}`);
    return agent.id === 'executive-assistant'
      ? `⚠️ Daily budget of $${limit.toFixed(2)} has been reached ($${spent.toFixed(2)} spent) and runtime auto-approval could not clear it. Pause the team only now and ask Jordan whether he wants more budget before work resumes.`
      : `⚠️ Daily budget of $${limit.toFixed(2)} has been reached ($${spent.toFixed(2)} spent) and runtime auto-approval could not clear it. Ask Riley to escalate only if she confirms the budget gate is still blocking.`;
  }

  const hasFullRepoTools = hasFullRepoToolAccess(agent.id);
  const { remaining, spent, limit } = getRemainingBudget();
  const { used: tokenUsed, remaining: tokenRemaining, limit: tokenLimit } = getClaudeTokenStatus();

  const rileyCoordination = agent.id === 'executive-assistant' ? `
AGENT COORDINATION: Coordinate agents via Discord mentions in your response text. The system parses and routes automatically.
Prefer exact role mentions supplied in the live conversation context. If no exact mention tokens are provided, use canonical handles like @ace, @max, @sophie, @kane, @raj, @elena, @kai, @jude, @liv, @harper, @mia, and @leo.
CRITICAL: Do NOT use send_channel_message — use Discord mentions for agent coordination.
    DEFAULT: When work needs execution, start with @ace only. Ace is the tool master and should bring in other specialists only if they are actually needed.
` : '';

  const budgetGovernance = RILEY_AUTO_APPROVE_BUDGET
    ? `
- Budget autopilot is enabled. If the runtime budget gate trips, it may auto-approve additional budget in $${RILEY_AUTO_APPROVE_BUDGET_INCREMENT.toFixed(2)} increments for you.
- Do NOT ask Jordan for budget approval merely because budget is low or because you see a warning. Keep working unless you receive an explicit hard budget block after auto-approval has already been attempted.
`
    : `
- When the team hits a limit, pause the work, explain what increase is needed, and ask Jordan for explicit approval before anyone resumes.
`;

  const workerBudgetGovernance = RILEY_AUTO_APPROVE_BUDGET
    ? `
- Budget autopilot is enabled through Riley/runtime. Do not suggest stopping for budget unless Riley explicitly confirms a hard budget block remains after auto-approval.
`
    : `
- Riley is the token master. Never ask Jordan directly for more tokens, budget, or credits. Ask Riley so she can seek approval.
`;

  const governanceSection = agent.id === 'executive-assistant' ? `
GOVERNANCE:
- You are Jordan's token master. Any request to increase Gemini tokens, Google Cloud credits, ElevenLabs credit, or daily budget must come through you.
- Only escalate budget to Jordan if a hard budget block remains after runtime auto-approval has already been attempted.
- Ace is the Tool Master. If tooling is missing, stale, or unreliable, direct @ace to prepare it before the rest of the team proceeds.
- If a run hits the safety cap, restart with a tighter prompt or hand it to the best specialist instead of letting one loop sprawl.
- If you state that a deployment/screenshots/URL/cleanup action is happening, you MUST include explicit action tags in the same message: [ACTION:DEPLOY], [ACTION:SCREENSHOTS], [ACTION:URLS], [ACTION:CLEANUP:<count>].
- You are allowed to self-improve: if your own orchestration/routing/tooling is causing friction, direct @ace to patch the Discord bot code and deploy the improvement in the same run.
- If groupchat gets noisy/disjointed, run [ACTION:CLEANUP:<count>] to delete recent bot/webhook clutter before posting the consolidated update.
${budgetGovernance}
` : agent.id === 'developer' ? `
GOVERNANCE:
- You are the Tool Master. Own tool readiness for the whole team.
- Keep .github/AGENT_TOOLING_STATUS.md accurate, make missing tools available where possible, and confirm readiness before other agents depend on them.
- Riley is the token master. If more budget, credits, or token headroom is needed, report that to Riley instead of asking Jordan directly.
- If a run stops at the safety cap, report the current state clearly and wait for a tighter follow-up prompt.
${workerBudgetGovernance}
` : `
GOVERNANCE:
- Riley is the token master. Never ask Jordan directly for more tokens, budget, or credits. Ask Riley so she can seek approval.
- Ace is the Tool Master. Before tool-heavy work, or anytime tool readiness is uncertain, check with @ace first and wait for the green light.
- If a run stops at the safety cap, report the current state clearly and wait for a tighter follow-up prompt.
${workerBudgetGovernance}
`;

  const toolsSection = agent.id === 'executive-assistant'
    ? `\nYou have a deliberately lean coordination/ops tool set. Prefer delegating code edits, deployments, and destructive changes to the best specialist instead of doing them yourself.`
    : hasFullRepoTools
      ? `\nYou can use the full repo, infra, and Discord tool surface when needed. Stay focused and avoid broad or repetitive scans.`
      : `\nYou can use analysis tools plus operational testing tools (GCP, screenshots, and mobile harness). Repository write tools remain restricted.`;

  const systemPrompt = `${agent.systemPrompt}

<project_context>
${getProjectContextForAgent(agent.id)}
</project_context>

You are "${agent.name}" responding in Discord.${rileyCoordination}
RULES: Max 220 words (code exempt). Speak like a real teammate, not a ticket template. Lead with the useful part.${toolsSection}
AUTHORITY: Any human team member in Discord can request work and should get help. Do not ignore requests because they are not Jordan. Jordan approval is only required for budget/credit increases.
When doing work, explain a bit more than before: what you're doing, why you're doing it, and what happened.
Default format (lightweight, not rigid): 1) action taken, 2) key result, 3) immediate next step or blocker (if any).
If the ask is simple (status check, direct answer, yes/no, one-step clarification), answer in 1-3 short sentences and skip the default status structure.
If you are asking for a decision, stop after presenting the decision and options. Do not continue with an assumption unless the user explicitly told you to proceed by default.
Use short paragraphs or bullets when helpful. Do not pad with fluff.
Formatting for Discord readability:
- Do not use Markdown headings (#, ##, etc.).
- Avoid excessive bolding. Only bold critical labels or exact decisions.
- Keep one visual style per message (plain text + simple bullets is preferred).
Never dump long tool output. Summarize the important result only.
Never start your visible reply with your own name, a role label, or bracketed speaker text such as "[Liv]:" or "Riley:".
Describe your role and capabilities plainly. Never call yourself "supreme", say you have "absolute authority", or claim unrestricted control. Do not exaggerate authority, status, or trust relationships.
Tooling: Ace owns tool readiness. Check .github/AGENT_TOOLING_STATUS.md first. If tooling looks stale or a required tool may not be ready, coordinate with @ace before relying on it.
${governanceSection}
RUNTIME EFFICIENCY:
- Runtime budget and token status will be supplied separately in the task context.
- Each tool call costs tokens. Prefer targeted reads, concise summaries, and the narrowest agent/tool path that can finish the job.`;

  // Convert conversation history to Gemini Content format.
  // Reused chat sessions already carry prior turns, so skip rebuilding history.
  let currentModelName = options?.modelOverride || options?.chatSession?.modelName || (isVoiceLane ? VOICE_FAST_MODEL : modelForAgent(agent.id, userMessage));
  let escalatedToPro = currentModelName === GEMINI_PRO;

  const trimmedHistory = options?.chatSession?.chat ? [] : trimConversationHistory(conversationHistory);
  let history: Content[] = trimmedHistory.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: normalizeHistoryContentForModel(msg.content) }],
  }));
  const prunedInitialHistory = applyContextPruningIfDue({ history, modelName: currentModelName, laneKey: pruneLaneKey });
  history = prunedInitialHistory.history;

  const agentTools = options?.disableTools ? [] : toolsForPrompt(agent.id, userMessage);
  const geminiTools = toGeminiTools(agentTools);
  let promptHistory = options?.chatSession?.chat
    ? await options.chatSession.chat.getHistory().catch(() => [] as Content[])
    : history;
  if (options?.chatSession?.chat && CONTEXT_PRUNING_ENABLED) {
    const sessionPrune = applyContextPruningIfDue({
      history: promptHistory,
      modelName: currentModelName,
      laneKey: pruneLaneKey,
    });
    if (sessionPrune.stats.changed) {
      history = sessionPrune.history;
      promptHistory = sessionPrune.history;
    }
  }
  const runtimeUserMessage = buildRuntimeStatusMessage(
    userMessage,
    { remaining, spent, limit },
    { used: tokenUsed, remaining: tokenRemaining, limit: tokenLimit },
  );
  const basePromptBreakdown: PromptBreakdown = {
    systemChars: systemPrompt.length,
    historyChars: estimateHistoryChars(promptHistory),
    toolsChars: estimateToolSchemaChars(agentTools),
  };
  let pendingPromptBreakdown: PromptBreakdown = {
    ...basePromptBreakdown,
    userChars: runtimeUserMessage.length,
    toolResultChars: 0,
  };

  const guardedInitial = applyPreemptiveContextGuard({
    history,
    modelName: currentModelName,
    laneKey: pruneLaneKey,
  });
  if (guardedInitial.changed) {
    history = guardedInitial.history;
  }

  logAgentEvent(agent.id, 'invoke', `model=${currentModelName}, context=${trimmedHistory.length} msgs, ${formatPromptBreakdownForLog(pendingPromptBreakdown)}, prompt="${userMessage.slice(0, 200)}"`);

  if (options?.signal?.aborted) return '';

  const loopStart = Date.now();
  let totalToolCalls = 0;
  const initialLanePenalty = getLaneOverflowPenalty(pruneLaneKey);
  let toolResultTruncateChars = Math.max(
    MIN_TOOL_RESULT_TRUNCATE_CHARS,
    Math.floor(DEFAULT_TOOL_RESULT_TRUNCATE_CHARS * Math.max(0.35, 1 - Math.min(CONTEXT_OVERFLOW_MAX_TOOL_RESULT_REDUCTION, initialLanePenalty.toolPenalty))),
  );

  const makeModel = (modelName: string) => createModel(modelName, {
    systemInstruction: systemPrompt,
    tools: geminiTools,
    rawTools: agentTools,
    generationConfig: {
      maxOutputTokens: resolveAdaptiveMaxOutputTokens({
        agentId: agent.id,
        userMessage,
        explicit: options?.maxTokens,
        modelName,
        promptCharsEstimate:
          (pendingPromptBreakdown.systemChars || 0) +
          (pendingPromptBreakdown.historyChars || 0) +
          (pendingPromptBreakdown.toolsChars || 0) +
          (pendingPromptBreakdown.userChars || 0) +
          (pendingPromptBreakdown.toolResultChars || 0),
        laneKey: pruneLaneKey,
      }),
    },
  });

  let model = options?.chatSession?.chat ? null : makeModel(currentModelName);
  let chat = options?.chatSession?.chat || model!.startChat({ history });
  if (options?.chatSession && !options.chatSession.chat) {
    options.chatSession.chat = chat;
    options.chatSession.modelName = currentModelName;
  }

  const swapToModel = async (nextModelName: string, nextHistory: Content[]): Promise<void> => {
    currentModelName = nextModelName;
    model = makeModel(nextModelName);
    chat = model.startChat({ history: nextHistory });
    if (options?.chatSession) {
      options.chatSession.chat = chat;
      options.chatSession.modelName = currentModelName;
    }
  };

  const recoverContextOverflowAndRetry = async (
    payload: string | Part[],
    err: any,
  ): Promise<ModelResultLike | null> => {
    if (!isContextOverflowError(err) || CONTEXT_OVERFLOW_MAX_RECOVERY_ATTEMPTS < 1) {
      return null;
    }
    let accumulatedHistory = await chat.getHistory().catch(() => [] as Content[]);
    if (!accumulatedHistory.length) return null;

    const aggressive = applyContextPruningIfDue({
      history: accumulatedHistory,
      modelName: currentModelName,
      laneKey: pruneLaneKey,
      force: true,
    });

    if (!aggressive.stats.changed) {
      // Retry with a strict one-shot tool result truncation pass when pruning did not change anything.
      const fallback = pruneContextToolResults(accumulatedHistory, currentModelName);
      if (!fallback.stats.changed) return null;
      accumulatedHistory = fallback.history;
    } else {
      accumulatedHistory = aggressive.history;
    }

    await swapToModel(currentModelName, accumulatedHistory);
    const observedOverflowTokens = extractObservedOverflowTokenCount(err);
    const currentPenalty = laneOverflowPenalty.get(pruneLaneKey) || { outputPenalty: 0, toolPenalty: 0, observedAt: Date.now() };
    const overflowScale = observedOverflowTokens && observedOverflowTokens > 0
      ? Math.min(1, observedOverflowTokens / Math.max(1, resolveContextWindowTokensForModel(currentModelName)))
      : 0.5;
    const outputPenalty = Math.min(
      CONTEXT_OVERFLOW_MAX_OUTPUT_REDUCTION,
      currentPenalty.outputPenalty + (0.2 * overflowScale),
    );
    const toolPenalty = Math.min(
      CONTEXT_OVERFLOW_MAX_TOOL_RESULT_REDUCTION,
      currentPenalty.toolPenalty + (0.25 * overflowScale),
    );
    laneOverflowPenalty.set(pruneLaneKey, { outputPenalty, toolPenalty, observedAt: Date.now() });
    const toolPenaltyFactor = Math.max(0.35, 1 - toolPenalty);
    toolResultTruncateChars = Math.max(
      MIN_TOOL_RESULT_TRUNCATE_CHARS,
      Math.floor(DEFAULT_TOOL_RESULT_TRUNCATE_CHARS * toolPenaltyFactor),
    );
    contextRuntimeStats.overflowRecoveries += 1;
    logAgentEvent(
      agent.id,
      'response',
      `Recovered from context overflow by pruning tool results (trimmed=${aggressive.stats.trimmedToolResults}, cleared=${aggressive.stats.hardClearedToolResults}, outputPenalty=${outputPenalty.toFixed(2)}, toolCap=${toolResultTruncateChars})`,
    );
    return withConcurrencyLimit(currentModelName, () =>
      withRetry(() => sendMessageWithOptionalStream(chat, payload, options?.signal, options?.onPartialText))
    , lane);
  };

  // Send initial user message
  let response;
  try {
    const historyBeforeSend = await chat.getHistory().catch(() => [] as Content[]);
    if (historyBeforeSend.length > 0) {
      const guarded = applyPreemptiveContextGuard({ history: historyBeforeSend, modelName: currentModelName, laneKey: pruneLaneKey });
      if (guarded.changed) {
        await swapToModel(currentModelName, guarded.history);
      }
    }
    response = await withConcurrencyLimit(currentModelName, () =>
      withRetry(() => sendMessageWithOptionalStream(chat, runtimeUserMessage, options?.signal, options?.onPartialText))
    , lane);
    markCacheTouched(pruneLaneKey);
    const lanePenalty = laneOverflowPenalty.get(pruneLaneKey);
    if (lanePenalty) {
      lanePenalty.outputPenalty = Math.max(0, lanePenalty.outputPenalty - 0.04);
      lanePenalty.toolPenalty = Math.max(0, lanePenalty.toolPenalty - 0.04);
      lanePenalty.observedAt = Date.now();
      if (lanePenalty.outputPenalty <= 0.01 && lanePenalty.toolPenalty <= 0.01) {
        laneOverflowPenalty.delete(pruneLaneKey);
        toolResultTruncateChars = DEFAULT_TOOL_RESULT_TRUNCATE_CHARS;
      }
    }
  } catch (err: any) {
    const recovered = await recoverContextOverflowAndRetry(runtimeUserMessage, err);
    if (recovered) {
      response = recovered;
      markCacheTouched(pruneLaneKey);
    } else {
    if (isAbortError(err)) {
      logAgentEvent(agent.id, 'error', 'Request interrupted by user', { durationMs: Date.now() - loopStart });
      return '';
    }
    if (isAnthropicModel(currentModelName) && isAnthropicAuthError(err)) {
      logAgentEvent(agent.id, 'error', 'Anthropic auth failed — falling back to Gemini Pro');
      await swapToModel(GEMINI_PRO, history);
      response = await withConcurrencyLimit(currentModelName, () =>
        withRetry(() => sendMessageWithOptionalStream(chat, runtimeUserMessage, options?.signal, options?.onPartialText))
      , lane);
    } else if (isGeminiRateLimitError(err)) {
      const recoverAt = Math.max(rateLimitedUntil, Date.now() + GEMINI_429_PAUSE_MS);
      return `⏳ Gemini is currently rate-limited (throughput), not out of credit. Please retry after ${formatRecoveryTime(recoverAt)} or reduce parallel requests.`;
    } else if (isGeminiQuotaError(err)) {
      triggerGeminiQuotaFuse();
      logAgentEvent(agent.id, 'error', 'Gemini quota exhausted');
      return agent.id === 'executive-assistant'
        ? (DISABLE_GEMINI_QUOTA_FUSE
            ? '⚠️ Gemini rejected that request. The local quota pause is disabled, so the team can keep trying, but upstream Google limits may still reject individual requests.'
            : `⚠️ Gemini quota is exhausted. Automatic retries resume at ${formatRecoveryTime(creditsExhaustedUntil)}. Pause the team and ask Jordan to top up Google Cloud billing.`)
        : (DISABLE_GEMINI_QUOTA_FUSE
            ? '⚠️ Gemini rejected that request, but the local quota pause is disabled. Retry or continue with other work.'
            : `⚠️ Gemini quota is exhausted right now. Automatic retries resume at ${formatRecoveryTime(creditsExhaustedUntil)}. Ask Riley to request Jordan approval for more credits before continuing.`);
    } else {
      throw err;
    }
    }
  }

  // Tool-use loop
  const WRITE_TOOLS = new Set([
    'write_file', 'edit_file', 'batch_edit',
    'run_command',
    'git_create_branch', 'create_pull_request', 'merge_pull_request', 'add_pr_comment',
    'delete_channel', 'create_channel', 'rename_channel', 'set_channel_topic',
    'send_channel_message', 'clear_channel_messages', 'delete_category', 'move_channel',
    'gcp_build_image', 'gcp_deploy', 'gcp_set_env', 'gcp_rollback', 'gcp_secret_set', 'gcp_secret_bind', 'gcp_vm_ssh',
    'memory_write', 'memory_append',
    'db_query',
    'capture_screenshots',
    'mobile_harness_start', 'mobile_harness_step', 'mobile_harness_snapshot', 'mobile_harness_stop',
  ]);

  for (let round = 0; round < maxToolRounds; round++) {
    const tokenStatus = getClaudeTokenStatus();
    const tokenHardExceeded = tokenStatus.used >= (tokenStatus.limit + Math.max(0, RILEY_TOKEN_OVERRUN_ALLOWANCE));

    if (isBudgetExceeded()) {
      if (RILEY_AUTO_APPROVE_BUDGET && autoBudgetPassesUsed < RILEY_AUTO_APPROVE_BUDGET_MAX_PASSES) {
        const approved = approveAdditionalBudget(RILEY_AUTO_APPROVE_BUDGET_INCREMENT);
        autoBudgetPassesUsed += 1;
        logAgentEvent(
          agent.id,
          'response',
          `Auto-approved budget +$${approved.added.toFixed(2)} during tool loop (new limit $${approved.limit.toFixed(2)}, remaining $${approved.remaining.toFixed(2)})`
        );
      }
    }

    if (tokenHardExceeded || isBudgetExceeded()) {
      const reason = isBudgetExceeded() ? 'Daily dollar budget exceeded' : 'Daily token limit reached';
      logAgentEvent(agent.id, 'error', reason);
      if (isBudgetExceeded()) {
        const { spent: roundSpent, limit: roundLimit } = getRemainingBudget();
        return agent.id === 'executive-assistant'
          ? `⚠️ Daily budget of $${roundLimit.toFixed(2)} has been reached ($${roundSpent.toFixed(2)} spent) and runtime auto-approval could not clear it. Ask Jordan whether he approves more budget before the team continues.`
          : `⚠️ Daily budget of $${roundLimit.toFixed(2)} has been reached ($${roundSpent.toFixed(2)} spent) and runtime auto-approval could not clear it. Ask Riley to escalate only if she confirms the block remains.`;
      }
      return agent.id === 'executive-assistant'
        ? '⚠️ Daily Gemini token limit reached. Ask Jordan whether he wants to raise DAILY_LIMIT_GEMINI_LLM_TOKENS (legacy: DAILY_LIMIT_CLAUDE_TOKENS) before the team continues.'
        : '⚠️ Daily Gemini token limit reached. Ask Riley to request approval before continuing.';
    }

    if (TOOL_LOOP_TIMEOUT > 0 && Date.now() - loopStart > TOOL_LOOP_TIMEOUT) {
      logAgentEvent(agent.id, 'error', `Tool loop timeout after ${totalToolCalls} tool calls`, { durationMs: Date.now() - loopStart });
      return `Tool loop timed out after ${Math.round(TOOL_LOOP_TIMEOUT / 60000)} minutes. Check the repository for any partial changes.`;
    }

    if (options?.signal?.aborted) {
      logAgentEvent(agent.id, 'error', 'Request interrupted by user', { durationMs: Date.now() - loopStart });
      return '';
    }

    const functionCalls = (response.response.functionCalls() || []) as ToolCallLike[];

    if (functionCalls.length === 0) {
      // No tool calls — final text response
      const usageTelemetry = extractUsageTelemetry(response.response);
      recordClaudeUsage(
        usageTelemetry.inputTokens,
        usageTelemetry.outputTokens,
        {
          modelName: currentModelName,
          agentLabel: agent.name,
          cacheCreationInputTokens: usageTelemetry.cacheCreationInputTokens,
          cacheReadInputTokens: usageTelemetry.cacheReadInputTokens,
          promptBreakdown: pendingPromptBreakdown,
        },
      );
      const finalText = response.response.text() || 'Done.';
      if (cacheKey && totalToolCalls === 0 && finalText.length <= 500) {
        setCachedResponse(cacheKey, finalText);
      }
      recordAgentResponse(agent.id, Date.now() - loopStart);
      logAgentEvent(
        agent.id,
        'response',
        `${totalToolCalls} tools, cacheRead=${usageTelemetry.cacheReadInputTokens}, cacheWrite=${usageTelemetry.cacheCreationInputTokens}, ${formatPromptBreakdownForLog(pendingPromptBreakdown)}, response="${finalText.slice(0, 300)}"`,
        {
          durationMs: Date.now() - loopStart,
          tokensIn: usageTelemetry.inputTokens,
          tokensOut: usageTelemetry.outputTokens,
        },
      );
      return finalText;
    }

    // Record usage for this round with cache/prompt attribution.
    const usageTelemetry = extractUsageTelemetry(response.response);
    recordClaudeUsage(
      usageTelemetry.inputTokens,
      usageTelemetry.outputTokens,
      {
        modelName: currentModelName,
        agentLabel: agent.name,
        cacheCreationInputTokens: usageTelemetry.cacheCreationInputTokens,
        cacheReadInputTokens: usageTelemetry.cacheReadInputTokens,
        promptBreakdown: pendingPromptBreakdown,
      },
    );

    // Separate read-only (parallel) and write (sequential) calls
    const readCalls = functionCalls.filter((c) => !WRITE_TOOLS.has(c.name));
    const writeCalls = functionCalls.filter((c) => WRITE_TOOLS.has(c.name));

    const functionResponses: Part[] = [];
    let sawValidationFailure = false;

    const processCall = async (call: ToolCallLike) => {
      const toolStart = Date.now();
      totalToolCalls++;
      const args = call.args as Record<string, string>;
      const result = await executeTool(call.name, args, { agentId: agent.id });
      if (agent.id === 'developer' && !options?.modelOverride && hasValidationFailure(call.name, result)) {
        sawValidationFailure = true;
      }
      const summary = formatToolSummary(call.name, args);
      logAgentEvent(agent.id, 'tool', summary, { durationMs: Date.now() - toolStart });
      if (onToolUse) await onToolUse(call.name, summary);
      const toolAudit = getToolAuditCallback();
      if (toolAudit) {
        try {
          toolAudit(agent.name, call.name, summary);
        } catch (auditErr) {
          console.warn('Tool audit callback failed:', auditErr instanceof Error ? auditErr.message : 'Unknown');
        }
      }
      return {
        functionResponse: {
          name: call.name,
          ...(isAnthropicModel(currentModelName) && call.id ? { toolUseId: call.id } : {}),
          response: { output: truncateToolResult(result, toolResultTruncateChars) },
        },
      } as Part;
    };

    if (readCalls.length > 0) {
      const readResults = await Promise.all(readCalls.map(processCall));
      functionResponses.push(...readResults);
    }
    for (const call of writeCalls) {
      functionResponses.push(await processCall(call));
    }

    // Cost-aware escalation: if tests/typecheck fail on Flash, switch to Pro
    if (
      agent.id === 'developer' &&
      !options?.modelOverride &&
      !escalatedToPro &&
      currentModelName === GEMINI_FLASH &&
      sawValidationFailure
    ) {
      escalatedToPro = true;
      currentModelName = GEMINI_PRO;
      logAgentEvent(agent.id, 'response', 'Escalated Flash -> Pro after validation failure');
      const accumulatedHistory = await chat.getHistory();
      model = makeModel(GEMINI_PRO);
      chat = model.startChat({ history: accumulatedHistory });
      if (options?.chatSession) {
        options.chatSession.chat = chat;
        options.chatSession.modelName = currentModelName;
      }
    }

    pendingPromptBreakdown = {
      ...basePromptBreakdown,
      userChars: 0,
      toolResultChars: estimateToolResultChars(functionResponses),
    };

    const preToolHistory = await chat.getHistory().catch(() => [] as Content[]);
    if (preToolHistory.length > 0 && CONTEXT_PRUNING_ENABLED) {
      const toolLoopPrune = applyContextPruningIfDue({
        history: preToolHistory,
        modelName: currentModelName,
        laneKey: pruneLaneKey,
      });
      if (toolLoopPrune.stats.changed) {
        await swapToModel(currentModelName, toolLoopPrune.history);
      }
    }

    const preemptiveBeforeToolSend = await chat.getHistory().catch(() => [] as Content[]);
    if (preemptiveBeforeToolSend.length > 0) {
      const guarded = applyPreemptiveContextGuard({
        history: preemptiveBeforeToolSend,
        modelName: currentModelName,
        laneKey: pruneLaneKey,
      });
      if (guarded.changed) {
        await swapToModel(currentModelName, guarded.history);
      }
    }

    // Send tool results back
    try {
      response = await withConcurrencyLimit(currentModelName, () =>
        withRetry(() => sendMessageWithOptionalStream(chat, functionResponses, options?.signal, options?.onPartialText))
      , lane);
      markCacheTouched(pruneLaneKey);
      const lanePenalty = laneOverflowPenalty.get(pruneLaneKey);
      if (lanePenalty) {
        lanePenalty.outputPenalty = Math.max(0, lanePenalty.outputPenalty - 0.05);
        lanePenalty.toolPenalty = Math.max(0, lanePenalty.toolPenalty - 0.05);
        lanePenalty.observedAt = Date.now();
        if (lanePenalty.outputPenalty <= 0.01 && lanePenalty.toolPenalty <= 0.01) {
          laneOverflowPenalty.delete(pruneLaneKey);
          toolResultTruncateChars = DEFAULT_TOOL_RESULT_TRUNCATE_CHARS;
        }
      }
    } catch (err: any) {
      const recovered = await recoverContextOverflowAndRetry(functionResponses, err);
      if (recovered) {
        response = recovered;
        markCacheTouched(pruneLaneKey);
        continue;
      }
      if (isAbortError(err)) {
        logAgentEvent(agent.id, 'error', 'Request interrupted by user', { durationMs: Date.now() - loopStart });
        return '';
      }
      if (isAnthropicModel(currentModelName) && isAnthropicAuthError(err)) {
        logAgentEvent(agent.id, 'error', 'Anthropic auth failed mid-loop — falling back to Gemini Pro');
        const accumulatedHistory = await chat.getHistory();
        await swapToModel(GEMINI_PRO, accumulatedHistory);
        response = await withConcurrencyLimit(currentModelName, () =>
          withRetry(() => sendMessageWithOptionalStream(chat, functionResponses, options?.signal, options?.onPartialText))
        , lane);
        continue;
      }
      if (isGeminiRateLimitError(err)) {
        const recoverAt = Math.max(rateLimitedUntil, Date.now() + GEMINI_429_PAUSE_MS);
        return `⏳ Gemini is currently rate-limited (throughput), not out of credit. Please retry after ${formatRecoveryTime(recoverAt)} or reduce parallel requests.`;
      }
      if (isGeminiQuotaError(err)) {
        triggerGeminiQuotaFuse();
        logAgentEvent(agent.id, 'error', 'Gemini quota exhausted mid-loop');
        return agent.id === 'executive-assistant'
          ? (DISABLE_GEMINI_QUOTA_FUSE
              ? '⚠️ Gemini rejected that request mid-run. The local quota pause is disabled, so the team can keep trying, but upstream Google limits may still reject individual requests.'
              : '⚠️ Gemini quota is exhausted. Pause the team and ask Jordan to top up Google Cloud billing.')
          : (DISABLE_GEMINI_QUOTA_FUSE
              ? '⚠️ Gemini rejected that request mid-run, but the local quota pause is disabled. Retry or continue with other work.'
              : '⚠️ Gemini quota is exhausted right now. Ask Riley to request Jordan approval for more credits before continuing.');
      }
      throw err;
    }
  }

  if (agent.id === 'executive-assistant' && !options?.rileyAutoToolApprovalUsed && RILEY_AUTO_TOOL_EXTENSION > 0) {
    const extension = Math.max(1, RILEY_AUTO_TOOL_EXTENSION);
    logAgentEvent(agent.id, 'response', `Riley started one extra tool pass (+${extension} rounds)`);
    return agentRespond(
      agent,
      conversationHistory,
      `${userMessage}\n\n[System note: one extra tool pass is enabled for this run (+${extension} rounds). Continue and finish.]`,
      onToolUse,
      {
        ...options,
        toolRoundBoost: extension,
        rileyAutoToolApprovalUsed: true,
      }
    );
  }

  logAgentEvent(agent.id, 'error', `Max tool iterations (${maxToolRounds}) after ${totalToolCalls} tool calls`, { durationMs: Date.now() - loopStart });
  return agent.id === 'executive-assistant'
    ? 'I hit the per-pass tool safety cap for this run. The latest state is preserved; start a fresh, tighter follow-up if you want me to continue from here.'
    : 'I hit the per-pass tool safety cap for this run. The latest state is preserved; send a tighter follow-up if you want me to continue from here.';
}

function sanitizeForCodeBlock(text: string): string {
  return String(text || '').replace(/```/g, "''' ");
}

function truncateCodeSnippet(text: string, maxLines = 16, maxChars = 900): string {
  const normalized = sanitizeForCodeBlock(text).replace(/\r\n/g, '\n');
  const clippedChars = normalized.length > maxChars
    ? `${normalized.slice(0, maxChars - 1)}…`
    : normalized;
  const lines = clippedChars.split('\n');
  if (lines.length <= maxLines) return clippedChars;
  return `${lines.slice(0, maxLines).join('\n')}\n…`;
}

function codeFenceLanguage(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.ts':
    case '.tsx':
      return 'ts';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.json':
      return 'json';
    case '.sql':
      return 'sql';
    case '.md':
      return 'md';
    case '.css':
      return 'css';
    case '.html':
      return 'html';
    case '.sh':
      return 'bash';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.py':
      return 'python';
    default:
      return '';
  }
}

function renderCodeBlock(language: string, content: string): string {
  const fence = '`'.repeat(3);
  return `\n${fence}${language}\n${content}\n${fence}`;
}

function renderDiffBlock(oldString: string, newString: string): string {
  const oldLines = truncateCodeSnippet(oldString, 8, 450).split('\n').map((line) => `- ${line}`);
  const newLines = truncateCodeSnippet(newString, 8, 450).split('\n').map((line) => `+ ${line}`);
  return renderCodeBlock('diff', [...oldLines, ...newLines].join('\n'));
}

function renderWriteBlock(filePath: string, content: string): string {
  return renderCodeBlock(codeFenceLanguage(filePath), truncateCodeSnippet(content, 18, 1000));
}

function formatBatchEditSummary(edits: Array<{ path: string; old_string: string; new_string: string }>): string {
  const visibleEdits = edits.slice(0, 2);
  const blocks = visibleEdits.map((edit) => `Editing \`${edit.path}\`${renderDiffBlock(edit.old_string, edit.new_string)}`);
  const remainder = edits.length > visibleEdits.length ? `\n(+${edits.length - visibleEdits.length} more edits)` : '';
  return `Batch editing ${edits.length} file${edits.length === 1 ? '' : 's'}.${blocks.length ? `\n${blocks.join('\n')}` : ''}${remainder}`;
}

function formatToolSummary(toolName: string, input: Record<string, string>): string {
  switch (toolName) {
    case 'read_file':
      return `Reading \`${input.path}\` to gather implementation context`;
    case 'write_file':
      return `Writing \`${input.path}\` with the requested changes${renderWriteBlock(input.path, input.content || '')}`;
    case 'edit_file':
      return `Editing \`${input.path}\` to implement or refine behavior${renderDiffBlock(input.old_string || '', input.new_string || '')}`;
    case 'search_files':
      return `Searching for \`${input.pattern}\`${input.include ? ` in ${input.include}` : ''} to locate relevant code paths`;
    case 'list_directory':
      return `Listing \`${input.path || '.'}\` to inspect project structure`;
    case 'run_command':
      return `Running \`${input.command.slice(0, 100)}\` to validate or apply changes`;
    case 'git_create_branch':
      return `Creating branch \`${input.branch_name}\``;
    case 'create_pull_request':
      return `Creating PR: ${input.title}`;
    case 'merge_pull_request':
      return `Merging PR #${input.pr_number}`;
    case 'add_pr_comment':
      return `Commenting on PR #${input.pr_number}`;
    case 'list_pull_requests':
      return 'Listing open PRs';
    case 'run_tests':
      return `Running tests${input.test_pattern ? ` (${input.test_pattern})` : ''} to verify behavior and catch regressions`;
    case 'list_channels':
      return 'Listing Discord channels';
    case 'delete_channel':
      return `Deleting channel #${input.channel_name}`;
    case 'create_channel':
      return `Creating channel #${input.channel_name}`;
    case 'rename_channel':
      return `Renaming #${input.old_name} → #${input.new_name}`;
    case 'set_channel_topic':
      return `Setting topic on #${input.channel_name}`;
    case 'send_channel_message':
      return `Sending message to #${input.channel_name}`;
    case 'delete_category':
      return `Deleting category ${input.category_name}`;
    case 'move_channel':
      return `Moving #${input.channel_name} to ${input.category}`;
    case 'read_logs':
      return `Reading Cloud Run logs${input.severity ? ` (${input.severity}+)` : ''}`;
    case 'github_search':
      return `Searching GitHub for \`${input.query}\`${input.type ? ` (${input.type})` : ''}`;
    case 'typecheck':
      return `Running typecheck${input.target ? ` (${input.target})` : ''} to confirm compile-time correctness`;
    case 'batch_edit': {
      const edits = input.edits as any;
      return Array.isArray(edits) ? formatBatchEditSummary(edits) : 'Batch editing files';
    }
    case 'capture_screenshots':
      return `Capturing app screenshots${input.channel_name ? ` to #${input.channel_name}` : ''} for visual verification`;
    case 'mobile_harness_start':
      return `Starting mobile harness${input.url ? ` at ${input.url.slice(0, 60)}` : ''}`;
    case 'mobile_harness_step':
      return `Mobile harness step: ${input.action || 'wait'} (interactive flow verification)`;
    case 'mobile_harness_snapshot':
      return `Capturing mobile harness snapshot`;
    case 'mobile_harness_stop':
      return `Stopping mobile harness session`;
    case 'gcp_preflight':
      return `Running GCP preflight checks`;
    case 'gcp_build_image':
      return `Building container image${input.tag ? ` (${input.tag})` : ''}`;
    case 'gcp_deploy':
      return `Deploying to Cloud Run${input.tag ? ` (${input.tag})` : ''}`;
    case 'gcp_set_env':
      return `Setting Cloud Run env vars`;
    case 'gcp_get_env':
      return `Reading Cloud Run env vars`;
    case 'gcp_list_revisions':
      return `Listing Cloud Run revisions`;
    case 'gcp_rollback':
      return `Rolling back to ${input.revision}`;
    case 'gcp_secret_set':
      return `Setting secret "${input.name}"`;
    case 'gcp_secret_bind':
      return `Binding secrets to Cloud Run service`;
    case 'gcp_secret_list':
      return `Listing GCP secrets`;
    case 'gcp_build_status':
      return `Checking Cloud Build status`;
    case 'gcp_logs_query':
      return `Querying GCP logs: ${(input.filter || 'all').slice(0, 60)}`;
    case 'gcp_run_describe':
      return `Getting Cloud Run service status and URL`;
    case 'gcp_storage_ls':
      return `Listing GCS bucket: ${input.bucket}${input.prefix ? `/${input.prefix}` : ''}`;
    case 'gcp_artifact_list':
      return `Listing Docker images in Artifact Registry`;
    case 'gcp_sql_describe':
      return `Getting Cloud SQL instance details`;
    case 'gcp_vm_ssh':
      return `Running on VM: ${(input.command || '').slice(0, 60)}`;
    case 'gcp_project_info':
      return `Getting GCP project info and enabled APIs`;
    case 'fetch_url':
      return `Fetching ${input.url?.slice(0, 80)}`;
    case 'memory_read':
      return `Reading memory "${input.file}"`;
    case 'memory_write':
      return `Writing memory "${input.file}"`;
    case 'memory_append':
      return `Appending to memory "${input.file}"`;
    case 'memory_list':
      return `Listing memory files`;
    case 'db_query':
      return 'Running SQL query';
    case 'db_query_readonly':
      return 'Running read-only SQL query';
    case 'db_schema':
      return `Inspecting schema${input.table ? `: ${input.table}` : ''}`;
    default:
      return `Using ${toolName}`;
  }
}

export function getContextRuntimeReport(): string {
  const avgCharsSaved = contextRuntimeStats.prunePasses > 0
    ? Math.round(contextRuntimeStats.charsSaved / contextRuntimeStats.prunePasses)
    : 0;
  return (
    `🧠 Runtime Context Efficiency\n` +
    `Prune passes: ${contextRuntimeStats.prunePasses}\n` +
    `Soft-trimmed tool results: ${contextRuntimeStats.softTrimmedToolResults}\n` +
    `Hard-cleared tool results: ${contextRuntimeStats.hardClearedToolResults}\n` +
    `Estimated chars saved: ${contextRuntimeStats.charsSaved.toLocaleString()} (avg ${avgCharsSaved.toLocaleString()} per pass)\n` +
    `Preemptive guards: ${contextRuntimeStats.preemptiveGuards}\n` +
    `Overflow recoveries: ${contextRuntimeStats.overflowRecoveries}\n` +
    `Cache heartbeats: ${contextRuntimeStats.cacheHeartbeats}`
  );
}

/**
 * Generate a summary of a voice call conversation.
 */
export async function summarizeCall(
  transcript: string[],
  participants: string[]
): Promise<string> {
  if (isClaudeOverLimit()) {
    return '⚠️ Daily token limit reached — cannot generate summary.';
  }

  const model = createModel(GEMINI_FLASH, {
    systemInstruction: 'You are a concise meeting summarizer. Produce a clear summary with key points, decisions, and action items. Format for Discord markdown. Keep under 1900 characters.',
  });

  const result = await withConcurrencyLimit(GEMINI_FLASH, () =>
    withRetry(() => model.generateContent(
      `Summarize this voice call between ${participants.join(', ')}:\n\n${transcript.join('\n')}`
    ))
  , 'background');

  recordClaudeUsage(
    result.response.usageMetadata?.promptTokenCount || 0,
    result.response.usageMetadata?.candidatesTokenCount || 0,
    { modelName: GEMINI_FLASH, agentLabel: 'system:voice-summary' },
  );
  return result.response.text() || 'Could not generate summary.';
}

/**
 * Compress conversation history into a condensed summary.
 * Used by the memory compression system to avoid losing context
 * when conversations get long — similar to how Copilot/Claude summarize
 * earlier chat context.
 *
 * If an existing summary exists, it's merged with the new messages
 * to create an updated rolling summary.
 */
export async function summarizeConversation(
  existingSummary: string,
  newMessages: string,
  agentId: string
): Promise<string> {
  if (isClaudeOverLimit()) {
    return existingSummary || 'Summary unavailable — token limit reached.';
  }

  const prompt = existingSummary
    ? `You are compressing conversation history for an AI agent (${agentId}) to maintain long-term context efficiently.

EXISTING SUMMARY of earlier conversation:
${existingSummary}

NEW MESSAGES to incorporate:
${newMessages}

Create an UPDATED summary that merges the existing summary with the new messages. Prioritize:
1. Key decisions made and their reasoning
2. Technical context (files changed, bugs found, features implemented)
3. User preferences and patterns observed
4. Active tasks / blockers / next steps
5. Important facts (names, IDs, configurations)

Keep the summary under 700 words. Use bullet points. Drop redundant or superseded information.`
    : `You are compressing conversation history for an AI agent (${agentId}) to maintain long-term context efficiently.

MESSAGES to summarize:
${newMessages}

Create a condensed summary. Prioritize:
1. Key decisions made and their reasoning
2. Technical context (files changed, bugs found, features implemented)
3. User preferences and patterns observed
4. Active tasks / blockers / next steps
5. Important facts (names, IDs, configurations)

Keep the summary under 700 words. Use bullet points. Drop small talk and redundant exchanges.`;

  const model = createModel(GEMINI_FLASH, {
    systemInstruction: 'You are a conversation compressor. Produce structured, information-dense summaries that preserve all actionable context while discarding noise. Output only the summary — no meta-commentary.',
  });

  const result = await withConcurrencyLimit(GEMINI_FLASH, () =>
    withRetry(() => model.generateContent(prompt))
  , 'background');

  recordClaudeUsage(
    result.response.usageMetadata?.promptTokenCount || 0,
    result.response.usageMetadata?.candidatesTokenCount || 0,
    { modelName: GEMINI_FLASH, agentLabel: `system:memory:${agentId}` },
  );
  return result.response.text() || existingSummary || 'Could not generate summary.';
}
