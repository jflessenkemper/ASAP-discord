import { TextChannel, Webhook } from 'discord.js';

/**
 * Webhook manager — creates/caches a single webhook per text channel.
 * Used so each agent can post with their own name and avatar instead of
 * appearing as the single bot with colored embeds.
 */

const WEBHOOK_NAME = 'ASAP Agent';

/** Cache: channelId → Webhook */
const webhookCache = new Map<string, Webhook>();

/**
 * Get or create a webhook for a text channel.
 * Reuses existing ASAP webhooks to avoid hitting the 15-webhook-per-channel limit.
 */
export async function getWebhook(channel: TextChannel): Promise<Webhook> {
  const cached = webhookCache.get(channel.id);
  if (cached) return cached;

  // Check for existing webhook we created previously
  const existing = await channel.fetchWebhooks();
  let webhook = existing.find((w) => w.name === WEBHOOK_NAME && w.owner?.id === channel.client.user?.id);

  if (!webhook) {
    webhook = await channel.createWebhook({ name: WEBHOOK_NAME, reason: 'ASAP multi-agent identity' });
  }

  webhookCache.set(channel.id, webhook);
  return webhook;
}

/** Clear the cache (e.g., on bot restart). */
export function clearWebhookCache(): void {
  webhookCache.clear();
}
