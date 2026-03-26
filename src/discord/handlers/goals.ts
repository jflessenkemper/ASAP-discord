import { Message, TextChannel } from 'discord.js';
import { getAgent, AgentId, AgentConfig } from '../agents';
import { agentRespond, ConversationMessage } from '../claude';
import { appendToMemory, getMemoryContext } from '../memory';
import { documentToChannel } from './documentation';
import { sendAgentMessage } from './textChannel';
import { getWebhook } from '../services/webhooks';

// Goals channel conversation history — persistent across messages
const goalsHistory: ConversationMessage[] = [];
const MAX_HISTORY = 40;

// Tracks whether we're waiting for a decision from the user.
// Using a message queue to prevent race conditions on concurrent messages.
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
 * directs Ace (Developer) to implement, and Harper (Lawyer) reviews.
 */
export async function handleGoalsMessage(
  message: Message,
  goalsChannel: TextChannel,
  groupchat: TextChannel
): Promise<void> {
  const content = message.content.trim();
  if (!content) return;

  // Serialize goals processing to prevent race conditions on pendingDecision
  goalsQueue = goalsQueue.then(() =>
    processGoalsMessage(message, content, goalsChannel, groupchat)
  ).catch((err) => {
    console.error('Goals queue error:', err instanceof Error ? err.message : 'Unknown');
  });
  await goalsQueue;
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
  } catch {
    await channel.send(`🔧 ${agent.emoji} ${agent.name} → ${summary}`);
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
  const harper = getAgent('lawyer' as AgentId);

  if (!riley || !ace) return;

  // If a decision is pending, this message is the user's choice
  if (pendingDecision) {
    pendingDecision = false;
    await goalsChannel.sendTyping();

    const decisionContext = `[${senderName} responded to your decision request]: ${content}

The user has made their choice. Acknowledge it briefly, then continue executing the plan. Direct Ace to implement the chosen approach.`;

    try {
      const rileyMemory = getMemoryContext('executive-assistant');
      const rileyResponse = await agentRespond(riley, [...rileyMemory, ...goalsHistory], decisionContext, async (_toolName, summary) => {
        await sendGoalsToolNotification(goalsChannel, riley, summary);
      });

      await sendAgentMessage(goalsChannel, riley, rileyResponse);
      goalsHistory.push({ role: 'user', content: `[${senderName} decision]: ${content}` });
      goalsHistory.push({ role: 'assistant', content: `[${riley.name}]: ${rileyResponse}` });
      appendToMemory('executive-assistant', [
        { role: 'user', content: `[${senderName} decision]: ${content}` },
        { role: 'assistant', content: `[Riley]: ${rileyResponse}` },
      ]);
      await documentToChannel('executive-assistant', `Received decision from ${senderName}: "${content.slice(0, 200)}". Continuing plan.`);

      // Check if Riley's response contains a decision request
      if (rileyResponse.includes('🛑') || rileyResponse.includes('Decision Required')) {
        pendingDecision = true;
        return;
      }

      // Now direct Ace to implement based on Riley's plan
      await executeAceStep(ace, riley, rileyResponse, senderName, goalsChannel);

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

  // Riley receives the goal first and creates a plan
  const goalContext = `[GOAL from ${senderName}]: ${content}

You are in the #goals channel. ${senderName} has given you a goal. Your job:
1. Analyze the goal and ask clarifying questions if it's too vague
2. Create a clear plan with numbered steps and agent assignments
3. If you need Jordan's input on an approach, use the Decision Protocol (🛑 Decision Required)
4. If the goal is clear, create the plan and then give Ace (Developer) his first instruction

Remember: You plan and coordinate. Ace implements. Harper reviews compliance. Other agents help in their domain.`;

  try {
    // Riley creates the plan
    const rileyMemory = getMemoryContext('executive-assistant');
    const rileyResponse = await agentRespond(riley, [...rileyMemory, ...goalsHistory], goalContext, async (_toolName, summary) => {
      await sendGoalsToolNotification(goalsChannel, riley, summary);
    });

    await sendAgentMessage(goalsChannel, riley, rileyResponse);

    goalsHistory.push({ role: 'user', content: `[${senderName}]: ${content}` });
    goalsHistory.push({ role: 'assistant', content: `[${riley.name}]: ${rileyResponse}` });
    appendToMemory('executive-assistant', [
      { role: 'user', content: `[GOAL from ${senderName}]: ${content}` },
      { role: 'assistant', content: `[Riley]: ${rileyResponse}` },
    ]);
    await documentToChannel('executive-assistant', `Received goal from ${senderName}: "${content.slice(0, 200)}". Created plan.`);

    // Check if Riley needs a decision before proceeding
    if (rileyResponse.includes('🛑') || rileyResponse.includes('Decision Required')) {
      pendingDecision = true;
      trimHistory();
      return;
    }

    // Riley's plan is ready — direct Ace to implement
    await executeAceStep(ace, riley, rileyResponse, senderName, goalsChannel);

    // Harper reviews for compliance
    if (harper) {
      await goalsChannel.sendTyping();

      const aceLastResponse = goalsHistory.filter(h => h.content.startsWith('[Ace')).pop()?.content || '';
      const harperContext = `[Riley planned and Ace implemented a goal from ${senderName}]: "${content}"

Riley's plan:
${rileyResponse.slice(0, 1500)}

Ace's implementation:
${aceLastResponse.slice(0, 1500)}

Review this for Australian business law compliance. Focus on: privacy (APPs), consumer law (ACL), contractor classification, data handling, and any regulatory concerns. Be concise — only flag actual issues.`;

      const harperMemory = getMemoryContext('lawyer');
      const harperResponse = await agentRespond(harper, [...harperMemory, ...goalsHistory], harperContext, async (_toolName, summary) => {
        await sendGoalsToolNotification(goalsChannel, harper, summary);
      });

      await sendAgentMessage(goalsChannel, harper, harperResponse);

      goalsHistory.push({ role: 'user', content: `[System: Harper reviewing for compliance]` });
      goalsHistory.push({ role: 'assistant', content: `[${harper.name}]: ${harperResponse}` });
      appendToMemory('lawyer', [
        { role: 'user', content: `[Compliance review for goal]: ${content.slice(0, 500)}` },
        { role: 'assistant', content: `[Harper]: ${harperResponse}` },
      ]);
      await documentToChannel('lawyer', `Reviewed compliance for goal: "${content.slice(0, 200)}"`);
    }

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

Riley has created this plan based on a goal from ${senderName}. Implement the steps assigned to you. Use your repo tools to read, write, and edit code. Report back what you've done.`;

  const aceMemory = getMemoryContext('developer');
  const aceResponse = await agentRespond(ace, [...aceMemory, ...goalsHistory], aceContext, async (_toolName, summary) => {
    await sendGoalsToolNotification(goalsChannel, ace, summary);
  });

  await sendAgentMessage(goalsChannel, ace, aceResponse);

  goalsHistory.push({ role: 'user', content: `[Riley's instruction to Ace]` });
  goalsHistory.push({ role: 'assistant', content: `[${ace.name}]: ${aceResponse}` });
  appendToMemory('developer', [
    { role: 'user', content: `[Instruction from Riley]: ${rileyPlan.slice(0, 1000)}` },
    { role: 'assistant', content: `[Ace]: ${aceResponse}` },
  ]);
  await documentToChannel('developer', `Implemented goal step. ${aceResponse.slice(0, 300)}`);
}

function trimHistory(): void {
  if (goalsHistory.length > MAX_HISTORY * 2) {
    goalsHistory.splice(0, goalsHistory.length - MAX_HISTORY * 2);
  }
}
