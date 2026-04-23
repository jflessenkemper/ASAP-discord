-- 023: Unified user_events table — every text, voice, image, reaction, and button
-- the user produces in Discord lands here in one shape so Riley can recall it.
--
-- kind values:
--   'text'        — plain message
--   'voice'       — transcribed voice note / voice session utterance
--   'image'       — uploaded image or screenshot (text = vision caption + OCR)
--   'reaction'    — emoji reaction to a message
--   'button'      — button click on a Riley-posted component
--   'edit'        — user edited a prior message
--   'decision'    — user resolved a decision card (resolution stored in metadata)
--
-- Embeddings are populated asynchronously by the embedding worker, so inserts
-- stay fast on the hot path. NULL embedding = "not yet embedded".

CREATE TABLE IF NOT EXISTS user_events (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT        NOT NULL,
  channel_id    TEXT        NOT NULL,
  thread_id     TEXT,
  message_id    TEXT,
  kind          TEXT        NOT NULL,
  text          TEXT,
  attachment_ref TEXT,
  metadata      JSONB       DEFAULT '{}'::jsonb,
  embedding     vector(768),
  embedded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_events_user_time
  ON user_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_events_channel_time
  ON user_events (channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_events_thread_time
  ON user_events (thread_id, created_at DESC)
  WHERE thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_events_kind
  ON user_events (kind, created_at DESC);

-- Partial index so the embedding worker can cheaply find rows that still need embedding.
CREATE INDEX IF NOT EXISTS idx_user_events_pending_embedding
  ON user_events (id) WHERE embedding IS NULL AND text IS NOT NULL;

-- HNSW index for semantic recall. Guarded in case pgvector extension is missing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_user_events_hnsw
             ON user_events USING hnsw (embedding vector_cosine_ops)
             WITH (m = 16, ef_construction = 64)';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not create HNSW index on user_events — falling back to sequential scan';
END $$;
