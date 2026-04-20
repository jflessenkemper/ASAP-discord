import pool from '../db/pool';
import { logAgentEvent } from './activityLog';
import { errMsg } from '../utils/errors';

// ─── agent_learnings backed semantic recall ───
// Replaces the former Google-embedding-based vector memory with direct Postgres
// queries against the agent_learnings table (migration 022).

const RECALL_LIMIT = 10;
const RECALL_MAX_CHARS = 800;

export interface VectorSearchResult {
  content: string;
  similarity: number;
  agentId: string;
  metadata?: Record<string, unknown>;
}

// ─── Store ───

export async function storeMemoryEmbedding(
  agentId: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  const tag = (metadata?.type as string) || 'general';
  const source = (metadata?.source as string) || 'memory';
  try {
    await pool.query(
      `INSERT INTO agent_learnings (agent_id, tag, pattern, source)
       VALUES ($1, $2, $3, $4)`,
      [agentId, tag, content.slice(0, 2000), source],
    );
    return true;
  } catch (err) {
    console.error('[vectorMemory] storeMemoryEmbedding failed:', errMsg(err));
    return false;
  }
}

export async function searchSimilarMemories(
  query: string,
  agentId?: string,
  limit?: number,
): Promise<VectorSearchResult[]> {
  try {
    const maxRows = limit ?? RECALL_LIMIT;
    const { rows } = agentId
      ? await pool.query(
          `SELECT agent_id, tag, pattern FROM agent_learnings
           WHERE agent_id = $1 AND active = true AND expires_at > now()
           ORDER BY created_at DESC LIMIT $2`,
          [agentId, maxRows],
        )
      : await pool.query(
          `SELECT agent_id, tag, pattern FROM agent_learnings
           WHERE active = true AND expires_at > now()
           ORDER BY created_at DESC LIMIT $1`,
          [maxRows],
        );
    return rows.map((r: { agent_id: string; tag: string; pattern: string }) => ({
      content: r.pattern,
      similarity: 1,
      agentId: r.agent_id,
      metadata: { tag: r.tag },
    }));
  } catch (err) {
    console.error('[vectorMemory] searchSimilarMemories failed:', errMsg(err));
    return [];
  }
}

// ─── Store a key decision or learning ───

export async function recordAgentDecision(
  agentId: string,
  decision: string,
  context?: string,
): Promise<boolean> {
  const content = context ? `Decision: ${decision}\nContext: ${context}` : `Decision: ${decision}`;
  const stored = await storeMemoryEmbedding(agentId, content, { type: 'decision' });
  if (stored) {
    logAgentEvent(agentId, 'memory', `Stored decision: ${decision.slice(0, 100)}`);
  }
  return stored;
}

export async function recordAgentLearning(
  agentId: string,
  learning: string,
  tag = 'learning',
  source = 'self-improvement',
): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO agent_learnings (agent_id, tag, pattern, source)
       VALUES ($1, $2, $3, $4)`,
      [agentId, tag, learning.slice(0, 2000), source],
    );
    logAgentEvent(agentId, 'memory', `Stored learning [${tag}]: ${learning.slice(0, 100)}`);
    return true;
  } catch (err) {
    console.error('[vectorMemory] recordAgentLearning failed:', errMsg(err));
    return false;
  }
}

// ─── Recall relevant context for a task ───

export async function recallRelevantContext(
  _query: string,
  agentId?: string,
): Promise<string> {
  try {
    const { rows } = agentId
      ? await pool.query(
          `SELECT tag, pattern FROM agent_learnings
           WHERE agent_id = $1 AND active = true AND expires_at > now()
           ORDER BY created_at DESC LIMIT $2`,
          [agentId, RECALL_LIMIT],
        )
      : await pool.query(
          `SELECT tag, pattern FROM agent_learnings
           WHERE active = true AND expires_at > now()
           ORDER BY created_at DESC LIMIT $1`,
          [RECALL_LIMIT],
        );
    if (rows.length === 0) return '';

    let result = '';
    for (const r of rows as { tag: string; pattern: string }[]) {
      const line = `- [${r.tag}] ${r.pattern}\n`;
      if (result.length + line.length > RECALL_MAX_CHARS) break;
      result += line;
    }
    return result ? `\n[Learned patterns]\n${result}` : '';
  } catch (err) {
    console.error('[vectorMemory] recallRelevantContext failed:', errMsg(err));
    return '';
  }
}

// ─── Memory Consolidation Loop ───

export async function consolidateMemoryInsights(agentId?: string): Promise<string> {
  try {
    // Expire old learnings
    await pool.query(
      `UPDATE agent_learnings SET active = false WHERE active = true AND expires_at < now()`,
    );

    // Deduplicate: mark older rows inactive when a newer row by the same agent+tag
    // has a very similar pattern (prefix match on first 80 chars).
    const scope = agentId
      ? await pool.query(
          `SELECT id, agent_id, tag, LEFT(pattern, 80) AS prefix, created_at
           FROM agent_learnings WHERE active = true AND agent_id = $1
           ORDER BY agent_id, tag, created_at DESC`,
          [agentId],
        )
      : await pool.query(
          `SELECT id, agent_id, tag, LEFT(pattern, 80) AS prefix, created_at
           FROM agent_learnings WHERE active = true
           ORDER BY agent_id, tag, created_at DESC`,
        );

    const seen = new Map<string, number>();
    const toDeactivate: number[] = [];
    for (const row of scope.rows as { id: number; agent_id: string; tag: string; prefix: string }[]) {
      const key = `${row.agent_id}:${row.tag}:${row.prefix}`;
      if (seen.has(key)) {
        toDeactivate.push(row.id);
      } else {
        seen.set(key, row.id);
      }
    }

    if (toDeactivate.length > 0) {
      await pool.query(
        `UPDATE agent_learnings SET active = false WHERE id = ANY($1::bigint[])`,
        [toDeactivate],
      );
    }

    return `Consolidation: expired stale rows, deactivated ${toDeactivate.length} duplicate(s).`;
  } catch (err) {
    console.error('[vectorMemory] consolidateMemoryInsights failed:', errMsg(err));
    return '';
  }
}

export async function recordSmokeInsight(
  categories: string[],
  hasFails: boolean,
  summary: string,
): Promise<void> {
  const insight = `Smoke test result — categories: [${categories.join(', ')}], outcome: ${hasFails ? 'FAILURES' : 'PASS'}. ${summary.slice(0, 400)}`;
  await recordAgentLearning('operations-manager', insight, 'smoke-test', 'self-improvement').catch(() => {});
}

// ─── Cleanup ───

export async function cleanupOldEmbeddings(_retentionDays = 90): Promise<number> {
  try {
    const result = await pool.query(
      `UPDATE agent_learnings SET active = false
       WHERE active = true AND expires_at < now()`,
    );
    return result.rowCount ?? 0;
  } catch (err) {
    console.error('[vectorMemory] cleanupOldEmbeddings failed:', errMsg(err));
    return 0;
  }
}
