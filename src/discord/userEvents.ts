/**
 * Unified capture for everything the user says or does in Discord.
 *
 * Inserts are synchronous and cheap — embedding happens asynchronously via the
 * embedding worker so it never blocks Cortana's turn.
 */

import pool from '../db/pool';
import { errMsg } from '../utils/errors';

export type UserEventKind =
  | 'text'
  | 'voice'
  | 'image'
  | 'reaction'
  | 'button'
  | 'edit'
  | 'decision';

export interface UserEventInput {
  userId: string;
  channelId: string;
  threadId?: string | null;
  messageId?: string | null;
  kind: UserEventKind;
  text?: string | null;
  attachmentRef?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UserEventRow {
  id: number;
  user_id: string;
  channel_id: string;
  thread_id: string | null;
  message_id: string | null;
  kind: UserEventKind;
  text: string | null;
  attachment_ref: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/**
 * Record a user event. Returns the inserted row id, or null on failure.
 * Never throws — the hot path must not fail because memory capture failed.
 */
export async function recordUserEvent(input: UserEventInput): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO user_events
         (user_id, channel_id, thread_id, message_id, kind, text, attachment_ref, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.userId,
        input.channelId,
        input.threadId ?? null,
        input.messageId ?? null,
        input.kind,
        input.text ?? null,
        input.attachmentRef ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('[userEvents] recordUserEvent failed:', errMsg(err));
    return null;
  }
}

/** Last N events for a user, newest first. Used as the hot context window. */
export async function getRecentUserEvents(
  userId: string,
  limit = 20,
): Promise<UserEventRow[]> {
  try {
    const { rows } = await pool.query<UserEventRow>(
      `SELECT id, user_id, channel_id, thread_id, message_id, kind, text, attachment_ref, metadata, created_at
         FROM user_events
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    return rows;
  } catch (err) {
    console.error('[userEvents] getRecentUserEvents failed:', errMsg(err));
    return [];
  }
}

/** Semantic recall: top-k events most similar to `queryEmbedding`. */
export async function searchUserEventsByEmbedding(
  userId: string,
  queryEmbedding: number[],
  limit = 5,
): Promise<(UserEventRow & { similarity: number })[]> {
  if (!queryEmbedding?.length) return [];
  try {
    const vectorLiteral = `[${queryEmbedding.join(',')}]`;
    const { rows } = await pool.query<UserEventRow & { similarity: number }>(
      `SELECT id, user_id, channel_id, thread_id, message_id, kind, text, attachment_ref, metadata, created_at,
              1 - (embedding <=> $2::vector) AS similarity
         FROM user_events
        WHERE user_id = $1 AND embedding IS NOT NULL
        ORDER BY embedding <=> $2::vector
        LIMIT $3`,
      [userId, vectorLiteral, limit],
    );
    return rows;
  } catch (err) {
    console.error('[userEvents] searchUserEventsByEmbedding failed:', errMsg(err));
    return [];
  }
}

/** Batch used by the embedding worker to find rows that still need embeddings. */
export async function claimPendingEmbeddings(batchSize = 25): Promise<UserEventRow[]> {
  try {
    const { rows } = await pool.query<UserEventRow>(
      `SELECT id, user_id, channel_id, thread_id, message_id, kind, text, attachment_ref, metadata, created_at
         FROM user_events
        WHERE embedding IS NULL AND text IS NOT NULL
        ORDER BY id ASC
        LIMIT $1`,
      [batchSize],
    );
    return rows;
  } catch (err) {
    console.error('[userEvents] claimPendingEmbeddings failed:', errMsg(err));
    return [];
  }
}

export async function writeEmbedding(id: number, embedding: number[]): Promise<void> {
  if (!embedding?.length) return;
  try {
    const vectorLiteral = `[${embedding.join(',')}]`;
    await pool.query(
      `UPDATE user_events
          SET embedding = $2::vector,
              embedded_at = NOW()
        WHERE id = $1`,
      [id, vectorLiteral],
    );
  } catch (err) {
    console.error('[userEvents] writeEmbedding failed:', errMsg(err));
  }
}
