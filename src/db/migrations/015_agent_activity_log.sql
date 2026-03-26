-- Agent activity log — records every agent invocation, tool call, response, and error
-- for debugging and observability. Queryable via /api/agent-log endpoint.

CREATE TABLE IF NOT EXISTS agent_activity_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  agent_id TEXT NOT NULL,
  event TEXT NOT NULL,        -- 'invoke' | 'tool' | 'response' | 'error' | 'rate_limit'
  detail TEXT,                -- tool name, error message, response preview, etc.
  duration_ms INTEGER,        -- how long the operation took (for invoke/tool events)
  tokens_in INTEGER,
  tokens_out INTEGER
);

CREATE INDEX idx_agent_log_ts ON agent_activity_log (ts DESC);
CREATE INDEX idx_agent_log_agent ON agent_activity_log (agent_id, ts DESC);
