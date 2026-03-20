-- 009: Saved businesses — let clients bookmark businesses from job search results
-- Currently find-businesses results are ephemeral (not stored)

CREATE TABLE IF NOT EXISTS saved_businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  latitude DECIMAL(10, 7),
  longitude DECIMAL(10, 7),
  rating DECIMAL(2, 1),
  icon TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, place_id)  -- one bookmark per business per client
);

CREATE INDEX IF NOT EXISTS idx_saved_businesses_client_id ON saved_businesses(client_id);
