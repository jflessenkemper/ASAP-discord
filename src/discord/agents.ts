import fs from 'fs';
import path from 'path';

export interface AgentConfig {
  id: string;
  name: string;
  channelName: string;
  emoji: string;
  /** Gemini TTS voice name */
  voice: string;
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
  for (const id of AGENT_IDS) {
    const emoji = EMOJI_MAP[id] || '🤖';
    agentCache.set(id, {
      id,
      name: DISPLAY_NAME[id] || id,
      channelName: `${emoji}${id}`,
      emoji,
      voice: VOICE_MAP[id] || 'Kore',
      systemPrompt: loadSystemPrompt(id),
    });
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
