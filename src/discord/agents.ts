import fs from 'fs';
import path from 'path';

import pool from '../db/pool';
import { errMsg } from '../utils/errors';

export interface AgentConfig {
  id: string;
  name: string;
  /** Short canonical handle used in plain-text fallback mentions */
  handle: string;
  /** Discord role name used for native role mentions */
  roleName: string;
  /** Alias tokens accepted by the router (without leading @) */
  aliases: string[];
  channelName: string;
  emoji: string;
  /** Hex color for Discord embeds */
  color: number;
  /** Gemini TTS voice name */
  voice: string;
  /** Avatar URL for webhook identity */
  avatarUrl: string;
  /** System prompt loaded from .agent.md file */
  systemPrompt: string;
}

const AVATAR_BASE = 'https://storage.googleapis.com/asap-bot-assets/avatars';

/**
 * Single source of truth for all agent configuration.
 * Every agent property lives here — no separate maps to keep in sync.
 */
const AGENT_REGISTRY = [
  { id: 'qa',                  name: 'Max (QA)',                  handle: 'max',     roleName: 'Max',    aliases: ['qa', 'max'],                                          emoji: '🧪',  color: 0x50C878, voice: 'Kore',      channelName: '🧪-qa' },
  { id: 'ux-reviewer',         name: 'Sophie (UX Reviewer)',      handle: 'sophie',  roleName: 'Sophie', aliases: ['ux-reviewer', 'ux', 'sophie'],                        emoji: '🎨',  color: 0x303F9F, voice: 'Puck',      channelName: '🎨-ux-reviewer' },
  { id: 'security-auditor',    name: 'Kane (Security Auditor)',   handle: 'kane',    roleName: 'Kane',   aliases: ['security-auditor', 'security', 'kane'],               emoji: '🔒',  color: 0x1F2937, voice: 'Charon',    channelName: '🔒-security-auditor' },
  { id: 'api-reviewer',        name: 'Raj (API Reviewer)',        handle: 'raj',     roleName: 'Raj',    aliases: ['api-reviewer', 'api', 'raj'],                         emoji: '📡',  color: 0x708090, voice: 'Fenrir',    channelName: '📡-api-reviewer' },
  { id: 'dba',                 name: 'Elena (DBA)',               handle: 'elena',   roleName: 'Elena',  aliases: ['dba', 'database', 'elena'],                           emoji: '🗄️', color: 0x7C3AED, voice: 'Leda',      channelName: '🗄️-dba' },
  { id: 'performance',         name: 'Kai (Performance)',         handle: 'kai',     roleName: 'Kai',    aliases: ['performance', 'perf', 'kai'],                         emoji: '⚡',  color: 0x0EA5E9, voice: 'Orus',      channelName: '⚡-performance' },
  { id: 'devops',              name: 'Jude (DevOps)',             handle: 'jude',    roleName: 'Jude',   aliases: ['devops', 'ops', 'jude'],                              emoji: '🚀',  color: 0x4338CA, voice: 'Vale',      channelName: '🚀-devops' },
  { id: 'copywriter',          name: 'Liv (Copywriter)',          handle: 'liv',     roleName: 'Liv',    aliases: ['copywriter', 'copy', 'liv'],                          emoji: '✍️',  color: 0x0F766E, voice: 'Zephyr',    channelName: '✍️-copywriter' },
  { id: 'developer',           name: 'Ace (Developer)',           handle: 'ace',     roleName: 'Ace',    aliases: ['developer', 'dev', 'ace'],                            emoji: '💻',  color: 0x4682B4, voice: 'Achernar',  channelName: '💻-developer' },
  { id: 'lawyer',              name: 'Harper (Lawyer)',           handle: 'harper',  roleName: 'Harper', aliases: ['lawyer', 'legal', 'harper'],                          emoji: '⚖️',  color: 0x14532D, voice: 'Sulafat',   channelName: '⚖️-lawyer' },
  { id: 'executive-assistant', name: 'Riley (Executive Assistant)', handle: 'riley', roleName: 'Riley',  aliases: ['executive-assistant', 'executive', 'assistant', 'riley'], emoji: '📋', color: 0x1D4ED8, voice: 'RileyEL',   channelName: '📋-executive-assistant' },
  { id: 'ios-engineer',        name: 'Mia (iOS Engineer)',        handle: 'mia',     roleName: 'Mia',    aliases: ['ios-engineer', 'ios', 'mia'],                         emoji: '🍎',  color: 0xF97316, voice: 'Enceladus', channelName: '🍎-ios-engineer' },
  { id: 'android-engineer',    name: 'Leo (Android Engineer)',    handle: 'leo',     roleName: 'Leo',    aliases: ['android-engineer', 'android', 'leo'],                 emoji: '🤖',  color: 0x16A34A, voice: 'Iapetus',   channelName: '🤖-android-engineer' },
] as const;

const AGENT_IDS = AGENT_REGISTRY.map((a) => a.id) as unknown as readonly AgentId[];

export type AgentId = (typeof AGENT_REGISTRY)[number]['id'];

/** Resolve the .github directory for loading agent prompts and personality files. */
function resolveGithubDir(): string | null {
  const candidates = [
    path.join(process.cwd(), '.github'),
    path.join(__dirname, '..', '..', '..', '.github'),
    path.join(__dirname, '..', '..', '..', '..', '.github'),
    path.join('/app', '.github'),
  ];
  for (const dir of candidates) {
    try {
      fs.accessSync(dir, fs.constants.R_OK);
      return dir;
    } catch { /* skip */ }
  }
  return null;
}

let resolvedGithubDir: string | null | undefined;
function getGithubDir(): string | null {
  if (resolvedGithubDir === undefined) resolvedGithubDir = resolveGithubDir();
  return resolvedGithubDir;
}

function loadFileFromGithub(...segments: string[]): string | null {
  const dir = getGithubDir();
  if (!dir) return null;
  try {
    return fs.readFileSync(path.join(dir, ...segments), 'utf-8');
  } catch { return null; }
}

function loadSystemPrompt(agentId: string): string {
  const content = loadFileFromGithub('agents', `${agentId}.agent.md`);
  if (content) {
    return content.replace(/^---[\s\S]*?---\n*/, '').trim();
  }
  const entry = AGENT_REGISTRY.find((a) => a.id === agentId);
  console.warn(`Could not load system prompt for agent: ${agentId}`);
  return `You are the ${entry?.name || agentId} agent for the ASAP project.`;
}

let personalityCache: string | null | undefined;
export function getRileyPersonality(): string | null {
  if (personalityCache === undefined) {
    personalityCache = loadFileFromGithub('riley-personality.md');
  }
  return personalityCache;
}

/** Extract owner_name from riley-personality.md. Falls back to env var or 'Jordan'. */
export function getOwnerName(): string {
  if (process.env.OWNER_NAME) return process.env.OWNER_NAME;
  const personality = getRileyPersonality();
  if (personality) {
    const match = personality.match(/^owner_name:\s*(.+)$/m);
    if (match) return match[1].trim();
  }
  return 'Jordan';
}

/** Extract owner_email from riley-personality.md. Falls back to env var. */
export function getOwnerEmail(): string {
  if (process.env.OWNER_EMAIL) return process.env.OWNER_EMAIL;
  const personality = getRileyPersonality();
  if (personality) {
    const match = personality.match(/^owner_email:\s*(.+)$/m);
    if (match) return match[1].trim();
  }
  return 'jordan.flessenkemper@gmail.com';
}

let memoryCache: string | null | undefined;
export function getRileyMemory(): string | null {
  if (memoryCache === undefined) {
    memoryCache = loadFileFromGithub('riley-memory.md');
  }
  return memoryCache;
}

let agentCache: Map<AgentId, AgentConfig> | null = null;
const agentRoleIds = new Map<AgentId, string>();
const dynamicAgents = new Map<string, AgentConfig>();

const DYNAMIC_AGENTS_DB_KEY = 'dynamic-agent-registry';
let dynamicAgentDbDisabled = false;

async function persistDynamicAgents(): Promise<void> {
  if (dynamicAgentDbDisabled) return;
  try {
    const configs = [...dynamicAgents.values()].map(a => ({
      id: a.id,
      name: a.name,
      handle: a.handle,
      emoji: a.emoji,
      color: a.color,
      voice: a.voice,
      systemPrompt: a.systemPrompt,
    }));
    await pool.query(
      `INSERT INTO agent_memory (file_name, content, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (file_name) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
      [DYNAMIC_AGENTS_DB_KEY, JSON.stringify(configs)]
    );
  } catch (err) {
    if (String((err as any)?.code) === '42501') {
      dynamicAgentDbDisabled = true;
      console.warn('[agent-lifecycle] DB persistence disabled: permission denied');
      return;
    }
    console.warn('[agent-lifecycle] Failed to persist dynamic agents:', errMsg(err));
  }
}

export async function loadDynamicAgentsFromDb(): Promise<number> {
  if (dynamicAgentDbDisabled) return 0;
  try {
    const res = await pool.query(
      'SELECT content FROM agent_memory WHERE file_name = $1',
      [DYNAMIC_AGENTS_DB_KEY]
    );
    if (!res.rows || res.rows.length === 0) return 0;

    const configs = JSON.parse(res.rows[0].content);
    if (!Array.isArray(configs)) return 0;

    let loaded = 0;
    for (const config of configs) {
      if (dynamicAgents.has(config.id) || AGENT_REGISTRY.some(a => a.id === config.id)) continue;
      dynamicAgents.set(config.id, {
        id: config.id,
        name: config.name,
        handle: config.handle,
        roleName: config.name.split(' ')[0],
        aliases: [config.id, config.handle],
        channelName: `${config.emoji}-${config.id}`,
        emoji: config.emoji,
        color: config.color || 0x888888,
        voice: config.voice || 'Kore',
        avatarUrl: `${AVATAR_BASE}/default.png`,
        systemPrompt: config.systemPrompt,
      });
      loaded++;
    }
    if (loaded > 0) {
      agentCache = null;
      console.log(`[agent-lifecycle] Loaded ${loaded} dynamic agent(s) from DB`);
    }
    return loaded;
  } catch (err) {
    if (String((err as any)?.code) === '42501') {
      dynamicAgentDbDisabled = true;
    }
    console.warn('[agent-lifecycle] Failed to load dynamic agents:', errMsg(err));
    return 0;
  }
}

export function getAgents(): Map<AgentId, AgentConfig> {
  if (agentCache) return agentCache;

  agentCache = new Map();
  let loadErrors = 0;
  for (const entry of AGENT_REGISTRY) {
    const systemPrompt = loadSystemPrompt(entry.id);
    if (systemPrompt.startsWith('You are the ')) loadErrors++;
    agentCache.set(entry.id as AgentId, {
      id: entry.id,
      name: entry.name,
      handle: entry.handle,
      roleName: entry.roleName,
      aliases: [...entry.aliases],
      channelName: entry.channelName,
      emoji: entry.emoji,
      color: entry.color,
      voice: entry.voice,
      avatarUrl: `${AVATAR_BASE}/${entry.id}.png`,
      systemPrompt,
    });
  }
  if (loadErrors > 0) {
    console.warn(`⚠️ ${loadErrors}/${AGENT_REGISTRY.length} agent prompts could not be loaded from .agent.md files`);
  }
  for (const [id, agent] of dynamicAgents) {
    agentCache.set(id as AgentId, agent);
  }
  return agentCache;
}

export function getAgent(id: AgentId): AgentConfig | undefined {
  return getAgents().get(id);
}

export function setAgentRoleId(id: AgentId, roleId: string | null): void {
  if (roleId) {
    agentRoleIds.set(id, roleId);
    return;
  }
  agentRoleIds.delete(id);
}

export function getAgentRoleId(id: AgentId): string | null {
  return agentRoleIds.get(id) || null;
}

export function getAgentMention(id: AgentId): string {
  const roleId = getAgentRoleId(id);
  if (roleId) return `<@&${roleId}>`;
  const agent = getAgent(id);
  return agent ? `@${agent.handle}` : `@${id}`;
}

export function getAgentAliases(id: AgentId): string[] {
  const agent = getAgent(id);
  if (!agent) return [id];
  return [...new Set([id, agent.handle, ...agent.aliases])];
}

function normalizeAgentToken(token: string): string {
  return token.trim().replace(/^@+/, '').toLowerCase();
}

export function resolveAgentId(token: string): AgentId | null {
  const normalized = normalizeAgentToken(token);
  for (const [id, agent] of getAgents()) {
    if (normalized === id) return id;
    if (normalized === agent.handle.toLowerCase()) return id;
    if (normalized === agent.roleName.toLowerCase()) return id;
    if (agent.aliases.some((alias) => alias.toLowerCase() === normalized)) return id;
  }
  return null;
}

export function resolveAgentIdByRoleId(roleId: string): AgentId | null {
  for (const [id, mappedRoleId] of agentRoleIds.entries()) {
    if (mappedRoleId === roleId) return id;
  }
  return null;
}

export function buildAgentMentionGuide(agentIds?: Iterable<AgentId>): string {
  const ids = agentIds ? [...agentIds] : [...getAgents().keys()];
  return ids
    .map((id) => {
      const agent = getAgent(id);
      if (!agent) return null;
      return `${agent.name.split(' ')[0]} ${getAgentMention(id)}`;
    })
    .filter((line): line is string => !!line)
    .join(', ');
}

export function getAgentByChannelName(channelName: string): AgentConfig | undefined {
  const normalized = channelName.toLowerCase();
  const stripped = normalized.replace(/^[^a-z0-9]+/, '');
  for (const agent of getAgents().values()) {
    const canonical = agent.channelName.toLowerCase();
    const canonicalStripped = canonical.replace(/^[^a-z0-9]+/, '');
    if (canonical === normalized || canonicalStripped === stripped || agent.id === normalized || agent.id === stripped) return agent;
  }
  return undefined;
}

export function createDynamicAgent(config: {
  id: string;
  name: string;
  handle: string;
  emoji: string;
  systemPrompt: string;
  color?: number;
  voice?: string;
}): AgentConfig {
  if (AGENT_REGISTRY.some(a => a.id === config.id)) {
    throw new Error(`Agent ID "${config.id}" conflicts with a static agent`);
  }
  const agent: AgentConfig = {
    id: config.id,
    name: config.name,
    handle: config.handle,
    roleName: config.name.split(' ')[0],
    aliases: [config.id, config.handle],
    channelName: `${config.emoji}-${config.id}`,
    emoji: config.emoji,
    color: config.color || 0x888888,
    voice: config.voice || 'Kore',
    avatarUrl: `${AVATAR_BASE}/default.png`,
    systemPrompt: config.systemPrompt,
  };
  dynamicAgents.set(config.id, agent);
  agentCache = null;
  void persistDynamicAgents();
  console.log(`[agent-lifecycle] Created dynamic agent: ${config.id} (${config.name})`);
  return agent;
}

export function destroyDynamicAgent(id: string): boolean {
  if (AGENT_REGISTRY.some(a => a.id === id)) {
    throw new Error(`Cannot destroy static agent "${id}"`);
  }
  const removed = dynamicAgents.delete(id);
  if (removed) {
    agentCache = null;
    // Archive memory instead of deleting (rename keys so they're preserved)
    pool.query(
      `UPDATE agent_memory SET file_name = 'archived-' || file_name, updated_at = NOW()
       WHERE file_name IN ($1, $2) AND file_name NOT LIKE 'archived-%'`,
      [`conv-${id}`, `summary-${id}`]
    ).catch((err) => {
      console.warn(`[agent-lifecycle] Failed to archive memory for ${id}:`, errMsg(err));
    });
    void persistDynamicAgents();
    console.log(`[agent-lifecycle] Destroyed dynamic agent: ${id} (memory archived)`);
  }
  return removed;
}

export function listDynamicAgents(): AgentConfig[] {
  return [...dynamicAgents.values()];
}

export { AGENT_IDS };
