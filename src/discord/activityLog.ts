import pool from '../db/pool';
import { postAgentErrorLog } from './services/agentErrors';

/**
 * Lightweight agent activity logger.
 * Writes structured events to the agent_activity_log table for debugging.
 * All writes are fire-and-forget — logging never blocks agent execution.
 */

type EventType = 'invoke' | 'tool' | 'response' | 'error' | 'rate_limit';
let activityLogDbDisabled = false;

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
  if (event === 'error') {
    const meta = [
      typeof extra?.durationMs === 'number' ? `durationMs=${extra.durationMs}` : null,
      typeof extra?.tokensIn === 'number' ? `tokensIn=${extra.tokensIn}` : null,
      typeof extra?.tokensOut === 'number' ? `tokensOut=${extra.tokensOut}` : null,
    ].filter(Boolean).join(' ');
    void postAgentErrorLog(`agent:${agentId}`, detail || 'Agent error', {
      agentId,
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
    const msg = err instanceof Error ? err.message : 'Unknown';
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
