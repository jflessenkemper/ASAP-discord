/**
 * Unified per-turn status tracker.
 *
 * A single Discord message shows Cortana's state plus a nested per-sub-agent
 * section, each with its own tool chain. Replaces the older pattern of
 * one "thinking" message plus separate tool-chain messages per agent.
 *
 * Lifecycle:
 *   const t = await beginTurn(channel, rileyAgent);
 *   t.setPhase('executive-assistant', 'planning', 'thinking about it');
 *   t.addTool('executive-assistant', 'search_files', 'src/foo', 'start');
 *   t.setPhase('qa', 'working', 'running smoke tests', maxAgent);
 *   t.addTool('qa', 'run_tests', 'smoke', 'done');
 *   t.setPhase('executive-assistant', 'done');
 *   await t.finalize('Here is the final answer.');
 */

import { Message } from 'discord.js';

import { AgentConfig } from './agents';
import { sendWebhookMessage, editWebhookMessage, WebhookCapableChannel } from './services/webhooks';
import { ToolChainTracker } from './services/discordOutputSanitizer';
import { errMsg } from '../utils/errors';

export type AgentPhase = 'queued' | 'planning' | 'working' | 'done' | 'error';

interface AgentSection {
  agent: AgentConfig;
  phase: AgentPhase;
  label: string;
  toolChain: ToolChainTracker;
  startedAt: number;
}

const MAX_MESSAGE_CHARS = 1900;
const EDIT_DEBOUNCE_MS = Math.max(200, parseInt(process.env.TURN_TRACKER_EDIT_DEBOUNCE_MS || '400', 10));
const MAX_AGENT_TOOLS_VISIBLE = Math.max(3, parseInt(process.env.TURN_TRACKER_MAX_TOOLS || '6', 10));

/**
 * Map an agent config to the short name we show in the header.
 * Prefers the short role name (e.g. "Cortana") over the verbose display name
 * (e.g. "Cortana (Executive Assistant)") so the composite message stays readable.
 */
function shortName(agent: AgentConfig): string {
  const role = (agent as unknown as { roleName?: string }).roleName;
  if (role && role.trim()) return role.trim();
  const name = agent.name || agent.id;
  // Strip trailing " (Role)" parenthetical if no roleName is available.
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Text marker for each phase. No decorative emoji — the phase is already
 * said in words via the label, and the webhook avatar identifies the agent.
 * The only glyph we keep is the done-check, because it's a useful scan cue.
 */
function phaseMarker(phase: AgentPhase): string {
  switch (phase) {
    case 'queued':   return 'queued';
    case 'planning': return 'planning';
    case 'working':  return 'working';
    case 'done':     return 'done';
    case 'error':    return 'error';
  }
}

export class TurnTracker {
  readonly channel: WebhookCapableChannel;
  readonly owner: AgentConfig;
  private sections: Map<string, AgentSection> = new Map();
  private message: Message | null = null;
  private finalized = false;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRender = false;

  constructor(channel: WebhookCapableChannel, owner: AgentConfig) {
    this.channel = channel;
    this.owner = owner;
  }

  /** Set or update the phase + short label for a given agent's section. */
  setPhase(agentId: string, phase: AgentPhase, label = '', agent?: AgentConfig): void {
    if (this.finalized) return;
    let section = this.sections.get(agentId);
    if (!section) {
      if (!agent) return; // Need an agent config to render a new section; skip silently.
      section = {
        agent,
        phase,
        label,
        toolChain: new ToolChainTracker(),
        startedAt: Date.now(),
      };
      this.sections.set(agentId, section);
    } else {
      section.phase = phase;
      if (label) section.label = label;
    }
    this.scheduleRender();
  }

  /** Record a tool start/complete on an agent's section. */
  addTool(agentId: string, toolName: string, summary: string, status: 'start' | 'done', agent?: AgentConfig): void {
    if (this.finalized) return;
    let section = this.sections.get(agentId);
    if (!section) {
      if (!agent) return;
      section = {
        agent,
        phase: 'working',
        label: '',
        toolChain: new ToolChainTracker(),
        startedAt: Date.now(),
      };
      this.sections.set(agentId, section);
    }
    if (status === 'start') section.toolChain.startTool(toolName, summary);
    else section.toolChain.completeTool(toolName, summary);
    this.scheduleRender();
  }

  /**
   * Render one section's tool chain as a list of lines with a caller-supplied
   * indent prefix. No per-tool emoji; only the " ✓" done-marker survives.
   */
  private renderToolLines(section: AgentSection, maxVisible: number, indent: string): string[] {
    const entries = section.toolChain.snapshot();
    if (entries.length === 0) return [];

    const visible = entries.length <= maxVisible
      ? entries
      : entries.slice(-maxVisible);
    const hidden = entries.length - visible.length;

    const lines = visible.map((e) => {
      const suffix = e.status === 'done' ? ' ✓' : '';
      return `${indent}• ${e.summary}${suffix}`;
    });
    if (hidden > 0) {
      lines.unshift(`${indent}• _(${hidden} earlier step${hidden === 1 ? '' : 's'})_`);
    }
    return lines;
  }

  private renderHeader(section: AgentSection): string {
    const name = shortName(section.agent);
    const label = section.label || phaseMarker(section.phase);
    return section.phase === 'done'
      ? `**${name}** — ${label} ✓`
      : `**${name}** — ${label}`;
  }

  /**
   * Render the composite message body.
   *
   * Layout: Cortana (the owner) is top-level. Sub-agents are indented under
   * her as a nested tree so it reads as one coordinated action, not a
   * flat list of peers.
   *
   *   **Cortana** — consulting Argus and Aphrodite
   *     • searched src/foo ✓
   *     ↳ **Argus** — working
   *         • run_tests smoke ✓
   *     ↳ **Aphrodite** — done ✓
   *         • capture_screenshots ✓
   */
  private renderBody(): string {
    const ownerSection = this.sections.get(this.owner.id);
    const subAgents: AgentSection[] = [];
    for (const [id, s] of this.sections) {
      if (id !== this.owner.id) subAgents.push(s);
    }

    const lines: string[] = [];

    if (ownerSection) {
      lines.push(this.renderHeader(ownerSection));
      lines.push(...this.renderToolLines(ownerSection, MAX_AGENT_TOOLS_VISIBLE, '  '));
    } else if (subAgents.length === 0) {
      return `**${shortName(this.owner)}** — thinking…`;
    } else {
      // Owner section missing but sub-agents exist — add a synthetic header
      // so the tree has a root.
      lines.push(`**${shortName(this.owner)}** — coordinating`);
    }

    for (const section of subAgents) {
      lines.push(`  ↳ ${this.renderHeader(section)}`);
      lines.push(...this.renderToolLines(section, MAX_AGENT_TOOLS_VISIBLE, '      '));
    }

    const body = lines.join('\n');
    if (body.length <= MAX_MESSAGE_CHARS) return body;
    return body.slice(0, MAX_MESSAGE_CHARS - 1) + '…';
  }

  private scheduleRender(): void {
    if (this.finalized) return;
    this.pendingRender = true;
    if (this.editTimer) return;
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      if (this.pendingRender) {
        this.pendingRender = false;
        void this.flushRender();
      }
    }, EDIT_DEBOUNCE_MS);
  }

  private async flushRender(): Promise<void> {
    if (this.finalized) return;
    const body = this.renderBody();
    try {
      if (!this.message) {
        this.message = await sendWebhookMessage(this.channel, {
          content: body,
          username: shortName(this.owner),
          avatarURL: this.owner.avatarUrl,
        });
      } else {
        await editWebhookMessage(this.channel, this.message.id, body);
      }
    } catch (err) {
      console.warn('[turnTracker] flushRender failed:', errMsg(err));
    }
  }

  /** Convert the composite status into the final answer (edit in place). */
  async finalize(finalContent: string): Promise<Message | null> {
    if (this.finalized) return this.message;
    this.finalized = true;
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    const content = finalContent.length > MAX_MESSAGE_CHARS
      ? finalContent.slice(0, MAX_MESSAGE_CHARS - 1) + '…'
      : finalContent;

    if (!this.message) {
      try {
        return await sendWebhookMessage(this.channel, {
          content,
          username: shortName(this.owner),
          avatarURL: this.owner.avatarUrl,
        });
      } catch (err) {
        console.warn('[turnTracker] finalize send failed:', errMsg(err));
        return null;
      }
    }

    try {
      const edited = await editWebhookMessage(this.channel, this.message.id, content);
      return edited ?? this.message;
    } catch (err) {
      console.warn('[turnTracker] finalize edit failed:', errMsg(err));
      return this.message;
    }
  }

  /** Delete the status message — used when a fresh message will carry the final answer. */
  async remove(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    if (this.message) {
      await this.message.delete().catch(() => {});
    }
  }

  get isFinalized(): boolean { return this.finalized; }
  get underlyingMessage(): Message | null { return this.message; }
}

export async function beginTurn(
  channel: WebhookCapableChannel,
  owner: AgentConfig,
): Promise<TurnTracker> {
  const tracker = new TurnTracker(channel, owner);
  // Seed the owner section so the user sees "Cortana · thinking" immediately.
  tracker.setPhase(owner.id, 'planning', 'thinking…', owner);
  return tracker;
}
