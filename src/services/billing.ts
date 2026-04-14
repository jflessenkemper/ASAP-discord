import { GoogleAuth } from 'google-auth-library';
import { errMsg } from '../utils/errors';

const PROJECT_ID =
  process.env.GCP_BILLING_MONITORING_PROJECT_ID ||
  process.env.GCS_PROJECT_ID ||
  'asap-489910';

const COST_METRIC_TYPE =
  process.env.GCP_BILLING_COST_METRIC_TYPE ||
  'billing.googleapis.com/billing/account/cost';

const CACHE_TTL_MS = parseInt(process.env.GCP_BILLING_CACHE_MS || '300000', 10);

interface LiveBillingCache {
  dailyCostUsd: number | null;
  monthCostUsd: number | null;
  currency: string;
  source: string;
  updatedAtIso: string | null;
  error: string | null;
  lastFetchMs: number;
}

const billingCache: LiveBillingCache = {
  dailyCostUsd: null,
  monthCostUsd: null,
  currency: 'USD',
  source: 'cloud-monitoring',
  updatedAtIso: null,
  error: null,
  lastFetchMs: 0,
};

let auth: GoogleAuth | null = null;

function normalizeBillingError(err: unknown): string {
  const raw = errMsg(err);
  const lower = raw.toLowerCase();
  if (lower.includes('cannot find metric') || lower.includes('metric(s) that match type')) {
    return 'Cloud Monitoring billing metric is not available in this project yet.';
  }
  if (lower.includes('permission') || lower.includes('denied')) {
    return 'Missing permission to read Cloud Monitoring billing metrics.';
  }
  return 'Live billing lookup failed; using estimated spend.';
}

function getAuth(): GoogleAuth {
  if (!auth) {
    auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/monitoring.read' });
  }
  return auth;
}

function utcStartOfDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

function utcStartOfMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

function parsePointValue(point: any): number {
  const value = point?.value;
  if (!value) return 0;
  if (typeof value.doubleValue === 'number') return value.doubleValue;
  if (typeof value.int64Value === 'string') return parseFloat(value.int64Value) || 0;
  if (typeof value.int64Value === 'number') return value.int64Value;
  return 0;
}

async function queryCostSum(start: Date, end: Date): Promise<{ total: number; currency: string }> {
  const client = await getAuth().getClient();
  const res = await client.request({
    url: `https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/timeSeries`,
    method: 'GET',
    params: {
      filter: `metric.type="${COST_METRIC_TYPE}"`,
      'interval.startTime': start.toISOString(),
      'interval.endTime': end.toISOString(),
      'aggregation.alignmentPeriod': `${Math.max(60, Math.floor((end.getTime() - start.getTime()) / 1000))}s`,
      'aggregation.perSeriesAligner': 'ALIGN_SUM',
      'aggregation.crossSeriesReducer': 'REDUCE_SUM',
      view: 'FULL',
      pageSize: 100,
    },
  });

  const data = res.data as any;
  const series = Array.isArray(data?.timeSeries) ? data.timeSeries : [];

  let total = 0;
  let currency = 'USD';

  for (const ts of series) {
    const points = Array.isArray(ts?.points) ? ts.points : [];
    for (const p of points) {
      total += parsePointValue(p);
    }
    const metricCurrency = ts?.metric?.labels?.currency;
    if (typeof metricCurrency === 'string' && metricCurrency.trim()) {
      currency = metricCurrency;
    }
  }

  return { total, currency };
}

export function getLiveBillingSnapshot(): {
  available: boolean;
  dailyCostUsd: number | null;
  monthCostUsd: number | null;
  currency: string;
  source: string;
  updatedAtIso: string | null;
  error: string | null;
} {
  return {
    available: billingCache.dailyCostUsd !== null,
    dailyCostUsd: billingCache.dailyCostUsd,
    monthCostUsd: billingCache.monthCostUsd,
    currency: billingCache.currency,
    source: billingCache.source,
    updatedAtIso: billingCache.updatedAtIso,
    error: billingCache.error,
  };
}

export async function refreshLiveBillingSnapshot(force = false): Promise<void> {
  if (!PROJECT_ID) {
    billingCache.error = 'GCP project not configured for billing metrics';
    return;
  }

  const now = Date.now();
  if (!force && now - billingCache.lastFetchMs < CACHE_TTL_MS) {
    return;
  }

  billingCache.lastFetchMs = now;

  try {
    const end = new Date();
    const [daily, monthly] = await Promise.all([
      queryCostSum(utcStartOfDay(end), end),
      queryCostSum(utcStartOfMonth(end), end),
    ]);

    billingCache.dailyCostUsd = daily.total;
    billingCache.monthCostUsd = monthly.total;
    billingCache.currency = daily.currency || monthly.currency || 'USD';
    billingCache.updatedAtIso = new Date().toISOString();
    billingCache.error = null;
  } catch (err) {
    billingCache.error = normalizeBillingError(err);
  }
}
