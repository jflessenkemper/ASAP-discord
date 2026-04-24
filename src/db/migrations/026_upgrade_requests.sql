-- 026: Durable upgrade-request log.
--
-- When Jordan reacts ✅ on a Cortana-authored upgrade approval card in
-- #🆙-upgrades, the approved request lands here BEFORE dispatching to
-- Cortana. If the bot crashes mid-dispatch, the row stays pending and
-- the startup replay picks it up. Without this, an approval vaporizes
-- on restart.

CREATE TABLE IF NOT EXISTS upgrade_requests (
  id               BIGSERIAL    PRIMARY KEY,
  requested_by     TEXT,
  issue            TEXT         NOT NULL,
  suggested_fix    TEXT,
  impact           TEXT,
  approved_by      TEXT         NOT NULL,
  approved_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  dispatched_at    TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  source_message_id TEXT
);

-- Fast lookup for startup replay: rows that were approved but never
-- dispatched (bot crashed in the milliseconds between INSERT and dispatch).
CREATE INDEX IF NOT EXISTS idx_upgrade_requests_pending_dispatch
  ON upgrade_requests (approved_at)
  WHERE dispatched_at IS NULL;
