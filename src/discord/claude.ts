import AnthropicVertex from '@anthropic-ai/vertex-sdk';
import { AgentConfig } from './agents';
import { REPO_TOOLS, executeTool, getToolAuditCallback } from './tools';
import { recordClaudeUsage, isClaudeOverLimit } from './usage';

const VERTEX_REGION = process.env.CLAUDE_VERTEX_REGION || 'us-east5';
const CLAUDE_OPUS = 'claude-opus-4';
const CLAUDE_SONNET = 'claude-sonnet-4';

/** Riley uses Sonnet (fast, conversational). All other agents use Opus (powerful, tool-heavy). */
function modelForAgent(agentId: string): string {
  return agentId === 'executive-assistant' ? CLAUDE_SONNET : CLAUDE_OPUS;
}

let client: AnthropicVertex | null = null;

function getClient(): AnthropicVertex {
  if (!client) {
    client = new AnthropicVertex({
      region: VERTEX_REGION,
      projectId: process.env.GCS_PROJECT_ID || process.env.ANTHROPIC_VERTEX_PROJECT_ID,
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
/** Max concurrent Claude requests to avoid rate limits */
const MAX_CONCURRENT = 4;
let activeClaude = 0;
const claudeQueue: Array<() => void> = [];

async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  while (activeClaude >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => claudeQueue.push(resolve));
  }
  activeClaude++;
  try {
    return await fn();
  } finally {
    activeClaude--;
    claudeQueue.shift()?.();
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1000): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === retries) throw err;
      // Only retry on transient errors (5xx, network)
      const status = err?.status || err?.statusCode;
      if (status && status < 500 && status !== 429) throw err;
      const delay = delayMs * Math.pow(2, i);
      console.warn(`Claude retry ${i + 1}/${retries} after ${delay}ms: ${err?.message || 'Unknown'}`);
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

  const systemPrompt = `${agent.systemPrompt}

IMPORTANT CONTEXT: You are responding in a Discord channel. Your name is "${agent.name}".

CONCISENESS RULES (MANDATORY):
- Max 200 words per response unless you're writing/editing code
- Use bullet points, not paragraphs
- No preamble, no fluff, no restating the question
- Action first, explanation only if needed
- Code blocks are exempt from the word limit
- Do not use headings larger than ### in Discord
- If you need to provide longer content, break it into sections and ask before continuing

DECISION PROTOCOL: When you need the user's input, use this format:
🛑 **Decision Required**
1️⃣ Option one
2️⃣ Option two
3️⃣ Option three

You have access to tools that let you read, write, search, and edit files in the ASAP repository, as well as run shell commands. Use them when the user asks you to inspect code, implement changes, fix bugs, or perform any repository operation. When you make file changes, always read the file first to understand context, then make precise edits.`;

  // Build messages — convert simple string history to proper format
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  // Tool-use loop
  let currentMessages: typeof messages = [...messages];
  const loopStart = Date.now();
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (isClaudeOverLimit()) {
      return '⚠️ Daily Claude token limit reached. Try again tomorrow or adjust DAILY_LIMIT_CLAUDE_TOKENS.';
    }
    if (Date.now() - loopStart > TOOL_LOOP_TIMEOUT) {
      return 'Tool loop timed out after 3 minutes. Check the repository for any partial changes.';
    }

    const response = await withConcurrencyLimit(() =>
      withRetry(() =>
        anthropic.messages.create({
          model: options?.modelOverride || modelForAgent(agent.id),
          max_tokens: options?.maxTokens || 16384,
          system: systemPrompt,
          tools: REPO_TOOLS as any,
          messages: currentMessages,
        })
      )
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
      const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'batch_edit', 'run_command', 'git_create_branch', 'create_pull_request', 'merge_pull_request']);

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

      const processBlock = async (block: any) => {
        const result = await executeTool(block.name, block.input as Record<string, string>);
        const summary = formatToolSummary(block.name, block.input as Record<string, string>);
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

      continue;
    }

    // Model finished with text — extract and return it
    recordClaudeUsage(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0);
    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock?.text || 'Done.';
  }

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
