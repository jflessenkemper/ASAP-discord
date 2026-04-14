import fs from 'fs';
import path from 'path';

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
  { id: 'executive-assistant', name: 'Riley (Executive Assistant)', handle: 'riley', roleName: 'Riley',  aliases: ['executive-assistant', 'executive', 'assistant', 'riley'], emoji: '📋', color: 0x1D4ED8, voice: 'Achernar',  channelName: '📋-executive-assistant' },
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

let memoryCache: string | null | undefined;
export function getRileyMemory(): string | null {
  if (memoryCache === undefined) {
    memoryCache = loadFileFromGithub('riley-memory.md');
  }
  return memoryCache;
}

let agentCache: Map<AgentId, AgentConfig> | null = null;
const agentRoleIds = new Map<AgentId, string>();

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

export { AGENT_IDS };
