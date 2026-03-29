import { GoogleGenerativeAI, Content, Part, FunctionDeclaration, Tool } from '@google/generative-ai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AgentConfig } from './agents';
import { REPO_TOOLS, REVIEW_TOOLS, executeTool, getToolAuditCallback } from './tools';
import { recordClaudeUsage, isClaudeOverLimit, isBudgetExceeded, getRemainingBudget, getClaudeTokenStatus } from './usage';
import { logAgentEvent } from './activityLog';

// Load project context once at startup — shared by all agents
let PROJECT_CONTEXT = '';
try {
  PROJECT_CONTEXT = readFileSync(join(__dirname, '../../../.github/PROJECT_CONTEXT.md'), 'utf-8');
} catch {
  console.warn('PROJECT_CONTEXT.md not found — agents will lack project context');
}

const PROJECT_CONTEXT_MAX_CHARS = parseInt(process.env.PROJECT_CONTEXT_MAX_CHARS || '4500', 10);
if (PROJECT_CONTEXT.length > PROJECT_CONTEXT_MAX_CHARS) {
  PROJECT_CONTEXT = PROJECT_CONTEXT.slice(0, PROJECT_CONTEXT_MAX_CHARS) + '\n\n[Project context truncated for token efficiency]';
}
const PROJECT_CONTEXT_LIGHT_MAX_CHARS = parseInt(process.env.PROJECT_CONTEXT_LIGHT_MAX_CHARS || '1200', 10);
const PROJECT_CONTEXT_LIGHT = PROJECT_CONTEXT.slice(0, PROJECT_CONTEXT_LIGHT_MAX_CHARS);

// Gemini model identifiers
// Use flash-latest because this key intermittently caps specific fixed model IDs.
const GEMINI_FLASH = 'gemini-flash-latest';
const GEMINI_PRO = 'gemini-2.5-pro';

/**
 * High-stakes prompts for Ace where Pro quality is worth the cost.
 * Everything else defaults to Flash for cost efficiency.
 */
const HIGH_STAKES_RE = /(high[-\s]?stakes|critical|prod(?:uction)?|hotfix|incident|security|auth|migration|rollback|data\s+loss|schema|deploy)/i;
function isHighStakesPrompt(userMessage: string): boolean {
  return HIGH_STAKES_RE.test(userMessage);
}

/** Detect failed tests/typecheck outputs that warrant escalation to Pro. */
function hasValidationFailure(toolName: string, result: string): boolean {
  if (toolName !== 'run_tests' && toolName !== 'typecheck') return false;
  return /(\bFAIL\b|failing|failed|Type error|not assignable|Compilation error|[1-9]\d*\s+errors?\b|Tests?:\s*[1-9]\d*\s+failed)/i.test(result);
}

/**
 * Model policy:
 * - Default: Flash for all agents (fast, cheap)
 * - Escalate: Pro for Ace on explicit high-stakes prompts
 */
function modelForAgent(agentId: string, userMessage: string): string {
  if (agentId === 'developer' && isHighStakesPrompt(userMessage)) {
    return GEMINI_PRO;
  }
  return GEMINI_FLASH;
}

/**
 * Agents that need full tool access (write files, deploy, manage Discord, etc.).
 * All other agents get the lightweight REVIEW_TOOLS subset.
 */
const FULL_TOOL_AGENTS = new Set(['developer', 'devops', 'executive-assistant']);

type AnyTool = { name: string; description: string; input_schema: any };

function toolsForAgent(agentId: string): AnyTool[] {
  return (FULL_TOOL_AGENTS.has(agentId) ? REPO_TOOLS : REVIEW_TOOLS) as unknown as AnyTool[];
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

function toGeminiTools(tools: AnyTool[]): Tool[] {
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description || tool.name,
      parameters: convertSchemaNode(tool.input_schema),
    } as FunctionDeclaration)),
  }];
}

let client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!client) {
    client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
  }
  return client;
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
    const msgLen = msg.content.length;
    if (recent.length >= MAX_CONTEXT_MESSAGES || chars + msgLen > MAX_CONTEXT_CHARS) break;
    recent.push(msg);
    chars += msgLen;
  }

  recent.reverse();
  const merged = summaryMsg ? [summaryMsg, ...recent] : recent;

  // Gemini chat history must start with a user message.
  // Groupchat edge cases can occasionally leave an assistant-first history.
  while (merged.length > 0 && merged[0].role !== 'user') {
    merged.shift();
  }

  return merged;
}

function truncateToolResult(result: string, maxChars = 3500): string {
  if (result.length <= maxChars) return result;
  const head = Math.floor(maxChars * 0.75);
  const tail = maxChars - head;
  return (
    result.slice(0, head) +
    `\n\n[Output truncated — original was ${result.length} chars]\n\n` +
    result.slice(-tail)
  );
}

function getProjectContextForAgent(agentId: string): string {
  return FULL_TOOL_AGENTS.has(agentId) ? PROJECT_CONTEXT : PROJECT_CONTEXT_LIGHT;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Max tool-use iterations before forcing a text response */
const MAX_TOOL_ROUNDS = parseInt(process.env.MAX_TOOL_ROUNDS || '60', 10);
const MAX_TOOL_ROUNDS_DEVELOPER = parseInt(process.env.MAX_TOOL_ROUNDS_DEVELOPER || '90', 10);
const MAX_TOOL_ROUNDS_EXECUTIVE = parseInt(process.env.MAX_TOOL_ROUNDS_EXECUTIVE || '75', 10);
/** Maximum history messages to send per request (excludes current user message) */
const MAX_CONTEXT_MESSAGES = parseInt(process.env.MAX_CONTEXT_MESSAGES || '35', 10);
/** Soft cap for history character volume sent per request */
const MAX_CONTEXT_CHARS = parseInt(process.env.MAX_CONTEXT_CHARS || '16000', 10);
/**
 * Max total time for a tool loop (ms).
 * Set to 0 (default) to disable wall-clock timeout so agents can run as long as needed.
 */
const TOOL_LOOP_TIMEOUT = parseInt(process.env.TOOL_LOOP_TIMEOUT_MS || '0', 10);
/** Max concurrent Gemini requests */
const MAX_CONCURRENT = 5;
let activeClaude = 0;
const claudeQueue: Array<() => void> = [];

/**
 * Global rate-limit gate — when ANY request gets 429'd, ALL requests
 * pause until the retry-after window passes. This prevents a cascade
 * of failed requests that burn through retries for nothing.
 */
let rateLimitedUntil = 0;
let creditsExhaustedUntil = 0;

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
    msg.includes('quota') ||
    msg.includes('resource_exhausted') ||
    msg.includes('billing') ||
    msg.includes('api key not valid') ||
    msg.includes('invalid api key') ||
    status === 429
  );
}

function isCreditsExhaustedNow(): boolean {
  return creditsExhaustedUntil > Date.now();
}

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  if (rateLimitedUntil > now) {
    const waitMs = rateLimitedUntil - now;
    console.warn(`Rate-limited: pausing all Claude requests for ${Math.ceil(waitMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  await waitForRateLimit();
  while (activeClaude >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => claudeQueue.push(resolve));
    await waitForRateLimit();
  }
  activeClaude++;
  try {
    return await fn();
  } finally {
    activeClaude--;
    // Stagger releases: 3-second delay before the next queued request starts.
    // This prevents token-burst spikes that trigger 429s on the 30k/min limit.
    const next = claudeQueue.shift();
    if (next) setTimeout(next, 3000);
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 2000): Promise<T> {
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
        delay = 60_000;
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + delay);
        console.warn(`429 rate limited — global pause for ${Math.ceil(delay / 1000)}s (retry ${i + 1}/${retries})`);
        logAgentEvent('system', 'rate_limit', `429 — pausing ${Math.ceil(delay / 1000)}s`);
      } else {
        delay = delayMs * Math.pow(2, i);
        console.warn(`Gemini retry ${i + 1}/${retries} after ${delay}ms: ${err?.message || 'Unknown'}`);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
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
  options?: { modelOverride?: string; maxTokens?: number; signal?: AbortSignal }
): Promise<string> {
  const maxToolRounds = agent.id === 'developer'
    ? MAX_TOOL_ROUNDS_DEVELOPER
    : agent.id === 'executive-assistant'
      ? MAX_TOOL_ROUNDS_EXECUTIVE
      : MAX_TOOL_ROUNDS;

  if (isCreditsExhaustedNow()) {
    return agent.id === 'executive-assistant'
      ? '⚠️ Gemini quota is exhausted right now. Pause the team and ask Jordan to check Google Cloud billing before more work continues.'
      : '⚠️ Gemini quota is exhausted right now. Ask Riley to request Jordan approval for more credits before continuing.';
  }

  // Hard budget gate — stop ALL agents if daily budget exceeded
  if (isBudgetExceeded()) {
    const { spent, limit } = getRemainingBudget();
    logAgentEvent(agent.id, 'error', `Budget exceeded: $${spent.toFixed(2)}/$${limit.toFixed(2)}`);
    return agent.id === 'executive-assistant'
      ? `⚠️ Daily budget of $${limit.toFixed(2)} has been reached ($${spent.toFixed(2)} spent). Pause the team and ask Jordan whether he wants to approve more budget before work resumes.`
      : `⚠️ Daily budget of $${limit.toFixed(2)} has been reached ($${spent.toFixed(2)} spent). Ask Riley to request Jordan approval before any extra spend.`;
  }

  const isFullToolAgent = FULL_TOOL_AGENTS.has(agent.id);
  const { remaining, spent, limit } = getRemainingBudget();
  const { used: tokenUsed, remaining: tokenRemaining, limit: tokenLimit } = getClaudeTokenStatus();

  const rileyCoordination = agent.id === 'executive-assistant' ? `
AGENT COORDINATION: Coordinate agents via @mentions in your response text. The system parses and routes automatically.
@ace @max @sophie @kane @raj @elena @kai @jude @liv @harper @mia @leo
CRITICAL: Do NOT use send_channel_message — ONLY @mentions work for agent coordination.
` : '';

  const governanceSection = agent.id === 'executive-assistant' ? `
GOVERNANCE:
- You are Jordan's token master. Any request to increase Gemini tokens, Google Cloud credits, ElevenLabs credit, or daily budget must come through you.
- When the team hits a limit, pause the work, explain what increase is needed, and ask Jordan for explicit approval before anyone resumes.
- Ace is the Tool Master. If tooling is missing, stale, or unreliable, direct @ace to prepare it before the rest of the team proceeds.
` : agent.id === 'developer' ? `
GOVERNANCE:
- You are the Tool Master. Own tool readiness for the whole team.
- Keep .github/AGENT_TOOLING_STATUS.md accurate, make missing tools available where possible, and confirm readiness before other agents depend on them.
- Riley is the token master. If more budget, credits, or token headroom is needed, report that to Riley instead of asking Jordan directly.
` : `
GOVERNANCE:
- Riley is the token master. Never ask Jordan directly for more tokens, budget, or credits. Ask Riley so she can seek approval.
- Ace is the Tool Master. Before tool-heavy work, or anytime tool readiness is uncertain, check with @ace first and wait for the green light.
`;

  const toolsSection = isFullToolAgent
    ? `\nYou can use the available tools for code, infra, and Discord operations.`
    : `\nYou can use analysis tools plus operational testing tools (GCP, screenshots, and mobile harness). Repository write tools remain restricted.`;

  const budgetWarning = remaining < 0.50 ? `\n⚠️ LOW BUDGET: $${remaining.toFixed(2)} remaining of $${limit.toFixed(2)} daily limit. Be extremely efficient — minimize tool calls, keep responses short.` : '';

  const systemPrompt = `${agent.systemPrompt}

<project_context>
${getProjectContextForAgent(agent.id)}
</project_context>

You are "${agent.name}" responding in Discord.${rileyCoordination}
RULES: Max 320 words (code exempt). Speak like a real teammate, not a ticket template. Lead with the useful part.${toolsSection}
AUTHORITY: Any human team member in Discord can request work and should get help. Do not ignore requests because they are not Jordan. Jordan approval is only required for budget/credit increases.
When doing work, explain a bit more than before: what you're doing, why you're doing it, and what happened.
Default format (lightweight, not rigid): 1) action taken, 2) key result, 3) immediate next step or blocker (if any).
Use short paragraphs or bullets when helpful. Do not pad with fluff.
Never dump long tool output. Summarize the important result only.
Tooling: Ace owns tool readiness. Check .github/AGENT_TOOLING_STATUS.md first. If tooling looks stale or a required tool may not be ready, coordinate with @ace before relying on it.
${governanceSection}
BUDGET: $${spent.toFixed(2)} spent / $${limit.toFixed(2)} daily limit ($${remaining.toFixed(2)} remaining). Each tool call costs tokens. Be efficient.${budgetWarning}
TOKENS: ${tokenUsed.toLocaleString()} used / ${tokenLimit.toLocaleString()} daily limit (${tokenRemaining.toLocaleString()} remaining). If remaining is low, reduce tool calls and avoid broad scans.`;

  // Convert conversation history to Gemini Content format
  const trimmedHistory = trimConversationHistory(conversationHistory);
  const history: Content[] = trimmedHistory.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));

  const agentTools = toolsForAgent(agent.id);
  const geminiTools = toGeminiTools(agentTools);
  let currentModelName = options?.modelOverride || modelForAgent(agent.id, userMessage);
  let escalatedToPro = currentModelName === GEMINI_PRO;

  logAgentEvent(agent.id, 'invoke', `model=${currentModelName}, context=${trimmedHistory.length} msgs, prompt="${userMessage.slice(0, 200)}"`);

  if (options?.signal?.aborted) return '';

  const genAI = getClient();
  const loopStart = Date.now();
  let totalToolCalls = 0;

  const makeModel = (modelName: string) => genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    tools: geminiTools,
    generationConfig: { maxOutputTokens: options?.maxTokens || 8192 },
  });

  let model = makeModel(currentModelName);
  let chat = model.startChat({ history });

  // Send initial user message
  let response;
  try {
    response = await withConcurrencyLimit(() =>
      withRetry(() => chat.sendMessage(userMessage, options?.signal ? { signal: options.signal } : undefined))
    );
  } catch (err: any) {
    if (isAbortError(err)) {
      logAgentEvent(agent.id, 'error', 'Request interrupted by user', { durationMs: Date.now() - loopStart });
      return '';
    }
    if (isGeminiQuotaError(err)) {
      creditsExhaustedUntil = Date.now() + 60 * 60 * 1000;
      logAgentEvent(agent.id, 'error', 'Gemini quota exhausted');
      return agent.id === 'executive-assistant'
        ? '⚠️ Gemini quota is exhausted. Pause the team and ask Jordan to top up Google Cloud billing.'
        : '⚠️ Gemini quota is exhausted right now. Ask Riley to request Jordan approval for more credits before continuing.';
    }
    throw err;
  }

  // Tool-use loop
  const WRITE_TOOLS = new Set([
    'write_file', 'edit_file', 'batch_edit',
    'run_command',
    'git_create_branch', 'create_pull_request', 'merge_pull_request', 'add_pr_comment',
    'delete_channel', 'create_channel', 'rename_channel', 'set_channel_topic',
    'send_channel_message', 'clear_channel_messages', 'delete_category', 'move_channel',
    'gcp_deploy', 'gcp_set_env', 'gcp_rollback', 'gcp_secret_set', 'gcp_vm_ssh',
    'memory_write', 'memory_append',
    'db_query',
    'capture_screenshots',
    'mobile_harness_start', 'mobile_harness_step', 'mobile_harness_snapshot', 'mobile_harness_stop',
  ]);

  for (let round = 0; round < maxToolRounds; round++) {
    if (isClaudeOverLimit() || isBudgetExceeded()) {
      const reason = isBudgetExceeded() ? 'Daily dollar budget exceeded' : 'Daily token limit reached';
      logAgentEvent(agent.id, 'error', reason);
      if (isBudgetExceeded()) {
        const { spent: roundSpent, limit: roundLimit } = getRemainingBudget();
        return agent.id === 'executive-assistant'
          ? `⚠️ Daily budget of $${roundLimit.toFixed(2)} has been reached ($${roundSpent.toFixed(2)} spent). Ask Jordan whether he approves more budget before the team continues.`
          : `⚠️ Daily budget of $${roundLimit.toFixed(2)} has been reached ($${roundSpent.toFixed(2)} spent). Ask Riley to request approval before continuing.`;
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

    const functionCalls = response.response.functionCalls();

    if (!functionCalls || functionCalls.length === 0) {
      // No tool calls — final text response
      recordClaudeUsage(
        response.response.usageMetadata?.promptTokenCount || 0,
        response.response.usageMetadata?.candidatesTokenCount || 0,
      );
      const finalText = response.response.text() || 'Done.';
      logAgentEvent(agent.id, 'response', `${totalToolCalls} tools, response="${finalText.slice(0, 300)}"`, {
        durationMs: Date.now() - loopStart,
        tokensIn: response.response.usageMetadata?.promptTokenCount,
        tokensOut: response.response.usageMetadata?.candidatesTokenCount,
      });
      return finalText;
    }

    // Record usage for this round
    recordClaudeUsage(
      response.response.usageMetadata?.promptTokenCount || 0,
      response.response.usageMetadata?.candidatesTokenCount || 0,
    );

    // Separate read-only (parallel) and write (sequential) calls
    const readCalls = functionCalls.filter((c) => !WRITE_TOOLS.has(c.name));
    const writeCalls = functionCalls.filter((c) => WRITE_TOOLS.has(c.name));

    const functionResponses: Part[] = [];
    let sawValidationFailure = false;

    const processCall = async (call: { name: string; args: object }) => {
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
      if (toolAudit) toolAudit(agent.name, call.name, summary);
      return {
        functionResponse: {
          name: call.name,
          response: { output: truncateToolResult(result) },
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
    }

    // Send tool results back
    try {
      response = await withConcurrencyLimit(() =>
        withRetry(() => chat.sendMessage(functionResponses, options?.signal ? { signal: options.signal } : undefined))
      );
    } catch (err: any) {
      if (isAbortError(err)) {
        logAgentEvent(agent.id, 'error', 'Request interrupted by user', { durationMs: Date.now() - loopStart });
        return '';
      }
      if (isGeminiQuotaError(err)) {
        creditsExhaustedUntil = Date.now() + 60 * 60 * 1000;
        logAgentEvent(agent.id, 'error', 'Gemini quota exhausted mid-loop');
        return agent.id === 'executive-assistant'
          ? '⚠️ Gemini quota is exhausted. Pause the team and ask Jordan to top up Google Cloud billing.'
          : '⚠️ Gemini quota is exhausted right now. Ask Riley to request Jordan approval for more credits before continuing.';
      }
      throw err;
    }
  }

  logAgentEvent(agent.id, 'error', `Max tool iterations (${maxToolRounds}) after ${totalToolCalls} tool calls`, { durationMs: Date.now() - loopStart });
  return 'I hit an internal tool-run safety limit for this pass. Here is what I accomplished so far — please check the repository for changes, then ask me to continue from the latest commit/state.';
}

function formatToolSummary(toolName: string, input: Record<string, string>): string {
  switch (toolName) {
    case 'read_file':
      return `Reading \`${input.path}\` to gather implementation context`;
    case 'write_file':
      return `Writing \`${input.path}\` with the requested changes`;
    case 'edit_file':
      return `Editing \`${input.path}\` to implement or refine behavior`;
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
      const count = Array.isArray(edits) ? edits.length : '?';
      return `Batch editing ${count} files`;
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

  const genAI = getClient();
  const model = genAI.getGenerativeModel({
    model: GEMINI_FLASH,
    systemInstruction: 'You are a concise meeting summarizer. Produce a clear summary with key points, decisions, and action items. Format for Discord markdown. Keep under 1900 characters.',
  });

  const result = await model.generateContent(
    `Summarize this voice call between ${participants.join(', ')}:\n\n${transcript.join('\n')}`
  );

  recordClaudeUsage(
    result.response.usageMetadata?.promptTokenCount || 0,
    result.response.usageMetadata?.candidatesTokenCount || 0,
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

  const genAI = getClient();
  const model = genAI.getGenerativeModel({
    model: GEMINI_FLASH,
    systemInstruction: 'You are a conversation compressor. Produce structured, information-dense summaries that preserve all actionable context while discarding noise. Output only the summary — no meta-commentary.',
  });

  const result = await withConcurrencyLimit(() =>
    withRetry(() => model.generateContent(prompt))
  );

  recordClaudeUsage(
    result.response.usageMetadata?.promptTokenCount || 0,
    result.response.usageMetadata?.candidatesTokenCount || 0,
  );
  return result.response.text() || existingSummary || 'Could not generate summary.';
}
