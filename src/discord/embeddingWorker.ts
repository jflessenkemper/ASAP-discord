/**
 * Background worker that embeds new user_events so Cortana can semantically
 * recall them later. Runs on a short interval, pulls pending rows in small
 * batches, and writes the embedding back. Keeps hot-path inserts fast.
 *
 * Backoff policy: if embedText returns null repeatedly (no creds, API down,
 * quota exhausted), the worker slows down exponentially — otherwise it would
 * spam the logs every tick. Resets to normal cadence on the next success.
 */

import { claimPendingEmbeddings, writeEmbedding } from './userEvents';
import { embedText } from './embeddings';
import { errMsg } from '../utils/errors';

const BASE_INTERVAL_MS = Math.max(5_000, parseInt(process.env.EMBEDDING_WORKER_INTERVAL_MS || '15000', 10));
const BATCH_SIZE = Math.max(1, parseInt(process.env.EMBEDDING_WORKER_BATCH || '10', 10));
const MAX_BACKOFF_MS = Math.max(BASE_INTERVAL_MS, parseInt(process.env.EMBEDDING_WORKER_MAX_BACKOFF_MS || '600000', 10));

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let consecutiveFailures = 0;
let lastErrorLoggedAt = 0;

function currentIntervalMs(): number {
  if (consecutiveFailures === 0) return BASE_INTERVAL_MS;
  // Exponential backoff: 15s → 30s → 60s → 120s → 240s → … capped.
  const backoff = BASE_INTERVAL_MS * Math.pow(2, Math.min(consecutiveFailures, 8));
  return Math.min(backoff, MAX_BACKOFF_MS);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const rows = await claimPendingEmbeddings(BATCH_SIZE);
    if (rows.length === 0) {
      // Nothing to do — don't count idle as failure.
      consecutiveFailures = 0;
      return;
    }

    // Probe once with the first row. If embedding returns null, assume creds
    // or provider are unavailable and back off instead of hammering the whole
    // batch. A missing provider typically means every row would fail.
    const first = rows[0];
    if (!first.text) {
      consecutiveFailures = 0;
      return;
    }

    const firstVec = await embedText(first.text);
    if (!firstVec) {
      consecutiveFailures += 1;
      // Log at most once per 5 min to keep the signal.
      const now = Date.now();
      if (now - lastErrorLoggedAt > 5 * 60_000) {
        console.warn(
          `[embeddingWorker] embed unavailable (retry #${consecutiveFailures}). ` +
          `Backing off for ${Math.round(currentIntervalMs() / 1000)}s. ` +
          `Common causes: Vertex ADC missing, quota exhausted, VERTEX_PROJECT_ID unset.`,
        );
        lastErrorLoggedAt = now;
      }
      return;
    }

    // Success on the probe — write it and continue through the rest of the
    // batch. Reset backoff.
    consecutiveFailures = 0;
    await writeEmbedding(first.id, firstVec);
    for (const row of rows.slice(1)) {
      if (!row.text) continue;
      const vec = await embedText(row.text);
      if (!vec) {
        // Mid-batch failure — stop; we'll retry remaining rows next tick.
        consecutiveFailures += 1;
        return;
      }
      await writeEmbedding(row.id, vec);
    }
  } catch (err) {
    consecutiveFailures += 1;
    const now = Date.now();
    if (now - lastErrorLoggedAt > 5 * 60_000) {
      console.warn('[embeddingWorker] tick failed:', errMsg(err));
      lastErrorLoggedAt = now;
    }
  } finally {
    running = false;
    // Re-arm with current (possibly backed-off) interval.
    if (timer !== null) {
      timer = setTimeout(() => { void tick(); }, currentIntervalMs());
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  }
}

export function startEmbeddingWorker(): void {
  if (timer) return;
  // Fire immediately so fresh rows get embedded within seconds of capture.
  timer = setTimeout(() => { void tick(); }, 0);
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function stopEmbeddingWorker(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
