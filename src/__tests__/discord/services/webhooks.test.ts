import { ChannelType } from 'discord.js';

jest.mock('discord.js', () => ({
  ChannelType: {
    GuildText: 0,
    PublicThread: 11,
    PrivateThread: 12,
    AnnouncementThread: 10,
  },
}));

// We need to test the module in isolation. Import after mocks.
// The module uses module-level state (webhookCache) so we test via exports.
let getWebhook: any;
let sendWebhookMessage: any;
let clearWebhookCache: any;

beforeEach(() => {
  jest.resetModules();
  jest.mock('discord.js', () => ({
    ChannelType: {
      GuildText: 0,
      PublicThread: 11,
      PrivateThread: 12,
      AnnouncementThread: 10,
    },
  }));
  const mod = require('../../../discord/services/webhooks');
  getWebhook = mod.getWebhook;
  sendWebhookMessage = mod.sendWebhookMessage;
  clearWebhookCache = mod.clearWebhookCache;
});

function makeTextChannel(overrides: any = {}): any {
  return {
    id: 'ch-1',
    type: 0, // GuildText
    fetchWebhooks: jest.fn().mockResolvedValue(new Map()),
    createWebhook: jest.fn().mockResolvedValue({ id: 'wh-1', name: 'ASAP Agent', send: jest.fn() }),
    client: { user: { id: 'bot-1' } },
    ...overrides,
  };
}

function makeThread(parentChannel: any): any {
  return {
    id: 'thread-1',
    type: 11, // PublicThread
    parent: parentChannel,
  };
}

describe('getWebhook', () => {
  it('creates a webhook when none exists', async () => {
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: () => undefined }),
    });
    const wh = await getWebhook(channel);
    expect(channel.createWebhook).toHaveBeenCalledWith(expect.objectContaining({ name: 'ASAP Agent' }));
  });

  it('reuses existing ASAP webhook', async () => {
    const existingWh = { id: 'wh-existing', name: 'ASAP Agent', owner: { id: 'bot-1' } };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(existingWh) ? existingWh : undefined }),
    });
    const wh = await getWebhook(channel);
    expect(channel.createWebhook).not.toHaveBeenCalled();
    expect(wh).toBe(existingWh);
  });

  it('caches webhook for subsequent calls', async () => {
    const existingWh = { id: 'wh-cached', name: 'ASAP Agent', owner: { id: 'bot-1' } };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(existingWh) ? existingWh : undefined }),
    });
    await getWebhook(channel);
    await getWebhook(channel);
    // Should only fetch webhooks once due to caching
    expect(channel.fetchWebhooks).toHaveBeenCalledTimes(1);
  });

  it('resolves webhook parent for threads', async () => {
    const parentChannel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: () => undefined }),
    });
    const thread = makeThread(parentChannel);
    await getWebhook(thread);
    expect(parentChannel.fetchWebhooks).toHaveBeenCalled();
  });
});

describe('sendWebhookMessage', () => {
  it('sends a message via webhook', async () => {
    const mockSend = jest.fn().mockResolvedValue({ id: 'msg-1' });
    const existingWh = { id: 'wh-1', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSend };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(existingWh) ? existingWh : undefined }),
    });

    const result = await sendWebhookMessage(channel, { content: 'Hello' } as any);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ content: 'Hello' }));
  });

  it('includes threadId for thread channels', async () => {
    const mockSend = jest.fn().mockResolvedValue({ id: 'msg-2' });
    const existingWh = { id: 'wh-2', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSend };
    const parentChannel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(existingWh) ? existingWh : undefined }),
    });
    const thread = makeThread(parentChannel);

    await sendWebhookMessage(thread, { content: 'Thread msg' } as any);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
  });

  it('retries on stale webhook error', async () => {
    const mockSendFail = jest.fn()
      .mockRejectedValueOnce({ code: 10015, message: 'Unknown Webhook' })
      .mockResolvedValueOnce({ id: 'msg-retry' });
    const staleWh = { id: 'wh-stale', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSendFail };
    const freshWh = { id: 'wh-fresh', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSendFail };

    let callCount = 0;
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockImplementation(() => ({
        find: (fn: any) => {
          const wh = callCount++ === 0 ? staleWh : freshWh;
          return fn(wh) ? wh : undefined;
        },
      })),
    });

    const result = await sendWebhookMessage(channel, { content: 'Retry' } as any);
    expect(result).toEqual({ id: 'msg-retry' });
  });

  it('throws on non-stale webhook errors', async () => {
    const mockSend = jest.fn().mockRejectedValue(new Error('Permission denied'));
    const wh = { id: 'wh-err', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSend };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(wh) ? wh : undefined }),
    });

    await expect(sendWebhookMessage(channel, { content: 'Fail' } as any)).rejects.toThrow('Permission denied');
  });

  it('sanitizes username in options', async () => {
    const mockSend = jest.fn().mockResolvedValue({ id: 'msg-3' });
    const wh = { id: 'wh-3', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSend };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(wh) ? wh : undefined }),
    });

    await sendWebhookMessage(channel, { content: 'Hi', username: 'Cortana (Executive Assistant)✦' } as any);
    const sentOptions = mockSend.mock.calls[0][0];
    expect(sentOptions.username).not.toContain('✦');
  });
});

describe('clearWebhookCache', () => {
  it('clears the cache without throwing', () => {
    expect(() => clearWebhookCache()).not.toThrow();
  });
});

describe('resolveWebhookParent – thread without valid parent', () => {
  it('throws when thread parent is null', async () => {
    const thread = { id: 'thread-orphan', type: 11, parent: null };
    await expect(getWebhook(thread as any)).rejects.toThrow('does not have a text-channel parent');
  });

  it('throws when thread parent type is not GuildText', async () => {
    const thread = { id: 'thread-wrong', type: 12, parent: { id: 'voice-1', type: 2 } };
    await expect(getWebhook(thread as any)).rejects.toThrow('does not have a text-channel parent');
  });
});

describe('getWebhook – stale cache', () => {
  it('refetches when cache TTL expires', async () => {
    const existingWh = { id: 'wh-ttl', name: 'ASAP Agent', owner: { id: 'bot-1' } };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(existingWh) ? existingWh : undefined }),
    });

    await getWebhook(channel);
    expect(channel.fetchWebhooks).toHaveBeenCalledTimes(1);

    // Advance Date.now past the default 6h TTL
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 22_000_000);

    await getWebhook(channel);
    expect(channel.fetchWebhooks).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });
});

describe('isStaleWebhookError – alternate true branches', () => {
  it('retries on code 10003 (Unknown Channel)', async () => {
    const mockSendFail = jest.fn()
      .mockRejectedValueOnce({ code: 10003, message: 'Unknown Channel' })
      .mockResolvedValueOnce({ id: 'msg-10003' });
    const wh = { id: 'wh-10003', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSendFail };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(wh) ? wh : undefined }),
    });
    const result = await sendWebhookMessage(channel, { content: 'test' } as any);
    expect(result).toEqual({ id: 'msg-10003' });
  });

  it('retries on message containing "unknown channel"', async () => {
    const mockSendFail = jest.fn()
      .mockRejectedValueOnce(new Error('unknown channel 12345'))
      .mockResolvedValueOnce({ id: 'msg-uc' });
    const wh = { id: 'wh-uc', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSendFail };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(wh) ? wh : undefined }),
    });
    const result = await sendWebhookMessage(channel, { content: 'test' } as any);
    expect(result).toEqual({ id: 'msg-uc' });
  });

  it('retries on message containing "404"', async () => {
    const mockSendFail = jest.fn()
      .mockRejectedValueOnce(new Error('404 Not Found'))
      .mockResolvedValueOnce({ id: 'msg-404' });
    const wh = { id: 'wh-404', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSendFail };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(wh) ? wh : undefined }),
    });
    const result = await sendWebhookMessage(channel, { content: 'test' } as any);
    expect(result).toEqual({ id: 'msg-404' });
  });
});

describe('sanitizeWebhookUsername – edge cases', () => {
  it('sends without username when username is null', async () => {
    const mockSend = jest.fn().mockResolvedValue({ id: 'msg-null' });
    const wh = { id: 'wh-null', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSend };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(wh) ? wh : undefined }),
    });
    await sendWebhookMessage(channel, { content: 'Hi', username: null } as any);
    const sentOptions = mockSend.mock.calls[0][0];
    // sanitizeWebhookUsername returns undefined for null → original options used
    expect(sentOptions.content).toBe('Hi');
  });

  it('sends without username when username is empty string', async () => {
    const mockSend = jest.fn().mockResolvedValue({ id: 'msg-empty' });
    const wh = { id: 'wh-empty', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSend };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(wh) ? wh : undefined }),
    });
    await sendWebhookMessage(channel, { content: 'Hi', username: '' } as any);
    const sentOptions = mockSend.mock.calls[0][0];
    expect(sentOptions.content).toBe('Hi');
  });

  it('strips trailing symbol clusters separated by whitespace', async () => {
    const mockSend = jest.fn().mockResolvedValue({ id: 'msg-sym' });
    const wh = { id: 'wh-sym', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSend };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(wh) ? wh : undefined }),
    });
    await sendWebhookMessage(channel, { content: 'Hi', username: 'Cortana ★' } as any);
    const sentOptions = mockSend.mock.calls[0][0];
    expect(sentOptions.username).toBe('Cortana');
  });

  it('clips username to 80 characters', async () => {
    const mockSend = jest.fn().mockResolvedValue({ id: 'msg-long' });
    const wh = { id: 'wh-long', name: 'ASAP Agent', owner: { id: 'bot-1' }, send: mockSend };
    const channel = makeTextChannel({
      fetchWebhooks: jest.fn().mockResolvedValue({ find: (fn: any) => fn(wh) ? wh : undefined }),
    });
    const longName = 'A'.repeat(100);
    await sendWebhookMessage(channel, { content: 'Hi', username: longName } as any);
    const sentOptions = mockSend.mock.calls[0][0];
    expect(sentOptions.username.length).toBe(80);
  });
});
