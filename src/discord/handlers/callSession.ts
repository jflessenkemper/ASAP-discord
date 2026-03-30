import { TextChannel, VoiceChannel, GuildMember } from 'discord.js';
import { getAgent, AgentId } from '../agents';
import { agentRespond, ConversationMessage, summarizeCall } from '../claude';
import { textToSpeech } from '../voice/tts';
import { joinVC, leaveVC, speakInVC, speakInVCWithOptions, stopVCPlayback, listenToAllMembersSmart, getConnection, VoiceTranscription } from '../voice/connection';
import { appendToMemory, getMemoryContext } from '../memory';
import { documentToChannel } from './documentation';
import { isGeminiOverLimit } from '../usage';
import { isDeepgramAvailable } from '../voice/deepgram';
import { postDiagnostic, mirrorAgentResponse, mirrorVoiceTranscript } from '../services/diagnosticsWebhook';
import { getWebhook } from '../services/webhooks';
import { getThinkingChime } from '../voice/thinkingSound';
import { recordVoiceCallStart, recordVoiceCallEnd, recordThinkingChimePlayed } from '../metrics';

/** Only Riley (EA) and Ace (Developer) speak in voice calls */
const VOICE_SPEAKERS = new Set(['executive-assistant', 'developer']);

/** Heartbeat interval to detect stale connections (every 2 minutes) */
const HEARTBEAT_INTERVAL = 2 * 60 * 1000;
/** Max conversation history in a call */
const MAX_CALL_HISTORY = 40;
const VOICE_PREFLIGHT_TIMEOUT_MS = parseInt(process.env.VOICE_PREFLIGHT_TIMEOUT_MS || '15000', 10);
const VOICE_MAX_TOKENS_RILEY = parseInt(process.env.VOICE_MAX_TOKENS_RILEY || '220', 10);
const VOICE_MAX_TOKENS_ACE = parseInt(process.env.VOICE_MAX_TOKENS_ACE || '260', 10);
const VOICE_MAX_TOKENS_SPECIALIST = parseInt(process.env.VOICE_MAX_TOKENS_SPECIALIST || '220', 10);
const VOICE_STREAM_PARTIAL_MIN_CHARS = parseInt(process.env.VOICE_STREAM_PARTIAL_MIN_CHARS || '70', 10);
const VOICE_STREAM_FORCE_CHARS = parseInt(process.env.VOICE_STREAM_FORCE_CHARS || '160', 10);
const VOICE_INTERRUPT_MIN_OUTPUT_ACTIVE_MS = parseInt(process.env.VOICE_INTERRUPT_MIN_OUTPUT_ACTIVE_MS || '350', 10);

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
  // Handle URLs, decimals, abbreviations, and code by using a more careful pattern.
  // First, protect URLs and common abbreviations from splitting.
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
async function speakPipelined(text: string, voice: string, signal?: AbortSignal): Promise<void> {
  const sentences = splitSentences(text.slice(0, 500));
  if (sentences.length === 0) return;

  if (sentences.length === 1) {
    if (signal?.aborted) return;
    const audio = await textToSpeech(sentences[0], voice);
    if (signal?.aborted) return;
    if (activeSession?.active && audio) await speakInVCWithOptions(audio, { signal });
    return;
  }

  // Start TTS for first sentence
  let nextTts: Promise<Buffer> = textToSpeech(sentences[0], voice);

  for (let i = 0; i < sentences.length; i++) {
    if (signal?.aborted) break;
    const audio = await nextTts;
    if (!activeSession?.active || signal?.aborted) break;

    // Prefetch next sentence's TTS while this one plays
    if (i + 1 < sentences.length) {
      nextTts = textToSpeech(sentences[i + 1], voice);
    }

    await speakInVCWithOptions(audio, { signal });
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

  if (boundary < 0 && remaining.length >= VOICE_STREAM_FORCE_CHARS) {
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

function createLiveSpeechStreamer(
  voice: string,
  signal: AbortSignal,
  isCurrentTurn: () => boolean,
  turnId: number
): {
  onPartialText: (partialText: string) => Promise<void>;
  finalize: (finalText: string) => Promise<void>;
} {
  let spokenUntil = 0;
  let latestText = '';
  let speakQueue = Promise.resolve();
  let lastSpokenNormalized = '';

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
        await speakPipelined(toSpeak, voice, signal);
      })
      .catch(() => {
        // Best-effort: interruption/cleanup paths can cancel queued speech.
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
    },
  };
}

export interface CallSession {
  active: boolean;
  startTime: Date;
  transcript: string[];
  conversationHistory: ConversationMessage[];
  unsubscribers: Array<() => void>;
  voiceChannel: VoiceChannel;
  groupchat: TextChannel;
  callLog: TextChannel;
  processingQueue: Promise<void>;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  currentAbortController: AbortController | null;
  currentTurnId: number;
  outputActive: boolean;
  outputStartedAt: number;
  lastInterruptAt: number;
}

let activeSession: CallSession | null = null;

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
  const agent = getAgent(agentId);
  if (agent) {
    try {
      const wh = await getWebhook(channel);
      await wh.send({
        content,
        username: `${agent.emoji} ${agent.name}`,
        avatarURL: agent.avatarUrl,
      });
      return;
    } catch {
      // fall through
    }
  }
  await channel.send(content).catch(() => {});
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

  await sendAsAgent(groupchat, `📞 Connecting Riley to **${voiceChannel.name}** and running voice preflight...`);

  const connection = await joinVC(voiceChannel);
  recordVoiceCallStart();

  activeSession = {
    active: true,
    startTime: new Date(),
    transcript: [],
    conversationHistory: [],
    unsubscribers: [],
    voiceChannel,
    groupchat,
    callLog,
    processingQueue: Promise.resolve(),
    heartbeatTimer: null,
    currentAbortController: null,
    currentTurnId: 0,
    outputActive: false,
    outputStartedAt: 0,
    lastInterruptAt: 0,
  };

  // Heartbeat — detect disconnected voice channel
  activeSession.heartbeatTimer = setInterval(() => {
    if (!activeSession?.active) return;
    try {
      const conn = getConnection();
      if (!conn || conn.state.status === 'destroyed' || conn.state.status === 'disconnected') {
        console.warn('Voice connection lost — ending call');
        endCall().catch((err) => console.error('Heartbeat endCall error:', err instanceof Error ? err.message : 'Unknown'));
      }
    } catch (err) {
      console.error('Heartbeat error:', err instanceof Error ? err.message : 'Unknown');
    }
  }, HEARTBEAT_INTERVAL);

  // Log call start
  const riley = getAgent('executive-assistant' as AgentId);
  const ace = getAgent('developer' as AgentId);

  activeSession.transcript.push(
    `[${new Date().toLocaleTimeString()}] Call started by ${initiator.displayName}`
  );

  // Voice output self-test: fail fast with a clear operator hint instead of silent VC.
  try {
    const checkAudio = await withTimeout(
      textToSpeech('Voice channel connected. Riley is ready.'),
      VOICE_PREFLIGHT_TIMEOUT_MS,
      'TTS preflight'
    );
    await withTimeout(speakInVC(checkAudio), VOICE_PREFLIGHT_TIMEOUT_MS, 'Voice playback preflight');
    await postDiagnostic('Voice self-test passed at call start.', {
      level: 'info',
      source: 'callSession.startCall',
      detail: `Channel=${voiceChannel.name} Initiator=${initiator.displayName}`,
    });

    await sendAsAgent(
      groupchat,
      `✅ **Voice call started**\n` +
        `Initiated by **${initiator.displayName}**\n` +
        `${riley?.emoji || '📋'} **Riley** and ${ace?.emoji || '💻'} **Ace** are on the line and listening now.\n\n` +
        `Speak in **${voiceChannel.name}**. Say "leave" or ask Riley to end the call.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('Voice output self-test failed:', msg);
    await postDiagnostic('Voice self-test failed.', {
      level: 'error',
      source: 'callSession.startCall',
      detail: msg,
    });
    await sendAsAgent(
      groupchat,
      `⚠️ Voice preflight failed: ${msg}. I am leaving voice so you are not stuck waiting on silence.`
    );
    leaveVC();
    recordVoiceCallEnd();
    if (activeSession?.heartbeatTimer) {
      clearInterval(activeSession.heartbeatTimer);
    }
    activeSession = null;
    return;
  }

  // Listen to ALL members using best available STT (Deepgram real-time or Gemini batch)
  const unsub = listenToAllMembersSmart(connection, voiceChannel, (transcription) => {
    if (activeSession) {
      activeSession.processingQueue = activeSession.processingQueue.then(() =>
        handleVoiceInput(transcription)
      ).catch((err) => {
        console.error('Voice processing error:', err instanceof Error ? err.message : 'Unknown');
      });
    }
  });
  activeSession.unsubscribers.push(unsub);

  const onSpeakingStart = (userId: string) => {
    if (!activeSession?.active) return;
    const member = voiceChannel.members.get(userId);
    if (!member || member.user.bot) return;
    // Only barge-in when Riley is actively playing TTS audio — not during the
    // thinking/LLM phase. Interrupting the LLM call while the user waits for a
    // response would silently abort it, creating the symptom of "chime plays but
    // Riley never responds".
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

  // Stop heartbeat
  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }

  // Stop all listeners
  for (const unsub of session.unsubscribers) {
    unsub();
  }

  session.transcript.push(`[${new Date().toLocaleTimeString()}] Call ended`);

  // Leave voice channel
    recordVoiceCallEnd();
  leaveVC();

  // Post transcript to call-log
  const duration = Math.round(
    (Date.now() - session.startTime.getTime()) / 1000 / 60
  );

  const transcriptText = session.transcript.join('\n');

  await session.callLog.send(
    `📋 **Call Log — ${session.startTime.toLocaleDateString()} ${session.startTime.toLocaleTimeString()}**\n` +
      `Duration: ${duration} minutes\n\n` +
      `\`\`\`\n${transcriptText.slice(0, 1800)}\n\`\`\``
  );

  // Generate and post AI summary
  try {
    const participants = ['User', 'Riley (Executive Assistant)', 'Ace (Developer)'];
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
  const userText = transcription.text;
  const turnId = session.currentTurnId + 1;
  const abortController = new AbortController();
  const { signal } = abortController;

  session.currentAbortController?.abort();
  session.currentAbortController = abortController;
  session.currentTurnId = turnId;
  session.outputActive = false;
  session.outputStartedAt = 0;

  const isCurrentTurn = () =>
    activeSession?.active === true &&
    activeSession.currentTurnId === turnId &&
    !signal.aborted;

  try {
    // Log to transcript
    const langTag = transcription.language && transcription.language !== 'en'
      ? ` [${transcription.language}]` : '';
    session.transcript.push(
      `[${transcription.timestamp.toLocaleTimeString()}] ${transcription.username}${langTag}: ${userText}`
    );

    // Post the transcription to call log
    await session.callLog.send(`🎤 **${transcription.username}**: ${userText}`);
    await mirrorVoiceTranscript(transcription.username, userText, transcription.language);
    if (!isCurrentTurn()) return;

    const riley = getAgent('executive-assistant' as AgentId);

    if (riley) {
      // Riley (EA) processes the input first and decides who should respond
      try {
      const rileyMemory = getMemoryContext('executive-assistant');
      const langHint = transcription.language && transcription.language !== 'en'
        ? `\n\nIMPORTANT: The speaker is using ${transcription.language === 'zh' ? 'Mandarin Chinese' : transcription.language}. Respond in the SAME language they spoke in. The TTS system supports multilingual output.`
        : '';
      const rileyContext = `[Voice from ${transcription.username}]: ${userText}

You are in a voice call. ${transcription.username} just spoke. Your job:
1. Interpret what they want
2. If it's a question you can answer directly, answer it
3. If it requires implementation, direct Ace (Developer) specifically
4. If it requires domain expertise, name which agent(s) should respond (e.g., "Kane, review this for security" or "Elena, what's the best schema?")
5. If you need their input, present options clearly

IMPORTANT: In your response, if you want Ace to implement something, say "@ace". For other agents, @mention them — they'll respond in text only (e.g., "@kane for security review"). Only you and Ace speak in voice. Other agents work via text.

Keep your spoken response very brief (normally 1-3 short sentences) — you're in a voice call, not a text chat.${langHint}`;

      // ── Thinking chime ────────────────────────────────────────────────────
      // Play a soft ascending chime the instant the LLM call starts so the user
      // immediately hears "I heard you, I'm thinking" — same UX as Grok/ChatGPT.
      // Runs concurrently with agentRespond (~750 ms vs 1-2 s LLM) → zero latency cost.
      const chimePromise = speakInVCWithOptions(getThinkingChime(), { signal })
        .then(() => recordThinkingChimePlayed())
        .catch((err) => console.warn('[VOICE] Thinking chime failed:', err instanceof Error ? err.message : String(err)));
      const rileyStreamer = createLiveSpeechStreamer(riley.voice, signal, isCurrentTurn, turnId);

      const response = await agentRespond(
        riley,
        [...rileyMemory, ...session.conversationHistory],
        rileyContext,
        undefined,
        {
          signal,
          maxTokens: VOICE_MAX_TOKENS_RILEY,
          onPartialText: async (partialText) => {
            await rileyStreamer.onPartialText(partialText);
          },
        }
      );
      if (!isCurrentTurn() || !response.trim()) return;

      // Chime is usually already done by now, but wait before starting TTS
      await chimePromise;
      if (!isCurrentTurn()) return;

      session.conversationHistory.push({
        role: 'user',
        content: `[Voice from ${transcription.username}]: ${userText}`,
      });
      session.conversationHistory.push({ role: 'assistant', content: `[Riley]: ${response}` });

      session.transcript.push(
        `[${new Date().toLocaleTimeString()}] Riley (EA): ${response}`
      );

      // Send text to call-log (not groupchat — keep it clean)
      await session.callLog.send(`${riley.emoji} **${riley.name}**: ${response.slice(0, 1900)}`);
      await mirrorAgentResponse(riley.name, 'call-log', response);
      appendToMemory('executive-assistant', [
        { role: 'user', content: `[Voice from ${transcription.username}]: ${userText}` },
        { role: 'assistant', content: `[Riley]: ${response}` },
      ]);
      if (!isCurrentTurn()) return;

      // Live partial speech: speak sentence chunks as they form, then flush tail.
      try {
        await rileyStreamer.finalize(response);
      } catch (ttsErr) {
        if (!isCurrentTurn()) return;
        console.error('TTS error for Riley:', ttsErr instanceof Error ? ttsErr.message : 'Unknown');
        await postDiagnostic('Riley TTS playback failed during call.', {
          level: 'error',
          source: 'callSession.handleVoiceInput',
          detail: ttsErr instanceof Error ? ttsErr.message : 'Unknown',
        });
        sendAsAgent(session.groupchat, '⚠️ Voice playback unavailable — check call-log for Riley\'s response.').catch(() => {});
      }
      if (!isCurrentTurn()) return;

      // Check if Riley directed Ace
      const directedAgents = parseDirectedAgents(response);
      const aceDirected = directedAgents.includes('developer');

      if (aceDirected) {
        const ace = getAgent('developer' as AgentId);
        if (ace && session.active) {
          try {
            const aceMemory = getMemoryContext('developer');
            const aceStreamer = createLiveSpeechStreamer(ace.voice, signal, isCurrentTurn, turnId);
            const aceResponse = await agentRespond(
              ace,
              [...aceMemory, ...session.conversationHistory],
              `[Riley directed you in voice call]: ${response}\n\n[Original voice from ${transcription.username}]: ${userText}`,
              undefined,
              {
                signal,
                maxTokens: VOICE_MAX_TOKENS_ACE,
                onPartialText: async (partialText) => {
                  await aceStreamer.onPartialText(partialText);
                },
              }
            );
            if (!isCurrentTurn() || !aceResponse.trim()) return;

            session.conversationHistory.push({
              role: 'assistant',
              content: `[Ace]: ${aceResponse}`,
            });

            if (session.conversationHistory.length > MAX_CALL_HISTORY) {
              session.conversationHistory.splice(0, session.conversationHistory.length - MAX_CALL_HISTORY);
            }
            session.transcript.push(
              `[${new Date().toLocaleTimeString()}] Ace (Developer): ${aceResponse}`
            );

            // Send text to call-log
            await session.callLog.send(`${ace.emoji} **Ace**: ${aceResponse.slice(0, 1900)}`);
            await mirrorAgentResponse(ace.name, 'call-log', aceResponse);
            appendToMemory('developer', [
              { role: 'user', content: `[Directed by Riley for voice call]: ${userText.slice(0, 500)}` },
              { role: 'assistant', content: `[Ace]: ${aceResponse}` },
            ]);
            await documentToChannel('developer', `Responded in voice call: ${aceResponse.slice(0, 300)}`);

            // Live partial speech: speak sentence chunks as they form, then flush tail.
            try {
              await aceStreamer.finalize(aceResponse);
            } catch (ttsErr) {
              if (!isCurrentTurn()) return;
              console.error('TTS error for Ace:', ttsErr instanceof Error ? ttsErr.message : 'Unknown');
              await postDiagnostic('Ace TTS playback failed during call.', {
                level: 'error',
                source: 'callSession.handleVoiceInput',
                detail: ttsErr instanceof Error ? ttsErr.message : 'Unknown',
              });
              sendAsAgent(session.groupchat, '⚠️ Voice playback unavailable — check call-log for Ace\'s response.').catch(() => {});
            }
          } catch (err) {
            if (!isCurrentTurn()) return;
            console.error('Ace voice response error:', err instanceof Error ? err.message : 'Unknown');
          }
        }
      }
      if (!isCurrentTurn()) return;

      // Other sub-agents don't speak in VC — they work in text only
      const otherAgents = directedAgents.filter((id) => !VOICE_SPEAKERS.has(id));
      for (const agentId of otherAgents) {
        const agent = getAgent(agentId as AgentId);
        if (!agent) continue;

        const agentMemory = getMemoryContext(agentId);
        try {
          const agentResponse = await agentRespond(
            agent,
            [...agentMemory, ...session.conversationHistory],
            `[Riley directed you during voice call]: ${response}\n[Original from ${transcription.username}]: ${userText}`,
            undefined,
            { signal, maxTokens: VOICE_MAX_TOKENS_SPECIALIST }
          );
          if (!isCurrentTurn() || !agentResponse.trim()) return;
          await sendAsAgent(session.groupchat, agentResponse.slice(0, 1900), agentId as AgentId);
          await mirrorAgentResponse(agent.name, 'groupchat', agentResponse);
          appendToMemory(agentId, [
            { role: 'user', content: `[Voice call directive]: ${userText.slice(0, 500)}` },
            { role: 'assistant', content: `[${agent.name}]: ${agentResponse}` },
          ]);
          await documentToChannel(agentId, `Responded in text during VC: ${agentResponse.slice(0, 300)}`);
        } catch (err) {
          if (!isCurrentTurn()) return;
          console.error(`${agent.name} text response error:`, err instanceof Error ? err.message : 'Unknown');
        }
      }
      } catch (err) {
        if (!isCurrentTurn()) return;
        console.error('Riley voice error:', err instanceof Error ? err.message : 'Unknown');
        await sendAsAgent(session.groupchat, '⚠️ Riley had an error processing voice input.');
      }
    } else {
      await sendAsAgent(session.groupchat, '⚠️ Riley is unavailable. Voice input not processed.');
    }
  } finally {
    if (session.currentTurnId === turnId) {
      session.currentAbortController = null;
      session.outputActive = false;
      session.outputStartedAt = 0;
    }
  }
}

/** Parse agent IDs that Riley directed in her response */
function parseDirectedAgents(response: string): string[] {
  const nameToId: Record<string, string> = {
    ace: 'developer', max: 'qa', sophie: 'ux-reviewer',
    kane: 'security-auditor', raj: 'api-reviewer', elena: 'dba',
    kai: 'performance', jude: 'devops', liv: 'copywriter', harper: 'lawyer',
    mia: 'ios-engineer', leo: 'android-engineer',
  };

  const found = new Set<string>();
  // Strict @name matching with word boundaries to avoid false positives
  for (const [name, id] of Object.entries(nameToId)) {
    const re = new RegExp(`@${name}\\b`, 'i');
    if (re.test(response)) {
      found.add(id);
    }
  }

  return [...found];
}

export function isCallActive(): boolean {
  return activeSession?.active ?? false;
}

export function getActiveSession(): CallSession | null {
  return activeSession;
}
