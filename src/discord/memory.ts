import { ConversationMessage } from './claude';
import { logAgentEvent } from './activityLog';
import pool from '../db/pool';

/**
 * Persistent memory system for Discord agents.
 * Stores conversation history in PostgreSQL (via agent_memory table) so data
 * survives container restarts and Cloud Run redeployments.
 *
 * Reads are synchronous from an in-memory cache. Writes are debounced
 * and flushed to the database asynchronously.
 *
 * Conversation compression: When history exceeds COMPRESS_THRESHOLD messages,
 * older messages are summarized into a condensed block and only recent messages
 * are kept verbatim — similar to how long chat sessions work in Copilot.
 */

const MAX_MESSAGES = 1000;

/** Number of raw messages before triggering compression */
const COMPRESS_THRESHOLD = 80;
/** Number of recent messages to keep verbatim after compression */
const KEEP_RECENT = 30;
const COMPRESS_STAGE_PARTS = parseInt(process.env.MEMORY_COMPRESS_STAGE_PARTS || '3', 10);
const COMPRESS_STAGE_MIN_MESSAGES = parseInt(process.env.MEMORY_COMPRESS_STAGE_MIN_MESSAGES || '24', 10);
const COMPRESS_STAGE_CHUNK_CHAR_LIMIT = parseInt(process.env.MEMORY_COMPRESS_STAGE_CHUNK_CHAR_LIMIT || '7000', 10);
const MEMORY_PERSIST_MAX_MESSAGE_CHARS = parseInt(process.env.MEMORY_PERSIST_MAX_MESSAGE_CHARS || '3500', 10);
const MEMORY_PERSIST_CODE_BLOCK_CHARS = parseInt(process.env.MEMORY_PERSIST_CODE_BLOCK_CHARS || '900', 10);

/** In-memory cache — primary read source for fast synchronous access */
const memoryCache = new Map<string, ConversationMessage[]>();

/** Pending debounced DB writes — avoids writing on every message */
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

/** Whether initial load from DB has completed */
let initialized = false;

function safeAgentId(agentId: string): string {
  return agentId.replace(/[^a-z0-9-]/gi, '');
}

function trimMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(120, Math.floor(maxChars * 0.7));
  const tail = Math.max(80, maxChars - head - 28);
  return `${text.slice(0, head)}\n…[persisted context trimmed]…\n${text.slice(-tail)}`;
}

function compactPersistedContent(content: string): string {
  let normalized = String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return normalized;

  normalized = normalized.replace(/```([\s\S]*?)```/g, (_match, code) => {
    const inner = trimMiddle(String(code || '').trim(), MEMORY_PERSIST_CODE_BLOCK_CHARS);
    return `\`\`\`\n${inner}\n\`\`\``;
  });

  return trimMiddle(normalized, MEMORY_PERSIST_MAX_MESSAGE_CHARS);
}

function compactPersistedHistory(history: ConversationMessage[]): void {
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (!msg || typeof msg.content !== 'string') continue;
    const compacted = compactPersistedContent(msg.content);
    if (compacted !== msg.content) {
      history[i] = { ...msg, content: compacted };
    }
  }
}

function isLowValueAck(message: ConversationMessage): boolean {
  if (message.role !== 'assistant') return false;
  const text = String(message.content || '').trim().toLowerCase();
  return /^(ok|okay|thanks|thank you|done|noted|understood|got it|will do|sounds good)[.!]?$/.test(text);
}

function compactTranscriptHistory(history: ConversationMessage[]): ConversationMessage[] {
  if (!history.length) return history;
  return history.filter((msg) => !isLowValueAck(msg));
}

/** DB key for conversation history */
function convKey(agentId: string): string {
  return `conv-${safeAgentId(agentId)}`;
}

/** DB key for compression summary */
function summaryKey(agentId: string): string {
  return `summary-${safeAgentId(agentId)}`;
}

/**
 * Initialize memory by loading all conversation histories from the database.
 * Call this once at startup before processing messages.
 */
export async function initMemory(): Promise<void> {
  if (initialized) return;
  try {
    const { rows } = await pool.query(
      `SELECT file_name, content FROM agent_memory WHERE file_name LIKE 'conv-%'`
    );
    for (const row of rows) {
      const agentId = row.file_name.replace(/^conv-/, '');
      try {
        const parsed = JSON.parse(row.content);
        if (Array.isArray(parsed)) {
          const existing = memoryCache.get(agentId);
          if (existing) {
            existing.length = 0;
            existing.push(...(parsed as ConversationMessage[]));
          } else {
            memoryCache.set(agentId, parsed as ConversationMessage[]);
          }
        }
      } catch {
        console.warn(`Corrupt memory for ${agentId}, skipping`);
      }
    }
    const { rows: sumRows } = await pool.query(
      `SELECT file_name, content FROM agent_memory WHERE file_name LIKE 'summary-%'`
    );
    for (const row of sumRows) {
      const agentId = row.file_name.replace(/^summary-/, '');
      summaryCache.set(agentId, row.content);
    }
    initialized = true;
    console.log(`Memory initialized: ${rows.length} conversation(s), ${sumRows.length} summary(ies) loaded from DB`);
  } catch (err) {
    console.error('Failed to initialize memory from DB:', err instanceof Error ? err.message : 'Unknown');
    initialized = true; // Continue with empty cache rather than blocking
  }
}

/**
 * Load conversation history for an agent.
 * Returns from in-memory cache (populated at startup from DB).
 */
export function loadMemory(agentId: string): ConversationMessage[] {
  const cached = memoryCache.get(agentId);
  if (cached) return cached;
  const empty: ConversationMessage[] = [];
  memoryCache.set(agentId, empty);
  return empty;
}

/**
 * Save conversation history for an agent.
 * Updates cache immediately, debounces DB write.
 */
export function saveMemory(agentId: string, history: ConversationMessage[]): void {
  compactPersistedHistory(history);

  if (history.length > MAX_MESSAGES * 2) {
    history.splice(0, history.length - MAX_MESSAGES * 2);
  }
  memoryCache.set(agentId, history);

  const existing = pendingWrites.get(agentId);
  if (existing) clearTimeout(existing);
  pendingWrites.set(
    agentId,
    setTimeout(() => {
      const key = convKey(agentId);
      pool.query(
        `INSERT INTO agent_memory (file_name, content, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (file_name) DO UPDATE SET content = $2, updated_at = NOW()`,
        [key, JSON.stringify(history)]
      ).catch((err) => {
        console.error(`DB write failed for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
      });
      pendingWrites.delete(agentId);
    }, 2000)
  );
}

/**
 * Append messages to an agent's memory and persist.
 */
export function appendToMemory(agentId: string, messages: ConversationMessage[]): void {
  const existing = loadMemory(agentId);
  existing.push(...messages);
  saveMemory(agentId, existing);
}

/**
 * Clear memory for a specific agent.
 */
export function clearMemory(agentId: string): void {
  memoryCache.delete(agentId);
  summaryCache.delete(agentId);
  const cKey = convKey(agentId);
  const sKey = summaryKey(agentId);
  pool.query('DELETE FROM agent_memory WHERE file_name IN ($1, $2)', [cKey, sKey]).catch((err) => {
    console.error(`Failed to clear memory for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
  });
}

/** In-memory summary cache */
const summaryCache = new Map<string, string>();

/** Load the compressed summary for an agent */
function loadSummary(agentId: string): string {
  return summaryCache.get(agentId) || '';
}

/** Save a compressed summary to cache + DB */
function saveSummary(agentId: string, summary: string): void {
  summaryCache.set(agentId, summary);
  const key = summaryKey(agentId);
  pool.query(
    `INSERT INTO agent_memory (file_name, content, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (file_name) DO UPDATE SET content = $2, updated_at = NOW()`,
    [key, summary]
  ).catch((err) => {
    console.error(`Failed to save summary for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
  });
}

/** Track which agents have pending compression to avoid duplicate runs */
const compressionInProgress = new Set<string>();

/**
 * Compress older conversation history into a summary.
 * Keeps the most recent KEEP_RECENT messages verbatim and summarizes the rest.
 * Called automatically when history exceeds COMPRESS_THRESHOLD.
 */
export async function compressMemory(agentId: string): Promise<void> {
  if (compressionInProgress.has(agentId)) return;
  const history = loadMemory(agentId);
  if (history.length < COMPRESS_THRESHOLD) return;

  compressionInProgress.add(agentId);
  const snapshotLen = history.length;
  try {
    const toCompress = compactTranscriptHistory(history.slice(0, snapshotLen - KEEP_RECENT));
    const toKeep = compactTranscriptHistory(history.slice(snapshotLen - KEEP_RECENT));

    const existingSummary = loadSummary(agentId);
    const { summarizeConversation } = await import('./claude');

    const formatMessages = (messages: ConversationMessage[]): string =>
      messages
        .map((m) => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content.slice(0, 300)}`)
        .join('\n');

    const summarizeInStages = async (messages: ConversationMessage[]): Promise<string> => {
      if (messages.length < COMPRESS_STAGE_MIN_MESSAGES || COMPRESS_STAGE_PARTS <= 1) {
        return summarizeConversation(existingSummary, formatMessages(messages), agentId);
      }

      const chunks: ConversationMessage[][] = [];
      const targetChunkSize = Math.max(1, Math.ceil(messages.length / COMPRESS_STAGE_PARTS));
      for (let i = 0; i < messages.length; i += targetChunkSize) {
        chunks.push(messages.slice(i, i + targetChunkSize));
      }

      if (chunks.length <= 1) {
        return summarizeConversation(existingSummary, formatMessages(messages), agentId);
      }

      const partials: string[] = [];
      for (const chunk of chunks) {
        const chunkText = formatMessages(chunk);
        const boundedChunkText = chunkText.length > COMPRESS_STAGE_CHUNK_CHAR_LIMIT
          ? `${chunkText.slice(0, COMPRESS_STAGE_CHUNK_CHAR_LIMIT)}\n[Chunk truncated for staged compression]`
          : chunkText;
        const partial = await summarizeConversation('', boundedChunkText, agentId);
        if (partial.trim()) {
          partials.push(partial.trim());
        }
      }

      const mergedPartialContext = partials
        .map((summary, idx) => `Part ${idx + 1}:\n${summary}`)
        .join('\n\n');
      if (!mergedPartialContext.trim()) {
        return summarizeConversation(existingSummary, formatMessages(messages), agentId);
      }

      return summarizeConversation(existingSummary, mergedPartialContext, agentId);
    };

    const newSummary = await summarizeInStages(toCompress);
    if (newSummary.trim().length < 30) {
      console.warn(`Compression summary too short for ${agentId}; keeping verbatim history`);
      logAgentEvent(agentId, 'response', 'Skipped compression because generated summary was too short');
      return;
    }

    const currentHistory = loadMemory(agentId);
    const newMessagesSinceSnapshot = currentHistory.slice(snapshotLen);

    saveSummary(agentId, newSummary);
    const preserved = [...toKeep, ...newMessagesSinceSnapshot];
    currentHistory.length = 0;
    currentHistory.push(...preserved);
    saveMemory(agentId, currentHistory);
    logAgentEvent(agentId, 'response', `Compressed ${snapshotLen} messages down to ${preserved.length} raw messages plus summary`);
    console.log(`Compressed memory for ${agentId}: ${snapshotLen} → ${preserved.length} messages + summary`);
  } catch (err) {
    logAgentEvent(agentId, 'error', `Memory compression failed: ${err instanceof Error ? err.message : 'Unknown'}`);
    console.error(`Memory compression failed for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
  } finally {
    compressionInProgress.delete(agentId);
  }
}

/**
 * Get a condensed summary of an agent's recent memory for context injection.
 * Returns: [summary as system context] + [recent raw messages]
 * If no summary exists, returns the last N raw messages.
 * Also triggers background compression if history is getting long.
 */
export function getMemoryContext(agentId: string, maxMessages = 20): ConversationMessage[] {
  const history = loadMemory(agentId);

  if (history.length >= COMPRESS_THRESHOLD) {
    compressMemory(agentId).catch(() => {});
  }

  const summary = loadSummary(agentId);
  if (summary) {
    const recent = history.length <= maxMessages
      ? history
      : history.slice(history.length - maxMessages);
    return [
      { role: 'user', content: `[Conversation Summary — earlier context]\n${summary}` },
      ...recent,
    ];
  }

  if (history.length <= maxMessages) return history;
  return history.slice(history.length - maxMessages);
}

/**
 * Flush all pending debounced writes to the database immediately.
 * Call this on graceful shutdown to avoid losing data.
 */
export async function flushPendingWrites(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [agentId, timer] of pendingWrites) {
    clearTimeout(timer);
    const cached = memoryCache.get(agentId);
    if (cached) {
      const key = convKey(agentId);
      promises.push(
        pool.query(
          `INSERT INTO agent_memory (file_name, content, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (file_name) DO UPDATE SET content = $2, updated_at = NOW()`,
          [key, JSON.stringify(cached)]
        ).then(() => {}).catch((err) => {
          console.error(`Flush write failed for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
        })
      );
    }
  }
  pendingWrites.clear();
  await Promise.all(promises);
}

process.on('SIGTERM', () => { flushPendingWrites(); });
process.on('SIGINT', () => { flushPendingWrites(); });
