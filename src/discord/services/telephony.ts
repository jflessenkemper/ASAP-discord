/**
 * Twilio telephony integration — lets users call Riley via a real phone number,
 * and lets Riley call out to a phone number. Uses the same Deepgram STT +
 * ElevenLabs TTS + Claude pipeline as the Discord voice system.
 *
 * Inbound:  User dials Twilio number → WebSocket media stream → Deepgram → Claude → ElevenLabs → Twilio
 * Outbound: Riley triggers call → Twilio REST API dials user → same pipeline
 */

import Twilio from 'twilio';
import { WebSocket, WebSocketServer } from 'ws';
import { Server as HttpServer } from 'http';
import { TextChannel } from 'discord.js';
import { startLiveTranscription, DeepgramLiveSession, isDeepgramAvailable } from '../voice/deepgram';
import { elevenLabsTTS } from '../voice/elevenlabs';
import { agentRespond, ConversationMessage, summarizeCall, CLAUDE_PHONE_MODEL } from '../claude';
import { getAgent, AgentId } from '../agents';
import { getMemoryContext, appendToMemory } from '../memory';

// ── Config ──
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER; // Australian number e.g. +61...
const SERVER_URL = process.env.SERVER_URL || process.env.FRONTEND_URL || '';

let twilioClient: Twilio.Twilio | null = null;
let callLogChannel: TextChannel | null = null;
let groupchatChannel: TextChannel | null = null;

function getTwilioClient(): Twilio.Twilio {
  if (!twilioClient) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required');
    }
    twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

export function setTelephonyChannels(callLog: TextChannel, groupchat: TextChannel): void {
  callLogChannel = callLog;
  groupchatChannel = groupchat;
}

export function isTelephonyAvailable(): boolean {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER);
}

// ── Known contacts (persisted to disk) ──
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const CONTACTS_FILE = join(process.cwd(), 'data', 'phone-contacts.json');

function loadContacts(): Record<string, string> {
  try {
    if (existsSync(CONTACTS_FILE)) {
      return JSON.parse(readFileSync(CONTACTS_FILE, 'utf-8'));
    }
  } catch {}
  return { '+61436012231': 'Jordan' };
}

function saveContacts(contacts: Record<string, string>): void {
  try {
    const dir = join(process.cwd(), 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
  } catch (err) {
    console.error('Failed to save contacts:', err instanceof Error ? err.message : 'Unknown');
  }
}

let knownContacts = loadContacts();

function identifyCaller(number: string): string | null {
  return knownContacts[number] || null;
}

/**
 * Learn a new contact — called when Riley discovers someone's name on a call.
 */
export function learnContact(number: string, name: string): void {
  let normalized = number.replace(/\\s+/g, '');
  if (normalized.startsWith('0')) normalized = '+61' + normalized.slice(1);
  else if (!normalized.startsWith('+')) normalized = '+61' + normalized;
  knownContacts[normalized] = name;
  saveContacts(knownContacts);
  logToDiscord(`📇 **Learned contact**: ${name} → ${normalized}`);
}

/**
 * Get all known contacts for display.
 */
export function getKnownContacts(): Record<string, string> {
  return { ...knownContacts };
}

// ── Active phone call sessions ──
interface PhoneSession {
  callSid: string;
  streamSid: string | null;
  ws: WebSocket | null;
  direction: 'inbound' | 'outbound';
  callerNumber: string;
  callerName: string | null;
  startTime: Date;
  transcript: string[];
  conversationHistory: ConversationMessage[];
  deepgramSession: DeepgramLiveSession | null;
  audioBuffer: Buffer[];
  processing: boolean;
  active: boolean;
  conferenceName: string | null;
}

const activeSessions = new Map<string, PhoneSession>();

// ── TwiML for inbound calls ──
/**
 * Returns TwiML XML that connects the caller straight to the WebSocket media stream.
 * No hold message — Riley greets via ElevenLabs TTS once the stream connects.
 */
export function getInboundTwiML(callerNumber?: string): string {
  const wsUrl = SERVER_URL.replace(/^https?/, 'wss') + '/api/webhooks/twilio/stream';
  // Pass caller number as a custom parameter so the WS handler can identify them
  const paramTag = callerNumber
    ? `\n      <Parameter name="callerNumber" value="${callerNumber}" />`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">${paramTag}
    </Stream>
  </Connect>
</Response>`;
}

/**
 * Returns TwiML to put a caller into a Twilio Conference room.
 */
export function getConferenceTwiML(conferenceName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference startConferenceOnEnter="true" endConferenceOnExit="false"
      beep="false">${conferenceName}</Conference>
  </Dial>
</Response>`;
}

// ── WebSocket media stream handler ──

/**
 * Attach the Twilio WebSocket media stream handler to an HTTP server.
 */
export function attachTelephonyWebSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/api/webhooks/twilio/stream') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    let sessionCallSid: string | null = null;

    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.event) {
          case 'connected':
            break;

          case 'start': {
            const callSid = msg.start.callSid;
            const streamSid = msg.start.streamSid;
            sessionCallSid = callSid;

            const session = activeSessions.get(callSid);
            if (session) {
              session.streamSid = streamSid;
              session.ws = ws;
              await startSessionSTT(session);
            } else {
              // Inbound call — create session
              // Extract caller number from custom parameters
              const callerNumber = msg.start.customParameters?.callerNumber || 'unknown';
              const callerName = identifyCaller(callerNumber);
              const confName = msg.start.customParameters?.conferenceName || null;
              const newSession: PhoneSession = {
                callSid,
                streamSid,
                ws,
                direction: 'inbound',
                callerNumber,
                callerName,
                startTime: new Date(),
                transcript: [],
                conversationHistory: [],
                deepgramSession: null,
                audioBuffer: [],
                processing: false,
                active: true,
                conferenceName: confName,
              };
              activeSessions.set(callSid, newSession);
              await startSessionSTT(newSession);

              const who = callerName || callerNumber;
              logToDiscord(`📞 **Inbound phone call** from ${who}`);
              newSession.transcript.push(`[${new Date().toLocaleTimeString()}] Inbound call from ${who}`);

              // Personalized greeting via ElevenLabs TTS (no robotic hold message)
              const greeting = callerName
                ? `Hey ${callerName}! It's Riley. What's up?`
                : `Hey! It's Riley. How can I help you?`;
              await speakToPhone(newSession, greeting);
            }
            break;
          }

          case 'media': {
            const session = sessionCallSid ? activeSessions.get(sessionCallSid) : null;
            if (!session?.active) break;

            // Twilio sends base64 µ-law 8kHz mono audio
            const audioChunk = Buffer.from(msg.media.payload, 'base64');
            // Convert µ-law to PCM s16le for Deepgram
            const pcm = mulawToPCM(audioChunk);

            if (session.deepgramSession) {
              // Upsample 8kHz mono to 48kHz stereo for Deepgram (matching Discord format)
              const upsampled = upsample8kTo48kStereo(pcm);
              session.deepgramSession.send(upsampled);
            }
            break;
          }

          case 'stop': {
            if (sessionCallSid) {
              const session = activeSessions.get(sessionCallSid);
              if (session) {
                await endPhoneSession(session);
              }
            }
            break;
          }
        }
      } catch (err) {
        console.error('Twilio WS error:', err instanceof Error ? err.message : 'Unknown');
      }
    });

    ws.on('close', () => {
      if (sessionCallSid) {
        const session = activeSessions.get(sessionCallSid);
        if (session?.active) {
          endPhoneSession(session).catch(console.error);
        }
      }
    });
  });
}

// ── STT setup for phone sessions ──

async function startSessionSTT(session: PhoneSession): Promise<void> {
  if (!isDeepgramAvailable()) {
    console.warn('Deepgram not available for phone STT');
    return;
  }

  let utteranceBuffer = '';
  let utteranceTimer: ReturnType<typeof setTimeout> | null = null;

  session.deepgramSession = await startLiveTranscription(
    (text: string, detectedLanguage?: string) => {
      // Accumulate fragments into full utterances
      utteranceBuffer += (utteranceBuffer ? ' ' : '') + text;

      if (utteranceTimer) clearTimeout(utteranceTimer);
      utteranceTimer = setTimeout(async () => {
        if (!utteranceBuffer.trim() || !session.active) return;
        const fullText = utteranceBuffer.trim();
        utteranceBuffer = '';

        await handlePhoneInput(session, fullText, detectedLanguage);
      }, 800); // 800ms after last fragment = full utterance
    },
    (err) => {
      console.error('Phone Deepgram error:', err.message);
    }
  );
}

// ── Voice input → Riley → TTS response ──

async function handlePhoneInput(session: PhoneSession, text: string, language?: string): Promise<void> {
  if (!session.active || session.processing) return;
  session.processing = true;

  try {
    const langTag = language && language !== 'en' ? ` [${language}]` : '';
    session.transcript.push(`[${new Date().toLocaleTimeString()}] Caller${langTag}: ${text}`);
    logToDiscord(`🎤 **Caller**: ${text}`);

    // Check for end-call commands
    if (/\b(goodbye|hang up|end call|that's all|bye)\b/i.test(text)) {
      await speakToPhone(session, "Goodbye! Have a great day.");
      // Give TTS time to play
      setTimeout(() => {
        hangUp(session.callSid).catch(console.error);
      }, 3000);
      return;
    }

    const riley = getAgent('executive-assistant' as AgentId);
    if (!riley) return;

    const rileyMemory = getMemoryContext('executive-assistant');
    const langHint = language && language !== 'en'
      ? `\nIMPORTANT: The caller is speaking ${language === 'zh' ? 'Mandarin Chinese' : language}. Respond in the SAME language.`
      : '';

    const callerLabel = session.callerName || session.callerNumber;
    const callerContext = session.callerName
      ? `You are on a phone call with ${session.callerName} (${session.callerNumber}). ${session.callerName} is the owner of ASAP — your boss.`
      : `You are on a phone call with ${session.callerNumber}.`;
    const confContext = session.conferenceName
      ? `\nThis is a GROUP call (conference: ${session.conferenceName}). There may be multiple people on the line. Be natural and address people by name when you can.\nIf you don't know someone on the call, politely ask their name early in the conversation. Once you learn it, mention it naturally so it gets recorded in the transcript.`
      : '';

    const context = `[Phone call from ${callerLabel}]: ${text}

${callerContext}${confContext}
Keep responses brief and conversational — you're on a phone call.
If you need to take any actions (code changes, etc.), tell the caller you'll handle it and then use your tools.
Do NOT use markdown formatting — this is spoken audio.${langHint}`;

    const response = await agentRespond(
      riley,
      [...rileyMemory, ...session.conversationHistory],
      context,
      undefined,
      { modelOverride: CLAUDE_PHONE_MODEL, maxTokens: 1024 }
    );

    session.conversationHistory.push(
      { role: 'user', content: `[Phone caller]: ${text}` },
      { role: 'assistant', content: `[Riley]: ${response}` }
    );

    // Trim history
    if (session.conversationHistory.length > 40) {
      session.conversationHistory.splice(0, session.conversationHistory.length - 40);
    }

    session.transcript.push(`[${new Date().toLocaleTimeString()}] Riley: ${response}`);
    logToDiscord(`📋 **Riley**: ${response.slice(0, 1900)}`);

    appendToMemory('executive-assistant', [
      { role: 'user', content: `[Phone from ${session.callerNumber}]: ${text}` },
      { role: 'assistant', content: `[Riley]: ${response}` },
    ]);

    // Try to learn names from conversation (e.g. "my name is Sarah", "I'm Sarah", "this is Sarah")
    const nameMatch = text.match(/(?:my name(?:'s| is)|i'm|i am|this is|call me)\s+([A-Z][a-z]+)/i);
    if (nameMatch && session.callerNumber !== 'unknown' && session.callerNumber !== 'conference') {
      const discoveredName = nameMatch[1];
      if (!identifyCaller(session.callerNumber)) {
        learnContact(session.callerNumber, discoveredName);
        session.callerName = discoveredName;
      }
    }

    await speakToPhone(session, response);
  } catch (err) {
    console.error('Phone input error:', err instanceof Error ? err.message : 'Unknown');
  } finally {
    session.processing = false;
  }
}

// ── TTS → Twilio audio ──

async function speakToPhone(session: PhoneSession, text: string): Promise<void> {
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN || !session.streamSid) return;

  try {
    // Get MP3 from ElevenLabs (same as Discord)
    const mp3Buffer = await elevenLabsTTS(text.slice(0, 500), 'Achernar');
    if (mp3Buffer.length === 0) return;

    // Convert MP3 to µ-law 8kHz for Twilio
    const mulawAudio = await mp3ToMulaw(mp3Buffer);

    // Send audio in chunks (Twilio expects base64 µ-law in 20ms frames)
    const CHUNK_SIZE = 160; // 160 bytes = 20ms at 8kHz µ-law
    for (let i = 0; i < mulawAudio.length; i += CHUNK_SIZE) {
      if (session.ws.readyState !== WebSocket.OPEN) break;
      const chunk = mulawAudio.subarray(i, i + CHUNK_SIZE);
      session.ws.send(JSON.stringify({
        event: 'media',
        streamSid: session.streamSid,
        media: { payload: chunk.toString('base64') },
      }));
    }

    // Mark to clear the stream buffer so Twilio plays our audio immediately
    session.ws.send(JSON.stringify({
      event: 'mark',
      streamSid: session.streamSid,
      mark: { name: `tts-${Date.now()}` },
    }));
  } catch (err) {
    console.error('Phone TTS error:', err instanceof Error ? err.message : 'Unknown');
  }
}

// ── Outbound call ──

/**
 * Make an outbound call to a phone number. Riley will speak to the callee.
 */
export async function makeOutboundCall(toNumber: string, greeting?: string): Promise<string> {
  const client = getTwilioClient();
  if (!TWILIO_PHONE_NUMBER) throw new Error('TWILIO_PHONE_NUMBER not configured');

  // Normalize Australian number
  let normalized = toNumber.replace(/\s+/g, '');
  if (normalized.startsWith('0')) {
    normalized = '+61' + normalized.slice(1);
  } else if (!normalized.startsWith('+')) {
    normalized = '+61' + normalized;
  }

  const wsUrl = SERVER_URL.replace(/^https?/, 'wss') + '/api/webhooks/twilio/stream';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  const call = await client.calls.create({
    to: normalized,
    from: TWILIO_PHONE_NUMBER,
    twiml,
  });

  // Pre-create session for this outbound call
  const callerName = identifyCaller(normalized);
  const session: PhoneSession = {
    callSid: call.sid,
    streamSid: null,
    ws: null,
    direction: 'outbound',
    callerNumber: normalized,
    callerName,
    startTime: new Date(),
    transcript: [],
    conversationHistory: [],
    deepgramSession: null,
    audioBuffer: [],
    processing: false,
    active: true,
    conferenceName: null,
  };
  activeSessions.set(call.sid, session);

  session.transcript.push(`[${new Date().toLocaleTimeString()}] Outbound call to ${normalized}`);
  logToDiscord(`📞 **Outbound call** to ${normalized}`);

  // Queue greeting to be spoken when stream connects
  if (greeting) {
    const waitForStream = setInterval(async () => {
      if (session.ws && session.streamSid) {
        clearInterval(waitForStream);
        await speakToPhone(session, greeting);
      }
      if (!session.active) clearInterval(waitForStream);
    }, 500);
    setTimeout(() => clearInterval(waitForStream), 30000); // Safety timeout
  }

  return call.sid;
}

/**
 * Hang up an active call.
 */
export async function hangUp(callSid: string): Promise<void> {
  try {
    const client = getTwilioClient();
    await client.calls(callSid).update({ status: 'completed' });
  } catch (err) {
    console.error('Hang up error:', err instanceof Error ? err.message : 'Unknown');
  }
}

// ── Session lifecycle ──

async function endPhoneSession(session: PhoneSession): Promise<void> {
  if (!session.active) return;
  session.active = false;

  // Close Deepgram
  session.deepgramSession?.close();

  const duration = Math.round((Date.now() - session.startTime.getTime()) / 1000 / 60);
  session.transcript.push(`[${new Date().toLocaleTimeString()}] Call ended`);

  // Post transcript to call-log
  const transcriptText = session.transcript.join('\n');
  if (callLogChannel) {
    await callLogChannel.send(
      `📋 **Phone Call Log — ${session.startTime.toLocaleDateString()} ${session.startTime.toLocaleTimeString()}**\n` +
      `Direction: ${session.direction}\n` +
      `Number: ${session.callerNumber}\n` +
      `Duration: ${duration} minutes\n\n` +
      `\`\`\`\n${transcriptText.slice(0, 1800)}\n\`\`\``
    );

    // AI summary
    try {
      const summary = await summarizeCall(session.transcript, ['Caller', 'Riley (Executive Assistant)']);
      await callLogChannel.send(`📝 **Summary**\n${summary}`);
    } catch {}
  }

  if (groupchatChannel) {
    await groupchatChannel.send(
      `📞 **Phone call ended** (${duration} min) — ${session.direction}\n` +
      `Summary posted in ${callLogChannel ? `<#${callLogChannel.id}>` : 'call-log'}`
    );
  }

  activeSessions.delete(session.callSid);
}

// ── Audio conversion utilities ──

/** µ-law to PCM s16le conversion table */
const MULAW_DECODE_TABLE = new Int16Array(256);
(function initMulawTable() {
  for (let i = 0; i < 256; i++) {
    let mulaw = ~i & 0xFF;
    const sign = mulaw & 0x80;
    const exponent = (mulaw >> 4) & 0x07;
    let mantissa = mulaw & 0x0F;
    mantissa = (mantissa << 1) | 0x21;
    mantissa <<= exponent;
    mantissa -= 0x21;
    MULAW_DECODE_TABLE[i] = sign ? -mantissa : mantissa;
  }
})();

/** PCM s16le to µ-law conversion */
function pcmSampleToMulaw(sample: number): number {
  const MAX = 32635;
  const BIAS = 0x84;

  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MAX) sample = MAX;
  sample += BIAS;

  let exponent = 7;
  const mask = 0x4000;
  for (let i = 0; i < 7; i++) {
    if (sample & (mask >> i)) { exponent = 7 - i; break; }
    if (i === 6) exponent = 0;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return mulawByte;
}

/** Convert µ-law 8kHz buffer to PCM s16le 8kHz */
function mulawToPCM(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    pcm.writeInt16LE(MULAW_DECODE_TABLE[mulaw[i]], i * 2);
  }
  return pcm;
}

/** Upsample 8kHz mono PCM s16le to 48kHz stereo PCM s16le (for Deepgram compatibility) */
function upsample8kTo48kStereo(pcm8k: Buffer): Buffer {
  const ratio = 6; // 48000/8000
  const samplesIn = pcm8k.length / 2;
  const out = Buffer.alloc(samplesIn * ratio * 4); // stereo = 2 channels * 2 bytes

  for (let i = 0; i < samplesIn; i++) {
    const sample = pcm8k.readInt16LE(i * 2);
    // Simple nearest-neighbor upsample + stereo duplication
    for (let r = 0; r < ratio; r++) {
      const outIdx = (i * ratio + r) * 4;
      out.writeInt16LE(sample, outIdx);      // Left
      out.writeInt16LE(sample, outIdx + 2);  // Right
    }
  }
  return out;
}

/**
 * Convert MP3 audio buffer to µ-law 8kHz mono for Twilio.
 * Uses ffmpeg (available in Cloud Run) for reliable transcoding.
 */
async function mp3ToMulaw(mp3: Buffer): Promise<Buffer> {
  const { execSync } = await import('child_process');
  const { writeFileSync, readFileSync, unlinkSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');

  const tmpIn = join(tmpdir(), `tts-${Date.now()}.mp3`);
  const tmpOut = join(tmpdir(), `tts-${Date.now()}.raw`);

  try {
    writeFileSync(tmpIn, mp3);

    // Convert MP3 → PCM s16le 8kHz mono using ffmpeg
    execSync(
      `ffmpeg -y -i "${tmpIn}" -ar 8000 -ac 1 -f s16le "${tmpOut}" 2>/dev/null`,
      { timeout: 10000 }
    );

    const pcm = readFileSync(tmpOut);

    // Convert PCM to µ-law
    const mulaw = Buffer.alloc(pcm.length / 2);
    for (let i = 0; i < mulaw.length; i++) {
      mulaw[i] = pcmSampleToMulaw(pcm.readInt16LE(i * 2));
    }

    return mulaw;
  } finally {
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}
  }
}

// ── Conference / group call support ──

/**
 * Start a conference call. Riley joins as an AI participant.
 * All listed numbers are called and joined to the same conference.
 */
export async function startConferenceCall(
  numbers: string[],
  conferenceName?: string
): Promise<string> {
  const client = getTwilioClient();
  if (!TWILIO_PHONE_NUMBER) throw new Error('TWILIO_PHONE_NUMBER not configured');

  const confName = conferenceName || `asap-conf-${Date.now()}`;

  // Call each participant and put them in the conference
  for (const raw of numbers) {
    let normalized = raw.replace(/\s+/g, '');
    if (normalized.startsWith('0')) normalized = '+61' + normalized.slice(1);
    else if (!normalized.startsWith('+')) normalized = '+61' + normalized;

    const twiml = getConferenceTwiML(confName);

    await client.calls.create({
      to: normalized,
      from: TWILIO_PHONE_NUMBER,
      twiml,
    });
  }

  // Connect Riley to the conference via a media stream so she can listen + speak
  const wsUrl = SERVER_URL.replace(/^https?/, 'wss') + '/api/webhooks/twilio/stream';
  const rileyTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="conferenceName" value="${confName}" />
    </Stream>
  </Connect>
  <Dial>
    <Conference startConferenceOnEnter="true" endConferenceOnExit="false"
      beep="false">${confName}</Conference>
  </Dial>
</Response>`;

  const rileyCall = await client.calls.create({
    to: TWILIO_PHONE_NUMBER,
    from: TWILIO_PHONE_NUMBER,
    twiml: rileyTwiml,
  });

  // Pre-create a session marked as conference
  const session: PhoneSession = {
    callSid: rileyCall.sid,
    streamSid: null,
    ws: null,
    direction: 'outbound',
    callerNumber: 'conference',
    callerName: null,
    startTime: new Date(),
    transcript: [],
    conversationHistory: [],
    deepgramSession: null,
    audioBuffer: [],
    processing: false,
    active: true,
    conferenceName: confName,
  };
  activeSessions.set(rileyCall.sid, session);

  const nameList = numbers.map(n => {
    let norm = n.replace(/\s+/g, '');
    if (norm.startsWith('0')) norm = '+61' + norm.slice(1);
    else if (!norm.startsWith('+')) norm = '+61' + norm;
    return identifyCaller(norm) || n;
  }).join(', ');
  logToDiscord(`📞 **Conference call started** — ${confName}\nParticipants: ${nameList} + Riley`);
  session.transcript.push(`[${new Date().toLocaleTimeString()}] Conference started: ${nameList} + Riley`);

  return confName;
}

/**
 * Add a participant to an existing conference.
 */
export async function addToConference(conferenceName: string, phoneNumber: string): Promise<void> {
  const client = getTwilioClient();
  if (!TWILIO_PHONE_NUMBER) throw new Error('TWILIO_PHONE_NUMBER not configured');

  let normalized = phoneNumber.replace(/\s+/g, '');
  if (normalized.startsWith('0')) normalized = '+61' + normalized.slice(1);
  else if (!normalized.startsWith('+')) normalized = '+61' + normalized;

  const twiml = getConferenceTwiML(conferenceName);

  await client.calls.create({
    to: normalized,
    from: TWILIO_PHONE_NUMBER,
    twiml,
  });

  const name = identifyCaller(normalized) || normalized;
  logToDiscord(`📞 **Added ${name}** to conference ${conferenceName}`);
}

// ── Discord logging helper ──

function logToDiscord(message: string): void {
  callLogChannel?.send(message.slice(0, 2000)).catch(() => {});
}
