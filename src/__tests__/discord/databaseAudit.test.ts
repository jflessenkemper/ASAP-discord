import { buildDatabaseAuditSummary } from '../../discord/databaseAudit';

describe('databaseAudit', () => {
  it('reports info when runtime tables are present and legacy schema is gone', () => {
    const summary = buildDatabaseAuditSummary({
      appliedMigrationCount: 20,
      requiredRuntimeTableCount: 2,
      runtimeTables: ['agent_memory', 'agent_activity_log'],
      missingRuntimeTables: [],
      legacyTables: [],
      dropApplied: true,
    });

    expect(summary).toEqual({
      severity: 'info',
      action: 'none',
      metric: 'migrations=20',
      delta: 'runtime=2/2 | legacy=0 | drop=applied',
    });
  });

  it('reports warn when legacy tables remain but drop migration is still pending', () => {
    const summary = buildDatabaseAuditSummary({
      appliedMigrationCount: 19,
      requiredRuntimeTableCount: 2,
      runtimeTables: ['agent_memory', 'agent_activity_log'],
      missingRuntimeTables: [],
      legacyTables: ['clients', 'employees', 'jobs'],
      dropApplied: false,
    });

    expect(summary.severity).toBe('warn');
    expect(summary.action).toBe('review legacy-drop migration status');
    expect(summary.delta).toContain('runtime=2/2');
    expect(summary.delta).toContain('legacy=3');
    expect(summary.delta).toContain('drop=pending');
    expect(summary.delta).toContain('legacy_tables=clients,employees,jobs');
  });

  it('reports error when a required runtime table is missing', () => {
    const summary = buildDatabaseAuditSummary({
      appliedMigrationCount: 20,
      requiredRuntimeTableCount: 2,
      runtimeTables: ['agent_memory'],
      missingRuntimeTables: ['agent_activity_log'],
      legacyTables: [],
      dropApplied: true,
    });

    expect(summary.severity).toBe('error');
    expect(summary.action).toBe('none');
    expect(summary.delta).toContain('runtime=1/2');
    expect(summary.delta).toContain('missing=agent_activity_log');
  });

  it('truncates long legacy table lists in the summary', () => {
    const summary = buildDatabaseAuditSummary({
      appliedMigrationCount: 20,
      requiredRuntimeTableCount: 2,
      runtimeTables: ['agent_memory', 'agent_activity_log'],
      missingRuntimeTables: [],
      legacyTables: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      dropApplied: true,
    });

    expect(summary.delta).toContain('legacy_tables=a,b,c,d,e,f,...');
    expect(summary.severity).toBe('error');
  });
});