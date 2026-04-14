import pool from '../db/pool';

import { postAgentErrorLog } from './services/agentErrors';
import { errMsg } from '../utils/errors';

/**
 * Lightweight agent activity logger.
 * Writes structured events to the agent_activity_log table for debugging.
 * All writes are fire-and-forget — logging never blocks agent execution.
 */

type EventType = 'invoke' | 'tool' | 'response' | 'error' | 'rate_limit' | 'guardrail' | 'cache' | 'memory';
let activityLogDbDisabled = false;
const AGENT_ERROR_DEDUPE_WINDOW_MS = Math.max(30_000, parseInt(process.env.AGENT_ERROR_DEDUPE_WINDOW_MS || '180000', 10));
const lastAgentErrorPostedAt = new Map<string, number>();

function classifyAgentErrorLevel(detail?: string): 'info' | 'warn' | 'error' {
  const normalized = String(detail || '').toLowerCase();
  if (!normalized) return 'error';

  // Quota/rate/budget conditions are operational limits, not service crashes.
  if (
    normalized.includes('daily token limit reached') ||
    normalized.includes('daily dollar budget exceeded') ||
    normalized.includes('quota exhausted') ||
    normalized.includes('rate limit') ||
    normalized.includes('resource_exhausted')
  ) {
    return 'warn';
  }

  return 'error';
}

function shouldPostAgentError(agentId: string, detail?: string): boolean {
  const now = Date.now();
  const key = `${agentId}:${String(detail || '').toLowerCase().slice(0, 240)}`;
  const last = lastAgentErrorPostedAt.get(key) || 0;
  if (now - last < AGENT_ERROR_DEDUPE_WINDOW_MS) {
    return false;
  }
  lastAgentErrorPostedAt.set(key, now);

  if (lastAgentErrorPostedAt.size > 2000) {
    for (const [k, ts] of lastAgentErrorPostedAt) {
      if (now - ts > AGENT_ERROR_DEDUPE_WINDOW_MS * 2) {
        lastAgentErrorPostedAt.delete(k);
      }
    }
  }
  return true;
}

function isPermissionDeniedError(err: unknown): boolean {
  const code = String((err as any)?.code || '');
  const msg = String((err as any)?.message || err || '').toLowerCase();
  return code === '42501' || msg.includes('permission denied');
}

export function logAgentEvent(
  agentId: string,
  event: EventType,
  detail?: string,
  extra?: { durationMs?: number; tokensIn?: number; tokensOut?: number }
): void {
  const isUserInterrupt = /request interrupted by user/i.test(String(detail || ''));

  if (event === 'error' && !isUserInterrupt && shouldPostAgentError(agentId, detail)) {
    const meta = [
      typeof extra?.durationMs === 'number' ? `durationMs=${extra.durationMs}` : null,
      typeof extra?.tokensIn === 'number' ? `tokensIn=${extra.tokensIn}` : null,
      typeof extra?.tokensOut === 'number' ? `tokensOut=${extra.tokensOut}` : null,
    ].filter(Boolean).join(' ');
    void postAgentErrorLog(`agent:${agentId}`, detail || 'Agent error', {
      agentId,
      level: classifyAgentErrorLevel(detail),
      detail: meta || undefined,
    });
  }

  if (activityLogDbDisabled) return;

  pool.query(
    `INSERT INTO agent_activity_log (agent_id, event, detail, duration_ms, tokens_in, tokens_out)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      agentId,
      event,
      detail?.slice(0, 2000) ?? null,
      extra?.durationMs ?? null,
      extra?.tokensIn ?? null,
      extra?.tokensOut ?? null,
    ]
  ).catch((err) => {
    const msg = errMsg(err);
    if (isPermissionDeniedError(err)) {
      activityLogDbDisabled = true;
      console.warn('Activity log DB persistence disabled due to permission error.');
      return;
    }
    if (err?.code !== '42P01' && !msg.includes('Cannot use a pool after calling end on the pool')) {
      console.error('Activity log write error:', msg);
    }
  });
}
