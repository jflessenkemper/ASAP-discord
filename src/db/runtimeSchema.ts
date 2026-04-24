export const TABLE_EXPECTATIONS_BY_MIGRATION: Record<string, string[]> = {
  // The squashed baseline replaces legacy 001–020; it creates agent_memory
  // and agent_activity_log directly. Legacy filename entries are kept so
  // prod DBs (which have 003/015 in applied_migrations) still drift-check.
  '000_baseline.sql': ['agent_memory', 'agent_activity_log'],
  '003_agent_memory.sql': ['agent_memory'],
  '015_agent_activity_log.sql': ['agent_activity_log'],
  '021_self_improvement_jobs.sql': ['self_improvement_jobs'],
  '022_agent_learnings.sql': ['agent_learnings'],
  '023_user_events.sql': ['user_events'],
  '024_decisions.sql': ['decisions'],
  '026_upgrade_requests.sql': ['upgrade_requests'],
};

export const REQUIRED_RUNTIME_TABLES = ['agent_memory', 'agent_activity_log', 'self_improvement_jobs', 'agent_learnings', 'user_events', 'decisions'];

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