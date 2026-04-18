-- Migration 021: Durable self-improvement background job queue

CREATE TABLE IF NOT EXISTS self_improvement_jobs (
  id            BIGSERIAL PRIMARY KEY,
  job_type      TEXT        NOT NULL DEFAULT 'self-improvement',
  status        TEXT        NOT NULL DEFAULT 'pending', -- pending | retry | processing | completed | failed
  payload       JSONB       NOT NULL,
  attempts      INTEGER     NOT NULL DEFAULT 0,
  max_attempts  INTEGER     NOT NULL DEFAULT 5,
  run_after     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at    TIMESTAMPTZ,
  claimed_by    TEXT,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_self_improvement_jobs_pending
  ON self_improvement_jobs (status, run_after, id);

CREATE INDEX IF NOT EXISTS idx_self_improvement_jobs_claimed
  ON self_improvement_jobs (claimed_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_self_improvement_jobs_created_at
  ON self_improvement_jobs (created_at);