import fs from 'fs';
import path from 'path';
import { ConversationMessage } from './claude';

/**
 * Persistent memory system for Discord agents.
 * Stores conversation history as JSON files on disk so agents
 * retain context across bot restarts.
 */

const MEMORY_DIR = process.env.MEMORY_DIR || path.join(process.cwd(), 'data', 'memory');
const MAX_MESSAGES = 1000;

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
    const filePath = memoryPath(agentId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(`Failed to clear memory for ${agentId}:`, err instanceof Error ? err.message : 'Unknown');
  }
}

/**
 * Get a condensed summary of an agent's recent memory for context injection.
 * Returns the last N messages formatted as context.
 */
export function getMemoryContext(agentId: string, maxMessages = 30): ConversationMessage[] {
  const history = loadMemory(agentId);
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
