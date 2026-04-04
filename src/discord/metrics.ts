/**
 * Lightweight in-memory metrics for the ASAP Discord bot.
 *
 * Exposes bot health data in Prometheus text exposition format
 * at GET /api/metrics (see server/src/index.ts).
 *
 * No external dependencies — all tracking is via counters/gauges stored
 * in plain JS objects. Thread-safe for single-process Node.js.
 */

/* ─────────────────────────── types ─────────────────────────── */

interface Counter {
  type: 'counter';
  help: string;
  /** Map of label-key → cumulative count */
  values: Map<string, number>;
}

interface Gauge {
  type: 'gauge';
  help: string;
  /** Map of label-key → current value */
  values: Map<string, number>;
}

interface Histogram {
  type: 'histogram';
  help: string;
  /** Upper bounds for each bucket (must be in ascending order) */
  buckets: number[];
  /** Label-key → per-bucket counts (parallel array matching buckets) */
  bucketValues: Map<string, number[]>;
  /** Label-key → sum of all observed values */
  sums: Map<string, number>;
  /** Label-key → number of observations */
  counts: Map<string, number>;
}

type Metric = Counter | Gauge | Histogram;

/* ─────────────────────────── registry ─────────────────────────── */

const registry = new Map<string, Metric>();

function registerCounter(name: string, help: string): Counter {
  const m: Counter = { type: 'counter', help, values: new Map() };
  registry.set(name, m);
  return m;
}

function registerGauge(name: string, help: string): Gauge {
  const m: Gauge = { type: 'gauge', help, values: new Map() };
  registry.set(name, m);
  return m;
}

function registerHistogram(name: string, help: string, buckets: number[]): Histogram {
  const m: Histogram = { type: 'histogram', help, buckets, bucketValues: new Map(), sums: new Map(), counts: new Map() };
  registry.set(name, m);
  return m;
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
    .join(',');
}

/* ─────────────────────────── instruments ─────────────────────────── */

const voiceCallsTotal = registerCounter('asap_voice_calls_total', 'Total voice calls initiated');
const apiCallsTotal   = registerCounter('asap_api_calls_total',   'Total outbound API calls by service and status');
const ttsErrorsTotal  = registerCounter('asap_tts_errors_total',  'Total TTS failures by service');
const agentInvocations = registerCounter('asap_agent_invocations_total', 'Total agent response invocations by agent id');
const rateLimitHits   = registerCounter('asap_rate_limit_hits_total', 'Total 429 rate-limit hits from Gemini');
const thinkingChimesPlayed = registerCounter('asap_thinking_chimes_played_total', 'Total thinking chimes played in voice calls');

const voiceCallsActive = registerGauge('asap_voice_calls_active', 'Number of currently active voice calls');
const geminiSpentUsd   = registerGauge('asap_gemini_spent_usd',   'USD spent on Gemini API today');
const memoryUsageMb    = registerGauge('asap_memory_usage_mb',    'Heap memory usage in MB');
const processUptimeSec = registerGauge('asap_process_uptime_seconds', 'Process uptime in seconds');

const ttsLatencyMs     = registerHistogram('asap_tts_latency_ms',        'TTS generation latency (ms)',            [50, 100, 200, 500, 1000, 2000, 5000]);
const transcriptionMs  = registerHistogram('asap_transcription_latency_ms', 'Voice transcription latency (ms)',   [200, 500, 1000, 2000, 3000, 5000, 10000]);
const agentResponseMs  = registerHistogram('asap_agent_response_time_ms', 'Agent LLM round-trip latency (ms)',    [500, 1000, 2000, 5000, 10000, 30000, 60000]);

/* ─────────────────────────── helpers ─────────────────────────── */

function incCounter(m: Counter, labels: Record<string, string> = {}, by = 1): void {
  const key = labelKey(labels);
  m.values.set(key, (m.values.get(key) ?? 0) + by);
}

function setGauge(m: Gauge, value: number, labels: Record<string, string> = {}): void {
  m.values.set(labelKey(labels), value);
}

function observeHistogram(m: Histogram, value: number, labels: Record<string, string> = {}): void {
  const key = labelKey(labels);
  if (!m.bucketValues.has(key)) {
    m.bucketValues.set(key, new Array(m.buckets.length + 1).fill(0));
  }
  const buckets = m.bucketValues.get(key)!;
  for (let i = 0; i < m.buckets.length; i++) {
    if (value <= m.buckets[i]) buckets[i]++;
  }
  buckets[m.buckets.length]++; // +Inf bucket
  m.sums.set(key,   (m.sums.get(key)   ?? 0) + value);
  m.counts.set(key, (m.counts.get(key) ?? 0) + 1);
}

/* ─────────────────────────── public API ─────────────────────────── */

/** Call when a voice call starts. */
export function recordVoiceCallStart(): void {
  incCounter(voiceCallsTotal);
  setGauge(voiceCallsActive, (voiceCallsActive.values.get('') ?? 0) + 1);
}

/** Call when a voice call ends. */
export function recordVoiceCallEnd(): void {
  const current = voiceCallsActive.values.get('') ?? 0;
  setGauge(voiceCallsActive, Math.max(0, current - 1));
}

/** Call when an outbound API request completes. */
export function recordApiCall(service: string, statusCode: number): void {
  incCounter(apiCallsTotal, { service, status: String(statusCode) });
}

/** Call when TTS generation fails (e.g. ElevenLabs/Gemini error). */
export function recordTtsError(service: 'elevenlabs' | 'gemini', errorType: string): void {
  incCounter(ttsErrorsTotal, { service, error_type: errorType });
}

/** Call after each TTS generation with the elapsed ms. */
export function recordTtsLatency(service: 'elevenlabs' | 'gemini', latencyMs: number): void {
  observeHistogram(ttsLatencyMs, latencyMs, { service });
}

export function recordTranscriptionLatency(service: 'deepgram' | 'gemini' | 'elevenlabs', latencyMs: number): void {
  observeHistogram(transcriptionMs, latencyMs, { service });
}

/** Call after each agent `agentRespond` call completes. */
export function recordAgentResponse(agentId: string, latencyMs: number): void {
  incCounter(agentInvocations, { agent: agentId });
  observeHistogram(agentResponseMs, latencyMs, { agent: agentId });
}

/** Call when a Gemini 429 is received. */
export function recordRateLimitHit(): void {
  incCounter(rateLimitHits);
}

/** Call when a thinking chime is played in a voice call. */
export function recordThinkingChimePlayed(): void {
  incCounter(thinkingChimesPlayed);
}

/** Update Gemini USD spent gauge (called from usage.ts or similar). */
export function updateGeminiSpend(usd: number): void {
  setGauge(geminiSpentUsd, usd);
}

/**
 * Refresh process-level gauges (memory, uptime).
 * Called internally by `getMetricsText()`.
 */
function refreshProcessMetrics(): void {
  const heap = process.memoryUsage().heapUsed / 1024 / 1024;
  setGauge(memoryUsageMb, Math.round(heap * 10) / 10);
  setGauge(processUptimeSec, Math.floor(process.uptime()));
}

/* ─────────────────────────── Prometheus text serialiser ─────────────────────────── */

function serializeMetric(name: string, m: Metric): string {
  const lines: string[] = [];
  lines.push(`# HELP ${name} ${m.help}`);
  lines.push(`# TYPE ${name} ${m.type}`);

  if (m.type === 'counter' || m.type === 'gauge') {
    for (const [key, value] of m.values) {
      const labels = key ? `{${key}}` : '';
      lines.push(`${name}${labels} ${value}`);
    }
    if (m.values.size === 0) {
      lines.push(`${name} 0`);
    }
  } else if (m.type === 'histogram') {
    for (const [key, buckets] of m.bucketValues) {
      const labelSuffix = key ? `,${key}` : '';
      for (let i = 0; i < m.buckets.length; i++) {
        lines.push(`${name}_bucket{le="${m.buckets[i]}"${labelSuffix}} ${buckets[i]}`);
      }
      lines.push(`${name}_bucket{le="+Inf"${labelSuffix}} ${buckets[m.buckets.length]}`);
      lines.push(`${name}_sum${key ? `{${key}}` : ''} ${m.sums.get(key) ?? 0}`);
      lines.push(`${name}_count${key ? `{${key}}` : ''} ${m.counts.get(key) ?? 0}`);
    }
  }

  return lines.join('\n');
}

/**
 * Return all metrics in Prometheus text exposition format.
 * Safe to call from an HTTP handler — refreshes process-level gauges first.
 */
export function getMetricsText(): string {
  refreshProcessMetrics();
  const parts: string[] = [];
  for (const [name, m] of registry) {
    parts.push(serializeMetric(name, m));
  }
  return parts.join('\n\n') + '\n';
}

/** Content-Type header value for Prometheus text format. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
