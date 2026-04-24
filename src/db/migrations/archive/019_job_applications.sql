-- 019 — Add application draft & submission fields
-- Adds cover_letter + resume_text to job_listings for drafted applications.
-- Adds board_api_key to job_portals for Greenhouse submission.
-- Adds contact details to job_profile for ATS submissions.

ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS cover_letter TEXT;
ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS resume_text TEXT;

ALTER TABLE job_portals ADD COLUMN IF NOT EXISTS board_api_key TEXT;

ALTER TABLE job_profile ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE job_profile ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE job_profile ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE job_profile ADD COLUMN IF NOT EXISTS phone TEXT;
