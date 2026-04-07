-- ASAP Tech Support — Initial Schema
-- Run against PostgreSQL (Cloud SQL)

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enum types
CREATE TYPE job_status AS ENUM (
  'pending', 'assigned', 'in_progress', 'paused', 'completed', 'cancelled'
);

CREATE TYPE timeline_event_type AS ENUM (
  'created', 'assigned', 'started', 'paused', 'resumed', 'note', 'photo', 'completed'
);

CREATE TYPE user_type AS ENUM ('client', 'employee');

-- Problem types (reference table)
CREATE TABLE problem_types (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

-- Clients
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  first_job_used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Employees
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rate_per_minute NUMERIC(10,2) NOT NULL DEFAULT 5.00,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Jobs
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  employee_id UUID REFERENCES employees(id),
  problem_type TEXT NOT NULL,
  description TEXT NOT NULL,
  status job_status NOT NULL DEFAULT 'pending',
  rate_per_minute NUMERIC(10,2) NOT NULL DEFAULT 5.00,
  total_seconds INTEGER NOT NULL DEFAULT 0,
  total_cost NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  is_free BOOLEAN NOT NULL DEFAULT FALSE,
  callout_free BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Job timeline
CREATE TABLE job_timeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type timeline_event_type NOT NULL,
  description TEXT NOT NULL,
  evidence_url TEXT,
  created_by_type user_type NOT NULL,
  created_by_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Two-factor codes
CREATE TABLE two_factor_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id),
  code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  user_type user_type NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_jobs_client_id ON jobs(client_id);
CREATE INDEX idx_jobs_employee_id ON jobs(employee_id);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_job_timeline_job_id ON job_timeline(job_id);
CREATE INDEX idx_two_factor_codes_employee_id ON two_factor_codes(employee_id);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  user_type user_type NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id, user_type);
