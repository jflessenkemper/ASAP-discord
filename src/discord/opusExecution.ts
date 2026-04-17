import {
  buildHandoffResult,
  type ExecutionEvidence,
  type ExecutionIssue,
  type ExecutionProgressUpdate,
  type ExecutionStatus,
  type HandoffResult,
  type LoopExecutionReport,
} from './handoff';
import { deriveOperationsStewardRequests, type OperationsStewardRequest } from './operationsSteward';

export interface OpusExecutionPlan {
  executionId: string;
  goal: string;
  requestedBy: string;
  specialistReports?: HandoffResult[];
  loopReports?: LoopExecutionReport[];
  issues?: ExecutionIssue[];
}

export interface OpusExecutionSummary {
  executionId: string;
  goal: string;
  status: ExecutionStatus;
  summary: string;
  recommendedUserUpdate: string;
  progress: ExecutionProgressUpdate[];
  issues: ExecutionIssue[];
  evidence: ExecutionEvidence[];
  specialistReports: HandoffResult[];
  loopReports: LoopExecutionReport[];
  stewardRequests: OperationsStewardRequest[];
  durationMs: number;
}

export interface OpusExecutionOptions {
  startedAt?: number;
  onMilestone?: (milestone: ExecutionProgressUpdate) => void;
}

function uniqueByKey<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function aggregateStatus(reports: HandoffResult[], loopReports: LoopExecutionReport[], issues: ExecutionIssue[]): ExecutionStatus {
  if (issues.some((issue) => issue.severity === 'error')) return 'blocked';
  if (reports.some((report) => report.status === 'blocked')) return 'blocked';
  if (loopReports.some((report) => report.status === 'blocked')) return 'blocked';
  if (reports.some((report) => report.status === 'partial')) return 'partial';
  if (loopReports.some((report) => report.status === 'partial')) return 'partial';
  return 'completed';
}

function buildRecommendedUserUpdate(status: ExecutionStatus, goal: string, reports: HandoffResult[], issues: ExecutionIssue[]): string {
  if (status === 'blocked') {
    const primaryIssue = issues[0]?.message || reports.find((report) => report.status === 'blocked')?.summary || 'execution is blocked';
    return `Opus hit a blocker while working on \"${goal}\": ${primaryIssue}`;
  }
  if (status === 'partial') {
    return `Opus made progress on \"${goal}\" and is still working through follow-up steps.`;
  }
  return `Opus completed the current execution pass for \"${goal}\".`;
}

function buildExecutionSummary(goal: string, reports: HandoffResult[], loopReports: LoopExecutionReport[], status: ExecutionStatus): string {
  const specialistSummary = reports.map((report) => `${report.agentId}: ${report.summary}`).join('; ');
  const loopSummary = loopReports.map((report) => `${report.loopId}: ${report.summary}`).join('; ');
  const parts = [specialistSummary, loopSummary].filter(Boolean);
  if (parts.length > 0) return parts.join(' | ');
  if (status === 'blocked') return `Execution for \"${goal}\" is blocked.`;
  if (status === 'partial') return `Execution for \"${goal}\" is in progress.`;
  return `Execution for \"${goal}\" completed.`;
}

export function createExecutionMilestone(
  stage: ExecutionProgressUpdate['stage'],
  message: string,
  source?: string,
  percent?: number,
): ExecutionProgressUpdate {
  return {
    stage,
    message,
    source,
    percent,
  };
}

export function createAgentExecutionReport(params: {
  agentId: string;
  summary: string;
  status?: ExecutionStatus;
  filesModified?: string[];
  toolsUsed?: string[];
  nextSteps?: string[];
  issues?: ExecutionIssue[];
  evidence?: ExecutionEvidence[];
  durationMs: number;
}): HandoffResult {
  const resolvedStatus = params.status || (params.issues?.some((issue) => issue.severity === 'error') ? 'blocked' : 'completed');
  return buildHandoffResult({
    agentId: params.agentId,
    status: resolvedStatus,
    summary: params.summary,
    filesModified: params.filesModified,
    toolsUsed: params.toolsUsed,
    nextSteps: params.nextSteps,
    issues: params.issues,
    evidence: params.evidence,
    recommendedUserUpdate: params.summary,
    progress: [createExecutionMilestone(resolvedStatus === 'blocked' ? 'blocked' : resolvedStatus === 'partial' ? 'executing' : 'completed', params.summary, params.agentId)],
    durationMs: params.durationMs,
  });
}

export async function executeOpusPlan(
  plan: OpusExecutionPlan,
  options: OpusExecutionOptions = {},
): Promise<OpusExecutionSummary> {
  const startedAt = options.startedAt || Date.now();
  const specialistReports = plan.specialistReports || [];
  const loopReports = plan.loopReports || [];
  const reportIssues = specialistReports.flatMap((report) => report.issues || []);
  const loopIssues = loopReports.flatMap((report) => report.issues || []);
  const issues = uniqueByKey([...(plan.issues || []), ...reportIssues, ...loopIssues], (issue) => `${issue.scope}:${issue.source || 'unknown'}:${issue.message}`);
  const evidence = uniqueByKey(
    [
      ...specialistReports.flatMap((report) => report.evidence || []),
      ...loopReports.flatMap((report) => report.evidence || []),
    ],
    (item) => `${item.kind}:${item.value}`,
  );

  const progress: ExecutionProgressUpdate[] = [
    createExecutionMilestone('planned', `Opus accepted execution plan for ${plan.goal}`, 'opus', 5),
    ...specialistReports.flatMap((report) => report.progress || []),
  ];

  const status = aggregateStatus(specialistReports, loopReports, issues);
  const stewardRequests = deriveOperationsStewardRequests({
    goal: plan.goal,
    status,
    summary: buildExecutionSummary(plan.goal, specialistReports, loopReports, status),
    issues,
  });
  progress.push(
    createExecutionMilestone(
      status === 'blocked' ? 'blocked' : status === 'partial' ? 'executing' : 'completed',
      status === 'blocked'
        ? `Opus found blockers while executing ${plan.goal}`
        : status === 'partial'
          ? `Opus completed a partial execution pass for ${plan.goal}`
          : `Opus completed execution for ${plan.goal}`,
      'opus',
      status === 'completed' ? 100 : status === 'partial' ? 75 : 50,
    ),
  );

  for (const milestone of progress) {
    options.onMilestone?.(milestone);
  }

  return {
    executionId: plan.executionId,
    goal: plan.goal,
    status,
    summary: buildExecutionSummary(plan.goal, specialistReports, loopReports, status),
    recommendedUserUpdate: buildRecommendedUserUpdate(status, plan.goal, specialistReports, issues),
    progress,
    issues,
    evidence,
    specialistReports,
    loopReports,
    stewardRequests,
    durationMs: Date.now() - startedAt,
  };
}