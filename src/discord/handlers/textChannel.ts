import { Message, TextChannel, EmbedBuilder } from 'discord.js';
import { AgentConfig } from '../agents';
import { agentRespond, ConversationMessage } from '../claude';
import { appendToMemory, getMemoryContext } from '../memory';
import { clearWebhookCache, getWebhook } from '../services/webhooks';
import { mirrorAgentResponse } from '../services/diagnosticsWebhook';

// Per-channel conversation history (in-memory, keyed by channelId)
const conversationHistories = new Map<string, ConversationMessage[]>();
// Per-channel message queue to prevent concurrent processing
const channelQueues = new Map<string, Promise<void>>();
// Per-channel abort controller so a new message can interrupt in-flight generation
const channelAbortControllers = new Map<string, AbortController>();

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

  // Interrupt any in-flight response in this channel so the agent listens to the latest message
  const prevController = channelAbortControllers.get(channelId);
  if (prevController) prevController.abort();
  const controller = new AbortController();
  channelAbortControllers.set(channelId, controller);

  const prev = channelQueues.get(channelId) || Promise.resolve();
  const next = prev.then(async () => {
    if (controller.signal.aborted) return;
    await handleAgentMessageInner(message, agent, controller.signal);
    if (channelAbortControllers.get(channelId) === controller) {
      channelAbortControllers.delete(channelId);
    }
  }).catch((err) => {
    console.error(`Agent queue error for ${agent.name}:`, err instanceof Error ? err.message : 'Unknown');
  });
  channelQueues.set(channelId, next);
}

async function handleAgentMessageInner(
  message: Message,
  agent: AgentConfig,
  signal?: AbortSignal
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
      if (signal?.aborted) return;
      try {
        const wh = await getWebhook(channel);
        await wh.send({
          content: `🔧 ${summary}`,
          username: `${agent.emoji} ${agent.name}`,
          avatarURL: agent.avatarUrl,
        });
      } catch (err) {
        console.warn(`Webhook tool notification failed for ${agent.name}:`, err instanceof Error ? err.message : 'Unknown');
      }
      }, { signal });

      if (signal?.aborted) return;

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
    if (signal?.aborted) return;
    await sendAgentMessage(channel, agent, response);
  } catch (err) {
    const abortLike = String((err as any)?.name || '').includes('Abort') || String((err as any)?.message || '').toLowerCase().includes('abort');
    if (abortLike || signal?.aborted) return;
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Agent ${agent.name} error:`, errMsg);
    const short = errMsg.length > 200 ? errMsg.slice(0, 200) + '…' : errMsg;
    try {
      const wh = await getWebhook(channel);
      await wh.send({
        content: `⚠️ ${agent.name} encountered an error:\n\`\`\`${short}\`\`\``,
        username: `${agent.emoji} ${agent.name}`,
        avatarURL: agent.avatarUrl,
      });
    } catch (webhookErr) {
      console.warn(`Webhook error notification failed for ${agent.name}:`, webhookErr instanceof Error ? webhookErr.message : 'Unknown');
    }
  }
}

/**
 * Clear conversation history for a channel.
 */
export function clearHistory(channelId: string): void {
  conversationHistories.delete(channelId);
}

/**
 * Send an agent response via webhook so each agent appears with their own
 * name and avatar — like separate users in Discord.
 * Falls back to colored embeds if webhook creation fails.
 */
export async function sendAgentMessage(
  channel: TextChannel,
  agent: AgentConfig,
  response: string
): Promise<void> {
  const rendered = renderAgentMessage(response);
  const chunks = splitMessage(rendered, 1900);

  try {
    const webhook = await getWebhook(channel);
    for (const chunk of chunks) {
      await webhook.send({
        content: chunk,
        username: `${agent.emoji} ${agent.name}`,
        avatarURL: agent.avatarUrl,
      });
    }
    await mirrorAgentResponse(agent.name, channel.name, rendered);
  } catch (err) {
    console.warn(`Webhook send failed for ${agent.name}, retrying with a fresh webhook:`, err instanceof Error ? err.message : 'Unknown');
    clearWebhookCache();
    try {
      const retryWebhook = await getWebhook(channel);
      for (const chunk of chunks) {
        await retryWebhook.send({
          content: chunk,
          username: `${agent.emoji} ${agent.name}`,
          avatarURL: agent.avatarUrl,
        });
      }
      await mirrorAgentResponse(agent.name, channel.name, rendered);
      return;
    } catch (retryErr) {
      console.error(`Webhook retry failed for ${agent.name}:`, retryErr instanceof Error ? retryErr.message : 'Unknown');
    }
  }
}

function renderAgentMessage(raw: string): string {
  const withoutActionTags = raw.replace(/\[ACTION:[^\]]+\]/g, '').trim();
  if (!withoutActionTags) return '';

  // Models may echo internal memory-style speaker labels (e.g. "[Liv]:").
  // Remove a single leading label so Discord output stays natural.
  const withoutSpeakerLabel = withoutActionTags.replace(/^\s*\[[^\]\r\n]{1,40}\]:\s*/u, '');
  if (!withoutSpeakerLabel) return '';

  // Reduce visual noise: strip markdown heading prefixes that make chat feel
  // disjointed (e.g. "## Next Steps"), while keeping the line content.
  const withoutHeadings = withoutSpeakerLabel
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .trim();
  if (!withoutHeadings) return '';

  // Preserve code blocks verbatim; bold mentions only in normal prose.
  const segments = withoutHeadings.split(/(```[\s\S]*?```)/g);
  const formatted = segments.map((segment) => {
    if (segment.startsWith('```') && segment.endsWith('```')) return segment;
    const noHeavyBold = segment
      // Keep @mentions bold, but demote other bold emphasis to plain text.
      .replace(/\*\*(?!@)([^*\n]{1,120})\*\*/g, '$1')
      // Collapse excessive blank space.
      .replace(/\n{3,}/g, '\n\n');
    return noHeavyBold.replace(/(^|\s)@([a-z0-9-]{2,32})\b/gi, (_m, prefix, name) => `${prefix}**@${name}**`);
  }).join('');

  return formatted.trim();
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
    if (line.length > 1990) {
      if (chunk) { await channel.send(chunk); chunk = ''; }
      for (let i = 0; i < line.length; i += 1990) {
        await channel.send(line.slice(i, i + 1990));
      }
    } else if (chunk.length + line.length + 1 > 1990) {
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
    if (line.length > maxLen) {
      // Flush current chunk first
      if (chunk) { chunks.push(chunk); chunk = ''; }
      // Sub-split oversized line at maxLen boundaries
      for (let i = 0; i < line.length; i += maxLen) {
        chunks.push(line.slice(i, i + maxLen));
      }
    } else if (chunk.length + line.length + 1 > maxLen) {
      if (chunk) chunks.push(chunk);
      chunk = line;
    } else {
      chunk += (chunk ? '\n' : '') + line;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
