import { TextChannel } from 'discord.js';

export type LoopHealthStatus = 'ok' | 'warn' | 'error';

export type LoopId =
  | 'channel-heartbeat'
  | 'logging-engine'
  | 'upgrades-triage'
  | 'memory-consolidation'
  | 'database-audit'
  | 'test-engine'
  | 'thread-status-reporter'
  | 'goal-watchdog'
  | 'self-improvement-worker'
  | 'voice-session';

export interface LoopHealthEntry {
  id: LoopId;
  label: string;
  status: LoopHealthStatus | 'idle';
  lastRunAt: number | null;
  lastDetail: string;
  runCount: number;
}

type MutableLoopHealthEntry = Omit<LoopHealthEntry, 'id' | 'label'>;

const LOOP_LABELS: Record<LoopId, string> = {
  'channel-heartbeat': 'Channel Heartbeat',
  'logging-engine': 'Logging Engine',
  'upgrades-triage': 'Upgrades Triage',
  'memory-consolidation': 'Memory Consolidation',
  'database-audit': 'Database Audit',
  'test-engine': 'Test Engine',
  'thread-status-reporter': 'Thread Status Reporter',
  'goal-watchdog': 'Goal Watchdog',
  'self-improvement-worker': 'Self-Improvement Worker',
  'voice-session': 'Voice Session',
};

const LOOP_ORDER: LoopId[] = [
  'channel-heartbeat',
  'logging-engine',
  'upgrades-triage',
  'memory-consolidation',
  'database-audit',
  'test-engine',
  'thread-status-reporter',
  'goal-watchdog',
  'self-improvement-worker',
  'voice-session',
];

const loopHealth = new Map<LoopId, MutableLoopHealthEntry>();
const loopReportSuppression = new Map<LoopId, { key: string; sentAt: number }>();
const LOOP_REPORT_SUPPRESSION_MS = 30_000;
let loopReportChannel: TextChannel | null = null;

function ensureLoop(loopId: LoopId): MutableLoopHealthEntry {
  let entry = loopHealth.get(loopId);
  if (!entry) {
    entry = {
      status: 'idle',
      lastRunAt: null,
      lastDetail: 'never ran',
      runCount: 0,
    };
    loopHealth.set(loopId, entry);
  }
  return entry;
}

function formatAge(ms: number): string {
  if (ms < 1000) return 'just now';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function statusIcon(status: LoopHealthEntry['status']): string {
  if (status === 'ok') return '✅';
  if (status === 'warn') return '⚠️';
  if (status === 'error') return '❌';
  return '⚪';
}

function normalizeLoopDetail(detail: string): string {
  return String(detail || '').replace(/\s+/g, ' ').trim() || 'no detail';
}

async function postLoopReport(loopId: LoopId, entry: MutableLoopHealthEntry): Promise<void> {
  if (!loopReportChannel) return;

  const detail = normalizeLoopDetail(entry.lastDetail);
  const dedupeKey = `${entry.status}:${detail}`;
  const previous = loopReportSuppression.get(loopId);
  const now = Date.now();
  if (previous && previous.key === dedupeKey && now - previous.sentAt < LOOP_REPORT_SUPPRESSION_MS) {
    return;
  }
  loopReportSuppression.set(loopId, { key: dedupeKey, sentAt: now });

  const label = LOOP_LABELS[loopId];
  await loopReportChannel.send(
    `🔁 ${statusIcon(entry.status)} **${label}** (${loopId}) | run ${entry.runCount} | ${detail}`.slice(0, 1900)
  ).catch(() => {});
}

export function setLoopReportChannel(channel: TextChannel | null): void {
  loopReportChannel = channel;
}

export function recordLoopHealth(loopId: LoopId, status: LoopHealthStatus, detail: string): void {
  const entry = ensureLoop(loopId);
  entry.status = status;
  entry.lastRunAt = Date.now();
  entry.lastDetail = normalizeLoopDetail(detail);
  entry.runCount += 1;
  void postLoopReport(loopId, entry);
}

export function getLoopHealthSnapshot(): LoopHealthEntry[] {
  return LOOP_ORDER.map((id) => {
    const entry = ensureLoop(id);
    return {
      id,
      label: LOOP_LABELS[id],
      status: entry.status,
      lastRunAt: entry.lastRunAt,
      lastDetail: entry.lastDetail,
      runCount: entry.runCount,
    };
  });
}

export function buildLoopHealthCompactSummary(): string {
  const entries = getLoopHealthSnapshot();
  const parts = entries.map((entry) => {
    const when = entry.lastRunAt ? formatAge(Date.now() - entry.lastRunAt) : 'never';
    return `${statusIcon(entry.status)} ${entry.id}: ${when}`;
  });
  return `Loops\n${parts.join('\n')}`;
}

export function buildLoopHealthDetailedReport(): string {
  const lines = ['Loop Health'];
  for (const entry of getLoopHealthSnapshot()) {
    const when = entry.lastRunAt ? formatAge(Date.now() - entry.lastRunAt) : 'never';
    lines.push(`${statusIcon(entry.status)} ${entry.label} (${entry.id}) — ${when} — runs=${entry.runCount} — ${entry.lastDetail}`);
  }
  return lines.join('\n');
}

export function resetLoopHealthForTests(): void {
  loopHealth.clear();
  loopReportSuppression.clear();
  loopReportChannel = null;
}