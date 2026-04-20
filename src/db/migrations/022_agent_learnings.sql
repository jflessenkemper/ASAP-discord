-- 022: Shared agent learnings table for cross-agent pattern recall
CREATE TABLE IF NOT EXISTS agent_learnings (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  pattern TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL DEFAULT 0.7,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT now() + interval '30 days'
);

CREATE INDEX IF NOT EXISTS idx_agent_learnings_lookup
  ON agent_learnings (agent_id, active, tag);

CREATE INDEX IF NOT EXISTS idx_agent_learnings_expires
  ON agent_learnings (expires_at) WHERE active;
