import { spawn } from 'child_process';
import { PassThrough, Readable } from 'stream';

import {
  entersState,
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  AudioPlayer,
  AudioPlayerStatus,
  StreamType,
} from '@discordjs/voice';
import { Client, GatewayIntentBits, Guild, VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';

import { textToSpeech } from './tts';
import { errMsg } from '../../utils/errors';

let testerClient: Client | null = null;
let testerReady = false;
let testerReadyPromise: Promise<void> | null = null;
let testerVoiceConnection: VoiceConnection | null = null;
let testerAudioPlayer: AudioPlayer | null = null;

function isEnabled(): boolean {
  return String(process.env.ASAPTESTER_VOICE_CLIENT_ENABLED || 'true').toLowerCase() !== 'false';
}

function getTesterToken(): string {
  return String(process.env.DISCORD_TEST_BOT_TOKEN || '').trim();
}

async function ensureTesterClient(): Promise<Client> {
  if (!isEnabled()) {
    throw new Error('ASAPTester voice client is disabled (ASAPTESTER_VOICE_CLIENT_ENABLED=false).');
  }

  const token = getTesterToken();
  if (!token) {
    throw new Error('DISCORD_TEST_BOT_TOKEN is missing.');
  }

  if (testerClient && testerReady) return testerClient;

  if (!testerClient) {
    testerClient = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    testerReadyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ASAPTester login timed out after 15s.')), 15000);
      testerClient?.once('ready', () => {
        clearTimeout(timeout);
        testerReady = true;
        resolve();
      });
      testerClient?.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    await testerClient.login(token);
  }

  if (testerReadyPromise) {
    await testerReadyPromise;
  }

  if (!testerClient) {
    throw new Error('Failed to initialize ASAPTester Discord client.');
  }

  return testerClient;
}

export async function joinTesterVoiceChannel(channel: VoiceBasedChannel): Promise<void> {
  const client = await ensureTesterClient();

  const guild = await client.guilds.fetch(channel.guild.id);
  const testerChannel = await guild.channels.fetch(channel.id);
  if (!testerChannel || !('isVoiceBased' in testerChannel) || !testerChannel.isVoiceBased()) {
    throw new Error('ASAPTester could not resolve the target voice channel.');
  }

  if (testerVoiceConnection) {
    try {
      testerVoiceConnection.destroy();
    } catch {
    } finally {
      testerVoiceConnection = null;
    }
  }

  const connection = joinVoiceChannel({
    channelId: testerChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 10000);
  testerAudioPlayer = createAudioPlayer();
  connection.subscribe(testerAudioPlayer);
  testerVoiceConnection = connection;
}

export async function speakAsTesterInVoice(text: string, language?: string): Promise<void> {
  if (!testerVoiceConnection || !testerAudioPlayer) {
    throw new Error('ASAPTester is not connected to voice.');
  }

  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Tester speech text is empty.');
  }

  const testerVoice = process.env.ASAPTESTER_VOICE_NAME || 'Achernar';
  const audio = await textToSpeech(trimmed, testerVoice, language);
  const resource = createAudioResource(Readable.from(audio), { inputType: StreamType.Arbitrary });

  await new Promise<void>((resolve, reject) => {
    const player = testerAudioPlayer;
    if (!player) {
      reject(new Error('Tester audio player is unavailable.'));
      return;
    }

    let started = false;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(started ? 'Tester playback timed out.' : 'Tester playback did not start in time.'));
    }, 20000);

    const cleanup = () => {
      clearTimeout(timeout);
      player.off(AudioPlayerStatus.Playing, onPlaying);
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
    };

    const onPlaying = () => {
      started = true;
    };
    const onIdle = () => {
      if (!started) return;
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    player.on(AudioPlayerStatus.Playing, onPlaying);
    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onError);
    player.play(resource);
  });
}

export function leaveTesterVoiceChannel(): void {
  if (testerAudioPlayer) {
    try {
      testerAudioPlayer.stop(true);
    } catch {
    } finally {
      testerAudioPlayer = null;
    }
  }
  if (!testerVoiceConnection) return;
  try {
    testerVoiceConnection.destroy();
  } catch {
  } finally {
    testerVoiceConnection = null;
  }
}

/** Get the current tester voice connection (for listening/barge-in detection). */
export function getTesterVoiceConnection(): VoiceConnection | null {
  return testerVoiceConnection;
}

/** Stop the current tester playback immediately. */
export function stopTesterVCPlayback(): void {
  if (!testerAudioPlayer) return;
  try {
    testerAudioPlayer.stop(true);
  } catch {
  }
}

/** Play raw audio through the tester voice connection. */
export async function speakInTesterVC(audioBuffer: Buffer): Promise<void> {
  return speakInTesterVCWithOptions(audioBuffer);
}

/** Play raw audio through the tester voice connection with abort/callback support. */
export async function speakInTesterVCWithOptions(
  audioBuffer: Buffer,
  options?: { signal?: AbortSignal; onPlaybackStart?: () => void }
): Promise<void> {
  if (!testerVoiceConnection || !testerAudioPlayer) {
    throw new Error('ASAPTester is not connected to voice.');
  }
  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error('TTS returned empty audio buffer');
  }

  const stream = Readable.from(audioBuffer);
  const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });

  return new Promise<void>((resolve, reject) => {
    const player = testerAudioPlayer;
    if (!player) {
      reject(new Error('Tester audio player not available'));
      return;
    }

    let sawPlaying = false;
    let aborted = false;

    const onPlaying = () => {
      sawPlaying = true;
      options?.onPlaybackStart?.();
    };
    const onIdle = () => {
      cleanup();
      if (aborted) {
        reject(new Error('Playback aborted'));
      } else {
        resolve();
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(sawPlaying ? 'Tester playback timed out' : 'Tester playback did not start in time'));
    }, 20_000);

    const cleanup = () => {
      player.off(AudioPlayerStatus.Playing, onPlaying);
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
      options?.signal?.removeEventListener('abort', onAbort);
      clearTimeout(timeout);
    };

    const onAbort = () => {
      aborted = true;
      stopTesterVCPlayback();
    };

    player.on(AudioPlayerStatus.Playing, onPlaying);
    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onError);
    if (options?.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    player.play(resource);
  });
}

/**
 * Set the tester bot's nickname in the given guild.
 * Returns the previous nickname.
 */
export async function setTesterNickname(
  guildId: string,
  nickname: string,
  reason?: string
): Promise<string | null> {
  const client = await ensureTesterClient();
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetchMe();
  const previous = member.nickname ?? null;
  try {
    await member.setNickname(nickname, reason || 'ASAP voice call');
  } catch (err) {
    console.warn(`Failed to set tester nickname to "${nickname}": ${errMsg(err)}`);
  }
  return previous;
}

/**
 * Restore the tester bot's nickname in the given guild.
 */
export async function restoreTesterNickname(
  guildId: string,
  previousNickname: string | null
): Promise<void> {
  const client = await ensureTesterClient();
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetchMe();
  const defaultNick = String(process.env.ASAPTESTER_DEFAULT_NICKNAME || 'ASAPTester').trim() || 'ASAPTester';
  const desired = previousNickname ?? defaultNick;
  try {
    await member.setNickname(desired, 'ASAP voice call ended');
  } catch (err) {
    console.warn(`Failed to restore tester nickname to "${desired}": ${errMsg(err)}`);
  }
}

/**
 * Set the tester bot's global avatar from a URL.
 * Rate-limited by Discord (2 changes per 10 min) — fails gracefully.
 */
export async function setTesterAvatar(avatarUrl: string): Promise<void> {
  const client = await ensureTesterClient();
  try {
    const resp = await fetch(avatarUrl);
    if (!resp.ok) throw new Error(`Avatar fetch failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    await client.user!.setAvatar(buf);
  } catch (err) {
    console.warn(`Failed to set tester avatar: ${errMsg(err)}`);
  }
}

/**
 * Restore the tester bot's default avatar.
 * If ASAPTESTER_DEFAULT_AVATAR_URL is set, applies that; otherwise resets to Discord default.
 */
export async function restoreTesterAvatar(): Promise<void> {
  const defaultUrl = String(process.env.ASAPTESTER_DEFAULT_AVATAR_URL || '').trim();
  if (!defaultUrl) return; // No default configured — leave as-is to avoid rate limit waste
  const client = await ensureTesterClient();
  try {
    const resp = await fetch(defaultUrl);
    if (!resp.ok) throw new Error(`Default avatar fetch failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    await client.user!.setAvatar(buf);
  } catch (err) {
    console.warn(`Failed to restore tester avatar: ${errMsg(err)}`);
  }
}


/**
 * Streaming PCM player for the Convai voice path.
 *
 * Convai sends raw 16-bit signed-LE PCM at 16 kHz mono in many small chunks
 * across one agent turn. The previous WAV-wrap-then-play approach worked in
 * theory but ffmpeg auto-detection via StreamType.Arbitrary was reading the
 * header inconsistently — playback "started" (so onPlaybackStart fired) but
 * silence came out the other end.
 *
 * This player skips auto-detect entirely:
 *   1. Caller opens a stream, gets `write(chunk)` and `end()`.
 *   2. Each PCM chunk is piped to ffmpeg with explicit `-f s16le -ar 16000
 *      -ac 1` input args, transcoded to 48 kHz stereo s16le, fed to the
 *      Discord audio player as StreamType.Raw.
 *   3. Audio plays as soon as the first chunk lands — no per-turn buffering,
 *      so the round-trip latency drops by however long the inactivity timer
 *      was (now 0).
 *
 * Returns a handle the caller can write chunks to and end when the agent
 * turn finishes (or aborts on barge-in).
 */
export interface PcmStreamHandle {
  write(chunk: Buffer): void;
  end(): void;
  abort(): void;
  readonly playbackStarted: Promise<void>;
}

export function streamRawPcmToTesterVC(
  options: { sampleRate?: number; channels?: number; signal?: AbortSignal } = {},
): PcmStreamHandle {
  if (!testerVoiceConnection || !testerAudioPlayer) {
    throw new Error("ASAPTester is not connected to voice (cannot stream PCM).");
  }
  const sampleRate = options.sampleRate || 16000;
  const channels = options.channels || 1;

  const input = new PassThrough();
  // We CANNOT use prism.FFmpeg here — it prepends `-i -` to the args so
  // input format hints (`-f s16le -ar 16000 -ac 1`) end up AFTER the
  // input declaration where ffmpeg treats them as OUTPUT options. Result:
  // ffmpeg auto-detects raw PCM as "Invalid data" and emits zero bytes.
  // That's the silent-playback bug Jordan reported on 2026-04-27.
  // Spawn ffmpeg directly so we control argument order.
  const proc = spawn('ffmpeg', [
    '-analyzeduration', '0',
    '-loglevel', 'error',
    '-f', 's16le',
    '-ar', String(sampleRate),
    '-ac', String(channels),
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  proc.stderr.on('data', (chunk: Buffer) => {
    const txt = chunk.toString().trim();
    if (txt) console.warn(`[pcm-stream] ffmpeg stderr: ${txt.slice(0, 200)}`);
  });
  proc.on('error', (err) => console.warn('[pcm-stream] ffmpeg spawn error:', errMsg(err)));

  input.pipe(proc.stdin);

  // Lead-in silence padding. Discord's audio player + ffmpeg analysis +
  // opus encoder all consume a few hundred ms after `player.play()` is
  // called before the audible output actually streams to the channel.
  // Without this, the first ~150 ms of every Convai turn arrives mid-
  // syllable (Jordan's 2026-04-27 "abrupt half-way through the first
  // word" report). Tunable via VOICE_LEAD_IN_SILENCE_MS.
  const leadMs = Math.max(0, parseInt(process.env.VOICE_LEAD_IN_SILENCE_MS || '220', 10));
  if (leadMs > 0) {
    const silenceSamples = Math.floor((sampleRate * leadMs) / 1000);
    const silenceBytes = silenceSamples * channels * 2; // s16le
    if (silenceBytes > 0) input.write(Buffer.alloc(silenceBytes));
  }

  const resource = createAudioResource(proc.stdout, {
    inputType: StreamType.Raw,
  });

  let playingResolve: () => void = () => {};
  let playingReject: (err: Error) => void = () => {};
  const playbackStarted = new Promise<void>((res, rej) => {
    playingResolve = res;
    playingReject = rej;
  });

  const player = testerAudioPlayer;
  if (!player) throw new Error("Tester audio player not available");

  let started = false;
  let ended = false;
  const onPlaying = () => {
    if (started) return;
    started = true;
    playingResolve();
  };
  const onError = (err: Error) => {
    console.warn("[pcm-stream] player error:", errMsg(err));
    playingReject(err);
  };
  player.on(AudioPlayerStatus.Playing, onPlaying);
  player.on("error", onError);

  if (options.signal) {
    options.signal.addEventListener(
      "abort",
      () => {
        if (!ended) {
          ended = true;
          input.end();
          try { proc.kill("SIGTERM"); } catch { /* ignore */ }
          stopTesterVCPlayback();
        }
      },
      { once: true },
    );
  }

  player.play(resource);

  return {
    write(chunk: Buffer) {
      if (ended) return;
      input.write(chunk);
    },
    end() {
      if (ended) return;
      ended = true;
      input.end();
    },
    abort() {
      if (ended) return;
      ended = true;
      try { input.end(); } catch { /* ignore */ }
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      stopTesterVCPlayback();
    },
    playbackStarted,
  };
}
