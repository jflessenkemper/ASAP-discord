-- 011: Auth events — audit trail for login, logout, and failed attempts
-- Currently no logging of auth events; important for security monitoring

CREATE TABLE IF NOT EXISTS auth_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,  -- nullable for failed attempts against unknown users
  user_type user_type,
  event TEXT NOT NULL,  -- 'login', 'logout', 'login_failed', '2fa_sent', '2fa_verified', '2fa_failed'
  provider TEXT,  -- 'google', 'apple', 'facebook', 'password', null
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events(user_id, user_type);
CREATE INDEX IF NOT EXISTS idx_auth_events_created_at ON auth_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_event ON auth_events(event);
