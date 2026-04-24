-- 020: Remove legacy marketplace/app schema no longer used by the Discord bot
-- Keeps bot runtime tables, telemetry, and career-ops job search tables.

DROP TABLE IF EXISTS quotes CASCADE;
DROP TABLE IF EXISTS quote_requests CASCADE;
DROP TABLE IF EXISTS businesses CASCADE;
DROP TABLE IF EXISTS employee_availability CASCADE;
DROP TABLE IF EXISTS saved_businesses CASCADE;
DROP TABLE IF EXISTS saved_items CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS reviews CASCADE;
DROP TABLE IF EXISTS price_searches CASCADE;
DROP TABLE IF EXISTS fuel_searches CASCADE;
DROP TABLE IF EXISTS auth_events CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS two_factor_codes CASCADE;
DROP TABLE IF EXISTS job_photos CASCADE;
DROP TABLE IF EXISTS job_timeline CASCADE;
DROP TABLE IF EXISTS jobs CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
DROP TABLE IF EXISTS clients CASCADE;
DROP TABLE IF EXISTS problem_types CASCADE;

DROP TYPE IF EXISTS notification_type CASCADE;
DROP TYPE IF EXISTS gender_type CASCADE;
DROP TYPE IF EXISTS timeline_event_type CASCADE;
DROP TYPE IF EXISTS job_status CASCADE;
DROP TYPE IF EXISTS user_type CASCADE;
