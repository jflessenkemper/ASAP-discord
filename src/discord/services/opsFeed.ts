import { TextChannel } from 'discord.js';

export type OpsSeverity = 'info' | 'warn' | 'error';

interface OpsLineInput {
  actor: string;
  scope: string;
  metric: string;
  delta: string;
  action: string;
  severity?: OpsSeverity;
  correlationId?: string;
  occurredAtMs?: number;
}

interface DigestEntry {
  scope: string;
  metric: string;
  severity: OpsSeverity;
}

interface DigestState {
  channel: TextChannel;
  entries: DigestEntry[];
  timer: ReturnType<typeof setTimeout> | null;
}

const digestStates = new Map<string, DigestState>();

function toSafeToken(value: string, fallback: string): string {
  const token = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return token || fallback;
}

function nowMs(): number {
  return Date.now();
}

function digestIntervalMs(): number {
  const raw = parseInt(process.env.OPS_DIGEST_INTERVAL_MS || '', 10);
  if (Number.isFinite(raw)) {
    return Math.max(15 * 60 * 1000, Math.min(raw, 30 * 60 * 1000));
  }
  return 15 * 60 * 1000;
}

function shouldDigest(channel: TextChannel, severity: OpsSeverity): boolean {
  if (severity !== 'info') return false;
  const name = String(channel.name || '').toLowerCase();
  return name.includes('cost');
}

function severityEmoji(severity: OpsSeverity): string {
  if (severity === 'error') return '🔴';
  if (severity === 'warn') return '🟡';
  return '🟢';
}

function ageLabel(occurredAtMs?: number): string {
  if (!Number.isFinite(occurredAtMs)) return '0s';
  const diff = Math.max(0, nowMs() - Number(occurredAtMs));
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

function newCorrelationId(seed = ''): string {
  const stamp = nowMs().toString(36).slice(-5);
  const nonce = Math.random().toString(36).slice(2, 6);
  const safeSeed = toSafeToken(seed, 'evt').slice(0, 4);
  return `${safeSeed}${stamp}${nonce}`;
}

function sanitizeValue(value: string, maxLen = 200): string {
  return String(value || '')
    .replace(/@(everyone|here)/gi, 'at-$1')
    .replace(/<@[!&]?\d+>/g, 'mention')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function normalizeScopeToken(value: string, fallback = 'unknown'): string {
  const token = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return token || fallback;
}

export function formatOpsLine(input: OpsLineInput): string {
  const severity = input.severity || 'info';
  const actor = toSafeToken(input.actor, 'system');
  const scope = sanitizeValue(input.scope, 80);
  const metric = sanitizeValue(input.metric, 80);
  const delta = sanitizeValue(input.delta, 350);
  const action = sanitizeValue(input.action, 180) || 'none';
  const corr = sanitizeValue(input.correlationId || newCorrelationId(scope), 24);
  const age = ageLabel(input.occurredAtMs);

  return `${severityEmoji(severity)} severity=${severity} | agent=${actor} | scope=${scope} | metric=${metric} | delta=${delta} | action=${action} | corr=${corr} | age=${age}`;
}

function summarizeDigest(entries: DigestEntry[]): string {
  const tally = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.scope}:${entry.metric}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  const top = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key, count]) => `${key}x${count}`)
    .join(', ');

  return top || 'none';
}

async function flushDigest(channelId: string): Promise<void> {
  const state = digestStates.get(channelId);
  if (!state || state.entries.length === 0) return;

  const entries = state.entries.splice(0, state.entries.length);
  state.timer = null;

  const warnCount = entries.filter((entry) => entry.severity !== 'info').length;
  const summary = summarizeDigest(entries);
  const line = formatOpsLine({
    actor: 'system',
    scope: `digest:${normalizeScopeToken(state.channel.name, 'channel')}`,
    metric: `events=${entries.length}`,
    delta: `top=${summary}`,
    action: warnCount > 0 ? 'review warning/error entries now' : 'none',
    severity: warnCount > 0 ? 'warn' : 'info',
    occurredAtMs: nowMs(),
  });

  await state.channel.send(line.slice(0, 1900)).catch(() => {});
}

function scheduleDigest(channel: TextChannel): DigestState {
  const existing = digestStates.get(channel.id);
  if (existing) return existing;

  const state: DigestState = {
    channel,
    entries: [],
    timer: null,
  };

  digestStates.set(channel.id, state);
  return state;
}

function getAlertMention(): string {
  const enabled = String(process.env.DISCORD_OPS_ALERT_MENTIONS || 'false').toLowerCase() === 'true';
  if (!enabled) return '';
  const roleId = String(process.env.DISCORD_OPS_ALERT_ROLE_ID || '').trim();
  if (!roleId) return '';
  return `<@&${roleId}>`;
}

export async function postOpsLine(channel: TextChannel, input: OpsLineInput): Promise<void> {
  const severity = input.severity || 'info';
  const line = formatOpsLine({ ...input, severity });

  if (shouldDigest(channel, severity)) {
    const state = scheduleDigest(channel);
    state.entries.push({ scope: input.scope, metric: input.metric, severity });
    if (!state.timer) {
      state.timer = setTimeout(() => {
        flushDigest(channel.id).catch(() => {});
      }, digestIntervalMs());
    }
    return;
  }

  const mention = getAlertMention();
  const finalLine = mention ? `${mention} ${line}` : line;
  await channel.send(finalLine.slice(0, 1900)).catch(() => {});
}

export async function flushAllOpsDigests(): Promise<void> {
  const ids = [...digestStates.keys()];
  for (const id of ids) {
    await flushDigest(id).catch(() => {});
  }
}
