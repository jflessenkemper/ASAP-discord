/**
 * Unit tests for Discord voice pipeline modules:
 *   - deepgram.ts  — live transcription, no recordGeminiUsage side-effect
 *   - elevenlabs.ts — model selection based on detected language
 *   - tts.ts        — language param threaded to ElevenLabs; Gemini TTS fallback
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock ElevenLabs SDK
const mockConvert = jest.fn();
jest.mock('elevenlabs', () => ({
  ElevenLabsClient: jest.fn().mockImplementation(() => ({
    textToSpeech: { convert: mockConvert },
  })),
}));

// Mock Deepgram SDK
const mockLive = jest.fn();
const mockListen = { live: mockLive };
jest.mock('@deepgram/sdk', () => ({
  createClient: jest.fn(() => ({ listen: mockListen })),
  LiveTranscriptionEvents: {
    Transcript: 'transcript',
    Error: 'error',
    Close: 'close',
  },
}));

// Mock usage counters — we test that recordGeminiUsage is NOT called for Deepgram events
const mockRecordGeminiUsage = jest.fn();
const mockRecordElevenLabsUsage = jest.fn();
jest.mock('../../discord/usage', () => ({
  recordGeminiUsage: mockRecordGeminiUsage,
  recordElevenLabsUsage: mockRecordElevenLabsUsage,
  isElevenLabsOverLimit: jest.fn().mockReturnValue(false),
  isGeminiOverLimit: jest.fn().mockReturnValue(false),
}));

// Mock metrics
jest.mock('../../discord/metrics', () => ({
  recordTtsLatency: jest.fn(),
  recordTtsError: jest.fn(),
  recordTranscriptionLatency: jest.fn(),
}));

// Mock @google/generative-ai for tts.ts
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn().mockResolvedValue({
        response: { text: jest.fn().mockReturnValue('test transcription') },
      }),
    }),
  })),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('deepgram.ts — recordGeminiUsage must NOT be called for transcription events', () => {
  beforeEach(() => {
    jest.resetModules();
    mockRecordGeminiUsage.mockClear();
    process.env.DEEPGRAM_API_KEY = 'test-dg-key';
  });

  afterEach(() => {
    delete process.env.DEEPGRAM_API_KEY;
  });

  it('isDeepgramAvailable returns true when key is set', async () => {
    const { isDeepgramAvailable } = await import('../../discord/voice/deepgram');
    expect(isDeepgramAvailable()).toBe(true);
  });

  it('isDeepgramAvailable returns false when key is not set', async () => {
    delete process.env.DEEPGRAM_API_KEY;
    const { isDeepgramAvailable } = await import('../../discord/voice/deepgram');
    expect(isDeepgramAvailable()).toBe(false);
  });

  it('does NOT call recordGeminiUsage when a Deepgram transcript fires', async () => {
    // Capture the Transcript event listener registered on the mock live connection
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(1),
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const onTranscript = jest.fn();
    await startLiveTranscription(onTranscript);

    // Simulate a Deepgram final transcript event
    const fakeData = {
      is_final: true,
      channel: { alternatives: [{ transcript: '你好', languages: ['zh'] }] },
    };
    eventListeners['transcript']?.(fakeData);

    expect(onTranscript).toHaveBeenCalledWith('你好', 'zh');
    // The critical assertion: Gemini usage counter must NOT be bumped for Deepgram events
    expect(mockRecordGeminiUsage).not.toHaveBeenCalled();
  });

  it('ignores non-final transcripts', async () => {
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(1),
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const onTranscript = jest.fn();
    await startLiveTranscription(onTranscript);

    // Non-final transcript should be ignored
    eventListeners['transcript']?.({ is_final: false, channel: { alternatives: [{ transcript: 'partial' }] } });
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('ignores transcript with empty text', async () => {
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(1),
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const onTranscript = jest.fn();
    await startLiveTranscription(onTranscript);

    eventListeners['transcript']?.({ is_final: true, channel: { alternatives: [{ transcript: '' }] } });
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('falls back to metadata.language when alternatives.languages is missing', async () => {
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(1),
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const onTranscript = jest.fn();
    await startLiveTranscription(onTranscript);

    eventListeners['transcript']?.({
      is_final: true,
      channel: { alternatives: [{ transcript: 'hello' }] },
      metadata: { language: 'en' },
    });
    expect(onTranscript).toHaveBeenCalledWith('hello', 'en');
  });

  it('calls onError when error event fires', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(1),
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const onTranscript = jest.fn();
    const onError = jest.fn();
    await startLiveTranscription(onTranscript, onError);

    // Error with a string message
    eventListeners['error']?.('connection failed');
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError.mock.calls[0][0].message).toBe('connection failed');
    spy.mockRestore();
  });

  it('calls onError with Error object directly', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(1),
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const onTranscript = jest.fn();
    const onError = jest.fn();
    await startLiveTranscription(onTranscript, onError);

    const realError = new Error('real error');
    eventListeners['error']?.(realError);
    expect(onError).toHaveBeenCalledWith(realError);
    spy.mockRestore();
  });

  it('calls onError on unexpected close when no error reported', async () => {
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(1),
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const onTranscript = jest.fn();
    const onError = jest.fn();
    await startLiveTranscription(onTranscript, onError);

    eventListeners['close']?.();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Deepgram connection closed unexpectedly' }));
  });

  it('does not call onError on close after explicit close', async () => {
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(1),
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const onTranscript = jest.fn();
    const onError = jest.fn();
    const session = await startLiveTranscription(onTranscript, onError);

    session.close();
    eventListeners['close']?.();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not call onError on close after error already reported', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(1),
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const onTranscript = jest.fn();
    const onError = jest.fn();
    await startLiveTranscription(onTranscript, onError);

    eventListeners['error']?.(new Error('some error'));
    onError.mockClear();
    eventListeners['close']?.();
    expect(onError).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('send forwards audio when connection is open', async () => {
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(1),
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const session = await startLiveTranscription(jest.fn());

    const audio = Buffer.from('test-audio-data');
    session.send(audio);
    expect(mockConnection.send).toHaveBeenCalled();
  });

  it('send does nothing when connection is not open', async () => {
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(0), // CONNECTING, not OPEN
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const session = await startLiveTranscription(jest.fn());

    session.send(Buffer.from('data'));
    expect(mockConnection.send).not.toHaveBeenCalled();
  });

  it('send does nothing after close', async () => {
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(1),
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const session = await startLiveTranscription(jest.fn());

    session.close();
    session.send(Buffer.from('data'));
    expect(mockConnection.send).not.toHaveBeenCalled();
  });

  it('close is idempotent', async () => {
    const eventListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => { eventListeners[event] = cb; }),
      getReadyState: jest.fn().mockReturnValue(1),
      send: jest.fn(),
      requestClose: jest.fn(),
    };
    mockLive.mockReturnValue(mockConnection);

    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    const session = await startLiveTranscription(jest.fn());

    session.close();
    session.close();
    expect(mockConnection.requestClose).toHaveBeenCalledTimes(1);
  });

  it('throws when DEEPGRAM_API_KEY is not set and startLiveTranscription is called', async () => {
    delete process.env.DEEPGRAM_API_KEY;
    const { startLiveTranscription } = await import('../../discord/voice/deepgram');
    await expect(startLiveTranscription(jest.fn())).rejects.toThrow('DEEPGRAM_API_KEY not configured');
  });
});

describe('elevenlabs.ts — language-aware model selection', () => {
  beforeEach(() => {
    jest.resetModules();
    mockConvert.mockClear();
    mockRecordElevenLabsUsage.mockClear();
    process.env.ELEVENLABS_API_KEY = 'test-el-key';

    // Return a fake async iterable so the streaming collect loop works
    mockConvert.mockResolvedValue(
      (async function* () { yield Buffer.from('audio'); })()
    );
  });

  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
  });

  it('isElevenLabsAvailable returns true when key configured', async () => {
    const { isElevenLabsAvailable } = await import('../../discord/voice/elevenlabs');
    expect(isElevenLabsAvailable()).toBe(true);
  });

  it('uses eleven_turbo_v2_5 for English (no language param)', async () => {
    const { elevenLabsTTS } = await import('../../discord/voice/elevenlabs');
    await elevenLabsTTS('Hello there', 'Achernar');
    expect(mockConvert).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model_id: 'eleven_turbo_v2_5' })
    );
  });

  it('uses eleven_turbo_v2_5 when language is explicitly "en"', async () => {
    const { elevenLabsTTS } = await import('../../discord/voice/elevenlabs');
    await elevenLabsTTS('Hello there', 'Achernar', 'en');
    expect(mockConvert).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model_id: 'eleven_turbo_v2_5' })
    );
  });

  it('uses eleven_multilingual_v2 when language is "zh" (Mandarin)', async () => {
    const { elevenLabsTTS } = await import('../../discord/voice/elevenlabs');
    await elevenLabsTTS('你好世界', 'Achernar', 'zh');
    expect(mockConvert).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model_id: 'eleven_multilingual_v2' })
    );
  });

  it('uses eleven_multilingual_v2 for arbitrary non-English language code', async () => {
    const { elevenLabsTTS } = await import('../../discord/voice/elevenlabs');
    await elevenLabsTTS('Bonjour', 'Achernar', 'fr');
    expect(mockConvert).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model_id: 'eleven_multilingual_v2' })
    );
  });

  it('returns empty buffer for empty text without calling API', async () => {
    const { elevenLabsTTS } = await import('../../discord/voice/elevenlabs');
    const result = await elevenLabsTTS('', 'Achernar');
    expect(result.length).toBe(0);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('passes raw voice ID when input is 20+ alphanumeric chars', async () => {
    const { elevenLabsTTS } = await import('../../discord/voice/elevenlabs');
    const rawVoiceId = 'ABCDEFGHIJ1234567890';
    await elevenLabsTTS('Test text for raw ID', rawVoiceId);
    expect(mockConvert).toHaveBeenCalledWith(rawVoiceId, expect.any(Object));
  });

  it('returns cached buffer for short text on second call', async () => {
    mockConvert.mockImplementation(() =>
      (async function* () { yield Buffer.from('audio'); })()
    );
    const { elevenLabsTTS } = await import('../../discord/voice/elevenlabs');
    const shortText = 'Cache hit test txt';
    await elevenLabsTTS(shortText, 'Achernar');
    mockConvert.mockClear();
    const buf = await elevenLabsTTS(shortText, 'Achernar');
    expect(mockConvert).not.toHaveBeenCalled();
    expect(buf.length).toBeGreaterThan(0);
  });

  it('evicts expired cache entries', async () => {
    mockConvert.mockImplementation(() =>
      (async function* () { yield Buffer.from('audio'); })()
    );
    const { elevenLabsTTS } = await import('../../discord/voice/elevenlabs');
    await elevenLabsTTS('Expire test txt!!', 'Achernar');
    mockConvert.mockClear();

    const origNow = Date.now;
    Date.now = () => origNow() + 1_000_000;
    mockConvert.mockImplementation(() =>
      (async function* () { yield Buffer.from('fresh'); })()
    );
    const buf = await elevenLabsTTS('Expire test txt!!', 'Achernar');
    expect(mockConvert).toHaveBeenCalled();
    expect(buf.length).toBeGreaterThan(0);
    Date.now = origNow;
  });

  it('evicts oldest entries when cache exceeds max size', async () => {
    process.env.TTS_CACHE_MAX_ENTRIES = '2';
    jest.resetModules();
    mockConvert.mockImplementation(() =>
      (async function* () { yield Buffer.from('audio'); })()
    );
    const { elevenLabsTTS } = await import('../../discord/voice/elevenlabs');
    await elevenLabsTTS('Short txt one!!', 'Achernar');
    await elevenLabsTTS('Short txt two!!', 'Achernar');
    await elevenLabsTTS('Short txt tri!!', 'Achernar');

    mockConvert.mockClear();
    mockConvert.mockImplementation(() =>
      (async function* () { yield Buffer.from('audio'); })()
    );
    await elevenLabsTTS('Short txt one!!', 'Achernar');
    expect(mockConvert).toHaveBeenCalled();
    delete process.env.TTS_CACHE_MAX_ENTRIES;
  });

  it('throws when daily limit is reached', async () => {
    const { isElevenLabsOverLimit } = require('../../discord/usage');
    (isElevenLabsOverLimit as jest.Mock).mockReturnValueOnce(true);
    const { elevenLabsTTS } = await import('../../discord/voice/elevenlabs');
    await expect(elevenLabsTTS('Hello there!', 'Achernar')).rejects.toThrow('Daily ElevenLabs character limit reached');
  });

  it('throws when ELEVENLABS_API_KEY is not set', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const { elevenLabsTTS } = await import('../../discord/voice/elevenlabs');
    await expect(elevenLabsTTS('Hello there!', 'Achernar')).rejects.toThrow('ELEVENLABS_API_KEY not configured');
  });

  it('primeElevenLabsVoiceCache warms phrases into cache', async () => {
    mockConvert.mockImplementation(() =>
      (async function* () { yield Buffer.from('audio'); })()
    );
    const { primeElevenLabsVoiceCache } = await import('../../discord/voice/elevenlabs');
    await primeElevenLabsVoiceCache('Achernar', ['Hello there', 'How are you']);
    expect(mockConvert).toHaveBeenCalledTimes(2);
  });

  it('primeElevenLabsVoiceCache skips when not available', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const { primeElevenLabsVoiceCache } = await import('../../discord/voice/elevenlabs');
    await primeElevenLabsVoiceCache('Achernar', ['Hello there']);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('primeElevenLabsVoiceCache skips already-warmed phrase set', async () => {
    mockConvert.mockImplementation(() =>
      (async function* () { yield Buffer.from('audio'); })()
    );
    const { primeElevenLabsVoiceCache } = await import('../../discord/voice/elevenlabs');
    await primeElevenLabsVoiceCache('Achernar', ['Repeat test phrase']);
    mockConvert.mockClear();
    await primeElevenLabsVoiceCache('Achernar', ['Repeat test phrase']);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('primeElevenLabsVoiceCache filters out short phrases', async () => {
    mockConvert.mockImplementation(() =>
      (async function* () { yield Buffer.from('audio'); })()
    );
    const { primeElevenLabsVoiceCache } = await import('../../discord/voice/elevenlabs');
    await primeElevenLabsVoiceCache('Achernar', ['X', '']);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('primeElevenLabsVoiceCache skips phrases already in TTS cache', async () => {
    mockConvert.mockImplementation(() =>
      (async function* () { yield Buffer.from('audio'); })()
    );
    const { elevenLabsTTS, primeElevenLabsVoiceCache } = await import('../../discord/voice/elevenlabs');
    // Cache a phrase via direct TTS call
    await elevenLabsTTS('Already cached txt', 'Achernar');
    mockConvert.mockClear();
    // Prime with different language → new warm key, but phrase is already cached
    await primeElevenLabsVoiceCache('Achernar', ['Already cached txt'], 'fr');
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('isElevenLabsAvailable returns false when key not set', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const { isElevenLabsAvailable } = await import('../../discord/voice/elevenlabs');
    expect(isElevenLabsAvailable()).toBe(false);
  });
});

describe('tts.ts — textToSpeech threads language parameter', () => {
  beforeEach(() => {
    jest.resetModules();
    mockConvert.mockClear();
    process.env.ELEVENLABS_API_KEY = 'test-el-key';

    mockConvert.mockResolvedValue(
      (async function* () { yield Buffer.from('audio-data'); })()
    );
  });

  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
  });

  it('passes language to ElevenLabs when ElevenLabs is available', async () => {
    const { textToSpeech } = await import('../../discord/voice/tts');
    await textToSpeech('你好', 'Achernar', 'zh');
    expect(mockConvert).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model_id: 'eleven_multilingual_v2' })
    );
  });

  it('passes no language → uses turbo model for English', async () => {
    const { textToSpeech } = await import('../../discord/voice/tts');
    await textToSpeech('Hello', 'Achernar');
    expect(mockConvert).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model_id: 'eleven_turbo_v2_5' })
    );
  });

  it('falls back to Gemini TTS if ElevenLabs not configured', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    process.env.GEMINI_API_KEY = 'test-gemini-key';

    // Mock global fetch for Gemini TTS REST call
    const fakeAudioData = Buffer.from('gemini-audio').toString('base64');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: 'audio/L16', data: fakeAudioData } }],
          },
        }],
      }),
    }) as any;

    const { textToSpeech } = await import('../../discord/voice/tts');
    const result = await textToSpeech('Hello', 'Kore');
    expect(result.length).toBeGreaterThan(0);
    // Verify Gemini TTS request includes role:'user' in contents
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.contents[0].role).toBe('user');

    delete process.env.GEMINI_API_KEY;
  });
});

describe('tts.ts — Gemini TTS request hardening', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.ELEVENLABS_API_KEY;
    process.env.GEMINI_API_KEY = 'test-gemini-key';
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it('sends role:user in Gemini TTS request body', async () => {
    const fakeAudioData = Buffer.from('audio').toString('base64');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: 'audio/L16', data: fakeAudioData } }],
          },
        }],
      }),
    }) as any;

    const { textToSpeech } = await import('../../discord/voice/tts');
    await textToSpeech('Test phrase', 'Kore');

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[0].parts[0].text).toBe('Test phrase');
    expect(body.generationConfig.responseModalities).toContain('AUDIO');
  });
});

describe('tts.ts — transcribeVoiceDetailed', () => {
  beforeEach(() => {
    jest.resetModules();
    mockRecordGeminiUsage.mockClear();
  });

  afterEach(() => {
    delete process.env.VOICE_STT_PROVIDER;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_USE_VERTEX_AI;
    delete process.env.VERTEX_PROJECT_ID;
  });

  it('uses elevenlabs provider when configured', async () => {
    process.env.VOICE_STT_PROVIDER = 'elevenlabs';
    process.env.ELEVENLABS_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hello world' }),
    }) as any;

    const { transcribeVoiceDetailed } = await import('../../discord/voice/tts');
    const result = await transcribeVoiceDetailed(Buffer.alloc(100));
    expect(result.provider).toBe('elevenlabs');
    expect(result.text).toBe('hello world');
  });

  it('returns empty text for elevenlabs silence', async () => {
    process.env.VOICE_STT_PROVIDER = 'elevenlabs';
    process.env.ELEVENLABS_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: '[silence]' }),
    }) as any;

    const { transcribeVoiceDetailed } = await import('../../discord/voice/tts');
    const result = await transcribeVoiceDetailed(Buffer.alloc(100));
    expect(result.text).toBe('');
    expect(result.provider).toBe('elevenlabs');
  });

  it('returns empty text for elevenlabs empty response', async () => {
    process.env.VOICE_STT_PROVIDER = 'elevenlabs';
    process.env.ELEVENLABS_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: '' }),
    }) as any;

    const { transcribeVoiceDetailed } = await import('../../discord/voice/tts');
    const result = await transcribeVoiceDetailed(Buffer.alloc(100));
    expect(result.text).toBe('');
  });

  it('throws when elevenlabs STT returns error', async () => {
    process.env.VOICE_STT_PROVIDER = 'elevenlabs';
    process.env.ELEVENLABS_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Error',
    }) as any;

    const { transcribeVoiceDetailed } = await import('../../discord/voice/tts');
    await expect(transcribeVoiceDetailed(Buffer.alloc(100))).rejects.toThrow('ElevenLabs STT error');
  });

  it('throws when elevenlabs key not configured', async () => {
    process.env.VOICE_STT_PROVIDER = 'elevenlabs';
    delete process.env.ELEVENLABS_API_KEY;

    const { transcribeVoiceDetailed } = await import('../../discord/voice/tts');
    await expect(transcribeVoiceDetailed(Buffer.alloc(100))).rejects.toThrow('ELEVENLABS_API_KEY not configured');
  });

  it('falls back to gemini provider by default', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    const { transcribeVoiceDetailed } = await import('../../discord/voice/tts');
    // Audio is all zeros → silence → returns empty string
    const result = await transcribeVoiceDetailed(Buffer.alloc(100));
    expect(result.provider).toBe('gemini');
    expect(result.text).toBe('');
  });
});

describe('tts.ts — transcribeVoice', () => {
  beforeEach(() => {
    jest.resetModules();
    mockRecordGeminiUsage.mockClear();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_USE_VERTEX_AI;
    delete process.env.VERTEX_PROJECT_ID;
  });

  it('throws when no Gemini provider is configured', async () => {
    delete process.env.GEMINI_API_KEY;
    const { transcribeVoice } = await import('../../discord/voice/tts');
    await expect(transcribeVoice(Buffer.alloc(100))).rejects.toThrow('Gemini API key not configured');
  });

  it('throws when Vertex is enabled but not configured', async () => {
    process.env.GEMINI_USE_VERTEX_AI = 'true';
    delete process.env.VERTEX_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    const { transcribeVoice } = await import('../../discord/voice/tts');
    await expect(transcribeVoice(Buffer.alloc(100))).rejects.toThrow('Vertex Gemini is not configured');
  });

  it('returns empty string for silent audio (all zeros)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const { transcribeVoice } = await import('../../discord/voice/tts');
    const result = await transcribeVoice(Buffer.alloc(4000));
    expect(result).toBe('');
    expect(mockRecordGeminiUsage).not.toHaveBeenCalled();
  });

  it('transcribes using Gemini API key (non-Vertex)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    const { transcribeVoice } = await import('../../discord/voice/tts');

    // Create non-silent audio buffer
    const buf = Buffer.alloc(4000);
    for (let i = 0; i < buf.length - 1; i += 2) {
      buf.writeInt16LE(1000, i);
    }

    const result = await transcribeVoice(buf);
    expect(result).toBe('test transcription');
    expect(mockRecordGeminiUsage).toHaveBeenCalled();
  });

  it('returns empty for [silence] response', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    // Override the mock for this test
    jest.doMock('@google/generative-ai', () => ({
      GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
        getGenerativeModel: jest.fn().mockReturnValue({
          generateContent: jest.fn().mockResolvedValue({
            response: { text: jest.fn().mockReturnValue('[silence]') },
          }),
        }),
      })),
    }));

    const { transcribeVoice } = await import('../../discord/voice/tts');
    const buf = Buffer.alloc(4000);
    for (let i = 0; i < buf.length - 1; i += 2) buf.writeInt16LE(1000, i);
    const result = await transcribeVoice(buf);
    expect(result).toBe('');
  });

  it('transcribes via Vertex AI when configured', async () => {
    process.env.GEMINI_USE_VERTEX_AI = 'true';
    process.env.VERTEX_PROJECT_ID = 'test-project';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ text: 'vertex transcription' }],
          },
        }],
      }),
    }) as any;

    const { transcribeVoice } = await import('../../discord/voice/tts');
    const buf = Buffer.alloc(4000);
    for (let i = 0; i < buf.length - 1; i += 2) buf.writeInt16LE(1000, i);
    const result = await transcribeVoice(buf);
    expect(result).toBe('vertex transcription');
    expect(mockRecordGeminiUsage).toHaveBeenCalled();
  });

  it('throws when Gemini over limit', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const { isGeminiOverLimit } = require('../../discord/usage');
    (isGeminiOverLimit as jest.Mock).mockReturnValueOnce(true);

    const { transcribeVoice } = await import('../../discord/voice/tts');
    const buf = Buffer.alloc(4000);
    for (let i = 0; i < buf.length - 1; i += 2) buf.writeInt16LE(1000, i);
    await expect(transcribeVoice(buf)).rejects.toThrow('Daily Gemini API call limit reached');
  });
});

describe('tts.ts — textToSpeech fallback behavior', () => {
  beforeEach(() => {
    jest.resetModules();
    mockConvert.mockClear();
    mockRecordGeminiUsage.mockClear();
  });

  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_USE_VERTEX_AI;
    delete process.env.VERTEX_PROJECT_ID;
  });

  it('falls back to Gemini when ElevenLabs fails at runtime', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-gemini-key';

    // ElevenLabs throws
    mockConvert.mockRejectedValue(new Error('ElevenLabs service unavailable'));

    const fakeAudioData = Buffer.from('gemini-fallback').toString('base64');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: 'audio/L16', data: fakeAudioData } }],
          },
        }],
      }),
    }) as any;

    const { textToSpeech } = await import('../../discord/voice/tts');
    const result = await textToSpeech('Test', 'Kore');
    expect(result.length).toBeGreaterThan(0);
  });

  it('throws when both ElevenLabs and Gemini fail', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-gemini-key';

    mockConvert.mockRejectedValue(new Error('ElevenLabs down'));

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Gemini error',
    }) as any;

    const { textToSpeech } = await import('../../discord/voice/tts');
    await expect(textToSpeech('Test', 'Kore')).rejects.toThrow('Gemini TTS error');
  });

  it('throws when Gemini TTS has no audio data in response', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    process.env.GEMINI_API_KEY = 'test-gemini-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ text: 'no audio here' }],
          },
        }],
      }),
    }) as any;

    const { textToSpeech } = await import('../../discord/voice/tts');
    await expect(textToSpeech('Test', 'Kore')).rejects.toThrow('No audio data in Gemini TTS response');
  });

  it('throws when Gemini API key is not set and Vertex is not enabled', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.GEMINI_API_KEY;

    const { textToSpeech } = await import('../../discord/voice/tts');
    await expect(textToSpeech('Test', 'Kore')).rejects.toThrow('Gemini API key not configured');
  });

  it('throws when Vertex is enabled but project ID missing for TTS', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.GEMINI_USE_VERTEX_AI = 'true';
    delete process.env.VERTEX_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;

    const { textToSpeech } = await import('../../discord/voice/tts');
    await expect(textToSpeech('Test', 'Kore')).rejects.toThrow('Vertex AI is enabled but VERTEX_PROJECT_ID');
  });

  it('uses Vertex AI for TTS when configured', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    process.env.GEMINI_USE_VERTEX_AI = 'true';
    process.env.VERTEX_PROJECT_ID = 'test-project';

    const fakeAudioData = Buffer.from('audio').toString('base64');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: 'audio/pcm', data: fakeAudioData } }],
          },
        }],
      }),
    }) as any;

    const { textToSpeech } = await import('../../discord/voice/tts');
    const result = await textToSpeech('Test', 'Kore');
    expect(result.length).toBeGreaterThan(0);
    // Verify it used Vertex endpoint
    const url = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(url).toContain('aiplatform.googleapis.com');
  });

  it('throws when Gemini is over limit for TTS', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    process.env.GEMINI_API_KEY = 'test-gemini-key';

    const { isGeminiOverLimit } = require('../../discord/usage');
    (isGeminiOverLimit as jest.Mock).mockReturnValueOnce(true);

    const { textToSpeech } = await import('../../discord/voice/tts');
    await expect(textToSpeech('Test', 'Kore')).rejects.toThrow('Daily Gemini API call limit reached');
  });
});

describe('tts.ts — Vertex access token flows', () => {
  beforeEach(() => {
    jest.resetModules();
    mockRecordGeminiUsage.mockClear();
  });

  afterEach(() => {
    delete process.env.GEMINI_USE_VERTEX_AI;
    delete process.env.VERTEX_PROJECT_ID;
    delete process.env.GEMINI_API_KEY;
  });

  it('callVertexGenerateContent throws when VERTEX_PROJECT_ID is not set', async () => {
    process.env.GEMINI_USE_VERTEX_AI = 'true';
    delete process.env.VERTEX_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;

    const { transcribeVoice } = await import('../../discord/voice/tts');
    await expect(transcribeVoice(Buffer.alloc(100))).rejects.toThrow();
  });

  it('callVertexGenerateContent throws on non-ok response', async () => {
    process.env.GEMINI_USE_VERTEX_AI = 'true';
    process.env.VERTEX_PROJECT_ID = 'test-project';

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad request',
    }) as any;

    const { transcribeVoice } = await import('../../discord/voice/tts');
    const buf = Buffer.alloc(4000);
    for (let i = 0; i < buf.length - 1; i += 2) buf.writeInt16LE(1000, i);
    await expect(transcribeVoice(buf)).rejects.toThrow('Vertex Gemini error');
  });

  it('resolves gemini-flash-latest to gemini-2.5-flash in Vertex', async () => {
    process.env.GEMINI_USE_VERTEX_AI = 'true';
    process.env.VERTEX_PROJECT_ID = 'test-project';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: 'transcribed' }] },
        }],
      }),
    }) as any;

    const { transcribeVoice } = await import('../../discord/voice/tts');
    const buf = Buffer.alloc(4000);
    for (let i = 0; i < buf.length - 1; i += 2) buf.writeInt16LE(1000, i);
    await transcribeVoice(buf);

    const url = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(url).toContain('gemini-2.5-flash');
  });
});
