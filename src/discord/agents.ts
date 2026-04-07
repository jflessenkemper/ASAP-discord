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

const VOICE_MAP: Record<string, string> = {
  qa: 'Kore',
  'ux-reviewer': 'Puck',
  'security-auditor': 'Charon',
  'api-reviewer': 'Fenrir',
  dba: 'Leda',
  performance: 'Orus',
  devops: 'Vale',
  copywriter: 'Zephyr',
  developer: 'Achernar',
  lawyer: 'Sulafat',
  'executive-assistant': 'Achernar',
  'ios-engineer': 'Enceladus',
  'android-engineer': 'Iapetus',
};

const EMOJI_MAP: Record<string, string> = {
  qa: '🧪',
  'ux-reviewer': '🎨',
  'security-auditor': '🔒',
  'api-reviewer': '📡',
  dba: '🗄️',
  performance: '⚡',
  devops: '🚀',
  copywriter: '✍️',
  developer: '💻',
  lawyer: '⚖️',
  'executive-assistant': '📋',
  'ios-engineer': '🍎',
  'android-engineer': '🤖',
};

const COLOR_MAP: Record<string, number> = {
  'executive-assistant': 0x3454D1,
  developer:            0x16A34A,
  qa:                   0xC62828,
  'ux-reviewer':        0x0F766E,
  'security-auditor':   0x374151,
  'api-reviewer':       0x1D4ED8,
  dba:                  0xB45309,
  performance:          0x0E7490,
  devops:               0x4338CA,
  copywriter:           0xBE185D,
  lawyer:               0x475569,
  'ios-engineer':       0x64748B,
  'android-engineer':   0x15803D,
};

/**
 * Agent avatar URLs.
 * Use ui-avatars for high-availability webhook avatar rendering.
 */
const AVATAR_MAP: Record<string, string> = {
  qa:                    'https://ui-avatars.com/api/?name=Max+QA+Flask&background=C62828&color=FFFFFF&size=256&bold=true&format=png',
  'ux-reviewer':         'https://ui-avatars.com/api/?name=Sophie+UX+Compass&background=0F766E&color=FFFFFF&size=256&bold=true&format=png',
  'security-auditor':    'https://ui-avatars.com/api/?name=Kane+Security+Shield&background=374151&color=FDE047&size=256&bold=true&format=png',
  'api-reviewer':        'https://ui-avatars.com/api/?name=Raj+API+Pulse&background=1D4ED8&color=FFFFFF&size=256&bold=true&format=png',
  dba:                   'https://ui-avatars.com/api/?name=Elena+DBA+Stack&background=B45309&color=FFFFFF&size=256&bold=true&format=png',
  performance:           'https://ui-avatars.com/api/?name=Kai+Perf+Bolt&background=0E7490&color=FFFFFF&size=256&bold=true&format=png',
  devops:                'https://ui-avatars.com/api/?name=Jude+DevOps+Rocket&background=4338CA&color=FFFFFF&size=256&bold=true&format=png',
  copywriter:            'https://ui-avatars.com/api/?name=Liv+Copy+Quill&background=BE185D&color=FFFFFF&size=256&bold=true&format=png',
  developer:             'https://ui-avatars.com/api/?name=Ace+Developer+Code&background=16A34A&color=FFFFFF&size=256&bold=true&format=png',
  lawyer:                'https://ui-avatars.com/api/?name=Harper+Law+Scale&background=475569&color=FFFFFF&size=256&bold=true&format=png',
  'executive-assistant': 'https://ui-avatars.com/api/?name=Riley+EA+Checklist&background=3454D1&color=FFFFFF&size=256&bold=true&format=png',
  'ios-engineer':        'https://ui-avatars.com/api/?name=Mia+iOS+Orbit&background=64748B&color=FFFFFF&size=256&bold=true&format=png',
  'android-engineer':    'https://ui-avatars.com/api/?name=Leo+Android+Bot&background=15803D&color=FFFFFF&size=256&bold=true&format=png',
};

const DISPLAY_NAME: Record<string, string> = {
  qa: 'Max (QA)',
  'ux-reviewer': 'Sophie (UX Reviewer)',
  'security-auditor': 'Kane (Security Auditor)',
  'api-reviewer': 'Raj (API Reviewer)',
  dba: 'Elena (DBA)',
  performance: 'Kai (Performance)',
  devops: 'Jude (DevOps)',
  copywriter: 'Liv (Copywriter)',
  developer: 'Ace (Developer)',
  lawyer: 'Harper (Lawyer)',
  'executive-assistant': 'Riley (Executive Assistant)',
  'ios-engineer': 'Mia (iOS Engineer)',
  'android-engineer': 'Leo (Android Engineer)',
};

const HANDLE_MAP: Record<string, string> = {
  qa: 'max',
  'ux-reviewer': 'sophie',
  'security-auditor': 'kane',
  'api-reviewer': 'raj',
  dba: 'elena',
  performance: 'kai',
  devops: 'jude',
  copywriter: 'liv',
  developer: 'ace',
  lawyer: 'harper',
  'executive-assistant': 'riley',
  'ios-engineer': 'mia',
  'android-engineer': 'leo',
};

const ROLE_NAME_MAP: Record<string, string> = {
  qa: 'Max',
  'ux-reviewer': 'Sophie',
  'security-auditor': 'Kane',
  'api-reviewer': 'Raj',
  dba: 'Elena',
  performance: 'Kai',
  devops: 'Jude',
  copywriter: 'Liv',
  developer: 'Ace',
  lawyer: 'Harper',
  'executive-assistant': 'Riley',
  'ios-engineer': 'Mia',
  'android-engineer': 'Leo',
};

const ALIAS_MAP: Record<string, string[]> = {
  qa: ['qa', 'max'],
  'ux-reviewer': ['ux-reviewer', 'ux', 'sophie'],
  'security-auditor': ['security-auditor', 'security', 'kane'],
  'api-reviewer': ['api-reviewer', 'api', 'raj'],
  dba: ['dba', 'database', 'elena'],
  performance: ['performance', 'perf', 'kai'],
  devops: ['devops', 'ops', 'jude'],
  copywriter: ['copywriter', 'copy', 'liv'],
  developer: ['developer', 'dev', 'ace'],
  lawyer: ['lawyer', 'legal', 'harper'],
  'executive-assistant': ['executive-assistant', 'executive', 'assistant', 'riley'],
  'ios-engineer': ['ios-engineer', 'ios', 'mia'],
  'android-engineer': ['android-engineer', 'android', 'leo'],
};

const CHANNEL_NAME_MAP: Record<string, string> = {
  qa: '🧪-qa',
  'ux-reviewer': '🎨-ux-reviewer',
  'security-auditor': '🔒-security-auditor',
  'api-reviewer': '📡-api-reviewer',
  dba: '🗄️-dba',
  performance: '⚡-performance',
  devops: '🚀-devops',
  copywriter: '✍️-copywriter',
  developer: '💻-developer',
  lawyer: '⚖️-lawyer',
  'executive-assistant': '📋-executive-assistant',
  'ios-engineer': '🍎-ios-engineer',
  'android-engineer': '🤖-android-engineer',
};

function loadSystemPrompt(agentId: string): string {
  const candidates = [
    path.join(__dirname, '..', '..', '..', '.github', 'agents', `${agentId}.agent.md`),
    path.join('/app', '.github', 'agents', `${agentId}.agent.md`),
  ];

  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const stripped = content.replace(/^---[\s\S]*?---\n*/, '');
      return stripped.trim();
    } catch {
    }
  }

  console.warn(`Could not load system prompt for agent: ${agentId}`);
  return `You are the ${DISPLAY_NAME[agentId] || agentId} agent for the ASAP project.`;
}

const AGENT_IDS = [
  'qa',
  'ux-reviewer',
  'security-auditor',
  'api-reviewer',
  'dba',
  'performance',
  'devops',
  'copywriter',
  'developer',
  'lawyer',
  'executive-assistant',
  'ios-engineer',
  'android-engineer',
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

let agentCache: Map<AgentId, AgentConfig> | null = null;
const agentRoleIds = new Map<AgentId, string>();

export function getAgents(): Map<AgentId, AgentConfig> {
  if (agentCache) return agentCache;

  agentCache = new Map();
  let loadErrors = 0;
  for (const id of AGENT_IDS) {
    const emoji = EMOJI_MAP[id] || '🤖';
    const systemPrompt = loadSystemPrompt(id);
    if (systemPrompt.startsWith('You are the ')) loadErrors++;
    agentCache.set(id, {
      id,
      name: DISPLAY_NAME[id] || id,
      handle: HANDLE_MAP[id] || id,
      roleName: ROLE_NAME_MAP[id] || DISPLAY_NAME[id] || id,
      aliases: ALIAS_MAP[id] || [id],
      channelName: CHANNEL_NAME_MAP[id] || `${emoji}-${id}`,
      emoji,
      color: COLOR_MAP[id] || 0x99AAB5,
      voice: VOICE_MAP[id] || 'Kore',
      avatarUrl: AVATAR_MAP[id] || `https://ui-avatars.com/api/?name=${encodeURIComponent(id)}&background=99AAB5&color=fff&size=256`,
      systemPrompt,
    });
  }
  if (loadErrors > 0) {
    console.warn(`⚠️ ${loadErrors}/${AGENT_IDS.length} agent prompts could not be loaded from .agent.md files`);
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
