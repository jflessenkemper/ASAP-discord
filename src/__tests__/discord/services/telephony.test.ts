/**
 * Tests for src/discord/services/telephony.ts
 * TwiML generation and telephony availability check.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../../db/pool', () => ({
  default: { query: mockQuery, on: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../discord/agents', () => ({
  getAgent: jest.fn(),
  AgentId: {},
}));
jest.mock('../../../discord/claude', () => ({
  agentRespond: jest.fn(),
  summarizeCall: jest.fn(),
}));
jest.mock('../../../discord/memory', () => ({
  getMemoryContext: jest.fn(),
  appendToMemory: jest.fn(),
  upsertMemory: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../discord/voice/deepgram', () => ({
  startLiveTranscription: jest.fn(),
  isDeepgramAvailable: jest.fn().mockReturnValue(false),
}));
jest.mock('../../../discord/voice/elevenlabs', () => ({
  elevenLabsTTS: jest.fn(),
}));
jest.mock('twilio', () => {
  const client = { calls: { create: jest.fn() } };
  const fn = jest.fn().mockReturnValue(client);
  return fn;
});

import {
  isTelephonyAvailable,
  getInboundTwiML,
  getConferenceTwiML,
  learnContact,
  setTelephonyChannels,
} from '../../../discord/services/telephony';

describe('telephony', () => {
  describe('isTelephonyAvailable()', () => {
    it('returns false when Twilio env vars are not set', () => {
      // In test env, TWILIO_* vars are not set
      expect(isTelephonyAvailable()).toBe(false);
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
  });

  describe('getConferenceTwiML()', () => {
    it('returns TwiML with conference room name', () => {
      const xml = getConferenceTwiML('riley-call-123');
      expect(xml).toContain('<?xml version="1.0"');
      expect(xml).toContain('<Conference');
      expect(xml).toContain('riley-call-123');
    });
  });

  describe('setTelephonyChannels()', () => {
    afterEach(() => {
      // Reset module-level channel refs so later tests don't hit stale mocks
      setTelephonyChannels(null as any, null as any);
    });

    it('does not throw', () => {
      const fakeChannel: any = { id: 'ch-1', send: jest.fn().mockResolvedValue(undefined) };
      expect(() => setTelephonyChannels(fakeChannel, fakeChannel)).not.toThrow();
    });
  });

  describe('learnContact()', () => {
    it('normalizes Australian phone numbers', () => {
      // learnContact stores the contact — verify no crash
      expect(() => learnContact('0436012231', 'Test User')).not.toThrow();
    });

    it('handles numbers with country code', () => {
      expect(() => learnContact('+61436012231', 'Test User')).not.toThrow();
    });
  });
});
