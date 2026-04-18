export const TABLE_EXPECTATIONS_BY_MIGRATION: Record<string, string[]> = {
  '003_agent_memory.sql': ['agent_memory'],
  '015_agent_activity_log.sql': ['agent_activity_log'],
  '021_self_improvement_jobs.sql': ['self_improvement_jobs'],
};

export const REQUIRED_RUNTIME_TABLES = ['agent_memory', 'agent_activity_log', 'self_improvement_jobs'];

export const LEGACY_APP_TABLES = [
  'quotes',
  'quote_requests',
  'businesses',
  'employee_availability',
  'saved_businesses',
  'saved_items',
  'notifications',
  'reviews',
  'price_searches',
  'fuel_searches',
  'auth_events',
  'sessions',
  'two_factor_codes',
  'job_photos',
  'job_timeline',
  'jobs',
  'employees',
  'clients',
  'problem_types',
];

export const LEGACY_DROP_MIGRATION = '020_drop_legacy_app_schema.sql';