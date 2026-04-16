import pool from '../db/pool';
import { MODEL_FALLBACK_CHAINS } from '../services/modelConfig';

// ─── Model Health Auto-Routing ───
// Per-model health tracking with transparent fallback chains.
// Replaces the all-or-nothing quota fuse with granular health scores.

export type ModelStatus = 'healthy' | 'degraded' | 'down';

interface ModelHealth {
  modelName: string;
  status: ModelStatus;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  lastSuccessAt: number;
  lastFailureAt: number;
  lastLatencyMs: number;
  avgLatencyMs: number;
  downUntil: number;   // if set, model is considered down until this timestamp
}

const healthMap = new Map<string, ModelHealth>();
const HEALTH_WINDOW_MS = parseInt(process.env.MODEL_HEALTH_WINDOW_MS || '300000', 10);  // 5min
const DOWN_COOLDOWN_MS = parseInt(process.env.MODEL_HEALTH_DOWN_COOLDOWN_MS || '120000', 10);  // 2min
const DEGRADED_THRESHOLD = parseFloat(process.env.MODEL_HEALTH_DEGRADED_THRESHOLD || '0.3');  // 30% failure rate
const DOWN_THRESHOLD = parseFloat(process.env.MODEL_HEALTH_DOWN_THRESHOLD || '0.7');  // 70% failure rate
const MIN_SAMPLES = parseInt(process.env.MODEL_HEALTH_MIN_SAMPLES || '3', 10);
let dbDisabled = false;

// ─── Fallback Chains ───

/**
 * Check if a model resolved differently from the preferred model (i.e. is on fallback).
 */
export function isOnFallbackModel(preferredModel: string): boolean {
  return resolveHealthyModel(preferredModel) !== preferredModel;
}

function getHealth(modelName: string): ModelHealth {
  const key = normalizeModel(modelName);
  let health = healthMap.get(key);
  if (!health) {
    health = {
      modelName: key,
      status: 'healthy',
      successCount: 0,
      failureCount: 0,
      rateLimitCount: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      lastLatencyMs: 0,
      avgLatencyMs: 0,
      downUntil: 0,
    };
    healthMap.set(key, health);
  }
  return health;
}

function normalizeModel(name: string): string {
  return String(name || '').trim().toLowerCase();
}

function updateStatus(health: ModelHealth): void {
  const now = Date.now();

  // If explicitly down, check cooldown
  if (health.downUntil > now) {
    health.status = 'down';
    return;
  }

  const total = health.successCount + health.failureCount;
  if (total < MIN_SAMPLES) {
    health.status = 'healthy';
    return;
  }

  const failureRate = health.failureCount / total;
  if (failureRate >= DOWN_THRESHOLD) {
    health.status = 'down';
    health.downUntil = now + DOWN_COOLDOWN_MS;
  } else if (failureRate >= DEGRADED_THRESHOLD) {
    health.status = 'degraded';
  } else {
    health.status = 'healthy';
  }
}

function decayCounters(health: ModelHealth): void {
  // Every HEALTH_WINDOW_MS, halve the counters to allow recovery
  const now = Date.now();
  const lastEvent = Math.max(health.lastSuccessAt, health.lastFailureAt);
  if (lastEvent > 0 && now - lastEvent > HEALTH_WINDOW_MS) {
    health.successCount = Math.floor(health.successCount / 2);
    health.failureCount = Math.floor(health.failureCount / 2);
    health.rateLimitCount = Math.floor(health.rateLimitCount / 2);
  }
}

// ─── Public API ───

export function recordModelSuccess(modelName: string, latencyMs: number): void {
  const health = getHealth(modelName);
  decayCounters(health);
  health.successCount++;
  health.lastSuccessAt = Date.now();
  health.lastLatencyMs = latencyMs;
  health.avgLatencyMs = health.avgLatencyMs > 0
    ? Math.round(health.avgLatencyMs * 0.8 + latencyMs * 0.2)
    : latencyMs;
  updateStatus(health);
  void persistHealthEvent(modelName, 'ok', latencyMs);
}

export function recordModelFailure(modelName: string, errorType: 'rate_limited' | 'quota_exhausted' | 'auth_error' | 'error', errorMsg?: string): void {
  const health = getHealth(modelName);
  decayCounters(health);
  health.failureCount++;
  health.lastFailureAt = Date.now();
  if (errorType === 'rate_limited') {
    health.rateLimitCount++;
  }
  if (errorType === 'quota_exhausted') {
    // Quota exhaustion = immediately mark down for longer
    health.downUntil = Date.now() + DOWN_COOLDOWN_MS * 3;
  }
  updateStatus(health);
  void persistHealthEvent(modelName, errorType, undefined, errorMsg);
}

export function getModelStatus(modelName: string): ModelStatus {
  const health = getHealth(modelName);
  decayCounters(health);
  updateStatus(health);
  return health.status;
}

export function isModelAvailable(modelName: string): boolean {
  return getModelStatus(modelName) !== 'down';
}

/**
 * Given a preferred model, return the best available model from its fallback chain.
 * Returns the preferred model if healthy, otherwise walks the chain.
 */
export function resolveHealthyModel(preferredModel: string): string {
  const key = normalizeModel(preferredModel);
  if (isModelAvailable(preferredModel)) return preferredModel;

  const chain = MODEL_FALLBACK_CHAINS[key] || [];
  for (const fallback of chain) {
    if (isModelAvailable(fallback)) {
      console.warn(`Model ${preferredModel} is ${getModelStatus(preferredModel)} — routing to ${fallback}`);
      return fallback;
    }
  }

  // All models are down — log a loud warning so ops can investigate
  console.error(`[model-health] ALL MODELS DOWN in fallback chain for ${preferredModel}: [${chain.join(', ')}]. Trying preferred model as last resort.`);
  return preferredModel;
}

/**
 * Force a model back to healthy (e.g., after manual intervention).
 */
export function resetModelHealth(modelName: string): void {
  const key = normalizeModel(modelName);
  healthMap.delete(key);
}

/**
 * Get health summary for all tracked models (for /api/metrics or debug).
 */
export function getAllModelHealth(): ModelHealth[] {
  const results: ModelHealth[] = [];
  for (const health of healthMap.values()) {
    decayCounters(health);
    updateStatus(health);
    results.push({ ...health });
  }
  return results;
}

// ─── DB Persistence ───

async function persistHealthEvent(
  modelName: string,
  status: string,
  latencyMs?: number,
  errorMsg?: string,
): Promise<void> {
  if (dbDisabled) return;
  try {
    await pool.query(
      `INSERT INTO model_health_log (model_name, status, latency_ms, error_message)
       VALUES ($1, $2, $3, $4)`,
      [normalizeModel(modelName), status, latencyMs ?? null, errorMsg?.slice(0, 500) ?? null],
    );
  } catch (err: any) {
    if (
      String(err?.message || '').includes('does not exist') ||
      String(err?.code || '') === '42P01'
    ) {
      dbDisabled = true;
    }
  }
}
