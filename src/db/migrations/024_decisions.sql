-- 024: Durable decisions log.
--
-- Every time Riley posts a decision card, a row lands here. When the user
-- clicks a button the row is updated with the resolution. This gives the
-- system a history of decisions without mining Discord messages, and lets a
-- pending decision survive a bot restart.

CREATE TABLE IF NOT EXISTS decisions (
  id           BIGSERIAL PRIMARY KEY,
  message_id   TEXT        NOT NULL,
  channel_id   TEXT        NOT NULL,
  groupchat_id TEXT,
  options      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Default option index Riley is proceeding with while awaiting confirmation.
  -- Lets the user see "working on option 2 pending override".
  default_idx  INTEGER,
  reversible   BOOLEAN     NOT NULL DEFAULT true,
  context      TEXT,
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT,
  resolution   TEXT,
  resolution_idx INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decisions_unresolved
  ON decisions (created_at DESC) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_decisions_message
  ON decisions (message_id);
