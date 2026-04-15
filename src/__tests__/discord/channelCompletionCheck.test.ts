/**
 * Tests for src/discord/channelCompletionCheck.ts
 *
 * Self-invoking script — calls `void main().catch(...)` on import.
 * We mock all deps and dynamically import the module so main()
 * runs in a controlled environment.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockProcessExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

// ---- FS / path ----
const mockMkdirSync = jest.fn();
const mockWriteFileSync = jest.fn();
jest.mock('node:fs', () => ({ mkdirSync: mockMkdirSync, writeFileSync: mockWriteFileSync }));
jest.mock('node:path', () => ({ join: (...parts: string[]) => parts.join('/') }));
jest.mock('dotenv/config', () => ({}));

// ---- discord.js ----
let readyCb: (() => void) | null = null;
const mockClientDestroy = jest.fn().mockResolvedValue(undefined);
const mockChannelSend = jest.fn().mockResolvedValue({ id: 'sent-1' });
const mockMessagesFetch = jest.fn().mockResolvedValue(new Map());
const mockChannelsCache = { find: jest.fn().mockReturnValue(undefined) };
const mockGuild = {
  channels: { fetch: jest.fn().mockResolvedValue(undefined), cache: mockChannelsCache },
};
const mockGuildsFetch = jest.fn().mockResolvedValue(mockGuild);
const mockLogin = jest.fn().mockResolvedValue('token');
const mockGetAgents = jest.fn().mockReturnValue(new Map());

function makeMockClient() {
  return {
    Client: class {
      user = { id: 'self-bot-id' };
      guilds = { fetch: (...a: any[]) => mockGuildsFetch(...a) };
      destroy = (...a: any[]) => mockClientDestroy(...a);
      once(event: string, cb: (...args: any[]) => void) { if (event === 'ready') readyCb = cb; return this; }
      login(t: string) { queueMicrotask(() => readyCb?.()); return mockLogin(t); }
    },
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  };
}

jest.mock('discord.js', () => makeMockClient());
jest.mock('../../discord/agents', () => ({ getAgents: (...a: any[]) => mockGetAgents(...a) }));
jest.mock('../../utils/errors', () => ({ errMsg: (e: any) => (e instanceof Error ? e.message : String(e)) }));

function makeChannel(name: string, type = 0) {
  return {
    name, type,
    isTextBased: () => type === 0,
    send: mockChannelSend,
    messages: { fetch: mockMessagesFetch },
  };
}

function resetAllMocks() {
  readyCb = null;
  mockClientDestroy.mockClear();
  mockChannelSend.mockClear().mockResolvedValue({ id: 'sent-1' });
  mockMessagesFetch.mockClear().mockResolvedValue(new Map());
  mockGuildsFetch.mockClear().mockResolvedValue(mockGuild);
  mockGuild.channels.fetch.mockClear().mockResolvedValue(undefined);
  mockLogin.mockClear().mockResolvedValue('token');
  mockMkdirSync.mockClear();
  mockWriteFileSync.mockClear();
  mockProcessExit.mockClear();
  mockGetAgents.mockClear().mockReturnValue(new Map());
  mockChannelsCache.find.mockClear().mockReturnValue(undefined);
}

/**
 * For "slow-path" tests where waitForTokenReply loops with sleep(2200),
 * we speed things up by:
 *   1. Making setTimeout fire immediately (sleep becomes ~0ms)
 *   2. Mocking Date.now to advance 5s per call (timeout expires fast)
 */
function installFastTimeMocks(): { cleanup: () => void } {
  const origST = global.setTimeout;
  // Speed up all setTimeout to fire immediately
  global.setTimeout = ((fn: (...a: any[]) => void, _ms?: number, ...args: any[]) =>
    origST(fn, 0, ...args)) as any;

  let dateCalls = 0;
  const baseTime = Date.now();
  const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => baseTime + (++dateCalls * 3000));

  return {
    cleanup: () => {
      global.setTimeout = origST;
      dateNowSpy.mockRestore();
    },
  };
}

/**
 * For "fast-path" tests where the token is found immediately,
 * we only need setTimeout mock (no Date.now mock) so the retry
 * jitter/backoff sleeps resolve instantly.
 */
function installFastSleepOnly(): { cleanup: () => void } {
  const origST = global.setTimeout;
  global.setTimeout = ((fn: (...a: any[]) => void, _ms?: number, ...args: any[]) =>
    origST(fn, 0, ...args)) as any;
  return { cleanup: () => { global.setTimeout = origST; } };
}

async function importModule(realNow?: () => number): Promise<void> {
  jest.resetModules();
  jest.doMock('dotenv/config', () => ({}));
  jest.doMock('node:fs', () => ({ mkdirSync: mockMkdirSync, writeFileSync: mockWriteFileSync }));
  jest.doMock('node:path', () => ({ join: (...parts: string[]) => parts.join('/') }));
  jest.doMock('discord.js', () => makeMockClient());
  jest.doMock('../../discord/agents', () => ({ getAgents: (...a: any[]) => mockGetAgents(...a) }));
  jest.doMock('../../utils/errors', () => ({ errMsg: (e: any) => (e instanceof Error ? e.message : String(e)) }));

  const origST = globalThis.setTimeout;
  const now = realNow || Date.now.bind(Date);
  await import('../../discord/channelCompletionCheck');
  // Poll for main() completion (it always calls process.exit)
  const t0 = now();
  while (!mockProcessExit.mock.calls.length) {
    await new Promise<void>((r) => origST(r, 5));
    if (now() - t0 > 60_000) break;
  }
}

describe('channelCompletionCheck', () => {
  jest.setTimeout(30000);
  const origEnv = { ...process.env };
  const origArgv = [...process.argv];

  beforeEach(() => resetAllMocks());
  afterEach(() => {
    process.env = { ...origEnv };
    process.argv = [...origArgv];
  });
  afterAll(() => mockProcessExit.mockRestore());

  // ---- fast-fail paths (env missing, no agents) ----

  it('exits 1 when DISCORD_TEST_BOT_TOKEN missing', async () => {
    delete process.env.DISCORD_TEST_BOT_TOKEN;
    delete process.env.DISCORD_GUILD_ID;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await importModule();

    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(spy).toHaveBeenCalledWith('Fatal:', expect.stringContaining('DISCORD_TEST_BOT_TOKEN'));
    spy.mockRestore();
  });

  it('exits 1 when DISCORD_GUILD_ID missing', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    delete process.env.DISCORD_GUILD_ID;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await importModule();

    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(spy).toHaveBeenCalledWith('Fatal:', expect.stringContaining('DISCORD_GUILD_ID'));
    spy.mockRestore();
  });

  it('exits 1 when no agents match', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    mockGetAgents.mockReturnValue(new Map());
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await importModule();

    expect(mockProcessExit).toHaveBeenCalledWith(1);
    expect(mockClientDestroy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // ---- channel-not-found path (fast — no waitForTokenReply) ----

  it('records channel-not-found and exits 1', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    process.argv = [...origArgv, '--retries=1', '--inter-agent-stagger-ms=0', '--inter-batch-delay-ms=0'];
    mockGetAgents.mockReturnValue(new Map([['qa', { id: 'qa', name: 'QA', channelName: 'qa-ch' }]]));
    mockChannelsCache.find.mockReturnValue(undefined);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await importModule();

    expect(mockWriteFileSync).toHaveBeenCalled();
    const report = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(report.results[0].ok).toBe(false);
    expect(report.results[0].attempts[0].reason).toBe('Channel not found');
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    logSpy.mockRestore();
  });

  it('handles multiple agents, all channels not found', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    process.argv = [...origArgv, '--retries=1', '--batch-size=2', '--inter-agent-stagger-ms=0', '--inter-batch-delay-ms=0'];
    mockGetAgents.mockReturnValue(new Map([
      ['a', { id: 'a', name: 'A', channelName: 'a-ch' }],
      ['b', { id: 'b', name: 'B', channelName: 'b-ch' }],
      ['c', { id: 'c', name: 'C', channelName: 'c-ch' }],
    ]));
    mockChannelsCache.find.mockReturnValue(undefined);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await importModule();

    const report = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(report.results.length).toBe(3);
    expect(report.failed).toBe(3);
    logSpy.mockRestore();
  });

  // ---- PASS path (token found on first fetch — fast) ----

  it('exits 0 when bot reply contains token', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    process.argv = [...origArgv, '--retries=1', '--inter-agent-stagger-ms=0', '--inter-batch-delay-ms=0'];

    mockGetAgents.mockReturnValue(new Map([['qa', { id: 'qa', name: 'QA', channelName: 'qa-ch' }]]));
    const ch = makeChannel('qa-ch');

    // Dynamic reply: extract token from the sent prompt and echo it back
    ch.messages.fetch = jest.fn().mockImplementation(async () => {
      const calls = mockChannelSend.mock.calls;
      if (calls.length) {
        const prompt = calls[calls.length - 1][0] as string;
        const m = prompt.match(/TOKEN:(\S+)/);
        if (m) {
          const map = new Map();
          map.set('r1', {
            author: { id: 'bot1', bot: true },
            webhookId: null,
            content: `Two paragraphs of great content. TOKEN:${m[1]}`,
            embeds: [],
            createdTimestamp: Date.now(),
          });
          return map;
        }
      }
      return new Map();
    });
    mockChannelsCache.find.mockReturnValue(ch);

    const fast = installFastSleepOnly();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await importModule();
    } finally {
      fast.cleanup();
    }

    const report = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(report.passed).toBe(1);
    expect(report.results[0].ok).toBe(true);
    expect(mockProcessExit).toHaveBeenCalledWith(0);
    logSpy.mockRestore();
  });

  it('PASS via webhook reply', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    process.argv = [...origArgv, '--retries=1', '--inter-agent-stagger-ms=0', '--inter-batch-delay-ms=0'];

    mockGetAgents.mockReturnValue(new Map([['qa', { id: 'qa', name: 'QA', channelName: 'qa-ch' }]]));
    const ch = makeChannel('qa-ch');
    ch.messages.fetch = jest.fn().mockImplementation(async () => {
      const calls = mockChannelSend.mock.calls;
      if (calls.length) {
        const m = (calls[calls.length - 1][0] as string).match(/TOKEN:(\S+)/);
        if (m) {
          const map = new Map();
          map.set('r1', {
            author: { id: 'wh-user', bot: false },
            webhookId: 'wh-123',
            content: `Webhook TOKEN:${m[1]}`,
            embeds: [],
            createdTimestamp: Date.now(),
          });
          return map;
        }
      }
      return new Map();
    });
    mockChannelsCache.find.mockReturnValue(ch);

    const fast = installFastSleepOnly();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try { await importModule(); } finally { fast.cleanup(); }

    const report = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(report.results[0].ok).toBe(true);
    logSpy.mockRestore();
  });

  it('PASS via embed description', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    process.argv = [...origArgv, '--retries=1', '--inter-agent-stagger-ms=0', '--inter-batch-delay-ms=0'];

    mockGetAgents.mockReturnValue(new Map([['qa', { id: 'qa', name: 'QA', channelName: 'qa-ch' }]]));
    const ch = makeChannel('qa-ch');
    ch.messages.fetch = jest.fn().mockImplementation(async () => {
      const calls = mockChannelSend.mock.calls;
      if (calls.length) {
        const m = (calls[calls.length - 1][0] as string).match(/TOKEN:(\S+)/);
        if (m) {
          const map = new Map();
          map.set('r1', {
            author: { id: 'bot1', bot: true }, webhookId: null,
            content: '',
            embeds: [{ description: `Embedded TOKEN:${m[1]}` }],
            createdTimestamp: Date.now(),
          });
          return map;
        }
      }
      return new Map();
    });
    mockChannelsCache.find.mockReturnValue(ch);

    const fast = installFastSleepOnly();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try { await importModule(); } finally { fast.cleanup(); }

    const report = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(report.results[0].ok).toBe(true);
    logSpy.mockRestore();
  });

  // ---- FAIL paths with fast-time mocks ----

  it('FAIL: no reply at all (fast-time)', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    process.argv = [...origArgv, '--retries=1', '--inter-agent-stagger-ms=0', '--inter-batch-delay-ms=0'];

    mockGetAgents.mockReturnValue(new Map([['qa', { id: 'qa', name: 'QA', channelName: 'qa-ch' }]]));
    const ch = makeChannel('qa-ch');
    ch.messages.fetch = jest.fn().mockResolvedValue(new Map());
    mockChannelsCache.find.mockReturnValue(ch);

    const realNow = Date.now.bind(Date);
    const fast = installFastTimeMocks();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try { await importModule(realNow); } finally { fast.cleanup(); }

    expect(mockWriteFileSync).toHaveBeenCalled();
    const report = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(report.results[0].ok).toBe(false);
    expect(mockProcessExit).toHaveBeenCalledWith(1);
    logSpy.mockRestore();
  });

  it('FAIL: reply with text but wrong token (fast-time)', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    process.argv = [...origArgv, '--retries=1', '--inter-agent-stagger-ms=0', '--inter-batch-delay-ms=0'];

    mockGetAgents.mockReturnValue(new Map([['qa', { id: 'qa', name: 'QA', channelName: 'qa-ch' }]]));
    const ch = makeChannel('qa-ch');
    const wrongTokenMsgs = new Map();
    wrongTokenMsgs.set('r1', {
      author: { id: 'bot1', bot: true }, webhookId: null,
      content: 'Some reply without the right token TOKEN:WRONG',
      embeds: [],
      createdTimestamp: 1000,
    });
    ch.messages.fetch = jest.fn().mockResolvedValue(wrongTokenMsgs);
    mockChannelsCache.find.mockReturnValue(ch);

    const realNow = Date.now.bind(Date);
    const fast = installFastTimeMocks();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try { await importModule(realNow); } finally { fast.cleanup(); }

    expect(mockWriteFileSync).toHaveBeenCalled();
    const report = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(report.results[0].ok).toBe(false);
    logSpy.mockRestore();
  });

  it('FAIL: only progress placeholder replies (fast-time)', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    process.argv = [...origArgv, '--retries=1', '--inter-agent-stagger-ms=0', '--inter-batch-delay-ms=0'];

    mockGetAgents.mockReturnValue(new Map([['qa', { id: 'qa', name: 'QA', channelName: 'qa-ch' }]]));
    const ch = makeChannel('qa-ch');
    const placeholderMsgs = new Map();
    placeholderMsgs.set('r1', {
      author: { id: 'bot1', bot: true }, webhookId: null,
      content: 'Thinking…',
      embeds: [],
      createdTimestamp: 1000,
    });
    ch.messages.fetch = jest.fn().mockResolvedValue(placeholderMsgs);
    mockChannelsCache.find.mockReturnValue(ch);

    const realNow = Date.now.bind(Date);
    const fast = installFastTimeMocks();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try { await importModule(realNow); } finally { fast.cleanup(); }

    const report = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(report.results[0].ok).toBe(false);
    logSpy.mockRestore();
  });

  it('FAIL: self and non-bot messages skipped (fast-time)', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    process.argv = [...origArgv, '--retries=1', '--inter-agent-stagger-ms=0', '--inter-batch-delay-ms=0'];

    mockGetAgents.mockReturnValue(new Map([['qa', { id: 'qa', name: 'QA', channelName: 'qa-ch' }]]));
    const ch = makeChannel('qa-ch');
    const msgs = new Map();
    msgs.set('r1', { author: { id: 'self-bot-id', bot: false }, webhookId: null, content: 'Self msg TOKEN:X', embeds: [], createdTimestamp: 1000 });
    msgs.set('r2', { author: { id: 'user1', bot: false }, webhookId: null, content: 'User msg TOKEN:X', embeds: [], createdTimestamp: 2000 });
    ch.messages.fetch = jest.fn().mockResolvedValue(msgs);
    mockChannelsCache.find.mockReturnValue(ch);

    const realNow = Date.now.bind(Date);
    const fast = installFastTimeMocks();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try { await importModule(realNow); } finally { fast.cleanup(); }

    const report = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(report.results[0].ok).toBe(false);
    logSpy.mockRestore();
  });

  it('FAIL: messages.fetch throws (fast-time)', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    process.argv = [...origArgv, '--retries=1', '--inter-agent-stagger-ms=0', '--inter-batch-delay-ms=0'];

    mockGetAgents.mockReturnValue(new Map([['qa', { id: 'qa', name: 'QA', channelName: 'qa-ch' }]]));
    const ch = makeChannel('qa-ch');
    ch.messages.fetch = jest.fn().mockRejectedValue(new Error('API Error'));
    mockChannelsCache.find.mockReturnValue(ch);

    const realNow = Date.now.bind(Date);
    const fast = installFastTimeMocks();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try { await importModule(realNow); } finally { fast.cleanup(); }

    const report = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(report.results[0].ok).toBe(false);
    logSpy.mockRestore();
  });

  it('handles inter-batch delay with multiple batches', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    process.argv = [...origArgv, '--retries=1', '--batch-size=1', '--inter-agent-stagger-ms=0', '--inter-batch-delay-ms=100'];

    mockGetAgents.mockReturnValue(new Map([
      ['a', { id: 'a', name: 'A', channelName: 'a-ch' }],
      ['b', { id: 'b', name: 'B', channelName: 'b-ch' }],
    ]));
    mockChannelsCache.find.mockReturnValue(undefined);

    const realNow = Date.now.bind(Date);
    const fast = installFastTimeMocks();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try { await importModule(realNow); } finally { fast.cleanup(); }

    const report = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(report.results.length).toBe(2);
    logSpy.mockRestore();
  });

  it('handles stagger between agents in same batch', async () => {
    process.env.DISCORD_TEST_BOT_TOKEN = 'tok';
    process.env.DISCORD_GUILD_ID = 'g1';
    process.argv = [...origArgv, '--retries=1', '--batch-size=3', '--inter-agent-stagger-ms=100', '--inter-batch-delay-ms=0'];

    mockGetAgents.mockReturnValue(new Map([
      ['a', { id: 'a', name: 'A', channelName: 'a-ch' }],
      ['b', { id: 'b', name: 'B', channelName: 'b-ch' }],
      ['c', { id: 'c', name: 'C', channelName: 'c-ch' }],
    ]));
    mockChannelsCache.find.mockReturnValue(undefined);

    const realNow = Date.now.bind(Date);
    const fast = installFastTimeMocks();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try { await importModule(realNow); } finally { fast.cleanup(); }

    const report = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(report.results.length).toBe(3);
    logSpy.mockRestore();
  });
});
