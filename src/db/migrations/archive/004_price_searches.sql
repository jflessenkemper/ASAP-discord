-- Price searches table: stores Gemini-grounded product search results linked to clients
CREATE TABLE IF NOT EXISTS price_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  results JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_searches_client_id ON price_searches(client_id);
CREATE INDEX IF NOT EXISTS idx_price_searches_created_at ON price_searches(created_at DESC);
