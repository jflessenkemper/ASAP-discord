/**
 * Environment variable sandboxing for child processes.
 * Allowlist approach: only known-safe variables are passed through.
 * This prevents secrets (API keys, DB passwords, tokens) from leaking
 * to agent-controlled child processes.
 */

/** Known-safe environment variable names for child processes */
export const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TMP', 'TEMP', 'HOSTNAME', 'PWD', 'LOGNAME',
  'EDITOR', 'VISUAL', 'PAGER', 'COLORTERM', 'FORCE_COLOR',
  'NODE_PATH', 'NODE_OPTIONS',
  'NPM_CONFIG_PREFIX', 'NVM_DIR', 'NVM_BIN',
  'AGENT_REPO_ROOT', 'CI',
]);

/** Prefixes for GCP-related environment variables needed by gcloud CLI */
export const GCP_ENV_PREFIXES = ['GOOGLE_', 'GCLOUD_', 'GCS_', 'CLOUDSDK_', 'CLOUD_RUN_'];

/**
 * Build a sanitized environment for general child processes (npm, git, grep, etc.).
 * Only passes through known-safe keys — strips all secrets.
 */
export function buildSafeCommandEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SAFE_ENV_KEYS.has(k)) env[k] = v;
  }
  env.NODE_ENV = 'development';
  return env;
}

/**
 * Build a sanitized environment for GCP (gcloud) child processes.
 * Extends safe env with GCP-specific variables needed for authentication.
 */
export function buildGcpSafeEnv(): Record<string, string> {
  const env = buildSafeCommandEnv();
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (GCP_ENV_PREFIXES.some(p => k.startsWith(p))) env[k] = v;
  }
  return env;
}
