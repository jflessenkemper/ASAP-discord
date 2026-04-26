import { VoiceConnectionStatus } from '@discordjs/voice';
import { TextChannel, VoiceChannel, GuildMember } from 'discord.js';

import { isTesterBotId } from '../../utils/botIdentity';
import { withPgAdvisoryLock } from '../../utils/pgLock';
import { withTimeout } from '../../utils/withTimeout';
import { getAgent, AgentId } from '../agents';
import { agentRespond, ConversationMessage, summarizeCall, ReusableAgentChatSession } from '../claude';
import { postOpsLine } from '../activityLog';
import { appendToMemory, getMemoryContext } from '../memory';
import { recordVoiceCallStart, recordVoiceCallEnd } from '../metrics';
import { postDiagnostic, mirrorAgentResponse, mirrorVoiceTranscript } from '../services/diagnosticsWebhook';
import { getWebhook } from '../services/webhooks';
import { listenToAllMembersSmart, SmartListenerHandle, VoiceTranscription } from '../voice/connection';
import { isElevenLabsAvailable, primeElevenLabsVoiceCache, CORTANA_WARM_PHRASES } from '../voice/elevenlabs';
import { getElevenLabsConvaiReply, isElevenLabsConvaiEnabled } from '../voice/elevenlabsConvai';
import { isElevenLabsRealtimeAvailable } from '../voice/elevenlabsRealtime';
import {
  joinTesterVoiceChannel, leaveTesterVoiceChannel, speakAsTesterInVoice,
  getTesterVoiceConnection, stopTesterVCPlayback, speakInTesterVC, speakInTesterVCWithOptions,
  setTesterNickname, restoreTesterNickname, setTesterAvatar, restoreTesterAvatar,
} from '../voice/testerClient';
import { textToSpeech } from '../voice/tts';
import { errMsg } from '../../utils/errors';
import { recordLoopHealth } from '../loopHealth';
import { buildVoiceDecisionPolicy, buildVoiceSingleSpeakerNotice } from '../cortanaInteraction';
import { recordUserEvent } from '../userEvents';

/** Heartbeat interval to detect stale connections (every 2 minutes) */
const HEARTBEAT_INTERVAL = 20 * 1000;
const VOICE_DISCONNECT_GRACE_MS = 45 * 1000;
const VOICE_PREFLIGHT_TIMEOUT_MS = parseInt(process.env.VOICE_PREFLIGHT_TIMEOUT_MS || '15000', 10);
const VOICE_LOW_LATENCY_MODE = String(process.env.VOICE_LOW_LATENCY_MODE || 'false').toLowerCase() === 'true';
const VOICE_DISABLE_CALL_LOG = String(process.env.VOICE_DISABLE_CALL_LOG || (VOICE_LOW_LATENCY_MODE ? 'true' : 'false')).toLowerCase() === 'true';
const VOICE_DISABLE_TRANSCRIPT_SUMMARY = String(process.env.VOICE_DISABLE_TRANSCRIPT_SUMMARY || (VOICE_LOW_LATENCY_MODE ? 'true' : 'false')).toLowerCase() === 'true';
function isVoiceStartupSelftestEnabled(): boolean {
  return String(process.env.VOICE_STARTUP_SELFTEST_ENABLED || 'false').toLowerCase() === 'true';
}
const VOICE_MAX_TOKENS_CORTANA = parseInt(
  process.env.VOICE_MAX_TOKENS_CORTANA || process.env.VOICE_MAX_TOKENS_RILEY || (VOICE_LOW_LATENCY_MODE ? '120' : '220'),
  10,
);
const VOICE_TOOLS_ENABLED = String(process.env.VOICE_TOOLS_ENABLED || 'true').toLowerCase() === 'true';
const VOICE_TOOLS_MAX_TOKENS = parseInt(process.env.VOICE_TOOLS_MAX_TOKENS || '1024', 10);
const VOICE_STREAM_PARTIAL_MIN_CHARS = parseInt(process.env.VOICE_STREAM_PARTIAL_MIN_CHARS || (VOICE_LOW_LATENCY_MODE ? '10' : '16'), 10);
const VOICE_STREAM_FORCE_CHARS = parseInt(process.env.VOICE_STREAM_FORCE_CHARS || (VOICE_LOW_LATENCY_MODE ? '36' : '60'), 10);
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
// CORTANA_WARM_PHRASES is imported above (one source of truth shared with
// the boot-time TTS cache warm-up).
const VOICE_TURN_WATCHDOG_MS = parseInt(process.env.VOICE_TURN_WATCHDOG_MS || '20000', 10);
const VOICE_SINGLE_SPEAKER_NOTICE_COOLDOWN_MS = parseInt(process.env.VOICE_SINGLE_SPEAKER_NOTICE_COOLDOWN_MS || '15000', 10);
const DEFAULT_TESTER_BOT_ID = '1487426371209789450';
const RUNTIME_INSTANCE_TAG = (process.env.RUNTIME_INSTANCE_TAG || process.env.HOSTNAME || `pid-${process.pid}`).slice(0, 80);
const VOICE_LIFECYCLE_DEDUPE_MS = parseInt(process.env.VOICE_LIFECYCLE_DEDUPE_MS || '15000', 10);

let callStartInProgress = false;
const lifecycleNoticeLastSentAt = new Map<string, number>();




function hasManagedTesterBotInChannel(voiceChannel: VoiceChannel): boolean {
  const members = (voiceChannel as { members?: unknown }).members;
  if (!members) return false;
  if (typeof (members as { some?: unknown }).some === 'function') {
    return (members as { some: (predicate: (member: GuildMember) => boolean) => boolean }).some(
      (member) => isTesterBotId(member.user.id)
    );
  }
  if (typeof (members as { values?: unknown }).values === 'function') {
    for (const member of (members as { values: () => Iterable<GuildMember> }).values()) {
      if (isTesterBotId(member.user.id)) return true;
    }
  }
  return false;
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
  try {
    await postOpsLine(voiceErrorChannel, {
      actor: 'system',
      scope: `voice:${stage}`,
      metric: 'voice-stage',
      delta: `instance=${RUNTIME_INSTANCE_TAG} ${detail}`,
      action,
      severity: level,
    });
  } catch (err) {
    console.warn(`Voice stage log failed for ${stage}:`, errMsg(err));
  }
}


function isVoiceInputAvailable(): { ok: boolean; reason?: string } {
  if (isElevenLabsRealtimeAvailable()) return { ok: true };
  if (!isElevenLabsAvailable()) {
    return { ok: false, reason: 'Neither ElevenLabs realtime STT nor ElevenLabs batch STT is configured.' };
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
    if (activeSession?.active && audio) await speakInTesterVCWithOptions(audio, { signal, onPlaybackStart });
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

    await speakInTesterVCWithOptions(audio, { signal, onPlaybackStart });
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

// ─── Voice Command Detection ───

interface VoiceCommand {
  type: 'smoke_test' | 'test_health' | 'set_goal' | 'memory_status' | 'deploy_app';
  args?: string;
}

function detectVoiceCommand(text: string): VoiceCommand | null {
  const lower = text.toLowerCase();
  if (/run\s+(smoke|the)\s+tests?/i.test(lower)) return { type: 'smoke_test' };
  if (/(?:check|what(?:'s| is))\s+(?:the\s+)?test\s+health/i.test(lower)) return { type: 'test_health' };
  if (/(?:deploy|ship|push)\s+(?:the\s+)?app/i.test(lower)) return { type: 'deploy_app' };
  if (/set\s+(?:a\s+)?goal\s*(?:to|:)?\s*(.+)/i.test(lower)) {
    const match = lower.match(/set\s+(?:a\s+)?goal\s*(?:to|:)?\s*(.+)/i);
    return { type: 'set_goal', args: match?.[1]?.trim() };
  }
  if (/memory\s+status/i.test(lower)) return { type: 'memory_status' };
  return null;
}

async function handleVoiceCommand(
  session: CallSession,
  command: VoiceCommand,
  transcription: VoiceTranscription,
  userText: string,
): Promise<void> {
  const cortana = getAgent('executive-assistant' as AgentId);
  let response: string;

  switch (command.type) {
    case 'smoke_test':
      response = 'Starting smoke tests now. I\'ll report results when they finish.';
      import('../tools').then(({ smokeTestAgents }) => {
        smokeTestAgents({ profile: 'readiness' }).catch((err: unknown) => {
          console.warn('[voice-cmd] smoke test error:', err);
        });
      }).catch(() => {});
      break;
    case 'test_health':
      try {
        const fs = await import('fs');
        const path = await import('path');
        const dir = path.join(process.cwd(), 'smoke-reports');
        const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.json')).sort();
        if (files.length > 0) {
          const report = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf-8'));
          const s = report?.summary;
          response = s
            ? `Test health: score ${s.score}%, ${s.capabilityPassed} passed, ${s.capabilityFailed} failed. Critical tests ${s.criticalPassed ? 'all passing' : 'have failures'}.`
            : 'I found a smoke report but couldn\'t parse the summary.';
        } else {
          response = 'No smoke test reports found yet.';
        }
      } catch {
        response = 'I couldn\'t read the smoke test reports.';
      }
      break;
    case 'set_goal':
      if (command.args) {
        const { goalState } = await import('./goalState');
        goalState.setGoal(command.args);
        response = `Goal set: ${command.args}`;
      } else {
        response = 'I didn\'t catch the goal. Please say "set a goal to" followed by the goal.';
      }
      break;
    case 'memory_status':
      try {
        const { consolidateMemoryInsights } = await import('../vectorMemory');
        const insights = await consolidateMemoryInsights();
        response = insights
          ? `Memory status: ${insights.slice(0, 200)}`
          : 'No recent memory insights available.';
      } catch {
        response = 'Memory system is currently unavailable.';
      }
      break;
    case 'deploy_app':
      response = 'Deploying the app to Cloud Run now. I\'ll let you know when it\'s done.';
      import('../toolsGcp').then(({ deployApp }) => {
        if (deployApp) {
          deployApp().catch((err: unknown) => {
            console.warn('[voice-cmd] deploy_app error:', err);
          });
        }
      }).catch(() => {});
      break;
    default:
      response = 'I didn\'t understand that command.';
  }

  // Log to call log
  if (!VOICE_DISABLE_CALL_LOG) {
    session.transcript.push(`[${new Date().toLocaleTimeString()}] ${transcription.username}: ${userText}`);
    session.transcript.push(`[${new Date().toLocaleTimeString()}] Cortana (EA): ${response}`);
    await session.callLog.send(`🎤 **${transcription.username}**: ${userText}`).catch(() => {});
    await session.callLog.send(`${cortana?.emoji || '📋'} **Cortana**: ${response}`).catch(() => {});
  }

  // Speak the response
  await speakPipelined(response, session.cortanaVoiceName, new AbortController().signal, transcription.language);
}

function extractVoiceToTextHandoffInstruction(text: string): string | null {
  const normalized = String(text || '').trim();
  if (!normalized) return null;

  const explicitPatterns: RegExp[] = [
    /(?:send|pass|forward)\s+(?:this\s+)?(?:to\s+)?(?:text\s+cortana|cortana\s+text|groupchat|the\s+text\s+channel)\s*[:,-]?\s*(.+)$/i,
    /(?:text\s+cortana|cortana\s+text)\s*[:,-]\s*(.+)$/i,
    /cortana\s*(?:please\s*)?(?:create|open|start|add)\s*(?:a\s+)?(?:text\s+)?(?:task|todo|follow\s*up)\s*[:,-]?\s*(.+)$/i,
    /cortana\s*(?:please\s*)?(?:note|remember)\s*(?:this)?\s*(?:in\s+text|for\s+text)?\s*[:,-]?\s*(.+)$/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = normalized.match(pattern);
    if (!match?.[1]) continue;
    const instruction = String(match[1]).trim();
    if (instruction.length >= 4) return instruction;
  }

  return null;
}

async function handoffVoiceInstructionToTextCortana(
  session: CallSession,
  transcription: VoiceTranscription,
  instruction: string,
): Promise<boolean> {
  const trimmed = String(instruction || '').trim();
  if (!trimmed) return false;
  if (!session.active) return false;

  try {
    const mod = await import('./groupchat');
    if (typeof mod.handoffVoiceInstructionToCortanaText !== 'function') {
      return false;
    }

    await mod.handoffVoiceInstructionToCortanaText(trimmed, transcription.username, session.groupchat);
    await postVoiceStageLog('voice_text_handoff', `user=${transcription.username} chars=${trimmed.length}`);
    await sendAsAgent(session.groupchat, `📝 Voice handoff queued for Cortana text: "${trimmed.slice(0, 180)}"`);
    if (!VOICE_DISABLE_CALL_LOG) {
      session.transcript.push(
        `[${new Date().toLocaleTimeString()}] System: queued voice handoff to Cortana text — ${trimmed}`
      );
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown handoff error';
    let userReason = 'a temporary backend issue occurred. Please try again in a few seconds.';
    if (/no active voice call/i.test(msg)) {
      userReason = 'there is no active voice call right now.';
    } else if (/timeout|timed out/i.test(msg)) {
      userReason = 'the handoff timed out. Please retry with a shorter instruction.';
    } else if (/abort/i.test(msg)) {
      userReason = 'the previous request was interrupted by a newer one.';
    }
    await postVoiceStageLog('voice_text_handoff_failed', `user=${transcription.username} error=${msg}`, 'warn');
    await sendAsAgent(session.groupchat, `⚠️ Voice handoff to Cortana text failed: ${userReason}`);
    return false;
  }
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

  const warmPhraseSet = new Set(CORTANA_WARM_PHRASES.map(p => p.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()));

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
          activeSession.isPlayingWarmPhrase = warmPhraseSet.has(normalized);
        }
        spokeAny = true;
        await speakPipelined(toSpeak, voice, signal, language, onPlaybackStart);
        // After playback, clear the warm-phrase flag
        if (activeSession?.currentTurnId === turnId) {
          activeSession.isPlayingWarmPhrase = false;
        }
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
  cortanaChatSession: ReusableAgentChatSession;
  unsubscribers: Array<() => void>;
  voiceChannel: VoiceChannel;
  groupchat: TextChannel;
  callLog: TextChannel;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  currentAbortController: AbortController | null;
  currentTurnId: number;
  outputActive: boolean;
  outputStartedAt: number;
  isPlayingWarmPhrase: boolean;
  lastInterruptAt: number;
  disconnectedSince: number | null;
  lastInputFingerprint: string;
  lastInputAt: number;
  lastDuplicateNoticeAt: number;
  pendingBargeIn: boolean;
  turnStartedAt: number;
  activeSpeakerUserId: string | null;
  activeSpeakerName: string | null;
  lastSpeakerPolicyNoticeAt: number;
  cortanaVoiceName: string;
  previousBotNickname: string | null;
}

let activeSession: CallSession | null = null;
let activeListenerHandle: SmartListenerHandle | null = null;

/** Pre-init STT for a member joining the voice channel (avoids cold start). */
export function preInitSttForMember(member: GuildMember): void {
  activeListenerHandle?.preInitMember(member);
}

function isTransientConnectionState(status: string): boolean {
  return status === VoiceConnectionStatus.Disconnected || status === 'signalling' || status === 'connecting';
}

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
  activeSession.isPlayingWarmPhrase = false;
  stopTesterVCPlayback();
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

async function sendLifecycleNoticeOnce(channel: TextChannel, key: string, content: string): Promise<void> {
  const now = Date.now();
  const dedupeKey = `${channel.id}:${key}`;
  const prev = lifecycleNoticeLastSentAt.get(dedupeKey) || 0;
  if (now - prev < VOICE_LIFECYCLE_DEDUPE_MS) return;
  lifecycleNoticeLastSentAt.set(dedupeKey, now);
  await sendAsAgent(channel, content);
}

async function maybeSendVoiceSingleSpeakerNotice(session: CallSession): Promise<void> {
  const now = Date.now();
  if (now - session.lastSpeakerPolicyNoticeAt < VOICE_SINGLE_SPEAKER_NOTICE_COOLDOWN_MS) return;
  session.lastSpeakerPolicyNoticeAt = now;
  await sendAsAgent(session.groupchat, buildVoiceSingleSpeakerNotice(session.activeSpeakerName || undefined));
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
  await withPgAdvisoryLock(`voice-call:${voiceChannel.guild.id}:${voiceChannel.id}`, async () => {
    const callStartMs = Date.now();
    if (callStartInProgress) {
      await sendLifecycleNoticeOnce(groupchat, `start_in_progress:${voiceChannel.id}`, '📞 A call start is already being processed. Please wait a few seconds.');
      return;
    }

    callStartInProgress = true;
    try {
    if (activeSession?.active || hasManagedTesterBotInChannel(voiceChannel)) {
      await sendLifecycleNoticeOnce(groupchat, `already_active:${voiceChannel.id}`, '⚠️ A call is already in progress. Say `LEAVE` to end it first.');
      return;
    }

    const inputReady = isVoiceInputAvailable();
    if (!inputReady.ok) {
      await sendAsAgent(
        groupchat,
        `⚠️ I can't join voice yet because listening is unavailable: ${inputReady.reason} ` +
        `Configure ElevenLabs realtime STT or ElevenLabs batch STT before joining.`
      );
      return;
    }

  const testerVoiceId = process.env.ASAPTESTER_DISCORD_VOICE_ID || 'lsgXALPNLFUcQfT1dmP1';
  const isTesterInitiated = isTesterBotId(initiator.user.id);
  const cortana = getAgent('executive-assistant' as AgentId);
  const selectedCortanaVoice = isTesterInitiated ? testerVoiceId : (cortana?.voice || 'Achernar');

  // Set ASAPTester's identity to Cortana BEFORE joining voice so users see
  // "Cortana" in the voice channel from the moment the bot appears.
  const guildId = voiceChannel.guild.id;
  const previousBotNickname = await setTesterNickname(guildId, 'Cortana', 'ASAP voice call active');
  if (cortana?.avatarUrl) {
    await setTesterAvatar(cortana.avatarUrl);
  }

  const joinStartMs = Date.now();
  await joinTesterVoiceChannel(voiceChannel);
  const connection = getTesterVoiceConnection()!;
  const testerMember = voiceChannel.guild.members.me;

  console.log(
    `[VOICE_DEBUG] joined channel=${voiceChannel.name} ` +
    `join_ms=${Date.now() - joinStartMs} ` +
    `selfMute=${testerMember?.voice.selfMute ?? 'unknown'} ` +
    `selfDeaf=${testerMember?.voice.selfDeaf ?? 'unknown'} ` +
    `serverMute=${testerMember?.voice.serverMute ?? 'unknown'} ` +
    `serverDeaf=${testerMember?.voice.serverDeaf ?? 'unknown'} ` +
    `channelId=${testerMember?.voice.channelId ?? 'unknown'}`
  );

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
    cortanaChatSession: { chat: null, modelName: null },
    unsubscribers: [],
    voiceChannel,
    groupchat,
    callLog,
    heartbeatTimer: null,
    currentAbortController: null,
    currentTurnId: 0,
    outputActive: false,
    outputStartedAt: 0,
    isPlayingWarmPhrase: false,
    lastInterruptAt: 0,
    disconnectedSince: null,
    lastInputFingerprint: '',
    lastInputAt: 0,
    lastDuplicateNoticeAt: 0,
    pendingBargeIn: false,
    turnStartedAt: 0,
    activeSpeakerUserId: null,
    activeSpeakerName: null,
    lastSpeakerPolicyNoticeAt: 0,
    cortanaVoiceName: selectedCortanaVoice,
    previousBotNickname,
  };

  activeSession.heartbeatTimer = setInterval(() => {
    if (!activeSession?.active) return;
    try {
      const conn = getTesterVoiceConnection();
      const status = String(conn?.state.status || 'unknown');
      if (!conn || status === VoiceConnectionStatus.Destroyed) {
        console.warn('Voice connection destroyed — ending call');
        void postVoiceStageLog('connection_destroyed', `channel=${voiceChannel.name}`, 'error');
        endCall().catch((err) => console.error('Heartbeat endCall error:', errMsg(err)));
        return;
      }

      if (isTransientConnectionState(status)) {
        if (!activeSession.disconnectedSince) {
          activeSession.disconnectedSince = Date.now();
          console.warn(`Voice connection entered transient state (${status}) — waiting for recovery`);
          void postVoiceStageLog(
            status === VoiceConnectionStatus.Disconnected ? 'connection_disconnected' : 'connection_unstable',
            `channel=${voiceChannel.name} status=${status}`,
            'warn'
          );
          sendLifecycleNoticeOnce(groupchat, `reconnecting:${voiceChannel.id}`, '⚠️ Voice connection interrupted — reconnecting for up to 45 seconds.').catch(() => {});
          return;
        }

        const degradedForMs = Date.now() - activeSession.disconnectedSince;
        if (degradedForMs < VOICE_DISCONNECT_GRACE_MS) {
          return;
        }

        console.warn(`Voice connection remained ${status} for ${Math.round(degradedForMs / 1000)}s — ending call`);
        recordLoopHealth('voice-session', 'error', `status=${status} degraded_ms=${degradedForMs}`);
        void postVoiceStageLog('connection_timeout', `status=${status} degraded_ms=${degradedForMs}`, 'error');
        endCall().catch((err) => console.error('Heartbeat endCall error:', errMsg(err)));
        return;
      }

      if (activeSession.disconnectedSince) {
        sendLifecycleNoticeOnce(groupchat, `reconnected:${voiceChannel.id}`, '✅ Voice reconnected.').catch(() => {});
        void postVoiceStageLog('connection_recovered', `channel=${voiceChannel.name}`);
      }
      activeSession.disconnectedSince = null;
    } catch (err) {
      console.error('Heartbeat error:', errMsg(err));
    }
  }, HEARTBEAT_INTERVAL);

  const onConnectionStateChange = (oldState: { status: string }, newState: { status: string }) => {
    console.log(`[VOICE_DEBUG] connection_state ${oldState.status} -> ${newState.status}`);
  };
  connection.on('stateChange', onConnectionStateChange);
  activeSession.unsubscribers.push(() => {
    connection.off('stateChange', onConnectionStateChange);
  });

  const listenerHandle = listenToAllMembersSmart(
    connection,
    voiceChannel,
    (transcription) => {
      if (!activeSession?.active) return;
      void handleVoiceInput(transcription).catch((err) => {
        if (!isAbortLikeError(err)) {
          console.error('Voice processing error:', errMsg(err));
        }
      });
    },
    (member) => {
      console.log(`[VOICE_DEBUG] speech_detected user=${member.displayName}`);
      void postVoiceStageLog('speech_detected', `user=${member.displayName}`);
    }
  );
  activeSession.unsubscribers.push(listenerHandle.unsubscribe);
  activeListenerHandle = listenerHandle;

  const onSpeakingStart = (userId: string) => {
    if (!activeSession?.active) return;
    const member = voiceChannel.members.get(userId);
    if (!member || member.user.bot) return;
    console.log(`[VOICE_DEBUG] receiver_speaking_start user=${member.displayName}`);
    if (activeSession.currentAbortController && activeSession.activeSpeakerUserId && userId !== activeSession.activeSpeakerUserId) {
      void maybeSendVoiceSingleSpeakerNotice(activeSession);
      return;
    }
    if (!activeSession.outputActive) return;
    // Let warm phrases (e.g. "One moment.") finish without interruption
    if (activeSession.isPlayingWarmPhrase) return;
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

  if (!VOICE_DISABLE_CALL_LOG) {
    activeSession.transcript.push(
      `[${new Date().toLocaleTimeString()}] Call started by ${initiator.displayName}`
    );
  }

  const sttNote = (String(process.env.VOICE_REALTIME_MODE || 'true').toLowerCase() !== 'false' && isElevenLabsRealtimeAvailable())
    ? '\n🎙️ ElevenLabs realtime STT is active.'
    : '\n⚠️ ElevenLabs realtime STT unavailable — using ElevenLabs batch mode (~1-2s latency).';
  await sendLifecycleNoticeOnce(
    groupchat,
    `started:${voiceChannel.id}`,
    `✅ **Voice call started**\n` +
      `Initiated by **${initiator.displayName}**\n` +
      `${cortana?.emoji || '📋'} **Cortana** is on the line and listening now.\n\n` +
      `Speak in **${voiceChannel.name}**. Say "leave" or ask Cortana to end the call.${sttNote}`
  );

  if (isVoiceStartupSelftestEnabled()) {
    const preflightStartMs = Date.now();
    void (async () => {
      try {
        const checkAudio = await withTimeout(
          textToSpeech(`Hello ${initiator.displayName}.`, selectedCortanaVoice),
          VOICE_PREFLIGHT_TIMEOUT_MS,
          'TTS preflight'
        );
        if (!activeSession?.active) return;
        await withTimeout(speakInTesterVC(checkAudio), VOICE_PREFLIGHT_TIMEOUT_MS, 'Voice playback preflight');
        await postDiagnostic('Voice self-test passed at call start.', {
          level: 'info',
          source: 'callSession.startCall',
          detail: `Channel=${voiceChannel.name} Initiator=${initiator.displayName}`,
        });
        await postVoiceStageLog('preflight_ok', `tts_playback_ms=${Date.now() - preflightStartMs}`);
      } catch (err) {
        const msg = errMsg(err);
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
    recordLoopHealth('voice-session', 'ok', `call started channel=${voiceChannel.name}`);
    primeElevenLabsVoiceCache(selectedCortanaVoice, [...CORTANA_WARM_PHRASES]).catch(() => {});
    } finally {
      callStartInProgress = false;
    }
  });
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
  session.isPlayingWarmPhrase = false;
  session.activeSpeakerUserId = null;
  session.activeSpeakerName = null;
  stopTesterVCPlayback();

  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }

  for (const unsub of session.unsubscribers) {
    unsub();
  }
  activeListenerHandle = null;

  // Restore ASAPTester's identity
  const guildId = session.voiceChannel.guild.id;
  await restoreTesterNickname(guildId, session.previousBotNickname);
  void restoreTesterAvatar();

  if (!VOICE_DISABLE_CALL_LOG) {
    session.transcript.push(`[${new Date().toLocaleTimeString()}] Call ended`);
  }

    recordVoiceCallEnd();
  leaveTesterVoiceChannel();

  const duration = Math.round(
    (Date.now() - session.startTime.getTime()) / 1000 / 60
  );

  await postVoiceStageLog('call_ended', `duration_min=${duration}`);
  recordLoopHealth('voice-session', 'ok', `call ended duration_min=${duration}`);
  if (!VOICE_DISABLE_CALL_LOG) {
    const transcriptText = session.transcript.join('\n');
    await session.callLog.send(
      `📋 **Call Log — ${session.startTime.toLocaleDateString()} ${session.startTime.toLocaleTimeString()}**\n` +
        `Duration: ${duration} minutes\n\n` +
        `\`\`\`\n${transcriptText.slice(0, 1800)}\n\`\`\``
    );
  }

  if (!VOICE_DISABLE_TRANSCRIPT_SUMMARY && !VOICE_DISABLE_CALL_LOG) {
    try {
      const participants = ['User', 'Cortana (Executive Assistant)'];
      const summary = await summarizeCall(session.transcript, participants);
      await session.callLog.send(`📝 **Summary**\n${summary}`);
      await sendAsAgent(
        session.groupchat,
        `📞 **Call ended** (${duration} min)\nSummary posted in <#${session.callLog.id}>`
      );
    } catch (err) {
      console.error('Call summary error:', errMsg(err));
      await sendAsAgent(session.groupchat, `📞 **Call ended** (${duration} min)`);
    }
  } else {
    await sendAsAgent(session.groupchat, `📞 **Call ended** (${duration} min)`);
  }

  activeSession = null;
}

/**
 * Process a voice transcription — Cortana (EA) receives it first, then directs agents.
 */
async function handleVoiceInput(transcription: VoiceTranscription): Promise<void> {
  if (!activeSession?.active) return;

  const session = activeSession;
  const userText = (transcription.text || '').trim();
  if (userText.length < VOICE_MIN_INPUT_CHARS) return;
  if (VOICE_FILLER_ONLY_RE.test(userText)) return;

  // Capture the voice utterance into user_events for Cortana's memory + SI.
  // Fire-and-forget so it never delays the turn.
  if (transcription.userId) {
    void recordUserEvent({
      userId: transcription.userId,
      channelId: session.voiceChannel.id,
      kind: 'voice',
      text: userText,
      metadata: {
        username: transcription.username,
        sttProvider: transcription.sttProvider,
        sttLatencyMs: transcription.sttLatencyMs,
      },
    }).catch(() => {});
  }

  const textHandoffInstruction = extractVoiceToTextHandoffInstruction(userText);
  if (textHandoffInstruction) {
    await handoffVoiceInstructionToTextCortana(session, transcription, textHandoffInstruction);
  }

  // Voice command detection
  const voiceCommand = detectVoiceCommand(userText);
  if (voiceCommand) {
    await handleVoiceCommand(session, voiceCommand, transcription, userText);
    return;
  }

  const fingerprint = userText
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!fingerprint) return;
  if (fingerprint === session.lastInputFingerprint && Date.now() - session.lastInputAt < VOICE_DUPLICATE_WINDOW_MS) {
    return;
  }
  session.lastInputFingerprint = fingerprint;
  session.lastInputAt = Date.now();
  session.pendingBargeIn = false;

  if (
    session.currentAbortController &&
    session.activeSpeakerUserId &&
    transcription.userId &&
    transcription.userId !== session.activeSpeakerUserId
  ) {
    await maybeSendVoiceSingleSpeakerNotice(session);
    return;
  }

  const turnId = session.currentTurnId + 1;
  const abortController = new AbortController();
  const { signal } = abortController;

  session.currentAbortController?.abort();
  session.currentAbortController = abortController;
  session.currentTurnId = turnId;
  session.outputActive = false;
  session.outputStartedAt = 0;
  session.turnStartedAt = Date.now();
  session.activeSpeakerUserId = transcription.userId || null;
  session.activeSpeakerName = transcription.username || null;
  const turnStartMs = session.turnStartedAt;

  const isCurrentTurn = () =>
    activeSession?.active === true &&
    activeSession.currentTurnId === turnId &&
    !signal.aborted;

  let firstTokenLogged = false;
  let firstAudioLogged = false;
  const sttFinalMs = Number.isFinite(transcription.sttLatencyMs) ? Number(transcription.sttLatencyMs) : -1;
  let firstTokenMs = -1;
  let firstAudioMs = -1;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  const armTurnWatchdog = () => {
    if (VOICE_TURN_WATCHDOG_MS <= 0) return;
    watchdogTimer = setTimeout(() => {
      if (!activeSession?.active) return;
      if (activeSession.currentTurnId !== turnId) return;
      recordLoopHealth('voice-session', 'warn', `turn watchdog turn=${turnId} elapsed_ms=${Date.now() - turnStartMs}`);
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
    if (!VOICE_DISABLE_CALL_LOG) {
      session.transcript.push(
        `[${transcription.timestamp.toLocaleTimeString()}] ${transcription.username}${langTag}: ${userText}`
      );
      await session.callLog.send(`🎤 **${transcription.username}**: ${userText}`);
      await mirrorVoiceTranscript(transcription.username, userText, transcription.language);
    }
    if (!isCurrentTurn()) return;

    const cortana = getAgent('executive-assistant' as AgentId);

    if (cortana) {
      try {
      if (isElevenLabsConvaiEnabled()) {
        try {
          const convaiStartMs = Date.now();
          const responseRaw = await getElevenLabsConvaiReply(userText, transcription.language);
          if (!firstTokenLogged && responseRaw.trim()) {
            firstTokenLogged = true;
            firstTokenMs = Date.now() - turnStartMs;
            await postVoiceStageLog('cortana_first_token', `turn=${turnId} token_ms=${firstTokenMs}`);
          }

          const response = finalizeSpokenResponse(responseRaw);
          await postVoiceStageLog(
            'cortana_convai',
            `turn=${turnId} convai_ms=${Date.now() - convaiStartMs} raw_chars=${responseRaw.length} final_chars=${response.length}`
          );

          if (!isCurrentTurn() || !response.trim()) return;

          session.conversationHistory.push({
            role: 'user',
            content: `[Voice from ${transcription.username}]: ${userText}`,
          });
          session.conversationHistory.push({ role: 'assistant', content: `[Cortana]: ${response}` });

          const cortanaLogAndMirror = VOICE_DISABLE_CALL_LOG
            ? Promise.resolve([])
            : Promise.allSettled([
                session.callLog.send(`${cortana.emoji} **${cortana.name}**: ${response.slice(0, 1900)}`),
                mirrorAgentResponse(cortana.name, 'call-log', response),
              ]);
          if (!VOICE_DISABLE_CALL_LOG) {
            session.transcript.push(
              `[${new Date().toLocaleTimeString()}] Cortana (EA): ${response}`
            );
          }

          if (!isCurrentTurn()) return;

          const cortanaTtsStartMs = Date.now();
          await speakPipelined(
            response,
            session.cortanaVoiceName,
            signal,
            transcription.language,
            () => {
              if (firstAudioLogged) return;
              firstAudioLogged = true;
              firstAudioMs = Date.now() - turnStartMs;
              void postVoiceStageLog('cortana_first_audio', `turn=${turnId} audio_ms=${firstAudioMs}`);
            }
          );
          await cortanaLogAndMirror;
          await postVoiceStageLog('cortana_tts', `turn=${turnId} tts_play_ms=${Date.now() - cortanaTtsStartMs}`);
          return;
        } catch (convaiErr) {
          await postVoiceStageLog(
            'cortana_convai_failed',
            `turn=${turnId} error=${convaiErr instanceof Error ? convaiErr.message : 'Unknown'}`,
            'warn'
          );
        }
      }

      const cortanaMemory = compactVoiceHistoryForPrompt(getMemoryContext('executive-assistant').slice(-VOICE_MEMORY_MAX_MESSAGES));
      const recentVoiceHistory = compactVoiceHistoryForPrompt(session.conversationHistory);
      const langHint = transcription.language && transcription.language !== 'en'
        ? `\n\nIMPORTANT: The speaker is using ${transcription.language === 'zh' ? 'Mandarin Chinese' : transcription.language}. Respond in the SAME language they spoke in. The TTS system supports multilingual output.`
        : '';
      const cortanaContext = `[Voice from ${transcription.username}]: ${userText}

You are in a voice call. ${transcription.username} just spoke. Your job:
1. Interpret what they want
2. If it's a question you can answer directly, answer it
3. Keep responses directly actionable for the caller

IMPORTANT: This call is Cortana-only. Do not delegate to any specialist during live voice.
${buildVoiceDecisionPolicy()}

Keep your spoken response very brief (normally 1-2 short sentences) — you're in a voice call, not a text chat.
IMPORTANT: End on a complete sentence, never a fragment.${langHint}`;

      const cortanaStreamer = createLiveSpeechStreamer(
        session.cortanaVoiceName,
        signal,
        isCurrentTurn,
        turnId,
        transcription.language,
        () => {
          if (firstAudioLogged) return;
          firstAudioLogged = true;
          void postVoiceStageLog('cortana_first_audio', `turn=${turnId} audio_ms=${Date.now() - turnStartMs}`);
        }
      );

      const cortanaLlmStartMs = Date.now();
      const responseRaw = await agentRespond(
        cortana,
        [...cortanaMemory, ...recentVoiceHistory],
        cortanaContext,
        VOICE_TOOLS_ENABLED ? async (toolName, summary) => {
          void postVoiceStageLog('tool_done', `turn=${turnId} tool=${toolName}`);
        } : undefined,
        {
          signal,
          maxTokens: VOICE_TOOLS_ENABLED ? VOICE_TOOLS_MAX_TOKENS : VOICE_MAX_TOKENS_CORTANA,
          disableTools: !VOICE_TOOLS_ENABLED,
          priority: 'voice',
          chatSession: session.cortanaChatSession,
          threadKey: `voice:${session.voiceChannel.id}`,
          onToolStart: VOICE_TOOLS_ENABLED ? async (toolName) => {
            void postVoiceStageLog('tool_start', `turn=${turnId} tool=${toolName}`);
          } : undefined,
          onPartialText: async (partialText) => {
            if (!firstTokenLogged && partialText.trim()) {
              firstTokenLogged = true;
              firstTokenMs = Date.now() - turnStartMs;
              await postVoiceStageLog('cortana_first_token', `turn=${turnId} token_ms=${firstTokenMs}`);
            }
            await cortanaStreamer.onPartialText(partialText);
          },
        }
      );
      const response = finalizeSpokenResponse(responseRaw);

      await postVoiceStageLog(
        'cortana_llm',
        `turn=${turnId} llm_ms=${Date.now() - cortanaLlmStartMs} raw_chars=${responseRaw.length} final_chars=${response.length}`
      );
      if (!isCurrentTurn() || !response.trim()) return;

      session.conversationHistory.push({
        role: 'user',
        content: `[Voice from ${transcription.username}]: ${userText}`,
      });
      session.conversationHistory.push({ role: 'assistant', content: `[Cortana]: ${response}` });

      const cortanaLogAndMirror = VOICE_DISABLE_CALL_LOG
        ? Promise.resolve([])
        : Promise.allSettled([
            session.callLog.send(`${cortana.emoji} **${cortana.name}**: ${response.slice(0, 1900)}`),
            mirrorAgentResponse(cortana.name, 'call-log', response),
          ]);
      if (!VOICE_DISABLE_CALL_LOG) {
        session.transcript.push(
          `[${new Date().toLocaleTimeString()}] Cortana (EA): ${response}`
        );
      }
      if (!VOICE_LOW_LATENCY_MODE) {
        appendToMemory('executive-assistant', [
          { role: 'user', content: `[Voice from ${transcription.username}]: ${userText}` },
          { role: 'assistant', content: `[Cortana]: ${response}` },
        ]);
      }
      if (!isCurrentTurn()) return;

      try {
        const cortanaTtsStartMs = Date.now();
        const cortanaSpoke = await cortanaStreamer.finalize(response);
        await cortanaLogAndMirror;
        if ((!cortanaSpoke || !firstAudioLogged) && isCurrentTurn() && !signal.aborted) {
          await speakPipelined(
            response,
            session.cortanaVoiceName,
            signal,
            transcription.language,
            () => {
              if (firstAudioLogged) return;
              firstAudioLogged = true;
              firstAudioMs = Date.now() - turnStartMs;
              void postVoiceStageLog('cortana_first_audio', `turn=${turnId} audio_ms=${firstAudioMs}`);
            }
          );
        }
        await postVoiceStageLog('cortana_tts', `turn=${turnId} tts_play_ms=${Date.now() - cortanaTtsStartMs}`);
      } catch (ttsErr) {
        if (!isCurrentTurn()) return;
        console.error('TTS error for Cortana:', ttsErr instanceof Error ? ttsErr.message : 'Unknown');
        await postVoiceStageLog(
          'cortana_tts_failed',
          `turn=${turnId} error=${ttsErr instanceof Error ? ttsErr.message : 'Unknown'}`,
          'error'
        );
        await postDiagnostic('Cortana TTS playback failed during call.', {
          level: 'error',
          source: 'callSession.handleVoiceInput',
          detail: ttsErr instanceof Error ? ttsErr.message : 'Unknown',
        });
        sendAsAgent(session.groupchat, '⚠️ Voice playback unavailable — check call-log for Cortana\'s response.').catch(() => {});
      }
      if (!isCurrentTurn()) return;

      } catch (err) {
        if (!isCurrentTurn()) return;
        if (isAbortLikeError(err)) return;
        console.error('Cortana voice error:', errMsg(err));
        await postVoiceStageLog('cortana_turn_failed', `turn=${turnId} error=${errMsg(err)}`, 'error');
        await sendAsAgent(session.groupchat, '⚠️ Cortana had an error processing voice input.');
      }
    } else {
      await sendAsAgent(session.groupchat, '⚠️ Cortana is unavailable. Voice input not processed.');
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
        recordLoopHealth('voice-session', 'ok', `turn=${turnId} total_ms=${totalMs}`);
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
      session.activeSpeakerUserId = null;
      session.activeSpeakerName = null;
    }
  }
}

export function isCallActive(): boolean {
  return activeSession?.active ?? false;
}

// Cortana-flavored openers for multi-party voice events. Short, dry, varied
// so repeat joins in one call don't sound scripted. Picked at random per event.
const VOICE_JOIN_PHRASES: readonly string[] = [
  'Hey {name}.',
  '{name} is here.',
  '{name} just joined us.',
  'Welcome, {name}.',
  'Another one — {name}. Hi.',
  'Look who it is. {name}.',
];
const VOICE_LEAVE_PHRASES: readonly string[] = [
  '{name} dropped out.',
  'And {name} is gone.',
  '{name} left us.',
  'Down one — {name} bailed.',
];

/** Cooldown (ms) so rapid join/leave flaps don't trigger multiple announcements. */
const VOICE_MEMBER_ANNOUNCE_COOLDOWN_MS = Math.max(5_000, parseInt(process.env.VOICE_MEMBER_ANNOUNCE_COOLDOWN_MS || '30000', 10));
const lastMemberAnnounceAt = new Map<string, number>();

/**
 * Announce a member joining or leaving the active voice call. Cortana speaks
 * a short line in her voice via TTS + VC playback. No-op when:
 *   - no call is active
 *   - the same member event fired within the cooldown window
 *   - TTS or voice playback is unavailable
 *
 * Runs fire-and-forget. Never throws; all errors logged quietly.
 */
export async function announceVoiceMember(
  kind: 'joined' | 'left',
  displayName: string,
  memberId: string,
): Promise<void> {
  if (!activeSession?.active) return;
  const session = activeSession;

  // The initiator's join happened before `isCallActive()` returned true
  // (startCall fires on VoiceStateUpdate from the bot.ts layer). So when
  // this function gets called, the joiner is by definition a second+
  // participant.

  const key = `${kind}:${memberId}`;
  const now = Date.now();
  const prev = lastMemberAnnounceAt.get(key) || 0;
  if (now - prev < VOICE_MEMBER_ANNOUNCE_COOLDOWN_MS) return;
  lastMemberAnnounceAt.set(key, now);

  // Don't step on Cortana mid-reply — skip if she's currently speaking to
  // someone. They'll see the join silently in Discord UI anyway.
  if (session.outputActive) return;

  const pool = kind === 'joined' ? VOICE_JOIN_PHRASES : VOICE_LEAVE_PHRASES;
  const template = pool[Math.floor(Math.random() * pool.length)] ?? pool[0];
  const line = template.replace('{name}', String(displayName || 'someone').slice(0, 40));

  try {
    const audio = await withTimeout(
      textToSpeech(line, session.cortanaVoiceName),
      VOICE_PREFLIGHT_TIMEOUT_MS,
      'TTS announce member',
    );
    if (!activeSession?.active || !audio || audio.length === 0) return;
    await speakInTesterVC(audio);
    session.transcript?.push?.(`[${new Date().toLocaleTimeString()}] Cortana (announce): ${line}`);
  } catch (err) {
    // Announcements are cosmetic — don't disturb the call on failure.
    console.debug('[voice] announce failed:', errMsg(err));
  }
}

interface VoiceTestInjection {
  userId: string;
  username: string;
  text: string;
  language?: string;
}

interface TesterVoiceTurnInput {
  userId: string;
  username: string;
  text: string;
  language?: string;
}

export async function processTesterVoiceTurnForCall(input: TesterVoiceTurnInput): Promise<{ ok: boolean; mode?: 'voice' | 'injected'; reason?: string }> {
  if (!activeSession?.active) {
    return { ok: false, reason: 'No active voice call.' };
  }

  const text = String(input.text || '').trim();
  if (!text) {
    return { ok: false, reason: 'Transcript text is empty.' };
  }

  const preferRealVoice = String(process.env.ASAPTESTER_REAL_VOICE_TURNS || 'true').toLowerCase() !== 'false';
  const allowInjectionFallback = String(process.env.ASAPTESTER_REAL_VOICE_FALLBACK_INJECTION || 'true').toLowerCase() !== 'false';

  if (preferRealVoice) {
    try {
      await speakAsTesterInVoice(text, input.language);
      await postVoiceStageLog('tester_voice_played', `user=${input.username} chars=${text.length}`);
      return { ok: true, mode: 'voice' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown tester voice playback error';
      await postVoiceStageLog('tester_voice_play_failed', `user=${input.username} error=${reason}`, 'warn');
      if (!allowInjectionFallback) {
        return { ok: false, reason };
      }
    }
  }

  const injected = await injectVoiceTranscriptForTesting({
    userId: input.userId,
    username: input.username,
    text,
    language: input.language,
  });
  if (!injected.ok) {
    return { ok: false, reason: injected.reason || 'Failed to inject tester transcript.' };
  }
  return { ok: true, mode: 'injected' };
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
      sttProvider: 'elevenlabs',
    });
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unknown injection failure';
    await postVoiceStageLog('stt_injected_failed', `user=${username} error=${reason}`, 'warn');
    return { ok: false, reason };
  }
}
