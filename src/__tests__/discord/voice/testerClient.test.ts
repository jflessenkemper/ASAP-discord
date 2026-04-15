/**
 * Tests for src/discord/voice/testerClient.ts
 * Voice tester client — mocks Discord voice primitives and Client.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { EventEmitter } from 'events';

// ---- @discordjs/voice mocks ----
const mockVoiceConnectionDestroy = jest.fn();
const mockVoiceConnectionSubscribe = jest.fn();
const mockVoiceConnection = {
  destroy: mockVoiceConnectionDestroy,
  subscribe: mockVoiceConnectionSubscribe,
};

const mockPlayerPlay = jest.fn();
const mockPlayerStop = jest.fn();
const mockAudioPlayer = Object.assign(new EventEmitter(), {
  play: mockPlayerPlay,
  stop: mockPlayerStop,
});

jest.mock('@discordjs/voice', () => ({
  entersState: jest.fn().mockResolvedValue(undefined),
  joinVoiceChannel: jest.fn().mockReturnValue(mockVoiceConnection),
  VoiceConnection: jest.fn(),
  VoiceConnectionStatus: { Ready: 'ready' },
  createAudioPlayer: jest.fn().mockReturnValue(mockAudioPlayer),
  createAudioResource: jest.fn().mockReturnValue({ type: 'resource' }),
  AudioPlayer: jest.fn(),
  AudioPlayerStatus: { Playing: 'playing', Idle: 'idle' },
  StreamType: { Arbitrary: 'arbitrary' },
}));

// ---- discord.js Client mock ----
let readyCb: ((...args: any[]) => void) | null = null;
let errorCb: ((...args: any[]) => void) | null = null;
const mockSetNickname = jest.fn().mockResolvedValue(undefined);
const mockSetAvatar = jest.fn().mockResolvedValue(undefined);
const mockFetchMe = jest.fn().mockResolvedValue({ nickname: 'OldNick', setNickname: mockSetNickname });
const mockChannelsFetch = jest.fn().mockResolvedValue({
  isVoiceBased: () => true,
});
const mockGuildsFetch = jest.fn().mockResolvedValue({
  id: 'guild-1',
  voiceAdapterCreator: jest.fn(),
  channels: { fetch: mockChannelsFetch },
  members: { fetchMe: mockFetchMe },
});
const mockLogin = jest.fn().mockResolvedValue('token');
const mockClientDestroy = jest.fn();

class MockClient {
  user = { id: 'tester-bot', setAvatar: mockSetAvatar };
  guilds = { fetch: mockGuildsFetch };
  destroy = mockClientDestroy;

  once(event: string, cb: (...args: any[]) => void) {
    if (event === 'ready') readyCb = cb;
    if (event === 'error') errorCb = cb;
    return this;
  }

  login(_token: string) {
    queueMicrotask(() => readyCb?.());
    return mockLogin(_token);
  }
}

jest.mock('discord.js', () => ({
  Client: MockClient,
  GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 },
}));

// ---- other mocks ----
jest.mock('../../../discord/voice/tts', () => ({
  textToSpeech: jest.fn().mockResolvedValue(Buffer.from('fake-audio')),
}));

jest.mock('../../../utils/errors', () => ({
  errMsg: (e: any) => (e instanceof Error ? e.message : String(e)),
}));

// ---- Module under test ----
import {
  joinTesterVoiceChannel,
  speakAsTesterInVoice,
  leaveTesterVoiceChannel,
  getTesterVoiceConnection,
  stopTesterVCPlayback,
  speakInTesterVC,
  speakInTesterVCWithOptions,
  setTesterNickname,
  restoreTesterNickname,
  setTesterAvatar,
  restoreTesterAvatar,
} from '../../../discord/voice/testerClient';

import { AudioPlayerStatus } from '@discordjs/voice';

describe('testerClient', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
    process.env.DISCORD_TEST_BOT_TOKEN = 'test-token';
    process.env.ASAPTESTER_VOICE_CLIENT_ENABLED = 'true';
    jest.clearAllMocks();
    readyCb = null;
    errorCb = null;
    // Reset player listeners
    mockAudioPlayer.removeAllListeners();
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  // ---- joinTesterVoiceChannel ----
  describe('joinTesterVoiceChannel', () => {
    it('joins a voice channel', async () => {
      const channel = {
        id: 'vc-1',
        guild: { id: 'guild-1' },
        isVoiceBased: () => true,
      } as any;

      await joinTesterVoiceChannel(channel);

      const { joinVoiceChannel, entersState, createAudioPlayer } = require('@discordjs/voice');
      expect(joinVoiceChannel).toHaveBeenCalled();
      expect(entersState).toHaveBeenCalled();
      expect(createAudioPlayer).toHaveBeenCalled();
      expect(mockVoiceConnectionSubscribe).toHaveBeenCalledWith(mockAudioPlayer);
    });

    it('destroys existing connection before joining new one', async () => {
      const channel = {
        id: 'vc-2',
        guild: { id: 'guild-1' },
        isVoiceBased: () => true,
      } as any;

      // First join
      await joinTesterVoiceChannel(channel);
      mockVoiceConnectionDestroy.mockClear();

      // Second join should destroy the first connection
      await joinTesterVoiceChannel(channel);
      expect(mockVoiceConnectionDestroy).toHaveBeenCalled();
    });

    it('throws if channel is not voice-based', async () => {
      mockChannelsFetch.mockResolvedValueOnce({
        isVoiceBased: () => false,
      });

      const channel = { id: 'text-ch', guild: { id: 'g1' } } as any;
      await expect(joinTesterVoiceChannel(channel)).rejects.toThrow('could not resolve');
    });

    it('throws if channel fetch returns null', async () => {
      mockChannelsFetch.mockResolvedValueOnce(null);

      const channel = { id: 'null-ch', guild: { id: 'g1' } } as any;
      await expect(joinTesterVoiceChannel(channel)).rejects.toThrow('could not resolve');
    });
  });

  // ---- speakAsTesterInVoice ----
  describe('speakAsTesterInVoice', () => {
    beforeEach(async () => {
      // Ensure connected
      const channel = { id: 'vc-1', guild: { id: 'g1' }, isVoiceBased: () => true } as any;
      await joinTesterVoiceChannel(channel);
    });

    it('plays TTS audio and resolves on idle', async () => {
      const speakPromise = speakAsTesterInVoice('Hello world');

      // Wait for event listeners to be set up
      await new Promise((r) => setTimeout(r, 10));

      // Simulate playing then idle
      mockAudioPlayer.emit(AudioPlayerStatus.Playing);
      mockAudioPlayer.emit(AudioPlayerStatus.Idle);

      await speakPromise;
      expect(mockPlayerPlay).toHaveBeenCalled();
    });

    it('rejects on player error', async () => {
      const speakPromise = speakAsTesterInVoice('Hello');

      await new Promise((r) => setTimeout(r, 10));
      mockAudioPlayer.emit('error', new Error('playback error'));

      await expect(speakPromise).rejects.toThrow('playback error');
    });

    it('throws if empty text', async () => {
      await expect(speakAsTesterInVoice('')).rejects.toThrow('empty');
    });

    it('throws if only whitespace', async () => {
      await expect(speakAsTesterInVoice('   ')).rejects.toThrow('empty');
    });
  });

  // ---- speakAsTesterInVoice when not connected ----
  describe('speakAsTesterInVoice when disconnected', () => {
    it('throws if not connected to voice', async () => {
      leaveTesterVoiceChannel();
      await expect(speakAsTesterInVoice('Test')).rejects.toThrow('not connected');
    });
  });

  // ---- leaveTesterVoiceChannel ----
  describe('leaveTesterVoiceChannel', () => {
    it('destroys connection and stops player', async () => {
      const channel = { id: 'vc-1', guild: { id: 'g1' }, isVoiceBased: () => true } as any;
      await joinTesterVoiceChannel(channel);

      leaveTesterVoiceChannel();
      expect(mockPlayerStop).toHaveBeenCalledWith(true);
      expect(mockVoiceConnectionDestroy).toHaveBeenCalled();
    });

    it('does nothing when not connected', () => {
      leaveTesterVoiceChannel();
      // Should not throw
    });
  });

  // ---- getTesterVoiceConnection ----
  describe('getTesterVoiceConnection', () => {
    it('returns null when not connected', () => {
      leaveTesterVoiceChannel();
      expect(getTesterVoiceConnection()).toBeNull();
    });

    it('returns connection when connected', async () => {
      const channel = { id: 'vc-1', guild: { id: 'g1' }, isVoiceBased: () => true } as any;
      await joinTesterVoiceChannel(channel);
      expect(getTesterVoiceConnection()).toBe(mockVoiceConnection);
    });
  });

  // ---- stopTesterVCPlayback ----
  describe('stopTesterVCPlayback', () => {
    it('stops audio player', async () => {
      const channel = { id: 'vc-1', guild: { id: 'g1' }, isVoiceBased: () => true } as any;
      await joinTesterVoiceChannel(channel);
      stopTesterVCPlayback();
      expect(mockPlayerStop).toHaveBeenCalledWith(true);
    });

    it('does nothing when no player', () => {
      leaveTesterVoiceChannel();
      stopTesterVCPlayback();
      // Should not throw
    });
  });

  // ---- speakInTesterVC ----
  describe('speakInTesterVC', () => {
    it('throws when not connected', async () => {
      leaveTesterVoiceChannel();
      await expect(speakInTesterVC(Buffer.from('audio'))).rejects.toThrow('not connected');
    });

    it('throws on empty buffer', async () => {
      const channel = { id: 'vc-1', guild: { id: 'g1' }, isVoiceBased: () => true } as any;
      await joinTesterVoiceChannel(channel);
      await expect(speakInTesterVC(Buffer.alloc(0))).rejects.toThrow('empty audio buffer');
    });

    it('plays audio and resolves on idle', async () => {
      const channel = { id: 'vc-1', guild: { id: 'g1' }, isVoiceBased: () => true } as any;
      await joinTesterVoiceChannel(channel);

      const promise = speakInTesterVC(Buffer.from('audio-data'));
      await new Promise((r) => setTimeout(r, 10));
      mockAudioPlayer.emit(AudioPlayerStatus.Playing);
      mockAudioPlayer.emit(AudioPlayerStatus.Idle);

      await promise;
      expect(mockPlayerPlay).toHaveBeenCalled();
    });
  });

  // ---- speakInTesterVCWithOptions ----
  describe('speakInTesterVCWithOptions', () => {
    beforeEach(async () => {
      const channel = { id: 'vc-1', guild: { id: 'g1' }, isVoiceBased: () => true } as any;
      await joinTesterVoiceChannel(channel);
    });

    it('calls onPlaybackStart callback', async () => {
      const onStart = jest.fn();
      const promise = speakInTesterVCWithOptions(Buffer.from('audio'), { onPlaybackStart: onStart });

      await new Promise((r) => setTimeout(r, 10));
      mockAudioPlayer.emit(AudioPlayerStatus.Playing);
      expect(onStart).toHaveBeenCalled();

      mockAudioPlayer.emit(AudioPlayerStatus.Idle);
      await promise;
    });

    it('aborts via AbortSignal', async () => {
      const controller = new AbortController();
      const promise = speakInTesterVCWithOptions(Buffer.from('audio'), { signal: controller.signal });

      await new Promise((r) => setTimeout(r, 10));
      controller.abort();

      // Emit idle to complete the promise
      mockAudioPlayer.emit(AudioPlayerStatus.Idle);

      await expect(promise).rejects.toThrow('aborted');
    });

    it('aborts immediately if signal already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const promise = speakInTesterVCWithOptions(Buffer.from('audio'), { signal: controller.signal });
      await new Promise((r) => setTimeout(r, 10));
      mockAudioPlayer.emit(AudioPlayerStatus.Idle);

      await expect(promise).rejects.toThrow('aborted');
    });

    it('rejects on player error', async () => {
      const promise = speakInTesterVCWithOptions(Buffer.from('audio'));
      await new Promise((r) => setTimeout(r, 10));
      mockAudioPlayer.emit('error', new Error('stream error'));

      await expect(promise).rejects.toThrow('stream error');
    });

    it('throws when not connected', async () => {
      leaveTesterVoiceChannel();
      await expect(speakInTesterVCWithOptions(Buffer.from('audio'))).rejects.toThrow('not connected');
    });

    it('throws on empty buffer', async () => {
      const ch = { id: 'vc-1', guild: { id: 'g1' }, isVoiceBased: () => true } as any;
      await joinTesterVoiceChannel(ch);
      await expect(speakInTesterVCWithOptions(Buffer.alloc(0))).rejects.toThrow('empty audio buffer');
    });
  });

  // ---- setTesterNickname ----
  describe('setTesterNickname', () => {
    it('sets nickname and returns previous', async () => {
      mockFetchMe.mockResolvedValueOnce({ nickname: 'OldNick', setNickname: mockSetNickname });

      const prev = await setTesterNickname('guild-1', 'NewNick', 'test reason');
      expect(prev).toBe('OldNick');
      expect(mockSetNickname).toHaveBeenCalledWith('NewNick', 'test reason');
    });

    it('returns null when no previous nickname', async () => {
      mockFetchMe.mockResolvedValueOnce({ nickname: null, setNickname: mockSetNickname });

      const prev = await setTesterNickname('guild-1', 'TestNick');
      expect(prev).toBeNull();
    });

    it('handles setNickname failure gracefully', async () => {
      mockSetNickname.mockRejectedValueOnce(new Error('Missing permissions'));
      mockFetchMe.mockResolvedValueOnce({ nickname: 'Old', setNickname: mockSetNickname });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const prev = await setTesterNickname('guild-1', 'Bad');
      expect(prev).toBe('Old');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Missing permissions'));
      warnSpy.mockRestore();
    });
  });

  // ---- restoreTesterNickname ----
  describe('restoreTesterNickname', () => {
    it('restores previous nickname', async () => {
      await restoreTesterNickname('guild-1', 'OldNick');
      expect(mockSetNickname).toHaveBeenCalledWith('OldNick', 'ASAP voice call ended');
    });

    it('restores default nickname when previous is null', async () => {
      process.env.ASAPTESTER_DEFAULT_NICKNAME = 'TestBot';
      await restoreTesterNickname('guild-1', null);
      expect(mockSetNickname).toHaveBeenCalledWith('TestBot', 'ASAP voice call ended');
    });

    it('uses ASAPTester as default nickname if env not set', async () => {
      delete process.env.ASAPTESTER_DEFAULT_NICKNAME;
      await restoreTesterNickname('guild-1', null);
      expect(mockSetNickname).toHaveBeenCalledWith('ASAPTester', 'ASAP voice call ended');
    });

    it('handles failure gracefully', async () => {
      mockSetNickname.mockRejectedValueOnce(new Error('No perms'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await restoreTesterNickname('guild-1', 'Test');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No perms'));
      warnSpy.mockRestore();
    });
  });

  // ---- setTesterAvatar ----
  describe('setTesterAvatar', () => {
    it('sets avatar from URL', async () => {
      const fakeBuf = Buffer.from('png-data');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeBuf),
      }) as any;

      await setTesterAvatar('https://example.com/avatar.png');
      expect(mockSetAvatar).toHaveBeenCalled();
    });

    it('handles fetch failure gracefully', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any;

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await setTesterAvatar('https://example.com/bad.png');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Avatar fetch failed'));
      warnSpy.mockRestore();
    });
  });

  // ---- restoreTesterAvatar ----
  describe('restoreTesterAvatar', () => {
    it('does nothing when no default avatar URL', async () => {
      delete process.env.ASAPTESTER_DEFAULT_AVATAR_URL;
      await restoreTesterAvatar();
      // setAvatar should not be called
    });

    it('restores default avatar from URL', async () => {
      process.env.ASAPTESTER_DEFAULT_AVATAR_URL = 'https://example.com/default.png';
      const fakeBuf = Buffer.from('default-png');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeBuf),
      }) as any;

      await restoreTesterAvatar();
      expect(mockSetAvatar).toHaveBeenCalled();
    });

    it('handles fetch failure gracefully', async () => {
      process.env.ASAPTESTER_DEFAULT_AVATAR_URL = 'https://example.com/bad.png';
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any;

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await restoreTesterAvatar();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Default avatar fetch failed'));
      warnSpy.mockRestore();
    });
  });

  // ---- disabled client ----
  describe('disabled client', () => {
    it('throws when ASAPTESTER_VOICE_CLIENT_ENABLED=false', async () => {
      process.env.ASAPTESTER_VOICE_CLIENT_ENABLED = 'false';

      // Need to re-import to get fresh module state
      jest.resetModules();
      jest.doMock('@discordjs/voice', () => ({
        entersState: jest.fn(),
        joinVoiceChannel: jest.fn(),
        VoiceConnectionStatus: { Ready: 'ready' },
        createAudioPlayer: jest.fn(),
        createAudioResource: jest.fn(),
        AudioPlayerStatus: { Playing: 'playing', Idle: 'idle' },
        StreamType: { Arbitrary: 'arbitrary' },
      }));
      jest.doMock('discord.js', () => ({
        Client: MockClient,
        GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 },
      }));
      jest.doMock('../../../discord/voice/tts', () => ({
        textToSpeech: jest.fn(),
      }));
      jest.doMock('../../../utils/errors', () => ({
        errMsg: (e: any) => (e instanceof Error ? e.message : String(e)),
      }));

      const { joinTesterVoiceChannel: join } = await import('../../../discord/voice/testerClient');
      const ch = { id: 'vc-1', guild: { id: 'g1' } } as any;
      await expect(join(ch)).rejects.toThrow('disabled');
    });
  });

  // ---- missing token ----
  describe('missing token', () => {
    it('throws when DISCORD_TEST_BOT_TOKEN is missing', async () => {
      delete process.env.DISCORD_TEST_BOT_TOKEN;

      jest.resetModules();
      jest.doMock('@discordjs/voice', () => ({
        entersState: jest.fn(),
        joinVoiceChannel: jest.fn(),
        VoiceConnectionStatus: { Ready: 'ready' },
        createAudioPlayer: jest.fn(),
        createAudioResource: jest.fn(),
        AudioPlayerStatus: { Playing: 'playing', Idle: 'idle' },
        StreamType: { Arbitrary: 'arbitrary' },
      }));
      jest.doMock('discord.js', () => ({
        Client: MockClient,
        GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 },
      }));
      jest.doMock('../../../discord/voice/tts', () => ({
        textToSpeech: jest.fn(),
      }));
      jest.doMock('../../../utils/errors', () => ({
        errMsg: (e: any) => (e instanceof Error ? e.message : String(e)),
      }));

      const { joinTesterVoiceChannel: join } = await import('../../../discord/voice/testerClient');
      const ch = { id: 'vc-1', guild: { id: 'g1' } } as any;
      await expect(join(ch)).rejects.toThrow('DISCORD_TEST_BOT_TOKEN');
    });
  });
});
