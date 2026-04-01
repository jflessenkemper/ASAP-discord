import { TextChannel } from 'discord.js';

interface AgentErrorExtra {
  agentId?: string;
  detail?: string;
  level?: 'info' | 'warn' | 'error';
}

const MAX_DISCORD_CONTENT = 1900;
let agentErrorChannel: TextChannel | null = null;

export function setAgentErrorChannel(channel: TextChannel | null): void {
  agentErrorChannel = channel;
}

export async function postAgentErrorLog(
  source: string,
  message: string,
  extra?: AgentErrorExtra
): Promise<void> {
  if (!agentErrorChannel) return;

  const level = extra?.level || 'error';
  const icon = level === 'error' ? '🚨' : level === 'warn' ? '⚠️' : 'ℹ️';
  const agentLine = extra?.agentId ? `\nAgent: ${sanitize(extra.agentId, 120)}` : '';
  const detailLine = extra?.detail ? `\nDetail: ${sanitize(extra.detail, 1400)}` : '';
  const content = `${icon} **${sanitize(source, 120)}**\nMessage: ${sanitize(message, 900)}${agentLine}${detailLine}`;

  for (const chunk of splitMessage(content, MAX_DISCORD_CONTENT)) {
    await agentErrorChannel.send(chunk).catch(() => {});
  }
}

function sanitize(value: string, maxLen: number): string {
  return String(value || '')
    .replace(/@(everyone|here)/gi, '[at-$1]')
    .replace(/<@[!&]?\d+>/g, '[mention]')
    .replace(/```/g, 'ˋˋˋ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxLen));
    start += maxLen;
  }
  return chunks;
}
