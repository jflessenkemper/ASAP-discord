/**
 * Generic circuit breaker for external service APIs.
 *
 * States:
 *   CLOSED    — requests pass through normally
 *   OPEN      — service is failing; requests short-circuit immediately
 *   HALF_OPEN — cooldown expired; one probe request allowed through
 *
 * Usage:
 *   const cb = getCircuitBreaker('github');
 *   const result = await cb.call(() => someApiCall());
 *   // throws CircuitOpenError if circuit is open
 */

// ── Circuit State ──────────────────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half_open';

interface CircuitStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  openedAt: number;
  halfOpenProbeInFlight: boolean;
}

export class CircuitOpenError extends Error {
  constructor(public readonly serviceName: string) {
    super(`Circuit breaker OPEN for "${serviceName}" — service is temporarily unavailable. Will retry after cooldown.`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private lastFailureAt = 0;
  private lastSuccessAt = 0;
  private openedAt = 0;
  private halfOpenProbeInFlight = false;

  constructor(
    public readonly name: string,
    private readonly failureThreshold: number = 5,
    private readonly cooldownMs: number = 60_000,
    private readonly windowMs: number = 120_000,
  ) {}

  /**
   * Execute an async function through the circuit breaker.
   * @throws CircuitOpenError if the circuit is open and cooldown hasn't elapsed.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.decayIfStale();

    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half_open';
      } else {
        throw new CircuitOpenError(this.name);
      }
    }

    if (this.state === 'half_open') {
      if (this.halfOpenProbeInFlight) {
        // Another probe is already testing the service — short-circuit
        throw new CircuitOpenError(this.name);
      }
      this.halfOpenProbeInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** Check whether a call would be allowed (without actually executing). */
  isAvailable(): boolean {
    this.decayIfStale();
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      return Date.now() - this.openedAt >= this.cooldownMs;
    }
    // half_open — only available if no probe in flight
    return !this.halfOpenProbeInFlight;
  }

  /** Force the circuit back to closed (e.g., manual reset). */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.halfOpenProbeInFlight = false;
  }

  /** Record a successful call (for callers that manage execution externally). */
  recordSuccess(): void {
    this.onSuccess();
  }

  /** Record a failed call (for callers that manage execution externally). */
  recordFailure(): void {
    this.onFailure();
  }

  /** Get current stats for diagnostics. */
  getStats(): CircuitStats {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      openedAt: this.openedAt,
      halfOpenProbeInFlight: this.halfOpenProbeInFlight,
    };
  }

  private onSuccess(): void {
    this.successes++;
    this.lastSuccessAt = Date.now();
    this.halfOpenProbeInFlight = false;

    if (this.state === 'half_open') {
      // Probe succeeded — service recovered
      this.state = 'closed';
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureAt = Date.now();
    this.halfOpenProbeInFlight = false;

    if (this.state === 'half_open') {
      // Probe failed — re-open
      this.state = 'open';
      this.openedAt = Date.now();
      return;
    }

    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      console.warn(`[circuit-breaker] ${this.name}: OPEN after ${this.failures} failures. Cooldown ${this.cooldownMs / 1000}s.`);
    }
  }

  /** Decay failure count if no events within the window. */
  private decayIfStale(): void {
    const lastEvent = Math.max(this.lastFailureAt, this.lastSuccessAt);
    if (lastEvent > 0 && Date.now() - lastEvent > this.windowMs) {
      this.failures = Math.floor(this.failures / 2);
      this.successes = Math.floor(this.successes / 2);
      if (this.state === 'open' && this.failures < this.failureThreshold) {
        this.state = 'closed';
      }
    }
  }
}

// ── Service Registry ───────────────────────────────────────────────

/** Map of tool name → service name for circuit breaker grouping. */
const TOOL_SERVICE_MAP: Record<string, string> = {
  // GitHub
  git_create_branch: 'github',
  create_pull_request: 'github',
  merge_pull_request: 'github',
  add_pr_comment: 'github',
  list_pull_requests: 'github',
  github_search: 'github',
  // GCP
  gcp_preflight: 'gcp',
  gcp_build_image: 'gcp',
  gcp_deploy: 'gcp',
  gcp_set_env: 'gcp',
  gcp_get_env: 'gcp',
  gcp_list_revisions: 'gcp',
  gcp_rollback: 'gcp',
  gcp_secret_set: 'gcp',
  gcp_secret_bind: 'gcp',
  gcp_secret_list: 'gcp',
  gcp_build_status: 'gcp',
  gcp_logs_query: 'gcp',
  gcp_run_describe: 'gcp',
  gcp_storage_ls: 'gcp',
  gcp_artifact_list: 'gcp',
  gcp_sql_describe: 'gcp',
  gcp_vm_ssh: 'gcp',
  gcp_project_info: 'gcp',
  // Fetch
  fetch_url: 'fetch',
  // Screenshots
  capture_screenshots: 'screenshots',
  // Job search (external APIs)
  job_scan: 'job_search',
};

const breakers = new Map<string, CircuitBreaker>();

/** Get or create a circuit breaker for a service. */
function getOrCreateBreaker(service: string): CircuitBreaker {
  let breaker = breakers.get(service);
  if (!breaker) {
    breaker = new CircuitBreaker(service);
    breakers.set(service, breaker);
  }
  return breaker;
}

/**
 * Get the circuit breaker for a given tool name (if one is mapped).
 * Returns undefined for tools that don't need circuit breaking (local ops, etc.).
 */
export function getCircuitBreakerForTool(toolName: string): CircuitBreaker | undefined {
  const service = TOOL_SERVICE_MAP[toolName];
  if (!service) return undefined;
  return getOrCreateBreaker(service);
}

/**
 * Get a named circuit breaker directly (for non-tool callers).
 */
export function getCircuitBreaker(serviceName: string): CircuitBreaker {
  return getOrCreateBreaker(serviceName);
}

/**
 * Get stats for all active circuit breakers (for diagnostics/metrics).
 */
export function getAllCircuitBreakerStats(): CircuitStats[] {
  return Array.from(breakers.values()).map((b) => b.getStats());
}
