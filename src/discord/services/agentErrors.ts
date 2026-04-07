import { TextChannel } from 'discord.js';

import { postOpsLine } from './opsFeed';

interface AgentErrorExtra {
  agentId?: string;
  detail?: string;
  level?: 'info' | 'warn' | 'error';
}

let agentErrorChannel: TextChannel | null = null;
const RUNTIME_INSTANCE_TAG = (process.env.RUNTIME_INSTANCE_TAG || process.env.HOSTNAME || `pid-${process.pid}`).slice(0, 80);

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
  const severity = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  const detailBody = extra?.detail ? sanitize(extra.detail, 420) : 'none';
  const detail = `instance=${sanitize(RUNTIME_INSTANCE_TAG, 80)} detail=${detailBody}`;
  const action = severity === 'error'
    ? 'inspect stack trace and recover service'
    : severity === 'warn'
      ? 'monitor and retry if recurring'
      : 'none';

  await postOpsLine(agentErrorChannel, {
    actor: sanitize(extra?.agentId || 'system', 120),
    scope: `agent-error:${sanitize(source, 80)}`,
    metric: sanitize(message, 180),
    delta: detail,
    action,
    severity,
  });
}

function sanitize(value: string, maxLen: number): string {
  return String(value || '')
    .replace(/@(everyone|here)/gi, 'at-$1')
    .replace(/<@[!&]?\d+>/g, 'mention')
    .replace(/```/g, 'ˋˋˋ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

