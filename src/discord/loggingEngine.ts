import { TextChannel } from 'discord.js';

import pool from '../db/pool';
import { errMsg } from '../utils/errors';
import { formatAge } from '../utils/time';

import { postOpsLine } from './activityLog';
import { recordLoopHealth } from './loopHealth';
import type { BotChannels } from './setup';

type ActivityEvent = 'invoke' | 'tool' | 'response' | 'error' | 'rate_limit' | 'guardrail' | 'cache' | 'memory';

type ActivityLogRow = {
  agent_id: string;
  event: ActivityEvent;
  detail: string | null;
  ts: string | Date;
};

type ActivitySummary = {
  totalEvents: number;
  errorCount: number;
  topAgents: string[];
  eventBreakdown: string[];
  recentErrors: string[];
};

type OpsChannelSnapshot = {
  channelName: string;
  ageMs: number | null;
  preview: string;
};

export interface LoggingEngineSnapshot {
  capturedAt: number;
  activityWindowHours: number;
  activity: ActivitySummary;
  channels: OpsChannelSnapshot[];
}

const LOGGING_ENGINE_WINDOW_HOURS = Math.max(1, parseInt(process.env.LOGGING_ENGINE_WINDOW_HOURS || '6', 10));
const LOGGING_ENGINE_CHANNEL_LIMIT = Math.max(4, parseInt(process.env.LOGGING_ENGINE_CHANNEL_LIMIT || '8', 10));
const LOGGING_ENGINE_TOP_ERRORS = Math.max(2, parseInt(process.env.LOGGING_ENGINE_TOP_ERRORS || '4', 10));

let latestSnapshot: LoggingEngineSnapshot | null = null;

function sanitizePreview(value: string, maxLen = 120): string {
  return String(value || '')
    .replace(/```/g, ' ')
    .replace(/@(everyone|here)/gi, 'at-$1')
    .replace(/<@[!&]?\d+>/g, 'mention')
    .replace(/[A-Za-z0-9_\-]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function summarizeCounts(entries: Map<string, number>, limit: number): string[] {
  return [...entries.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => `${key}=${count}`);
}

export function summarizeActivityRows(rows: ActivityLogRow[]): ActivitySummary {
  const agentCounts = new Map<string, number>();
  const eventCounts = new Map<string, number>();
  const recentErrors: string[] = [];

  for (const row of rows) {
    const agentId = String(row.agent_id || 'unknown');
    agentCounts.set(agentId, (agentCounts.get(agentId) || 0) + 1);
    eventCounts.set(row.event, (eventCounts.get(row.event) || 0) + 1);

    if (row.event === 'error' && recentErrors.length < LOGGING_ENGINE_TOP_ERRORS) {
      recentErrors.push(`${agentId}: ${sanitizePreview(row.detail || 'unknown error', 140)}`);
    }
  }

  return {
    totalEvents: rows.length,
    errorCount: eventCounts.get('error') || 0,
    topAgents: summarizeCounts(agentCounts, 3),
    eventBreakdown: summarizeCounts(eventCounts, 6),
    recentErrors,
  };
}

async function readLatestChannelMessage(channel: TextChannel): Promise<OpsChannelSnapshot> {
  const messages = await channel.messages.fetch({ limit: 1 }).catch(() => null);
  const latest = messages?.first();
  return {
    channelName: channel.name,
    ageMs: latest?.createdTimestamp ? Date.now() - latest.createdTimestamp : null,
    preview: sanitizePreview(latest?.content || latest?.embeds?.[0]?.description || latest?.embeds?.[0]?.title || 'no recent messages'),
  };
}

function getLogSourceChannels(channels: BotChannels): TextChannel[] {
  return [
    channels.threadStatus,
    channels.agentErrors,
    channels.voiceErrors,
    channels.terminal,
    channels.tools,
    channels.github,
    channels.cost,
    channels.callLog,
    channels.upgrades,
    channels.screenshots,
    channels.url,
    channels.limits,
  ].slice(0, LOGGING_ENGINE_CHANNEL_LIMIT);
}

async function queryRecentActivityRows(hours: number): Promise<ActivityLogRow[]> {
  const result = await pool.query(
    `SELECT agent_id, event, detail, ts
       FROM agent_activity_log
      WHERE ts >= NOW() - INTERVAL '1 hour' * $1
        AND agent_id <> 'ops'
      ORDER BY ts DESC
      LIMIT 200`,
    [hours]
  );
  return (result.rows || []) as ActivityLogRow[];
}

export async function captureLoggingEngineSnapshot(channels: BotChannels): Promise<LoggingEngineSnapshot> {
  const [rows, channelSnapshots] = await Promise.all([
    queryRecentActivityRows(LOGGING_ENGINE_WINDOW_HOURS),
    Promise.all(getLogSourceChannels(channels).map((channel) => readLatestChannelMessage(channel))),
  ]);

  return {
    capturedAt: Date.now(),
    activityWindowHours: LOGGING_ENGINE_WINDOW_HOURS,
    activity: summarizeActivityRows(rows),
    channels: channelSnapshots,
  };
}

export function buildLoggingEngineReport(snapshot: LoggingEngineSnapshot | null = latestSnapshot): string {
  if (!snapshot) {
    return 'Logging Engine\n⚪ No snapshot yet — waiting for the first log sweep.';
  }

  const lines = [
    'Logging Engine',
    `Window: last ${snapshot.activityWindowHours}h`,
    `Events: ${snapshot.activity.totalEvents} | errors: ${snapshot.activity.errorCount}`,
    `Top agents: ${snapshot.activity.topAgents.join(' | ') || 'none'}`,
    `Event mix: ${snapshot.activity.eventBreakdown.join(' | ') || 'none'}`,
  ];

  if (snapshot.activity.recentErrors.length > 0) {
    lines.push('Recent errors:');
    for (const entry of snapshot.activity.recentErrors) {
      lines.push(`- ${entry}`);
    }
  } else {
    lines.push('Recent errors: none');
  }

  lines.push('Ops channels:');
  for (const channel of snapshot.channels) {
    const age = channel.ageMs == null ? 'never' : formatAge(channel.ageMs);
    lines.push(`- #${channel.channelName}: ${age} — ${channel.preview || 'no preview'}`);
  }

  return lines.join('\n').slice(0, 1900);
}

export function getLoggingEngineRuntimeContext(): string {
  if (!latestSnapshot) {
    return '🪵 Logging Engine\nNo log sweep captured yet.';
  }

  const oldestChannelAge = latestSnapshot.channels
    .map((channel) => channel.ageMs)
    .filter((age): age is number => typeof age === 'number')
    .sort((a, b) => b - a)[0];

  return [
    '🪵 Logging Engine',
    `Window: ${latestSnapshot.activityWindowHours}h`,
    `Events: ${latestSnapshot.activity.totalEvents}`,
    `Errors: ${latestSnapshot.activity.errorCount}`,
    `Top agents: ${latestSnapshot.activity.topAgents.join(' | ') || 'none'}`,
    `Noisiest channel age: ${typeof oldestChannelAge === 'number' ? formatAge(oldestChannelAge) : 'n/a'}`,
  ].join('\n');
}

export async function runLoggingEngine(channels: BotChannels): Promise<void> {
  try {
    latestSnapshot = await captureLoggingEngineSnapshot(channels);
    const severity = latestSnapshot.activity.errorCount > 0 ? 'warn' : 'info';
    const detail = `events=${latestSnapshot.activity.totalEvents} | errors=${latestSnapshot.activity.errorCount} | top=${latestSnapshot.activity.topAgents.join(',') || 'none'}`;

    recordLoopHealth('logging-engine', severity === 'warn' ? 'warn' : 'ok', detail);
    await postOpsLine(channels.threadStatus, {
      actor: 'executive-assistant',
      scope: 'logging-engine',
      metric: `channels=${latestSnapshot.channels.length}`,
      delta: detail,
      action: latestSnapshot.activity.errorCount > 0 ? 'review recent errors' : 'none',
      severity,
    });
  } catch (err) {
    recordLoopHealth('logging-engine', 'error', errMsg(err));
  }
}

export function resetLoggingEngineForTests(): void {
  latestSnapshot = null;
}
