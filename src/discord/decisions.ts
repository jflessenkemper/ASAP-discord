/**
 * Decision persistence + resolution.
 *
 * Cortana can post a decision card and keep working on a default option
 * ("working on it — click a button to change course"). The decision lands in
 * `decisions` so a resolution can arrive even after a bot restart, and so
 * future turns can see what was decided.
 */

import pool from '../db/pool';
import { errMsg } from '../utils/errors';

export interface RecordDecisionInput {
  messageId: string;
  channelId: string;
  groupchatId?: string;
  options: string[];
  defaultIdx: number;
  reversible: boolean;
  context?: string;
}

export interface DecisionRow {
  id: number;
  message_id: string;
  channel_id: string;
  groupchat_id: string | null;
  options: string[];
  default_idx: number | null;
  reversible: boolean;
  context: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution: string | null;
  resolution_idx: number | null;
}

export async function recordDecision(input: RecordDecisionInput): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO decisions (message_id, channel_id, groupchat_id, options, default_idx, reversible, context)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING id`,
      [
        input.messageId,
        input.channelId,
        input.groupchatId ?? null,
        JSON.stringify(input.options),
        input.defaultIdx,
        input.reversible,
        input.context ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.warn('[decisions] recordDecision failed:', errMsg(err));
    return null;
  }
}

export async function resolveDecision(
  messageId: string,
  resolvedBy: string,
  resolutionIdx: number,
  resolution: string,
): Promise<DecisionRow | null> {
  try {
    const { rows } = await pool.query<DecisionRow>(
      `UPDATE decisions
          SET resolved_at = NOW(),
              resolved_by = $2,
              resolution_idx = $3,
              resolution = $4
        WHERE message_id = $1 AND resolved_at IS NULL
        RETURNING *`,
      [messageId, resolvedBy, resolutionIdx, resolution],
    );
    return rows[0] ?? null;
  } catch (err) {
    console.warn('[decisions] resolveDecision failed:', errMsg(err));
    return null;
  }
}

export async function getUnresolvedDecisions(limit = 20): Promise<DecisionRow[]> {
  try {
    const { rows } = await pool.query<DecisionRow>(
      `SELECT * FROM decisions
        WHERE resolved_at IS NULL
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows;
  } catch (err) {
    console.warn('[decisions] getUnresolvedDecisions failed:', errMsg(err));
    return [];
  }
}
