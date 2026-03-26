import { Message, TextChannel, EmbedBuilder } from 'discord.js';
import { AgentConfig } from '../agents';
import { agentRespond, ConversationMessage } from '../claude';
import { appendToMemory, getMemoryContext } from '../memory';

// Per-channel conversation history (in-memory, keyed by channelId)
const conversationHistories = new Map<string, ConversationMessage[]>();
// Per-channel message queue to prevent concurrent processing
const channelQueues = new Map<string, Promise<void>>();

const MAX_HISTORY = 20; // Keep last 20 messages for context

/**
 * Handle a message in an individual agent channel.
 * Serialized per-channel to prevent race conditions on history.
 */
export async function handleAgentMessage(
  message: Message,
  agent: AgentConfig
): Promise<void> {
  const channelId = message.channel.id;
  const prev = channelQueues.get(channelId) || Promise.resolve();
  const next = prev.then(() => handleAgentMessageInner(message, agent)).catch((err) => {
    console.error(`Agent queue error for ${agent.name}:`, err instanceof Error ? err.message : 'Unknown');
  });
  channelQueues.set(channelId, next);
}

async function handleAgentMessageInner(
  message: Message,
  agent: AgentConfig
): Promise<void> {
  const channelId = message.channel.id;
  const userMessage = message.content.trim();

  if (!userMessage) return;

  // Show typing indicator
  const channel = message.channel as TextChannel;
  await channel.sendTyping();

  // Get or create conversation history, seeded with persistent memory
  let history = conversationHistories.get(channelId);
  if (!history) {
    history = getMemoryContext(agent.id);
    conversationHistories.set(channelId, history);
  }

  try {
    const response = await agentRespond(agent, history, userMessage, async (toolName, summary) => {
      await channel.send(`🔧 ${summary}`);
    });

    // Update history
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: response });

    // Trim history if too long
    if (history.length > MAX_HISTORY * 2) {
      history.splice(0, history.length - MAX_HISTORY * 2);
    }

    // Persist to disk
    appendToMemory(agent.id, [
      { role: 'user', content: userMessage },
      { role: 'assistant', content: response },
    ]);

    // Split response if over Discord's 2000 char limit
    await sendAgentMessage(channel, agent, response);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Agent ${agent.name} error:`, errMsg);
    const short = errMsg.length > 200 ? errMsg.slice(0, 200) + '…' : errMsg;
    await channel.send(`⚠️ ${agent.name} encountered an error:\n\`\`\`${short}\`\`\``);
  }
}

/**
 * Clear conversation history for a channel.
 */
export function clearHistory(channelId: string): void {
  conversationHistories.delete(channelId);
}

/**
 * Send an agent response as a colored embed with the agent's name and emoji.
 */
export async function sendAgentMessage(
  channel: TextChannel,
  agent: AgentConfig,
  response: string
): Promise<void> {
  // Discord embed description limit is 4096 chars
  const chunks = splitMessage(response, 4000);
  const embeds: EmbedBuilder[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const embed = new EmbedBuilder()
      .setColor(agent.color)
      .setDescription(chunks[i]);

    if (i === 0) {
      embed.setAuthor({ name: `${agent.emoji} ${agent.name}` });
    }
    embeds.push(embed);
  }

  // Discord allows up to 10 embeds per message — batch them
  for (let i = 0; i < embeds.length; i += 10) {
    await channel.send({ embeds: embeds.slice(i, i + 10) });
  }
}

/**
 * Send a plain message, splitting if over 2000 characters.
 */
export async function sendLongMessage(channel: TextChannel, content: string): Promise<void> {
  if (content.length <= 2000) {
    await channel.send(content);
    return;
  }

  const lines = content.split('\n');
  let chunk = '';

  for (const line of lines) {
    if (chunk.length + line.length + 1 > 1990) {
      if (chunk) await channel.send(chunk);
      chunk = line;
    } else {
      chunk += (chunk ? '\n' : '') + line;
    }
  }

  if (chunk) await channel.send(chunk);
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let chunk = '';

  for (const line of lines) {
    if (chunk.length + line.length + 1 > maxLen) {
      if (chunk) chunks.push(chunk);
      chunk = line;
    } else {
      chunk += (chunk ? '\n' : '') + line;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
