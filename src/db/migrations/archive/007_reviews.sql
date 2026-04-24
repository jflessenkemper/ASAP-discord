-- 007: Reviews — client reviews of employees after job completion
-- Essential for marketplace trust; currently no review system exists

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id)  -- one review per job
);

CREATE INDEX IF NOT EXISTS idx_reviews_employee_id ON reviews(employee_id);
CREATE INDEX IF NOT EXISTS idx_reviews_client_id ON reviews(client_id);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(employee_id, rating);

-- Add average rating cache column to employees for fast lookups
ALTER TABLE employees ADD COLUMN IF NOT EXISTS avg_rating DECIMAL(3, 2) DEFAULT 0.00;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS total_reviews INTEGER DEFAULT 0;
