-- Migration 017: Request tracing spans + vector memory (pgvector)
-- Features: trace_spans table for request tracing, agent_embeddings for semantic memory

-- ─── Trace Spans ───
CREATE TABLE IF NOT EXISTS trace_spans (
  id            BIGSERIAL PRIMARY KEY,
  trace_id      TEXT        NOT NULL,
  span_id       TEXT        NOT NULL,
  parent_span_id TEXT,
  agent_id      TEXT        NOT NULL,
  model_name    TEXT,
  operation     TEXT        NOT NULL,  -- 'agent_respond', 'tool_call', 'delegation', 'guardrail'
  status        TEXT        NOT NULL DEFAULT 'ok',  -- 'ok', 'error', 'timeout', 'rate_limited'
  input_tokens  INTEGER     DEFAULT 0,
  output_tokens INTEGER     DEFAULT 0,
  cache_read_tokens  INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  duration_ms   INTEGER,
  tool_name     TEXT,
  error_message TEXT,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trace_spans_trace_id ON trace_spans (trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_spans_agent_id ON trace_spans (agent_id);
CREATE INDEX IF NOT EXISTS idx_trace_spans_created_at ON trace_spans (created_at);
CREATE INDEX IF NOT EXISTS idx_trace_spans_operation ON trace_spans (operation);

-- ─── Vector Memory (pgvector) ───
-- Enable pgvector extension (requires superuser or rds_superuser on Cloud SQL)
-- If this fails, vector memory will gracefully degrade to disabled.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension not available — vector memory will be disabled';
END $$;

-- Embeddings table: stores semantic memories for agent recall
CREATE TABLE IF NOT EXISTS agent_embeddings (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  content_hash TEXT       NOT NULL,
  embedding   vector(768),  -- Gemini text-embedding-004 outputs 768 dims
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_agent_embeddings_agent_id ON agent_embeddings (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_embeddings_created_at ON agent_embeddings (created_at);

-- HNSW index for fast approximate nearest neighbor search
-- Only create if vector type exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_agent_embeddings_hnsw ON agent_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not create HNSW index — will use sequential scan for vector queries';
END $$;

-- ─── Model Health Log ───
CREATE TABLE IF NOT EXISTS model_health_log (
  id          BIGSERIAL PRIMARY KEY,
  model_name  TEXT        NOT NULL,
  status      TEXT        NOT NULL,  -- 'ok', 'rate_limited', 'quota_exhausted', 'auth_error', 'error'
  latency_ms  INTEGER,
  error_message TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_health_log_model ON model_health_log (model_name, created_at);

-- Cleanup policy: retain 7 days of trace data, 30 days of health logs
-- (Run via cron or scheduled Cloud SQL job)
