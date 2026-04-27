/**
 * Tests for src/discord/tools.ts — tool permissions, agent access control,
 * tool definitions, and key helper functions.
 */

// Mock all heavy dependencies
jest.mock('../../db/pool', () => ({ default: { query: jest.fn() }, __esModule: true }));
jest.mock('../../services/github', () => ({
  createBranch: jest.fn(),
  createPullRequest: jest.fn(),
  mergePullRequest: jest.fn(),
  addPRComment: jest.fn(),
  listPullRequests: jest.fn(),
  searchGitHub: jest.fn(),
}));
jest.mock('../../services/jobSearch', () => ({
  scanAdzuna: jest.fn(),
  scanPortals: jest.fn(),
  getListingsByStatus: jest.fn(),
  updateListingStatus: jest.fn(),
  getTrackerSummary: jest.fn(),
  getProfile: jest.fn(),
  upsertProfile: jest.fn(),
  seedDefaultPortals: jest.fn(),
  updateListingScore: jest.fn(),
  setListingDiscordMsg: jest.fn(),
  getListingById: jest.fn(),
  draftApplication: jest.fn(),
  submitToGreenhouse: jest.fn(),
  getPortalByCompany: jest.fn(),
}));
jest.mock('../../discord/agents', () => ({
  getAgent: jest.fn(),
  AgentId: {},
}));
jest.mock('../../discord/handlers/review', () => ({ getRequiredReviewers: jest.fn() }));
jest.mock('../../discord/handlers/groupchat', () => ({ setActiveSmokeTestRunning: jest.fn() }));
jest.mock('../../discord/services/mobileHarness', () => ({
  mobileHarnessStart: jest.fn(),
  mobileHarnessStep: jest.fn(),
  mobileHarnessSnapshot: jest.fn(),
  mobileHarnessStop: jest.fn(),
}));
jest.mock('../../discord/services/screenshots', () => ({ captureAndPostScreenshots: jest.fn() }));
jest.mock('../../discord/services/webhooks', () => ({ getWebhook: jest.fn() }));
jest.mock('../../discord/usage', () => ({
  setDailyBudgetLimit: jest.fn(),
  setDailyClaudeTokenLimit: jest.fn(),
  setConversationTokenLimit: jest.fn(),
  clearConversationTokens: jest.fn(),
  getConversationTokenUsage: jest.fn(() => ({ used: 0, warn: 300000, limit: 500000, overWarn: false, overLimit: false })),
}));
jest.mock('../../discord/memory', () => ({
  upsertMemory: jest.fn(),
  appendMemoryRow: jest.fn(),
  readMemoryRow: jest.fn(),
}));
jest.mock('../../discord/ui/constants', () => ({
  jobScoreColor: jest.fn(),
  SYSTEM_COLORS: {},
  BUTTON_IDS: {},
}));

import {
  REPO_TOOLS,
  REVIEW_TOOLS,
  CORTANA_TOOLS,
  PROMPT_REPO_TOOLS,
  PROMPT_REVIEW_TOOLS,
  PROMPT_CORTANA_TOOLS,
  getToolsForAgent,
  getAllowedToolNamesForAgent,
  agentCanUseTool,
  executeTool,
  safePath,
  BLOCKED_PATHS,
  HARD_BLOCKED,
  ALLOWED_COMMANDS,
} from '../../discord/tools';

describe('tools — tool definitions', () => {
  describe('REPO_TOOLS', () => {
    it('is a non-empty array', () => {
      expect(Array.isArray(REPO_TOOLS)).toBe(true);
      expect(REPO_TOOLS.length).toBeGreaterThan(30);
    });

    it('each tool has name, description, and input_schema', () => {
      for (const tool of REPO_TOOLS) {
        expect(tool.name).toBeTruthy();
        expect(typeof tool.name).toBe('string');
        expect(tool.description).toBeTruthy();
        expect(tool.input_schema).toBeDefined();
        expect(tool.input_schema.type).toBe('object');
      }
    });

    it('has no duplicate tool names', () => {
      const names = REPO_TOOLS.map(t => t.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('includes core file tools', () => {
      const names = new Set(REPO_TOOLS.map(t => t.name));
      expect(names.has('read_file')).toBe(true);
      expect(names.has('write_file')).toBe(true);
      expect(names.has('edit_file')).toBe(true);
      expect(names.has('search_files')).toBe(true);
      expect(names.has('list_directory')).toBe(true);
    });

    it('includes GCP tools', () => {
      const names = new Set(REPO_TOOLS.map(t => t.name));
      expect(names.has('gcp_deploy')).toBe(true);
      expect(names.has('gcp_logs_query')).toBe(true);
      expect(names.has('gcp_preflight')).toBe(true);
      expect(names.has('gcp_redeploy_bot_vm')).toBe(true);
    });

    it('includes DB tools', () => {
      const names = new Set(REPO_TOOLS.map(t => t.name));
      expect(names.has('db_query')).toBe(true);
      expect(names.has('db_query_readonly')).toBe(true);
      expect(names.has('db_schema')).toBe(true);
    });

    it('includes job search tools', () => {
      const names = new Set(REPO_TOOLS.map(t => t.name));
      expect(names.has('job_scan')).toBe(true);
    });
  });

  describe('REVIEW_TOOLS', () => {
    it('is a subset of REPO_TOOLS', () => {
      const repoNames = new Set(REPO_TOOLS.map(t => t.name));
      for (const tool of REVIEW_TOOLS) {
        expect(repoNames.has(tool.name)).toBe(true);
      }
    });

    it('includes read-only tools', () => {
      const names = new Set(REVIEW_TOOLS.map(t => t.name));
      expect(names.has('read_file')).toBe(true);
      expect(names.has('search_files')).toBe(true);
      expect(names.has('db_query_readonly')).toBe(true);
    });

    it('excludes write tools', () => {
      const names = new Set(REVIEW_TOOLS.map(t => t.name));
      expect(names.has('write_file')).toBe(false);
      expect(names.has('edit_file')).toBe(false);
      expect(names.has('run_command')).toBe(false);
      expect(names.has('db_query')).toBe(false);
    });

    it('excludes deploy tools', () => {
      const names = new Set(REVIEW_TOOLS.map(t => t.name));
      expect(names.has('gcp_deploy')).toBe(false);
      expect(names.has('gcp_rollback')).toBe(false);
    });
  });

  describe('CORTANA_TOOLS', () => {
    it('includes coordination tools', () => {
      const names = new Set(CORTANA_TOOLS.map(t => t.name));
      expect(names.has('read_file')).toBe(true);
      expect(names.has('list_threads')).toBe(true);
      expect(names.has('send_channel_message')).toBe(true);
      expect(names.has('smoke_test_agents')).toBe(true);
    });

    it('includes Cortana autonomy tools', () => {
      const names = new Set(CORTANA_TOOLS.map(t => t.name));
      expect(names.has('write_file')).toBe(true);
      expect(names.has('edit_file')).toBe(true);
      expect(names.has('run_command')).toBe(true);
      expect(names.has('gcp_deploy')).toBe(true);
      expect(names.has('gcp_redeploy_bot_vm')).toBe(true);
      expect(names.has('create_pull_request')).toBe(true);
      expect(names.has('merge_pull_request')).toBe(true);
    });

    it('includes budget tool', () => {
      const names = new Set(CORTANA_TOOLS.map(t => t.name));
      expect(names.has('set_daily_budget')).toBe(true);
    });

    it('includes token control tools', () => {
      const names = new Set(CORTANA_TOOLS.map(t => t.name));
      expect(names.has('set_daily_claude_token_limit')).toBe(true);
      expect(names.has('set_conversation_token_limit')).toBe(true);
      expect(names.has('reset_conversation_token_window')).toBe(true);
    });
  });

  describe('PROMPT_*_TOOLS (compacted)', () => {
    it('PROMPT_REPO_TOOLS has same count as REPO_TOOLS', () => {
      expect(PROMPT_REPO_TOOLS.length).toBe(REPO_TOOLS.length);
    });

    it('PROMPT_REVIEW_TOOLS has same count as REVIEW_TOOLS', () => {
      expect(PROMPT_REVIEW_TOOLS.length).toBe(REVIEW_TOOLS.length);
    });

    it('PROMPT_CORTANA_TOOLS has same count as CORTANA_TOOLS', () => {
      expect(PROMPT_CORTANA_TOOLS.length).toBe(CORTANA_TOOLS.length);
    });

    it('compact tools have shorter descriptions (first sentence only)', () => {
      for (const tool of PROMPT_REPO_TOOLS) {
        expect(tool.description.length).toBeLessThanOrEqual(140);
      }
    });

    it('compact schemas strip descriptions', () => {
      for (const tool of PROMPT_REPO_TOOLS) {
        const schema = tool.input_schema;
        if (schema.properties) {
          for (const prop of Object.values(schema.properties) as any[]) {
            expect(prop.description).toBeUndefined();
          }
        }
      }
    });
  });
});

describe('tools — agent access control', () => {
  // Self-repair tools are gated to Cortana + ops-manager only — every other
  // "full access" agent gets REPO_TOOLS minus this set. 5 read/edit + 7
  // verify+ship (typecheck, tests, voice-validator, commit, PR, merge, deploy).
  const SELF_REPAIR_TOOL_COUNT = 12;

  describe('getToolsForAgent()', () => {
    it('returns full tools (minus self-repair) for developer', () => {
      const tools = getToolsForAgent('developer');
      expect(tools.length).toBe(REPO_TOOLS.length - SELF_REPAIR_TOOL_COUNT);
    });

    it('returns full tools (minus self-repair) for devops', () => {
      expect(getToolsForAgent('devops').length).toBe(REPO_TOOLS.length - SELF_REPAIR_TOOL_COUNT);
    });

    it('returns Cortana tools for executive-assistant — including self-repair', () => {
      const tools = getToolsForAgent('executive-assistant');
      expect(tools.length).toBe(CORTANA_TOOLS.length);
      const names = new Set(tools.map((t) => (t as { name: string }).name));
      expect(names.has('read_self_file')).toBe(true);
      expect(names.has('edit_self_file')).toBe(true);
    });

    it('returns review tools for qa', () => {
      const tools = getToolsForAgent('qa');
      expect(tools.length).toBe(REVIEW_TOOLS.length);
    });

    it('returns review tools for security-auditor', () => {
      expect(getToolsForAgent('security-auditor').length).toBe(REVIEW_TOOLS.length);
    });

    it('returns review tools for ux-reviewer', () => {
      expect(getToolsForAgent('ux-reviewer').length).toBe(REVIEW_TOOLS.length);
    });

    it('returns review tools for unknown agents (least privilege)', () => {
      expect(getToolsForAgent('unknown-agent').length).toBe(REVIEW_TOOLS.length);
    });

    it('returns compact tools when compactPrompt=true', () => {
      const tools = getToolsForAgent('developer', true);
      expect(tools.length).toBe(REPO_TOOLS.length - SELF_REPAIR_TOOL_COUNT);
      // Should be compact format
      for (const tool of tools as any[]) {
        expect(tool.description.length).toBeLessThanOrEqual(140);
      }
    });
  });

  describe('getAllowedToolNamesForAgent()', () => {
    it('returns Set of tool names', () => {
      const names = getAllowedToolNamesForAgent('developer');
      expect(names).toBeInstanceOf(Set);
      expect(names.size).toBe(REPO_TOOLS.length - SELF_REPAIR_TOOL_COUNT);
    });

    it('review agents have fewer tools', () => {
      const devNames = getAllowedToolNamesForAgent('developer');
      const qaNames = getAllowedToolNamesForAgent('qa');
      expect(qaNames.size).toBeLessThan(devNames.size);
    });
  });

  describe('agentCanUseTool()', () => {
    it('developer can use all tools', () => {
      expect(agentCanUseTool('developer', 'write_file')).toBe(true);
      expect(agentCanUseTool('developer', 'run_command')).toBe(true);
      expect(agentCanUseTool('developer', 'gcp_deploy')).toBe(true);
    });

    it('qa cannot use write tools', () => {
      expect(agentCanUseTool('qa', 'write_file')).toBe(false);
      expect(agentCanUseTool('qa', 'run_command')).toBe(false);
      expect(agentCanUseTool('qa', 'db_query')).toBe(false);
    });

    it('qa can use read tools', () => {
      expect(agentCanUseTool('qa', 'read_file')).toBe(true);
      expect(agentCanUseTool('qa', 'search_files')).toBe(true);
      expect(agentCanUseTool('qa', 'db_query_readonly')).toBe(true);
    });

    it('Cortana can use autonomy tools', () => {
      expect(agentCanUseTool('executive-assistant', 'write_file')).toBe(true);
      expect(agentCanUseTool('executive-assistant', 'gcp_deploy')).toBe(true);
      expect(agentCanUseTool('executive-assistant', 'gcp_redeploy_bot_vm')).toBe(true);
      expect(agentCanUseTool('executive-assistant', 'merge_pull_request')).toBe(true);
        expect(agentCanUseTool('executive-assistant', 'set_daily_claude_token_limit')).toBe(true);
        expect(agentCanUseTool('executive-assistant', 'set_conversation_token_limit')).toBe(true);
        expect(agentCanUseTool('executive-assistant', 'reset_conversation_token_window')).toBe(true);
    });
  });
});

describe('tools — executeTool access control', () => {
  it('blocks unauthorized tool calls', async () => {
    const result = await executeTool('write_file', { path: 'test.ts', content: 'hi' }, { agentId: 'qa' });
    expect(result).toContain('not allowed');
  });

  it('allows authorized tool calls (read_file for qa)', async () => {
    // read_file might fail on non-existent file, but shouldn't say "not allowed"
    const result = await executeTool('read_file', { path: 'package.json' }, { agentId: 'qa' });
    expect(result).not.toContain('not allowed');
  });

  it('executes Cortana token control tools', async () => {
    const usage = require('../../discord/usage');
    usage.setDailyClaudeTokenLimit.mockReturnValue({ previous: 8000000, current: 12000000, used: 125000, remaining: 11875000 });
    usage.setConversationTokenLimit.mockReturnValue({ previous: 500000, current: 900000, warn: 450000 });
    usage.getConversationTokenUsage
      .mockReturnValueOnce({ used: 640000, warn: 300000, limit: 500000, overWarn: true, overLimit: true })
      .mockReturnValueOnce({ used: 0, warn: 300000, limit: 500000, overWarn: false, overLimit: false });

    const dailyResult = await executeTool('set_daily_claude_token_limit', { limit_tokens: 12000000 }, { agentId: 'executive-assistant', threadKey: 'groupchat:thread-1' });
    const convoResult = await executeTool('set_conversation_token_limit', { limit_tokens: 900000, warn_tokens: 450000 }, { agentId: 'executive-assistant', threadKey: 'groupchat:thread-1' });
    const resetResult = await executeTool('reset_conversation_token_window', {}, { agentId: 'executive-assistant', threadKey: 'groupchat:thread-1' });

    expect(dailyResult).toContain('Daily Claude token limit updated');
    expect(convoResult).toContain('Conversation token limit updated');
    expect(resetResult).toContain('Conversation token window reset');
    expect(usage.clearConversationTokens).toHaveBeenCalledWith('groupchat:thread-1');
  });
});

describe('tools — safePath', () => {
  it('resolves relative paths', () => {
    const resolved = safePath('src/index.ts');
    expect(resolved).toContain('src/index.ts');
  });

  it('blocks path traversal', () => {
    expect(() => safePath('../../etc/passwd')).toThrow('Path escapes');
  });

  it('blocks .env access', () => {
    expect(() => safePath('.env')).toThrow('Access denied');
  });

  it('blocks node_modules', () => {
    expect(() => safePath('node_modules/some-package/index.js')).toThrow('Access denied');
  });

  it('blocks .git internal objects', () => {
    expect(() => safePath('.git/objects/abc')).toThrow('Access denied');
    expect(() => safePath('.git/refs/heads/main')).toThrow('Access denied');
    expect(() => safePath('.git/HEAD')).toThrow('Access denied');
  });

  it('allows normal source files', () => {
    expect(() => safePath('src/discord/bot.ts')).not.toThrow();
  });

  it('caches resolved paths', () => {
    const a = safePath('src/index.ts');
    const b = safePath('src/index.ts');
    expect(a).toBe(b);
  });
});

describe('tools — BLOCKED_PATHS', () => {
  it('blocks critical paths', () => {
    expect(BLOCKED_PATHS).toContain('.env');
    expect(BLOCKED_PATHS).toContain('node_modules');
    expect(BLOCKED_PATHS).toContain('.git/objects');
    expect(BLOCKED_PATHS).toContain('.git/refs');
    expect(BLOCKED_PATHS).toContain('.git/HEAD');
  });
});
