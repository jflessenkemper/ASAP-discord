-- ASAP Migration 003: Add missing tables and columns for social auth, search history, auth events, saved items
-- Fixes BUG-2: These tables/columns are referenced in the codebase but were never created

-- ─── 1. Add social auth columns to clients ───
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auth_provider TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auth_provider_id TEXT;

-- Make password_hash nullable (social/email-signup users don't have one)
ALTER TABLE clients ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE clients ALTER COLUMN password_hash SET DEFAULT NULL;

-- ─── 2. Create auth_events table ───
CREATE TABLE IF NOT EXISTS auth_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  user_type user_type,
  event TEXT NOT NULL,
  provider TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_events_user_id ON auth_events(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_events_created_at ON auth_events(created_at);

-- ─── 3. Create fuel_searches table ───
CREATE TABLE IF NOT EXISTS fuel_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  latitude DECIMAL(10, 7) NOT NULL,
  longitude DECIMAL(10, 7) NOT NULL,
  radius_km INTEGER NOT NULL DEFAULT 15,
  results JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fuel_searches_client_id ON fuel_searches(client_id);
CREATE INDEX IF NOT EXISTS idx_fuel_searches_created_at ON fuel_searches(created_at);

-- ─── 4. Create price_searches table ───
CREATE TABLE IF NOT EXISTS price_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  results JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_searches_client_id ON price_searches(client_id);
CREATE INDEX IF NOT EXISTS idx_price_searches_created_at ON price_searches(created_at);

-- ─── 5. Create saved_items table ───
CREATE TABLE IF NOT EXISTS saved_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  item_data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_items_client_id ON saved_items(client_id);

-- ─── 6. Index for social auth lookups ───
CREATE INDEX IF NOT EXISTS idx_clients_auth_provider ON clients(auth_provider, auth_provider_id);
