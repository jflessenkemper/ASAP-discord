/**
 * Tests for src/discord/voice/elevenlabsConvai.ts
 * ElevenLabs Conversational AI via signed WebSocket.
 */

import { EventEmitter } from 'events';

// --- Mocks ---
const mockGetSignedUrl = jest.fn();
jest.mock('elevenlabs', () => ({
  ElevenLabsClient: jest.fn().mockImplementation(() => ({
    conversationalAi: { getSignedUrl: mockGetSignedUrl },
  })),
}));

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = MockWebSocket.OPEN;
  send = jest.fn();
  close = jest.fn();
  constructor(_url: string) {
    super();
    // Simulate async open
    setTimeout(() => this.emit('open'), 0);
  }
}
let mockWsInstance: MockWebSocket | null = null;
const MockWsConstructor = Object.assign(
  jest.fn().mockImplementation((url: string) => {
    mockWsInstance = new MockWebSocket(url);
    return mockWsInstance;
  }),
  { OPEN: 1, CONNECTING: 0 },
);
jest.mock('ws', () => ({
  __esModule: true,
  default: MockWsConstructor,
}));

describe('elevenlabsConvai', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...OLD_ENV };
    process.env.ELEVENLABS_API_KEY = 'test-el-key';
    process.env.ELEVENLABS_CONVAI_ENABLED = 'true';
    process.env.ELEVENLABS_CONVAI_AGENT_ID = 'test-agent-id';
    process.env.ELEVENLABS_CONVAI_TIMEOUT_MS = '5000';
    process.env.ELEVENLABS_CONVAI_WS_TIMEOUT_MS = '5000';
    process.env.ELEVENLABS_CONVAI_MAX_REPLY_CHARS = '500';
    mockWsInstance = null;
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  describe('isElevenLabsConvaiEnabled()', () => {
    it('returns true when all config present', async () => {
      const { isElevenLabsConvaiEnabled } = await import('../../../discord/voice/elevenlabsConvai');
      expect(isElevenLabsConvaiEnabled()).toBe(true);
    });

    it('returns false when disabled via env', async () => {
      process.env.ELEVENLABS_CONVAI_ENABLED = 'false';
      const { isElevenLabsConvaiEnabled } = await import('../../../discord/voice/elevenlabsConvai');
      expect(isElevenLabsConvaiEnabled()).toBe(false);
    });

    it('returns false when agent ID missing', async () => {
      process.env.ELEVENLABS_CONVAI_AGENT_ID = '';
      const { isElevenLabsConvaiEnabled } = await import('../../../discord/voice/elevenlabsConvai');
      expect(isElevenLabsConvaiEnabled()).toBe(false);
    });

    it('returns false when API key missing', async () => {
      delete process.env.ELEVENLABS_API_KEY;
      const { isElevenLabsConvaiEnabled } = await import('../../../discord/voice/elevenlabsConvai');
      expect(isElevenLabsConvaiEnabled()).toBe(false);
    });
  });

  describe('getElevenLabsConvaiReply()', () => {
    it('throws when ConvAI is not enabled', async () => {
      process.env.ELEVENLABS_CONVAI_ENABLED = 'false';
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');
      await expect(getElevenLabsConvaiReply('hello', 'en')).rejects.toThrow('not enabled');
    });

    it('throws when no API key', async () => {
      delete process.env.ELEVENLABS_API_KEY;
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');
      await expect(getElevenLabsConvaiReply('hello', 'en')).rejects.toThrow();
    });

    it('throws when signed URL is empty', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: '' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');
      await expect(getElevenLabsConvaiReply('hello', 'en')).rejects.toThrow('signed_url');
    });

    it('returns agent response from websocket', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello', 'en');

      // Wait for the WebSocket to be created and 'open' emitted
      await new Promise((r) => setTimeout(r, 10));

      // Simulate agent response
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Hello from the agent!',
      }));

      const reply = await promise;
      expect(reply).toBe('Hello from the agent!');
    });

    it('handles agent_response_event format', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');

      await new Promise((r) => setTimeout(r, 10));

      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response_event',
        agent_response_event: { agent_response: 'Response from event' },
      }));

      const reply = await promise;
      expect(reply).toBe('Response from event');
    });

    it('handles tentative_agent_response type', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');

      await new Promise((r) => setTimeout(r, 10));

      mockWsInstance!.emit('message', JSON.stringify({
        type: 'tentative_agent_response',
        text: 'Tentative response',
      }));

      const reply = await promise;
      expect(reply).toBe('Tentative response');
    });

    it('responds to ping with pong', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');

      await new Promise((r) => setTimeout(r, 10));

      // Send ping, then agent response
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'ping',
        event_id: 'ping-1',
      }));

      expect(mockWsInstance!.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"pong"'),
      );

      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'After ping',
      }));

      await promise;
    });

    it('handles ping with ping_event.event_id', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      mockWsInstance!.emit('message', JSON.stringify({
        type: 'ping',
        ping_event: { event_id: 'ping-evt-1' },
      }));

      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Done',
      }));

      await promise;
    });

    it('ignores non-parseable messages', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      // Non-JSON message
      mockWsInstance!.emit('message', 'not json');

      // Then real response
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Real response',
      }));

      const reply = await promise;
      expect(reply).toBe('Real response');
    });

    it('ignores user_transcript events', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      // User transcript should be ignored
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'user_transcript',
        user_transcript: 'user said something',
      }));

      // Agent response finalizes
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Agent reply',
      }));

      const reply = await promise;
      expect(reply).toBe('Agent reply');
    });

    it('rejects on websocket error', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      mockWsInstance!.emit('error', new Error('connection failed'));

      await expect(promise).rejects.toThrow('connection failed');
    });

    it('rejects on websocket error with non-Error', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      mockWsInstance!.emit('error', 'string error');

      await expect(promise).rejects.toThrow('string error');
    });

    it('rejects on websocket close before response', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      mockWsInstance!.emit('close');

      await expect(promise).rejects.toThrow('closed before response');
    });

    it('sends init, user_message, and fallback frames on open', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello world', 'de');
      await new Promise((r) => setTimeout(r, 10));

      // Should have sent 3 frames: init, user_message, fallback_user_transcript
      expect(mockWsInstance!.send).toHaveBeenCalledTimes(3);
      const calls = mockWsInstance!.send.mock.calls.map((c: any) => JSON.parse(c[0]));
      expect(calls[0].type).toBe('conversation_initiation_client_data');
      expect(calls[0].conversation_initiation_client_data.dynamic_variables.caller_language).toBe('de');
      expect(calls[1].type).toBe('user_message');
      expect(calls[1].text).toBe('hello world');
      expect(calls[2].type).toBe('user_transcript');

      // Finish the promise
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Done',
      }));
      await promise;
    });

    it('normalizes language code with hyphen', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello', 'en-US');
      await new Promise((r) => setTimeout(r, 10));

      const initFrame = JSON.parse(mockWsInstance!.send.mock.calls[0][0]);
      expect(initFrame.conversation_initiation_client_data.dynamic_variables.caller_language).toBe('en');

      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Done',
      }));
      await promise;
    });

    it('defaults language to en when empty', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello', '');
      await new Promise((r) => setTimeout(r, 10));

      const initFrame = JSON.parse(mockWsInstance!.send.mock.calls[0][0]);
      expect(initFrame.conversation_initiation_client_data.dynamic_variables.caller_language).toBe('en');

      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Done',
      }));
      await promise;
    });

    it('truncates reply to max chars', async () => {
      process.env.ELEVENLABS_CONVAI_MAX_REPLY_CHARS = '10';
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      const longResponse = 'A'.repeat(200);
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: longResponse,
      }));

      const reply = await promise;
      // min is max(80, 10) = 80
      expect(reply.length).toBeLessThanOrEqual(80);
    });

    it('throws for empty prompt', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');
      await expect(getElevenLabsConvaiReply('  ', 'en')).rejects.toThrow('Empty ConvAI prompt');
    });

    it('handles agent_response_correction_event', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response_correction',
        agent_response_correction_event: { agent_response: 'Corrected response' },
      }));

      const reply = await promise;
      expect(reply).toBe('Corrected response');
    });

    it('ignores messages with empty text', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      // Event with type but no text
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
      }));

      // Real response
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Real text',
      }));

      const reply = await promise;
      expect(reply).toBe('Real text');
    });

    it('handles ws.close throwing', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      // Make close throw
      mockWsInstance!.close = jest.fn().mockImplementation(() => { throw new Error('close failed'); });

      // Resolve normally
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Response',
      }));

      const reply = await promise;
      expect(reply).toBe('Response');
    });

    it('handles pong send throwing', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      // Make send throw on pong
      mockWsInstance!.send = jest.fn().mockImplementation(() => { throw new Error('send failed'); });

      mockWsInstance!.emit('message', JSON.stringify({ type: 'ping', event_id: 'p1' }));

      mockWsInstance!.send = jest.fn(); // Restore for subsequent
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Still works',
      }));

      const reply = await promise;
      expect(reply).toBe('Still works');
    });

    it('ignores duplicate finish calls', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      // Send two agent responses quickly - second should be ignored
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'First',
      }));
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Second',
      }));

      const reply = await promise;
      expect(reply).toBe('First');
    });

    it('does not call close when ws already closed', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      // Set readyState to CLOSED
      mockWsInstance!.readyState = 3; // CLOSED
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Response',
      }));

      const reply = await promise;
      expect(reply).toBe('Response');
      // close should NOT have been called since readyState is CLOSED
      expect(mockWsInstance!.close).not.toHaveBeenCalled();
    });

    it('handles close event after already settled', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        agent_response: 'Done',
      }));

      const reply = await promise;
      // Close after already settled should be a no-op
      mockWsInstance!.emit('close');
      expect(reply).toBe('Done');
    });

    it('rejects on close after timeout', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      process.env.ELEVENLABS_CONVAI_WS_TIMEOUT_MS = '50';
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      // Wait for timeout
      await new Promise((r) => setTimeout(r, 100));

      await expect(promise).rejects.toThrow('timed out');
    });

    it('extracts text from transcript field', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        transcript: 'Transcript text',
      }));

      const reply = await promise;
      expect(reply).toBe('Transcript text');
    });

    it('extracts text from message field', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      mockWsInstance!.emit('message', JSON.stringify({
        type: 'agent_response',
        message: 'Message text',
      }));

      const reply = await promise;
      expect(reply).toBe('Message text');
    });

    it('treats non-user_transcript event with text as agent event', async () => {
      mockGetSignedUrl.mockResolvedValue({ signed_url: 'wss://test.example.com/signed' });
      const { getElevenLabsConvaiReply } = await import('../../../discord/voice/elevenlabsConvai');

      const promise = getElevenLabsConvaiReply('hello');
      await new Promise((r) => setTimeout(r, 10));

      // Event type that doesn't contain 'agent_response' or 'tentative_agent_response'
      // but has text and is not user_transcript → covered by third branch
      mockWsInstance!.emit('message', JSON.stringify({
        type: 'custom_event',
        text: 'Custom event text',
      }));

      const reply = await promise;
      expect(reply).toBe('Custom event text');
    });
  });
});
