import pool from '../db/pool';
import type { ExecutionStatus } from './handoff';
import type { SelfImprovementPacket } from './operationsSteward';

export interface SelfImprovementQueuePayload {
  packet: SelfImprovementPacket;
  goal: string;
  conversationSummary: string;
  status: ExecutionStatus;
  directiveContext: string;
  groupchatChannelId: string;
  workspaceChannelId: string;
}

export interface ClaimedSelfImprovementJob {
  id: number;
  attempts: number;
  maxAttempts: number;
  payload: SelfImprovementQueuePayload;
}

const DEFAULT_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.SELF_IMPROVEMENT_MAX_ATTEMPTS || '5', 10));
const CLAIM_STALE_MS = Math.max(60_000, parseInt(process.env.SELF_IMPROVEMENT_CLAIM_STALE_MS || '900000', 10));
const RETRY_BASE_DELAY_MS = Math.max(1_000, parseInt(process.env.SELF_IMPROVEMENT_RETRY_BASE_DELAY_MS || '10000', 10));
const RETRY_MAX_DELAY_MS = Math.max(RETRY_BASE_DELAY_MS, parseInt(process.env.SELF_IMPROVEMENT_RETRY_MAX_DELAY_MS || '300000', 10));

function isNonRetryableSelfImprovementError(errorDetail: string): boolean {
  const normalized = String(errorDetail || '').toLowerCase();
  if (!normalized) return false;

  return normalized.includes('your credit balance is too low')
    || normalized.includes('plans & billing')
    || normalized.includes('invalid x-api-key')
    || normalized.includes('authentication_error')
    || normalized.includes('unauthorized')
    || normalized.includes('invalid api key')
    || normalized.includes('api key') && normalized.includes('invalid')
    || normalized.includes('daily anthropic token limit reached');
}

function coercePayload(value: unknown): SelfImprovementQueuePayload {
  const payload = value as Partial<SelfImprovementQueuePayload> | undefined;
  return {
    packet: payload?.packet as SelfImprovementPacket,
    goal: String(payload?.goal || ''),
    conversationSummary: String(payload?.conversationSummary || ''),
    status: (payload?.status || 'completed') as ExecutionStatus,
    directiveContext: String(payload?.directiveContext || ''),
    groupchatChannelId: String(payload?.groupchatChannelId || ''),
    workspaceChannelId: String(payload?.workspaceChannelId || ''),
  };
}

export async function enqueueSelfImprovementJob(payload: SelfImprovementQueuePayload): Promise<number> {
  const result = await pool.query(
    `INSERT INTO self_improvement_jobs (payload, max_attempts)
     VALUES ($1::jsonb, $2)
     RETURNING id`,
    [payload, DEFAULT_MAX_ATTEMPTS],
  );
  return Number(result.rows?.[0]?.id || 0);
}

export async function claimNextSelfImprovementJob(instanceTag: string): Promise<ClaimedSelfImprovementJob | null> {
  const staleSeconds = Math.max(1, Math.ceil(CLAIM_STALE_MS / 1000));
  const result = await pool.query(
    `WITH next_job AS (
       SELECT id
       FROM self_improvement_jobs
       WHERE (
         status IN ('pending', 'retry')
         AND run_after <= NOW()
       ) OR (
         status = 'processing'
         AND claimed_at <= NOW() - ($1 * INTERVAL '1 second')
       )
       ORDER BY run_after ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE self_improvement_jobs AS jobs
     SET status = 'processing',
         attempts = jobs.attempts + 1,
         claimed_at = NOW(),
         claimed_by = $2,
         updated_at = NOW(),
         last_error = NULL
     WHERE jobs.id IN (SELECT id FROM next_job)
     RETURNING jobs.id, jobs.attempts, jobs.max_attempts, jobs.payload`,
    [staleSeconds, instanceTag],
  );

  const row = result.rows?.[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || DEFAULT_MAX_ATTEMPTS),
    payload: coercePayload(row.payload),
  };
}

export async function markSelfImprovementJobCompleted(jobId: number): Promise<void> {
  await pool.query(
    `UPDATE self_improvement_jobs
     SET status = 'completed',
         completed_at = NOW(),
         updated_at = NOW(),
         claimed_at = NULL,
         claimed_by = NULL
     WHERE id = $1`,
    [jobId],
  );
}

export async function markSelfImprovementJobFailed(jobId: number, attempts: number, maxAttempts: number, errorDetail: string): Promise<void> {
  const exhausted = attempts >= maxAttempts || isNonRetryableSelfImprovementError(errorDetail);
  const retryDelayMs = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempts - 1)));
  const retryDelaySeconds = Math.max(1, Math.ceil(retryDelayMs / 1000));
  await pool.query(
    `UPDATE self_improvement_jobs
     SET status = $2,
         last_error = $3,
         updated_at = NOW(),
         claimed_at = NULL,
         claimed_by = NULL,
         run_after = CASE
           WHEN $2 = 'failed' THEN run_after
           ELSE NOW() + ($4 * INTERVAL '1 second')
         END
     WHERE id = $1`,
    [jobId, exhausted ? 'failed' : 'retry', errorDetail.slice(0, 4000), retryDelaySeconds],
  );
}