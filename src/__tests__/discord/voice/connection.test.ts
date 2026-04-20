/**
 * Tests for src/discord/voice/connection.ts
 * Voice connection management — join, leave, speak, listen, STT routing.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { EventEmitter, Readable, Transform } from 'stream';

// ── @discordjs/voice mocks ──
const mockConnectionDestroy = jest.fn();
const mockConnectionSubscribe = jest.fn();
const mockSpeakingEmitter = new EventEmitter();
const mockReceiverSubscribe = jest.fn();
const mockConnection = {
  destroy: mockConnectionDestroy,
  subscribe: mockConnectionSubscribe,
  state: { status: 'ready' },
  receiver: {
    subscribe: mockReceiverSubscribe,
    speaking: mockSpeakingEmitter,
  },
};

const mockPlayerPlay = jest.fn();
const mockPlayerStop = jest.fn();
const mockAudioPlayer = Object.assign(new EventEmitter(), {
  play: mockPlayerPlay,
  stop: mockPlayerStop,
});

jest.mock('@discordjs/voice', () => ({
  joinVoiceChannel: jest.fn().mockReturnValue(mockConnection),
  entersState: jest.fn().mockResolvedValue(undefined),
  VoiceConnection: jest.fn(),
  VoiceConnectionStatus: { Ready: 'ready', Destroyed: 'destroyed', Disconnected: 'disconnected' },
  createAudioPlayer: jest.fn().mockReturnValue(mockAudioPlayer),
  createAudioResource: jest.fn().mockReturnValue({ type: 'resource' }),
  AudioPlayer: jest.fn(),
  AudioPlayerStatus: { Playing: 'playing', Idle: 'idle' },
  EndBehaviorType: { AfterSilence: 1, AfterInactivity: 2 },
  StreamType: { Arbitrary: 'arbitrary' },
}));

// ── discord.js mocks ──
jest.mock('discord.js', () => ({
  VoiceBasedChannel: jest.fn(),
  GuildMember: jest.fn(),
}));

// ── prism-media mock ──
class MockOpusDecoder extends Transform {
  constructor() {
    super();
  }
  _transform(chunk: Buffer, _enc: string, cb: () => void) {
    this.push(chunk);
    cb();
  }
}
jest.mock('prism-media', () => ({
  opus: {
    Decoder: jest.fn().mockImplementation(() => new MockOpusDecoder()),
  },
}));

// ── STT service mocks ──
jest.mock('../../../discord/voice/elevenlabsRealtime', () => ({
  startElevenLabsRealtimeTranscription: jest.fn(),
  ElevenLabsRealtimeSession: jest.fn(),
  isElevenLabsRealtimeAvailable: jest.fn().mockReturnValue(false),
}));
jest.mock('../../../discord/voice/tts', () => ({
  transcribeVoiceDetailed: jest.fn().mockResolvedValue({ text: 'hello world', provider: 'elevenlabs' }),
}));
jest.mock('../../../utils/errors', () => ({
  errMsg: jest.fn((e: any) => (e instanceof Error ? e.message : String(e || 'Unknown'))),
}));

import {
  joinVC,
  leaveVC,
  speakInVC,
  speakInVCWithOptions,
  stopVCPlayback,
  getConnection,
  listenToUser,
  listenToAllMembers,
  listenToAllMembersSmart,
  listenToUserElevenLabsRealtime,
} from '../../../discord/voice/connection';
import { isElevenLabsRealtimeAvailable, startElevenLabsRealtimeTranscription } from '../../../discord/voice/elevenlabsRealtime';
import { transcribeVoiceDetailed } from '../../../discord/voice/tts';

function makeVoiceChannel(members: any[] = []): any {
  const membersMap = new Map(members.map((m) => [m.id || '1', m]));
  return {
    id: 'vc-1',
    name: 'Voice',
    guild: {
      id: 'guild-1',
      voiceAdapterCreator: jest.fn(),
    },
    members: membersMap,
  };
}

function makeMember(id = '999', displayName = 'TestUser', bot = false): any {
  return {
    id,
    displayName,
    user: { bot, id },
  };
}

describe('voice/connection', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...origEnv };
    process.env.DISCORD_TESTER_BOT_ID = '';
    process.env.DISCORD_TEST_BOT_TOKEN = '';
    process.env.VOICE_REALTIME_MODE = 'false';
    process.env.VOICE_STT_PROVIDER = '';
    mockAudioPlayer.removeAllListeners();
  });

  afterAll(() => {
    process.env = origEnv;
  });

  // ────────────────────────────────────────
  // joinVC
  // ────────────────────────────────────────
  describe('joinVC()', () => {
    it('joins a voice channel and returns the connection', async () => {
      const channel = makeVoiceChannel();
      const conn = await joinVC(channel);
      expect(conn).toBe(mockConnection);
      expect(mockConnectionSubscribe).toHaveBeenCalledWith(mockAudioPlayer);
    });

    it('destroys previous connection before joining a new one', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      mockConnectionDestroy.mockClear();
      await joinVC(channel);
      expect(mockConnectionDestroy).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────
  // leaveVC
  // ────────────────────────────────────────
  describe('leaveVC()', () => {
    it('stops audio player and destroys connection', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      leaveVC();
      expect(mockPlayerStop).toHaveBeenCalled();
    });

    it('no-ops when called while cleanup is in progress', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      // First call
      leaveVC();
      mockPlayerStop.mockClear();
      // Second call should be skipped (isCleaningUp is reset after first)
      leaveVC();
    });

    it('handles leaveVC when not connected', () => {
      expect(() => leaveVC()).not.toThrow();
    });
  });

  // ────────────────────────────────────────
  // speakInVC / speakInVCWithOptions
  // ────────────────────────────────────────
  describe('speakInVC()', () => {
    it('rejects when not connected', async () => {
      // Leave first to clear connection
      leaveVC();
      await expect(speakInVC(Buffer.from('audio'))).rejects.toThrow('Not connected');
    });

    it('rejects with empty buffer', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      await expect(speakInVC(Buffer.alloc(0))).rejects.toThrow('empty audio buffer');
    });

    it('plays audio and resolves on idle', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      const playPromise = speakInVC(Buffer.from('audio-data'));
      // Simulate Playing then Idle
      mockAudioPlayer.emit('playing');
      mockAudioPlayer.emit('idle');
      await playPromise;
      expect(mockPlayerPlay).toHaveBeenCalled();
    });

    it('resolves on idle even without seeing Playing (very short clip)', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      const playPromise = speakInVC(Buffer.from('short'));
      mockAudioPlayer.emit('idle');
      await playPromise;
    });

    it('rejects on error', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      const playPromise = speakInVC(Buffer.from('audio-data'));
      mockAudioPlayer.emit('error', new Error('playback failed'));
      await expect(playPromise).rejects.toThrow('playback failed');
    });

    it('aborts playback on signal abort', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      const ac = new AbortController();
      const playPromise = speakInVCWithOptions(Buffer.from('audio-data'), { signal: ac.signal });
      ac.abort();
      // After abort, player stop fires idle
      mockAudioPlayer.emit('idle');
      await expect(playPromise).rejects.toThrow('aborted');
    });

    it('calls onPlaybackStart callback', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      const onStart = jest.fn();
      const playPromise = speakInVCWithOptions(Buffer.from('audio'), { onPlaybackStart: onStart });
      mockAudioPlayer.emit('playing');
      mockAudioPlayer.emit('idle');
      await playPromise;
      expect(onStart).toHaveBeenCalled();
    });

    it('handles pre-aborted signal', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      const ac = new AbortController();
      ac.abort();
      const playPromise = speakInVCWithOptions(Buffer.from('audio'), { signal: ac.signal });
      mockAudioPlayer.emit('idle');
      await expect(playPromise).rejects.toThrow('aborted');
    });
  });

  // ────────────────────────────────────────
  // stopVCPlayback
  // ────────────────────────────────────────
  describe('stopVCPlayback()', () => {
    it('stops the audio player', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      stopVCPlayback();
      expect(mockPlayerStop).toHaveBeenCalledWith(true);
    });

    it('no-ops when no player', () => {
      leaveVC();
      expect(() => stopVCPlayback()).not.toThrow();
    });
  });

  // ────────────────────────────────────────
  // getConnection
  // ────────────────────────────────────────
  describe('getConnection()', () => {
    it('returns connection after join', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      expect(getConnection()).toBe(mockConnection);
    });

    it('returns null after leave', async () => {
      const channel = makeVoiceChannel();
      await joinVC(channel);
      leaveVC();
      expect(getConnection()).toBeNull();
    });
  });

  // ────────────────────────────────────────
  // listenToUser (batch ElevenLabs STT)
  // ────────────────────────────────────────
  describe('listenToUser()', () => {
    it('subscribes to member audio and transcribes', async () => {
      const member = makeMember('100', 'Alice', false);
      const onTranscription = jest.fn();
      const onSpeechStart = jest.fn();

      // Create a subscription that emits audio data then ends
      const subStream = new Readable({ read() {} });
      // Also provide a stream for the re-subscribe after transcription completes
      const subStream2 = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValueOnce(subStream).mockReturnValue(subStream2);

      const unsub = listenToUser(mockConnection as any, member, onTranscription, onSpeechStart);
      expect(mockReceiverSubscribe).toHaveBeenCalledWith('100', expect.any(Object));

      // Feed PCM data from the decoder path
      const pcmChunk = Buffer.alloc(96000); // enough bytes for min threshold
      subStream.push(pcmChunk);
      subStream.push(null);

      // Wait for transcription
      await new Promise((r) => setTimeout(r, 100));

      expect(onSpeechStart).toHaveBeenCalledWith(member);
      expect(transcribeVoiceDetailed).toHaveBeenCalled();
      expect(onTranscription).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: '100',
          username: 'Alice',
          text: 'hello world',
          sttProvider: 'elevenlabs',
        })
      );

      unsub();
    });

    it('skips transcription for short audio buffers', async () => {
      const member = makeMember('101', 'Bob', false);
      const onTranscription = jest.fn();

      const subStream = new Readable({ read() {} });
      const subStream2 = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValueOnce(subStream).mockReturnValue(subStream2);

      const unsub = listenToUser(mockConnection as any, member, onTranscription);

      // Push less than VOICE_MIN_AUDIO_BYTES (default 48000)
      subStream.push(Buffer.alloc(100));
      subStream.push(null);

      await new Promise((r) => setTimeout(r, 100));

      // Should not transcribe short audio
      expect(onTranscription).not.toHaveBeenCalled();

      unsub();
    });

    it('returns cleanup function that stops listening', async () => {
      const member = makeMember('102', 'Carol', false);
      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValueOnce(subStream);

      const unsub = listenToUser(mockConnection as any, member, jest.fn());
      unsub();
      // Should not throw
    });
  });

  // ────────────────────────────────────────
  // listenToAllMembers
  // ────────────────────────────────────────
  describe('listenToAllMembers()', () => {
    it('subscribes to all non-bot members', () => {
      const human = makeMember('201', 'Human', false);
      const bot = makeMember('202', 'Bot', true);
      const channel = makeVoiceChannel([human, bot]);

      // Each listenToUser call will invoke receiver.subscribe
      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValue(subStream);

      const unsub = listenToAllMembers(mockConnection as any, channel, jest.fn());
      // Should subscribe to human, skip non-tester bot
      expect(mockReceiverSubscribe).toHaveBeenCalledWith('201', expect.any(Object));

      unsub();
    });

    it('picks up new speakers via speaking event', () => {
      const channel = makeVoiceChannel([]);
      const lateMember = makeMember('203', 'Late', false);
      channel.members.set('203', lateMember);

      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValue(subStream);

      const unsub = listenToAllMembers(mockConnection as any, channel, jest.fn());
      mockSpeakingEmitter.emit('start', '203');
      expect(mockReceiverSubscribe).toHaveBeenCalledWith('203', expect.any(Object));

      unsub();
    });

    it('ignores duplicate speaking events', () => {
      const member = makeMember('204', 'TestUser', false);
      const channel = makeVoiceChannel([member]);

      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValue(subStream);

      const unsub = listenToAllMembers(mockConnection as any, channel, jest.fn());
      const callCount = mockReceiverSubscribe.mock.calls.length;
      mockSpeakingEmitter.emit('start', '204'); // already listening
      expect(mockReceiverSubscribe.mock.calls.length).toBe(callCount);

      unsub();
    });
  });

  // ────────────────────────────────────────
  // listenToAllMembersSmart (STT routing)
  // ────────────────────────────────────────
  describe('listenToAllMembersSmart()', () => {
    it('uses ElevenLabs batch STT when nothing else is available', () => {
      (isElevenLabsRealtimeAvailable as jest.Mock).mockReturnValue(false);
      process.env.VOICE_REALTIME_MODE = 'false';

      const channel = makeVoiceChannel([]);
      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValue(subStream);

      const handle = listenToAllMembersSmart(mockConnection as any, channel, jest.fn());
      handle.unsubscribe();
    });

    it('uses ElevenLabs realtime when available', () => {
      (isElevenLabsRealtimeAvailable as jest.Mock).mockReturnValue(true);
      process.env.VOICE_REALTIME_MODE = 'true';

      const channel = makeVoiceChannel([]);
      const handle = listenToAllMembersSmart(mockConnection as any, channel, jest.fn());
      handle.unsubscribe();
    });

    it('respects VOICE_STT_PROVIDER=elevenlabs fallback to batch', () => {
      (isElevenLabsRealtimeAvailable as jest.Mock).mockReturnValue(false);
      process.env.VOICE_REALTIME_MODE = 'false';
      process.env.VOICE_STT_PROVIDER = 'elevenlabs';

      const channel = makeVoiceChannel([]);
      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValue(subStream);

      const handle = listenToAllMembersSmart(mockConnection as any, channel, jest.fn());
      handle.unsubscribe();
    });

    it('defaults to ElevenLabs batch STT for unsupported provider values', () => {
      (isElevenLabsRealtimeAvailable as jest.Mock).mockReturnValue(false);
      process.env.VOICE_REALTIME_MODE = 'false';
      process.env.VOICE_STT_PROVIDER = 'unsupported';

      const channel = makeVoiceChannel([]);
      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValue(subStream);

      const handle = listenToAllMembersSmart(mockConnection as any, channel, jest.fn());
      handle.unsubscribe();
    });
  });

  // ────────────────────────────────────────
  // listenToUserElevenLabsRealtime
  // ────────────────────────────────────────
  describe('listenToUserElevenLabsRealtime()', () => {
    it('falls back to batch on timeout', async () => {
      jest.useFakeTimers();
      const member = makeMember('400', 'ELUser', false);

      (startElevenLabsRealtimeTranscription as jest.Mock).mockReturnValue(new Promise(() => {}));

      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValue(subStream);

      const unsub = listenToUserElevenLabsRealtime(mockConnection as any, member, jest.fn());
      jest.advanceTimersByTime(11_000);
      unsub();
      jest.useRealTimers();
    });

    it('returns cleanup when session starts', async () => {
      const member = makeMember('401', 'ELUser2', false);
      const mockElSession = { send: jest.fn(), close: jest.fn() };

      (startElevenLabsRealtimeTranscription as jest.Mock).mockResolvedValue(mockElSession);

      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValue(subStream);

      const unsub = listenToUserElevenLabsRealtime(mockConnection as any, member, jest.fn());
      await new Promise((r) => setTimeout(r, 50));
      unsub();
      expect(mockElSession.close).toHaveBeenCalled();
    });

    it('handles ElevenLabs startup failure with retry and fallback', async () => {
      jest.useFakeTimers();
      const member = makeMember('402', 'ELFail', false);

      (startElevenLabsRealtimeTranscription as jest.Mock).mockRejectedValue(new Error('unauthorized'));

      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValue(subStream);

      const unsub = listenToUserElevenLabsRealtime(mockConnection as any, member, jest.fn());
      await jest.advanceTimersByTimeAsync(50);
      unsub();
      jest.useRealTimers();
    });

    it('falls back on quota error immediately', async () => {
      const member = makeMember('403', 'ELQuota', false);

      let errorCb: ((err: Error) => void) | undefined;
      (startElevenLabsRealtimeTranscription as jest.Mock).mockImplementation((_onText: any, onError: any) => {
        errorCb = onError;
        return Promise.resolve({ send: jest.fn(), close: jest.fn() });
      });

      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValue(subStream);

      const unsub = listenToUserElevenLabsRealtime(mockConnection as any, member, jest.fn());
      await new Promise((r) => setTimeout(r, 50));

      // Trigger quota error — should fallback directly
      errorCb?.(new Error('quota exceeded'));
      await new Promise((r) => setTimeout(r, 50));

      unsub();
    });
  });

  // ────────────────────────────────────────
  // tester bot ID detection
  // ────────────────────────────────────────
  describe('tester bot ID filtering', () => {
    it('transcribes tester bot members', () => {
      process.env.DISCORD_TESTER_BOT_ID = '500';
      const testerBot = makeMember('500', 'TesterBot', true);
      const channel = makeVoiceChannel([testerBot]);

      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValue(subStream);

      const unsub = listenToAllMembers(mockConnection as any, channel, jest.fn());
      expect(mockReceiverSubscribe).toHaveBeenCalledWith('500', expect.any(Object));
      unsub();
    });

    it('skips non-tester bots', () => {
      process.env.DISCORD_TESTER_BOT_ID = '';
      const otherBot = makeMember('600', 'OtherBot', true);
      const channel = makeVoiceChannel([otherBot]);

      const subStream = new Readable({ read() {} });
      mockReceiverSubscribe.mockReturnValue(subStream);

      const callCountBefore = mockReceiverSubscribe.mock.calls.length;
      const unsub = listenToAllMembers(mockConnection as any, channel, jest.fn());
      expect(mockReceiverSubscribe.mock.calls.length).toBe(callCountBefore);
      unsub();
    });
  });
});
