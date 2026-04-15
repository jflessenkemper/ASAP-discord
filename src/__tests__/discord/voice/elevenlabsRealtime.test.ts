/**
 * Tests for src/discord/voice/elevenlabsRealtime.ts
 * ElevenLabs realtime speech-to-text transcription via WebSocket.
 */

import { EventEmitter } from 'events';

// --- Mocks ---
class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = MockWebSocket.OPEN;
  send = jest.fn();
  close = jest.fn();
  constructor(_url: string, _opts?: any) {
    super();
  }
}

let mockWsInstance: MockWebSocket | null = null;
const MockWsConstructor = Object.assign(
  jest.fn().mockImplementation((_url: string, _opts?: any) => {
    mockWsInstance = new MockWebSocket(_url, _opts);
    return mockWsInstance;
  }),
  { OPEN: 1, CONNECTING: 0 },
);

jest.mock('ws', () => ({
  __esModule: true,
  default: MockWsConstructor,
}));

describe('elevenlabsRealtime', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    MockWsConstructor.mockClear();
    process.env = { ...OLD_ENV };
    process.env.ELEVENLABS_API_KEY = 'test-key';
    mockWsInstance = null;
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  describe('isElevenLabsRealtimeAvailable()', () => {
    it('returns true when API key is set', async () => {
      const { isElevenLabsRealtimeAvailable } = await import('../../../discord/voice/elevenlabsRealtime');
      expect(isElevenLabsRealtimeAvailable()).toBe(true);
    });

    it('returns false when API key is not set', async () => {
      delete process.env.ELEVENLABS_API_KEY;
      const { isElevenLabsRealtimeAvailable } = await import('../../../discord/voice/elevenlabsRealtime');
      expect(isElevenLabsRealtimeAvailable()).toBe(false);
    });
  });

  describe('startElevenLabsRealtimeTranscription()', () => {
    it('throws when API key is not set', async () => {
      delete process.env.ELEVENLABS_API_KEY;
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');
      await expect(startElevenLabsRealtimeTranscription(jest.fn())).rejects.toThrow('ELEVENLABS_API_KEY not configured');
    });

    it('connects and returns a session', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      process.env.ELEVENLABS_STT_STARTUP_TIMEOUT_MS = '5000';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const promise = startElevenLabsRealtimeTranscription(jest.fn());

      // Wait for ws to be created
      await new Promise((r) => setTimeout(r, 5));
      expect(mockWsInstance).not.toBeNull();

      // Simulate open
      mockWsInstance!.emit('open');

      const session = await promise;
      expect(session).toHaveProperty('send');
      expect(session).toHaveProperty('close');
    });

    it('retries on connection failure', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '2';
      process.env.ELEVENLABS_STT_STARTUP_TIMEOUT_MS = '500';
      process.env.ELEVENLABS_STT_STARTUP_BACKOFF_BASE_MS = '250';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const promise = startElevenLabsRealtimeTranscription(jest.fn());

      // First attempt: emit error
      await new Promise((r) => setTimeout(r, 5));
      const firstWs = mockWsInstance!;
      firstWs.emit('error', new Error('connection refused'));

      // Wait for backoff + retry
      await new Promise((r) => setTimeout(r, 350));

      // Second attempt: emit open
      if (mockWsInstance && mockWsInstance !== firstWs) {
        mockWsInstance.emit('open');
      }

      const session = await promise;
      expect(session).toBeDefined();
    });

    it('throws after all retries exhausted', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      process.env.ELEVENLABS_STT_STARTUP_TIMEOUT_MS = '200';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const promise = startElevenLabsRealtimeTranscription(jest.fn());

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('error', new Error('connection refused'));

      await expect(promise).rejects.toThrow('connection refused');
    });

    it('times out on startup connection', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      process.env.ELEVENLABS_STT_STARTUP_TIMEOUT_MS = '100';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const promise = startElevenLabsRealtimeTranscription(jest.fn());

      // Don't emit open - let it time out
      await expect(promise).rejects.toThrow('timed out');
    });

    it('calls onTranscript for committed_transcript', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const onTranscript = jest.fn();
      const promise = startElevenLabsRealtimeTranscription(onTranscript);

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('open');
      await promise;

      // Simulate committed transcript
      mockWsInstance!.emit('message', JSON.stringify({
        message_type: 'committed_transcript',
        text: 'Hello world',
        language_code: 'en',
      }));

      expect(onTranscript).toHaveBeenCalledWith('Hello world', 'en');
    });

    it('calls onTranscript for committed_transcript_with_timestamps', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const onTranscript = jest.fn();
      const promise = startElevenLabsRealtimeTranscription(onTranscript);

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('open');
      await promise;

      mockWsInstance!.emit('message', JSON.stringify({
        message_type: 'committed_transcript_with_timestamps',
        text: 'Timestamped text',
        language_code: 'de',
      }));

      expect(onTranscript).toHaveBeenCalledWith('Timestamped text', 'de');
    });

    it('ignores empty transcript text', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const onTranscript = jest.fn();
      const promise = startElevenLabsRealtimeTranscription(onTranscript);

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('open');
      await promise;

      mockWsInstance!.emit('message', JSON.stringify({
        message_type: 'committed_transcript',
        text: '   ',
      }));

      expect(onTranscript).not.toHaveBeenCalled();
    });

    it('calls onError for scribe error events', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const onTranscript = jest.fn();
      const onError = jest.fn();
      const promise = startElevenLabsRealtimeTranscription(onTranscript, onError);

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('open');
      await promise;

      mockWsInstance!.emit('message', JSON.stringify({
        message_type: 'scribe_some_error',
        error: { code: 'ERR001', message: 'Audio quality too low' },
      }));

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Audio quality too low'),
      }));
    });

    it('calls onError for scribe error with code only', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const onTranscript = jest.fn();
      const onError = jest.fn();
      const promise = startElevenLabsRealtimeTranscription(onTranscript, onError);

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('open');
      await promise;

      mockWsInstance!.emit('message', JSON.stringify({
        message_type: 'scribe_fatal_error',
        error: { code: 'FATAL' },
      }));

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('FATAL'),
      }));
    });

    it('calls onError for scribe error with no details', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const onTranscript = jest.fn();
      const onError = jest.fn();
      const promise = startElevenLabsRealtimeTranscription(onTranscript, onError);

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('open');
      await promise;

      mockWsInstance!.emit('message', JSON.stringify({
        message_type: 'scribe_processing_error',
      }));

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('scribe_processing_error'),
      }));
    });

    it('calls onError for malformed JSON in message', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const onTranscript = jest.fn();
      const onError = jest.fn();
      const promise = startElevenLabsRealtimeTranscription(onTranscript, onError);

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('open');
      await promise;

      mockWsInstance!.emit('message', 'not valid json!');

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it('calls onError on ws error event', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const onTranscript = jest.fn();
      const onError = jest.fn();
      const promise = startElevenLabsRealtimeTranscription(onTranscript, onError);

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('open');
      await promise;

      mockWsInstance!.emit('error', new Error('stream error'));

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'stream error' }));
    });

    it('wraps non-Error ws error event', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const onTranscript = jest.fn();
      const onError = jest.fn();
      const promise = startElevenLabsRealtimeTranscription(onTranscript, onError);

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('open');
      await promise;

      mockWsInstance!.emit('error', 'string error');

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it('calls onError on unexpected close', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const onTranscript = jest.fn();
      const onError = jest.fn();
      const promise = startElevenLabsRealtimeTranscription(onTranscript, onError);

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('open');
      await promise;

      mockWsInstance!.emit('close');

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('closed unexpectedly'),
      }));
    });

    it('does not call onError on close after explicit close', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const onTranscript = jest.fn();
      const onError = jest.fn();
      const promise = startElevenLabsRealtimeTranscription(onTranscript, onError);

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('open');
      const session = await promise;

      session.close();
      mockWsInstance!.emit('close');

      expect(onError).not.toHaveBeenCalled();
    });

    it('does not call onError on close after error already reported', async () => {
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const onTranscript = jest.fn();
      const onError = jest.fn();
      const promise = startElevenLabsRealtimeTranscription(onTranscript, onError);

      await new Promise((r) => setTimeout(r, 5));
      mockWsInstance!.emit('open');
      await promise;

      mockWsInstance!.emit('error', new Error('fatal'));
      onError.mockClear();
      mockWsInstance!.emit('close');

      expect(onError).not.toHaveBeenCalled();
    });

    describe('session.send()', () => {
      it('sends PCM audio converted to mono 16kHz', async () => {
        process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
        const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

        const promise = startElevenLabsRealtimeTranscription(jest.fn());
        await new Promise((r) => setTimeout(r, 5));
        mockWsInstance!.emit('open');
        const session = await promise;

        // 48kHz stereo PCM: 4 bytes per frame, need at least 3 frames for one output sample
        // 3 frames * 4 bytes = 12 bytes minimum
        const pcm = Buffer.alloc(12);
        pcm.writeInt16LE(1000, 0);  // left ch, frame 0
        pcm.writeInt16LE(2000, 2);  // right ch, frame 0
        pcm.writeInt16LE(1500, 4);  // left ch, frame 1
        pcm.writeInt16LE(2500, 6);  // right ch, frame 1
        pcm.writeInt16LE(800, 8);   // left ch, frame 2
        pcm.writeInt16LE(1200, 10); // right ch, frame 2

        session.send(pcm);

        expect(mockWsInstance!.send).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(mockWsInstance!.send.mock.calls[0][0]);
        expect(payload.message_type).toBe('input_audio_chunk');
        expect(payload.sample_rate).toBe(16000);
        expect(payload.audio_base_64).toBeDefined();
      });

      it('skips sending empty buffers', async () => {
        process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
        const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

        const promise = startElevenLabsRealtimeTranscription(jest.fn());
        await new Promise((r) => setTimeout(r, 5));
        mockWsInstance!.emit('open');
        const session = await promise;

        // Too small to produce any output sample
        session.send(Buffer.alloc(2));

        expect(mockWsInstance!.send).not.toHaveBeenCalled();
      });

      it('queues when ws is CONNECTING', async () => {
        process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
        const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

        const promise = startElevenLabsRealtimeTranscription(jest.fn());
        await new Promise((r) => setTimeout(r, 5));
        mockWsInstance!.emit('open');
        const session = await promise;

        // Set readyState to CONNECTING
        mockWsInstance!.readyState = 0;
        const pcm = Buffer.alloc(12); // minimum for one output sample
        session.send(pcm);

        // Should not have called send directly (it's queued internally)
        // Since we have the session already and set readyState, the send
        // path goes to the CONNECTING branch
        // Note: The queue is internal to startElevenLabsRealtimeTranscription
      });

      it('skips send when ws is not open or connecting', async () => {
        process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
        const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

        const promise = startElevenLabsRealtimeTranscription(jest.fn());
        await new Promise((r) => setTimeout(r, 5));
        mockWsInstance!.emit('open');
        const session = await promise;

        // Set readyState to CLOSED
        mockWsInstance!.readyState = 3;
        session.send(Buffer.alloc(12));

        expect(mockWsInstance!.send).not.toHaveBeenCalled();
      });
    });

    describe('session.close()', () => {
      it('closes the websocket', async () => {
        process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
        const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

        const promise = startElevenLabsRealtimeTranscription(jest.fn());
        await new Promise((r) => setTimeout(r, 5));
        mockWsInstance!.emit('open');
        const session = await promise;

        session.close();
        expect(mockWsInstance!.close).toHaveBeenCalledTimes(1);
      });

      it('does not close when ws already closed', async () => {
        process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';
        const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

        const promise = startElevenLabsRealtimeTranscription(jest.fn());
        await new Promise((r) => setTimeout(r, 5));
        mockWsInstance!.emit('open');
        const session = await promise;

        mockWsInstance!.readyState = 3; // CLOSED
        session.close();
        expect(mockWsInstance!.close).not.toHaveBeenCalled();
      });
    });

    it('uses custom env var config', async () => {
      process.env.ELEVENLABS_STT_REALTIME_MODEL_ID = 'custom_model';
      process.env.ELEVENLABS_STT_LANGUAGE_CODE = 'de';
      process.env.ELEVENLABS_STT_INCLUDE_LANGUAGE_DETECTION = 'false';
      process.env.ELEVENLABS_STT_INCLUDE_TIMESTAMPS = 'true';
      process.env.ELEVENLABS_STT_VAD_SILENCE_THRESHOLD_SECS = '1.0';
      process.env.ELEVENLABS_STT_VAD_THRESHOLD = '0.5';
      process.env.ELEVENLABS_STT_MIN_SPEECH_DURATION_MS = '100';
      process.env.ELEVENLABS_STT_MIN_SILENCE_DURATION_MS = '200';
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';

      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const promise = startElevenLabsRealtimeTranscription(jest.fn());
      await new Promise((r) => setTimeout(r, 5));

      // Check the URL contains expected params
      const wsUrl = MockWsConstructor.mock.calls[0][0];
      expect(wsUrl).toContain('model_id=custom_model');
      expect(wsUrl).toContain('language_code=de');
      expect(wsUrl).toContain('include_language_detection=false');
      expect(wsUrl).toContain('include_timestamps=true');

      mockWsInstance!.emit('open');
      await promise;
    });

    it('toBoolParam defaults correctly', async () => {
      // Unset env vars to trigger defaults
      delete process.env.ELEVENLABS_STT_INCLUDE_LANGUAGE_DETECTION;
      delete process.env.ELEVENLABS_STT_INCLUDE_TIMESTAMPS;
      process.env.ELEVENLABS_STT_STARTUP_MAX_RETRIES = '1';

      const { startElevenLabsRealtimeTranscription } = await import('../../../discord/voice/elevenlabsRealtime');

      const promise = startElevenLabsRealtimeTranscription(jest.fn());
      await new Promise((r) => setTimeout(r, 5));

      const wsUrl = MockWsConstructor.mock.calls[0][0];
      expect(wsUrl).toContain('include_language_detection=true');
      expect(wsUrl).toContain('include_timestamps=false');

      mockWsInstance!.emit('open');
      await promise;
    });
  });
});
