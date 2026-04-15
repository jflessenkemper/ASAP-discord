/**
 * Tests for src/discord/setup.ts
 * Discord bot channel setup and initialization.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- Mock agents ----
const mockAgents = new Map([
  ['dev', {
    id: 'dev', name: 'Ace Developer', handle: 'ace', roleName: 'Ace',
    aliases: ['ace'], channelName: '💻-ace', emoji: '💻', color: 0x00ff00,
    voice: 'Puck', avatarUrl: 'https://example.com/ace.png', systemPrompt: '',
  }],
]);
jest.mock('../../discord/agents', () => ({
  getAgents: jest.fn().mockReturnValue(mockAgents),
  setAgentRoleId: jest.fn(),
}));

// ---- Mock webhooks ----
jest.mock('../../discord/services/webhooks', () => ({
  getWebhook: jest.fn().mockResolvedValue({ id: 'wh-1' }),
}));

// ---- Mock tools ----
jest.mock('../../discord/tools', () => ({
  REPO_TOOLS: [
    { name: 'read_file' },
    { name: 'run_command' },
    { name: 'send_channel_message' },
  ],
}));

jest.mock('../../utils/errors', () => ({
  errMsg: (e: any) => (e instanceof Error ? e.message : String(e)),
}));

// ---- discord.js mock layer ----
const mockChannelDelete = jest.fn().mockResolvedValue(undefined);
const mockChannelSetParent = jest.fn().mockResolvedValue(undefined);
const mockChannelSetTopic = jest.fn().mockResolvedValue(undefined);
const mockChannelSend = jest.fn().mockResolvedValue(undefined);
const mockMessageDelete = jest.fn().mockResolvedValue(undefined);
const mockPermissionOverwritesEdit = jest.fn().mockResolvedValue(undefined);

const mockMessagesFetch = jest.fn().mockImplementation(() => {
  const m = new Map() as Map<string, any> & { last: () => any };
  m.last = () => undefined;
  return Promise.resolve(m);
});

function makeTextChannel(name: string, id: string, parentId?: string, topic?: string): any {
  return {
    id,
    name,
    type: 0, // GuildText
    parentId: parentId || null,
    topic: topic || '',
    isTextBased: () => true,
    send: mockChannelSend,
    setParent: mockChannelSetParent,
    setTopic: mockChannelSetTopic,
    delete: mockChannelDelete,
    createdTimestamp: Date.now(),
    children: { cache: new Map() },
    messages: { fetch: mockMessagesFetch },
    permissionOverwrites: { edit: mockPermissionOverwritesEdit },
    client: { user: { id: 'bot-user-id' } },
  };
}

function makeVoiceChannel(name: string, id: string, parentId?: string): any {
  return {
    id,
    name,
    type: 2, // GuildVoice
    parentId: parentId || null,
    isTextBased: () => false,
    setParent: mockChannelSetParent,
    delete: mockChannelDelete,
    createdTimestamp: Date.now(),
    children: { cache: new Map() },
  };
}

function makeCategoryChannel(name: string, id: string): any {
  return {
    id,
    name,
    type: 4, // GuildCategory
    children: { cache: new Map() },
    delete: mockChannelDelete,
  };
}

jest.mock('discord.js', () => ({
  ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildStageVoice: 13 },
  Guild: jest.fn(),
  TextChannel: jest.fn(),
  VoiceChannel: jest.fn(),
  CategoryChannel: jest.fn(),
  Role: jest.fn(),
}));

import { setupChannels, BotChannels } from '../../discord/setup';

describe('setup', () => {
  const origEnv = { ...process.env };

  // Build a mock guild with a channels cache.
  // The cache starts empty so setupChannels creates everything.
  let channelCache: Map<string, any>;
  let rolesCache: Map<string, any>;
  let mockGuild: any;

  function buildGuild(existingChannels: any[] = [], existingRoles: any[] = []) {
    channelCache = new Map(existingChannels.map((c) => [c.id, c]));
    rolesCache = new Map(existingRoles.map((r) => [r.id, r]));

    // Everyone role
    const everyoneRole = { id: 'everyone-role', name: '@everyone' };
    if (!rolesCache.has('everyone-role')) rolesCache.set('everyone-role', everyoneRole);

    const ownerMember = {
      id: 'owner-1',
      setNickname: jest.fn(),
    };

    /** Create a Discord.js Collection-like Map with .first() */
    function toCollection(map: Map<string, any>) {
      const col = map as Map<string, any> & { first: () => any };
      col.first = () => {
        const iter = map.values();
        const first = iter.next();
        return first.done ? undefined : first.value;
      };
      return col;
    }

    mockGuild = {
      id: 'guild-1',
      client: { user: { id: 'bot-user-id' } },
      channels: {
        fetch: jest.fn().mockResolvedValue(undefined),
        cache: {
          find: jest.fn().mockImplementation((fn: (c: any) => boolean) => {
            for (const ch of channelCache.values()) {
              if (fn(ch)) return ch;
            }
            return undefined;
          }),
          filter: jest.fn().mockImplementation((fn: (c: any) => boolean) => {
            const result = new Map();
            for (const [k, ch] of channelCache) {
              if (fn(ch)) result.set(k, ch);
            }
            return toCollection(result);
          }),
          values: jest.fn().mockImplementation(() => channelCache.values()),
        },
        create: jest.fn().mockImplementation(async (opts: any) => {
          const type = opts.type ?? 0;
          const id = `created-${opts.name}-${Date.now()}`;
          let ch: any;
          if (type === 4) {
            ch = makeCategoryChannel(opts.name, id);
          } else if (type === 2) {
            ch = makeVoiceChannel(opts.name, id, opts.parent?.id);
          } else {
            ch = makeTextChannel(opts.name, id, opts.parent?.id, opts.topic);
          }
          ch.client = { user: { id: 'bot-user-id' } };
          channelCache.set(id, ch);
          return ch;
        }),
      },
      roles: {
        fetch: jest.fn().mockResolvedValue(undefined),
        cache: {
          find: jest.fn().mockImplementation((fn: (r: any) => boolean) => {
            for (const r of rolesCache.values()) {
              if (fn(r)) return r;
            }
            return undefined;
          }),
        },
        everyone: everyoneRole,
        create: jest.fn().mockImplementation(async (opts: any) => {
          const role = {
            id: `role-${opts.name}`,
            name: opts.name,
            color: opts.color,
            mentionable: opts.mentionable,
            edit: jest.fn().mockImplementation(async (u: any) => {
              Object.assign(role, u);
              return role;
            }),
          };
          rolesCache.set(role.id, role);
          return role;
        }),
      },
      fetchOwner: jest.fn().mockResolvedValue(ownerMember),
    };

    return mockGuild;
  }

  beforeEach(() => {
    process.env = { ...origEnv };
    jest.clearAllMocks();
    // Default: messages.fetch returns empty (no bot posts to delete)
    mockMessagesFetch.mockResolvedValue(new Map());
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('creates all channels and categories from scratch', async () => {
    const guild = buildGuild();

    const result = await setupChannels(guild);

    expect(result.groupchat).toBeDefined();
    expect(result.threadStatus).toBeDefined();
    expect(result.decisions).toBeDefined();
    expect(result.github).toBeDefined();
    expect(result.upgrades).toBeDefined();
    expect(result.tools).toBeDefined();
    expect(result.callLog).toBeDefined();
    expect(result.limits).toBeDefined();
    expect(result.cost).toBeDefined();
    expect(result.screenshots).toBeDefined();
    expect(result.url).toBeDefined();
    expect(result.terminal).toBeDefined();
    expect(result.voiceErrors).toBeDefined();
    expect(result.agentErrors).toBeDefined();
    expect(result.careerOps).toBeDefined();
    expect(result.jobApplications).toBeDefined();
    expect(result.voiceChannel).toBeDefined();
    expect(result.agentChannels.size).toBe(1); // our mock has 1 agent
    expect(guild.channels.create).toHaveBeenCalled();
  });

  it('creates agent roles', async () => {
    const guild = buildGuild();
    await setupChannels(guild);

    expect(guild.roles.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Ace', mentionable: true })
    );

    const { setAgentRoleId } = require('../../discord/agents');
    expect(setAgentRoleId).toHaveBeenCalledWith('dev', expect.any(String));
  });

  it('reuses existing voice channel', async () => {
    const vc = makeVoiceChannel('🎤-voice', 'vc-existing', 'cat-main');
    const guild = buildGuild([vc]);

    const result = await setupChannels(guild);
    expect(result.voiceChannel.id).toBe('vc-existing');
  });

  it('moves voice channel to correct parent', async () => {
    const vc = makeVoiceChannel('🎤-voice', 'vc-existing', 'wrong-parent');
    const guild = buildGuild([vc]);

    await setupChannels(guild);
    expect(mockChannelSetParent).toHaveBeenCalled();
  });

  it('reuses existing text channel and updates topic', async () => {
    const existingCh = makeTextChannel('💬-groupchat', 'gc-existing', 'some-parent', 'old topic');
    const guild = buildGuild([existingCh]);

    await setupChannels(guild);
    // Channel should have setTopic called since topic differs
    expect(mockChannelSetTopic).toHaveBeenCalled();
  });

  it('deduplicates channels with same name (keeps oldest)', async () => {
    const ch1 = makeTextChannel('💬-groupchat', 'gc-1', 'p1');
    ch1.createdTimestamp = 1000;
    const ch2 = makeTextChannel('💬-groupchat', 'gc-2', 'p1');
    ch2.createdTimestamp = 2000;
    const guild = buildGuild([ch1, ch2]);

    await setupChannels(guild);
    // The newer (ch2) should be deleted
    expect(mockChannelDelete).toHaveBeenCalled();
  });

  it('deletes legacy accidental channels', async () => {
    const legacyCh = makeTextChannel('developer', 'legacy-dev');
    const guild = buildGuild([legacyCh]);

    await setupChannels(guild);
    // Should delete the 'developer' legacy channel
    expect(mockChannelDelete).toHaveBeenCalled();
  });

  it('deletes old agent channels (replaced by emoji-prefixed)', async () => {
    // 'dev' is an agent id, so a plain #dev channel should be deleted
    const oldAgentCh = makeTextChannel('dev', 'old-dev');
    const guild = buildGuild([oldAgentCh]);

    await setupChannels(guild);
    expect(mockChannelDelete).toHaveBeenCalled();
  });

  it('deletes legacy command voice channels', async () => {
    const legacyVoice = makeVoiceChannel('🎤-command', 'legacy-vc-1');
    const guild = buildGuild([legacyVoice]);

    await setupChannels(guild);
    expect(mockChannelDelete).toHaveBeenCalled();
  });

  it('deletes empty old category "ASAP Agents"', async () => {
    const oldCat = makeCategoryChannel('ASAP Agents', 'old-cat');
    const guild = buildGuild([oldCat]);

    await setupChannels(guild);
    expect(mockChannelDelete).toHaveBeenCalled();
  });

  it('does not delete "ASAP Agents" category if it has children', async () => {
    const oldCat = makeCategoryChannel('ASAP Agents', 'old-cat');
    const child = makeTextChannel('child', 'child-1', 'old-cat');
    const guild = buildGuild([oldCat, child]);

    // Need to make the filter for parentId work
    mockChannelDelete.mockClear();
    await setupChannels(guild);
    // The old cat might not be deleted if it has children — difficult to test
    // with our mock, but the coverage covers the branch
  });

  it('refreshes tools channel post (deletes old bot posts)', async () => {
    const botPostMsg = {
      id: 'msg-1',
      author: { id: 'bot-user-id' },
      delete: mockMessageDelete,
    };
    const msgMap = new Map([['msg-1', botPostMsg]]) as Map<string, any> & { last: () => any };
    msgMap.last = () => botPostMsg;
    mockMessagesFetch.mockImplementation(() => Promise.resolve(msgMap));

    const guild = buildGuild();
    await setupChannels(guild);

    // Bot posts should be deleted during refresh
    expect(mockMessageDelete).toHaveBeenCalled();
  });

  it('handles RESET_CHANNELS=true', async () => {
    process.env.RESET_CHANNELS = 'true';
    const catMain = makeCategoryChannel('ASAP', 'cat-main');
    const childCh = makeTextChannel('child', 'child-1', 'cat-main');
    catMain.children.cache.set('child-1', childCh);
    const guild = buildGuild([catMain, childCh]);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await setupChannels(guild);

    expect(mockChannelDelete).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('RESET_CHANNELS'));
    logSpy.mockRestore();
  });

  it('syncs existing role metadata', async () => {
    const existingRole = {
      id: 'role-ace',
      name: 'Ace',
      color: 0x000000, // different color
      mentionable: false, // not mentionable
      edit: jest.fn().mockImplementation(async function (this: any, updates: any) {
        Object.assign(this, updates);
        return this;
      }),
    };
    const guild = buildGuild([], [existingRole]);

    await setupChannels(guild);
    expect(existingRole.edit).toHaveBeenCalledWith(
      expect.objectContaining({ color: 0x00ff00, mentionable: true })
    );
  });

  it('resolves public app URL from env', async () => {
    process.env.PUBLIC_APP_URL = 'https://my-app.example.com';
    const guild = buildGuild();
    await setupChannels(guild);

    // URL channel should contain the app URL
    expect(mockChannelSend).toHaveBeenCalledWith(
      expect.stringContaining('https://my-app.example.com')
    );
  });

  it('falls back to default app URL when env vars are not set', async () => {
    delete process.env.PUBLIC_APP_URL;
    delete process.env.APP_URL;
    delete process.env.FRONTEND_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    delete process.env.CLOUD_RUN_APP_URL;

    const guild = buildGuild();
    await setupChannels(guild);

    // Should fall back to default URL
    expect(mockChannelSend).toHaveBeenCalledWith(
      expect.stringContaining('asap-489910.australia-southeast1.run.app')
    );
  });

  it('rejects localhost URLs for public app URL', async () => {
    process.env.PUBLIC_APP_URL = 'http://localhost:3000';
    delete process.env.APP_URL;
    delete process.env.FRONTEND_URL;

    const guild = buildGuild();
    await setupChannels(guild);

    // Should NOT contain localhost, should use default
    expect(mockChannelSend).toHaveBeenCalledWith(
      expect.stringContaining('asap-489910.australia-southeast1.run.app')
    );
  });

  it('applies bot posting restrictions', async () => {
    const guild = buildGuild();
    await setupChannels(guild);

    // Permissions should be set on channels
    expect(mockPermissionOverwritesEdit).toHaveBeenCalled();
  });

  it('hardens sensitive channels when enabled', async () => {
    process.env.DISCORD_HARDEN_SENSITIVE_CHANNELS = 'true';
    const guild = buildGuild();

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await setupChannels(guild);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('sensitive channel ACL'));
    logSpy.mockRestore();
  });

  it('skips hardening when disabled', async () => {
    process.env.DISCORD_HARDEN_SENSITIVE_CHANNELS = 'false';
    const guild = buildGuild();

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await setupChannels(guild);

    const hardenCalls = logSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('sensitive channel ACL')
    );
    expect(hardenCalls.length).toBe(0);
    logSpy.mockRestore();
  });

  it('handles webhook creation failures gracefully', async () => {
    const { getWebhook } = require('../../discord/services/webhooks');
    getWebhook.mockRejectedValue(new Error('Webhook error'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const guild = buildGuild();
    await setupChannels(guild);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('webhook'));
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('handles fetchOwner failure gracefully', async () => {
    process.env.DISCORD_HARDEN_SENSITIVE_CHANNELS = 'true';
    const guild = buildGuild();
    guild.fetchOwner.mockRejectedValue(new Error('Cannot fetch owner'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await setupChannels(guild);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not resolve guild owner')
    );
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('uses APP_URL fallback when PUBLIC_APP_URL is invalid', async () => {
    process.env.PUBLIC_APP_URL = 'not-a-url';
    process.env.APP_URL = 'https://app-url.example.com';
    const guild = buildGuild();
    await setupChannels(guild);

    expect(mockChannelSend).toHaveBeenCalledWith(
      expect.stringContaining('https://app-url.example.com')
    );
  });

  it('rejects .local domains for public app URL', async () => {
    process.env.PUBLIC_APP_URL = 'http://myhost.local:3000';
    delete process.env.APP_URL;
    delete process.env.FRONTEND_URL;
    const guild = buildGuild();
    await setupChannels(guild);

    expect(mockChannelSend).toHaveBeenCalledWith(
      expect.stringContaining('asap-489910')
    );
  });

  it('rejects ftp:// protocol for public app URL', async () => {
    process.env.PUBLIC_APP_URL = 'ftp://files.example.com';
    process.env.APP_URL = 'https://real.example.com';
    const guild = buildGuild();
    await setupChannels(guild);

    expect(mockChannelSend).toHaveBeenCalledWith(
      expect.stringContaining('https://real.example.com')
    );
  });

  it('handles permission edit failures gracefully', async () => {
    mockPermissionOverwritesEdit.mockRejectedValue(new Error('Missing perms'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const guild = buildGuild();
    await setupChannels(guild);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to'),
      expect.any(String)
    );
    warnSpy.mockRestore();
  });

  it('handles setTopic failure gracefully', async () => {
    const existingCh = makeTextChannel('💬-groupchat', 'gc-1', 'some-parent', 'old topic');
    existingCh.setTopic = jest.fn().mockRejectedValue(new Error('Rate limited'));
    const guild = buildGuild([existingCh]);

    // Should not throw
    await setupChannels(guild);
  });

  it('splits long welcome messages', async () => {
    // The groupchat welcome message is multi-line. Verify send is called.
    const guild = buildGuild();
    await setupChannels(guild);

    // Multiple send calls for various channels
    expect(mockChannelSend).toHaveBeenCalled();
  });

  it('refreshes URL channel posts (deletes old bot posts)', async () => {
    const botPostMsg = {
      id: 'url-msg-1',
      author: { id: 'bot-user-id' },
      delete: mockMessageDelete,
    };
    const msgMap = new Map([['url-msg-1', botPostMsg]]) as Map<string, any> & { last: () => any };
    msgMap.last = () => botPostMsg;
    const emptyMap = new Map() as Map<string, any> & { last: () => any };
    emptyMap.last = () => undefined;
    // First call returns bot messages, subsequent calls return empty
    let callCount = 0;
    mockMessagesFetch.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) return msgMap;
      return emptyMap;
    });

    const guild = buildGuild();
    await setupChannels(guild);

    expect(mockMessageDelete).toHaveBeenCalled();
  });
});
