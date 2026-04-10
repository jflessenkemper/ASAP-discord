// ─── Agent Handoff Protocol ───
// Structured context transfer between agents during delegation.
// Ensures receiving agents get clean, relevant context instead of raw history dumps.

export interface HandoffContext {
  fromAgent: string;
  toAgent: string;
  traceId: string;
  task: string;
  relevantContext: string[];
  constraints: string[];
  expectedOutput?: string;
  priority: 'high' | 'normal' | 'low';
  parentGoal?: string;
  toolsUsed?: string[];
  filesModified?: string[];
  timestamp: number;
}

export interface HandoffResult {
  agentId: string;
  status: 'completed' | 'blocked' | 'partial';
  summary: string;
  filesModified: string[];
  toolsUsed: string[];
  nextSteps?: string[];
  durationMs: number;
}

/**
 * Build a handoff context for delegating work to another agent.
 */
export function buildHandoffContext(params: {
  fromAgent: string;
  toAgent: string;
  traceId: string;
  task: string;
  conversationSummary?: string;
  constraints?: string[];
  expectedOutput?: string;
  priority?: 'high' | 'normal' | 'low';
  parentGoal?: string;
  toolsUsed?: string[];
  filesModified?: string[];
}): HandoffContext {
  const relevantContext: string[] = [];

  if (params.conversationSummary) {
    relevantContext.push(params.conversationSummary);
  }

  if (params.filesModified && params.filesModified.length > 0) {
    relevantContext.push(`Files already modified: ${params.filesModified.join(', ')}`);
  }

  if (params.toolsUsed && params.toolsUsed.length > 0) {
    relevantContext.push(`Tools already used: ${params.toolsUsed.join(', ')}`);
  }

  return {
    fromAgent: params.fromAgent,
    toAgent: params.toAgent,
    traceId: params.traceId,
    task: params.task,
    relevantContext,
    constraints: params.constraints || [],
    expectedOutput: params.expectedOutput,
    priority: params.priority || 'normal',
    parentGoal: params.parentGoal,
    toolsUsed: params.toolsUsed,
    filesModified: params.filesModified,
    timestamp: Date.now(),
  };
}

/**
 * Format handoff context as a prompt prefix for the receiving agent.
 */
export function formatHandoffPrompt(ctx: HandoffContext): string {
  const lines: string[] = [
    `[Handoff from ${ctx.fromAgent}]`,
    `Task: ${ctx.task}`,
  ];

  if (ctx.parentGoal) {
    lines.push(`Parent goal: ${ctx.parentGoal}`);
  }

  if (ctx.priority !== 'normal') {
    lines.push(`Priority: ${ctx.priority}`);
  }

  if (ctx.relevantContext.length > 0) {
    lines.push('Context:');
    for (const item of ctx.relevantContext) {
      lines.push(`  - ${item}`);
    }
  }

  if (ctx.constraints.length > 0) {
    lines.push('Constraints:');
    for (const constraint of ctx.constraints) {
      lines.push(`  - ${constraint}`);
    }
  }

  if (ctx.expectedOutput) {
    lines.push(`Expected output: ${ctx.expectedOutput}`);
  }

  lines.push(`Trace: ${ctx.traceId}`);

  return lines.join('\n');
}

/**
 * Build a handoff result for returning to the delegating agent.
 */
export function buildHandoffResult(params: {
  agentId: string;
  status: 'completed' | 'blocked' | 'partial';
  summary: string;
  filesModified?: string[];
  toolsUsed?: string[];
  nextSteps?: string[];
  durationMs: number;
}): HandoffResult {
  return {
    agentId: params.agentId,
    status: params.status,
    summary: params.summary,
    filesModified: params.filesModified || [],
    toolsUsed: params.toolsUsed || [],
    nextSteps: params.nextSteps,
    durationMs: params.durationMs,
  };
}

/**
 * Format handoff result as text for the delegating agent.
 */
export function formatHandoffResult(result: HandoffResult): string {
  const lines: string[] = [
    `[Result from ${result.agentId}] Status: ${result.status}`,
    result.summary,
  ];

  if (result.filesModified.length > 0) {
    lines.push(`Files touched: ${result.filesModified.join(', ')}`);
  }

  if (result.nextSteps && result.nextSteps.length > 0) {
    lines.push(`Next steps: ${result.nextSteps.join('; ')}`);
  }

  return lines.join('\n');
}

/**
 * Determine if multiple handoffs can be run in parallel.
 * Independent if they don't share file dependencies.
 */
export function canRunInParallel(handoffs: HandoffContext[]): boolean {
  if (handoffs.length <= 1) return true;

  const allFiles = new Set<string>();
  for (const h of handoffs) {
    for (const f of h.filesModified || []) {
      if (allFiles.has(f)) return false;
      allFiles.add(f);
    }
  }
  return true;
}
