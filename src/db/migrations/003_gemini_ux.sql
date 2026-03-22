-- Gemini UX Redesign Migration
-- Adds business metadata to jobs and phone to clients

-- ─── 1. Jobs: business metadata for marketplace bookings ───
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS business_name TEXT DEFAULT NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS business_place_id TEXT DEFAULT NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS business_address TEXT DEFAULT NULL;

-- ─── 2. Clients: phone field ───
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '';
