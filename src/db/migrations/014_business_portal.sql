-- 014: Business Portal — businesses, quote_requests, quotes tables

-- ─── 0. Extend user_type enum to include 'business' ───
ALTER TYPE user_type ADD VALUE IF NOT EXISTS 'business';

-- ─── 1. Businesses table ───
CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT '',
  abn TEXT DEFAULT '',
  address TEXT DEFAULT '',
  latitude DECIMAL(10, 7),
  longitude DECIMAL(10, 7),
  service_categories TEXT[] DEFAULT '{}',
  password_hash TEXT NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  access_code TEXT NOT NULL UNIQUE,
  place_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_businesses_email ON businesses(email);
CREATE INDEX IF NOT EXISTS idx_businesses_access_code ON businesses(access_code);
CREATE INDEX IF NOT EXISTS idx_businesses_place_id ON businesses(place_id);
CREATE INDEX IF NOT EXISTS idx_businesses_location ON businesses(latitude, longitude);

-- ─── 2. Quote requests table ───
CREATE TABLE IF NOT EXISTS quote_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'quoted', 'accepted', 'declined', 'expired')),
  client_name TEXT DEFAULT '',
  client_email TEXT DEFAULT '',
  client_phone TEXT DEFAULT '',
  client_lat DECIMAL(10, 7),
  client_lng DECIMAL(10, 7),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

CREATE INDEX IF NOT EXISTS idx_quote_requests_business_id ON quote_requests(business_id);
CREATE INDEX IF NOT EXISTS idx_quote_requests_client_id ON quote_requests(client_id);
CREATE INDEX IF NOT EXISTS idx_quote_requests_status ON quote_requests(status);

-- ─── 3. Quotes table ───
CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  price DECIMAL(10, 2) NOT NULL,
  estimated_hours DECIMAL(5, 1),
  notes TEXT DEFAULT '',
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quotes_request_id ON quotes(request_id);
CREATE INDEX IF NOT EXISTS idx_quotes_business_id ON quotes(business_id);
