import fs from 'fs';
import path from 'path';
import { ConversationMessage } from './claude';

/**
 * Persistent memory system for Discord agents.
 * Stores conversation history as JSON files on disk so agents
 * retain context across bot restarts.
 */

const MEMORY_DIR = process.env.MEMORY_DIR || path.join(process.cwd(), 'data', 'memory');
const MAX_MESSAGES = 100;

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
  try {
    const filePath = memoryPath(agentId);
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed as ConversationMessage[];
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
    // Keep only the most recent messages
    const trimmed = history.length > MAX_MESSAGES * 2
      ? history.slice(history.length - MAX_MESSAGES * 2)
      : history;
    fs.writeFileSync(memoryPath(agentId), JSON.stringify(trimmed, null, 2));
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
export function getMemoryContext(agentId: string, maxMessages = 20): ConversationMessage[] {
  const history = loadMemory(agentId);
  if (history.length <= maxMessages * 2) return history;
  return history.slice(history.length - maxMessages * 2);
}
