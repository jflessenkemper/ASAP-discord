#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const ANTHROPIC_VERSION = '2023-06-01';
const ADMIN_API_KEY = process.env.ANTHROPIC_ADMIN_API_KEY || '';
const API_BASE = 'https://api.anthropic.com';
const SNAPSHOT_DIR = path.resolve(process.cwd(), 'reports', 'anthropic-usage');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function isoNow() {
  return new Date().toISOString();
}

function utcDayStartIso(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0)).toISOString();
}

function ensureAdminKey() {
  if (!ADMIN_API_KEY) {
    fail('ANTHROPIC_ADMIN_API_KEY is required. Anthropic usage/cost reporting requires an Admin API key (sk-ant-admin...).');
  }
}

async function requestJson(url) {
  const response = await fetch(url, {
    headers: {
      'anthropic-version': ANTHROPIC_VERSION,
      'x-api-key': ADMIN_API_KEY,
      'User-Agent': 'ASAP-Discord/1.0 anthropic-usage-report',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 300)}`);
  }

  return response.json();
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') search.append(key, String(item));
      }
      continue;
    }
    search.set(key, String(value));
  }
  return search.toString();
}

function sumUsageResults(data) {
  const rows = Array.isArray(data?.data) ? data.data : [];
  const totals = {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    serverToolUseCount: 0,
    webSearchCount: 0,
  };
  const byModel = new Map();

  for (const bucket of rows) {
    const results = Array.isArray(bucket?.results) ? bucket.results : [];
    for (const result of results) {
      const model = result.model || 'unknown';
      const uncachedInputTokens = Number(result.uncached_input_tokens || 0);
      const cachedInputTokens = Number(result.cached_input_tokens || 0);
      const cacheCreationTokens = Number(result.cache_creation_input_tokens || 0);
      const outputTokens = Number(result.output_tokens || 0);
      const serverToolUseCount = Number(result.server_tool_use_count || 0);
      const webSearchCount = Number(result.web_search_requests || 0);

      totals.uncachedInputTokens += uncachedInputTokens;
      totals.cachedInputTokens += cachedInputTokens;
      totals.cacheCreationTokens += cacheCreationTokens;
      totals.outputTokens += outputTokens;
      totals.serverToolUseCount += serverToolUseCount;
      totals.webSearchCount += webSearchCount;

      const current = byModel.get(model) || {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
      };
      current.uncachedInputTokens += uncachedInputTokens;
      current.cachedInputTokens += cachedInputTokens;
      current.cacheCreationTokens += cacheCreationTokens;
      current.outputTokens += outputTokens;
      byModel.set(model, current);
    }
  }

  return {
    totals,
    byModel: Object.fromEntries([...byModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

function parseUsdDecimalToNumber(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function sumCostResults(data) {
  const rows = Array.isArray(data?.data) ? data.data : [];
  let totalUsd = 0;
  const byDescription = new Map();

  for (const bucket of rows) {
    const results = Array.isArray(bucket?.results) ? bucket.results : [];
    for (const result of results) {
      const amountUsd = parseUsdDecimalToNumber(result.amount_usd);
      const description = result.description || result.line_item || 'unknown';
      totalUsd += amountUsd;
      byDescription.set(description, (byDescription.get(description) || 0) + amountUsd);
    }
  }

  return {
    totalUsd,
    byDescription: Object.fromEntries([...byDescription.entries()].sort((a, b) => b[1] - a[1])),
  };
}

function writeSnapshotFile(label, payload) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const safeLabel = String(label || 'snapshot').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const fileName = `${new Date().toISOString().replace(/[:]/g, '-')}-${safeLabel}.json`;
  const filePath = path.join(SNAPSHOT_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf8'));
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function diffObjects(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const result = {};
  for (const key of keys) {
    result[key] = Number(after[key] || 0) - Number(before[key] || 0);
  }
  return result;
}

function diffUsageByModel(before = {}, after = {}) {
  const models = new Set([...Object.keys(before), ...Object.keys(after)]);
  const result = {};
  for (const model of models) {
    result[model] = diffObjects(before[model] || {}, after[model] || {});
  }
  return result;
}

function printDiffReport(before, after) {
  const usageDelta = diffObjects(before.usageSummary?.totals, after.usageSummary?.totals);
  const costDelta = Number(after.costSummary?.totalUsd || 0) - Number(before.costSummary?.totalUsd || 0);
  const modelDiff = diffUsageByModel(before.usageSummary?.byModel || {}, after.usageSummary?.byModel || {});

  console.log('Anthropic Test Usage Report');
  console.log(`Before: ${before.capturedAt}`);
  console.log(`After:  ${after.capturedAt}`);
  console.log('');
  console.log(`Estimated Anthropic cost delta: ${formatUsd(costDelta)}`);
  console.log(`Uncached input tokens: ${formatNumber(usageDelta.uncachedInputTokens)}`);
  console.log(`Cached input tokens:   ${formatNumber(usageDelta.cachedInputTokens)}`);
  console.log(`Cache creation tokens: ${formatNumber(usageDelta.cacheCreationTokens)}`);
  console.log(`Output tokens:         ${formatNumber(usageDelta.outputTokens)}`);
  console.log(`Server tool uses:      ${formatNumber(usageDelta.serverToolUseCount)}`);
  console.log(`Web searches:          ${formatNumber(usageDelta.webSearchCount)}`);

  const modelLines = [];
  for (const [model, values] of Object.entries(modelDiff)) {
    if (!values || typeof values !== 'object') continue;
    const uncached = Number(values.uncachedInputTokens || 0);
    const cached = Number(values.cachedInputTokens || 0);
    const created = Number(values.cacheCreationTokens || 0);
    const output = Number(values.outputTokens || 0);
    if (uncached === 0 && cached === 0 && created === 0 && output === 0) continue;
    modelLines.push(`${model}: in=${formatNumber(uncached)} cached=${formatNumber(cached)} cache_write=${formatNumber(created)} out=${formatNumber(output)}`);
  }

  if (modelLines.length > 0) {
    console.log('');
    console.log('By model');
    for (const line of modelLines) console.log(`- ${line}`);
  }
}

async function captureSnapshot() {
  ensureAdminKey();
  const label = getArg('label', 'snapshot');
  const now = new Date();
  const startingAt = getArg('starting-at', utcDayStartIso(now));
  const endingAt = getArg('ending-at', isoNow());
  const apiKeyIds = getArg('api-key-ids', '').split(',').map((v) => v.trim()).filter(Boolean);
  const workspaceIds = getArg('workspace-ids', '').split(',').map((v) => v.trim()).filter(Boolean);

  const usageQuery = buildQuery({
    starting_at: startingAt,
    ending_at: endingAt,
    bucket_width: '1d',
    'group_by[]': ['model'],
    'api_key_ids[]': apiKeyIds,
    'workspace_ids[]': workspaceIds,
  });
  const costQuery = buildQuery({
    starting_at: startingAt,
    ending_at: endingAt,
    'group_by[]': ['description'],
    'workspace_ids[]': workspaceIds,
  });

  const [usageRaw, costRaw] = await Promise.all([
    requestJson(`${API_BASE}/v1/organizations/usage_report/messages?${usageQuery}`),
    requestJson(`${API_BASE}/v1/organizations/cost_report?${costQuery}`),
  ]);

  const payload = {
    type: 'anthropic-usage-snapshot',
    label,
    capturedAt: isoNow(),
    startingAt,
    endingAt,
    filters: {
      apiKeyIds,
      workspaceIds,
    },
    usageSummary: sumUsageResults(usageRaw),
    costSummary: sumCostResults(costRaw),
    usageRaw,
    costRaw,
  };

  const filePath = writeSnapshotFile(label, payload);
  console.log(`Snapshot written: ${filePath}`);
  console.log(`Anthropic cumulative cost at snapshot: ${formatUsd(payload.costSummary.totalUsd)}`);
}

async function diffSnapshots() {
  const beforePath = getArg('before');
  const afterPath = getArg('after');
  if (!beforePath || !afterPath) {
    fail('Usage: npm run anthropic:usage:report -- --before <file> --after <file>');
  }
  const before = readJson(beforePath);
  const after = readJson(afterPath);
  printDiffReport(before, after);
}

function printHelp() {
  console.log(`Anthropic usage report tool

Commands:
  snapshot   Capture a usage/cost snapshot using the Anthropic Admin API
  diff       Compare two snapshots and print the delta for a test window

Examples:
  npm run anthropic:usage:snapshot -- --label before-test
  npm run anthropic:usage:snapshot -- --label after-test
  npm run anthropic:usage:report -- --before reports/anthropic-usage/<before>.json --after reports/anthropic-usage/<after>.json

Optional filters:
  --api-key-ids apikey_1,apikey_2
  --workspace-ids wrkspc_1,wrkspc_2

Notes:
  - Requires ANTHROPIC_ADMIN_API_KEY.
  - Anthropic exposes usage and cost reports, not a simple remaining-credit balance endpoint.
  - For short tests, snapshot before and after the test and diff the results.`);
}

async function main() {
  const command = process.argv[2] || 'help';
  if (command === 'snapshot') return captureSnapshot();
  if (command === 'diff') return diffSnapshots();
  printHelp();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});