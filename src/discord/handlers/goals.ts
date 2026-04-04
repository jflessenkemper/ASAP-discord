import { Message, TextChannel } from 'discord.js';
import { getAgent, AgentId, AgentConfig } from '../agents';
import { agentRespond, ConversationMessage, extractAgentResponseEnvelope } from '../claude';
import { appendToMemory, getMemoryContext, loadMemory, saveMemory, compressMemory } from '../memory';
import { documentToChannel } from './documentation';
import { sendAgentMessage } from './textChannel';
import { getWebhook } from '../services/webhooks';

const goalsHistory: ConversationMessage[] = loadMemory('goals');
const MAX_HISTORY = 40;

let pendingDecision = false;
let goalsQueue: Promise<void> = Promise.resolve();

export function isDecisionPending(): boolean {
  return pendingDecision;
}

export function clearDecision(): void {
  pendingDecision = false;
}

/**
 * Handle a message in the #goals channel.
 * Riley (Executive Assistant) receives the goal, creates a plan,
 * and directs Ace (Developer) to implement. Ace pulls in specialists only when needed.
 */
export async function handleGoalsMessage(
  message: Message,
  goalsChannel: TextChannel,
  groupchat: TextChannel
): Promise<void> {
  const content = message.content.trim();
  if (!content) return;

  goalsQueue = goalsQueue.then(() =>
    processGoalsMessage(message, content, goalsChannel, groupchat)
  ).catch((err) => {
    console.error('Goals queue error:', err instanceof Error ? err.message : 'Unknown');
  });
}

/** Send a tool notification as an agent via webhook */
async function sendGoalsToolNotification(channel: TextChannel, agent: AgentConfig, summary: string): Promise<void> {
  try {
    const wh = await getWebhook(channel);
    await wh.send({
      content: `🔧 ${summary}`,
      username: `${agent.emoji} ${agent.name}`,
      avatarURL: agent.avatarUrl,
    });
  } catch (err) {
    console.warn(`Webhook tool notification failed for ${agent.name}:`, err instanceof Error ? err.message : 'Unknown');
  }
}

async function processGoalsMessage(
  message: Message,
  content: string,
  goalsChannel: TextChannel,
  groupchat: TextChannel
): Promise<void> {
  const senderName = message.member?.displayName || message.author.username;
  const riley = getAgent('executive-assistant' as AgentId);
  const ace = getAgent('developer' as AgentId);

  if (!riley || !ace) return;

  if (pendingDecision) {
    pendingDecision = false;
    await goalsChannel.sendTyping();

    const decisionContext = `[${senderName} responded to your decision request]: ${content}

The user has made their choice. Acknowledge it briefly, then continue executing the plan. Start with Ace only; he can involve any needed specialists after he inspects the work.`;

    try {
      const rileyMemory = getMemoryContext('executive-assistant');
      const rileyResponseRaw = await agentRespond(riley, [...rileyMemory, ...goalsHistory], decisionContext, async (_toolName, summary) => {
        sendGoalsToolNotification(goalsChannel, riley, summary).catch(() => {});
      }, { outputMode: 'machine_json' });
      const rileyEnvelope = extractAgentResponseEnvelope(rileyResponseRaw);
      const rileyResponse = rileyEnvelope?.human || rileyResponseRaw;

      await sendAgentMessage(goalsChannel, riley, rileyResponse);
      goalsHistory.push({ role: 'user', content: `[${senderName} decision]: ${content}` });
      goalsHistory.push({ role: 'assistant', content: `[${riley.name}]: ${rileyResponse}` });
      appendToMemory('executive-assistant', [
        { role: 'user', content: `[${senderName} decision]: ${content}` },
        { role: 'assistant', content: `[Riley]: ${rileyResponse}` },
      ]);
      documentToChannel('executive-assistant', `Received decision from ${senderName}: "${content.slice(0, 200)}". Continuing plan.`).catch(() => {});

      if (rileyResponse.includes('🛑') || rileyResponse.includes('Decision Required')) {
        pendingDecision = true;
        trimHistory();
        return;
      }

      await executeAceStep(ace, riley, rileyResponse, senderName, goalsChannel);
      trimHistory();

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('Goals decision handler error:', errMsg);
      const short = errMsg.length > 200 ? errMsg.slice(0, 200) + '…' : errMsg;
      try {
        const wh = await getWebhook(goalsChannel);
        await wh.send({ content: `⚠️ Error processing your decision:\n\`\`\`${short}\`\`\``, username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
      } catch {
        await goalsChannel.send(`⚠️ Error processing your decision:\n\`\`\`${short}\`\`\``);
      }
    }
    return;
  }

  await goalsChannel.sendTyping();

  const goalContext = `[GOAL from ${senderName}]: ${content}

You are in the #goals channel. ${senderName} has given you a goal. Your job:
1. Analyze the goal and ask clarifying questions if it's too vague
2. Create a clear plan with numbered steps and agent assignments
3. If you need Jordan's input on an approach, use the Decision Protocol (🛑 Decision Required)
4. If the goal is clear, create the plan and then give Ace (Developer) his first instruction

Remember: You plan and coordinate. Start with Ace first for execution. Ace can involve Harper or other specialists only if they are actually needed.`;

  try {
    const rileyMemory = getMemoryContext('executive-assistant');
    const rileyResponseRaw = await agentRespond(riley, [...rileyMemory, ...goalsHistory], goalContext, async (_toolName, summary) => {
      sendGoalsToolNotification(goalsChannel, riley, summary).catch(() => {});
    }, { outputMode: 'machine_json' });
    const rileyEnvelope = extractAgentResponseEnvelope(rileyResponseRaw);
    const rileyResponse = rileyEnvelope?.human || rileyResponseRaw;

    await sendAgentMessage(goalsChannel, riley, rileyResponse);

    goalsHistory.push({ role: 'user', content: `[${senderName}]: ${content}` });
    goalsHistory.push({ role: 'assistant', content: `[${riley.name}]: ${rileyResponse}` });
    appendToMemory('executive-assistant', [
      { role: 'user', content: `[GOAL from ${senderName}]: ${content}` },
      { role: 'assistant', content: `[Riley]: ${rileyResponse}` },
    ]);
    documentToChannel('executive-assistant', `Received goal from ${senderName}: "${content.slice(0, 200)}". Created plan.`).catch(() => {});

    if (rileyResponse.includes('🛑') || rileyResponse.includes('Decision Required')) {
      pendingDecision = true;
      trimHistory();
      return;
    }

    await executeAceStep(ace, riley, rileyResponse, senderName, goalsChannel);

    trimHistory();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Goals handler error:', errMsg);
    const short = errMsg.length > 200 ? errMsg.slice(0, 200) + '…' : errMsg;
    try {
      const wh = await getWebhook(goalsChannel);
      await wh.send({ content: `⚠️ Error processing this goal:\n\`\`\`${short}\`\`\``, username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
    } catch {
      await goalsChannel.send(`⚠️ Error processing this goal:\n\`\`\`${short}\`\`\``);
    }
  }
}

/**
 * Direct Ace to implement based on Riley's plan.
 */
async function executeAceStep(
  ace: ReturnType<typeof getAgent> & {},
  riley: ReturnType<typeof getAgent> & {},
  rileyPlan: string,
  senderName: string,
  goalsChannel: TextChannel
): Promise<void> {
  await goalsChannel.sendTyping();

  const aceContext = `[INSTRUCTION from Riley (Executive Assistant)]:
${rileyPlan}

Riley has created this plan based on a goal from ${senderName}. Implement the steps assigned to you. Start the work yourself first, then involve any specialists only if they are actually needed. Use your repo tools to read, write, and edit code. Report back what you've done.`;

  const aceMemory = getMemoryContext('developer');
  const aceResponse = await agentRespond(ace, [...aceMemory, ...goalsHistory], aceContext, async (_toolName, summary) => {
    sendGoalsToolNotification(goalsChannel, ace, summary).catch(() => {});
  });

  await sendAgentMessage(goalsChannel, ace, aceResponse);

  goalsHistory.push({ role: 'user', content: `[Riley's instruction to Ace]` });
  goalsHistory.push({ role: 'assistant', content: `[${ace.name}]: ${aceResponse}` });
  appendToMemory('developer', [
    { role: 'user', content: `[Instruction from Riley]: ${rileyPlan.slice(0, 1000)}` },
    { role: 'assistant', content: `[Ace]: ${aceResponse}` },
  ]);
  documentToChannel('developer', `Implemented goal step. ${aceResponse.slice(0, 300)}`).catch(() => {});
}

function trimHistory(): void {
  if (goalsHistory.length > MAX_HISTORY * 2) {
    goalsHistory.splice(0, goalsHistory.length - MAX_HISTORY * 2);
  }
  saveMemory('goals', goalsHistory);
  if (goalsHistory.length >= 60) {
    compressMemory('goals').catch(() => {});
  }
}
