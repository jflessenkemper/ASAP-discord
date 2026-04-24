-- Job search tables for Riley career-ops integration

CREATE TABLE IF NOT EXISTS job_profile (
  id            SERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL DEFAULT 'owner',
  cv_text       TEXT,                          -- markdown CV
  target_roles  TEXT[] DEFAULT '{}',           -- e.g. '{software engineer,full stack developer}'
  keywords_pos  TEXT[] DEFAULT '{}',           -- positive title keywords
  keywords_neg  TEXT[] DEFAULT '{}',           -- negative title keywords
  salary_min    INTEGER,                       -- AUD annual
  salary_max    INTEGER,
  location      TEXT DEFAULT 'New South Wales',
  remote_ok     BOOLEAN DEFAULT TRUE,
  deal_breakers TEXT,                          -- freeform notes
  preferences   TEXT,                          -- freeform notes
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS job_portals (
  id            SERIAL PRIMARY KEY,
  company_name  TEXT NOT NULL,
  careers_url   TEXT NOT NULL,
  api_type      TEXT,                          -- 'greenhouse', 'ashby', 'lever', or NULL
  api_url       TEXT,                          -- resolved API endpoint
  enabled       BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_name)
);

CREATE TABLE IF NOT EXISTS job_listings (
  id            SERIAL PRIMARY KEY,
  source        TEXT NOT NULL,                 -- 'adzuna', 'greenhouse', 'ashby', 'lever'
  external_id   TEXT,                          -- source-specific ID
  title         TEXT NOT NULL,
  company       TEXT NOT NULL,
  location      TEXT,
  salary_min    INTEGER,
  salary_max    INTEGER,
  url           TEXT NOT NULL,
  description   TEXT,                          -- snippet or full JD
  score         NUMERIC(2,1),                  -- 1.0-5.0 evaluation score
  evaluation    TEXT,                          -- freeform evaluation summary
  status        TEXT DEFAULT 'scanned',        -- scanned|evaluated|approved|rejected|applied|interview|offer|discarded
  discord_msg_id TEXT,                         -- message ID for reaction tracking
  scanned_at    TIMESTAMPTZ DEFAULT NOW(),
  evaluated_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (url)
);

CREATE TABLE IF NOT EXISTS job_scan_history (
  id            SERIAL PRIMARY KEY,
  url           TEXT NOT NULL,
  source        TEXT NOT NULL,
  company       TEXT,
  title         TEXT,
  first_seen    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (url)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_job_listings_status ON job_listings (status);
CREATE INDEX IF NOT EXISTS idx_job_listings_score ON job_listings (score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_job_scan_history_url ON job_scan_history (url);
