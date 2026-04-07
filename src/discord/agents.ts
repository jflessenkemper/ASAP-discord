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
  'executive-assistant': 0x5865F2, // Blurple (Riley)
  developer:            0x57F287, // Green (Ace)
  qa:                   0xED4245, // Red (Max)
  'ux-reviewer':        0xEB459E, // Fuchsia (Sophie)
  'security-auditor':   0xFEE75C, // Yellow (Kane)
  'api-reviewer':       0x3498DB, // Blue (Raj)
  dba:                  0xE67E22, // Orange (Elena)
  performance:          0x1ABC9C, // Teal (Kai)
  devops:               0x9B59B6, // Purple (Jude)
  copywriter:           0xE91E63, // Pink (Liv)
  lawyer:               0x607D8B, // Blue Grey (Harper)
  'ios-engineer':       0xA3AAAE, // Silver (Mia)
  'android-engineer':   0x2ECC71, // Emerald (Leo)
};

/**
 * Agent avatar URLs.
 * Use ui-avatars for high-availability webhook avatar rendering.
 */
const AVATAR_MAP: Record<string, string> = {
  qa:                    'https://ui-avatars.com/api/?name=Max+QA&background=ED4245&color=FFFFFF&size=256&bold=true&format=png',
  'ux-reviewer':         'https://ui-avatars.com/api/?name=Sophie+UX&background=EB459E&color=FFFFFF&size=256&bold=true&format=png',
  'security-auditor':    'https://ui-avatars.com/api/?name=Kane+Security&background=FEE75C&color=111111&size=256&bold=true&format=png',
  'api-reviewer':        'https://ui-avatars.com/api/?name=Raj+API&background=3498DB&color=FFFFFF&size=256&bold=true&format=png',
  dba:                   'https://ui-avatars.com/api/?name=Elena+DBA&background=E67E22&color=FFFFFF&size=256&bold=true&format=png',
  performance:           'https://ui-avatars.com/api/?name=Kai+Perf&background=1ABC9C&color=FFFFFF&size=256&bold=true&format=png',
  devops:                'https://ui-avatars.com/api/?name=Jude+DevOps&background=9B59B6&color=FFFFFF&size=256&bold=true&format=png',
  copywriter:            'https://ui-avatars.com/api/?name=Liv+Copy&background=E91E63&color=FFFFFF&size=256&bold=true&format=png',
  developer:             'https://ui-avatars.com/api/?name=Ace+Dev&background=57F287&color=0F172A&size=256&bold=true&format=png',
  lawyer:                'https://ui-avatars.com/api/?name=Harper+Law&background=607D8B&color=FFFFFF&size=256&bold=true&format=png',
  'executive-assistant': 'https://ui-avatars.com/api/?name=Riley+EA&background=5865F2&color=FFFFFF&size=256&bold=true&format=png',
  'ios-engineer':        'https://ui-avatars.com/api/?name=Mia+iOS&background=A3AAAE&color=111111&size=256&bold=true&format=png',
  'android-engineer':    'https://ui-avatars.com/api/?name=Leo+Android&background=2ECC71&color=0F172A&size=256&bold=true&format=png',
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
