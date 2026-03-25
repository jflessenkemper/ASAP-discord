import AnthropicVertex from '@anthropic-ai/vertex-sdk';
import { AgentConfig } from './agents';
import { REPO_TOOLS, executeTool } from './tools';

const VERTEX_REGION = process.env.CLAUDE_VERTEX_REGION || 'us-east5';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

let client: AnthropicVertex | null = null;

function getClient(): AnthropicVertex {
  if (!client) {
    client = new AnthropicVertex({ region: VERTEX_REGION });
  }
  return client;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Max tool-use iterations before forcing a text response */
const MAX_TOOL_ROUNDS = 15;

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
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools: REPO_TOOLS as any,
      messages: currentMessages,
    });

    // If the model wants to use tools, execute them and continue
    if (response.stop_reason === 'tool_use') {
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
            content: result.slice(0, 8000), // Limit tool output size
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

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock?.text || 'Could not generate summary.';
}
