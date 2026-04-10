import { postOpsLine } from '../services/opsFeed';
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

  const channel = channels.terminal;
  if (!channel) return;

  try {
    await postOpsLine(channel, {
      actor: agentId,
      scope: 'agent-doc',
      metric: 'summary',
      delta: String(summary || '').slice(0, 600),
      action: 'none',
      severity: 'info',
    });
  } catch (err) {
    console.error(`Documentation error for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
  }
}
