-- Social Auth Migration
-- Adds OAuth provider columns, makes password_hash and phone nullable

-- ─── 1. Add social auth columns to clients ───
ALTER TABLE clients ADD COLUMN auth_provider TEXT;
ALTER TABLE clients ADD COLUMN auth_provider_id TEXT;

-- ─── 2. Make password_hash nullable (social auth users won't have one) ───
ALTER TABLE clients ALTER COLUMN password_hash DROP NOT NULL;

-- ─── 3. Make phone nullable (social auth may not provide phone) ───
ALTER TABLE clients ALTER COLUMN phone DROP NOT NULL;

-- ─── 4. Unique index on provider + provider_id to prevent duplicate social accounts ───
CREATE UNIQUE INDEX idx_clients_auth_provider ON clients (auth_provider, auth_provider_id)
  WHERE auth_provider IS NOT NULL AND auth_provider_id IS NOT NULL;
