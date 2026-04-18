import type { ExecutionIssue, ExecutionStatus, LoopExecutionReport } from './handoff';

export type SelfImprovementOpsChannelKey = 'thread-status' | 'loops' | 'upgrades';

export interface SelfImprovementPacket {
  managerAgentId: 'executive-assistant';
  stewardAgentId: 'operations-manager';
  consumerAgentId: 'opus';
  summary: string;
  requests: OperationsStewardRequest[];
  recommendedLoopIds: string[];
}

export interface SelfImprovementOpsUpdate {
  channelKey: SelfImprovementOpsChannelKey;
  metric: string;
  delta: string;
  action: string;
  severity: 'info' | 'warn' | 'error';
}

export type OperationsStewardRequestKind = 'remember' | 'logging' | 'test' | 'loop-health' | 'ops-report';

export interface OperationsStewardRequest {
  kind: OperationsStewardRequestKind;
  summary: string;
  detail?: string;
  source?: string;
  recommendedLoopIds?: string[];
}

export interface OperationsStewardSource {
  goal: string;
  status: ExecutionStatus;
  summary: string;
  issues: ExecutionIssue[];
}

const SELF_IMPROVEMENT_MANAGER_AGENT_ID = 'executive-assistant';
const SELF_IMPROVEMENT_STEWARD_AGENT_ID = 'operations-manager';
const SELF_IMPROVEMENT_CONSUMER_AGENT_ID = 'opus';

function uniqueRequests(requests: OperationsStewardRequest[]): OperationsStewardRequest[] {
  const seen = new Set<string>();
  const result: OperationsStewardRequest[] = [];
  for (const request of requests) {
    const key = `${request.kind}:${request.source || 'unknown'}:${request.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(request);
  }
  return result;
}

export function deriveOperationsStewardRequests(source: OperationsStewardSource): OperationsStewardRequest[] {
  const requests: OperationsStewardRequest[] = [];

  if (source.status !== 'completed') {
    requests.push({
      kind: 'logging',
      summary: `Capture clearer operational logging for ${source.goal}`,
      detail: source.summary,
      source: 'opus',
      recommendedLoopIds: ['logging-engine'],
    });
    requests.push({
      kind: 'ops-report',
      summary: `Refresh ops-channel state for ${source.goal}`,
      detail: source.summary,
      source: 'opus',
      recommendedLoopIds: ['thread-status-reporter', 'channel-heartbeat'],
    });
  }

  if (source.issues.length > 0) {
    requests.push({
      kind: 'test',
      summary: `Review regression-test coverage for issues found while executing ${source.goal}`,
      detail: source.issues.map((issue) => `${issue.severity}:${issue.message}`).join('; '),
      source: source.issues[0]?.source || 'opus',
      recommendedLoopIds: ['test-engine'],
    });
    requests.push({
      kind: 'loop-health',
      summary: `Check loop reporting and health after issues in ${source.goal}`,
      detail: source.issues.map((issue) => issue.message).join('; '),
      source: 'opus',
      recommendedLoopIds: ['logging-engine', 'thread-status-reporter'],
    });
  }

  if (source.summary.trim()) {
    requests.push({
      kind: 'remember',
      summary: `Record durable operational learning from ${source.goal}`,
      detail: source.summary,
      source: 'opus',
      recommendedLoopIds: ['memory-consolidation'],
    });
  }

  return uniqueRequests(requests);
}

export function buildSelfImprovementPacket(source: OperationsStewardSource): SelfImprovementPacket {
  const requests = deriveOperationsStewardRequests(source);
  const recommendedLoopIds = [...new Set(requests.flatMap((request) => request.recommendedLoopIds || []))];
  const kinds = [...new Set(requests.map((request) => request.kind))];
  return {
    managerAgentId: SELF_IMPROVEMENT_MANAGER_AGENT_ID,
    stewardAgentId: SELF_IMPROVEMENT_STEWARD_AGENT_ID,
    consumerAgentId: SELF_IMPROVEMENT_CONSUMER_AGENT_ID,
    summary: requests.length > 0
      ? `Riley Sonnet queued ${requests.length} self-improvement item(s) for Riley Opus${kinds.length > 0 ? ` (${kinds.join(', ')})` : ''}.`
      : 'Riley Sonnet did not queue any self-improvement work for Riley Opus.',
    requests,
    recommendedLoopIds,
  };
}

export function buildSelfImprovementOpsUpdates(
  packet: SelfImprovementPacket,
  loopReports: LoopExecutionReport[],
  stewardSummary?: string,
): SelfImprovementOpsUpdate[] {
  if (packet.requests.length === 0 && loopReports.length === 0 && !String(stewardSummary || '').trim()) {
    return [];
  }

  const loopSummary = loopReports.length > 0
    ? loopReports.map((report) => `${report.loopId}=${report.status}`).join(', ')
    : 'none';
  const requestKinds = [...new Set(packet.requests.map((request) => request.kind))];
  const hasLoopError = loopReports.some((report) => report.status === 'blocked');
  const hasLoopWarn = loopReports.some((report) => report.status === 'partial');
  const severity: 'info' | 'warn' | 'error' = hasLoopError ? 'error' : hasLoopWarn ? 'warn' : 'info';
  const updates: SelfImprovementOpsUpdate[] = [
    {
      channelKey: 'thread-status',
      metric: `requests=${packet.requests.length}`,
      delta: `manager=${packet.managerAgentId} | consumer=${packet.consumerAgentId} | kinds=${requestKinds.join(',') || 'none'} | loops=${loopSummary}`,
      action: stewardSummary ? 'publish manager summary' : loopReports.length > 0 ? 'inspect loop evidence' : 'none',
      severity,
    },
  ];

  if (loopReports.length > 0) {
    updates.push({
      channelKey: 'loops',
      metric: `reports=${loopReports.length}`,
      delta: loopReports.map((report) => `${report.loopId}: ${report.summary}`).join(' | '),
      action: hasLoopError || hasLoopWarn ? 'review loop follow-up' : 'none',
      severity,
    });
  }

  const durableRequests = packet.requests.filter((request) => request.kind !== 'ops-report');
  if (durableRequests.length > 0 || String(stewardSummary || '').trim()) {
    updates.push({
      channelKey: 'upgrades',
      metric: `items=${durableRequests.length}`,
      delta: durableRequests.length > 0
        ? durableRequests.map((request) => `[${request.kind}] ${request.summary}`).join(' | ')
        : String(stewardSummary || '').trim(),
      action: 'triage self-improvement backlog',
      severity,
    });
  }

  return updates;
}

export function formatOperationsStewardRequests(requests: OperationsStewardRequest[]): string {
  if (requests.length === 0) return 'No operations-steward requests.';
  return requests
    .map((request, index) => {
      const loops = request.recommendedLoopIds && request.recommendedLoopIds.length > 0
        ? ` | loops=${request.recommendedLoopIds.join(',')}`
        : '';
      const detail = request.detail ? ` | detail=${request.detail}` : '';
      return `${index + 1}. [${request.kind}] ${request.summary}${loops}${detail}`;
    })
    .join('\n')
    .slice(0, 1800);
}