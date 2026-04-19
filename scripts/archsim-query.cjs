const { Pool } = require('pg');

const token = process.argv[2];

if (!token) {
  console.error('Usage: node scripts/archsim-query.cjs <token>');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ANTHROPIC_INPUT = Number(process.env.CLAUDE_INPUT_COST_PER_M || process.env.LLM_INPUT_COST_PER_M || 15);
const ANTHROPIC_OUTPUT = Number(process.env.CLAUDE_OUTPUT_COST_PER_M || process.env.LLM_OUTPUT_COST_PER_M || 75);
const ANTHROPIC_CACHE_READ = Number(process.env.CLAUDE_CACHE_READ_COST_PER_M || 1.5);
const GEMINI_INPUT = Number(process.env.GEMINI_TEXT_INPUT_COST_PER_M || 0.2);
const GEMINI_OUTPUT = Number(process.env.GEMINI_TEXT_OUTPUT_COST_PER_M || 1.27);

function isAnthropic(model) {
  const key = String(model || '').toLowerCase();
  return key.includes('claude') || key.includes('opus') || key.includes('sonnet') || key.includes('haiku');
}

function spanCost(span) {
  const input = Number(span.input_tokens || 0);
  const output = Number(span.output_tokens || 0);
  const cacheRead = Number(span.cache_read_tokens || 0);
  if (isAnthropic(span.model_name)) {
    const nonCacheInput = Math.max(0, input - cacheRead);
    return (nonCacheInput / 1_000_000) * ANTHROPIC_INPUT +
      (cacheRead / 1_000_000) * ANTHROPIC_CACHE_READ +
      (output / 1_000_000) * ANTHROPIC_OUTPUT;
  }
  return (input / 1_000_000) * GEMINI_INPUT + (output / 1_000_000) * GEMINI_OUTPUT;
}

async function main() {
  const tokenRows = await pool.query(
    `select ts, agent_id, event, detail, duration_ms, tokens_in, tokens_out
       from agent_activity_log
      where ts > now() - interval '2 hours'
        and detail ilike $1
      order by ts asc`,
    [`%${token}%`],
  );

  if (tokenRows.rows.length === 0) {
    console.log(JSON.stringify({ token, error: 'No token rows found' }, null, 2));
    return;
  }

  const firstTs = new Date(tokenRows.rows[0].ts);
  const lastTs = new Date(tokenRows.rows[tokenRows.rows.length - 1].ts);
  const windowStart = new Date(firstTs.getTime() - 90_000).toISOString();
  const windowEnd = new Date(lastTs.getTime() + 180_000).toISOString();

  const spans = await pool.query(
    `select created_at, agent_id, model_name, operation, status,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            duration_ms, tool_name, error_message
       from trace_spans
      where created_at between $1 and $2
      order by created_at asc`,
    [windowStart, windowEnd],
  );

  const activity = await pool.query(
    `select ts, agent_id, event, detail, duration_ms, tokens_in, tokens_out
       from agent_activity_log
      where ts between $1 and $2
      order by ts asc`,
    [windowStart, windowEnd],
  );

  const spanSummary = new Map();
  for (const span of spans.rows) {
    const key = `${span.agent_id}::${span.operation}`;
    const current = spanSummary.get(key) || {
      agentId: span.agent_id,
      operation: span.operation,
      model: span.model_name,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      durationMs: 0,
      usd: 0,
      statuses: new Set(),
    };
    current.calls += 1;
    current.inputTokens += Number(span.input_tokens || 0);
    current.outputTokens += Number(span.output_tokens || 0);
    current.cacheReadTokens += Number(span.cache_read_tokens || 0);
    current.durationMs += Number(span.duration_ms || 0);
    current.usd += spanCost(span);
    current.statuses.add(span.status);
    spanSummary.set(key, current);
  }

  const toolSummary = new Map();
  const activitySummary = new Map();
  for (const row of activity.rows) {
    const activityKey = `${row.agent_id}::${row.event}`;
    const activityCurrent = activitySummary.get(activityKey) || {
      agentId: row.agent_id,
      event: row.event,
      calls: 0,
      durationMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      sampleDetail: String(row.detail || '').slice(0, 220),
    };
    activityCurrent.calls += 1;
    activityCurrent.durationMs += Number(row.duration_ms || 0);
    activityCurrent.tokensIn += Number(row.tokens_in || 0);
    activityCurrent.tokensOut += Number(row.tokens_out || 0);
    activitySummary.set(activityKey, activityCurrent);

    if (row.event !== 'tool') continue;
    const current = toolSummary.get(row.agent_id) || {
      agentId: row.agent_id,
      toolCalls: 0,
      toolDurationMs: 0,
    };
    current.toolCalls += 1;
    current.toolDurationMs += Number(row.duration_ms || 0);
    toolSummary.set(row.agent_id, current);
  }

  const payload = {
    token,
    firstTokenTs: tokenRows.rows[0].ts,
    lastTokenTs: tokenRows.rows[tokenRows.rows.length - 1].ts,
    windowStart,
    windowEnd,
    tokenEvents: tokenRows.rows.map((row) => ({
      ts: row.ts,
      agentId: row.agent_id,
      event: row.event,
      durationMs: row.duration_ms,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      detail: String(row.detail || '').slice(0, 220),
    })),
    spanSummary: [...spanSummary.values()].map((entry) => ({
      ...entry,
      statuses: [...entry.statuses],
      usd: Number(entry.usd.toFixed(6)),
    })).sort((a, b) => b.durationMs - a.durationMs),
    activitySummary: [...activitySummary.values()].sort((a, b) => b.durationMs - a.durationMs),
    toolSummary: [...toolSummary.values()].sort((a, b) => b.toolDurationMs - a.toolDurationMs),
    rawSpanCount: spans.rows.length,
    rawActivityCount: activity.rows.length,
  };

  console.log(JSON.stringify(payload, null, 2));
}

main()
  .catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {}
  });