function firstEnv(keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return fallback;
}

function csvEnv(keys: string[], fallback: string[]): string[] {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (!value) continue;
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return fallback;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export type ModelRole = 'coding' | 'fast' | 'secondary-fast' | 'voice-fast' | 'guardrails' | 'job-draft' | 'cortana-planning';

export const DEFAULT_CODING_MODEL = firstEnv(
  ['CODING_AGENT_MODEL', 'ANTHROPIC_CODING_MODEL'],
  'claude-opus-4-6',
);

export const DEFAULT_FAST_MODEL = firstEnv(
  ['FAST_AGENT_MODEL', 'ANTHROPIC_FAST_MODEL'],
  'claude-sonnet-4-20250514',
);

export const SECONDARY_FAST_MODEL = firstEnv(
  ['SECONDARY_FAST_AGENT_MODEL', 'ANTHROPIC_SECONDARY_FAST_MODEL'],
  'claude-sonnet-4-6',
);

export const VOICE_FAST_MODEL = firstEnv(
  ['VOICE_FAST_MODEL'],
  DEFAULT_FAST_MODEL,
);

export const GUARDRAILS_MODEL = firstEnv(
  ['GUARDRAILS_MODEL'],
  DEFAULT_FAST_MODEL,
);

export const JOB_DRAFT_MODEL = firstEnv(
  ['JOB_DRAFT_MODEL'],
  DEFAULT_FAST_MODEL,
);

export const CORTANA_PLANNING_MODEL = firstEnv(
  ['CORTANA_PLANNING_MODEL'],
  DEFAULT_FAST_MODEL,
);

export const MODEL_BY_ROLE: Record<ModelRole, string> = {
  coding: DEFAULT_CODING_MODEL,
  fast: DEFAULT_FAST_MODEL,
  'secondary-fast': SECONDARY_FAST_MODEL,
  'voice-fast': VOICE_FAST_MODEL,
  guardrails: GUARDRAILS_MODEL,
  'job-draft': JOB_DRAFT_MODEL,
  'cortana-planning': CORTANA_PLANNING_MODEL,
};

export const ANTHROPIC_HEALTHCHECK_MODELS = unique(csvEnv(
  ['ANTHROPIC_HEALTHCHECK_MODELS'],
  [DEFAULT_FAST_MODEL, DEFAULT_CODING_MODEL],
));

const codingFallbacks = unique(csvEnv(
  ['CODING_MODEL_FALLBACKS', 'MODEL_FALLBACKS_CODING'],
  [DEFAULT_FAST_MODEL, SECONDARY_FAST_MODEL],
));

const fastFallbacks = unique(csvEnv(
  ['FAST_MODEL_FALLBACKS', 'MODEL_FALLBACKS_FAST'],
  [DEFAULT_CODING_MODEL, SECONDARY_FAST_MODEL],
));

const secondaryFastFallbacks = unique(csvEnv(
  ['SECONDARY_FAST_MODEL_FALLBACKS', 'MODEL_FALLBACKS_SECONDARY_FAST'],
  [DEFAULT_CODING_MODEL, DEFAULT_FAST_MODEL],
));

export const MODEL_FALLBACK_CHAINS: Record<string, string[]> = {
  [DEFAULT_CODING_MODEL]: codingFallbacks,
  [DEFAULT_FAST_MODEL]: fastFallbacks,
  [SECONDARY_FAST_MODEL]: secondaryFastFallbacks,
};

export const USE_VERTEX_ANTHROPIC = process.env.ANTHROPIC_USE_VERTEX_AI === 'true' || process.env.OPUS_USE_VERTEX_AI === 'true';
export const VERTEX_PROJECT_ID = firstEnv(
  ['VERTEX_PROJECT_ID', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT'],
  '',
);
export const VERTEX_LOCATION = firstEnv(['VERTEX_LOCATION'], 'us-central1');
export const VERTEX_ANTHROPIC_LOCATION = firstEnv(
  ['VERTEX_ANTHROPIC_LOCATION', 'VERTEX_PARTNER_LOCATION'],
  VERTEX_LOCATION,
);
export const VERTEX_ANTHROPIC_FALLBACK_LOCATIONS = unique(csvEnv(
  ['VERTEX_ANTHROPIC_FALLBACK_LOCATIONS'],
  ['us-east5'],
));
export const VERTEX_ANTHROPIC_VERSION = firstEnv(
  ['VERTEX_ANTHROPIC_VERSION'],
  'vertex-2023-10-16',
);

export function getModelForRole(role: ModelRole): string {
  return MODEL_BY_ROLE[role];
}

export function getFallbackChain(modelName: string): string[] {
  return MODEL_FALLBACK_CHAINS[String(modelName || '').trim()] || [];
}

export function getPreferredAnthropicLocations(modelName: string): string[] {
  const normalizedModel = String(modelName || '').toLowerCase();
  if (normalizedModel.includes('opus-4-6')) {
    return unique(['us-east5', VERTEX_ANTHROPIC_LOCATION, ...VERTEX_ANTHROPIC_FALLBACK_LOCATIONS]);
  }
  return unique([VERTEX_ANTHROPIC_LOCATION, ...VERTEX_ANTHROPIC_FALLBACK_LOCATIONS]);
}

export function shouldTryAnotherAnthropicLocation(status: number, bodyText: string): boolean {
  const msg = String(bodyText || '').toLowerCase();
  if (status === 429) return true;
  if (status === 404) return true;
  if (status === 400 && (msg.includes('not servable') || msg.includes('not found'))) return true;
  return false;
}

export function isAnthropicModel(modelName: string): boolean {
  return String(modelName || '').toLowerCase().includes('claude');
}