import pool from '../db/pool';
import { recordLoopHealth } from './loopHealth';
import { recordAgentLearning } from './vectorMemory';
import { errMsg } from '../utils/errors';

export interface AnomalyReport {
  type: string;
  severity: 'warn' | 'error';
  detail: string;
  recommendedAction: string;
}

const ERROR_RATE_THRESHOLD = 2;
const TOKEN_COST_THRESHOLD = 1.5;
const DURATION_THRESHOLD = 1.5;
const RATE_LIMIT_THRESHOLD = 5;

export async function detectAnomalies(): Promise<AnomalyReport[]> {
  const anomalies: AnomalyReport[] = [];

  try {
    // 1. Error rate spike: last hour vs previous 6h average
    const errorRate = await pool.query(`
      WITH recent AS (
        SELECT COUNT(*) AS cnt FROM agent_activity_log
        WHERE event = 'error' AND ts > now() - interval '1 hour'
      ),
      baseline AS (
        SELECT COUNT(*) / GREATEST(6, 1) AS avg_cnt FROM agent_activity_log
        WHERE event = 'error' AND ts > now() - interval '7 hours' AND ts <= now() - interval '1 hour'
      )
      SELECT recent.cnt AS recent_cnt, baseline.avg_cnt AS baseline_avg
      FROM recent, baseline
    `);
    const er = errorRate.rows[0];
    if (er && Number(er.recent_cnt) > ERROR_RATE_THRESHOLD * Math.max(1, Number(er.baseline_avg))) {
      anomalies.push({
        type: 'error-rate-spike',
        severity: 'error',
        detail: `Error count last hour: ${er.recent_cnt} vs 6h average: ${Number(er.baseline_avg).toFixed(1)}`,
        recommendedAction: 'Investigate recent errors in agent_activity_log for common source/pattern.',
      });
    }

    // 2. Token cost trend: avg(tokens_in+tokens_out) last hour vs 6h average
    const tokenCost = await pool.query(`
      WITH recent AS (
        SELECT AVG(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS avg_tokens
        FROM agent_activity_log
        WHERE event = 'response' AND ts > now() - interval '1 hour'
      ),
      baseline AS (
        SELECT AVG(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS avg_tokens
        FROM agent_activity_log
        WHERE event = 'response' AND ts > now() - interval '7 hours' AND ts <= now() - interval '1 hour'
      )
      SELECT recent.avg_tokens AS recent_avg, baseline.avg_tokens AS baseline_avg
      FROM recent, baseline
    `);
    const tc = tokenCost.rows[0];
    if (tc && Number(tc.recent_avg) > TOKEN_COST_THRESHOLD * Math.max(1, Number(tc.baseline_avg || 0))) {
      anomalies.push({
        type: 'token-cost-spike',
        severity: 'warn',
        detail: `Avg tokens/response last hour: ${Number(tc.recent_avg).toFixed(0)} vs 6h average: ${Number(tc.baseline_avg || 0).toFixed(0)}`,
        recommendedAction: 'Check for verbose prompts or unexpected tool loops increasing token usage.',
      });
    }

    // 3. Duration degradation: avg(duration_ms) for responses last hour vs 6h average
    const duration = await pool.query(`
      WITH recent AS (
        SELECT AVG(duration_ms) AS avg_dur FROM agent_activity_log
        WHERE event = 'response' AND duration_ms IS NOT NULL AND ts > now() - interval '1 hour'
      ),
      baseline AS (
        SELECT AVG(duration_ms) AS avg_dur FROM agent_activity_log
        WHERE event = 'response' AND duration_ms IS NOT NULL
          AND ts > now() - interval '7 hours' AND ts <= now() - interval '1 hour'
      )
      SELECT recent.avg_dur AS recent_avg, baseline.avg_dur AS baseline_avg
      FROM recent, baseline
    `);
    const dur = duration.rows[0];
    if (dur && Number(dur.recent_avg) > DURATION_THRESHOLD * Math.max(1, Number(dur.baseline_avg || 0))) {
      anomalies.push({
        type: 'latency-degradation',
        severity: 'warn',
        detail: `Avg response duration last hour: ${Number(dur.recent_avg).toFixed(0)}ms vs 6h average: ${Number(dur.baseline_avg || 0).toFixed(0)}ms`,
        recommendedAction: 'Check model health, quota status, and network latency.',
      });
    }

    // 4. Rate limit frequency: count in last hour
    const rateLimit = await pool.query(`
      SELECT COUNT(*) AS cnt FROM agent_activity_log
      WHERE event = 'rate_limit' AND ts > now() - interval '1 hour'
    `);
    const rl = rateLimit.rows[0];
    if (rl && Number(rl.cnt) > RATE_LIMIT_THRESHOLD) {
      anomalies.push({
        type: 'rate-limit-frequency',
        severity: 'error',
        detail: `${rl.cnt} rate limit events in the last hour (threshold: ${RATE_LIMIT_THRESHOLD})`,
        recommendedAction: 'Consider reducing request concurrency or switching to a backup model.',
      });
    }

    // Record learnings for each anomaly
    for (const anomaly of anomalies) {
      recordAgentLearning(
        'operations-manager',
        `${anomaly.type}: ${anomaly.detail}`,
        anomaly.type,
        'anomaly',
      ).catch(() => {});
    }

    recordLoopHealth(
      'anomaly-detection',
      anomalies.some(a => a.severity === 'error') ? 'error' : anomalies.length > 0 ? 'warn' : 'ok',
      anomalies.length > 0
        ? `${anomalies.length} anomalies: ${anomalies.map(a => a.type).join(', ')}`
        : 'no anomalies detected',
    );
  } catch (err) {
    recordLoopHealth('anomaly-detection', 'error', errMsg(err));
    console.error('[anomalyDetection] detectAnomalies failed:', errMsg(err));
  }

  return anomalies;
}
