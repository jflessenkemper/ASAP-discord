-- 025: Index tunings from the April 2026 perf audit.
--
-- 1. decisions: getUnresolvedDecisions orders by created_at DESC but the
--    existing partial index on (resolved_at) doesn't cover the sort.
--    Add a composite partial index for the common query shape.
--
-- 2. agent_memory: destroyDynamicAgent runs
--      WHERE file_name IN ($1,$2) AND file_name NOT LIKE 'archived-%'
--    which is a full scan today (only an updated_at index exists). Small
--    table, but dynamic-agent churn is growing — cheap to index now.

CREATE INDEX IF NOT EXISTS idx_decisions_unresolved_recent
  ON decisions (created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_memory_file_name
  ON agent_memory (file_name);
