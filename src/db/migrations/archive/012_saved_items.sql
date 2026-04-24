-- 012: Generic saved items — let clients bookmark fuel cards, shop products, and businesses
-- Replaces the business-only saved_businesses table with a flexible JSONB approach

CREATE TABLE IF NOT EXISTS saved_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('fuel', 'shop', 'business')),
  item_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_items_client_id ON saved_items(client_id);
CREATE INDEX IF NOT EXISTS idx_saved_items_type ON saved_items(client_id, item_type);
