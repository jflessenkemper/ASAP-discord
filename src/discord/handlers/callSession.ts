import { TextChannel, VoiceChannel, GuildMember } from 'discord.js';
import { VoiceConnection } from '@discordjs/voice';
import { getAgents, getAgent, AgentConfig, AgentId } from '../agents';
import { agentRespond, ConversationMessage, summarizeCall } from '../claude';
import { textToSpeech } from '../voice/tts';
import { joinVC, leaveVC, speakInVC, listenToUser, listenToAllMembers, VoiceTranscription } from '../voice/connection';
import { appendToMemory, getMemoryContext } from '../memory';
import { documentToChannel } from './documentation';

/** Only Riley (EA) and Ace (Developer) speak in voice calls */
const VOICE_SPEAKERS = new Set(['executive-assistant', 'developer']);

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
}

let activeSession: CallSession | null = null;

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
    await groupchat.send('⚠️ A call is already in progress. Say `LEAVE` to end it first.');
    return;
  }

  const connection = await joinVC(voiceChannel);

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
  };

  // Log call start
  const riley = getAgent('executive-assistant' as AgentId);
  const ace = getAgent('developer' as AgentId);

  await groupchat.send(
    `📞 **Voice call started**\n` +
      `Initiated by **${initiator.displayName}**\n` +
      `${riley?.emoji || '📋'} **Riley** and ${ace?.emoji || '💻'} **Ace** are on the line.\n\n` +
      `Speak in the **${voiceChannel.name}** voice channel. Use \`/leave\` to end the call.`
  );

  activeSession.transcript.push(
    `[${new Date().toLocaleTimeString()}] Call started by ${initiator.displayName}`
  );

  // Listen to ALL members in the voice channel (multi-member support)
  const unsub = listenToAllMembers(connection, voiceChannel, (transcription) => {
    if (activeSession) {
      activeSession.processingQueue = activeSession.processingQueue.then(() =>
        handleVoiceInput(transcription)
      );
    }
  });
  activeSession.unsubscribers.push(unsub);
}

/**
 * End the voice call session — disconnect, post summary.
 */
export async function endCall(): Promise<void> {
  if (!activeSession?.active) return;

  const session = activeSession;
  session.active = false;

  // Stop all listeners
  for (const unsub of session.unsubscribers) {
    unsub();
  }

  session.transcript.push(`[${new Date().toLocaleTimeString()}] Call ended`);

  // Leave voice channel
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
    await session.groupchat.send(
      `📞 **Call ended** (${duration} min)\nSummary posted in <#${session.callLog.id}>`
    );
  } catch (err) {
    console.error('Call summary error:', err instanceof Error ? err.message : 'Unknown');
    await session.groupchat.send(`📞 **Call ended** (${duration} min)`);
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

  // Log to transcript
  session.transcript.push(
    `[${transcription.timestamp.toLocaleTimeString()}] ${transcription.username}: ${userText}`
  );

  // Post the transcription to groupchat
  await session.groupchat.send(`🎤 **${transcription.username}**: ${userText}`);

  const riley = getAgent('executive-assistant' as AgentId);

  if (riley) {
    // Riley (EA) processes the input first and decides who should respond
    try {
      const rileyMemory = getMemoryContext('executive-assistant');
      const rileyContext = `[Voice from ${transcription.username}]: ${userText}

You are in a voice call. ${transcription.username} just spoke. Your job:
1. Interpret what they want
2. If it's a question you can answer directly, answer it
3. If it requires implementation, direct Ace (Developer) specifically
4. If it requires domain expertise, name which agent(s) should respond (e.g., "Kane, review this for security" or "Elena, what's the best schema?")
5. If you need their input, present options clearly

IMPORTANT: In your response, if you want Ace to implement something, say "@ace". For other agents, @mention them — they'll respond in text only (e.g., "@kane for security review"). Only you and Ace speak in voice. Other agents work via text.

Keep your spoken response brief — you're in a voice call, not a text chat.`;

      const response = await agentRespond(
        riley,
        [...rileyMemory, ...session.conversationHistory],
        rileyContext
      );

      session.conversationHistory.push({
        role: 'user',
        content: `[Voice from ${transcription.username}]: ${userText}`,
      });
      session.conversationHistory.push({
        role: 'assistant',
        content: `[Riley]: ${response}`,
      });

      session.transcript.push(
        `[${new Date().toLocaleTimeString()}] Riley (EA): ${response}`
      );

      // Run TTS generation, text message, and memory save in parallel
      const ttsPromise = textToSpeech(response.slice(0, 500), riley.voice).catch((ttsErr) => {
        console.error('TTS error for Riley:', ttsErr instanceof Error ? ttsErr.message : 'Unknown');
        return null;
      });

      await session.groupchat.send(`${riley.emoji} **${riley.name}**: ${response.slice(0, 1900)}`);
      appendToMemory('executive-assistant', [
        { role: 'user', content: `[Voice from ${transcription.username}]: ${userText}` },
        { role: 'assistant', content: `[Riley]: ${response}` },
      ]);

      // Speak Riley's response (TTS was started in parallel above)
      const audioBuffer = await ttsPromise;
      if (audioBuffer && session.active) {
        await speakInVC(audioBuffer);
      }

      // Check if Riley directed Ace
      const directedAgents = parseDirectedAgents(response);
      const aceDirected = directedAgents.includes('developer');

      if (aceDirected) {
        const ace = getAgent('developer' as AgentId);
        if (ace && session.active) {
          try {
            const aceMemory = getMemoryContext('developer');
            const aceResponse = await agentRespond(
              ace,
              [...aceMemory, ...session.conversationHistory],
              `[Riley directed you in voice call]: ${response}\n\n[Original voice from ${transcription.username}]: ${userText}`
            );

            session.conversationHistory.push({
              role: 'assistant',
              content: `[Ace]: ${aceResponse}`,
            });

            if (session.conversationHistory.length > 40) {
              session.conversationHistory.splice(0, session.conversationHistory.length - 40);
            }

            session.transcript.push(
              `[${new Date().toLocaleTimeString()}] Ace (Developer): ${aceResponse}`
            );

            // Run TTS generation, text message, and memory save in parallel
            const aceTtsPromise = textToSpeech(aceResponse.slice(0, 500), ace.voice).catch((ttsErr) => {
              console.error('TTS error for Ace:', ttsErr instanceof Error ? ttsErr.message : 'Unknown');
              return null;
            });

            await session.groupchat.send(`${ace.emoji} **Ace**: ${aceResponse.slice(0, 1900)}`);
            appendToMemory('developer', [
              { role: 'user', content: `[Directed by Riley for voice call]: ${userText.slice(0, 500)}` },
              { role: 'assistant', content: `[Ace]: ${aceResponse}` },
            ]);
            await documentToChannel('developer', `Responded in voice call: ${aceResponse.slice(0, 300)}`);

            // Ace speaks in VC (TTS was started in parallel above)
            const aceAudio = await aceTtsPromise;
            if (aceAudio && session.active) {
              await speakInVC(aceAudio);
            }
          } catch (err) {
            console.error('Ace voice response error:', err instanceof Error ? err.message : 'Unknown');
          }
        }
      }

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
            `[Riley directed you during voice call]: ${response}\n[Original from ${transcription.username}]: ${userText}`
          );
          await session.groupchat.send(`${agent.emoji} **${agent.name.split(' ')[0]}** (text): ${agentResponse.slice(0, 1900)}`);
          appendToMemory(agentId, [
            { role: 'user', content: `[Voice call directive]: ${userText.slice(0, 500)}` },
            { role: 'assistant', content: `[${agent.name}]: ${agentResponse}` },
          ]);
          await documentToChannel(agentId, `Responded in text during VC: ${agentResponse.slice(0, 300)}`);
        } catch (err) {
          console.error(`${agent.name} text response error:`, err instanceof Error ? err.message : 'Unknown');
        }
      }
    } catch (err) {
      console.error('Riley voice error:', err instanceof Error ? err.message : 'Unknown');
      await session.groupchat.send('⚠️ Riley had an error processing voice input.');
    }
  } else {
    await session.groupchat.send('⚠️ Riley is unavailable. Voice input not processed.');
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
