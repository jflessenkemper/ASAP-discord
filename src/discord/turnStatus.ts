/**
 * Rolling turn-status message.
 *
 * Instead of posting a new Discord message for every stage ("thinking",
 * "consulting Argus", "drafting reply"), the runtime creates one message at the
 * start of a turn and edits it in place as work progresses. When the turn
 * finishes, the same message gets swapped for the final answer.
 *
 * Usage:
 *   const turn = await beginTurn(channel, agent);
 *   await turn.update('Consulting Argus…');
 *   ...
 *   await turn.finalize('Done. Here is the answer.');
 */

import { Message } from 'discord.js';

import { AgentConfig } from './agents';
import { sendWebhookMessage, editWebhookMessage, WebhookCapableChannel } from './services/webhooks';
import { errMsg } from '../utils/errors';

export interface TurnStatusHandle {
  /** Update the status text in place. Safe to call many times; no-ops if finalized. */
  update(text: string): Promise<void>;
  /** Replace the status with the final answer. Keeps the same message id. */
  finalize(finalContent: string): Promise<Message | null>;
  /** Delete the status message entirely (fallback path when finalize isn't applicable). */
  remove(): Promise<void>;
  /** The underlying message, or null if creation failed. */
  message: Message | null;
  /** True after finalize/remove has been called. */
  done: boolean;
}

const MAX_DISCORD_MESSAGE_LENGTH = 2000;

function clip(text: string): string {
  if (text.length <= MAX_DISCORD_MESSAGE_LENGTH) return text;
  return text.slice(0, MAX_DISCORD_MESSAGE_LENGTH - 1) + '…';
}

/**
 * Start a turn — posts the initial status message via webhook so it wears the
 * agent's identity (name + avatar) rather than the generic bot identity.
 */
export async function beginTurn(
  channel: WebhookCapableChannel,
  agent: AgentConfig,
  initialText = '⏳ Thinking…',
): Promise<TurnStatusHandle> {
  let message: Message | null = null;
  let done = false;

  try {
    message = await sendWebhookMessage(channel, {
      content: clip(initialText),
      username: `${agent.emoji} ${agent.name}`,
      avatarURL: agent.avatarUrl,
    });
  } catch (err) {
    console.warn('[turnStatus] beginTurn send failed:', errMsg(err));
    message = null;
  }

  return {
    get message() { return message; },
    get done() { return done; },
    async update(text: string) {
      if (done || !message) return;
      try {
        await editWebhookMessage(channel, message.id, clip(text));
      } catch (err) {
        console.warn('[turnStatus] update failed:', errMsg(err));
      }
    },
    async finalize(finalContent: string) {
      if (done) return message;
      done = true;
      if (!message) {
        // Edit target was never created — fall back to a fresh post.
        try {
          return await sendWebhookMessage(channel, {
            content: clip(finalContent),
            username: `${agent.emoji} ${agent.name}`,
            avatarURL: agent.avatarUrl,
          });
        } catch (err) {
          console.warn('[turnStatus] finalize fallback send failed:', errMsg(err));
          return null;
        }
      }
      try {
        const edited = await editWebhookMessage(channel, message.id, clip(finalContent));
        return edited ?? message;
      } catch (err) {
        console.warn('[turnStatus] finalize edit failed:', errMsg(err));
        return message;
      }
    },
    async remove() {
      if (done) return;
      done = true;
      if (!message) return;
      await message.delete().catch(() => {});
    },
  };
}
