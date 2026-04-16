export type DatabaseAuditSeverity = 'info' | 'warn' | 'error';

export interface DatabaseAuditSnapshot {
  appliedMigrationCount: number;
  requiredRuntimeTableCount: number;
  runtimeTables: string[];
  missingRuntimeTables: string[];
  legacyTables: string[];
  dropApplied: boolean;
}

export interface DatabaseAuditSummary {
  severity: DatabaseAuditSeverity;
  action: string;
  metric: string;
  delta: string;
}

export function buildDatabaseAuditSummary(snapshot: DatabaseAuditSnapshot): DatabaseAuditSummary {
  const { appliedMigrationCount, requiredRuntimeTableCount, runtimeTables, missingRuntimeTables, legacyTables, dropApplied } = snapshot;

  const severity: DatabaseAuditSeverity = missingRuntimeTables.length > 0 || (dropApplied && legacyTables.length > 0)
    ? 'error'
    : legacyTables.length > 0
      ? 'warn'
      : 'info';

  const deltaParts = [
    `runtime=${runtimeTables.length}/${requiredRuntimeTableCount}`,
    `legacy=${legacyTables.length}`,
    `drop=${dropApplied ? 'applied' : 'pending'}`,
  ];
  if (missingRuntimeTables.length > 0) {
    deltaParts.push(`missing=${missingRuntimeTables.join(',')}`);
  }
  if (legacyTables.length > 0) {
    deltaParts.push(`legacy_tables=${legacyTables.slice(0, 6).join(',')}${legacyTables.length > 6 ? ',...' : ''}`);
  }

  return {
    severity,
    action: severity === 'warn' ? 'review legacy-drop migration status' : 'none',
    metric: `migrations=${appliedMigrationCount}`,
    delta: deltaParts.join(' | '),
  };
}