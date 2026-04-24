-- 006: Fuel search history — tracks fuel lookups for the Track tab and analytics
-- Currently the Fuel tab fetches live NSW FuelCheck data but nothing is persisted

CREATE TABLE IF NOT EXISTS fuel_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  latitude DECIMAL(10, 7) NOT NULL,
  longitude DECIMAL(10, 7) NOT NULL,
  radius_km DECIMAL(5, 1) NOT NULL DEFAULT 15.0,
  results JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fuel_searches_client_id ON fuel_searches(client_id);
CREATE INDEX IF NOT EXISTS idx_fuel_searches_created_at ON fuel_searches(created_at DESC);
