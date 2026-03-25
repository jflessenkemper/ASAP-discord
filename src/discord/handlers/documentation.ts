import { TextChannel } from 'discord.js';
import { BotChannels } from '../setup';

/**
 * Agent self-documentation system.
 * Agents post summaries of their actions to their own text channels
 * so there's a persistent record of what each agent has done.
 */

let channels: BotChannels | null = null;

/**
 * Initialize the documentation system with bot channels.
 * Must be called after setupChannels() completes.
 */
export function setBotChannels(botChannels: BotChannels): void {
  channels = botChannels;
}

/**
 * Post a documentation entry to an agent's own text channel.
 * This is a fire-and-forget operation — errors are logged but not thrown.
 */
export async function documentToChannel(agentId: string, summary: string): Promise<void> {
  if (!channels) return;

  const channel = channels.agentChannels.get(agentId);
  if (!channel) return;

  try {
    const timestamp = new Date().toLocaleTimeString('en-AU', { hour12: false });
    const entry = `📝 *[${timestamp}]* ${summary.slice(0, 1900)}`;
    await channel.send(entry);
  } catch (err) {
    console.error(`Documentation error for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
  }
}

/**
 * Post a longer documentation entry with a title.
 */
export async function documentActionToChannel(
  agentId: string,
  title: string,
  details: string
): Promise<void> {
  if (!channels) return;

  const channel = channels.agentChannels.get(agentId);
  if (!channel) return;

  try {
    const timestamp = new Date().toLocaleTimeString('en-AU', { hour12: false });
    const entry = `📝 *[${timestamp}]* **${title}**\n${details.slice(0, 1800)}`;
    await channel.send(entry);
  } catch (err) {
    console.error(`Documentation error for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
  }
}
