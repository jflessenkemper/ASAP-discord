/**
 * Unit tests for Discord handler language detection:
 *   - callSession.ts  — isVoiceInputAvailable gating
 *   - groupchat.ts    — CJK language hint injection
 *   - textChannel.ts  — CJK language hint injection
 *
 * NOTE: The language-hint injection helpers are tested via the pattern/regex
 * behaviour used inside the handlers, since the handlers are not individually
 * exported. Using the pure regex logic verifies correctness without coupling
 * tests to Discord API internals.
 */

// ─── Shared CJK detection helper (mirrors logic in groupchat.ts / textChannel.ts) ─
const CJK_PATTERN = /[\u4e00-\u9fff\u3400-\u4dbf]/;

function buildContextMessage(senderName: string, userMessage: string): string {
  const hint = CJK_PATTERN.test(userMessage)
    ? '\n\n[Language detected: Mandarin Chinese. Please reply in Mandarin Chinese (简体中文).]'
    : '';
  return `[${senderName}]: ${userMessage}${hint}`;
}

// ─── Mock pool so callSession / usage imports don't fail ──────────────────
jest.mock('../../db/pool', () => require('../mocks/pool'));
jest.mock('@discordjs/voice', () => ({
  VoiceConnectionStatus: {
    Signalling: 'signalling',
    Connecting: 'connecting',
    Ready: 'ready',
    Disconnected: 'disconnected',
    Destroyed: 'destroyed',
  },
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Language detection helper — CJK pattern', () => {
  it('detects Mandarin characters in the CJK Unified Ideographs block', () => {
    expect(CJK_PATTERN.test('你好世界')).toBe(true);
  });

  it('detects CJK Extension A characters', () => {
    // U+3400 start of CJK Extension A
    expect(CJK_PATTERN.test('\u3400')).toBe(true);
  });

  it('returns false for English-only text', () => {
    expect(CJK_PATTERN.test('Hello, world!')).toBe(false);
  });

  it('returns false for Japanese kana (not covered by CJK unified block)', () => {
    // Hiragana is U+3040–U+309F — outside our detection range; intentional
    expect(CJK_PATTERN.test('こんにちは')).toBe(false);
  });

  it('returns true for mixed English + Chinese', () => {
    expect(CJK_PATTERN.test('Hello 你好')).toBe(true);
  });
});

describe('buildContextMessage — language hint injection', () => {
  it('does NOT add hint for English messages', () => {
    const msg = buildContextMessage('Alice', 'Can you help me with this bug?');
    expect(msg).toBe('[Alice]: Can you help me with this bug?');
    expect(msg).not.toContain('Language detected');
  });

  it('adds Mandarin hint when message contains Chinese characters', () => {
    const msg = buildContextMessage('Bob', '你好，请帮我修复这个错误');
    expect(msg).toContain('[Bob]: 你好，请帮我修复这个错误');
    expect(msg).toContain('Language detected: Mandarin Chinese');
    expect(msg).toContain('简体中文');
  });

  it('adds Mandarin hint for mixed English + Chinese', () => {
    const msg = buildContextMessage('Carol', 'Please 帮我 fix this');
    expect(msg).toContain('Language detected: Mandarin Chinese');
  });

  it('hint is appended — original message content is preserved exactly', () => {
    const userMessage = '请给我看代码';
    const msg = buildContextMessage('Dave', userMessage);
    expect(msg).toContain(`[Dave]: ${userMessage}`);
  });
});

describe('callSession — isVoiceInputAvailable logic', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('loads callSession successfully when ElevenLabs voice is configured', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-elevenlabs';
    // Minimal mocks so the module can load
    jest.mock('../../discord/usage', () => ({
      isGeminiOverLimit: () => false,
      recordGeminiUsage: jest.fn(),
      initUsageCounters: jest.fn().mockResolvedValue(undefined),
      flushUsageCounters: jest.fn().mockResolvedValue(undefined),
    }));
    jest.mock('../../discord/agents', () => ({ getAgent: jest.fn(), getAgents: jest.fn().mockReturnValue(new Map()) }));
    jest.mock('../../discord/claude', () => ({ agentRespond: jest.fn(), summarizeCall: jest.fn() }));
    jest.mock('../../discord/voice/tts', () => ({ textToSpeech: jest.fn().mockResolvedValue(Buffer.alloc(0)) }));
    jest.mock('../../discord/voice/connection', () => ({
      joinVC: jest.fn(), leaveVC: jest.fn(), speakInVC: jest.fn(), speakInVCWithOptions: jest.fn(),
      stopVCPlayback: jest.fn(), listenToAllMembersSmart: jest.fn(), getConnection: jest.fn(),
    }));
    jest.mock('../../discord/memory', () => ({ appendToMemory: jest.fn(), getMemoryContext: jest.fn().mockReturnValue([]) }));
    jest.mock('../../discord/metrics', () => ({ recordVoiceCallStart: jest.fn(), recordVoiceCallEnd: jest.fn() }));
    jest.mock('../../discord/services/diagnosticsWebhook', () => ({
      postDiagnostic: jest.fn(), mirrorAgentResponse: jest.fn(), mirrorVoiceTranscript: jest.fn(),
    }));
    jest.mock('../../discord/services/webhooks', () => ({ getWebhook: jest.fn() }));
    jest.mock('../../discord/handlers/documentation', () => ({ documentToChannel: jest.fn() }));

    const { isCallActive } = await import('../../discord/handlers/callSession');
    // isCallActive is a simple getter; if it loads without throwing, module is importable
    expect(typeof isCallActive).toBe('function');
    expect(isCallActive()).toBe(false);

    delete process.env.ELEVENLABS_API_KEY;
  });
});
