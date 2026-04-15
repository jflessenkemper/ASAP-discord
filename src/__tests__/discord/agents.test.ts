/**
 * Tests for src/discord/agents.ts
 * Agent registry, resolution, mentions, and configuration.
 */

// Mock fs so system prompt loading doesn't hit the real filesystem
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    accessSync: jest.fn(() => { throw new Error('not found'); }),
    readFileSync: jest.fn(() => { throw new Error('not found'); }),
    existsSync: actual.existsSync,
  };
});

import {
  getAgents,
  getAgent,
  resolveAgentId,
  resolveAgentIdByRoleId,
  getAgentMention,
  getAgentAliases,
  buildAgentMentionGuide,
  getAgentByChannelName,
  setAgentRoleId,
  getAgentRoleId,
  getRileyPersonality,
  getRileyMemory,
  AGENT_IDS,
} from '../../discord/agents';

describe('agents', () => {
  describe('AGENT_IDS', () => {
    it('contains all 13 agent IDs', () => {
      expect(AGENT_IDS.length).toBe(13);
    });

    it('includes known agent IDs', () => {
      expect(AGENT_IDS).toContain('developer');
      expect(AGENT_IDS).toContain('executive-assistant');
      expect(AGENT_IDS).toContain('qa');
      expect(AGENT_IDS).toContain('security-auditor');
    });
  });

  describe('getAgents()', () => {
    it('returns a Map of all agents', () => {
      const agents = getAgents();
      expect(agents).toBeInstanceOf(Map);
      expect(agents.size).toBe(13);
    });

    it('each agent has required properties', () => {
      for (const agent of getAgents().values()) {
        expect(agent).toHaveProperty('id');
        expect(agent).toHaveProperty('name');
        expect(agent).toHaveProperty('handle');
        expect(agent).toHaveProperty('roleName');
        expect(agent).toHaveProperty('aliases');
        expect(agent).toHaveProperty('channelName');
        expect(agent).toHaveProperty('emoji');
        expect(agent).toHaveProperty('color');
        expect(agent).toHaveProperty('voice');
        expect(agent).toHaveProperty('avatarUrl');
        expect(agent).toHaveProperty('systemPrompt');
      }
    });

    it('avatar URLs use GCS bucket', () => {
      for (const agent of getAgents().values()) {
        expect(agent.avatarUrl).toMatch(/^https:\/\/storage\.googleapis\.com\/asap-bot-assets\/avatars\//);
      }
    });
  });

  describe('getAgent()', () => {
    it('returns agent by ID', () => {
      const agent = getAgent('developer');
      expect(agent).toBeDefined();
      expect(agent!.name).toContain('Ace');
    });

    it('returns undefined for unknown ID', () => {
      expect(getAgent('nonexistent' as any)).toBeUndefined();
    });
  });

  describe('resolveAgentId()', () => {
    it('resolves by exact ID', () => {
      expect(resolveAgentId('developer')).toBe('developer');
    });

    it('resolves by handle', () => {
      expect(resolveAgentId('ace')).toBe('developer');
      expect(resolveAgentId('riley')).toBe('executive-assistant');
    });

    it('resolves by alias', () => {
      expect(resolveAgentId('dev')).toBe('developer');
      expect(resolveAgentId('qa')).toBe('qa');
      expect(resolveAgentId('security')).toBe('security-auditor');
    });

    it('resolves with @ prefix', () => {
      expect(resolveAgentId('@ace')).toBe('developer');
      expect(resolveAgentId('@@riley')).toBe('executive-assistant');
    });

    it('resolves case-insensitively', () => {
      expect(resolveAgentId('ACE')).toBe('developer');
      expect(resolveAgentId('Riley')).toBe('executive-assistant');
    });

    it('resolves by role name', () => {
      expect(resolveAgentId('Ace')).toBe('developer');
      expect(resolveAgentId('Riley')).toBe('executive-assistant');
    });

    it('returns null for unknown token', () => {
      expect(resolveAgentId('unknown-agent')).toBeNull();
      expect(resolveAgentId('')).toBeNull();
    });
  });

  describe('setAgentRoleId / getAgentRoleId / resolveAgentIdByRoleId', () => {
    afterEach(() => {
      setAgentRoleId('developer', null);
    });

    it('sets and gets a role ID', () => {
      setAgentRoleId('developer', '123456789');
      expect(getAgentRoleId('developer')).toBe('123456789');
    });

    it('clears role ID with null', () => {
      setAgentRoleId('developer', '123');
      setAgentRoleId('developer', null);
      expect(getAgentRoleId('developer')).toBeNull();
    });

    it('resolves agent by role ID', () => {
      setAgentRoleId('qa', '999');
      expect(resolveAgentIdByRoleId('999')).toBe('qa');
      setAgentRoleId('qa', null);
    });

    it('returns null for unset role ID', () => {
      expect(resolveAgentIdByRoleId('nonexistent')).toBeNull();
    });
  });

  describe('getAgentMention()', () => {
    afterEach(() => {
      setAgentRoleId('developer', null);
    });

    it('returns @handle when no role ID is set', () => {
      expect(getAgentMention('developer')).toBe('@ace');
    });

    it('returns Discord role mention when role ID is set', () => {
      setAgentRoleId('developer', '123456');
      expect(getAgentMention('developer')).toBe('<@&123456>');
    });
  });

  describe('getAgentAliases()', () => {
    it('returns deduplicated aliases including ID and handle', () => {
      const aliases = getAgentAliases('developer');
      expect(aliases).toContain('developer');
      expect(aliases).toContain('ace');
      expect(aliases).toContain('dev');
    });

    it('returns [id] for unknown agent', () => {
      expect(getAgentAliases('nonexistent' as any)).toEqual(['nonexistent']);
    });
  });

  describe('buildAgentMentionGuide()', () => {
    it('builds guide for all agents', () => {
      const guide = buildAgentMentionGuide();
      expect(guide).toContain('Ace');
      expect(guide).toContain('Riley');
      expect(guide.split(', ').length).toBe(13);
    });

    it('builds guide for specified agents', () => {
      const guide = buildAgentMentionGuide(['developer', 'qa']);
      expect(guide).toContain('Ace');
      expect(guide).toContain('Max');
      expect(guide.split(', ').length).toBe(2);
    });

    it('filters out null entries for invalid agent IDs', () => {
      const guide = buildAgentMentionGuide(['developer', 'nonexistent' as any]);
      expect(guide).toContain('Ace');
      expect(guide).not.toContain('nonexistent');
      expect(guide.split(', ').length).toBe(1);
    });
  });

  describe('getAgentByChannelName()', () => {
    it('resolves by channel name', () => {
      const agent = getAgentByChannelName('💻-developer');
      expect(agent?.id).toBe('developer');
    });

    it('resolves by agent ID as channel name', () => {
      const agent = getAgentByChannelName('developer');
      expect(agent?.id).toBe('developer');
    });

    it('returns undefined for unknown channel', () => {
      expect(getAgentByChannelName('random-channel')).toBeUndefined();
    });
  });

  describe('getRileyPersonality / getRileyMemory', () => {
    it('returns null when .github dir not found', () => {
      expect(getRileyPersonality()).toBeNull();
    });

    it('returns null for memory when .github dir not found', () => {
      expect(getRileyMemory()).toBeNull();
    });
  });
});

describe('agents (fresh module — .github dir found)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('loads system prompt from .github when directory is accessible', async () => {
    jest.doMock('fs', () => {
      const actual = jest.requireActual('fs');
      return {
        ...actual,
        accessSync: jest.fn(),
        readFileSync: jest.fn(() => '---\ntitle: Test\n---\nYou are a test agent.'),
        existsSync: actual.existsSync,
      };
    });
    const { getAgents } = await import('../../discord/agents');
    const agents = getAgents();
    for (const agent of agents.values()) {
      expect(agent.systemPrompt).toBe('You are a test agent.');
    }
  });

  it('falls back to default prompt when readFileSync throws', async () => {
    jest.doMock('fs', () => {
      const actual = jest.requireActual('fs');
      return {
        ...actual,
        accessSync: jest.fn(),
        readFileSync: jest.fn(() => { throw new Error('ENOENT'); }),
        existsSync: actual.existsSync,
      };
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const { getAgents } = await import('../../discord/agents');
    const agents = getAgents();
    for (const agent of agents.values()) {
      expect(agent.systemPrompt).toContain('agent for the ASAP project');
    }
    warnSpy.mockRestore();
  });

  it('getAgentAliases returns [id] for unknown agent (fresh module)', async () => {
    jest.doMock('fs', () => {
      const actual = jest.requireActual('fs');
      return {
        ...actual,
        accessSync: jest.fn(() => { throw new Error('not found'); }),
        readFileSync: jest.fn(() => { throw new Error('not found'); }),
        existsSync: actual.existsSync,
      };
    });
    const { getAgentAliases } = await import('../../discord/agents');
    expect(getAgentAliases('totally-fake' as any)).toEqual(['totally-fake']);
  });
});
