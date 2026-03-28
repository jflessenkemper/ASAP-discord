import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AgentConfig } from './agents';
import { PROMPT_REPO_TOOLS, PROMPT_REVIEW_TOOLS, executeTool, getToolAuditCallback } from './tools';
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

const CLAUDE_OPUS = 'claude-opus-4-20250514';
const CLAUDE_SONNET = 'claude-sonnet-4-20250514';

/**
 * High-stakes prompts for Ace where Opus quality is worth the cost.
 * Everything else defaults to Sonnet for cost efficiency.
 */
const HIGH_STAKES_RE = /(high[-\s]?stakes|critical|prod(?:uction)?|hotfix|incident|security|auth|migration|rollback|data\s+loss|schema|deploy)/i;
function isHighStakesPrompt(userMessage: string): boolean {
  return HIGH_STAKES_RE.test(userMessage);
}

/** Detect failed tests/typecheck outputs that warrant escalation to Opus. */
function hasValidationFailure(toolName: string, result: string): boolean {
  if (toolName !== 'run_tests' && toolName !== 'typecheck') return false;
  return /(\bFAIL\b|failing|failed|Type error|not assignable|Compilation error|[1-9]\d*\s+errors?\b|Tests?:\s*[1-9]\d*\s+failed)/i.test(result);
}

/**
 * Model policy:
 * - Default: Sonnet for all agents (including Ace)
 * - Escalate: Opus for Ace on explicit high-stakes prompts
 */
function modelForAgent(agentId: string, userMessage: string): string {
  if (agentId === 'developer' && isHighStakesPrompt(userMessage)) {
    return CLAUDE_OPUS;
  }
  return CLAUDE_SONNET;
}

/**
 * Agents that need full tool access (write files, deploy, manage Discord, etc.).
 * All other agents get the lightweight REVIEW_TOOLS subset (~10 tools vs 40),
 * saving ~4,000–6,000 input tokens per request.
 */
const FULL_TOOL_AGENTS = new Set(['developer', 'devops', 'executive-assistant']);
function toolsForAgent(agentId: string) {
  return FULL_TOOL_AGENTS.has(agentId) ? PROMPT_REPO_TOOLS : PROMPT_REVIEW_TOOLS;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
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
  return summaryMsg ? [summaryMsg, ...recent] : recent;
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

function estimateMessageChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  try {
    return JSON.stringify(content).length;
  } catch {
    return 1000;
  }
}

function trimLoopMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: any }>
): Array<{ role: 'user' | 'assistant'; content: any }> {
  if (messages.length <= MAX_LOOP_MESSAGES) return messages;

  const trimmed: Array<{ role: 'user' | 'assistant'; content: any }> = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgChars = estimateMessageChars(msg.content);
    if (trimmed.length >= MAX_LOOP_MESSAGES || chars + msgChars > MAX_LOOP_CHARS) break;
    trimmed.push(msg);
    chars += msgChars;
  }
  trimmed.reverse();
  return trimmed;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Max tool-use iterations before forcing a text response */
const MAX_TOOL_ROUNDS = parseInt(process.env.MAX_TOOL_ROUNDS || '20', 10);
/** Maximum history messages to send to Claude per request (excludes current user message) */
const MAX_CONTEXT_MESSAGES = parseInt(process.env.MAX_CONTEXT_MESSAGES || '35', 10);
/** Soft cap for history character volume sent to Claude per request */
const MAX_CONTEXT_CHARS = parseInt(process.env.MAX_CONTEXT_CHARS || '16000', 10);
/** Cap ongoing tool loop conversation size to prevent token blow-up over many rounds */
const MAX_LOOP_MESSAGES = parseInt(process.env.MAX_LOOP_MESSAGES || '28', 10);
const MAX_LOOP_CHARS = parseInt(process.env.MAX_LOOP_CHARS || '18000', 10);
/**
 * Max total time for a tool loop (ms).
 * Set to 0 (default) to disable wall-clock timeout so agents can run as long as needed.
 */
const TOOL_LOOP_TIMEOUT = parseInt(process.env.TOOL_LOOP_TIMEOUT_MS || '0', 10);
/** Max concurrent Claude requests — kept low to stay within 30k input tokens/min rate limit */
const MAX_CONCURRENT = 3;
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

function isLowCreditError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('credit balance is too low') || msg.includes('plans & billing');
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
        // Extract retry-after from error headers (Anthropic SDK exposes this)
        const retryAfter = err?.headers?.['retry-after'];
        delay = retryAfter ? Math.ceil(Number(retryAfter) * 1000) : 60_000;
        // Set global gate so all concurrent requests pause too
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + delay);
        console.warn(`429 rate limited — global pause for ${Math.ceil(delay / 1000)}s (retry ${i + 1}/${retries})`);
        logAgentEvent('system', 'rate_limit', `429 — pausing ${Math.ceil(delay / 1000)}s`);
      } else {
        delay = delayMs * Math.pow(2, i);
        console.warn(`Claude retry ${i + 1}/${retries} after ${delay}ms: ${err?.message || 'Unknown'}`);
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
  const anthropic = getClient();

  if (isCreditsExhaustedNow()) {
    return agent.id === 'executive-assistant'
      ? '⚠️ Anthropic credits are exhausted right now. Pause the team and ask Jordan whether he wants to top them up before more work continues.'
      : '⚠️ Anthropic credits are exhausted right now. Ask Riley to request Jordan approval for more credits before continuing.';
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

  // Build system prompt — compact version for review agents to save ~1,500 tokens
  const rileyCoordination = agent.id === 'executive-assistant' ? `
AGENT COORDINATION: Coordinate agents via @mentions in your response text. The system parses and routes automatically.
@ace @max @sophie @kane @raj @elena @kai @jude @liv @harper @mia @leo
CRITICAL: Do NOT use send_channel_message — ONLY @mentions work for agent coordination.
` : '';

  const governanceSection = agent.id === 'executive-assistant' ? `
GOVERNANCE:
- You are Jordan's token master. Any request to increase Claude tokens, Anthropic credits, ElevenLabs credit, or daily budget must come through you.
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
    : `\nYou can use the available read-only tools for analysis and verification.`;

  const budgetWarning = remaining < 0.50 ? `\n⚠️ LOW BUDGET: $${remaining.toFixed(2)} remaining of $${limit.toFixed(2)} daily limit. Be extremely efficient — minimize tool calls, keep responses short.` : '';

  const systemPrompt = `${agent.systemPrompt}

<project_context>
${getProjectContextForAgent(agent.id)}
</project_context>

You are "${agent.name}" responding in Discord.${rileyCoordination}
RULES: Max 200 words (code exempt). Speak like a real teammate, not a ticket template. Use short paragraphs or bullets only when helpful. No forced "Summary / Actions / Next" sections. Lead with the useful part.${toolsSection}
Never dump long tool output. Summarize the important result only.
Tooling: Ace owns tool readiness. Check .github/AGENT_TOOLING_STATUS.md first. If tooling looks stale or a required tool may not be ready, coordinate with @ace before relying on it.
${governanceSection}
BUDGET: $${spent.toFixed(2)} spent / $${limit.toFixed(2)} daily limit ($${remaining.toFixed(2)} remaining). Each tool call costs tokens. Be efficient.${budgetWarning}
TOKENS: ${tokenUsed.toLocaleString()} used / ${tokenLimit.toLocaleString()} daily limit (${tokenRemaining.toLocaleString()} remaining). If remaining is low, reduce tool calls and avoid broad scans.`;

  // Build messages — convert simple string history to proper format
  const trimmedHistory = trimConversationHistory(conversationHistory);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...trimmedHistory,
    { role: 'user', content: userMessage },
  ];

  // Tool-use loop
  let currentMessages: typeof messages = [...messages];
  const loopStart = Date.now();
  let totalToolCalls = 0;
  const agentTools = toolsForAgent(agent.id);
  let selectedModel = options?.modelOverride || modelForAgent(agent.id, userMessage);
  let escalatedToOpus = selectedModel === CLAUDE_OPUS;
  logAgentEvent(agent.id, 'invoke', `model=${selectedModel}, context=${messages.length} msgs, prompt="${userMessage.slice(0, 200)}"`);
  // Check for pre-abort before starting any work
  if (options?.signal?.aborted) return '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
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
        ? '⚠️ Daily Claude token limit reached. Ask Jordan whether he wants to raise DAILY_LIMIT_CLAUDE_TOKENS before the team continues.'
        : '⚠️ Daily Claude token limit reached. Ask Riley to request approval before continuing.';
    }
    if (TOOL_LOOP_TIMEOUT > 0 && Date.now() - loopStart > TOOL_LOOP_TIMEOUT) {
      logAgentEvent(agent.id, 'error', `Tool loop timeout after ${totalToolCalls} tool calls`, { durationMs: Date.now() - loopStart });
      return `Tool loop timed out after ${Math.round(TOOL_LOOP_TIMEOUT / 60000)} minutes. Check the repository for any partial changes.`;
    }

    // Check if the request was aborted (user sent a new message)
    if (options?.signal?.aborted) {
      logAgentEvent(agent.id, 'error', 'Request interrupted by user', { durationMs: Date.now() - loopStart });
      return '';
    }

    let response;
    try {
      response = await withConcurrencyLimit(() =>
        withRetry(async () => {
          const stream = anthropic.messages.stream({
            model: selectedModel,
            max_tokens: options?.maxTokens || 8192,
            system: systemPrompt,
            tools: agentTools as any,
            messages: currentMessages,
          }, { signal: options?.signal ?? undefined });
          return stream.finalMessage();
        })
      );
    } catch (err: any) {
      if (isAbortError(err)) {
        logAgentEvent(agent.id, 'error', 'Request interrupted by user', { durationMs: Date.now() - loopStart });
        return '';
      }
      if (isLowCreditError(err)) {
        creditsExhaustedUntil = Date.now() + 60 * 60 * 1000; // suppress churn for 1h
        logAgentEvent(agent.id, 'error', 'Anthropic credits exhausted');
        return '⚠️ Anthropic credits are exhausted, so I cannot run tools right now. Please top up billing and retry.';
      }
      throw err;
    }

    // If the model wants to use tools, execute them and continue
    if (response.stop_reason === 'tool_use') {
      // Track token usage for this round
      recordClaudeUsage(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0);
      // Add assistant message with tool_use blocks
      currentMessages.push({
        role: 'assistant',
        content: response.content as any,
      } as any);

      // Execute tool calls in parallel (read-only tools) or sequentially (write tools)
      const toolBlocks = response.content.filter((b) => b.type === 'tool_use');
      const WRITE_TOOLS = new Set([
        // File ops
        'write_file', 'edit_file', 'batch_edit',
        // Shell
        'run_command',
        // Git/GitHub
        'git_create_branch', 'create_pull_request', 'merge_pull_request', 'add_pr_comment',
        // Discord management
        'delete_channel', 'create_channel', 'rename_channel', 'set_channel_topic',
        'send_channel_message', 'clear_channel_messages', 'delete_category', 'move_channel',
        // GCP
        'gcp_deploy', 'gcp_set_env', 'gcp_rollback', 'gcp_secret_set',
        // Memory
        'memory_write', 'memory_append',
        // Database (may contain INSERT/UPDATE/DELETE)
        'db_query',
        // Screenshots
        'capture_screenshots',
      ]);

      // Separate into read-only (parallelizable) and write (sequential) batches
      const readBatch: typeof toolBlocks = [];
      const writeBatch: typeof toolBlocks = [];
      for (const block of toolBlocks) {
        if (block.type === 'tool_use') {
          (WRITE_TOOLS.has(block.name) ? writeBatch : readBatch).push(block);
        }
      }

      const toolResults: Array<{
        type: 'tool_result';
        tool_use_id: string;
        content: string;
      }> = [];

      let sawValidationFailure = false;
      const processBlock = async (block: any) => {
        const toolStart = Date.now();
        totalToolCalls++;
        const result = await executeTool(block.name, block.input as Record<string, string>);
        if (agent.id === 'developer' && !options?.modelOverride && hasValidationFailure(block.name, result)) {
          sawValidationFailure = true;
        }
        const summary = formatToolSummary(block.name, block.input as Record<string, string>);
        logAgentEvent(agent.id, 'tool', summary, { durationMs: Date.now() - toolStart });
        if (onToolUse) await onToolUse(block.name, summary);
        const toolAudit = getToolAuditCallback();
        if (toolAudit) toolAudit(agent.name, block.name, summary);
        return {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: truncateToolResult(result),
        };
      };

      // Run read-only tools in parallel
      if (readBatch.length > 0) {
        const readResults = await Promise.all(readBatch.map(processBlock));
        toolResults.push(...readResults);
      }

      // Run write tools sequentially (order matters)
      for (const block of writeBatch) {
        toolResults.push(await processBlock(block));
      }

      // Add tool results as a user message
      currentMessages.push({
        role: 'user',
        content: toolResults as any,
      } as any);

      // Cost-aware escalation policy for Ace:
      // if tests/typecheck fail while on Sonnet, switch this request to Opus.
      if (
        agent.id === 'developer' &&
        !options?.modelOverride &&
        !escalatedToOpus &&
        selectedModel === CLAUDE_SONNET &&
        sawValidationFailure
      ) {
        selectedModel = CLAUDE_OPUS;
        escalatedToOpus = true;
        logAgentEvent(agent.id, 'response', 'Escalated Sonnet -> Opus after validation failure');
        currentMessages.push({
          role: 'user',
          content: 'Validation failed (tests/typecheck). Re-plan and fix using deeper reasoning before final response.',
        });
      }

      currentMessages = trimLoopMessages(currentMessages as any) as any;

      continue;
    }

    // Model finished with text — extract and return it
    recordClaudeUsage(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0);
    const textBlock = response.content.find((b) => b.type === 'text');
    const finalText = textBlock?.text || 'Done.';
    logAgentEvent(agent.id, 'response', `${totalToolCalls} tools, response="${finalText.slice(0, 300)}"`, {
      durationMs: Date.now() - loopStart,
      tokensIn: response.usage?.input_tokens,
      tokensOut: response.usage?.output_tokens,
    });
    return finalText;
  }

  logAgentEvent(agent.id, 'error', `Max tool iterations (${MAX_TOOL_ROUNDS}) after ${totalToolCalls} tool calls`, { durationMs: Date.now() - loopStart });
  return 'Reached maximum tool iterations. Here is what I accomplished so far — please check the repository for changes.';
}

function formatToolSummary(toolName: string, input: Record<string, string>): string {
  switch (toolName) {
    case 'read_file':
      return `Reading \`${input.path}\``;
    case 'write_file':
      return `Writing \`${input.path}\``;
    case 'edit_file':
      return `Editing \`${input.path}\``;
    case 'search_files':
      return `Searching for \`${input.pattern}\`${input.include ? ` in ${input.include}` : ''}`;
    case 'list_directory':
      return `Listing \`${input.path || '.'}\``;
    case 'run_command':
      return `Running \`${input.command.slice(0, 100)}\``;
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
      return `Running tests${input.test_pattern ? ` (${input.test_pattern})` : ''}`;
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
      return `Running typecheck${input.target ? ` (${input.target})` : ''}`;
    case 'batch_edit': {
      const edits = input.edits as any;
      const count = Array.isArray(edits) ? edits.length : '?';
      return `Batch editing ${count} files`;
    }
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
      return `Running SQL: ${input.query?.slice(0, 80)}`;
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
    return '⚠️ Daily Claude token limit reached — cannot generate summary.';
  }

  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: CLAUDE_SONNET,
    max_tokens: 1024,
    system: 'You are a concise meeting summarizer. Produce a clear summary with key points, decisions, and action items. Format for Discord markdown. Keep under 1900 characters.',
    messages: [
      {
        role: 'user',
        content: `Summarize this voice call between ${participants.join(', ')}:\n\n${transcript.join('\n')}`,
      },
    ],
  });

  recordClaudeUsage(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0);

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock?.text || 'Could not generate summary.';
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

  const anthropic = getClient();

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

  const response = await withConcurrencyLimit(() =>
    withRetry(() =>
      anthropic.messages.create({
        model: CLAUDE_SONNET,
        max_tokens: 2048,
        system: 'You are a conversation compressor. Produce structured, information-dense summaries that preserve all actionable context while discarding noise. Output only the summary — no meta-commentary.',
        messages: [{ role: 'user', content: prompt }],
      })
    )
  );

  recordClaudeUsage(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0);
  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock?.text || existingSummary || 'Could not generate summary.';
}
