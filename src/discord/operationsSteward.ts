import type { ExecutionIssue, ExecutionStatus } from './handoff';

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