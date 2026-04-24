-- 005: Session cleanup, expired data pruning, and missing indexes
-- Fixes: sessions/2FA codes accumulate forever, missing query-pattern indexes

-- ─── 1. Indexes for session lookups (requireAuth hits sessions.token) ───
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, user_type);

-- ─── 2. Indexes for 2FA code lookups ───
CREATE INDEX IF NOT EXISTS idx_2fa_employee_id ON two_factor_codes(employee_id);
CREATE INDEX IF NOT EXISTS idx_2fa_expires_at ON two_factor_codes(expires_at);

-- ─── 3. Indexes for job timeline and job query patterns ───
CREATE INDEX IF NOT EXISTS idx_job_timeline_job_id ON job_timeline(job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_completed_at ON jobs(completed_at);
CREATE INDEX IF NOT EXISTS idx_jobs_employee_status ON jobs(employee_id, status);

-- ─── 4. Delete expired sessions ───
DELETE FROM sessions WHERE expires_at < NOW();

-- ─── 5. Delete expired and used 2FA codes (older than 24h) ───
DELETE FROM two_factor_codes WHERE expires_at < NOW() - INTERVAL '24 hours';
