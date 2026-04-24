-- 013: Missing indexes for query patterns, orphan table cleanup, auth_events retention
-- Addresses DBA audit findings: earnings query performance, unbounded auth_events, dead table

-- ─── 1. Composite index for earnings queries ───
-- Earnings endpoint filters on (employee_id, status='completed', completed_at >= date).
-- Current idx_jobs_employee_status only covers (employee_id, status), so completed_at
-- range scans must scan all completed jobs per employee. This index covers the full predicate.
CREATE INDEX IF NOT EXISTS idx_jobs_employee_completed
  ON jobs(employee_id, status, completed_at DESC)
  WHERE status = 'completed';

-- ─── 2. Auth events retention ───
-- auth_events grows unbounded (no cleanup). Add a composite index for efficient
-- pruning and add the table to the hourly cleanup job (code change).
-- Note: idx_auth_events_created_at already exists from 011 but is not partial.
-- We add nothing new here — the existing index is sufficient for DELETE WHERE created_at < X.

-- ─── 3. Drop orphan table: saved_businesses ───
-- Migration 012 introduced saved_items with JSONB approach, explicitly replacing
-- saved_businesses. No route code references saved_businesses. Safe to drop.
DROP TABLE IF EXISTS saved_businesses;

-- ─── 4. Index on two_factor_codes for the compound lookup in verify-2fa ───
-- The verify query: WHERE employee_id = $1 AND code = $2 AND used = FALSE AND expires_at > NOW()
-- Current idx_2fa_employee_id only covers employee_id. Adding (employee_id, used, expires_at)
-- lets the planner skip used/expired codes without fetching rows.
CREATE INDEX IF NOT EXISTS idx_2fa_lookup
  ON two_factor_codes(employee_id, used, expires_at DESC)
  WHERE used = FALSE;
