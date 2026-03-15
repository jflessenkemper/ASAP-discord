-- ASAP Redesign Migration
-- Removes problem types, adds new client/employee/job fields, job_photos table

-- ─── 1. Create gender enum ───
CREATE TYPE gender_type AS ENUM ('male', 'female', 'other', 'prefer_not_to_say');

-- ─── 2. Alter clients table ───
ALTER TABLE clients ADD COLUMN first_name TEXT;
ALTER TABLE clients ADD COLUMN last_name TEXT;
ALTER TABLE clients ADD COLUMN gender gender_type;
ALTER TABLE clients ADD COLUMN date_of_birth DATE;
ALTER TABLE clients ADD COLUMN latitude DECIMAL(10, 7);
ALTER TABLE clients ADD COLUMN longitude DECIMAL(10, 7);
ALTER TABLE clients ADD COLUMN last_location_update TIMESTAMPTZ;

-- Migrate existing full_name data to first_name/last_name
UPDATE clients SET
  first_name = split_part(full_name, ' ', 1),
  last_name = CASE
    WHEN position(' ' IN full_name) > 0
    THEN substring(full_name FROM position(' ' IN full_name) + 1)
    ELSE ''
  END
WHERE full_name IS NOT NULL;

-- Now make first_name NOT NULL (last_name can be empty)
ALTER TABLE clients ALTER COLUMN first_name SET NOT NULL;
ALTER TABLE clients ALTER COLUMN last_name SET NOT NULL;
ALTER TABLE clients ALTER COLUMN last_name SET DEFAULT '';

-- Drop full_name (no longer needed)
ALTER TABLE clients DROP COLUMN full_name;

-- ─── 3. Alter employees table ───
ALTER TABLE employees ADD COLUMN latitude DECIMAL(10, 7);
ALTER TABLE employees ADD COLUMN longitude DECIMAL(10, 7);
ALTER TABLE employees ADD COLUMN last_location_update TIMESTAMPTZ;
ALTER TABLE employees ADD COLUMN profile_picture_url TEXT;
ALTER TABLE employees ADD COLUMN banner_url TEXT;
ALTER TABLE employees ADD COLUMN bio TEXT DEFAULT '';
ALTER TABLE employees ADD COLUMN total_minutes INTEGER NOT NULL DEFAULT 0;

-- ─── 4. Alter jobs table ───
-- jobs already has description TEXT, drop problem_type
ALTER TABLE jobs DROP COLUMN IF EXISTS problem_type;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS difficulty_rating INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS estimated_duration_minutes INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fuel_cost DECIMAL(10, 2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fuel_distance_km DECIMAL(10, 2);

-- ─── 5. Create job_photos table ───
CREATE TABLE IF NOT EXISTS job_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  photo_url TEXT NOT NULL,
  caption TEXT DEFAULT '',
  uploaded_by UUID NOT NULL,
  uploaded_by_type user_type NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_photos_job_id ON job_photos(job_id);

-- ─── 6. Drop problem_types table ───
DROP TABLE IF EXISTS problem_types;

-- ─── 7. Indexes for location queries ───
CREATE INDEX IF NOT EXISTS idx_clients_location ON clients(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_employees_location ON employees(latitude, longitude);
