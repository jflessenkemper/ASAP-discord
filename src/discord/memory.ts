import fs from 'fs';
import path from 'path';
import { ConversationMessage } from './claude';

/**
 * Persistent memory system for Discord agents.
 * Stores conversation history as JSON files on disk so agents
 * retain context across bot restarts.
 *
 * Conversation compression: When history exceeds COMPRESS_THRESHOLD messages,
 * older messages are summarized into a condensed block and only recent messages
 * are kept verbatim — similar to how long chat sessions work in Copilot.
 */

const MEMORY_DIR = process.env.MEMORY_DIR || path.join(process.cwd(), 'data', 'memory');
const MAX_MESSAGES = 1000;

/** Number of raw messages before triggering compression */
const COMPRESS_THRESHOLD = 60;
/** Number of recent messages to keep verbatim after compression */
const KEEP_RECENT = 20;

/** In-memory cache to avoid reading from disk on every message */
const memoryCache = new Map<string, ConversationMessage[]>();

/** Pending debounced writes — avoids writing to disk on every single message */
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

/** Ensure the memory directory exists */
function ensureDir(): void {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function memoryPath(agentId: string): string {
  // Sanitize agentId to prevent path traversal
  const safe = agentId.replace(/[^a-z0-9-]/gi, '');
  return path.join(MEMORY_DIR, `${safe}.json`);
}

/**
 * Load conversation history for an agent from disk.
 */
export function loadMemory(agentId: string): ConversationMessage[] {
  // Return from cache if available
  const cached = memoryCache.get(agentId);
  if (cached) return cached;

  try {
    const filePath = memoryPath(agentId);
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    const messages = parsed as ConversationMessage[];
    memoryCache.set(agentId, messages);
    return messages;
  } catch (err) {
    console.error(`Failed to load memory for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
    return [];
  }
}

/**
 * Save conversation history for an agent to disk.
 * Automatically trims to MAX_MESSAGES.
 */
export function saveMemory(agentId: string, history: ConversationMessage[]): void {
  try {
    ensureDir();
    const trimmed = history.length > MAX_MESSAGES * 2
      ? history.slice(history.length - MAX_MESSAGES * 2)
      : history;
    memoryCache.set(agentId, trimmed);

    // Debounce disk writes — update cache immediately, write to disk after 2s of inactivity
    const existing = pendingWrites.get(agentId);
    if (existing) clearTimeout(existing);
    pendingWrites.set(
      agentId,
      setTimeout(() => {
        try {
          fs.writeFileSync(memoryPath(agentId), JSON.stringify(trimmed, null, 2));
        } catch (writeErr) {
          console.error(`Deferred write failed for ${agentId}:`, writeErr instanceof Error ? writeErr.message : 'Unknown');
        }
        pendingWrites.delete(agentId);
      }, 2000)
    );
  } catch (err) {
    console.error(`Failed to save memory for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
  }
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
  try {
    memoryCache.delete(agentId);
    summaryCache.delete(agentId);
    const filePath = memoryPath(agentId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    const sumPath = summaryPath(agentId);
    if (fs.existsSync(sumPath)) {
      fs.unlinkSync(sumPath);
    }
  } catch (err) {
    console.error(`Failed to clear memory for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
  }
}

/** In-memory summary cache */
const summaryCache = new Map<string, string>();

function summaryPath(agentId: string): string {
  const safe = agentId.replace(/[^a-z0-9-]/gi, '');
  return path.join(MEMORY_DIR, `${safe}-summary.json`);
}

/** Load the compressed summary for an agent */
function loadSummary(agentId: string): string {
  const cached = summaryCache.get(agentId);
  if (cached !== undefined) return cached;
  try {
    const filePath = summaryPath(agentId);
    if (!fs.existsSync(filePath)) return '';
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const summary = typeof data === 'string' ? data : (data.summary || '');
    summaryCache.set(agentId, summary);
    return summary;
  } catch {
    return '';
  }
}

/** Save a compressed summary */
function saveSummary(agentId: string, summary: string): void {
  summaryCache.set(agentId, summary);
  try {
    ensureDir();
    fs.writeFileSync(summaryPath(agentId), JSON.stringify({ summary, updatedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error(`Failed to save summary for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
  }
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
  // Snapshot the length before async work — new messages may arrive during summarization
  const snapshotLen = history.length;
  try {
    // Split: older messages to compress, recent to keep
    const toCompress = history.slice(0, snapshotLen - KEEP_RECENT);
    const toKeep = history.slice(snapshotLen - KEEP_RECENT);

    // Build the text to summarize
    const existingSummary = loadSummary(agentId);
    const contextToSummarize = toCompress.map(m =>
      `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content.slice(0, 500)}`
    ).join('\n');

    // Lazy import to avoid circular dependency
    const { summarizeConversation } = await import('./claude');
    const newSummary = await summarizeConversation(existingSummary, contextToSummarize, agentId);

    // Preserve any messages that arrived during compression
    const currentHistory = loadMemory(agentId);
    const newMessagesSinceSnapshot = currentHistory.slice(snapshotLen);

    // Save the new summary and replace history with kept + any new messages
    saveSummary(agentId, newSummary);
    const preserved = [...toKeep, ...newMessagesSinceSnapshot];
    // Mutate in place so existing references stay valid
    currentHistory.length = 0;
    currentHistory.push(...preserved);
    saveMemory(agentId, currentHistory);
    console.log(`Compressed memory for ${agentId}: ${snapshotLen} → ${preserved.length} messages + summary`);
  } catch (err) {
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
export function getMemoryContext(agentId: string, maxMessages = 30): ConversationMessage[] {
  const history = loadMemory(agentId);

  // Trigger compression in the background if needed
  if (history.length >= COMPRESS_THRESHOLD) {
    compressMemory(agentId).catch(() => {});
  }

  const summary = loadSummary(agentId);
  if (summary) {
    // Prepend summary as a synthetic context message, then recent history
    const recent = history.length <= maxMessages * 2
      ? history
      : history.slice(history.length - maxMessages * 2);
    return [
      { role: 'user', content: `[Conversation Summary — earlier context]\n${summary}` },
      { role: 'assistant', content: 'Understood, I have this context from our earlier conversation.' },
      ...recent,
    ];
  }

  // No summary yet — return raw recent messages
  if (history.length <= maxMessages * 2) return history;
  return history.slice(history.length - maxMessages * 2);
}

/**
 * Flush all pending debounced writes to disk immediately.
 * Call this on graceful shutdown to avoid losing data.
 */
export function flushPendingWrites(): void {
  for (const [agentId, timer] of pendingWrites) {
    clearTimeout(timer);
    const cached = memoryCache.get(agentId);
    if (cached) {
      try {
        ensureDir();
        fs.writeFileSync(memoryPath(agentId), JSON.stringify(cached, null, 2));
      } catch (err) {
        console.error(`Flush write failed for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
      }
    }
  }
  pendingWrites.clear();
}

// Safety net: flush memory on process termination signals
process.on('SIGTERM', () => { flushPendingWrites(); });
process.on('SIGINT', () => { flushPendingWrites(); });
