-- Migration to add location consent tracking for APP 5 compliance.

-- Add consent timestamp and policy version to the clients table
ALTER TABLE clients ADD COLUMN IF NOT EXISTS location_consent_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS privacy_policy_version TEXT;

-- Add consent timestamp and policy version to the employees table
ALTER TABLE employees ADD COLUMN IF NOT EXISTS location_consent_at TIMESTAMPTZ;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS privacy_policy_version TEXT;
