import { TextChannel, VoiceChannel, GuildMember } from 'discord.js';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { getAgent, AgentId } from '../agents';
import { agentRespond, ConversationMessage, summarizeCall, ReusableAgentChatSession } from '../claude';
import { textToSpeech } from '../voice/tts';
import { primeElevenLabsVoiceCache } from '../voice/elevenlabs';
import { joinVC, leaveVC, speakInVC, speakInVCWithOptions, stopVCPlayback, listenToAllMembersSmart, getConnection, VoiceTranscription } from '../voice/connection';
import { joinTesterVoiceChannel, leaveTesterVoiceChannel } from '../voice/testerClient';
import { appendToMemory, getMemoryContext } from '../memory';
import { documentToChannel } from './documentation';
import { isGeminiOverLimit } from '../usage';
import { isDeepgramAvailable } from '../voice/deepgram';
import { postDiagnostic, mirrorAgentResponse, mirrorVoiceTranscript } from '../services/diagnosticsWebhook';
import { getWebhook } from '../services/webhooks';
import { recordVoiceCallStart, recordVoiceCallEnd } from '../metrics';
import { postOpsLine } from '../services/opsFeed';

/** Only Riley (EA) speaks in voice calls */
const VOICE_SPEAKERS = new Set(['executive-assistant']);

/** Heartbeat interval to detect stale connections (every 2 minutes) */
const HEARTBEAT_INTERVAL = 20 * 1000;
const VOICE_DISCONNECT_GRACE_MS = 45 * 1000;
/** Max conversation history in a call */
const MAX_CALL_HISTORY = 40;
const VOICE_PREFLIGHT_TIMEOUT_MS = parseInt(process.env.VOICE_PREFLIGHT_TIMEOUT_MS || '15000', 10);
const VOICE_STARTUP_SELFTEST_ENABLED = String(process.env.VOICE_STARTUP_SELFTEST_ENABLED || 'false').toLowerCase() === 'true';
const VOICE_MAX_TOKENS_RILEY = parseInt(process.env.VOICE_MAX_TOKENS_RILEY || '220', 10);
const VOICE_STREAM_PARTIAL_MIN_CHARS = parseInt(process.env.VOICE_STREAM_PARTIAL_MIN_CHARS || '16', 10);
const VOICE_STREAM_FORCE_CHARS = parseInt(process.env.VOICE_STREAM_FORCE_CHARS || '60', 10);
const VOICE_INTERRUPT_MIN_OUTPUT_ACTIVE_MS = parseInt(process.env.VOICE_INTERRUPT_MIN_OUTPUT_ACTIVE_MS || '700', 10);
const VOICE_MIN_INPUT_CHARS = parseInt(process.env.VOICE_MIN_INPUT_CHARS || '3', 10);
const VOICE_DUPLICATE_WINDOW_MS = parseInt(process.env.VOICE_DUPLICATE_WINDOW_MS || '1200', 10);
const VOICE_STAGE_LOGS_ENABLED = process.env.VOICE_STAGE_LOGS_ENABLED !== 'false';
const VOICE_HISTORY_MAX_MESSAGES = parseInt(process.env.VOICE_HISTORY_MAX_MESSAGES || '10', 10);
const VOICE_MEMORY_MAX_MESSAGES = parseInt(process.env.VOICE_MEMORY_MAX_MESSAGES || '8', 10);
const VOICE_CONTEXT_MAX_CHARS = parseInt(process.env.VOICE_CONTEXT_MAX_CHARS || '3800', 10);
const VOICE_CONTEXT_MESSAGE_MAX_CHARS = parseInt(process.env.VOICE_CONTEXT_MESSAGE_MAX_CHARS || '550', 10);
const VOICE_CONTEXT_SUMMARY_MAX_CHARS = parseInt(process.env.VOICE_CONTEXT_SUMMARY_MAX_CHARS || '900', 10);
const VOICE_FILLER_ONLY_RE = /^(?:uh+|um+|hmm+|mm+|ah+|er+|uh huh|huh|hmm okay|okay|ok|yeah|yep|nah|nope)[.!?\s]*$/i;
const RILEY_WARM_PHRASES = ['One moment.', 'Let me check.', 'I am on it.', 'Here is what I found.', 'Done.'];
const VOICE_TURN_WATCHDOG_MS = parseInt(process.env.VOICE_TURN_WATCHDOG_MS || '20000', 10);
const DEFAULT_TESTER_BOT_ID = '1487426371209789450';
const RUNTIME_INSTANCE_TAG = (process.env.RUNTIME_INSTANCE_TAG || process.env.HOSTNAME || `pid-${process.pid}`).slice(0, 80);

function isTesterBotId(userId: string): boolean {
  const configured = String(process.env.DISCORD_TESTER_BOT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const allowed = new Set([DEFAULT_TESTER_BOT_ID, ...configured]);
  return allowed.has(userId);
}

let voiceErrorChannel: TextChannel | null = null;

export function setVoiceErrorChannel(channel: TextChannel | null): void {
  voiceErrorChannel = channel;
}

async function postVoiceStageLog(stage: string, detail: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
  if (!VOICE_STAGE_LOGS_ENABLED || !voiceErrorChannel) return;
  const action = level === 'error'
    ? 'restart voice pipeline and inspect credentials'
    : level === 'warn'
      ? 'check voice stage health if repeated'
      : 'none';
  await postOpsLine(voiceErrorChannel, {
    actor: 'system',
    scope: `voice:${stage}`,
    metric: 'voice-stage',
    delta: `instance=${RUNTIME_INSTANCE_TAG} ${detail}`,
    action,
    severity: level,
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((value) => resolve(value))
      .catch(reject)
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  });
}

function isVoiceInputAvailable(): { ok: boolean; reason?: string } {
  if (isDeepgramAvailable()) return { ok: true };
  if (!process.env.GEMINI_API_KEY) {
    return { ok: false, reason: 'Deepgram is not configured and Gemini API key is missing.' };
  }
  if (isGeminiOverLimit()) {
    return { ok: false, reason: 'Deepgram is not configured and Gemini transcription quota is exhausted.' };
  }
  return { ok: true };
}

/**
 * Split text into sentences for pipelined TTS playback.
 * Sentence boundaries: . ! ? followed by space/end, or newlines.
 */
function splitSentences(text: string): string[] {
  const placeholder = '\x00';
  const protected_ = text
    .replace(/https?:\/\/[^\s]+/g, (m) => m.replace(/\./g, placeholder))
    .replace(/\b(Mr|Mrs|Ms|Dr|Jr|Sr|St|vs|etc|e\.g|i\.e)\./gi, (m) => m.replace('.', placeholder));
  const raw = protected_.match(/[^.!?\n]+[.!?]+[\s]?|[^.!?\n]+$/g) || [text];
  return raw.map(s => s.replace(new RegExp(placeholder, 'g'), '.').trim()).filter(s => s.length > 0);
}

/**
 * Pipeline TTS + playback: while sentence N plays, sentence N+1's TTS generates.
 * Falls back to full-buffer TTS if only one sentence.
 */
async function speakPipelined(
  text: string,
  voice: string,
  signal?: AbortSignal,
  language?: string,
  onPlaybackStart?: () => void
): Promise<void> {
  const sentences = splitSentences(text.slice(0, 500));
  if (sentences.length === 0) return;

  if (sentences.length === 1) {
    if (signal?.aborted) return;
    const audio = await textToSpeech(sentences[0], voice, language);
    if (signal?.aborted) return;
    if (activeSession?.active && audio) await speakInVCWithOptions(audio, { signal, onPlaybackStart });
    return;
  }

  let nextTts: Promise<Buffer> = textToSpeech(sentences[0], voice, language);

  for (let i = 0; i < sentences.length; i++) {
    if (signal?.aborted) break;
    const audio = await nextTts;
    if (!activeSession?.active || signal?.aborted) break;

    if (i + 1 < sentences.length) {
      nextTts = textToSpeech(sentences[i + 1], voice, language);
    }

    await speakInVCWithOptions(audio, { signal, onPlaybackStart });
  }
}

function findSpeechBoundaryIndex(text: string, start: number, force: boolean): number {
  if (start >= text.length) return start;
  const remaining = text.slice(start);

  let boundary = -1;
  const sentenceRe = /[.!?]+(?:\s+|$)|\n+/g;
  let match: RegExpExecArray | null;
  while ((match = sentenceRe.exec(remaining)) !== null) {
    boundary = start + match.index + match[0].length;
  }

  if (force && boundary < 0 && remaining.length >= VOICE_STREAM_FORCE_CHARS) {
    const softRe = /[,;:](?:\s+|$)/g;
    while ((match = softRe.exec(remaining)) !== null) {
      boundary = start + match.index + match[0].length;
    }
    if (boundary < 0) {
      const target = Math.min(text.length, start + VOICE_STREAM_FORCE_CHARS);
      const window = text.slice(start, target);
      const lastSpace = window.lastIndexOf(' ');
      boundary = lastSpace > 40 ? start + lastSpace + 1 : target;
    }
  }

  if (force && boundary < 0) {
    boundary = text.length;
  }

  return boundary < 0 ? start : Math.min(text.length, boundary);
}

function finalizeSpokenResponse(raw: string): string {
  const text = (raw || '').trim();
  if (!text) return text;

  const hasTerminalPunctuation = /[.!?)]\s*$/.test(text);
  if (hasTerminalPunctuation) return text;

  let lastBoundary = -1;
  const re = /[.!?]+(?:\s+|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    lastBoundary = match.index + match[0].length;
  }

  if (lastBoundary >= 20) {
    return text.slice(0, lastBoundary).trim();
  }

  return `${text}.`;
}

function trimVoiceText(content: string, maxChars: number): string {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  const head = Math.max(100, Math.floor(maxChars * 0.72));
  const tail = Math.max(60, maxChars - head - 24);
  return `${normalized.slice(0, head)} … ${normalized.slice(-tail)}`;
}

function compactVoiceHistoryForPrompt(history: ConversationMessage[]): ConversationMessage[] {
  if (!history.length) return history;
  const summaryMsg = history.find((m) => m.role === 'user' && m.content.startsWith('[Conversation Summary'));
  const next: ConversationMessage[] = [];
  let chars = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (summaryMsg && msg === summaryMsg) continue;
    const compact = trimVoiceText(msg.content, VOICE_CONTEXT_MESSAGE_MAX_CHARS);
    if (!compact) continue;
    if (next.length >= VOICE_HISTORY_MAX_MESSAGES || chars + compact.length > VOICE_CONTEXT_MAX_CHARS) {
      break;
    }
    next.push({ ...msg, content: compact });
    chars += compact.length;
  }

  next.reverse();
  if (summaryMsg) {
    const summary = trimVoiceText(summaryMsg.content, VOICE_CONTEXT_SUMMARY_MAX_CHARS);
    next.unshift({ ...summaryMsg, content: summary });
  }
  return next;
}

function createLiveSpeechStreamer(
  voice: string,
  signal: AbortSignal,
  isCurrentTurn: () => boolean,
  turnId: number,
  language?: string,
  onPlaybackStart?: () => void
): {
  onPartialText: (partialText: string) => Promise<void>;
  finalize: (finalText: string) => Promise<boolean>;
} {
  let spokenUntil = 0;
  let latestText = '';
  let speakQueue = Promise.resolve();
  let lastSpokenNormalized = '';
  let spokeAny = false;

  const normalizeSegment = (segment: string) =>
    segment.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s]/g, '').trim();

  const enqueue = (segment: string) => {
    const toSpeak = segment.trim();
    if (!toSpeak) return;
    const normalized = normalizeSegment(toSpeak);
    if (!normalized) return;
    if (lastSpokenNormalized.endsWith(normalized) || normalized.endsWith(lastSpokenNormalized)) return;
    lastSpokenNormalized = normalized;
    speakQueue = speakQueue
      .then(async () => {
        if (!isCurrentTurn() || signal.aborted) return;
        if (activeSession?.currentTurnId === turnId) {
          activeSession.outputActive = true;
          activeSession.outputStartedAt = Date.now();
        }
        spokeAny = true;
        await speakPipelined(toSpeak, voice, signal, language, onPlaybackStart);
      })
      .catch(() => {
      });
  };

  return {
    onPartialText: async (partialText: string) => {
      if (!isCurrentTurn() || signal.aborted) return;
      if (!partialText || partialText.length <= spokenUntil) return;
      latestText = partialText;

      const boundary = findSpeechBoundaryIndex(latestText, spokenUntil, false);
      if (boundary <= spokenUntil) return;

      const candidate = latestText.slice(spokenUntil, boundary).trim();
      if (candidate.length < VOICE_STREAM_PARTIAL_MIN_CHARS) return;
      spokenUntil = boundary;
      enqueue(candidate);
    },
    finalize: async (finalText: string) => {
      latestText = finalText || latestText;
      const boundary = findSpeechBoundaryIndex(latestText, spokenUntil, true);
      if (boundary > spokenUntil) {
        const tail = latestText.slice(spokenUntil, boundary).trim();
        spokenUntil = boundary;
        enqueue(tail);
      }

      await speakQueue;
      if (activeSession?.currentTurnId === turnId) {
        activeSession.outputActive = false;
        activeSession.outputStartedAt = 0;
      }
      return spokeAny;
    },
  };
}

export interface CallSession {
  active: boolean;
  startTime: Date;
  transcript: string[];
  conversationHistory: ConversationMessage[];
  rileyChatSession: ReusableAgentChatSession;
  unsubscribers: Array<() => void>;
  voiceChannel: VoiceChannel;
  groupchat: TextChannel;
  callLog: TextChannel;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  currentAbortController: AbortController | null;
  currentTurnId: number;
  outputActive: boolean;
  outputStartedAt: number;
  lastInterruptAt: number;
  disconnectedSince: number | null;
  lastInputFingerprint: string;
  lastInputAt: number;
  lastDuplicateNoticeAt: number;
  pendingBargeIn: boolean;
  turnStartedAt: number;
  rileyVoiceName: string;
}

let activeSession: CallSession | null = null;

function isAbortLikeError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { name?: string; code?: string; message?: string };
  const code = String(anyErr.code || '');
  const name = String(anyErr.name || '');
  const msg = String(anyErr.message || err).toLowerCase();
  return code === 'ABORT_ERR' || name === 'AbortError' || msg.includes('aborted') || msg.includes('playback aborted');
}

function interruptActiveVoiceTurn(reason: string): void {
  if (!activeSession?.active) return;
  const now = Date.now();
  if (now - activeSession.lastInterruptAt < 300) return;
  activeSession.lastInterruptAt = now;

  console.log(`[VOICE] Barge-in interrupt: ${reason}`);
  activeSession.currentAbortController?.abort();
  activeSession.currentAbortController = null;
  activeSession.outputActive = false;
  activeSession.outputStartedAt = 0;
  stopVCPlayback();
  postDiagnostic('Voice turn interrupted.', {
    level: 'info',
    source: 'callSession.interrupt',
    detail: reason,
  }).catch(() => {});
}

async function sendAsAgent(channel: TextChannel, content: string, agentId: AgentId = 'executive-assistant'): Promise<void> {
  const chunks = content.match(/.{1,1900}/gs) || [content];
  const agent = getAgent(agentId);
  if (agent) {
    try {
      const wh = await getWebhook(channel);
      for (const chunk of chunks) {
        await wh.send({
          content: chunk,
          username: `${agent.emoji} ${agent.name}`,
          avatarURL: agent.avatarUrl,
        });
      }
      return;
    } catch {
    }
  }
  for (const chunk of chunks) {
    await channel.send(chunk).catch(() => {});
  }
}

/**
 * Start a voice call session — bot joins VC and begins listening.
 */
export async function startCall(
  voiceChannel: VoiceChannel,
  groupchat: TextChannel,
  callLog: TextChannel,
  initiator: GuildMember
): Promise<void> {
  const callStartMs = Date.now();
  if (activeSession?.active) {
    await sendAsAgent(groupchat, '⚠️ A call is already in progress. Say `LEAVE` to end it first.');
    return;
  }

  const inputReady = isVoiceInputAvailable();
  if (!inputReady.ok) {
    await sendAsAgent(
      groupchat,
      `⚠️ I can't join voice yet because listening is unavailable: ${inputReady.reason} ` +
      `Configure Deepgram (preferred) or restore Gemini transcription before joining.`
    );
    return;
  }

  const joinStartMs = Date.now();
  const connection = await joinVC(voiceChannel);

  const testerVoiceId = process.env.ASAPTESTER_DISCORD_VOICE_ID || 'lsgXALPNLFUcQfT1dmP1';
  const isTesterInitiated = isTesterBotId(initiator.user.id);
  const forceTesterJoin = String(process.env.ASAPTESTER_FORCE_JOIN_VOICE || 'false').toLowerCase() === 'true';
  const shouldJoinTesterVoice = isTesterInitiated || forceTesterJoin;
  const riley = getAgent('executive-assistant' as AgentId);
  const selectedRileyVoice = isTesterInitiated ? testerVoiceId : (riley?.voice || 'Achernar');

  await postVoiceStageLog(
    'join_vc',
    `channel=${voiceChannel.name} join_ms=${Date.now() - joinStartMs} initiator=${initiator.displayName}`
  );
  recordVoiceCallStart();

  activeSession = {
    active: true,
    startTime: new Date(),
    transcript: [],
    conversationHistory: [],
    rileyChatSession: { chat: null, modelName: null },
    unsubscribers: [],
    voiceChannel,
    groupchat,
    callLog,
    heartbeatTimer: null,
    currentAbortController: null,
    currentTurnId: 0,
    outputActive: false,
    outputStartedAt: 0,
    lastInterruptAt: 0,
    disconnectedSince: null,
    lastInputFingerprint: '',
    lastInputAt: 0,
    lastDuplicateNoticeAt: 0,
    pendingBargeIn: false,
    turnStartedAt: 0,
    rileyVoiceName: selectedRileyVoice,
  };

  if (shouldJoinTesterVoice) {
    try {
      const testerJoinStartMs = Date.now();
      await joinTesterVoiceChannel(voiceChannel);
      await postVoiceStageLog('tester_join_vc', `channel=${voiceChannel.name} join_ms=${Date.now() - testerJoinStartMs}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      await postVoiceStageLog('tester_join_vc_failed', `channel=${voiceChannel.name} error=${msg}`, 'warn');
      await sendAsAgent(groupchat, `⚠️ ASAPTester could not join voice: ${msg}`);
    }
  }

  activeSession.heartbeatTimer = setInterval(() => {
    if (!activeSession?.active) return;
    try {
      const conn = getConnection();
      if (!conn || conn.state.status === VoiceConnectionStatus.Destroyed) {
        console.warn('Voice connection destroyed — ending call');
        void postVoiceStageLog('connection_destroyed', `channel=${voiceChannel.name}`, 'error');
        endCall().catch((err) => console.error('Heartbeat endCall error:', err instanceof Error ? err.message : 'Unknown'));
        return;
      }

      if (conn.state.status === VoiceConnectionStatus.Disconnected) {
        if (!activeSession.disconnectedSince) {
          activeSession.disconnectedSince = Date.now();
          console.warn('Voice connection temporarily disconnected — waiting for recovery');
          void postVoiceStageLog('connection_disconnected', `channel=${voiceChannel.name}`, 'warn');
          sendAsAgent(groupchat, '⚠️ Voice connection interrupted — reconnecting for up to 45 seconds.').catch(() => {});
          return;
        }

        const disconnectedForMs = Date.now() - activeSession.disconnectedSince;
        if (disconnectedForMs < VOICE_DISCONNECT_GRACE_MS) {
          return;
        }

        console.warn(`Voice disconnected for ${Math.round(disconnectedForMs / 1000)}s — ending call`);
        void postVoiceStageLog('connection_timeout', `disconnected_ms=${disconnectedForMs}`, 'error');
        endCall().catch((err) => console.error('Heartbeat endCall error:', err instanceof Error ? err.message : 'Unknown'));
        return;
      }

      if (activeSession.disconnectedSince) {
        sendAsAgent(groupchat, '✅ Voice reconnected.').catch(() => {});
        void postVoiceStageLog('connection_recovered', `channel=${voiceChannel.name}`);
      }
      activeSession.disconnectedSince = null;
    } catch (err) {
      console.error('Heartbeat error:', err instanceof Error ? err.message : 'Unknown');
    }
  }, HEARTBEAT_INTERVAL);

  const unsub = listenToAllMembersSmart(
    connection,
    voiceChannel,
    (transcription) => {
      if (!activeSession?.active) return;
      void handleVoiceInput(transcription).catch((err) => {
        if (!isAbortLikeError(err)) {
          console.error('Voice processing error:', err instanceof Error ? err.message : 'Unknown');
        }
      });
    },
    (member) => {
      void postVoiceStageLog('speech_detected', `user=${member.displayName}`);
    }
  );
  activeSession.unsubscribers.push(unsub);

  const onSpeakingStart = (userId: string) => {
    if (!activeSession?.active) return;
    const member = voiceChannel.members.get(userId);
    if (!member || member.user.bot) return;
    if (!activeSession.outputActive) return;
    if (activeSession.outputStartedAt > 0) {
      const activeForMs = Date.now() - activeSession.outputStartedAt;
      if (activeForMs < VOICE_INTERRUPT_MIN_OUTPUT_ACTIVE_MS) return;
    }
    interruptActiveVoiceTurn(`speech-start:${member.displayName}`);
  };
  connection.receiver.speaking.on('start', onSpeakingStart);
  activeSession.unsubscribers.push(() => {
    connection.receiver.speaking.off('start', onSpeakingStart);
  });

  activeSession.transcript.push(
    `[${new Date().toLocaleTimeString()}] Call started by ${initiator.displayName}`
  );

  const sttNote = isDeepgramAvailable()
    ? ''
    : '\n⚠️ Real-time STT is currently unavailable — using Gemini batch mode (~1-2s latency).';
  await sendAsAgent(
    groupchat,
    `✅ **Voice call started**\n` +
      `Initiated by **${initiator.displayName}**\n` +
      `${riley?.emoji || '📋'} **Riley** is on the line and listening now.\n\n` +
      `Speak in **${voiceChannel.name}**. Say "leave" or ask Riley to end the call.${sttNote}`
  );

  if (VOICE_STARTUP_SELFTEST_ENABLED) {
    const preflightStartMs = Date.now();
    void (async () => {
      try {
        const checkAudio = await withTimeout(
          textToSpeech(`Hello ${initiator.displayName}.`, selectedRileyVoice),
          VOICE_PREFLIGHT_TIMEOUT_MS,
          'TTS preflight'
        );
        if (!activeSession?.active) return;
        await withTimeout(speakInVC(checkAudio), VOICE_PREFLIGHT_TIMEOUT_MS, 'Voice playback preflight');
        await postDiagnostic('Voice self-test passed at call start.', {
          level: 'info',
          source: 'callSession.startCall',
          detail: `Channel=${voiceChannel.name} Initiator=${initiator.displayName}`,
        });
        await postVoiceStageLog('preflight_ok', `tts_playback_ms=${Date.now() - preflightStartMs}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error('Voice output self-test failed:', msg);
        await postVoiceStageLog('preflight_failed', `ms=${Date.now() - preflightStartMs} error=${msg}`, 'warn');
        await postDiagnostic('Voice self-test failed.', {
          level: 'warn',
          source: 'callSession.startCall',
          detail: msg,
        });
      }
    })();
  }

  await postVoiceStageLog('call_started', `channel=${voiceChannel.name} total_startup_ms=${Date.now() - callStartMs}`);
  primeElevenLabsVoiceCache(selectedRileyVoice, RILEY_WARM_PHRASES).catch(() => {});
}

/**
 * End the voice call session — disconnect, post summary.
 */
export async function endCall(): Promise<void> {
  if (!activeSession?.active) return;

  const session = activeSession;
  session.active = false;
  session.currentAbortController?.abort();
  session.currentAbortController = null;
  session.outputActive = false;
  session.outputStartedAt = 0;
  stopVCPlayback();

  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }

  for (const unsub of session.unsubscribers) {
    unsub();
  }

  session.transcript.push(`[${new Date().toLocaleTimeString()}] Call ended`);

    recordVoiceCallEnd();
  leaveTesterVoiceChannel();
  leaveVC();

  const duration = Math.round(
    (Date.now() - session.startTime.getTime()) / 1000 / 60
  );

  const transcriptText = session.transcript.join('\n');

  await postVoiceStageLog('call_ended', `duration_min=${duration}`);

  await session.callLog.send(
    `📋 **Call Log — ${session.startTime.toLocaleDateString()} ${session.startTime.toLocaleTimeString()}**\n` +
      `Duration: ${duration} minutes\n\n` +
      `\`\`\`\n${transcriptText.slice(0, 1800)}\n\`\`\``
  );

  try {
    const participants = ['User', 'Riley (Executive Assistant)'];
    const summary = await summarizeCall(session.transcript, participants);

    await session.callLog.send(`📝 **Summary**\n${summary}`);
    await sendAsAgent(
      session.groupchat,
      `📞 **Call ended** (${duration} min)\nSummary posted in <#${session.callLog.id}>`
    );
  } catch (err) {
    console.error('Call summary error:', err instanceof Error ? err.message : 'Unknown');
    await sendAsAgent(session.groupchat, `📞 **Call ended** (${duration} min)`);
  }

  activeSession = null;
}

/**
 * Process a voice transcription — Riley (EA) receives it first, then directs agents.
 */
async function handleVoiceInput(transcription: VoiceTranscription): Promise<void> {
  if (!activeSession?.active) return;

  const session = activeSession;
  const userText = (transcription.text || '').trim();
  if (userText.length < VOICE_MIN_INPUT_CHARS) return;
  if (VOICE_FILLER_ONLY_RE.test(userText)) return;

  const fingerprint = userText
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!fingerprint) return;
  if (fingerprint === session.lastInputFingerprint && Date.now() - session.lastInputAt < VOICE_DUPLICATE_WINDOW_MS) {
    if (Date.now() - session.lastDuplicateNoticeAt > VOICE_DUPLICATE_WINDOW_MS) {
      session.lastDuplicateNoticeAt = Date.now();
      session.callLog.send('🟡 I heard that already — waiting for a new utterance.').catch(() => {});
    }
    return;
  }
  session.lastInputFingerprint = fingerprint;
  session.lastInputAt = Date.now();
  session.pendingBargeIn = false;

  const turnId = session.currentTurnId + 1;
  const abortController = new AbortController();
  const { signal } = abortController;

  session.currentAbortController?.abort();
  session.currentAbortController = abortController;
  session.currentTurnId = turnId;
  session.outputActive = false;
  session.outputStartedAt = 0;
  session.turnStartedAt = Date.now();
  const turnStartMs = session.turnStartedAt;

  const isCurrentTurn = () =>
    activeSession?.active === true &&
    activeSession.currentTurnId === turnId &&
    !signal.aborted;

  let firstTokenLogged = false;
  let firstAudioLogged = false;
  let sttFinalMs = Number.isFinite(transcription.sttLatencyMs) ? Number(transcription.sttLatencyMs) : -1;
  let firstTokenMs = -1;
  let firstAudioMs = -1;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  const armTurnWatchdog = () => {
    if (VOICE_TURN_WATCHDOG_MS <= 0) return;
    watchdogTimer = setTimeout(() => {
      if (!activeSession?.active) return;
      if (activeSession.currentTurnId !== turnId) return;
      void postVoiceStageLog(
        'turn_watchdog',
        `turn=${turnId} elapsed_ms=${Date.now() - turnStartMs} user=${transcription.username}`,
        'warn'
      );
    }, VOICE_TURN_WATCHDOG_MS);
  };

  armTurnWatchdog();

  try {
    await postVoiceStageLog(
      'stt_final',
      `turn=${turnId} user=${transcription.username} provider=${transcription.sttProvider || 'unknown'} stt_ms=${transcription.sttLatencyMs ?? -1} chars=${userText.length}`
    );

    const langTag = transcription.language && transcription.language !== 'en'
      ? ` [${transcription.language}]` : '';
    session.transcript.push(
      `[${transcription.timestamp.toLocaleTimeString()}] ${transcription.username}${langTag}: ${userText}`
    );

    await session.callLog.send(`🎤 **${transcription.username}**: ${userText}`);
    await mirrorVoiceTranscript(transcription.username, userText, transcription.language);
    if (!isCurrentTurn()) return;

    const riley = getAgent('executive-assistant' as AgentId);

    if (riley) {
      try {
      const rileyMemory = compactVoiceHistoryForPrompt(getMemoryContext('executive-assistant').slice(-VOICE_MEMORY_MAX_MESSAGES));
      const recentVoiceHistory = compactVoiceHistoryForPrompt(session.conversationHistory);
      const langHint = transcription.language && transcription.language !== 'en'
        ? `\n\nIMPORTANT: The speaker is using ${transcription.language === 'zh' ? 'Mandarin Chinese' : transcription.language}. Respond in the SAME language they spoke in. The TTS system supports multilingual output.`
        : '';
      const rileyContext = `[Voice from ${transcription.username}]: ${userText}

You are in a voice call. ${transcription.username} just spoke. Your job:
1. Interpret what they want
2. If it's a question you can answer directly, answer it
3. Keep responses directly actionable for the caller

IMPORTANT: This call is Riley-only. Do not delegate to Ace or any other specialist during live voice.

Keep your spoken response very brief (normally 1-2 short sentences) — you're in a voice call, not a text chat.
IMPORTANT: End on a complete sentence, never a fragment.${langHint}`;

      const rileyStreamer = createLiveSpeechStreamer(
        session.rileyVoiceName,
        signal,
        isCurrentTurn,
        turnId,
        transcription.language,
        () => {
          if (firstAudioLogged) return;
          firstAudioLogged = true;
          void postVoiceStageLog('riley_first_audio', `turn=${turnId} audio_ms=${Date.now() - turnStartMs}`);
        }
      );

      const rileyLlmStartMs = Date.now();
      const responseRaw = await agentRespond(
        riley,
        [...rileyMemory, ...recentVoiceHistory],
        rileyContext,
        undefined,
        {
          signal,
          maxTokens: VOICE_MAX_TOKENS_RILEY,
          disableTools: true,
          priority: 'voice',
          chatSession: session.rileyChatSession,
          onPartialText: async (partialText) => {
            if (!firstTokenLogged && partialText.trim()) {
              firstTokenLogged = true;
              firstTokenMs = Date.now() - turnStartMs;
              await postVoiceStageLog('riley_first_token', `turn=${turnId} token_ms=${firstTokenMs}`);
            }
            await rileyStreamer.onPartialText(partialText);
          },
        }
      );
      const response = finalizeSpokenResponse(responseRaw);

      await postVoiceStageLog(
        'riley_llm',
        `turn=${turnId} llm_ms=${Date.now() - rileyLlmStartMs} raw_chars=${responseRaw.length} final_chars=${response.length}`
      );
      if (!isCurrentTurn() || !response.trim()) return;

      session.conversationHistory.push({
        role: 'user',
        content: `[Voice from ${transcription.username}]: ${userText}`,
      });
      session.conversationHistory.push({ role: 'assistant', content: `[Riley]: ${response}` });

      session.transcript.push(
        `[${new Date().toLocaleTimeString()}] Riley (EA): ${response}`
      );

      const rileyLogAndMirror = Promise.allSettled([
        session.callLog.send(`${riley.emoji} **${riley.name}**: ${response.slice(0, 1900)}`),
        mirrorAgentResponse(riley.name, 'call-log', response),
      ]);
      appendToMemory('executive-assistant', [
        { role: 'user', content: `[Voice from ${transcription.username}]: ${userText}` },
        { role: 'assistant', content: `[Riley]: ${response}` },
      ]);
      if (!isCurrentTurn()) return;

      try {
        const rileyTtsStartMs = Date.now();
        const rileySpoke = await rileyStreamer.finalize(response);
        await rileyLogAndMirror;
        if (!rileySpoke && isCurrentTurn() && !signal.aborted) {
          await speakPipelined(
            response,
            session.rileyVoiceName,
            signal,
            transcription.language,
            () => {
              if (firstAudioLogged) return;
              firstAudioLogged = true;
              firstAudioMs = Date.now() - turnStartMs;
              void postVoiceStageLog('riley_first_audio', `turn=${turnId} audio_ms=${firstAudioMs}`);
            }
          );
        }
        await postVoiceStageLog('riley_tts', `turn=${turnId} tts_play_ms=${Date.now() - rileyTtsStartMs}`);
      } catch (ttsErr) {
        if (!isCurrentTurn()) return;
        console.error('TTS error for Riley:', ttsErr instanceof Error ? ttsErr.message : 'Unknown');
        await postVoiceStageLog(
          'riley_tts_failed',
          `turn=${turnId} error=${ttsErr instanceof Error ? ttsErr.message : 'Unknown'}`,
          'error'
        );
        await postDiagnostic('Riley TTS playback failed during call.', {
          level: 'error',
          source: 'callSession.handleVoiceInput',
          detail: ttsErr instanceof Error ? ttsErr.message : 'Unknown',
        });
        sendAsAgent(session.groupchat, '⚠️ Voice playback unavailable — check call-log for Riley\'s response.').catch(() => {});
      }
      if (!isCurrentTurn()) return;

      } catch (err) {
        if (!isCurrentTurn()) return;
        if (isAbortLikeError(err)) return;
        console.error('Riley voice error:', err instanceof Error ? err.message : 'Unknown');
        await postVoiceStageLog('riley_turn_failed', `turn=${turnId} error=${err instanceof Error ? err.message : 'Unknown'}`, 'error');
        await sendAsAgent(session.groupchat, '⚠️ Riley had an error processing voice input.');
      }
    } else {
      await sendAsAgent(session.groupchat, '⚠️ Riley is unavailable. Voice input not processed.');
    }
  } finally {
    if (session.currentTurnId === turnId) {
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      if (!signal.aborted && session.turnStartedAt > 0) {
        const totalMs = Date.now() - turnStartMs;
        console.log(`[VOICE] turn ${turnId} completed in ${Date.now() - session.turnStartedAt}ms`);
        await postVoiceStageLog('turn_total', `turn=${turnId} total_ms=${totalMs}`);
        await postVoiceStageLog(
          'turn_summary',
          `turn=${turnId} user=${transcription.username} stt_ms=${sttFinalMs} token_ms=${firstTokenMs} audio_ms=${firstAudioMs} total_ms=${totalMs}`
        );
      }
      session.currentAbortController = null;
      session.outputActive = false;
      session.outputStartedAt = 0;
      session.turnStartedAt = 0;
    }
  }
}

export function isCallActive(): boolean {
  return activeSession?.active ?? false;
}

export function getActiveSession(): CallSession | null {
  return activeSession;
}

interface VoiceTestInjection {
  userId: string;
  username: string;
  text: string;
  language?: string;
}

/**
 * Deterministically inject a transcript turn into the live voice pipeline.
 * Used for bot-to-bot smoke tests when Discord bot audio cannot be transcribed.
 */
export async function injectVoiceTranscriptForTesting(input: VoiceTestInjection): Promise<{ ok: boolean; reason?: string }> {
  if (!activeSession?.active) {
    return { ok: false, reason: 'No active voice call.' };
  }

  const text = String(input.text || '').trim();
  if (!text) {
    return { ok: false, reason: 'Transcript text is empty.' };
  }

  const username = String(input.username || '').trim() || 'ASAPTester';
  const userId = String(input.userId || '').trim() || 'asaptester';

  await postVoiceStageLog('stt_injected', `user=${username} chars=${text.length}`);

  try {
    await handleVoiceInput({
      userId,
      username,
      text,
      timestamp: new Date(),
      language: input.language,
      sttLatencyMs: 0,
      sttProvider: 'deepgram',
    });
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unknown injection failure';
    await postVoiceStageLog('stt_injected_failed', `user=${username} error=${reason}`, 'warn');
    return { ok: false, reason };
  }
}
