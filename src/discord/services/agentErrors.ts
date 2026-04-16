import { TextChannel } from 'discord.js';

import pool from '../../db/pool';

import { postOpsLine } from './opsFeed';

interface AgentErrorExtra {
  agentId?: string;
  detail?: string;
  level?: 'info' | 'warn' | 'error';
}

let agentErrorChannel: TextChannel | null = null;
const RUNTIME_INSTANCE_TAG = (process.env.RUNTIME_INSTANCE_TAG || process.env.HOSTNAME || `pid-${process.pid}`).slice(0, 80);

const errorOccurrences = new Map<string, { count: number; firstSeen: number }>();
const ERROR_LEARNING_THRESHOLD = 3;
const ERROR_LEARNING_WINDOW_MS = 60 * 60 * 1000; // 1 hour

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

  // Track recurring errors and record as learnings
  const errorKey = `${source}:${message}`.slice(0, 200);
  const now = Date.now();
  const occ = errorOccurrences.get(errorKey);
  if (occ && now - occ.firstSeen < ERROR_LEARNING_WINDOW_MS) {
    occ.count++;
    if (occ.count === ERROR_LEARNING_THRESHOLD) {
      import('../vectorMemory').then(({ recordAgentLearning }) => {
        recordAgentLearning(
          extra?.agentId || 'system',
          `Recurring error pattern (${occ.count}x in <1h): source=${source}, message=${message}. ${extra?.detail || ''}`
        ).catch(() => {});
      }).catch(() => {});
    }
  } else {
    errorOccurrences.set(errorKey, { count: 1, firstSeen: now });
  }

  // Cleanup old entries periodically
  if (errorOccurrences.size > 500) {
    for (const [k, v] of errorOccurrences) {
      if (now - v.firstSeen > ERROR_LEARNING_WINDOW_MS) errorOccurrences.delete(k);
    }
  }
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

export async function getRecentErrorPatterns(agentId?: string, hours = 24, limit = 20): Promise<string> {
  try {
    const params: any[] = [hours];
    let whereClause = `WHERE event = 'error' AND ts >= NOW() - INTERVAL '1 hour' * $1`;
    if (agentId) {
      whereClause += ` AND agent_id = $${params.length + 1}`;
      params.push(agentId);
    }

    const res = await pool.query(
      `SELECT agent_id, detail, COUNT(*) as occurrences, MAX(ts) as last_seen
       FROM agent_activity_log
       ${whereClause}
       GROUP BY agent_id, detail
       ORDER BY occurrences DESC, last_seen DESC
       LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    if (!res.rows || res.rows.length === 0) return 'No errors in the last ' + hours + ' hours.';

    return res.rows.map((r: any) =>
      `[${r.agent_id}] ${r.occurrences}x: ${String(r.detail || '').slice(0, 200)} (last: ${new Date(r.last_seen).toISOString()})`
    ).join('\n');
  } catch (err) {
    return `Error querying patterns: ${(err as Error).message}`;
  }
}

