import { Message, TextChannel, EmbedBuilder } from 'discord.js';
import { AgentConfig } from '../agents';
import { agentRespond, ConversationMessage } from '../claude';
import { appendToMemory, getMemoryContext } from '../memory';
import { clearWebhookCache, sendWebhookMessage, WebhookCapableChannel } from '../services/webhooks';
import { mirrorAgentResponse } from '../services/diagnosticsWebhook';

// Per-channel conversation history (in-memory, keyed by channelId)
const conversationHistories = new Map<string, ConversationMessage[]>();
// Per-channel message queue to prevent concurrent processing
const channelQueues = new Map<string, Promise<void>>();
// Per-channel abort controller so a new message can interrupt in-flight generation
const channelAbortControllers = new Map<string, AbortController>();
const pendingThinkingMessages = new Map<string, Message>();

const MAX_HISTORY = 20; // Keep last 20 messages for context
const PROGRESSIVE_REVEAL_STEP_CHARS = parseInt(process.env.PROGRESSIVE_REVEAL_STEP_CHARS || '320', 10);
const PROGRESSIVE_REVEAL_STEP_MS = parseInt(process.env.PROGRESSIVE_REVEAL_STEP_MS || '60', 10);
const TEXT_MAX_TOKENS_SIMPLE = parseInt(process.env.TEXT_MAX_TOKENS_SIMPLE || '700', 10);
const TEXT_MAX_TOKENS_STANDARD = parseInt(process.env.TEXT_MAX_TOKENS_STANDARD || '1100', 10);
const TEXT_MAX_TOKENS_DEVELOPER = parseInt(process.env.TEXT_MAX_TOKENS_DEVELOPER || '1700', 10);
const STREAM_EDIT_THROTTLE_MS = parseInt(process.env.STREAM_EDIT_THROTTLE_MS || '80', 10);
const STREAM_MAX_PREVIEW_CHARS = parseInt(process.env.STREAM_MAX_PREVIEW_CHARS || '1800', 10);
const STREAM_EDIT_MIN_CHAR_DELTA = parseInt(process.env.STREAM_EDIT_MIN_CHAR_DELTA || '35', 10);

function classifyAgentError(err: unknown): string {
  const message = String((err as any)?.message || err || '').toLowerCase();
  const status = (err as any)?.status || (err as any)?.statusCode;
  if (status === 429 || message.includes('rate limit')) {
    return 'Gemini API is busy right now. Please retry in a moment.';
  }
  if (
    message.includes('quota') ||
    message.includes('resource_exhausted') ||
    message.includes('billing') ||
    message.includes('credits before continuing')
  ) {
    return 'Gemini quota is exhausted right now. Riley needs to restore credits before this can continue.';
  }
  return 'An internal error interrupted the response.';
}

function estimateTextMaxTokens(agent: AgentConfig, userMessage: string): number {
  const trimmed = userMessage.trim();
  const simple = trimmed.length <= 180 && /^(ok|yes|no|status|why|what|how|help|fix|run|test|show|give)\b/i.test(trimmed);
  if (simple) return TEXT_MAX_TOKENS_SIMPLE;
  if (agent.id === 'developer') return TEXT_MAX_TOKENS_DEVELOPER;
  return TEXT_MAX_TOKENS_STANDARD;
}

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
  const pending = pendingThinkingMessages.get(channelId);
  if (pending) {
    pending.delete().catch(() => {});
    pendingThinkingMessages.delete(channelId);
  }
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

  // Visible immediate feedback while the LLM is thinking.
  let pendingThinking: Message | null = null;
  try {
    pendingThinking = await sendWebhookMessage(channel, {
      content: 'Thinking…',
      username: `${agent.emoji} ${agent.name}`,
      avatarURL: agent.avatarUrl,
    });
    pendingThinkingMessages.set(channelId, pendingThinking);
  } catch {
    // Non-fatal: typing indicator already sent.
  }

  // Get or create conversation history, seeded with persistent memory
  let history = conversationHistories.get(channelId);
  if (!history) {
    history = getMemoryContext(agent.id);
    conversationHistories.set(channelId, history);
  }

  try {
    const maxTokens = estimateTextMaxTokens(agent, userMessage);
    // Inject language hint when Mandarin Chinese characters are detected (not persisted to history)
    const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf]/;
    const textLangHint = cjkPattern.test(userMessage)
      ? '\n\n[Language detected: Mandarin Chinese. Please reply in Mandarin Chinese (简体中文).]'
      : '';
    const userMessageWithLang = textLangHint ? `${userMessage}${textLangHint}` : userMessage;
    let streamedPreviewShown = false;
    let lastStreamEditAt = 0;
    let lastRenderedLength = 0;

    const updateStreamPreview = async (partialText: string, force = false): Promise<void> => {
      if (signal?.aborted || !pendingThinking) return;
      const rendered = renderAgentMessage(partialText).trim();
      if (!rendered) return;
      const clipped = rendered.length > STREAM_MAX_PREVIEW_CHARS
        ? `${rendered.slice(0, STREAM_MAX_PREVIEW_CHARS - 1)}…`
        : rendered;
      const now = Date.now();
      if (!force && now - lastStreamEditAt < STREAM_EDIT_THROTTLE_MS) return;
      if (!force && Math.abs(clipped.length - lastRenderedLength) < STREAM_EDIT_MIN_CHAR_DELTA) return;
      lastStreamEditAt = now;
      await pendingThinking.edit(clipped).catch(() => {});
      streamedPreviewShown = true;
      lastRenderedLength = clipped.length;
    };

    const response = await agentRespond(agent, history, userMessageWithLang, async (toolName, summary) => {
      if (signal?.aborted) return;
      try {
        await sendWebhookMessage(channel, {
          content: `🔧 ${summary}`,
          username: `${agent.emoji} ${agent.name}`,
          avatarURL: agent.avatarUrl,
        });
      } catch (err) {
        console.warn(`Webhook tool notification failed for ${agent.name}:`, err instanceof Error ? err.message : 'Unknown');
      }
      }, {
        signal,
        maxTokens,
        onPartialText: async (partialText) => {
          await updateStreamPreview(partialText);
        },
      });

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
    const renderedResponse = renderAgentMessage(response);
    const canFinalizeInPlace =
      !!pendingThinking &&
      streamedPreviewShown &&
      renderedResponse.length > 0 &&
      renderedResponse.length <= 1900;

    if (canFinalizeInPlace && pendingThinking) {
      await updateStreamPreview(renderedResponse, true);
      pendingThinkingMessages.delete(channelId);
      await mirrorAgentResponse(agent.name, channel.name, renderedResponse);
      return;
    }

    if (pendingThinking) {
      pendingThinking.delete().catch(() => {});
      pendingThinkingMessages.delete(channelId);
    }
    await sendAgentMessage(channel, agent, response);
  } catch (err) {
    const abortLike = String((err as any)?.name || '').includes('Abort') || String((err as any)?.message || '').toLowerCase().includes('abort');
    if (abortLike || signal?.aborted) return;
    const errMsg = err instanceof Error ? err.message : String(err);
    const userFacing = classifyAgentError(err);
    console.error(`Agent ${agent.name} error:`, errMsg);
    const short = errMsg.length > 200 ? errMsg.slice(0, 200) + '…' : errMsg;
    try {
      if (pendingThinking) {
        pendingThinking.delete().catch(() => {});
        pendingThinkingMessages.delete(channelId);
      }
      await sendWebhookMessage(channel, {
        content: `⚠️ ${agent.name}: ${userFacing}\n\`\`\`${short}\`\`\``,
        username: `${agent.emoji} ${agent.name}`,
        avatarURL: agent.avatarUrl,
      });
    } catch (webhookErr) {
      console.warn(`Webhook error notification failed for ${agent.name}:`, webhookErr instanceof Error ? webhookErr.message : 'Unknown');
    }
  } finally {
    if (signal?.aborted && pendingThinking) {
      pendingThinking.delete().catch(() => {});
      pendingThinkingMessages.delete(channelId);
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
  channel: WebhookCapableChannel,
  agent: AgentConfig,
  response: string
): Promise<void> {
  const rendered = renderAgentMessage(response);
  const chunks = splitMessage(rendered, 1900);

  try {
    if (shouldProgressivelyReveal(rendered)) {
      await sendProgressiveWebhookMessage(channel, agent, rendered);
    } else {
      for (const chunk of chunks) {
        await sendWebhookMessage(channel, {
          content: chunk,
          username: `${agent.emoji} ${agent.name}`,
          avatarURL: agent.avatarUrl,
        });
      }
    }
    await mirrorAgentResponse(agent.name, channel.name, rendered);
  } catch (err) {
    console.warn(`Webhook send failed for ${agent.name}, retrying with a fresh webhook:`, err instanceof Error ? err.message : 'Unknown');
    clearWebhookCache();
    try {
      for (const chunk of chunks) {
        await sendWebhookMessage(channel, {
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

function shouldProgressivelyReveal(rendered: string): boolean {
  if (!rendered) return false;
  if (rendered.length < 260 || rendered.length > 1800) return false;
  if (rendered.includes('```')) return false;
    return false;
}

async function sendProgressiveWebhookMessage(
  channel: WebhookCapableChannel,
  agent: AgentConfig,
  rendered: string
): Promise<void> {
  const initialChars = Math.min(180, rendered.length);
  const initialContent = initialChars < rendered.length
    ? `${rendered.slice(0, initialChars)}…`
    : rendered;

  const sent = await sendWebhookMessage(channel, {
    content: initialContent,
    username: `${agent.emoji} ${agent.name}`,
    avatarURL: agent.avatarUrl,
  });

  if (typeof (sent as { edit?: unknown }).edit !== 'function') return;

  let visible = initialChars;
  while (visible < rendered.length) {
    await new Promise((resolve) => setTimeout(resolve, PROGRESSIVE_REVEAL_STEP_MS));
    visible = Math.min(rendered.length, visible + PROGRESSIVE_REVEAL_STEP_CHARS);
    const nextContent = visible < rendered.length
      ? `${rendered.slice(0, visible)}…`
      : rendered;
    await (sent as Message).edit(nextContent).catch(() => {});
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
