import { AnyThreadChannel, ChannelType, Message, TextChannel, Webhook, WebhookMessageCreateOptions } from 'discord.js';

/**
 * Webhook manager — creates/caches a single webhook per text channel.
 * Used so each agent can post with their own name and avatar instead of
 * appearing as the single bot with colored embeds.
 */

const WEBHOOK_NAME = 'ASAP Agent';
const WEBHOOK_CACHE_TTL_MS = Math.max(60_000, Number(process.env.WEBHOOK_CACHE_TTL_MS || '21600000'));

/** Cache: channelId → Webhook */
const webhookCache = new Map<string, { webhook: Webhook; cachedAt: number }>();

export type WebhookCapableChannel = TextChannel | AnyThreadChannel;

function resolveWebhookParent(channel: WebhookCapableChannel): { base: TextChannel; threadId?: string } {
  if (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread || channel.type === ChannelType.AnnouncementThread) {
    const parent = channel.parent;
    if (!parent || parent.type !== ChannelType.GuildText) {
      throw new Error(`Thread ${channel.id} does not have a text-channel parent for webhook execution`);
    }
    return { base: parent as TextChannel, threadId: channel.id };
  }

  return { base: channel as TextChannel };
}

/**
 * Get or create a webhook for a text channel.
 * Reuses existing ASAP webhooks to avoid hitting the 15-webhook-per-channel limit.
 */
export async function getWebhook(channel: WebhookCapableChannel): Promise<Webhook> {
  const { base } = resolveWebhookParent(channel);
  const cached = webhookCache.get(base.id);
  if (cached && Date.now() - cached.cachedAt <= WEBHOOK_CACHE_TTL_MS) {
    return cached.webhook;
  }
  if (cached) webhookCache.delete(base.id);

  const existing = await base.fetchWebhooks();
  let webhook = existing.find((w) => w.name === WEBHOOK_NAME && w.owner?.id === base.client.user?.id);

  if (!webhook) {
    webhook = await base.createWebhook({ name: WEBHOOK_NAME, reason: 'ASAP multi-agent identity' });
  }

  webhookCache.set(base.id, { webhook, cachedAt: Date.now() });
  return webhook;
}

function isStaleWebhookError(err: unknown): boolean {
  const message = String((err as any)?.message || err || '').toLowerCase();
  const code = Number((err as any)?.code || 0);
  // Discord Unknown Webhook / Unknown Channel and common 404-like text patterns.
  return code === 10015 || code === 10003 || message.includes('unknown webhook') || message.includes('unknown channel') || message.includes('404');
}

function sanitizeWebhookUsername(name: unknown): string | undefined {
  const raw = String(name || '').trim();
  if (!raw) return undefined;

  let normalized = raw;
  // Remove decorative suffix symbols after a role label, e.g. "Riley (Executive Assistant)✦".
  normalized = normalized.replace(/(\([^)]*\))\s*[^\p{L}\p{N}\s)]+$/u, '$1');
  // Fallback trim for any remaining standalone trailing symbol clusters.
  normalized = normalized.replace(/\s+[^\p{L}\p{N}\s]+$/u, '');

  const clipped = normalized.trim();
  return clipped ? clipped.slice(0, 80) : undefined;
}

export async function sendWebhookMessage(
  channel: WebhookCapableChannel,
  options: WebhookMessageCreateOptions,
): Promise<Message<boolean>> {
  const { base, threadId } = resolveWebhookParent(channel);
  const sanitizedUsername = sanitizeWebhookUsername((options as any)?.username);
  const normalizedOptions = sanitizedUsername
    ? { ...options, username: sanitizedUsername }
    : options;
  const payload = threadId ? { ...normalizedOptions, threadId } : normalizedOptions;
  const webhook = await getWebhook(channel);
  try {
    return await webhook.send(payload);
  } catch (err) {
    if (!isStaleWebhookError(err)) throw err;
    webhookCache.delete(base.id);
    const refreshed = await getWebhook(channel);
    return await refreshed.send(payload);
  }
}

/** Clear the cache (e.g., on bot restart). */
export function clearWebhookCache(): void {
  webhookCache.clear();
}
