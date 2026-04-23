/**
 * Bot presence manager — reflects the current active agent(s) in the bot's
 * Discord status so users can tell at a glance whether Cortana is idle,
 * thinking, or which specialists are working.
 *
 * Discord gives the bot a single presence per token. We rotate the displayed
 * text across whichever agents are currently active (debounced to stay within
 * rate limits). When nothing is running, the bot shows a quiet idle status.
 */

import { ActivityType, Client, PresenceUpdateStatus } from 'discord.js';

import { getAgent } from './agents';
import { errMsg } from '../utils/errors';

const UPDATE_DEBOUNCE_MS = 1500;
const ROTATE_INTERVAL_MS = 6000;

interface ActiveAgent {
  agentId: string;
  label: string;
  sinceMs: number;
}

const activeAgents = new Map<string, ActiveAgent>();
let client: Client | null = null;
let updateTimer: ReturnType<typeof setTimeout> | null = null;
let rotateTimer: ReturnType<typeof setInterval> | null = null;
let rotateIndex = 0;
let lastPresenceText: string | null = null;

function agentDisplay(agentId: string): string {
  const cfg = getAgent(agentId as any);
  if (!cfg) return agentId;
  return `${cfg.emoji} ${cfg.name}`;
}

function setPresenceNow(text: string): void {
  if (!client?.user) return;
  if (text === lastPresenceText) return;
  try {
    client.user.setPresence({
      activities: [{ name: text.slice(0, 128), type: ActivityType.Custom, state: text.slice(0, 128) }],
      status: activeAgents.size > 0 ? PresenceUpdateStatus.Online : PresenceUpdateStatus.Online,
    });
    lastPresenceText = text;
  } catch (err) {
    console.warn('[presence] setPresence failed:', errMsg(err));
  }
}

function renderPresence(): string {
  const list = Array.from(activeAgents.values()).sort((a, b) => a.sinceMs - b.sinceMs);
  if (list.length === 0) return 'Listening in #groupchat';
  if (list.length === 1) {
    const only = list[0];
    return `${agentDisplay(only.agentId)} · ${only.label}`;
  }

  // Rotate through active agents so each gets visibility.
  rotateIndex = (rotateIndex + 1) % list.length;
  const shown = list[rotateIndex];
  return `${agentDisplay(shown.agentId)} · ${shown.label} (+${list.length - 1} more)`;
}

function scheduleUpdate(): void {
  if (updateTimer) return;
  updateTimer = setTimeout(() => {
    updateTimer = null;
    setPresenceNow(renderPresence());
  }, UPDATE_DEBOUNCE_MS);
}

export function initPresence(discordClient: Client): void {
  client = discordClient;
  // Initial idle state.
  setPresenceNow('Listening in #groupchat');
  // Rotate through active agents periodically so multi-agent fan-outs cycle.
  if (!rotateTimer) {
    rotateTimer = setInterval(() => {
      if (activeAgents.size > 1) setPresenceNow(renderPresence());
    }, ROTATE_INTERVAL_MS);
  }
}

export function shutdownPresence(): void {
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  activeAgents.clear();
  client = null;
  lastPresenceText = null;
}

/** Mark an agent as actively working with a short label (e.g., "reviewing PR"). */
export function trackAgentActive(agentId: string, label: string): void {
  activeAgents.set(agentId, { agentId, label: label.slice(0, 40), sinceMs: Date.now() });
  scheduleUpdate();
}

/** Mark an agent as no longer working. */
export function trackAgentIdle(agentId: string): void {
  if (!activeAgents.delete(agentId)) return;
  scheduleUpdate();
}

/** Reset everything — used when a turn aborts or on shutdown. */
export function clearAllActive(): void {
  activeAgents.clear();
  scheduleUpdate();
}
