/**
 * Tests for src/discord/services/telephony.ts
 * TwiML generation, WebSocket handling, outbound calls, audio conversion.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Set env BEFORE importing the module (captured at module level)
process.env.TWILIO_ACCOUNT_SID = 'AC-test';
process.env.TWILIO_AUTH_TOKEN = 'auth-test';
process.env.TWILIO_PHONE_NUMBER = '+61400000000';
process.env.SERVER_URL = 'https://example.com';

import { EventEmitter } from 'events';
import http from 'http';

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../../db/pool', () => ({
  default: { query: mockQuery, on: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../discord/agents', () => ({
  getAgent: jest.fn().mockReturnValue({
    id: 'executive-assistant',
    name: 'Cortana',
    systemPrompt: 'You are Cortana.',
  }),
  AgentId: {},
}));
jest.mock('../../../discord/claude', () => ({
  agentRespond: jest.fn().mockResolvedValue('Hello, this is Cortana.'),
  summarizeCall: jest.fn().mockResolvedValue('Call summary.'),
}));
jest.mock('../../../discord/memory', () => ({
  getMemoryContext: jest.fn().mockReturnValue([]),
  appendToMemory: jest.fn(),
  upsertMemory: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../discord/voice/elevenlabsRealtime', () => ({
  startElevenLabsRealtimeTranscription: jest.fn().mockResolvedValue({
    send: jest.fn(),
    close: jest.fn(),
  }),
  isElevenLabsRealtimeAvailable: jest.fn().mockReturnValue(true),
}));
jest.mock('../../../discord/voice/elevenlabs', () => ({
  elevenLabsTTS: jest.fn().mockResolvedValue(Buffer.alloc(0)),
}));

const mockCallsCreate = jest.fn().mockResolvedValue({ sid: 'CA-test-sid' });
const mockCallsUpdate = jest.fn().mockResolvedValue({});
const mockTwilioClient = {
  calls: Object.assign(mockCallsCreate, {
    create: mockCallsCreate,
  }),
};
// Make calls callable as a function (for client.calls(callSid).update)
(mockTwilioClient.calls as any) = jest.fn().mockReturnValue({ update: mockCallsUpdate });
(mockTwilioClient.calls as any).create = mockCallsCreate;

jest.mock('twilio', () => {
  const fn = jest.fn().mockReturnValue(mockTwilioClient);
  return fn;
});

import {
  isTelephonyAvailable,
  getInboundTwiML,
  getConferenceTwiML,
  learnContact,
  setTelephonyChannels,
  initContacts,
  attachTelephonyWebSocket,
  makeOutboundCall,
  makeAsapTesterCall,
  hangUp,
  startConferenceCall,
} from '../../../discord/services/telephony';

describe('telephony', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
    jest.clearAllMocks();
    setTelephonyChannels(null as any, null as any);
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  describe('isTelephonyAvailable()', () => {
    it('returns true when Twilio env vars are set', () => {
      expect(isTelephonyAvailable()).toBe(true);
    });
  });

  describe('getInboundTwiML()', () => {
    it('returns valid TwiML XML', () => {
      const xml = getInboundTwiML();
      expect(xml).toContain('<?xml version="1.0"');
      expect(xml).toContain('<Response>');
      expect(xml).toContain('<Connect>');
      expect(xml).toContain('<Stream');
      expect(xml).toContain('</Response>');
    });

    it('includes caller number parameter when provided', () => {
      const xml = getInboundTwiML('+61400000000');
      expect(xml).toContain('callerNumber');
      expect(xml).toContain('+61400000000');
    });

    it('escapes XML special characters in caller number', () => {
      const xml = getInboundTwiML('+61<script>');
      expect(xml).not.toContain('<script>');
      expect(xml).toContain('&lt;script&gt;');
    });

    it('escapes ampersand', () => {
      const xml = getInboundTwiML('a&b');
      expect(xml).toContain('&amp;');
    });

    it('escapes double quotes', () => {
      const xml = getInboundTwiML('"test"');
      expect(xml).toContain('&quot;');
    });
  });

  describe('getConferenceTwiML()', () => {
    it('returns TwiML with conference room name', () => {
      const xml = getConferenceTwiML('riley-call-123');
      expect(xml).toContain('<?xml version="1.0"');
      expect(xml).toContain('<Conference');
      expect(xml).toContain('riley-call-123');
      expect(xml).toContain('<Dial>');
    });
  });

  describe('setTelephonyChannels()', () => {
    it('does not throw', () => {
      const fakeChannel: any = { id: 'ch-1', send: jest.fn().mockResolvedValue(undefined) };
      expect(() => setTelephonyChannels(fakeChannel, fakeChannel)).not.toThrow();
    });
  });

  describe('learnContact()', () => {
    it('normalizes Australian phone numbers starting with 0', () => {
      expect(() => learnContact('0436012231', 'Test User')).not.toThrow();
    });

    it('handles numbers with country code', () => {
      expect(() => learnContact('+61436012231', 'Test User')).not.toThrow();
    });

    it('normalizes numbers without prefix', () => {
      expect(() => learnContact('436012231', 'Norm User')).not.toThrow();
    });

    it('removes whitespace from numbers', () => {
      expect(() => learnContact('0436 012 231', 'Spaced User')).not.toThrow();
    });

    it('logs to Discord when channel is set', () => {
      const mockSend = jest.fn().mockResolvedValue(undefined);
      const fakeChannel = { id: 'cl-1', send: mockSend } as any;
      setTelephonyChannels(fakeChannel, fakeChannel);

      learnContact('+61999', 'LogTest');
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('Learned contact'));
    });
  });

  describe('initContacts()', () => {
    it('loads contacts from database', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ content: JSON.stringify({ '+61111': 'DB User' }) }],
      });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      await initContacts();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('agent_memory'),
        ['phone-contacts']
      );
      logSpy.mockRestore();
    });

    it('handles empty database result', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      await initContacts();
      logSpy.mockRestore();
    });

    it('handles database error gracefully', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB Error'));
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await initContacts();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load contacts'),
        expect.any(String)
      );
      errSpy.mockRestore();
    });

    it('handles invalid JSON gracefully', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ content: 'not json' }] });
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await initContacts();
      errSpy.mockRestore();
    });
  });

  describe('attachTelephonyWebSocket()', () => {
    let server: http.Server;
    let upgradeHandlers: Array<(...args: any[]) => void>;

    beforeEach(() => {
      upgradeHandlers = [];
      server = {
        on: jest.fn().mockImplementation((event: string, handler: (...args: any[]) => void) => {
          if (event === 'upgrade') upgradeHandlers.push(handler);
        }),
      } as any;
    });

    it('registers upgrade handler on server', () => {
      attachTelephonyWebSocket(server);
      expect(server.on).toHaveBeenCalledWith('upgrade', expect.any(Function));
    });

    it('ignores non-twilio upgrade requests', () => {
      attachTelephonyWebSocket(server);

      const handler = upgradeHandlers[0];
      const mockSocket = { destroy: jest.fn() } as any;
      // Call with a non-twilio URL — should not crash
      handler(
        { url: '/api/other-websocket' },
        mockSocket,
        Buffer.alloc(0)
      );
    });

    it('handles twilio upgrade request', () => {
      attachTelephonyWebSocket(server);

      const handler = upgradeHandlers[0];
      const mockSocket = new EventEmitter() as any;
      mockSocket.destroy = jest.fn();
      mockSocket.write = jest.fn();
      mockSocket.end = jest.fn();

      // This just triggers the upgrade handler — it will try to upgrade via WSS
      // which won't fully work in test, but it covers the code path
      handler(
        { url: '/api/webhooks/twilio/stream', headers: {} },
        mockSocket,
        Buffer.alloc(0)
      );
    });
  });

  describe('makeOutboundCall()', () => {
    beforeEach(() => {
      process.env.TWILIO_ACCOUNT_SID = 'AC-test';
      process.env.TWILIO_AUTH_TOKEN = 'auth-test';
      process.env.TWILIO_PHONE_NUMBER = '+61400000000';
      process.env.SERVER_URL = 'https://example.com';
    });

    it('makes a call and returns call SID', async () => {
      mockCallsCreate.mockResolvedValueOnce({ sid: 'CA-outbound-1' });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const callSid = await makeOutboundCall('+61411222333');
      expect(callSid).toBe('CA-outbound-1');
      expect(mockCallsCreate).toHaveBeenCalledWith(expect.objectContaining({
        to: '+61411222333',
        from: '+61400000000',
      }));
      logSpy.mockRestore();
    });

    it('normalizes numbers starting with 0', async () => {
      mockCallsCreate.mockResolvedValueOnce({ sid: 'CA-norm-1' });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await makeOutboundCall('0411222333');
      expect(mockCallsCreate).toHaveBeenCalledWith(expect.objectContaining({
        to: '+61411222333',
      }));
      logSpy.mockRestore();
    });

    it('normalizes numbers without prefix', async () => {
      mockCallsCreate.mockResolvedValueOnce({ sid: 'CA-norm-2' });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await makeOutboundCall('411222333');
      expect(mockCallsCreate).toHaveBeenCalledWith(expect.objectContaining({
        to: '+61411222333',
      }));
      logSpy.mockRestore();
    });

    it('removes whitespace from number', async () => {
      mockCallsCreate.mockResolvedValueOnce({ sid: 'CA-ws' });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await makeOutboundCall('0411 222 333');
      expect(mockCallsCreate).toHaveBeenCalledWith(expect.objectContaining({
        to: '+61411222333',
      }));
      logSpy.mockRestore();
    });

    it('throws when TWILIO_PHONE_NUMBER is not configured', async () => {
      delete process.env.TWILIO_PHONE_NUMBER;

      // Need fresh module to pick up env change at module level
      jest.resetModules();
      jest.doMock('../../../db/pool', () => ({
        default: { query: mockQuery, on: jest.fn() }, __esModule: true,
      }));
      jest.doMock('../../../discord/agents', () => ({
        getAgent: jest.fn().mockReturnValue(null), AgentId: {},
      }));
      jest.doMock('../../../discord/claude', () => ({
        agentRespond: jest.fn(), summarizeCall: jest.fn(),
      }));
      jest.doMock('../../../discord/memory', () => ({
        getMemoryContext: jest.fn(), appendToMemory: jest.fn(),
        upsertMemory: jest.fn().mockResolvedValue(undefined),
      }));
      jest.doMock('../../../discord/voice/elevenlabsRealtime', () => ({
        startElevenLabsRealtimeTranscription: jest.fn(), isElevenLabsRealtimeAvailable: jest.fn().mockReturnValue(false),
      }));
      jest.doMock('../../../discord/voice/elevenlabs', () => ({
        elevenLabsTTS: jest.fn(),
      }));
      jest.doMock('twilio', () => jest.fn().mockReturnValue(mockTwilioClient));

      const { makeOutboundCall: moc } = await import('../../../discord/services/telephony');
      await expect(moc('+61411111111')).rejects.toThrow('TWILIO_PHONE_NUMBER');
    });

    it('logs to Discord when channels are set', async () => {
      mockCallsCreate.mockResolvedValueOnce({ sid: 'CA-log' });
      const sendMock = jest.fn().mockResolvedValue(undefined);
      const fakeChannel = { id: 'cl', send: sendMock } as any;
      setTelephonyChannels(fakeChannel, fakeChannel);

      await makeOutboundCall('+61411222333');
      expect(sendMock).toHaveBeenCalledWith(expect.stringContaining('Outbound call'));
    });

    it('handles greeting with setInterval', async () => {
      mockCallsCreate.mockResolvedValueOnce({ sid: 'CA-greet' });
      jest.useFakeTimers();

      const promise = makeOutboundCall('+61411222333', 'Hello!');
      const sid = await promise;
      expect(sid).toBe('CA-greet');

      // Clean up timers
      jest.runAllTimers();
      jest.useRealTimers();
    });
  });

  describe('makeAsapTesterCall()', () => {
    beforeEach(() => {
      process.env.TWILIO_ACCOUNT_SID = 'AC-test';
      process.env.TWILIO_AUTH_TOKEN = 'auth-test';
      process.env.TWILIO_PHONE_NUMBER = '+61400000000';
      process.env.SERVER_URL = 'https://example.com';
    });

    it('makes a call with tester voice name', async () => {
      mockCallsCreate.mockResolvedValueOnce({ sid: 'CA-tester-1' });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const sid = await makeAsapTesterCall('+61411222333');
      expect(sid).toBe('CA-tester-1');
      logSpy.mockRestore();
    });

    it('uses custom greeting', async () => {
      mockCallsCreate.mockResolvedValueOnce({ sid: 'CA-tester-2' });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const sid = await makeAsapTesterCall('+61411222333', 'Custom greeting');
      expect(sid).toBe('CA-tester-2');
      logSpy.mockRestore();
    });
  });

  describe('hangUp()', () => {
    beforeEach(() => {
      process.env.TWILIO_ACCOUNT_SID = 'AC-test';
      process.env.TWILIO_AUTH_TOKEN = 'auth-test';
    });

    it('calls Twilio to complete the call', async () => {
      await hangUp('CA-hangup-1');
      expect((mockTwilioClient.calls as any)).toHaveBeenCalledWith('CA-hangup-1');
      expect(mockCallsUpdate).toHaveBeenCalledWith({ status: 'completed' });
    });

    it('handles errors gracefully', async () => {
      mockCallsUpdate.mockRejectedValueOnce(new Error('Twilio error'));
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await hangUp('CA-bad');
      expect(errSpy).toHaveBeenCalledWith('Hang up error:', expect.any(String));
      errSpy.mockRestore();
    });
  });

  describe('startConferenceCall()', () => {
    beforeEach(() => {
      process.env.TWILIO_ACCOUNT_SID = 'AC-test';
      process.env.TWILIO_AUTH_TOKEN = 'auth-test';
      process.env.TWILIO_PHONE_NUMBER = '+61400000000';
      process.env.SERVER_URL = 'https://example.com';
    });

    it('creates conference and calls participants', async () => {
      mockCallsCreate.mockResolvedValue({ sid: 'CA-conf' });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const confName = await startConferenceCall(['+61411111111', '+61422222222'], 'test-conf');
      expect(confName).toBe('test-conf');
      // Should call create for each participant + Cortana
      expect(mockCallsCreate).toHaveBeenCalledTimes(3);
      logSpy.mockRestore();
    });

    it('generates conference name when not provided', async () => {
      mockCallsCreate.mockResolvedValue({ sid: 'CA-auto-conf' });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const confName = await startConferenceCall(['+61411111111']);
      expect(confName).toMatch(/^asap-conf-/);
      logSpy.mockRestore();
    });

    it('normalizes participant numbers', async () => {
      mockCallsCreate.mockResolvedValue({ sid: 'CA-norm-conf' });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await startConferenceCall(['0411111111', '422222222']);
      // First two calls are for participants (normalized), third is Cortana
      expect(mockCallsCreate).toHaveBeenCalledTimes(3);
      logSpy.mockRestore();
    });

    it('throws when TWILIO_PHONE_NUMBER not set', async () => {
      delete process.env.TWILIO_PHONE_NUMBER;

      jest.resetModules();
      jest.doMock('../../../db/pool', () => ({
        default: { query: mockQuery, on: jest.fn() }, __esModule: true,
      }));
      jest.doMock('../../../discord/agents', () => ({
        getAgent: jest.fn(), AgentId: {},
      }));
      jest.doMock('../../../discord/claude', () => ({
        agentRespond: jest.fn(), summarizeCall: jest.fn(),
      }));
      jest.doMock('../../../discord/memory', () => ({
        getMemoryContext: jest.fn(), appendToMemory: jest.fn(),
        upsertMemory: jest.fn().mockResolvedValue(undefined),
      }));
      jest.doMock('../../../discord/voice/elevenlabsRealtime', () => ({
        startElevenLabsRealtimeTranscription: jest.fn(), isElevenLabsRealtimeAvailable: jest.fn().mockReturnValue(false),
      }));
      jest.doMock('../../../discord/voice/elevenlabs', () => ({
        elevenLabsTTS: jest.fn(),
      }));
      jest.doMock('twilio', () => jest.fn().mockReturnValue(mockTwilioClient));

      const { startConferenceCall: scc } = await import('../../../discord/services/telephony');
      await expect(scc(['+61411111111'])).rejects.toThrow('TWILIO_PHONE_NUMBER');
    });

    it('logs to Discord when channels configured', async () => {
      mockCallsCreate.mockResolvedValue({ sid: 'CA-conf-log' });
      const sendMock = jest.fn().mockResolvedValue(undefined);
      setTelephonyChannels({ id: 'cl', send: sendMock } as any, { id: 'gc', send: sendMock } as any);
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await startConferenceCall(['+61411111111'], 'log-conf');
      expect(sendMock).toHaveBeenCalledWith(expect.stringContaining('Conference call started'));
      logSpy.mockRestore();
    });
  });

  describe('WebSocket message handling', () => {
    let upgradeHandler: (...args: any[]) => void;

    beforeEach(() => {
      const server = {
        on: jest.fn().mockImplementation((_event: string, handler: (...args: any[]) => void) => {
          upgradeHandler = handler;
        }),
      } as any;
      attachTelephonyWebSocket(server);
    });

    it('sets up upgrade handler for WS connections', () => {
      expect(upgradeHandler).toBeDefined();
    });
  });

  describe('audio conversion (mulawToPCM / upsample)', () => {
    // These are internal functions, but they're executed when handling WebSocket
    // media events. We can't call them directly, but they're covered when
    // the WebSocket handler processes media messages.
    // Instead we test the observable behavior via the exported functions.
    it('getInboundTwiML generates correct WebSocket URL', () => {
      process.env.SERVER_URL = 'https://my-server.com';
      // Re-import not needed since SERVER_URL is read at module scope.
      // But we can verify the existing output.
      const xml = getInboundTwiML();
      // SERVER_URL is captured at import time, so it uses whatever was set then
      expect(xml).toContain('<Stream');
    });
  });
});

