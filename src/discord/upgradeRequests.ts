/**
 * Durable upgrade-request log.
 *
 * Every ✅-approved upgrade card is logged here BEFORE Cortana's dispatch
 * runs. If the bot crashes between INSERT and dispatch, the row stays
 * pending and the startup replay re-fires it. Prevents approvals from
 * vaporizing silently on restart.
 */

import pool from '../db/pool';
import { errMsg } from '../utils/errors';

export interface RecordUpgradeInput {
  requestedBy: string | null;
  issue: string;
  suggestedFix: string | null;
  impact: string | null;
  approvedBy: string;
  sourceMessageId: string | null;
}

export interface PendingUpgrade {
  id: number;
  requested_by: string | null;
  issue: string;
  suggested_fix: string | null;
  impact: string | null;
  approved_by: string;
  source_message_id: string | null;
}

export async function recordApprovedUpgrade(input: RecordUpgradeInput): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO upgrade_requests
         (requested_by, issue, suggested_fix, impact, approved_by, source_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.requestedBy,
        input.issue,
        input.suggestedFix,
        input.impact,
        input.approvedBy,
        input.sourceMessageId,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.warn('[upgradeRequests] recordApprovedUpgrade failed:', errMsg(err));
    return null;
  }
}

export async function markUpgradeDispatched(id: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE upgrade_requests SET dispatched_at = NOW() WHERE id = $1`,
      [id],
    );
  } catch (err) {
    console.warn('[upgradeRequests] markUpgradeDispatched failed:', errMsg(err));
  }
}

export async function markUpgradeCompleted(id: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE upgrade_requests SET completed_at = NOW() WHERE id = $1`,
      [id],
    );
  } catch (err) {
    console.warn('[upgradeRequests] markUpgradeCompleted failed:', errMsg(err));
  }
}

/**
 * Fetch upgrades that were approved but not yet dispatched — the startup
 * replay uses this to resume interrupted handoffs.
 */
export async function listPendingDispatches(limit = 25): Promise<PendingUpgrade[]> {
  try {
    const { rows } = await pool.query<PendingUpgrade>(
      `SELECT id, requested_by, issue, suggested_fix, impact, approved_by, source_message_id
         FROM upgrade_requests
        WHERE dispatched_at IS NULL
        ORDER BY approved_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows;
  } catch (err) {
    console.warn('[upgradeRequests] listPendingDispatches failed:', errMsg(err));
    return [];
  }
}

/**
 * Serialize a pending upgrade row into the description string that
 * dispatchUpgradeToCortana expects. Matches the inline format the reaction
 * handler uses, so replayed dispatches look identical to live ones.
 */
export function formatUpgradeForDispatch(u: Pick<PendingUpgrade, 'requested_by' | 'issue' | 'suggested_fix' | 'impact'>): string {
  const lines: string[] = [];
  if (u.requested_by) lines.push(`**${u.requested_by}** is blocked.`);
  lines.push(`**Issue:** ${u.issue}`);
  if (u.suggested_fix) lines.push(`**Proposed fix:** ${u.suggested_fix}`);
  if (u.impact) lines.push(`**Impact if skipped:** ${u.impact}`);
  return lines.join('\n');
}
