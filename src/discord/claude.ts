import { readFileSync } from 'fs';
import { extname, join } from 'path';

import { GoogleGenerativeAI, Content, Part, FunctionDeclaration, Tool } from '@google/generative-ai';
import { GoogleAuth } from 'google-auth-library';

import { ensureGoogleCredentials, getAccessTokenViaGcloud } from '../services/googleCredentials';

import { logAgentEvent } from './activityLog';
import { AgentConfig } from './agents';
import { getOrCreateContentCache } from './contextCache';
import { classifyInput, classifyOutput, sanitizeOutputForSecrets } from './guardrails';
import { isLowSignalCompletion } from './handlers/responseNormalization';
import { recordModelSuccess, recordModelFailure, resolveHealthyModel, isModelAvailable } from './modelHealth';
import { recordAgentResponse, recordRateLimitHit } from './metrics';
import { REPO_TOOLS, getToolsForAgent, executeTool, getToolAuditCallback } from './tools';
import { createTraceContext, recordSpan, newSpanId, type TraceContext, type TraceSpan } from './tracing';
import { recordClaudeUsage, isClaudeOverLimit, isBudgetExceeded, getRemainingBudget, getClaudeTokenStatus, approveAdditionalBudget, type PromptBreakdown } from './usage';
import { recallRelevantContext, recordAgentDecision } from './vectorMemory';


let PROJECT_CONTEXT = '';
try {
  const candidates = [
    join(process.cwd(), '.github/PROJECT_CONTEXT.md'),
    join(__dirname, '../../../.github/PROJECT_CONTEXT.md'),
    join(__dirname, '../../../../.github/PROJECT_CONTEXT.md'),
  ];
  for (const contextPath of candidates) {
    try {
      PROJECT_CONTEXT = readFileSync(contextPath, 'utf-8');
      break;
    } catch {
    }
  }
  if (!PROJECT_CONTEXT) throw new Error('missing project context');
} catch {
  console.warn('PROJECT_CONTEXT.md not found — agents will lack project context');
}

const PROJECT_CONTEXT_MAX_CHARS = parseInt(process.env.PROJECT_CONTEXT_MAX_CHARS || '1800', 10);
if (PROJECT_CONTEXT.length > PROJECT_CONTEXT_MAX_CHARS) {
  PROJECT_CONTEXT = PROJECT_CONTEXT.slice(0, PROJECT_CONTEXT_MAX_CHARS) + '\n\n[Project context truncated for token efficiency]';
}
const PROJECT_CONTEXT_LIGHT_MAX_CHARS = parseInt(process.env.PROJECT_CONTEXT_LIGHT_MAX_CHARS || '500', 10);
const PROJECT_CONTEXT_LIGHT = PROJECT_CONTEXT.slice(0, PROJECT_CONTEXT_LIGHT_MAX_CHARS);

const GEMINI_FLASH = process.env.GEMINI_FLASH_MODEL || 'gemini-flash-latest';
const GEMINI_FLASH_LITE = process.env.GEMINI_FLASH_LITE_MODEL || 'gemini-2.0-flash';
const GEMINI_PRO = process.env.GEMINI_PRO_MODEL || 'gemini-2.5-pro';
const ANTHROPIC_OPUS = process.env.ANTHROPIC_CODING_MODEL || 'claude-opus-4-6';
const DEFAULT_CODING_MODEL = process.env.CODING_AGENT_MODEL || ANTHROPIC_OPUS;
const DEFAULT_FAST_MODEL = process.env.FAST_AGENT_MODEL || GEMINI_FLASH;
const VOICE_FAST_MODEL = process.env.VOICE_FAST_MODEL || DEFAULT_FAST_MODEL;
const VERTEX_OPUS_ONLY_MODE = process.env.VERTEX_OPUS_ONLY_MODE === 'true';
const FORCE_OPUS_FOR_CODE_WORK = process.env.FORCE_OPUS_FOR_CODE_WORK !== 'false';
const DEVELOPER_ALWAYS_OPUS = process.env.DEVELOPER_ALWAYS_OPUS !== 'false';
const COMPACT_RUNTIME_TOOL_PROMPTS = process.env.COMPACT_RUNTIME_TOOL_PROMPTS !== 'false';
const CODE_HEAVY_AGENT_IDS = new Set(['developer', 'devops', 'ios-engineer', 'android-engineer']);
const CODE_WORK_RE = /\b(?:code|coding|implement|implementation|fix|bug|debug|refactor|build|compile|lint|typecheck|test(?:s|ing)?|deploy|migration|schema|sql|query|api|endpoint|component|screen|tsx|jsx|react|expo|node|frontend|backend|repo|commit|branch|diff|patch|pull request|pr)\b/i;
const TOOL_ACTION_RE = /\b(?:run|read|search|grep|inspect|check|verify|edit|change|update|deploy|build|test|commit|push|rollback|migrate|open)\b/i;
const SIMPLE_FAST_PATH_RE = /^(?:ok(?:ay)?|yes|no|thanks?|thank you|status|summary|summari[sz]e|what happened|why|how|help|ping|continue|proceed|looks good|sounds good)\b/i;
const DIRECT_ANSWER_ONLY_RE = /^(?:ok(?:ay)?|yes|no|thanks?|thank you|understood|sounds good|what does|what is|why is|how does|explain|summari[sz]e|clarify)\b/i;
const VERIFICATION_TASK_RE = /\b(?:verify|verification|confirm|smoke(?:\s+test)?|evidence|prove|check(?:\s+that)?|regression|screenshot|snapshot|next\s*steps)\b/i;

function normalizePromptForHeuristics(userMessage: string): string {
  return String(userMessage || '')
    .replace(/^\[[^\]]+\]:\s*/, '')
    .replace(/<@[!&]?\d+>/g, ' ')
    .replace(/^(?:\[[^\]]+\]\s*)+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * High-stakes prompts for Ace where Pro quality is worth the cost.
 * Everything else defaults to Flash for cost efficiency.
 */
const HIGH_STAKES_RE = /(high[-\s]?stakes|critical|prod(?:uction)?|hotfix|incident|security|auth|migration|rollback|data\s+loss|schema|deploy)/i;
function isHighStakesPrompt(userMessage: string): boolean {
  return HIGH_STAKES_RE.test(userMessage);
}

function isCodeWorkPrompt(userMessage: string): boolean {
  const normalized = normalizePromptForHeuristics(userMessage);
  return CODE_WORK_RE.test(normalized);
}

function isSimpleFastPathPrompt(userMessage: string): boolean {
  const trimmed = normalizePromptForHeuristics(userMessage);
  if (!trimmed || trimmed.length > 220) return false;
  if (TOOL_ACTION_RE.test(trimmed) || isCodeWorkPrompt(trimmed)) return false;
  return SIMPLE_FAST_PATH_RE.test(trimmed) || trimmed.split(/\s+/).length <= 10;
}

function isDirectAnswerOnlyPrompt(userMessage: string): boolean {
  const trimmed = normalizePromptForHeuristics(userMessage);
  if (!trimmed || trimmed.length > 240) return false;
  if (TOOL_ACTION_RE.test(trimmed) || isCodeWorkPrompt(trimmed)) return false;
  return DIRECT_ANSWER_ONLY_RE.test(trimmed) || /^(?:who|what|why|how)\b/i.test(trimmed);
}

function isVerificationTaskPrompt(userMessage: string): boolean {
  const trimmed = normalizePromptForHeuristics(userMessage);
  if (!trimmed || trimmed.length > 500) return false;
  return VERIFICATION_TASK_RE.test(trimmed);
}

function isSmokePrompt(userMessage: string): boolean {
  return /\bSMOKE_[A-Z0-9_]+\b/i.test(String(userMessage || ''));
}

function extractSmokeToken(userMessage: string): string | null {
  const match = String(userMessage || '').match(/\bSMOKE_[A-Z0-9_]+\b/);
  return match ? match[0] : null;
}

function ensureSmokeTokenEcho(userMessage: string, replyText: string): string {
  const token = extractSmokeToken(userMessage);
  if (!token) return String(replyText || '').trim();
  const normalized = String(replyText || '').trim();
  if (!normalized) return token;
  if (normalized.includes(token)) return normalized;
  return `${normalized}\n${token}`;
}

function normalizeLowSignalFinalText(agentId: string, text: string, totalToolCalls: number): string {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  if ((agentId === 'developer' || agentId === 'executive-assistant') && totalToolCalls > 0 && isLowSignalCompletion(normalized)) {
    return '✅ Done.';
  }
  return normalized;
}

/** Detect failed tests/typecheck outputs that warrant escalation to Pro. */
function hasValidationFailure(toolName: string, result: string): boolean {
  if (toolName !== 'run_tests' && toolName !== 'typecheck') return false;
  return /(\bFAIL\b|failing|failed|Type error|not assignable|Compilation error|[1-9]\d*\s+errors?\b|Tests?:\s*[1-9]\d*\s+failed)/i.test(result);
}

function hasToolFailureSignal(toolName: string, result: string): boolean {
  const text = String(result || '').trim();
  if (!text) return false;
  if (hasValidationFailure(toolName, text)) return true;
  if (/^Error:/i.test(text)) return true;
  if (/\b(timeout|timed out|failed|failure|exception|cannot|could not|denied|forbidden|unauthorized|invalid)\b/i.test(text)) {
    if (/No matches found for pattern/i.test(text)) return false;
    return true;
  }
  return false;
}

function resolveInitialToolBudget(agentId: string, maxToolRounds: number): number {
  const raw = agentId === 'developer'
    ? Number(process.env.MAX_TOOL_CALLS_FIRST_PASS_DEVELOPER || '14')
    : agentId === 'executive-assistant'
      ? Number(process.env.MAX_TOOL_CALLS_FIRST_PASS_EXECUTIVE || '8')
      : Number(process.env.MAX_TOOL_CALLS_FIRST_PASS || '10');
  if (!Number.isFinite(raw) || raw <= 0) return Math.max(4, Math.floor(maxToolRounds));
  return Math.max(3, Math.min(Math.floor(raw), Math.max(4, maxToolRounds * 2)));
}

function resolveEscalatedToolBudget(initialBudget: number, maxToolRounds: number): number {
  const raw = Number(process.env.MAX_TOOL_CALLS_ESCALATED || String(initialBudget * 2));
  const fallback = initialBudget * 2;
  const resolved = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  return Math.max(initialBudget + 1, Math.min(resolved, Math.max(8, maxToolRounds * 4)));
}

function resolveToolThreadKey(
  agentId: string,
  conversationHistory: ConversationMessage[],
  userMessage: string,
  explicitKey?: string,
): string {
  if (explicitKey) return explicitKey;
  const firstUser = conversationHistory.find((m) => m.role === 'user')?.content || '';
  const seed = normalizeHistoryContentForModel(firstUser || userMessage).replace(/\s+/g, ' ').slice(0, 140) || 'default';
  return `${agentId}:${seed}`;
}

/**
 * Model policy:
 * - Voice and other short/status asks stay on the fast model.
 * - Code-heavy prompts escalate to the coding model when warranted.
 * - Riley still escalates to Pro for non-code high-stakes ops prompts.
 */
function modelForAgent(agentId: string, userMessage: string): string {
  if (VERTEX_OPUS_ONLY_MODE) {
    return DEFAULT_CODING_MODEL;
  }
  // Per-agent model override via env var (e.g. AGENT_MODEL_OVERRIDE_security_auditor=gemini-2.5-pro)
  const overrideKey = `AGENT_MODEL_OVERRIDE_${agentId.replace(/-/g, '_')}`;
  const override = process.env[overrideKey];
  if (override) {
    return resolveHealthyModel(override);
  }
  if (agentId === 'developer' && DEVELOPER_ALWAYS_OPUS) {
    return DEFAULT_CODING_MODEL;
  }
  // Riley (EA) gets Opus for best orchestration quality
  if (agentId === 'executive-assistant') {
    if (isSimpleFastPathPrompt(userMessage)) return resolveHealthyModel(DEFAULT_FAST_MODEL);
    return resolveHealthyModel(DEFAULT_CODING_MODEL);
  }
  if (isSimpleFastPathPrompt(userMessage)) {
    return resolveHealthyModel(DEFAULT_FAST_MODEL);
  }
  if (CODE_HEAVY_AGENT_IDS.has(agentId) && isCodeWorkPrompt(userMessage)) {
    return resolveHealthyModel(DEFAULT_CODING_MODEL);
  }
  if (FORCE_OPUS_FOR_CODE_WORK && isCodeWorkPrompt(userMessage)) {
    return resolveHealthyModel(DEFAULT_CODING_MODEL);
  }
  return resolveHealthyModel(DEFAULT_FAST_MODEL);
}

function shouldFallbackToOpus(modelName: string): boolean {
  if (!DEFAULT_CODING_MODEL || !isAnthropicModel(DEFAULT_CODING_MODEL)) return false;
  return !isAnthropicModel(modelName);
}

/**
 * Tool access can be constrained by agent role via tools.ts policy.
 */

const RILEY_AUTO_APPROVE_BUDGET = process.env.RILEY_AUTO_APPROVE_BUDGET !== 'false';
const RILEY_AUTO_APPROVE_BUDGET_INCREMENT = parseFloat(process.env.RILEY_AUTO_APPROVE_BUDGET_INCREMENT_USD || '5');
const RILEY_AUTO_APPROVE_BUDGET_MAX_PASSES = parseInt(process.env.RILEY_AUTO_APPROVE_BUDGET_MAX_PASSES || '4', 10);
const RILEY_TOKEN_OVERRUN_ALLOWANCE = parseInt(process.env.RILEY_TOKEN_OVERRUN_ALLOWANCE || '2000000', 10);

type AnyTool = { name: string; description: string; input_schema: any };

function hasFullRepoToolAccess(agentId: string): boolean {
  return getToolsForAgent(agentId, false).length === REPO_TOOLS.length;
}

function toolsForAgent(agentId: string): AnyTool[] {
  return getToolsForAgent(agentId, COMPACT_RUNTIME_TOOL_PROMPTS) as unknown as AnyTool[];
}

function toolsForPrompt(agentId: string, userMessage: string): AnyTool[] {
  if (isDirectAnswerOnlyPrompt(userMessage)) {
    return [];
  }

  void agentId;

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
  if (
    Array.isArray(out.required)
    && out.properties
    && typeof out.properties === 'object'
    && !Array.isArray(out.properties)
  ) {
    const allowed = new Set(Object.keys(out.properties));
    out.required = out.required
      .map((item: unknown) => String(item || ''))
      .filter((name: string) => name.length > 0 && allowed.has(name));
    if (out.required.length === 0) {
      delete out.required;
    }
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
let vertexAuth: GoogleAuth | null = null;
let vertexTokenCache: { token: string; expiresAtMs: number } | null = null;
let vertexAuthUnavailable = false;

const USE_VERTEX_AI = process.env.GEMINI_USE_VERTEX_AI === 'true';
const USE_VERTEX_ANTHROPIC = process.env.ANTHROPIC_USE_VERTEX_AI !== 'false';
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const VERTEX_ANTHROPIC_LOCATION = process.env.VERTEX_ANTHROPIC_LOCATION || process.env.VERTEX_PARTNER_LOCATION || VERTEX_LOCATION;
const VERTEX_ANTHROPIC_FALLBACK_LOCATIONS = (process.env.VERTEX_ANTHROPIC_FALLBACK_LOCATIONS || 'us-east5')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const VERTEX_ANTHROPIC_VERSION = process.env.VERTEX_ANTHROPIC_VERSION || 'vertex-2023-10-16';
const PARTNER_MODEL_CACHE_ENABLED = process.env.PARTNER_MODEL_CACHE_ENABLED !== 'false';
let warnedVertexAnthropicMissingProject = false;

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

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.floor(seconds * 1000);
  }
  const timestamp = Date.parse(headerValue);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return Math.max(0, timestamp - Date.now());
  }
  return undefined;
}

function makeVertexError(status: number, bodyText: string, retryAfterMs?: number): Error & { status: number; statusCode: number; retryAfterMs?: number } {
  const err = new Error(`Vertex Gemini error: HTTP ${status} ${bodyText.slice(0, 400)}`) as Error & { status: number; statusCode: number; retryAfterMs?: number };
  err.status = status;
  err.statusCode = status;
  if (retryAfterMs && retryAfterMs > 0) {
    err.retryAfterMs = retryAfterMs;
  }
  return err;
}

function makeVertexAnthropicError(
  status: number,
  bodyText: string,
  retryAfterMs?: number,
  location?: string,
): Error & { status: number; statusCode: number; retryAfterMs?: number; location?: string } {
  const locationDetail = location ? ` [${location}]` : '';
  const err = new Error(`Vertex Anthropic error${locationDetail}: HTTP ${status} ${bodyText.slice(0, 400)}`) as Error & {
    status: number;
    statusCode: number;
    retryAfterMs?: number;
    location?: string;
  };
  err.status = status;
  err.statusCode = status;
  if (retryAfterMs && retryAfterMs > 0) {
    err.retryAfterMs = retryAfterMs;
  }
  if (location) {
    err.location = location;
  }
  return err;
}

function uniqueLocations(locations: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const location of locations) {
    const normalized = String(location || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function preferredAnthropicLocations(modelName: string): string[] {
  const normalizedModel = String(modelName || '').toLowerCase();
  if (normalizedModel.includes('opus-4-6')) {
    return uniqueLocations(['us-east5', VERTEX_ANTHROPIC_LOCATION, ...VERTEX_ANTHROPIC_FALLBACK_LOCATIONS]);
  }
  return uniqueLocations([VERTEX_ANTHROPIC_LOCATION, ...VERTEX_ANTHROPIC_FALLBACK_LOCATIONS]);
}

function shouldTryAnotherAnthropicLocation(status: number, bodyText: string): boolean {
  const msg = String(bodyText || '').toLowerCase();
  if (status === 429) return true;
  if (status === 404) return true;
  if (status === 400 && (msg.includes('not servable') || msg.includes('not found'))) return true;
  return false;
}

function isVertexCredentialsUnavailableError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '').toLowerCase();
  return (
    msg.includes('could not load the default credentials')
    || msg.includes('application default credentials')
    || msg.includes('getapplicationdefaultasync')
    || msg.includes('default credentials')
  );
}

async function getVertexAccessToken(): Promise<string> {
  if (vertexAuthUnavailable) {
    const recovered = await ensureGoogleCredentials(VERTEX_PROJECT_ID).catch(() => false);
    if (recovered) {
      vertexAuthUnavailable = false;
      vertexAuth = null;
    }
  }

  if (vertexAuthUnavailable) {
    const tokenViaCli = getAccessTokenViaGcloud();
    if (tokenViaCli) {
      vertexTokenCache = {
        token: tokenViaCli,
        expiresAtMs: Date.now() + 45 * 60_000,
      };
      return tokenViaCli;
    }
    throw new Error('Vertex auth unavailable: Application Default Credentials are not configured');
  }

  const now = Date.now();
  if (vertexTokenCache && vertexTokenCache.expiresAtMs - now > 60_000) {
    return vertexTokenCache.token;
  }

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
    if (isVertexCredentialsUnavailableError(err)) {
      const recovered = await ensureGoogleCredentials(VERTEX_PROJECT_ID).catch(() => false);
      if (recovered) {
        vertexAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        authClient = await vertexAuth.getClient();
        accessToken = await authClient.getAccessToken();
      } else {
        const tokenViaCli = getAccessTokenViaGcloud();
        if (tokenViaCli) {
          vertexTokenCache = {
            token: tokenViaCli,
            expiresAtMs: now + 45 * 60_000,
          };
          return tokenViaCli;
        }
        vertexAuthUnavailable = true;
        throw new Error('Vertex auth unavailable: Application Default Credentials are not configured');
      }
    } else {
      throw err;
    }
  }
  const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;
  if (!token) {
    throw new Error('Vertex auth failed: could not obtain access token');
  }

  vertexTokenCache = {
    token,
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

  const lower = String(modelName || '').toLowerCase();
  const primaryModel = lower.includes('gemini-flash-latest')
    ? 'gemini-2.5-flash'
    : lower.includes('gemini-pro-latest')
      ? 'gemini-2.5-pro'
      : modelName;

  const candidates = [primaryModel];
  if (!candidates.includes('gemini-2.5-flash')) candidates.push('gemini-2.5-flash');
  if (!candidates.includes('gemini-2.5-pro')) candidates.push('gemini-2.5-pro');

  const token = await getVertexAccessToken();
  let lastErr: Error | null = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const model = candidates[i];
    const endpoint = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (res.ok) {
      return res.json();
    }

    const bodyText = await res.text();
    const err = makeVertexError(res.status, bodyText, parseRetryAfterMs(res.headers.get('retry-after')));
    const shouldRetryModel = res.status === 404 && i < candidates.length - 1;
    if (shouldRetryModel) {
      lastErr = err;
      continue;
    }
    throw err;
  }

  if (lastErr) throw lastErr;
  throw new Error('Vertex Gemini request failed before model attempts');
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
  const locations = preferredAnthropicLocations(modelName);
  let lastErr: Error | null = null;

  for (let index = 0; index < locations.length; index += 1) {
    const location = locations[index];
    const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${location}/publishers/anthropic/models/${encodeURIComponent(modelName)}:rawPredict`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (res.ok) {
      return res.json();
    }

    const bodyText = await res.text();
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    const err = makeVertexAnthropicError(res.status, bodyText, retryAfterMs, location);
    const hasNextLocation = index < locations.length - 1;
    if (hasNextLocation && shouldTryAnotherAnthropicLocation(res.status, bodyText)) {
      lastErr = err;
      continue;
    }

    throw err;
  }

  if (lastErr) {
    throw lastErr;
  }
  throw new Error('Vertex Anthropic request failed before any location attempt');
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

function isAnthropicModel(modelName: string): boolean {
  const key = String(modelName || '').trim().toLowerCase();
  return key.includes('claude') || key.includes('opus') || key.includes('sonnet');
}

function getNonAnthropicFallbackModel(primary?: string): string {
  const preferred = String(primary || GEMINI_PRO || '').trim();
  if (preferred && !isAnthropicModel(preferred)) return preferred;
  if (!isAnthropicModel(GEMINI_FLASH)) return GEMINI_FLASH;
  return 'gemini-flash-latest';
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

function createModel(modelName: string, options: { systemInstruction?: string; tools?: Tool[]; rawTools?: AnyTool[]; generationConfig?: Record<string, any>; cachedContentId?: string }): ModelLike {
  const canUseVertex = USE_VERTEX_AI && !vertexAuthUnavailable;
  const canUseVertexAnthropic = USE_VERTEX_ANTHROPIC && !vertexAuthUnavailable && !!VERTEX_PROJECT_ID;
  const nonAnthropicFallbackModel = getNonAnthropicFallbackModel(GEMINI_PRO);

  if (isAnthropicModel(modelName)) {
    if (!canUseVertexAnthropic) {
      if (USE_VERTEX_ANTHROPIC && !VERTEX_PROJECT_ID && !warnedVertexAnthropicMissingProject) {
        warnedVertexAnthropicMissingProject = true;
        console.warn('Vertex Anthropic disabled: VERTEX_PROJECT_ID/GOOGLE_CLOUD_PROJECT is not set; falling back to Gemini.');
      }
      if (VERTEX_OPUS_ONLY_MODE) {
        throw new Error('Vertex Anthropic unavailable while VERTEX_OPUS_ONLY_MODE=true');
      }
      return createModel(nonAnthropicFallbackModel, options);
    }
    return createVertexAnthropicModel(modelName, options);
  }

  if (canUseVertex) {
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

export interface AgentMachinePayload {
  delegateAgents?: string[];
  actionTags?: string[];
  notes?: string;
}

export interface AgentResponseEnvelope {
  human: string;
  machine?: AgentMachinePayload;
}

function normalizeAgentResponseEnvelope(value: unknown): AgentResponseEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const human = String(obj.human || '').trim();
  if (!human) return null;

  const machineRaw = obj.machine;
  if (!machineRaw || typeof machineRaw !== 'object' || Array.isArray(machineRaw)) {
    return { human };
  }

  const machineObj = machineRaw as Record<string, unknown>;
  const delegateAgents = Array.isArray(machineObj.delegateAgents)
    ? machineObj.delegateAgents.map((v) => String(v || '').trim()).filter(Boolean)
    : undefined;
  const actionTags = Array.isArray(machineObj.actionTags)
    ? machineObj.actionTags.map((v) => String(v || '').trim()).filter(Boolean)
    : undefined;
  const notes = typeof machineObj.notes === 'string' ? machineObj.notes.trim() : undefined;

  const machine: AgentMachinePayload = {};
  if (delegateAgents && delegateAgents.length > 0) machine.delegateAgents = delegateAgents;
  if (actionTags && actionTags.length > 0) machine.actionTags = actionTags;
  if (notes) machine.notes = notes;

  if (Object.keys(machine).length === 0) return { human };
  return { human, machine };
}

function parseAgentResponseEnvelope(text: string): AgentResponseEnvelope | null {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const candidates: string[] = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeAgentResponseEnvelope(parsed);
      if (normalized) return normalized;
    } catch {
    }
  }

  // Fallback for slightly malformed model output: salvage a quoted "human" field.
  const humanField = raw.match(/"human"\s*:\s*"([\s\S]*?)"\s*(?:,|})/i)
    || raw.match(/human\s*:\s*"([\s\S]*?)"\s*(?:,|})/i);
  if (humanField?.[1]) {
    const unescaped = humanField[1]
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim();
    if (unescaped) return { human: unescaped };
  }

  // Fallback for plain-text envelope format:
  // human: <message>
  // machine: {...}
  const plainHuman = raw.match(/(?:^|\n)\s*human\s*:\s*([\s\S]*?)(?:\n\s*machine\s*:|$)/i);
  if (plainHuman?.[1]) {
    const cleaned = plainHuman[1].trim();
    if (cleaned) return { human: cleaned };
  }

  return null;
}

export function extractAgentResponseEnvelope(text: string): AgentResponseEnvelope | null {
  return parseAgentResponseEnvelope(text);
}

/** Max tool-use iterations before forcing a text response. Lower defaults help stop runaway loops. */
const MAX_TOOL_ROUNDS = parseInt(process.env.MAX_TOOL_ROUNDS || '18', 10);
const MAX_TOOL_ROUNDS_DEVELOPER = parseInt(process.env.MAX_TOOL_ROUNDS_DEVELOPER || '28', 10);
const MAX_TOOL_ROUNDS_EXECUTIVE = parseInt(process.env.MAX_TOOL_ROUNDS_EXECUTIVE || '12', 10);
/** Optional one-time extra Riley pass. Default OFF to avoid runaway tool loops. */
const RILEY_AUTO_TOOL_EXTENSION = parseInt(process.env.RILEY_AUTO_TOOL_EXTENSION || '0', 10);
/** Maximum history messages to send per request (excludes current user message) */
const MAX_CONTEXT_MESSAGES = parseInt(process.env.MAX_CONTEXT_MESSAGES || '10', 10);
/** Soft cap for history character volume sent per request */
const MAX_CONTEXT_CHARS = parseInt(process.env.MAX_CONTEXT_CHARS || '3200', 10);
/** Per-message history cap so one long dump does not crowd out the rest of the context */
const MAX_CONTEXT_MESSAGE_CHARS = parseInt(process.env.MAX_CONTEXT_MESSAGE_CHARS || '520', 10);
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
const QUEUE_RELEASE_DELAY_MS = parseInt(process.env.QUEUE_RELEASE_DELAY_MS || '90', 10);
/** Additional delay when we are inside/just after a 429 window */
const QUEUE_RELEASE_DELAY_RATE_LIMIT_MS = parseInt(process.env.QUEUE_RELEASE_DELAY_RATE_LIMIT_MS || '1500', 10);
/** Minimum delay between sends per model to avoid bursty RPM spikes */
const MODEL_PACE_FLASH_MS = parseInt(process.env.GEMINI_MODEL_PACE_FLASH_MS || '130', 10);
const MODEL_PACE_PRO_MS = parseInt(process.env.GEMINI_MODEL_PACE_PRO_MS || '700', 10);
const MODEL_PACE_FLASH_VOICE_MS = parseInt(process.env.GEMINI_MODEL_PACE_FLASH_VOICE_MS || '0', 10);
const MODEL_PACE_PRO_VOICE_MS = parseInt(process.env.GEMINI_MODEL_PACE_PRO_VOICE_MS || '300', 10);

/** Lower default output tokens for faster first responses. */
const DEFAULT_MAX_OUTPUT_TOKENS = parseInt(process.env.DEFAULT_MAX_OUTPUT_TOKENS || '800', 10);
const DEFAULT_MAX_OUTPUT_TOKENS_DEVELOPER = parseInt(process.env.DEFAULT_MAX_OUTPUT_TOKENS_DEVELOPER || '1400', 10);
const DISABLE_GEMINI_QUOTA_FUSE = process.env.DISABLE_GEMINI_QUOTA_FUSE === 'true';
const GEMINI_QUOTA_FUSE_MS = parseInt(process.env.GEMINI_QUOTA_FUSE_MS || '300000', 10);
const GEMINI_MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || '4', 10);
const GEMINI_RETRY_BASE_DELAY_MS = parseInt(process.env.GEMINI_RETRY_BASE_DELAY_MS || '1500', 10);
const GEMINI_429_PAUSE_MS = parseInt(process.env.GEMINI_429_PAUSE_MS || '10000', 10);
const GEMINI_429_BACKOFF_FACTOR = Math.max(1, parseFloat(process.env.GEMINI_429_BACKOFF_FACTOR || '2'));
const GEMINI_429_MAX_BACKOFF_MS = Math.max(5000, parseInt(process.env.GEMINI_429_MAX_BACKOFF_MS || '20000', 10));
const GEMINI_429_JITTER_MS = parseInt(process.env.GEMINI_429_JITTER_MS || '5000', 10);
const RATE_LIMIT_FAST_FAIL_ON_429 = process.env.RATE_LIMIT_FAST_FAIL_ON_429 === 'true';
const GEMINI_RATE_LIMIT_FUSE_HITS = parseInt(process.env.GEMINI_RATE_LIMIT_FUSE_HITS || '6', 10);
const GEMINI_RATE_LIMIT_FUSE_WINDOW_MS = parseInt(process.env.GEMINI_RATE_LIMIT_FUSE_WINDOW_MS || '180000', 10);
const GEMINI_RATE_LIMIT_FUSE_COOLDOWN_MS = parseInt(process.env.GEMINI_RATE_LIMIT_FUSE_COOLDOWN_MS || '120000', 10);
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
  const quotaLike =
    msg.includes('quota') ||
    msg.includes('resource_exhausted') ||
    msg.includes('billing') ||
    msg.includes('insufficient_quota') ||
    msg.includes('quota exceeded');
  return (
    quotaLike ||
    (status === 403 && quotaLike)
  );
}

function isGeminiAuthError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.statusCode;
  return (
    status === 401 ||
    msg.includes('api key not valid') ||
    msg.includes('invalid api key') ||
    msg.includes('permission denied') ||
    msg.includes('unauthenticated') ||
    msg.includes('default credentials') ||
    msg.includes('application default credentials')
  );
}

function isGeminiRateLimitError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.statusCode;
  return status === 429 || msg.includes('rate limit') || msg.includes('too many requests');
}

function isAnthropicRateLimitError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = err?.status || err?.statusCode;
  return status === 429 || msg.includes('online_prediction_input_tokens_per_minute') || msg.includes('resource exhausted');
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
  return (
    status === 401
    || status === 404
    || msg.includes('invalid x-api-key')
    || msg.includes('authentication_error')
    || msg.includes('publisher model')
    || msg.includes('not found')
    || msg.includes('not servable')
    || msg.includes('default credentials')
    || msg.includes('application default credentials')
  );
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

export function clearGeminiQuotaFuse(): void {
  creditsExhaustedUntil = 0;
  rateLimitFuseUntil = 0;
  recentRateLimitHits = [];
}

export function getGeminiQuotaFuseStatus(): { blocked: boolean; recoverAt: number } {
  return {
    blocked: isCreditsExhaustedNow(),
    recoverAt: creditsExhaustedUntil,
  };
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

function isPotentiallyMutatingCommand(command: string): boolean {
  const cmd = String(command || '').toLowerCase();
  if (!cmd.trim()) return false;
  return /(\b(?:git\s+(?:add|commit|push|merge|rebase|reset|checkout|restore|cherry-pick)|rm\s+-|mv\s+|cp\s+|sed\s+-i|perl\s+-i|tee\s+|truncate\s+|chmod\s+|chown\s+|npm\s+run\s+format|pnpm\s+format|yarn\s+format)\b)/.test(cmd);
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

async function waitForModelPace(modelName: string, lane: 'text' | 'voice' | 'background' = 'text'): Promise<void> {
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

  const sameQueue = getModelQueue(modelKey);
  const same = sameQueue.shift();
  if (same) {
    setTimeout(same, releaseDelay);
    return;
  }

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

    await waitForModelPace(modelName, 'voice');
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

    await waitForModelPace(modelName, 'background');
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

  await waitForModelPace(modelName, 'text');
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
      if (isAbortError(err)) throw err;
      if (i === retries) throw err;
      const status = err?.status || err?.statusCode;
      if (status && status < 500 && status !== 429) throw err;

      let delay: number;
      if (status === 429) {
        recordRateLimitHit();
        registerRateLimitHit();
        const retryAfterMs = Number(err?.retryAfterMs || 0);
        const halfJitter = Math.max(0, Math.floor(GEMINI_429_JITTER_MS / 2));
        const jitter = Math.floor(Math.random() * (halfJitter * 2 + 1)) - halfJitter;
        const basePause = retryAfterMs > 0 ? retryAfterMs : GEMINI_429_PAUSE_MS;
        const scaledPause = Math.min(
          GEMINI_429_MAX_BACKOFF_MS,
          Math.round(basePause * Math.pow(GEMINI_429_BACKOFF_FACTOR, i))
        );
        delay = Math.max(5000, scaledPause + jitter);
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + Math.max(5000, scaledPause + halfJitter));
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
    safetyCapSynthesisUsed?: boolean;
    disableTools?: boolean;
    priority?: 'normal' | 'voice' | 'background';
    chatSession?: ReusableAgentChatSession;
    outputMode?: 'normal' | 'machine_json';
    machineEnvelopeRaw?: boolean;
    threadKey?: string;
    toolBudgetSynthesisUsed?: boolean;
  }
): Promise<string> {
  const requestedOutputMode = options?.outputMode || 'machine_json';
  const cacheEligible = isCacheablePrompt(agent.id, userMessage, conversationHistory);
  const lane = options?.priority || 'normal';
  const isVoiceLane = lane === 'voice';
  const pruneLaneKey = `${agent.id}:${lane}`;
  const traceCtx = createTraceContext();
  const agentSpanId = traceCtx.spanId;
  const agentSpanStart = Date.now();

  // ─── Input Guardrail ───
  const guardrailResult = await classifyInput(userMessage, agent.id);
  if (guardrailResult.verdict === 'block') {
    logAgentEvent(agent.id, 'guardrail', `Input blocked: ${guardrailResult.reason}`);
    void recordSpan({
      traceId: traceCtx.traceId, spanId: agentSpanId, agentId: agent.id,
      operation: 'guardrail_input', status: 'error', inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: Date.now() - agentSpanStart,
      errorMessage: guardrailResult.reason,
    });
    return `⚠️ I can't process that request. ${guardrailResult.reason || 'Please rephrase.'}`;
  }

  // ─── Vector Memory Recall ───
  const semanticContext = await recallRelevantContext(userMessage, agent.id);

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
  const verificationRoundCap = (agent.id === 'executive-assistant' && isVerificationTaskPrompt(userMessage))
    ? Math.min(baseToolRounds, 2)
    : baseToolRounds;
  const maxToolRounds = verificationRoundCap + Math.max(0, options?.toolRoundBoost || 0);
  const smokePrompt = isSmokePrompt(userMessage);
  const toolThreadKey = resolveToolThreadKey(agent.id, conversationHistory, userMessage, options?.threadKey);
  let activeToolBudget = smokePrompt ? Math.max(maxToolRounds * 4, 40) : resolveInitialToolBudget(agent.id, maxToolRounds);
  let toolBudgetEscalated = false;
  let sawToolFailure = false;
  let autoBudgetPassesUsed = 0;

  if (isCreditsExhaustedNow()) {
    const recoveryTime = formatRecoveryTime(creditsExhaustedUntil);
    return agent.id === 'executive-assistant'
      ? `⚠️ Gemini quota is exhausted right now. Automatic retries resume at ${recoveryTime}. Pause the team and ask Jordan to check Google Cloud billing before more work continues.`
      : `⚠️ Gemini quota is exhausted right now. Automatic retries resume at ${recoveryTime}. Ask Riley to request Jordan approval for more credits before continuing.`;
  }

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
- If groupchat gets noisy/disjointed, run [ACTION:CLEANUP:<count>] to delete recent bot/webhook clutter before posting the consolidated update.
${budgetGovernance}
SELF-IMPROVEMENT & AUTONOMY:
- You have full code mutation tools: write_file, edit_file, batch_edit, run_command.
- You have the complete PR workflow: git_create_branch, create_pull_request, merge_pull_request, add_pr_comment, list_pull_requests.
- You have deploy tools: gcp_deploy, gcp_rollback.
- You may write code, create branches, commit, create PRs, and merge them yourself. Tests + typecheck are enforced automatically before merge/deploy.
- You may review and merge Ace's PRs after verifying quality.
- You may implement improvements from the #upgrades backlog directly, or delegate to @ace and then review/merge his PR.
- Self-modification flow: create branch → make changes → run tests/typecheck → create PR → merge → deploy.
- After any self-deploy, notify @jordan in #groupchat with a summary of what changed.
- Post all self-improvement actions to #upgrades with a summary.
- You do NOT have access to: gcp_secret_set (secrets are human-managed), db_query (write DB), or Discord channel create/delete/rename.
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

  const toolsSection = hasFullRepoTools
    ? `\nYou can use the full repo, infra, and Discord tool surface when needed. Stay focused and avoid broad or repetitive scans.`
    : `\nYou can use the full repo, infra, and Discord tool surface when needed. Stay focused and avoid broad or repetitive scans.`;

  const outputModePrompt = requestedOutputMode === 'machine_json'
    ? `
OUTPUT MODE:
- Return ONLY valid JSON (no markdown, no code fences).
- JSON schema:
  {
    "human": "normal human-readable reply text",
    "machine": {
      "delegateAgents": ["developer", "qa"],
      "actionTags": ["[ACTION:DEPLOY]"],
      "notes": "optional short machine note"
    }
  }
- Keep "human" as natural teammate language for people.
- Keep machine arrays concise; omit fields when empty.
- Never include JSON keys/objects in the human field.
`
    : '';

  const upgradesChannelRule = `
UPGRADES CHANNEL:
- When you notice a better way to work, a blocker that should be removed, or a worthwhile enhancement to your job/functionality, post a concise note to #🆙-upgrades using send_channel_message.
- Keep upgrades posts short and actionable: problem, proposed upgrade, expected benefit, and what implementation support is needed.
- Post at most one upgrades message per task unless someone explicitly asks for more.
  - Always include token optimization thinking in your work. If you detect token waste (repeated broad scans, redundant tool calls, oversized outputs) or low token headroom, post at least one token-optimization recommendation to #🆙-upgrades before finishing.
  - During smoke/readiness checks, each agent should contribute at least one concrete token-saving suggestion to #🆙-upgrades if one has not been posted in that thread yet.
`;

  const systemPrompt = `${agent.systemPrompt}

<project_context>
${getProjectContextForAgent(agent.id)}
</project_context>

You are "${agent.name}" responding in Discord.${rileyCoordination}
RULES: Max 220 words (code exempt). Speak like a real teammate, not a ticket template. Lead with the useful part.${toolsSection}
Default brevity target: 60-120 words for normal updates; 1-3 short sentences for simple asks.
AUTHORITY: Any human team member in Discord can request work and should get help. Do not ignore requests because they are not Jordan. Jordan approval is only required for budget/credit increases.
When doing work, explain a bit more than before: what you're doing, why you're doing it, and what happened.
Default format (lightweight, not rigid): 1) action taken, 2) key result, 3) immediate next step or blocker (if any).
If the ask is simple (status check, direct answer, yes/no, one-step clarification), answer in 1-3 short sentences and skip the default status structure.
Never paste raw JSON or machine envelope text into user-visible chat.
Do not include internal smoke-test tokens (SMOKE_...) in normal user-visible updates unless a test harness explicitly requires it.
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
Knowledge recall: for any non-trivial task, start with repo_memory_search before broad read/search sweeps. If results are stale or missing, run repo_memory_index first, then continue.
${governanceSection}
${upgradesChannelRule}
RUNTIME EFFICIENCY:
- Runtime budget and token status will be supplied separately in the task context.
- Each tool call costs tokens. Prefer targeted reads, concise summaries, and the narrowest agent/tool path that can finish the job.
- Prefer check_file_exists before broad search/read when you only need to validate presence.${outputModePrompt}`;

  let currentModelName = options?.modelOverride || options?.chatSession?.modelName || (isVoiceLane ? VOICE_FAST_MODEL : modelForAgent(agent.id, userMessage));
  let escalatedToPro = currentModelName === GEMINI_PRO;
  let opusFallbackUsed = false;

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
    semanticContext ? `${userMessage}${semanticContext}` : userMessage,
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

  // ─── Structured Output Schema for machine_json mode ───
  const DELEGATION_SCHEMA = {
    type: 'OBJECT',
    properties: {
      human: { type: 'STRING', description: 'Human-readable reply text' },
      machine: {
        type: 'OBJECT',
        properties: {
          delegateAgents: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Agent IDs to delegate to' },
          actionTags: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Action tags like [ACTION:DEPLOY]' },
          notes: { type: 'STRING', description: 'Optional machine note' },
        },
      },
    },
    required: ['human'],
  };

  // ─── Context Caching (create/reuse cached content for system prompt + tools) ───
  // Attempt to cache for Gemini models (not Anthropic)
  const contextCacheId = !isAnthropicModel(currentModelName)
    ? await getOrCreateContentCache(
        currentModelName,
        systemPrompt,
        agentTools.map(t => ({ name: t.name, description: t.description, parameters: t.input_schema })),
        agent.id,
      ).catch(() => null)
    : null;

  const makeModel = (modelName: string) => {
    const genConfig: Record<string, any> = {
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
    };

    // Add structured output schema for Gemini models in machine_json mode
    // Only when tools are not active (Gemini doesn't support both simultaneously)
    if (requestedOutputMode === 'machine_json' && !isAnthropicModel(modelName) && agentTools.length === 0) {
      genConfig.responseMimeType = 'application/json';
      genConfig.responseSchema = DELEGATION_SCHEMA;
    }

    return createModel(modelName, {
      systemInstruction: systemPrompt,
      tools: geminiTools,
      rawTools: agentTools,
      generationConfig: genConfig,
      cachedContentId: contextCacheId || undefined,
    });
  };

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
    recordModelSuccess(currentModelName, Date.now() - loopStart);
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
    // Record model health failure
    const errType = isGeminiRateLimitError(err) || isAnthropicRateLimitError(err) ? 'rate_limited'
      : isGeminiQuotaError(err) ? 'quota_exhausted'
      : isGeminiAuthError(err) || isAnthropicAuthError(err) ? 'auth_error'
      : 'error';
    recordModelFailure(currentModelName, errType, String(err?.message || '').slice(0, 200));

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
      if (VERTEX_OPUS_ONLY_MODE) {
        logAgentEvent(agent.id, 'error', 'Anthropic auth failed in Vertex Opus-only mode');
        return '⚠️ Vertex Anthropic auth/config failed and fallback is disabled (VERTEX_OPUS_ONLY_MODE=true). Check Vertex IAM/model access and retry.';
      }
      const fallbackModel = getNonAnthropicFallbackModel(GEMINI_PRO);
      logAgentEvent(agent.id, 'error', `Anthropic auth failed — falling back to ${fallbackModel}`);
      await swapToModel(fallbackModel, history);
      response = await withConcurrencyLimit(currentModelName, () =>
        withRetry(() => sendMessageWithOptionalStream(chat, runtimeUserMessage, options?.signal, options?.onPartialText))
      , lane);
    } else if (isAnthropicModel(currentModelName) && isAnthropicRateLimitError(err)) {
      if (VERTEX_OPUS_ONLY_MODE) {
        logAgentEvent(agent.id, 'error', 'Anthropic rate limited in Vertex Opus-only mode');
        return '⏳ Vertex Anthropic is rate-limited and fallback is disabled (VERTEX_OPUS_ONLY_MODE=true). Retry shortly.';
      }
      logAgentEvent(agent.id, 'error', 'Anthropic rate limited — falling back to Gemini Flash');
      await swapToModel(DEFAULT_FAST_MODEL, history);
      response = await withConcurrencyLimit(currentModelName, () =>
        withRetry(() => sendMessageWithOptionalStream(chat, runtimeUserMessage, options?.signal, options?.onPartialText))
      , lane);
    } else if (isGeminiRateLimitError(err) && !opusFallbackUsed && shouldFallbackToOpus(currentModelName)) {
      opusFallbackUsed = true;
      logAgentEvent(agent.id, 'error', `Gemini rate limited — falling back to ${DEFAULT_CODING_MODEL}`);
      await swapToModel(DEFAULT_CODING_MODEL, history);
      response = await withConcurrencyLimit(currentModelName, () =>
        withRetry(() => sendMessageWithOptionalStream(chat, runtimeUserMessage, options?.signal, options?.onPartialText))
      , lane);
    } else if (isGeminiQuotaError(err) && !opusFallbackUsed && shouldFallbackToOpus(currentModelName)) {
      opusFallbackUsed = true;
      logAgentEvent(agent.id, 'error', `Gemini quota exhausted — falling back to ${DEFAULT_CODING_MODEL}`);
      await swapToModel(DEFAULT_CODING_MODEL, history);
      response = await withConcurrencyLimit(currentModelName, () =>
        withRetry(() => sendMessageWithOptionalStream(chat, runtimeUserMessage, options?.signal, options?.onPartialText))
      , lane);
    } else if (isGeminiAuthError(err) && !opusFallbackUsed && shouldFallbackToOpus(currentModelName)) {
      const fallbackModel = isAnthropicModel(DEFAULT_CODING_MODEL)
        ? getNonAnthropicFallbackModel(GEMINI_PRO)
        : DEFAULT_CODING_MODEL;
      opusFallbackUsed = true;
      logAgentEvent(agent.id, 'error', `Gemini auth/config issue — falling back to ${fallbackModel}`);
      await swapToModel(fallbackModel, history);
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
    } else if (isGeminiAuthError(err)) {
      logAgentEvent(agent.id, 'error', 'Gemini auth/config issue');
      return '⚠️ Gemini auth/config issue detected (not quota). Check runtime API key/service account and provider mode flags, then retry.';
    } else {
      throw err;
    }
    }
  }

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
          ? `⚠️ Daily budget of $${roundLimit.toFixed(2)} has been reached ($${roundSpent.toFixed(2)} spent) and runtime auto-approval could not clear it. Riley should request budget approval before the team continues.`
          : `⚠️ Daily budget of $${roundLimit.toFixed(2)} has been reached ($${roundSpent.toFixed(2)} spent) and runtime auto-approval could not clear it. Ask Riley to escalate only if she confirms the block remains.`;
      }
      return agent.id === 'executive-assistant'
        ? '⚠️ Daily Gemini token limit reached. Riley should request approval to raise DAILY_LIMIT_GEMINI_LLM_TOKENS (legacy: DAILY_LIMIT_CLAUDE_TOKENS) before the team continues.'
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
      let finalText = normalizeLowSignalFinalText(agent.id, response.response.text() || '', totalToolCalls);
      if (requestedOutputMode !== 'machine_json' && process.env.ENABLE_SMOKE_TOKEN_ECHO === 'true') {
        finalText = ensureSmokeTokenEcho(userMessage, finalText);
      }
      if (requestedOutputMode === 'machine_json') {
        const envelope = parseAgentResponseEnvelope(finalText);
        if (envelope) {
          return options?.machineEnvelopeRaw ? JSON.stringify(envelope) : envelope.human;
        }
      }
      if (cacheKey && totalToolCalls === 0 && finalText.length <= 500) {
        setCachedResponse(cacheKey, finalText);
      }
      recordAgentResponse(agent.id, Date.now() - loopStart);
      recordModelSuccess(currentModelName, Date.now() - loopStart);

      // ─── Output Guardrail ───
      const outputGuardrail = await classifyOutput(finalText, agent.id);
      if (outputGuardrail.verdict === 'block') {
        finalText = sanitizeOutputForSecrets(finalText);
      }

      // ─── Record trace span ───
      void recordSpan({
        traceId: traceCtx.traceId, spanId: agentSpanId, agentId: agent.id,
        modelName: currentModelName, operation: 'agent_respond', status: 'ok',
        inputTokens: usageTelemetry.inputTokens, outputTokens: usageTelemetry.outputTokens,
        cacheReadTokens: usageTelemetry.cacheReadInputTokens,
        cacheWriteTokens: usageTelemetry.cacheCreationInputTokens,
        durationMs: Date.now() - agentSpanStart,
        metadata: { toolCalls: totalToolCalls, contextCached: !!contextCacheId },
      });

      // ─── Store significant decisions in vector memory ───
      if (requestedOutputMode === 'machine_json' && finalText.length > 50 && totalToolCalls > 2) {
        void recordAgentDecision(agent.id, finalText.slice(0, 500), userMessage.slice(0, 200));
      }

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

    const readCalls = functionCalls.filter((c) => !WRITE_TOOLS.has(c.name));
    const writeCalls = functionCalls.filter((c) => WRITE_TOOLS.has(c.name));

    if (totalToolCalls >= activeToolBudget) {
      if (!toolBudgetEscalated && sawToolFailure) {
        const escalatedBudget = resolveEscalatedToolBudget(activeToolBudget, maxToolRounds);
        if (escalatedBudget > activeToolBudget) {
          toolBudgetEscalated = true;
          activeToolBudget = escalatedBudget;
          logAgentEvent(agent.id, 'response', `Escalated tool budget after failure signal: ${activeToolBudget} calls`);
        }
      }

      if (totalToolCalls >= activeToolBudget) {
        if (!options?.toolBudgetSynthesisUsed) {
          const budgetPrompt = `${userMessage}\n\n[System note: strict first-pass tool budget reached (${activeToolBudget} calls). Do not use tools. Summarize what is complete, what is still open, and the single best next step.]`;
          logAgentEvent(agent.id, 'response', `Tool budget reached (${activeToolBudget}) — forcing no-tools synthesis`);
          return agentRespond(
            agent,
            conversationHistory,
            budgetPrompt,
            onToolUse,
            {
              ...options,
              disableTools: true,
              toolBudgetSynthesisUsed: true,
              toolRoundBoost: 0,
              threadKey: toolThreadKey,
            }
          );
        }

        return 'Reached strict per-pass tool budget. Provide a narrower follow-up and I will continue with targeted calls.';
      }
    }

    const functionResponses: Part[] = [];
    let sawValidationFailure = false;

    const processCall = async (call: ToolCallLike) => {
      const toolStart = Date.now();
      totalToolCalls++;
      const args = call.args as Record<string, string>;

      if (call.name === 'run_command' && isPotentiallyMutatingCommand((args as any)?.command || '')) {
        // Allowed for all agents; keep only safety checks elsewhere.
      }

      const result = await executeTool(call.name, args, {
        agentId: agent.id,
        threadKey: toolThreadKey,
      });
      if (agent.id === 'developer' && !options?.modelOverride && hasValidationFailure(call.name, result)) {
        sawValidationFailure = true;
      }
      if (hasToolFailureSignal(call.name, result)) {
        sawToolFailure = true;
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

    // Do not mutate/prune chat history between a model functionCall turn and
    // sending functionResponses; Gemini requires strict immediate adjacency.

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
        if (VERTEX_OPUS_ONLY_MODE) {
          logAgentEvent(agent.id, 'error', 'Anthropic auth failed mid-loop in Vertex Opus-only mode');
          return '⚠️ Vertex Anthropic auth/config failed and fallback is disabled (VERTEX_OPUS_ONLY_MODE=true). Check Vertex IAM/model access and retry.';
        }
        const fallbackModel = getNonAnthropicFallbackModel(GEMINI_PRO);
        logAgentEvent(agent.id, 'error', `Anthropic auth failed mid-loop — falling back to ${fallbackModel}`);
        const accumulatedHistory = await chat.getHistory();
        await swapToModel(fallbackModel, accumulatedHistory);
        response = await withConcurrencyLimit(currentModelName, () =>
          withRetry(() => sendMessageWithOptionalStream(chat, functionResponses, options?.signal, options?.onPartialText))
        , lane);
        continue;
      }
      if (isAnthropicModel(currentModelName) && isAnthropicRateLimitError(err)) {
        if (VERTEX_OPUS_ONLY_MODE) {
          logAgentEvent(agent.id, 'error', 'Anthropic rate limited mid-loop in Vertex Opus-only mode');
          return '⏳ Vertex Anthropic is rate-limited and fallback is disabled (VERTEX_OPUS_ONLY_MODE=true). Retry shortly.';
        }
        logAgentEvent(agent.id, 'error', 'Anthropic rate limited mid-loop — falling back to Gemini Flash');
        const accumulatedHistory = await chat.getHistory();
        await swapToModel(DEFAULT_FAST_MODEL, accumulatedHistory);
        response = await withConcurrencyLimit(currentModelName, () =>
          withRetry(() => sendMessageWithOptionalStream(chat, functionResponses, options?.signal, options?.onPartialText))
        , lane);
        continue;
      }
      if (isGeminiRateLimitError(err) && !opusFallbackUsed && shouldFallbackToOpus(currentModelName)) {
        opusFallbackUsed = true;
        logAgentEvent(agent.id, 'error', `Gemini rate limited mid-loop — falling back to ${DEFAULT_CODING_MODEL}`);
        const accumulatedHistory = await chat.getHistory();
        await swapToModel(DEFAULT_CODING_MODEL, accumulatedHistory);
        response = await withConcurrencyLimit(currentModelName, () =>
          withRetry(() => sendMessageWithOptionalStream(chat, functionResponses, options?.signal, options?.onPartialText))
        , lane);
        continue;
      }
      if (isGeminiQuotaError(err) && !opusFallbackUsed && shouldFallbackToOpus(currentModelName)) {
        opusFallbackUsed = true;
        logAgentEvent(agent.id, 'error', `Gemini quota exhausted mid-loop — falling back to ${DEFAULT_CODING_MODEL}`);
        const accumulatedHistory = await chat.getHistory();
        await swapToModel(DEFAULT_CODING_MODEL, accumulatedHistory);
        response = await withConcurrencyLimit(currentModelName, () =>
          withRetry(() => sendMessageWithOptionalStream(chat, functionResponses, options?.signal, options?.onPartialText))
        , lane);
        continue;
      }
      if (isGeminiAuthError(err) && !opusFallbackUsed && shouldFallbackToOpus(currentModelName)) {
        const fallbackModel = isAnthropicModel(DEFAULT_CODING_MODEL)
          ? getNonAnthropicFallbackModel(GEMINI_PRO)
          : DEFAULT_CODING_MODEL;
        opusFallbackUsed = true;
        logAgentEvent(agent.id, 'error', `Gemini auth/config issue mid-loop — falling back to ${fallbackModel}`);
        const accumulatedHistory = await chat.getHistory();
        await swapToModel(fallbackModel, accumulatedHistory);
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
      if (isGeminiAuthError(err)) {
        logAgentEvent(agent.id, 'error', 'Gemini auth/config issue mid-loop');
        return '⚠️ Gemini auth/config issue detected (not quota). Check runtime API key/service account and provider mode flags, then retry.';
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

  if (!options?.safetyCapSynthesisUsed) {
    const synthesisPrompt = agent.id === 'executive-assistant'
      ? `${userMessage}\n\n[System note: tool safety cap reached. Do not use tools. In one concise response, summarize current status and evidence gathered. CRITICAL: do not claim work is complete unless evidence is checkable from runtime artifacts (screenshots, harness snapshots, or puppeteer/playwright-style output). If that evidence is missing, explicitly say verification is pending and list what remains open.]`
      : `${userMessage}\n\n[System note: tool safety cap reached. Do not use tools. Return a concise completion summary using this exact format:\nResult: <one sentence>\nEvidence: <files/checks/outcome>\nRisk/Follow-up: <one sentence>.]`;
    logAgentEvent(agent.id, 'response', `Starting final no-tools synthesis after tool cap (${maxToolRounds} rounds)`);
    return agentRespond(
      agent,
      conversationHistory,
      synthesisPrompt,
      onToolUse,
      {
        ...options,
        disableTools: true,
        safetyCapSynthesisUsed: true,
        toolRoundBoost: 0,
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
    systemInstruction: 'You are a concise meeting summarizer. Produce a clear summary with key points, decisions, and action items. Format for Discord markdown. Keep under 1900 characters. Use only the provided participant names; do not introduce extra participants that are not explicitly listed.',
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

  const model = createModel(GEMINI_FLASH_LITE, {
    systemInstruction: 'You are a conversation compressor. Produce structured, information-dense summaries that preserve all actionable context while discarding noise. Output only the summary — no meta-commentary.',
  });

  const result = await withConcurrencyLimit(GEMINI_FLASH_LITE, () =>
    withRetry(() => model.generateContent(prompt))
  , 'background');

  recordClaudeUsage(
    result.response.usageMetadata?.promptTokenCount || 0,
    result.response.usageMetadata?.candidatesTokenCount || 0,
    { modelName: GEMINI_FLASH_LITE, agentLabel: `system:memory:${agentId}` },
  );
  return result.response.text() || existingSummary || 'Could not generate summary.';
}
