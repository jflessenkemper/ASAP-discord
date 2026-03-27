import Anthropic from '@anthropic-ai/sdk';
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
  return FULL_TOOL_AGENTS.has(agentId) ? REPO_TOOLS : REVIEW_TOOLS;
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

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Max tool-use iterations before forcing a text response */
const MAX_TOOL_ROUNDS = 25;
/** Max total time for a tool loop (ms) */
const TOOL_LOOP_TIMEOUT = 180_000;
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
  options?: { modelOverride?: string; maxTokens?: number }
): Promise<string> {
  const anthropic = getClient();

  // Hard budget gate — stop ALL agents if daily budget exceeded
  if (isBudgetExceeded()) {
    const { spent, limit } = getRemainingBudget();
    logAgentEvent(agent.id, 'error', `Budget exceeded: $${spent.toFixed(2)}/$${limit.toFixed(2)}`);
    return `⚠️ Daily budget of $${limit.toFixed(2)} has been reached ($${spent.toFixed(2)} spent). All agents paused until midnight UTC.`;
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

  const toolsSection = isFullToolAgent ? `
You have repo tools: read/write/edit/search files, run_command (shell), fetch_url, memory_read/write, db_query/db_schema, GitHub ops, GCP ops, Discord channel ops, run_tests, typecheck, capture_screenshots.` : `
You have read-only tools: read_file, search_files, list_directory, fetch_url, db_query, db_schema, memory_read, memory_list, run_tests, typecheck.`;

  const budgetWarning = remaining < 0.50 ? `\n⚠️ LOW BUDGET: $${remaining.toFixed(2)} remaining of $${limit.toFixed(2)} daily limit. Be extremely efficient — minimize tool calls, keep responses short.` : '';

  const systemPrompt = `${agent.systemPrompt}

<project_context>
${PROJECT_CONTEXT}
</project_context>

You are "${agent.name}" responding in Discord.${rileyCoordination}
RULES: Max 200 words (code exempt). Bullets not paragraphs. No preamble. Action first. Max ### headings.${toolsSection}
BUDGET: $${spent.toFixed(2)} spent / $${limit.toFixed(2)} daily limit ($${remaining.toFixed(2)} remaining). Each tool call costs tokens. Be efficient.${budgetWarning}
TOKENS: ${tokenUsed.toLocaleString()} used / ${tokenLimit.toLocaleString()} daily limit (${tokenRemaining.toLocaleString()} remaining). If remaining is low, reduce tool calls and avoid broad scans.`;

  // Build messages — convert simple string history to proper format
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...conversationHistory,
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
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (isClaudeOverLimit() || isBudgetExceeded()) {
      const reason = isBudgetExceeded() ? 'Daily dollar budget exceeded' : 'Daily token limit reached';
      logAgentEvent(agent.id, 'error', reason);
      return '⚠️ Daily Claude token limit reached. Try again tomorrow or adjust DAILY_LIMIT_CLAUDE_TOKENS.';
    }
    if (Date.now() - loopStart > TOOL_LOOP_TIMEOUT) {
      logAgentEvent(agent.id, 'error', `Tool loop timeout after ${totalToolCalls} tool calls`, { durationMs: Date.now() - loopStart });
      return 'Tool loop timed out after 3 minutes. Check the repository for any partial changes.';
    }

    const response = await withConcurrencyLimit(() =>
      withRetry(async () => {
        const stream = anthropic.messages.stream({
          model: selectedModel,
          max_tokens: options?.maxTokens || 16384,
          system: systemPrompt,
          tools: agentTools as any,
          messages: currentMessages,
        });
        return stream.finalMessage();
      })
    );

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
        'send_channel_message', 'delete_category', 'move_channel',
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
          content: result.length > 8000
            ? result.slice(0, 8000) + '\n\n[Output truncated — original was ' + result.length + ' chars]'
            : result,
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

Keep the summary under 1500 words. Use bullet points. Drop redundant or superseded information.`
    : `You are compressing conversation history for an AI agent (${agentId}) to maintain long-term context efficiently.

MESSAGES to summarize:
${newMessages}

Create a condensed summary. Prioritize:
1. Key decisions made and their reasoning
2. Technical context (files changed, bugs found, features implemented)
3. User preferences and patterns observed
4. Active tasks / blockers / next steps
5. Important facts (names, IDs, configurations)

Keep the summary under 1500 words. Use bullet points. Drop small talk and redundant exchanges.`;

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
