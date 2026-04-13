import { AttachmentBuilder, Message, TextChannel } from 'discord.js';

import { AgentConfig, getAgentMention, resolveAgentId } from '../agents';
import { agentRespond, ConversationMessage } from '../claude';
import { appendToMemory, getMemoryContext } from '../memory';
import { recordTextChannelTimeout, updateTextChannelQueueDepth } from '../metrics';
import { mirrorAgentResponse } from '../services/diagnosticsWebhook';
import { clearWebhookCache, sendWebhookMessage, WebhookCapableChannel } from '../services/webhooks';

import { isLowSignalCompletion } from './responseNormalization';

const conversationHistories = new Map<string, ConversationMessage[]>();
const channelQueues = new Map<string, Promise<void>>();
const channelQueueDepth = new Map<string, number>();
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
const TEXT_AGENT_RESPONSE_TIMEOUT_MS = parseInt(process.env.TEXT_AGENT_RESPONSE_TIMEOUT_MS || '120000', 10);
const TEXT_PROGRESS_HEARTBEAT_MS = parseInt(process.env.TEXT_PROGRESS_HEARTBEAT_MS || '15000', 10);
const CAREER_OPS_DUPLICATE_WINDOW_MS = parseInt(process.env.CAREER_OPS_DUPLICATE_WINDOW_MS || '600000', 10);
const CAREER_OPS_SUPPRESSION_NOTICE_COOLDOWN_MS = parseInt(process.env.CAREER_OPS_SUPPRESSION_NOTICE_COOLDOWN_MS || '120000', 10);
const careerOpsLastResponseFingerprint = new Map<string, { fingerprint: string; ts: number }>();
const careerOpsSuppressionNoticeAt = new Map<string, number>();
const careerOpsIncomingCompletionFingerprint = new Map<string, number>();

function shouldSuppressCareerOpsDuplicate(channel: WebhookCapableChannel, rendered: string): { suppress: boolean; notice?: string } {
  const channelName = String((channel as any)?.name || '').toLowerCase();
  if (!channelName.includes('career-ops')) return { suppress: false };

  const normalized = rendered
    .replace(/<@!?\d+>/g, '@user')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const looksLikeCompletionUpdate =
    normalized.startsWith('completion update:') ||
    normalized.startsWith('✅ completion update:') ||
    normalized.includes('partially complete with follow-up required');

  if (!looksLikeCompletionUpdate) return { suppress: false };

  const key = String((channel as any)?.id || channelName);
  const fingerprint = normalized.slice(0, 260);
  const prev = careerOpsLastResponseFingerprint.get(key);
  const now = Date.now();
  if (prev && prev.fingerprint === fingerprint && now - prev.ts < CAREER_OPS_DUPLICATE_WINDOW_MS) {
    const noticePrev = careerOpsSuppressionNoticeAt.get(key) || 0;
    if (now - noticePrev >= CAREER_OPS_SUPPRESSION_NOTICE_COOLDOWN_MS) {
      careerOpsSuppressionNoticeAt.set(key, now);
      return {
        suppress: true,
        notice: 'ℹ️ I already posted that completion update recently, so I skipped the duplicate.',
      };
    }
    return { suppress: true };
  }
  careerOpsLastResponseFingerprint.set(key, { fingerprint, ts: now });
  return { suppress: false };
}

function classifyAgentError(err: unknown): string {
  const message = String((err as any)?.message || err || '').toLowerCase();
  const status = (err as any)?.status || (err as any)?.statusCode;
  if (status === 429 || message.includes('rate limit')) {
    return 'Gemini API is busy right now. Please retry in a moment.';
  }
  if (message.includes('timed out') || message.includes('timeout')) {
    return 'The model timed out while responding. Please retry with a shorter or more specific request.';
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

function isGeminiFunctionTurnSequenceError(err: unknown): boolean {
  const message = String((err as any)?.message || err || '').toLowerCase();
  return message.includes('function response turn comes immediately after a function call turn');
}

function isTextTimeoutError(err: unknown): boolean {
  const message = String((err as any)?.message || err || '').toLowerCase();
  return message.includes('text channel response timed out after') || message.includes('timed out');
}

function detectCareerOpsIncomingDuplicate(message: Message, channel: TextChannel, raw: string): { duplicate: boolean; notice?: string } {
  const channelName = String(channel.name || '').toLowerCase();
  if (!channelName.includes('career-ops')) return { duplicate: false };

  const normalized = String(raw || '')
    .replace(/<@!?\d+>/g, '@user')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!normalized) return { duplicate: false };

  const looksLikeCompletionUpdate =
    normalized.startsWith('completion update:') ||
    normalized.startsWith('✅ completion update:') ||
    normalized.includes('partially complete with follow-up required');
  if (!looksLikeCompletionUpdate) return { duplicate: false };

  const authorId = String(message.author?.id || 'unknown');
  const fingerprint = normalized.slice(0, 260);
  const key = `${channel.id}:${authorId}:${fingerprint}`;
  const now = Date.now();
  const prev = careerOpsIncomingCompletionFingerprint.get(key) || 0;
  careerOpsIncomingCompletionFingerprint.set(key, now);

  if (now - prev < CAREER_OPS_DUPLICATE_WINDOW_MS) {
    return {
      duplicate: true,
      notice: 'ℹ️ I already received that completion update recently, so I skipped the duplicate submission.',
    };
  }

  if (careerOpsIncomingCompletionFingerprint.size > 1000) {
    for (const [k, ts] of careerOpsIncomingCompletionFingerprint) {
      if (now - ts > CAREER_OPS_DUPLICATE_WINDOW_MS * 2) {
        careerOpsIncomingCompletionFingerprint.delete(k);
      }
    }
  }

  return { duplicate: false };
}

function estimateTextMaxTokens(agent: AgentConfig, userMessage: string): number {
  const trimmed = userMessage.trim();
  const simple = trimmed.length <= 180 && /^(ok|yes|no|status|why|what|how|help|fix|run|test|show|give)\b/i.test(trimmed);
  if (simple) return TEXT_MAX_TOKENS_SIMPLE;
  if (agent.id === 'developer') return TEXT_MAX_TOKENS_DEVELOPER;
  return TEXT_MAX_TOKENS_STANDARD;
}

function shouldDisableToolsForProfilePrompt(userMessage: string): boolean {
  const text = String(userMessage || '').toLowerCase();
  const asksForProfileFields =
    /(profile|avatar|picture|colors?|colour|symbol|nickname)/.test(text) &&
    /(reply|format|one line|exact format|only|picture=|colors=|symbol=)/.test(text);
  return asksForProfileFields;
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

  const prevController = channelAbortControllers.get(channelId);
  if (prevController) prevController.abort();
  const pending = pendingThinkingMessages.get(channelId);
  if (pending) {
    pending.delete().catch(() => {});
    pendingThinkingMessages.delete(channelId);
  }
  const controller = new AbortController();
  channelAbortControllers.set(channelId, controller);

  const depth = (channelQueueDepth.get(channelId) || 0) + 1;
  channelQueueDepth.set(channelId, depth);
  updateTextChannelQueueDepth(agent.id, depth);

  const prev = channelQueues.get(channelId) || Promise.resolve();
  const next = prev.then(async () => {
    if (controller.signal.aborted) return;
    await handleAgentMessageInner(message, agent, controller.signal);
    if (channelAbortControllers.get(channelId) === controller) {
      channelAbortControllers.delete(channelId);
    }
  }).catch((err) => {
    console.error(`Agent queue error for ${agent.name}:`, err instanceof Error ? err.message : 'Unknown');
  }).finally(() => {
    const nextDepth = Math.max(0, (channelQueueDepth.get(channelId) || 1) - 1);
    channelQueueDepth.set(channelId, nextDepth);
    updateTextChannelQueueDepth(agent.id, nextDepth);
  });
  channelQueues.set(channelId, next);
}

async function handleAgentMessageInner(
  message: Message,
  agent: AgentConfig,
  signal?: AbortSignal
): Promise<void> {
  const channelId = message.channel.id;
  let userMessage = message.content.trim();

  if (!userMessage) return;

  const channel = message.channel as TextChannel;
  const isCareerOpsRiley = agent.id === 'executive-assistant' && /career-ops/i.test(channel.name);
  const completionToken = extractCompletionTokenFromPrompt(userMessage);
  const isCompletionCheckPrompt = !!completionToken && !!message.author?.bot;

  if (isCompletionCheckPrompt && completionToken) {
    const completionReply = buildCompletionCheckReply(agent, completionToken);
    await sendWebhookMessage(channel, {
      content: completionReply,
      username: `${agent.emoji} ${agent.name}`,
      avatarURL: agent.avatarUrl,
    }).catch(async () => {
      await sendAgentFallbackMessage(channel, agent, completionReply).catch(() => {});
    });
    return;
  }

  const incomingDuplicate = detectCareerOpsIncomingDuplicate(message, channel, userMessage);
  if (incomingDuplicate.duplicate) {
    await sendWebhookMessage(channel, {
      content: incomingDuplicate.notice || 'ℹ️ Duplicate update suppressed.',
      username: `${agent.emoji} ${agent.name}`,
      avatarURL: agent.avatarUrl,
    }).catch(() => {});
    return;
  }
  if (isCareerOpsRiley) {
    userMessage = `${userMessage}\n\n[Career Ops channel mode: respond directly for job-search workflow. Do not run deployment, health-check, smoke-test, or infra actions unless the user explicitly asks for them.]`;
  }
  await channel.sendTyping();

  let pendingThinking: Message | null = null;
  let progressHeartbeat: ReturnType<typeof setTimeout> | null = null;
  try {
    pendingThinking = await sendWebhookMessage(channel, {
      content: 'Thinking…',
      username: `${agent.emoji} ${agent.name}`,
      avatarURL: agent.avatarUrl,
    });
    pendingThinkingMessages.set(channelId, pendingThinking);
  } catch {
  }

  let history = conversationHistories.get(channelId);
  if (!history) {
    history = getMemoryContext(agent.id);
    conversationHistories.set(channelId, history);
  }

  try {
    const maxTokens = estimateTextMaxTokens(agent, userMessage);
    const disableToolsForPrompt = isCareerOpsRiley || shouldDisableToolsForProfilePrompt(userMessage) || isCompletionCheckPrompt;
    const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf]/;
    const textLangHint = cjkPattern.test(userMessage)
      ? '\n\n[Language detected: Mandarin Chinese. Please reply in Mandarin Chinese (简体中文).]'
      : '';
    const userMessageWithLang = textLangHint ? `${userMessage}${textLangHint}` : userMessage;
    let streamedPreviewShown = false;
    let lastStreamEditAt = 0;
    let lastRenderedLength = 0;
    let lastProgressSignalAt = Date.now();
    let heartbeatDelayMs = Math.max(5000, TEXT_PROGRESS_HEARTBEAT_MS);

    const scheduleProgressHeartbeat = (): void => {
      if (!pendingThinking) return;
      progressHeartbeat = setTimeout(async () => {
        if (signal?.aborted || !pendingThinking) return;
        if (streamedPreviewShown) return;
        if (Date.now() - lastProgressSignalAt < heartbeatDelayMs) {
          scheduleProgressHeartbeat();
          return;
        }

        const beat = `⏳ ${agent.name} is still working on this...`;
        const edited = await pendingThinking.edit(beat)
          .then(() => true)
          .catch(() => false);
        if (!edited) {
          const fallbackMsg = await sendWebhookMessage(channel, {
            content: beat,
            username: `${agent.emoji} ${agent.name}`,
            avatarURL: agent.avatarUrl,
          }).catch(() => null);
          // Track fallback so cleanup deletes it before the real response
          if (fallbackMsg) {
            pendingThinking = fallbackMsg;
            pendingThinkingMessages.set(channelId, fallbackMsg);
          }
        }
        lastProgressSignalAt = Date.now();
        heartbeatDelayMs = Math.min(60_000, Math.floor(heartbeatDelayMs * 1.6));
        scheduleProgressHeartbeat();
      }, heartbeatDelayMs);
    };

    if (pendingThinking) {
      scheduleProgressHeartbeat();
    }

    const updateStreamPreview = async (partialText: string, force = false): Promise<boolean> => {
      if (signal?.aborted || !pendingThinking) return false;
      const rendered = renderAgentMessage(partialText).trim();
      if (!rendered) return false;
      const clipped = !force && rendered.length > STREAM_MAX_PREVIEW_CHARS
        ? `${rendered.slice(0, STREAM_MAX_PREVIEW_CHARS - 1)}…`
        : rendered;
      const now = Date.now();
      if (!force && now - lastStreamEditAt < STREAM_EDIT_THROTTLE_MS) return false;
      if (!force && Math.abs(clipped.length - lastRenderedLength) < STREAM_EDIT_MIN_CHAR_DELTA) return false;
      lastStreamEditAt = now;
      const edited = await pendingThinking.edit(clipped)
        .then(() => true)
        .catch(() => false);
      if (!edited) return false;
      lastProgressSignalAt = now;
      streamedPreviewShown = true;
      lastRenderedLength = clipped.length;
      return true;
    };

    const runAgent = async (sourceHistory: ConversationMessage[], disableTools: boolean): Promise<string> => {
      return await withTextTimeout(agentRespond(agent, sourceHistory, userMessageWithLang, async (toolName, summary) => {
        if (signal?.aborted) return;
        if (disableTools) return;
        try {
          await sendWebhookMessage(channel, {
            content: `🔧 [${toolName}] ${summary}`,
            username: `${agent.emoji} ${agent.name}`,
            avatarURL: agent.avatarUrl,
          });
        } catch (err) {
          console.warn(`Webhook tool notification failed for ${agent.name}:`, err instanceof Error ? err.message : 'Unknown');
        }
      }, {
        signal,
        maxTokens,
        disableTools,
        threadKey: `text:${channelId}`,
        onPartialText: async (partialText) => {
          await updateStreamPreview(partialText);
        },
      }), TEXT_AGENT_RESPONSE_TIMEOUT_MS);
    };

    let response: string;
    try {
      response = await runAgent(history, disableToolsForPrompt);
    } catch (err) {
      if (!isGeminiFunctionTurnSequenceError(err)) {
        throw err;
      }
      console.warn(`Resetting ${agent.name} text-channel history after function-turn sequencing error`);
      history = [];
      conversationHistories.set(channelId, history);
      response = await runAgent(history, true);
    }

      if (signal?.aborted) return;

    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: response });

    if (history.length > MAX_HISTORY * 2) {
      history.splice(0, history.length - MAX_HISTORY * 2);
    }

    appendToMemory(agent.id, [
      { role: 'user', content: userMessage },
      { role: 'assistant', content: response },
    ]);

    if (signal?.aborted) return;
    const renderedResponse = ensureCompletionToken(renderAgentMessage(response), completionToken);
    if (!renderedResponse.trim()) {
      await sendWebhookMessage(channel, {
        content: `⚠️ ${agent.name}: I executed the request but did not generate a usable message. Retrying usually fixes this; if it repeats, ask Riley to break the task into smaller steps.`,
        username: `${agent.emoji} ${agent.name}`,
        avatarURL: agent.avatarUrl,
      }).catch(async () => {
        await sendAgentFallbackMessage(
          channel,
          agent,
          `⚠️ ${agent.name}: I executed the request but did not generate a usable message. Retrying usually fixes this; if it repeats, ask Riley to break the task into smaller steps.`
        ).catch(() => {});
      });
      pendingThinkingMessages.delete(channelId);
      return;
    }
    const canFinalizeInPlace =
      !!pendingThinking &&
      streamedPreviewShown &&
      renderedResponse.length > 0 &&
      renderedResponse.length <= 1900;

    if (canFinalizeInPlace && pendingThinking) {
      const finalizedInPlace = await updateStreamPreview(renderedResponse, true);
      if (!finalizedInPlace) {
        // Delete the stale preview before posting the full message to avoid duplicates
        await pendingThinking.delete().catch(() => {});
        await sendWebhookMessage(channel, {
          content: renderedResponse,
          username: `${agent.emoji} ${agent.name}`,
          avatarURL: agent.avatarUrl,
        }).catch(async () => {
          await sendAgentFallbackMessage(channel, agent, renderedResponse).catch(() => {});
        });
      }
      pendingThinkingMessages.delete(channelId);
      await mirrorAgentResponse(agent.name, channel.name, renderedResponse);
      return;
    }

    if (pendingThinking) {
      pendingThinking.delete().catch(() => {});
      pendingThinkingMessages.delete(channelId);
    }
    await sendAgentMessage(channel, agent, response, completionToken);
  } catch (err) {
    const abortLike = String((err as any)?.name || '').includes('Abort') || String((err as any)?.message || '').toLowerCase().includes('abort');
    if (abortLike || signal?.aborted) {
      if (pendingThinking) {
        pendingThinking.delete().catch(() => {});
        pendingThinkingMessages.delete(channelId);
      }
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    const timedOut = isTextTimeoutError(err);
    if (timedOut) recordTextChannelTimeout(agent.id);
    const userFacing = classifyAgentError(err);
    console.error(`Agent ${agent.name} error:`, errMsg);
    try {
      if (pendingThinking) {
        pendingThinking.delete().catch(() => {});
        pendingThinkingMessages.delete(channelId);
      }
      await sendWebhookMessage(channel, {
        content: `⚠️ ${agent.name}: ${userFacing}`,
        username: `${agent.emoji} ${agent.name}`,
        avatarURL: agent.avatarUrl,
      });
      if (timedOut) {
        await sendWebhookMessage(channel, {
          content: 'ℹ️ Timeout hint: ask a narrower question or split this into smaller steps. Riley can orchestrate the breakdown in #groupchat.',
          username: `${agent.emoji} ${agent.name}`,
          avatarURL: agent.avatarUrl,
        }).catch(() => {});
      }
    } catch (webhookErr) {
      console.warn(`Webhook error notification failed for ${agent.name}:`, webhookErr instanceof Error ? webhookErr.message : 'Unknown');
      await sendAgentFallbackMessage(channel, agent, `⚠️ ${agent.name}: ${userFacing}`).catch(() => {});
      if (timedOut) {
        await sendAgentFallbackMessage(
          channel,
          agent,
          'ℹ️ Timeout hint: ask a narrower question or split this into smaller steps. Riley can orchestrate the breakdown in #groupchat.'
        ).catch(() => {});
      }
    }
  } finally {
    if (progressHeartbeat) {
      clearTimeout(progressHeartbeat);
    }
    if (signal?.aborted && pendingThinking) {
      pendingThinking.delete().catch(() => {});
      pendingThinkingMessages.delete(channelId);
    }
  }
}

async function withTextTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Text channel response timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
  response: string,
  completionToken: string | null = null
): Promise<void> {
  const normalized = String(response || '').trim();
  const effectiveResponse = (
    (agent.id === 'developer' || agent.id === 'executive-assistant')
    && isLowSignalCompletion(normalized)
  ) ? '✅ Done.' : response;

  const rendered = ensureCompletionToken(renderAgentMessage(effectiveResponse), completionToken);
  if (!rendered.trim()) {
    return;
  }

  // Compact very long text-only responses (>8000 chars = 4+ Discord messages)
  // to avoid wall-of-text spam. Preserve key sections and truncate the rest.
  const compacted = compactLongResponse(rendered);

  const duplicateDecision = shouldSuppressCareerOpsDuplicate(channel, compacted);
  if (duplicateDecision.suppress) {
    if (duplicateDecision.notice) {
      await sendWebhookMessage(channel, {
        content: duplicateDecision.notice,
        username: `${agent.emoji} ${agent.name}`,
        avatarURL: agent.avatarUrl,
      }).catch(() => {});
    }
    return;
  }
  const chunks = splitMessage(compacted, 1900);
  const codeAttachment = extractLongCodeAttachment(compacted);

  try {
    if (codeAttachment) {
      // Long code block → send as file attachment instead of splitting across messages
      await sendWebhookMessage(channel, {
        content: codeAttachment.summary,
        username: `${agent.emoji} ${agent.name}`,
        avatarURL: agent.avatarUrl,
        files: [codeAttachment.attachment],
      });
    } else if (shouldProgressivelyReveal(compacted)) {
      await sendProgressiveWebhookMessage(channel, agent, compacted);
    } else {
      for (const chunk of chunks) {
        await sendWebhookMessage(channel, {
          content: chunk,
          username: `${agent.emoji} ${agent.name}`,
          avatarURL: agent.avatarUrl,
        });
      }
    }
    await mirrorAgentResponse(agent.name, channel.name, compacted);
  } catch (err) {
    console.warn(`Webhook send failed for ${agent.name}, falling back to a single plain send path:`, err instanceof Error ? err.message : 'Unknown');
    clearWebhookCache();
    if (channel instanceof TextChannel) {
      await sendAgentFallbackMessage(channel, agent, compacted).catch(() => {});
    }
  }
}

function shouldProgressivelyReveal(rendered: string): boolean {
  if (!rendered) return false;
  if (rendered.length < 260 || rendered.length > 1800) return false;
  if (rendered.includes('```')) return false;
  return true;
}

/**
 * Compact very long text-only responses to avoid wall-of-text spam.
 * Responses under 8000 chars (≤4 Discord messages) pass through unchanged.
 * Longer responses are truncated: keep key sections (Result, Evidence, Risk)
 * and the first ~3500 chars, then append a truncation note.
 */
function compactLongResponse(text: string): string {
  if (text.length <= 8000) return text;
  // Don't compact responses with code blocks — those use the file attachment path
  if (text.includes('```')) return text;

  // Extract key contract sections if present
  const sectionRe = /^((?:Result|Evidence|Risk|Follow-up|Summary|Status)[:/].*?)$/gim;
  const sections: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(text)) !== null) {
    sections.push(m[1].trim());
  }

  // Keep first ~3500 chars of the original response
  const head = text.slice(0, 3500).replace(/\s+\S*$/, ''); // break on word boundary

  // Append extracted sections that aren't already in the head
  const extra = sections.filter(s => !head.includes(s)).slice(0, 8);
  const extraBlock = extra.length > 0 ? '\n\n' + extra.join('\n') : '';

  return head + extraBlock + '\n\n*(Response compacted — full details in workspace thread)*';
}

function extractLongCodeAttachment(rendered: string): { summary: string; attachment: AttachmentBuilder } | null {
  if (rendered.length <= 1900) return null;
  // Match fenced code blocks: ```lang\n...\n```
  const codeBlockRe = /```(\w*)\n([\s\S]*?)```/g;
  const blocks: { lang: string; code: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = codeBlockRe.exec(rendered)) !== null) {
    blocks.push({ lang: match[1] || 'txt', code: match[2], start: match.index, end: match.index + match[0].length });
  }
  if (blocks.length === 0) return null;

  // Only trigger if the code blocks are the bulk of the content
  const totalCodeLen = blocks.reduce((sum, b) => sum + b.code.length, 0);
  if (totalCodeLen < 800) return null;

  // Use the first block's language for the file extension
  const lang = blocks[0].lang.toLowerCase();
  const extMap: Record<string, string> = { html: 'html', css: 'css', ts: 'ts', typescript: 'ts', js: 'js', javascript: 'js', json: 'json', sql: 'sql', tsx: 'tsx' };
  const ext = extMap[lang] || 'txt';

  // Combine all code blocks into one file
  const fileContent = blocks.map((b) => b.code).join('\n\n');
  const attachment = new AttachmentBuilder(Buffer.from(fileContent, 'utf-8'), { name: `deliverable.${ext}` });

  // Build summary: everything outside code blocks, truncated
  let summary = rendered;
  for (let i = blocks.length - 1; i >= 0; i--) {
    summary = summary.slice(0, blocks[i].start) + summary.slice(blocks[i].end);
  }
  summary = summary.replace(/\n{3,}/g, '\n\n').trim();
  if (!summary) summary = `📎 Full ${ext.toUpperCase()} deliverable attached.`;
  if (summary.length > 1800) summary = summary.slice(0, 1800) + '…';

  return { summary, attachment };
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
  let lastSuccessfulVisible = initialChars;
  while (visible < rendered.length) {
    await new Promise((resolve) => setTimeout(resolve, PROGRESSIVE_REVEAL_STEP_MS));
    visible = Math.min(rendered.length, visible + PROGRESSIVE_REVEAL_STEP_CHARS);
    const nextContent = visible < rendered.length
      ? `${rendered.slice(0, visible)}…`
      : rendered;
    const edited = await (sent as Message).edit(nextContent)
      .then(() => true)
      .catch(() => false);
    if (edited) {
      lastSuccessfulVisible = visible;
    }
  }

  // If progressive edits were interrupted, try one final in-place update.
  // Avoid posting another full message to prevent duplicate spam.
  if (lastSuccessfulVisible < rendered.length) {
    await (sent as Message).edit(rendered).catch(() => {});
  }
}

function renderAgentMessage(raw: string): string {
  const withoutActionTags = raw.replace(/\[ACTION:[^\]]+\]/g, '').trim();
  if (!withoutActionTags) return '';

  // Strip smoke-test tokens & metadata that leak into visible output
  const withoutSmokeTokens = withoutActionTags
    .replace(/\[smoke[- ]?token[^\]]*\]/gi, '')
    .replace(/\bSMOKE_[A-Z0-9_]+\b/g, '')
    .replace(/\[smoke test:[^\]]*\]/gi, '')
    .replace(/^Next step: Riley will post.*$/gm, '')
    .trim();
  if (!withoutSmokeTokens) return '';

  const withoutSpeakerLabel = withoutSmokeTokens
    .replace(/^\s*\[[^\]\r\n]{1,40}\]:\s*/u, '')
    .replace(/^\s*(?:Riley|Ace|Max|Kane|Sophie|Raj|Elena|Jude|Harper|Kai|Liv|Mia|Leo)\s*:\s*/i, '');
  if (!withoutSpeakerLabel) return '';

  const withoutHeadings = withoutSpeakerLabel
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .trim();
  if (!withoutHeadings) return '';

  const segments = withoutHeadings.split(/(```[\s\S]*?```)/g);
  const formatted = segments.map((segment) => {
    if (segment.startsWith('```') && segment.endsWith('```')) return segment;
    const noHeavyBold = segment
      .replace(/\*\*(?!@)([^*\n]{1,120})\*\*/g, '$1')
      .replace(/\n{3,}/g, '\n\n');
    return noHeavyBold.replace(/(^|\s)@([a-z0-9-]{2,32})\b/gi, (_m, prefix, name) => {
      const resolved = resolveAgentId(name);
      if (!resolved) return `${prefix}@${name}`;
      return `${prefix}${getAgentMention(resolved)}`;
    });
  }).join('');

  let normalized = formatted
    .replace(/\bI\s+cannot\s+access\b/gi, 'Blocked: missing access to')
    .replace(/\bI\s+don't\s+have\s+access\s+to\b/gi, 'Blocked: missing access to')
    .trim();

  const hasActionCue = /\b(next step|action|will|now|recommend|should|run|check|verify|post|update|fix|implement|create|change|retry)\b/i.test(normalized);
  if (normalized.length > 220 && !hasActionCue) {
    normalized = `${normalized}\n\nNext step: I will post a concrete action and owner in my next update.`;
  }

  return normalized;
}

function extractCompletionTokenFromPrompt(userMessage: string): string | null {
  if (!/\[channel-completion-check:[^\]]+\]/i.test(userMessage)) return null;
  const match = userMessage.match(/\bTOKEN:([A-Z0-9]{6,32})\b/);
  return match ? match[1] : null;
}

function ensureCompletionToken(rendered: string, token: string | null): string {
  if (!token) return rendered;
  const needle = `TOKEN:${token}`;
  if (rendered.includes(needle)) return rendered;
  return `${rendered.trim()}\n${needle}`;
}

function buildCompletionCheckReply(agent: AgentConfig, token: string): string {
  const agentFirst = agent.name.split(' ')[0] || agent.name;
  const paragraphOne = `${agentFirst} is responsible for high-trust execution in ASAP by turning user intent into concrete, auditable outcomes. In practice this means reducing ambiguity, keeping communication crisp, and ensuring that every recommendation includes scope, expected impact, and the safest next action. The role also protects team velocity by identifying blockers early, escalating risk before it becomes outage-level, and converting broad requests into stepwise work that can be validated quickly in Discord and in production workflows.`;
  const paragraphTwo = `One concrete improvement I recommend is adding a shared response contract used by every agent channel: explicit objective, constraints, acceptance checks, and completion status in a stable output shape. That contract would reduce partial or inconsistent responses, improve automated channel validation reliability, and make retries more deterministic under load. It also gives Riley and operators a cleaner way to audit quality and triage failures because each answer is comparable, measurable, and easier to route to the right owner without losing execution context.`;
  return `${paragraphOne}\n\n${paragraphTwo}\nTOKEN:${token}`;
}

async function sendAgentFallbackMessage(channel: TextChannel, agent: AgentConfig, content: string): Promise<void> {
  const cleaned = String(content || '').trim();
  if (!cleaned) return;
  const prefix = `${agent.emoji} ${agent.name}: `;
  const chunks = splitMessage(cleaned, 1900 - prefix.length);
  for (const chunk of chunks) {
    await channel.send(`${prefix}${chunk}`);
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let chunk = '';

  for (const line of lines) {
    if (line.length > maxLen) {
      if (chunk) { chunks.push(chunk); chunk = ''; }
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
