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
    const eventListeners: Record<string, Function> = {};
    const mockConnection = {
      on: jest.fn((event: string, cb: Function) => { eventListeners[event] = cb; }),
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
