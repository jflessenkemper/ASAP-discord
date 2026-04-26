/**
 * Tiny helpers for reading env vars with legacy-name fallbacks.
 *
 * Used during the Cortana → Cortana migration: preferred CORTANA_* vars take
 * precedence; the CORTANA_* names still work so existing deploys don't break.
 */

/** Return the first defined env var from the list, else the default. */
export function envFirst(names: readonly string[], defaultValue: string): string {
  for (const name of names) {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
  }
  return defaultValue;
}

export function envIntFirst(names: readonly string[], defaultValue: number): number {
  const raw = envFirst(names, '');
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

export function envBoolFirst(names: readonly string[]): boolean {
  const raw = envFirst(names, '').toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}
