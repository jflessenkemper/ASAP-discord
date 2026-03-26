-- Agent memory table — replaces ephemeral filesystem .agent-memory/ directory
-- Persists across Cloud Run deployments and scale-to-zero events

CREATE TABLE IF NOT EXISTS agent_memory (
  file_name TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_memory_updated ON agent_memory (updated_at);
