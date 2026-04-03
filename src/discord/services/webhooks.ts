import { AnyThreadChannel, ChannelType, Message, TextChannel, Webhook, WebhookMessageCreateOptions } from 'discord.js';

/**
 * Webhook manager — creates/caches a single webhook per text channel.
 * Used so each agent can post with their own name and avatar instead of
 * appearing as the single bot with colored embeds.
 */

const WEBHOOK_NAME = 'ASAP Agent';

/** Cache: channelId → Webhook */
const webhookCache = new Map<string, Webhook>();

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
  if (cached) return cached;

  const existing = await base.fetchWebhooks();
  let webhook = existing.find((w) => w.name === WEBHOOK_NAME && w.owner?.id === base.client.user?.id);

  if (!webhook) {
    webhook = await base.createWebhook({ name: WEBHOOK_NAME, reason: 'ASAP multi-agent identity' });
  }

  webhookCache.set(base.id, webhook);
  return webhook;
}

export async function sendWebhookMessage(
  channel: WebhookCapableChannel,
  options: WebhookMessageCreateOptions,
): Promise<Message<boolean>> {
  const { threadId } = resolveWebhookParent(channel);
  const webhook = await getWebhook(channel);
  return webhook.send(threadId ? { ...options, threadId } : options);
}

/** Clear the cache (e.g., on bot restart). */
export function clearWebhookCache(): void {
  webhookCache.clear();
}
