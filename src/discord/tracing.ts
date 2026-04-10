import { randomUUID } from 'crypto';

import pool from '../db/pool';

import { logAgentEvent } from './activityLog';

// ─── Types ───

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  agentId: string;
  modelName?: string;
  operation: string;
  status: 'ok' | 'error' | 'timeout' | 'rate_limited';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs?: number;
  toolName?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
}

// ─── Trace ID Generation ───

export function newTraceId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

export function newSpanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

export function createTraceContext(parentTrace?: TraceContext): TraceContext {
  return {
    traceId: parentTrace?.traceId || newTraceId(),
    spanId: newSpanId(),
  };
}

// ─── Span Recording ───

let dbDisabled = false;

function logSpanStructured(span: TraceSpan): void {
  const log = {
    level: span.status === 'error' ? 'error' : 'info',
    type: 'trace_span',
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    agent: span.agentId,
    model: span.modelName,
    op: span.operation,
    status: span.status,
    tokensIn: span.inputTokens,
    tokensOut: span.outputTokens,
    cacheRead: span.cacheReadTokens,
    cacheWrite: span.cacheWriteTokens,
    durationMs: span.durationMs,
    tool: span.toolName,
    error: span.errorMessage?.slice(0, 200),
  };
  console.log(JSON.stringify(log));
}

export async function recordSpan(span: TraceSpan): Promise<void> {
  logSpanStructured(span);

  if (dbDisabled) return;

  try {
    await pool.query(
      `INSERT INTO trace_spans
        (trace_id, span_id, parent_span_id, agent_id, model_name, operation,
         status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         duration_ms, tool_name, error_message, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        span.traceId,
        span.spanId,
        span.parentSpanId || null,
        span.agentId,
        span.modelName || null,
        span.operation,
        span.status,
        span.inputTokens,
        span.outputTokens,
        span.cacheReadTokens,
        span.cacheWriteTokens,
        span.durationMs ?? null,
        span.toolName || null,
        span.errorMessage?.slice(0, 500) || null,
        span.metadata ? JSON.stringify(span.metadata) : null,
      ],
    );
  } catch (err: any) {
    if (
      String(err?.message || '').includes('does not exist') ||
      String(err?.code || '') === '42P01'
    ) {
      dbDisabled = true;
      console.warn('trace_spans table not found — tracing DB persistence disabled');
    }
  }
}

// ─── Span Helper: time a function and record the span ───

export async function traceOperation<T>(
  ctx: TraceContext,
  agentId: string,
  operation: string,
  fn: () => Promise<T>,
  opts?: { modelName?: string; toolName?: string; parentSpanId?: string },
): Promise<{ result: T; span: TraceSpan }> {
  const spanId = newSpanId();
  const start = Date.now();
  let status: TraceSpan['status'] = 'ok';
  let errorMessage: string | undefined;
  let result: T;

  try {
    result = await fn();
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    status = msg.includes('429') || msg.includes('rate') ? 'rate_limited'
      : msg.includes('timeout') || msg.includes('timed out') ? 'timeout'
      : 'error';
    errorMessage = msg.slice(0, 500);
    throw err;
  } finally {
    const span: TraceSpan = {
      traceId: ctx.traceId,
      spanId,
      parentSpanId: opts?.parentSpanId || ctx.spanId,
      agentId,
      modelName: opts?.modelName,
      operation,
      status: status!,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: Date.now() - start,
      toolName: opts?.toolName,
      errorMessage,
    };
    void recordSpan(span);
  }

  const span: TraceSpan = {
    traceId: ctx.traceId,
    spanId,
    parentSpanId: opts?.parentSpanId || ctx.spanId,
    agentId,
    modelName: opts?.modelName,
    operation,
    status,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: Date.now() - start,
    toolName: opts?.toolName,
    errorMessage,
  };
  return { result, span };
}

// ─── Query helpers ───

export async function getRecentTraces(agentId?: string, limit = 20): Promise<TraceSpan[]> {
  if (dbDisabled) return [];
  try {
    const query = agentId
      ? `SELECT * FROM trace_spans WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`
      : `SELECT * FROM trace_spans ORDER BY created_at DESC LIMIT $1`;
    const params = agentId ? [agentId, limit] : [limit];
    const res = await pool.query(query, params);
    return res.rows.map(rowToSpan);
  } catch {
    return [];
  }
}

export async function getTraceById(traceId: string): Promise<TraceSpan[]> {
  if (dbDisabled) return [];
  try {
    const res = await pool.query(
      'SELECT * FROM trace_spans WHERE trace_id = $1 ORDER BY created_at ASC',
      [traceId],
    );
    return res.rows.map(rowToSpan);
  } catch {
    return [];
  }
}

function rowToSpan(row: any): TraceSpan {
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id || undefined,
    agentId: row.agent_id,
    modelName: row.model_name || undefined,
    operation: row.operation,
    status: row.status,
    inputTokens: row.input_tokens || 0,
    outputTokens: row.output_tokens || 0,
    cacheReadTokens: row.cache_read_tokens || 0,
    cacheWriteTokens: row.cache_write_tokens || 0,
    durationMs: row.duration_ms ?? undefined,
    toolName: row.tool_name || undefined,
    errorMessage: row.error_message || undefined,
    metadata: row.metadata || undefined,
  };
}

// ─── Cleanup ───

export async function cleanupOldTraces(retentionDays = 7): Promise<number> {
  if (dbDisabled) return 0;
  try {
    const res = await pool.query(
      `DELETE FROM trace_spans WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
      [retentionDays],
    );
    return res.rowCount || 0;
  } catch {
    return 0;
  }
}
