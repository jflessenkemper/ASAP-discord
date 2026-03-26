import AnthropicVertex from '@anthropic-ai/vertex-sdk';
import { AgentConfig } from './agents';
import { REPO_TOOLS, executeTool } from './tools';
import { recordClaudeUsage, isClaudeOverLimit } from './usage';

const VERTEX_REGION = process.env.CLAUDE_VERTEX_REGION || 'asia-southeast1';
const CLAUDE_MODEL = 'claude-opus-4-20250514';

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
const MAX_TOOL_ROUNDS = 15;
/** Max total time for a tool loop (ms) */
const TOOL_LOOP_TIMEOUT = 90_000;
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
  onToolUse?: (toolName: string, summary: string) => Promise<void>
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
      return 'Tool loop timed out after 90 seconds. Check the repository for any partial changes.';
    }

    const response = await withConcurrencyLimit(() =>
      withRetry(() =>
        anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 4096,
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

      // Execute each tool call and build tool_result messages
      const toolResults: Array<{
        type: 'tool_result';
        tool_use_id: string;
        content: string;
      }> = [];

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const result = await executeTool(
            block.name,
            block.input as Record<string, string>
          );

          // Notify the channel about the tool use
          if (onToolUse) {
            const summary = formatToolSummary(block.name, block.input as Record<string, string>);
            await onToolUse(block.name, summary);
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.length > 8000
              ? result.slice(0, 8000) + '\n\n[Output truncated — original was ' + result.length + ' chars]'
              : result,
          });
        }
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
    model: CLAUDE_MODEL,
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
