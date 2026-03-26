import fs from 'fs';
import path from 'path';

export interface AgentConfig {
  id: string;
  name: string;
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
  developer: 'Aoede',
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
 * Agent avatar URLs — AI-generated profile pictures hosted on Discord CDN.
 * Using placeholder emoji-based avatars via UI Avatars API.
 * Replace with custom images later by uploading to Discord/CDN.
 */
const AVATAR_MAP: Record<string, string> = {
  qa:                   'https://ui-avatars.com/api/?name=Max&background=ED4245&color=fff&size=256&bold=true',
  'ux-reviewer':        'https://ui-avatars.com/api/?name=Sophie&background=EB459E&color=fff&size=256&bold=true',
  'security-auditor':   'https://ui-avatars.com/api/?name=Kane&background=FEE75C&color=000&size=256&bold=true',
  'api-reviewer':       'https://ui-avatars.com/api/?name=Raj&background=3498DB&color=fff&size=256&bold=true',
  dba:                  'https://ui-avatars.com/api/?name=Elena&background=E67E22&color=fff&size=256&bold=true',
  performance:          'https://ui-avatars.com/api/?name=Kai&background=1ABC9C&color=fff&size=256&bold=true',
  devops:               'https://ui-avatars.com/api/?name=Jude&background=9B59B6&color=fff&size=256&bold=true',
  copywriter:           'https://ui-avatars.com/api/?name=Liv&background=E91E63&color=fff&size=256&bold=true',
  developer:            'https://ui-avatars.com/api/?name=Ace&background=57F287&color=000&size=256&bold=true',
  lawyer:               'https://ui-avatars.com/api/?name=Harper&background=607D8B&color=fff&size=256&bold=true',
  'executive-assistant': 'https://ui-avatars.com/api/?name=Riley&background=5865F2&color=fff&size=256&bold=true',
  'ios-engineer':       'https://ui-avatars.com/api/?name=Mia&background=A3AAAE&color=000&size=256&bold=true',
  'android-engineer':   'https://ui-avatars.com/api/?name=Leo&background=2ECC71&color=000&size=256&bold=true',
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

function loadSystemPrompt(agentId: string): string {
  // Try multiple paths — Docker copies to /app/.github/agents/, local dev uses repo root
  const candidates = [
    path.join(__dirname, '..', '..', '..', '.github', 'agents', `${agentId}.agent.md`),
    path.join('/app', '.github', 'agents', `${agentId}.agent.md`),
  ];

  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Strip YAML frontmatter
      const stripped = content.replace(/^---[\s\S]*?---\n*/, '');
      return stripped.trim();
    } catch {
      // Try next path
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

export function getAgents(): Map<AgentId, AgentConfig> {
  if (agentCache) return agentCache;

  agentCache = new Map();
  let loadErrors = 0;
  for (const id of AGENT_IDS) {
    const emoji = EMOJI_MAP[id] || '🤖';
    const systemPrompt = loadSystemPrompt(id);
    // Track agents that fell back to default prompt
    if (systemPrompt.startsWith('You are the ')) loadErrors++;
    agentCache.set(id, {
      id,
      name: DISPLAY_NAME[id] || id,
      channelName: `${emoji}${id}`,
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

export function getAgentByChannelName(channelName: string): AgentConfig | undefined {
  for (const agent of getAgents().values()) {
    if (agent.channelName === channelName || agent.id === channelName) return agent;
  }
  return undefined;
}

export { AGENT_IDS };
