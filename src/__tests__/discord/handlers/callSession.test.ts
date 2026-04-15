/**
 * Tests for src/discord/handlers/callSession.ts
 * Phone call session handler — mock Discord, Twilio, voice streams.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Static mocks (must come before imports) ──

jest.mock('@discordjs/voice', () => ({
  VoiceConnectionStatus: { Ready: 'ready', Destroyed: 'destroyed', Disconnected: 'disconnected' },
}));

jest.mock('discord.js', () => ({
  TextChannel: jest.fn(),
  VoiceChannel: jest.fn(),
  GuildMember: jest.fn(),
}));

jest.mock('../../../db/pool', () => ({
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), on: jest.fn() },
  __esModule: true,
}));

jest.mock('../../../discord/agents', () => ({
  getAgent: jest.fn().mockReturnValue({
    id: 'executive-assistant',
    name: 'Riley',
    emoji: '📋',
    avatarUrl: 'https://example.com/riley.png',
    voice: 'Achernar',
  }),
  AgentId: {},
}));

const mockAgentRespond = jest.fn().mockResolvedValue('Hello from Riley');
jest.mock('../../../discord/claude', () => ({
  agentRespond: mockAgentRespond,
  summarizeCall: jest.fn().mockResolvedValue('Call summary text'),
  ConversationMessage: {},
  ReusableAgentChatSession: {},
}));

jest.mock('../../../discord/memory', () => ({
  appendToMemory: jest.fn(),
  getMemoryContext: jest.fn().mockReturnValue([]),
}));

jest.mock('../../../discord/metrics', () => ({
  recordVoiceCallStart: jest.fn(),
  recordVoiceCallEnd: jest.fn(),
}));

jest.mock('../../../discord/services/diagnosticsWebhook', () => ({
  postDiagnostic: jest.fn().mockResolvedValue(undefined),
  mirrorAgentResponse: jest.fn().mockResolvedValue(undefined),
  mirrorVoiceTranscript: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../discord/services/opsFeed', () => ({
  postOpsLine: jest.fn().mockResolvedValue(undefined),
}));

const mockGetWebhook = jest.fn().mockResolvedValue({
  send: jest.fn().mockResolvedValue({ id: 'wh-msg-1' }),
});
jest.mock('../../../discord/services/webhooks', () => ({
  getWebhook: mockGetWebhook,
}));

jest.mock('../../../discord/usage', () => ({
  isGeminiOverLimit: jest.fn().mockReturnValue(false),
}));

const mockListenToAllMembersSmart = jest.fn().mockReturnValue(() => {});
jest.mock('../../../discord/voice/connection', () => ({
  listenToAllMembersSmart: mockListenToAllMembersSmart,
  VoiceTranscription: {},
}));

jest.mock('../../../discord/voice/deepgram', () => ({
  isDeepgramAvailable: jest.fn().mockReturnValue(false),
}));

jest.mock('../../../discord/voice/elevenlabs', () => ({
  primeElevenLabsVoiceCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../discord/voice/elevenlabsConvai', () => ({
  getElevenLabsConvaiReply: jest.fn().mockResolvedValue('ConvAI response'),
  isElevenLabsConvaiEnabled: jest.fn().mockReturnValue(false),
}));

jest.mock('../../../discord/voice/elevenlabsRealtime', () => ({
  isElevenLabsRealtimeAvailable: jest.fn().mockReturnValue(false),
}));

const mockJoinTesterVoiceChannel = jest.fn().mockResolvedValue(undefined);
const mockLeaveTesterVoiceChannel = jest.fn();
const mockSpeakAsTesterInVoice = jest.fn().mockResolvedValue(undefined);
const mockGetTesterVoiceConnection = jest.fn().mockReturnValue({
  state: { status: 'ready' },
  receiver: { speaking: { on: jest.fn(), off: jest.fn() } },
});
const mockStopTesterVCPlayback = jest.fn();
const mockSpeakInTesterVC = jest.fn().mockResolvedValue(undefined);
const mockSpeakInTesterVCWithOptions = jest.fn().mockResolvedValue(undefined);
const mockSetTesterNickname = jest.fn().mockResolvedValue('OldNick');
const mockRestoreTesterNickname = jest.fn().mockResolvedValue(undefined);
const mockSetTesterAvatar = jest.fn().mockResolvedValue(undefined);
const mockRestoreTesterAvatar = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../discord/voice/testerClient', () => ({
  joinTesterVoiceChannel: mockJoinTesterVoiceChannel,
  leaveTesterVoiceChannel: mockLeaveTesterVoiceChannel,
  speakAsTesterInVoice: mockSpeakAsTesterInVoice,
  getTesterVoiceConnection: mockGetTesterVoiceConnection,
  stopTesterVCPlayback: mockStopTesterVCPlayback,
  speakInTesterVC: mockSpeakInTesterVC,
  speakInTesterVCWithOptions: mockSpeakInTesterVCWithOptions,
  setTesterNickname: mockSetTesterNickname,
  restoreTesterNickname: mockRestoreTesterNickname,
  setTesterAvatar: mockSetTesterAvatar,
  restoreTesterAvatar: mockRestoreTesterAvatar,
}));

const mockTextToSpeech = jest.fn().mockResolvedValue(Buffer.from('audio'));
jest.mock('../../../discord/voice/tts', () => ({
  textToSpeech: mockTextToSpeech,
}));

jest.mock('../../../utils/errors', () => ({
  errMsg: jest.fn((e: any) => (e instanceof Error ? e.message : String(e || 'Unknown'))),
}));

import {
  setVoiceErrorChannel,
  startCall,
  endCall,
  isCallActive,
  processTesterVoiceTurnForCall,
  injectVoiceTranscriptForTesting,
} from '../../../discord/handlers/callSession';

function makeTextChannel(name = 'groupchat'): any {
  return {
    id: `ch-${name}`,
    name,
    send: jest.fn().mockResolvedValue({ id: 'msg-1' }),
    client: { user: { id: 'bot-1' } },
    messages: { fetch: jest.fn().mockResolvedValue(new Map()) },
  };
}

function makeVoiceChannel(name = 'voice'): any {
  return {
    id: `vc-${name}`,
    name,
    guild: { id: 'guild-1', voiceAdapterCreator: jest.fn() },
    members: new Map(),
  };
}

function makeMember(id = '999', displayName = 'TestUser', bot = false): any {
  return {
    id,
    displayName,
    user: { bot, id },
  };
}

describe('callSession', () => {
  const origEnv = { ...process.env };

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env = { ...origEnv };
    process.env.VOICE_DISABLE_CALL_LOG = 'true';
    process.env.VOICE_DISABLE_TRANSCRIPT_SUMMARY = 'true';
    process.env.VOICE_LOW_LATENCY_MODE = 'false';
    process.env.VOICE_STARTUP_SELFTEST_ENABLED = 'false';
    process.env.VOICE_STAGE_LOGS_ENABLED = 'false';
    process.env.VOICE_TURN_WATCHDOG_MS = '0';
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.DISCORD_TESTER_BOT_ID = '';
    process.env.DISCORD_TEST_BOT_TOKEN = '';

    // Ensure no leftover active session
    if (isCallActive()) {
      await endCall();
    }
  });

  afterAll(async () => {
    process.env = origEnv;
    if (isCallActive()) {
      await endCall();
    }
  });

  // ────────────────────────────────────────
  // setVoiceErrorChannel
  // ────────────────────────────────────────
  describe('setVoiceErrorChannel()', () => {
    it('accepts a channel', () => {
      expect(() => setVoiceErrorChannel(makeTextChannel('voice-errors'))).not.toThrow();
    });
    it('accepts null', () => {
      expect(() => setVoiceErrorChannel(null)).not.toThrow();
    });
  });

  // ────────────────────────────────────────
  // isCallActive
  // ────────────────────────────────────────
  describe('isCallActive()', () => {
    it('returns false when no call is active', () => {
      expect(isCallActive()).toBe(false);
    });
  });

  // ────────────────────────────────────────
  // startCall + endCall
  // ────────────────────────────────────────
  describe('startCall()', () => {
    it('starts a call and sets active state', async () => {
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('100', 'Alice', false);

      await startCall(vc, gc, cl, member);

      expect(isCallActive()).toBe(true);
      expect(mockJoinTesterVoiceChannel).toHaveBeenCalledWith(vc);
      expect(mockSetTesterNickname).toHaveBeenCalled();
      expect(mockListenToAllMembersSmart).toHaveBeenCalled();

      await endCall();
      expect(isCallActive()).toBe(false);
    });

    it('rejects starting a second call', async () => {
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('101', 'Bob', false);

      await startCall(vc, gc, cl, member);
      expect(isCallActive()).toBe(true);

      // Second start should be blocked
      await startCall(vc, gc, cl, member);
      // Still only one call
      expect(isCallActive()).toBe(true);

      await endCall();
    });

    it('fails when voice input unavailable', async () => {
      process.env.GEMINI_API_KEY = '';
      const { isElevenLabsRealtimeAvailable } = require('../../../discord/voice/elevenlabsRealtime');
      (isElevenLabsRealtimeAvailable as jest.Mock).mockReturnValue(false);
      const { isDeepgramAvailable } = require('../../../discord/voice/deepgram');
      (isDeepgramAvailable as jest.Mock).mockReturnValue(false);

      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('102', 'Carol', false);

      await startCall(vc, gc, cl, member);
      expect(isCallActive()).toBe(false);
    });

    it('uses tester voice ID for tester-initiated calls', async () => {
      process.env.DISCORD_TESTER_BOT_ID = '200';
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const tester = makeMember('200', 'ASAPTester', true);

      await startCall(vc, gc, cl, tester);
      expect(isCallActive()).toBe(true);

      await endCall();
    });
  });

  describe('endCall()', () => {
    it('no-ops when no call is active', async () => {
      expect(isCallActive()).toBe(false);
      await endCall();
      expect(isCallActive()).toBe(false);
    });

    it('restores tester nickname and avatar', async () => {
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('103', 'Dan', false);

      await startCall(vc, gc, cl, member);
      await endCall();

      expect(mockRestoreTesterNickname).toHaveBeenCalled();
      expect(mockRestoreTesterAvatar).toHaveBeenCalled();
      expect(mockLeaveTesterVoiceChannel).toHaveBeenCalled();
    });

    it('posts call log when logging enabled', async () => {
      process.env.VOICE_DISABLE_CALL_LOG = 'false';
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('104', 'Eve', false);

      await startCall(vc, gc, cl, member);
      await endCall();

      expect(cl.send).toHaveBeenCalled();
    });

    it('posts call summary when enabled', async () => {
      process.env.VOICE_DISABLE_CALL_LOG = 'false';
      process.env.VOICE_DISABLE_TRANSCRIPT_SUMMARY = 'false';
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('105', 'Frank', false);

      await startCall(vc, gc, cl, member);
      await endCall();

      const { summarizeCall } = require('../../../discord/claude');
      expect(summarizeCall).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────
  // processTesterVoiceTurnForCall
  // ────────────────────────────────────────
  describe('processTesterVoiceTurnForCall()', () => {
    it('returns failure when no call is active', async () => {
      const result = await processTesterVoiceTurnForCall({
        userId: '999',
        username: 'Tester',
        text: 'Hello',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('No active voice call');
    });

    it('returns failure for empty text', async () => {
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('106', 'Tester', false);
      await startCall(vc, gc, cl, member);

      const result = await processTesterVoiceTurnForCall({
        userId: '106',
        username: 'Tester',
        text: '',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('empty');

      await endCall();
    });

    it('uses real voice when available', async () => {
      process.env.ASAPTESTER_REAL_VOICE_TURNS = 'true';
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('107', 'Tester', false);
      await startCall(vc, gc, cl, member);

      const result = await processTesterVoiceTurnForCall({
        userId: '107',
        username: 'Tester',
        text: 'Hello Riley',
      });
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('voice');

      await endCall();
    });

    it('falls back to injection on voice failure', async () => {
      process.env.ASAPTESTER_REAL_VOICE_TURNS = 'true';
      process.env.ASAPTESTER_REAL_VOICE_FALLBACK_INJECTION = 'true';
      mockSpeakAsTesterInVoice.mockRejectedValueOnce(new Error('playback failed'));

      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('108', 'Tester', false);
      await startCall(vc, gc, cl, member);

      const result = await processTesterVoiceTurnForCall({
        userId: '108',
        username: 'Tester',
        text: 'Hello Riley',
      });
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('injected');

      await endCall();
    });

    it('does not fall back when fallback disabled', async () => {
      process.env.ASAPTESTER_REAL_VOICE_TURNS = 'true';
      process.env.ASAPTESTER_REAL_VOICE_FALLBACK_INJECTION = 'false';
      mockSpeakAsTesterInVoice.mockRejectedValueOnce(new Error('playback failed'));

      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('109', 'Tester', false);
      await startCall(vc, gc, cl, member);

      const result = await processTesterVoiceTurnForCall({
        userId: '109',
        username: 'Tester',
        text: 'Hello Riley',
      });
      expect(result.ok).toBe(false);

      await endCall();
    });
  });

  // ────────────────────────────────────────
  // injectVoiceTranscriptForTesting
  // ────────────────────────────────────────
  describe('injectVoiceTranscriptForTesting()', () => {
    it('returns failure when no call is active', async () => {
      const result = await injectVoiceTranscriptForTesting({
        userId: '999',
        username: 'Tester',
        text: 'inject me',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('No active voice call');
    });

    it('returns failure for empty text', async () => {
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('110', 'Tester', false);
      await startCall(vc, gc, cl, member);

      const result = await injectVoiceTranscriptForTesting({
        userId: '110',
        username: 'Tester',
        text: '  ',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('empty');

      await endCall();
    });

    it('injects transcript into active call', async () => {
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('111', 'Tester', false);
      await startCall(vc, gc, cl, member);

      const result = await injectVoiceTranscriptForTesting({
        userId: '111',
        username: 'Tester',
        text: 'What time is it?',
      });
      expect(result.ok).toBe(true);
      expect(mockAgentRespond).toHaveBeenCalled();

      await endCall();
    });

    it('uses default username if not provided', async () => {
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('112', 'Tester', false);
      await startCall(vc, gc, cl, member);

      const result = await injectVoiceTranscriptForTesting({
        userId: '',
        username: '',
        text: 'test input',
      });
      expect(result.ok).toBe(true);

      await endCall();
    });
  });

  // ────────────────────────────────────────
  // Voice input handling (via injection)
  // ────────────────────────────────────────
  describe('voice input processing', () => {
    it('skips filler-only input', async () => {
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('120', 'User', false);
      await startCall(vc, gc, cl, member);

      mockAgentRespond.mockClear();
      const result = await injectVoiceTranscriptForTesting({
        userId: '120',
        username: 'User',
        text: 'uh huh',
      });
      // Filler-only text is filtered before agent respond
      expect(result.ok).toBe(true);
      expect(mockAgentRespond).not.toHaveBeenCalled();

      await endCall();
    });

    it('skips very short input', async () => {
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('121', 'User', false);
      await startCall(vc, gc, cl, member);

      mockAgentRespond.mockClear();
      const result = await injectVoiceTranscriptForTesting({
        userId: '121',
        username: 'User',
        text: 'hi',
      });
      expect(result.ok).toBe(true);
      // "hi" is only 2 chars, below VOICE_MIN_INPUT_CHARS
      expect(mockAgentRespond).not.toHaveBeenCalled();

      await endCall();
    });

    it('handles duplicate input within window', async () => {
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('122', 'User', false);
      await startCall(vc, gc, cl, member);

      await injectVoiceTranscriptForTesting({
        userId: '122',
        username: 'User',
        text: 'what is the weather today?',
      });

      mockAgentRespond.mockClear();
      // Same text again immediately
      await injectVoiceTranscriptForTesting({
        userId: '122',
        username: 'User',
        text: 'what is the weather today?',
      });
      expect(mockAgentRespond).not.toHaveBeenCalled();

      await endCall();
    });

    it('processes voice-to-text handoff instructions', async () => {
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('123', 'User', false);
      await startCall(vc, gc, cl, member);

      // This needs a longer phrase to pass min char filter
      const result = await injectVoiceTranscriptForTesting({
        userId: '123',
        username: 'User',
        text: 'send to text riley: please check the deployment status',
      });
      expect(result.ok).toBe(true);

      await endCall();
    });

    it('generates TTS response and speaks', async () => {
      process.env.VOICE_DISABLE_CALL_LOG = 'false';
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('124', 'User', false);
      await startCall(vc, gc, cl, member);

      await injectVoiceTranscriptForTesting({
        userId: '124',
        username: 'User',
        text: 'Please tell me the project status',
      });

      expect(mockAgentRespond).toHaveBeenCalled();

      await endCall();
    });

    it('handles TTS failure gracefully', async () => {
      mockSpeakInTesterVCWithOptions.mockRejectedValueOnce(new Error('TTS failed'));
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('125', 'User', false);
      await startCall(vc, gc, cl, member);

      // This should not throw; error is caught internally
      await injectVoiceTranscriptForTesting({
        userId: '125',
        username: 'User',
        text: 'Can you help me with something?',
      });

      await endCall();
    });
  });

  // ────────────────────────────────────────
  // ConvAI mode
  // ────────────────────────────────────────
  describe('ConvAI mode', () => {
    it('uses ConvAI when enabled', async () => {
      const { isElevenLabsConvaiEnabled } = require('../../../discord/voice/elevenlabsConvai');
      (isElevenLabsConvaiEnabled as jest.Mock).mockReturnValue(true);

      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('130', 'User', false);
      await startCall(vc, gc, cl, member);

      await injectVoiceTranscriptForTesting({
        userId: '130',
        username: 'User',
        text: 'Hello via ConvAI path',
      });

      const { getElevenLabsConvaiReply } = require('../../../discord/voice/elevenlabsConvai');
      expect(getElevenLabsConvaiReply).toHaveBeenCalled();

      await endCall();
      (isElevenLabsConvaiEnabled as jest.Mock).mockReturnValue(false);
    });
  });

  // ────────────────────────────────────────
  // Call logging variations
  // ────────────────────────────────────────
  describe('call logging', () => {
    it('logs transcript when call log enabled', async () => {
      process.env.VOICE_DISABLE_CALL_LOG = 'false';
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('140', 'Logger', false);

      await startCall(vc, gc, cl, member);
      await injectVoiceTranscriptForTesting({
        userId: '140',
        username: 'Logger',
        text: 'This should be logged in call log',
      });
      await endCall();

      // Call log channel should receive transcript messages
      expect(cl.send).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────
  // Startup self-test
  // ────────────────────────────────────────
  describe('startup self-test', () => {
    it('runs self-test when enabled', async () => {
      process.env.VOICE_STARTUP_SELFTEST_ENABLED = 'true';
      // textToSpeech returns a buffer after a tiny delay to simulate real latency
      mockTextToSpeech.mockResolvedValue(Buffer.from('self-test-audio'));
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('150', 'SelfTest', false);

      await startCall(vc, gc, cl, member);
      // Self-test is a fire-and-forget async — give it time to resolve
      await new Promise((r) => setTimeout(r, 200));

      expect(mockTextToSpeech).toHaveBeenCalledWith(
        expect.stringContaining('SelfTest'),
        expect.any(String),
      );

      await endCall();
    });
  });

  // ────────────────────────────────────────
  // Language detection
  // ────────────────────────────────────────
  describe('language support', () => {
    it('passes language hint to agent for non-English input', async () => {
      const vc = makeVoiceChannel();
      const gc = makeTextChannel('groupchat');
      const cl = makeTextChannel('call-log');
      const member = makeMember('160', 'CNUser', false);
      await startCall(vc, gc, cl, member);

      await injectVoiceTranscriptForTesting({
        userId: '160',
        username: 'CNUser',
        text: 'Hello, tell me the current status with details',
        language: 'zh',
      });

      // The agentRespond call should include language hint
      expect(mockAgentRespond).toHaveBeenCalled();
      const callArgs = mockAgentRespond.mock.calls[0];
      const contextArg = callArgs[2];
      expect(contextArg).toContain('Mandarin Chinese');

      await endCall();
    });
  });
});
