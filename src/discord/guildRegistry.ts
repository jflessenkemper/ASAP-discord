/**
 * Module-scoped holder for the current Discord Guild.
 *
 * Extracted from tools.ts so other modules (the job-tools split, future
 * tools.ts splits) can share access without round-tripping through
 * tools.ts and risking a dependency cycle.
 */

import { Guild, TextChannel } from 'discord.js';

let discordGuild: Guild | null = null;
let agentChannelResolver: ((agentId: string) => TextChannel | null) | null = null;

export function setDiscordGuild(guild: Guild): void {
  discordGuild = guild;
}

export function getDiscordGuild(): Guild | null {
  return discordGuild;
}

export function requireGuild(): Guild {
  if (!discordGuild) throw new Error('Discord guild not available');
  return discordGuild;
}

export function setAgentChannelResolver(cb: (agentId: string) => TextChannel | null): void {
  agentChannelResolver = cb;
}

export function resolveAgentChannel(agentId: string): TextChannel | null {
  return agentChannelResolver ? agentChannelResolver(agentId) : null;
}
