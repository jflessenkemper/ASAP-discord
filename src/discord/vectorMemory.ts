import { logAgentEvent } from './activityLog';
// Semantic embedding memory previously depended on Google-only embedding APIs.
// Until an Anthropic-compatible replacement is wired in, preserve the API surface
// and degrade the feature to a disabled state.

export async function storeMemoryEmbedding(
  _agentId: string,
  _content: string,
  _metadata?: Record<string, unknown>,
): Promise<boolean> {
  return false;
}

// ─── Search ───

export interface VectorSearchResult {
  content: string;
  similarity: number;
  agentId: string;
  metadata?: Record<string, unknown>;
}

export async function searchSimilarMemories(
  _query: string,
  _agentId?: string,
  _limit?: number,
): Promise<VectorSearchResult[]> {
  return [];
}

// ─── Store a key decision or learning ───

export async function recordAgentDecision(
  agentId: string,
  decision: string,
  context?: string,
): Promise<boolean> {
  const content = context ? `Decision: ${decision}\nContext: ${context}` : `Decision: ${decision}`;
  const stored = await storeMemoryEmbedding(agentId, content, {
    type: 'decision',
    timestamp: new Date().toISOString(),
  });
  if (stored) {
    logAgentEvent(agentId, 'memory', `Stored decision embedding: ${decision.slice(0, 100)}`);
  }
  return stored;
}

export async function recordAgentLearning(
  agentId: string,
  learning: string,
): Promise<boolean> {
  const stored = await storeMemoryEmbedding(agentId, `Learning: ${learning}`, {
    type: 'learning',
    timestamp: new Date().toISOString(),
  });
  if (stored) {
    logAgentEvent(agentId, 'memory', `Stored learning embedding: ${learning.slice(0, 100)}`);
  }
  return stored;
}

// ─── Recall relevant context for a task ───

export async function recallRelevantContext(
  query: string,
  agentId?: string,
): Promise<string> {
  const results = await searchSimilarMemories(query, agentId);
  if (results.length === 0) return '';

  const formatted = results
    .map((r, i) => `[${i + 1}] (${(r.similarity * 100).toFixed(0)}% match) ${r.content.slice(0, 300)}`)
    .join('\n');

  return `\n[Relevant past context]\n${formatted}\n`;
}

// ─── Memory Consolidation Loop ───

export async function consolidateMemoryInsights(): Promise<string> {
  return '';
}

export async function recordSmokeInsight(
  categories: string[],
  hasFails: boolean,
  summary: string,
): Promise<void> {
  const insight = `Smoke test result — categories: [${categories.join(', ')}], outcome: ${hasFails ? 'FAILURES' : 'PASS'}. ${summary.slice(0, 400)}`;
  await recordAgentLearning('operations-manager', insight).catch(() => {});
}

// ─── Cleanup ───

export async function cleanupOldEmbeddings(retentionDays = 90): Promise<number> {
  void retentionDays;
  return 0;
}
