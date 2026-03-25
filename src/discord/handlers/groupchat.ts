import { Message, TextChannel, GuildMember, EmbedBuilder } from 'discord.js';
import { getAgents, getAgent, AgentConfig, AgentId } from '../agents';
import { agentRespond, ConversationMessage } from '../claude';
import { appendToMemory, getMemoryContext } from '../memory';
import { documentToChannel } from './documentation';
import { sendAgentMessage, sendLongMessage } from './textChannel';

// Shared groupchat conversation history
const groupHistory: ConversationMessage[] = [];
const MAX_HISTORY = 40;

// Active goal tracking for /status
let activeGoal: string | null = null;
let goalStatus: string | null = null;

/** Regex to detect @agent mentions — requires @ prefix for explicit mentions */
const MENTION_RE = /@(qa|max|ux-reviewer|sophie|security-auditor|kane|api-reviewer|raj|dba|elena|performance|kai|devops|jude|copywriter|liv|developer|ace|lawyer|harper|executive-assistant|riley|ios-engineer|mia|android-engineer|leo)\b/gi;

/** Map casual name mentions back to agent IDs */
const NAME_TO_ID: Record<string, string> = {
  qa: 'qa', max: 'qa',
  'ux-reviewer': 'ux-reviewer', sophie: 'ux-reviewer',
  'security-auditor': 'security-auditor', kane: 'security-auditor',
  'api-reviewer': 'api-reviewer', raj: 'api-reviewer',
  dba: 'dba', elena: 'dba',
  performance: 'performance', kai: 'performance',
  devops: 'devops', jude: 'devops',
  copywriter: 'copywriter', liv: 'copywriter',
  developer: 'developer', ace: 'developer',
  lawyer: 'lawyer', harper: 'lawyer',
  'executive-assistant': 'executive-assistant', riley: 'executive-assistant',
  'ios-engineer': 'ios-engineer', mia: 'ios-engineer',
  'android-engineer': 'android-engineer', leo: 'android-engineer',
};

/**
 * Handle a message in the groupchat channel.
 * Riley-led flow: everything goes through Riley unless user @mentions a specific agent.
 */
export async function handleGroupchatMessage(
  message: Message,
  groupchat: TextChannel
): Promise<void> {
  const content = message.content.trim();
  if (!content) return;

  const senderName = message.member?.displayName || message.author.username;

  // Check for explicit @agent mentions — route directly
  const mentions = [...content.matchAll(MENTION_RE)].map((m) => {
    const key = m[1].toLowerCase();
    return NAME_TO_ID[key] || key;
  });
  const uniqueMentions = [...new Set(mentions)];

  if (uniqueMentions.length > 0) {
    // User explicitly @mentioned agents — route to them directly
    await handleDirectedMessage(content, senderName, uniqueMentions, groupchat);
  } else {
    // No @mentions — goes to Riley, she coordinates
    await handleRileyMessage(content, senderName, groupchat);
  }
}

/**
 * Handle a /goal command — Riley receives the goal and orchestrates.
 */
export async function handleGoalCommand(
  description: string,
  member: GuildMember,
  groupchat: TextChannel
): Promise<void> {
  const senderName = member.displayName || member.user.username;
  activeGoal = description;
  goalStatus = '⏳ Planning...';

  await handleRileyGoal(description, senderName, groupchat);
}

/**
 * Get current status summary for /status command.
 */
export function getStatusSummary(): string | null {
  if (!activeGoal) return null;
  return `📋 **Current Goal:** ${activeGoal}\n**Status:** ${goalStatus || 'In progress...'}`;
}

/**
 * Riley receives the message, responds, and orchestrates Ace + sub-agents.
 */
async function handleRileyMessage(
  userMessage: string,
  senderName: string,
  groupchat: TextChannel
): Promise<void> {
  const riley = getAgent('executive-assistant' as AgentId);
  if (!riley) return;

  try {
    await groupchat.sendTyping();

    const rileyMemory = getMemoryContext('executive-assistant');
    const contextMessage = `[${senderName}]: ${userMessage}`;

    const response = await agentRespond(riley, [...rileyMemory, ...groupHistory], contextMessage, async (_toolName, summary) => {
      await groupchat.send(`🔧 ${riley.emoji} → ${summary}`);
    });

    await sendAgentMessage(groupchat, riley, response);
    appendToMemory('executive-assistant', [
      { role: 'user', content: contextMessage },
      { role: 'assistant', content: `[Riley]: ${response}` },
    ]);

    groupHistory.push({ role: 'user', content: contextMessage });
    groupHistory.push({ role: 'assistant', content: `[Riley]: ${response}` });

    // Check if Riley presented a decision (🛑)
    if (response.includes('🛑') || response.includes('Decision Required')) {
      await postDecisionEmbed(groupchat, response);
    }

    // Check if Riley directed Ace or other agents
    await handleAgentChain(response, groupchat);

    trimHistory();
  } catch (err) {
    console.error('Riley error:', err instanceof Error ? err.message : 'Unknown');
    await groupchat.send('⚠️ Riley encountered an error. Try again.');
  }
}

/**
 * Riley receives a goal from /goal command.
 */
async function handleRileyGoal(
  goalDescription: string,
  senderName: string,
  groupchat: TextChannel
): Promise<void> {
  const riley = getAgent('executive-assistant' as AgentId);
  if (!riley) return;

  try {
    await groupchat.sendTyping();

    const rileyMemory = getMemoryContext('executive-assistant');
    const contextMessage = `[GOAL from ${senderName}]: ${goalDescription}

Create a plan for this goal. Be specific about which agents handle which steps. Then direct Ace to start implementing. If anything is unclear, ask ${senderName} using the Decision Protocol.`;

    const response = await agentRespond(riley, [...rileyMemory, ...groupHistory], contextMessage, async (_toolName, summary) => {
      await groupchat.send(`🔧 ${riley.emoji} → ${summary}`);
    });

    goalStatus = '📋 Plan created';
    await sendAgentMessage(groupchat, riley, response);
    appendToMemory('executive-assistant', [
      { role: 'user', content: `[GOAL from ${senderName}]: ${goalDescription}` },
      { role: 'assistant', content: `[Riley]: ${response}` },
    ]);

    groupHistory.push({ role: 'user', content: `[GOAL from ${senderName}]: ${goalDescription}` });
    groupHistory.push({ role: 'assistant', content: `[Riley]: ${response}` });

    // Check for decision request
    if (response.includes('🛑') || response.includes('Decision Required')) {
      goalStatus = '🛑 Waiting for your decision';
      await postDecisionEmbed(groupchat, response);
      trimHistory();
      return;
    }

    // Riley directs Ace and sub-agents
    await handleAgentChain(response, groupchat);

    trimHistory();
  } catch (err) {
    console.error('Riley goal error:', err instanceof Error ? err.message : 'Unknown');
    goalStatus = '❌ Error';
    await groupchat.send('⚠️ Riley encountered an error planning this goal. Try again.');
  }
}

/**
 * Parse Riley/Ace's response for @agent directives using strict word-boundary regex.
 * Only matches explicit @name patterns to avoid false positives.
 */
function parseDirectives(text: string): string[] {
  const directiveRe = /@(ace|max|sophie|kane|raj|elena|kai|jude|liv|harper|mia|leo)\b/gi;
  const nameToId: Record<string, string> = {
    ace: 'developer', max: 'qa', sophie: 'ux-reviewer',
    kane: 'security-auditor', raj: 'api-reviewer', elena: 'dba',
    kai: 'performance', jude: 'devops', liv: 'copywriter', harper: 'lawyer',
    mia: 'ios-engineer', leo: 'android-engineer',
  };

  const found = new Set<string>();
  for (const match of text.matchAll(directiveRe)) {
    const name = match[1].toLowerCase();
    if (nameToId[name]) found.add(nameToId[name]);
  }
  return [...found];
}

/**
 * Handle the chain: Riley → Ace → sub-agents → report back
 */
async function handleAgentChain(
  rileyResponse: string,
  groupchat: TextChannel
): Promise<void> {
  const directedAgents = parseDirectives(rileyResponse);
  if (directedAgents.length === 0) return;

  // If Ace was directed, he gets Riley's full plan
  const aceDirected = directedAgents.includes('developer');
  const otherDirected = directedAgents.filter((id) => id !== 'developer');

  if (aceDirected) {
    const ace = getAgent('developer' as AgentId);
    if (ace) {
      try {
        await groupchat.sendTyping();
        const aceMemory = getMemoryContext('developer');
        const aceContext = `[Riley directed you]: ${rileyResponse}\n\nImplement what Riley asked. Use repo tools. If you need a sub-agent's help, @mention them (e.g., @kane for security review, @elena for DB schema). Report back concisely when done.`;

        const aceResponse = await agentRespond(ace, [...aceMemory, ...groupHistory], aceContext, async (_toolName, summary) => {
          await groupchat.send(`🔧 ${ace.emoji} → ${summary}`);
        });

        await sendAgentMessage(groupchat, ace, aceResponse);
        appendToMemory('developer', [
          { role: 'user', content: `[Riley directed]: ${rileyResponse.slice(0, 1000)}` },
          { role: 'assistant', content: `[Ace]: ${aceResponse}` },
        ]);
        await documentToChannel('developer', aceResponse.slice(0, 300));

        groupHistory.push({ role: 'assistant', content: `[Ace]: ${aceResponse}` });
        goalStatus = '💻 Ace implementing...';

        // Ace may direct sub-agents
        const aceDirected = parseDirectives(aceResponse);
        if (aceDirected.length > 0) {
          await handleSubAgents(aceDirected, aceResponse, groupchat);
        }
      } catch (err) {
        console.error('Ace error:', err instanceof Error ? err.message : 'Unknown');
        await groupchat.send(`⚠️ ${ace.emoji} Ace had an error.`);
      }
    }
  }

  // Handle other agents Riley directed directly (not through Ace)
  if (otherDirected.length > 0) {
    await handleSubAgents(otherDirected, rileyResponse, groupchat);
  }
}

/**
 * Sub-agents work in their own channels, then report back to groupchat.
 */
async function handleSubAgents(
  agentIds: string[],
  directiveContext: string,
  groupchat: TextChannel
): Promise<void> {
  for (const agentId of agentIds) {
    if (agentId === 'executive-assistant') continue;

    const agent = getAgent(agentId as AgentId);
    if (!agent) continue;

    try {
      // Post in the sub-agent's own channel that they're working
      await documentToChannel(agentId, `📥 Received task from groupchat. Working...`);

      const agentMemory = getMemoryContext(agentId);
      const agentContext = `[Directive from groupchat]: ${directiveContext}\n\nDo your job. Be concise in your response — max 200 words. Report what you found or did.`;

      const agentResponse = await agentRespond(agent, [...agentMemory, ...groupHistory], agentContext, async (_toolName, summary) => {
        await documentToChannel(agentId, `🔧 ${summary}`);
      });

      // Report back in groupchat
      await sendAgentMessage(groupchat, agent, agentResponse);
      appendToMemory(agentId, [
        { role: 'user', content: `[Groupchat directive]: ${directiveContext.slice(0, 500)}` },
        { role: 'assistant', content: `[${agent.name}]: ${agentResponse}` },
      ]);
      await documentToChannel(agentId, `✅ ${agentResponse.slice(0, 300)}`);

      groupHistory.push({ role: 'assistant', content: `[${agent.name.split(' ')[0]}]: ${agentResponse}` });
    } catch (err) {
      console.error(`${agent.name} error:`, err instanceof Error ? err.message : 'Unknown');
      await groupchat.send(`⚠️ ${agent.emoji} ${agent.name.split(' ')[0]} had an error.`);
    }
  }
}

/**
 * User explicitly @mentioned agents — route directly to them.
 */
async function handleDirectedMessage(
  userMessage: string,
  senderName: string,
  agentIds: string[],
  groupchat: TextChannel
): Promise<void> {
  const contextMessage = `[${senderName}]: ${userMessage}`;

  for (const agentId of agentIds) {
    const agent = getAgent(agentId as AgentId);
    if (!agent) continue;

    try {
      await groupchat.sendTyping();

      const agentMemory = getMemoryContext(agentId);
      const response = await agentRespond(agent, [...agentMemory, ...groupHistory], contextMessage, async (_toolName, summary) => {
        await groupchat.send(`🔧 ${agent.emoji} → ${summary}`);
      });

      await sendAgentMessage(groupchat, agent, response);
      appendToMemory(agentId, [
        { role: 'user', content: contextMessage },
        { role: 'assistant', content: `[${agent.name}]: ${response}` },
      ]);
      await documentToChannel(agentId, `Direct @mention from ${senderName}: ${response.slice(0, 200)}`);
    } catch (err) {
      console.error(`${agent.name} error:`, err instanceof Error ? err.message : 'Unknown');
      await groupchat.send(`⚠️ ${agent.emoji} ${agent.name.split(' ')[0]} had an error.`);
    }
  }

  groupHistory.push({ role: 'user', content: contextMessage });
  trimHistory();
}

/**
 * Post a reaction-based decision embed.
 * Parses numbered options from Riley's response and adds reaction buttons.
 */
async function postDecisionEmbed(
  groupchat: TextChannel,
  rileyResponse: string
): Promise<void> {
  // Extract the decision section
  const decisionMatch = rileyResponse.match(/🛑[\s\S]*?(?=\n\n[^1-9]|$)/);
  if (!decisionMatch) return;

  const decisionText = decisionMatch[0];

  // Extract options (lines starting with numbers or emoji numbers)
  const optionRe = /^[1-5]️?⃣?\s*[.):]\s*(.+)$/gm;
  const options: string[] = [];
  for (const match of decisionText.matchAll(optionRe)) {
    options.push(match[1].trim());
  }

  // Also try "**Option X**" pattern
  if (options.length === 0) {
    const altRe = /[1-5]️⃣\s*\*\*(.+?)\*\*/g;
    for (const match of decisionText.matchAll(altRe)) {
      options.push(match[1].trim());
    }
  }

  const reactions = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

  if (options.length === 0) return; // No parseable options

  const embed = new EmbedBuilder()
    .setTitle('🛑 Decision Required')
    .setDescription(
      options
        .slice(0, 5)
        .map((opt, i) => `${reactions[i]} ${opt}`)
        .join('\n\n')
    )
    .setColor(0xff4444)
    .setFooter({ text: 'React to choose • Times out in 5 minutes' });

  const decisionMsg = await groupchat.send({ embeds: [embed] });

  // Add reaction buttons
  for (let i = 0; i < Math.min(options.length, 5); i++) {
    await decisionMsg.react(reactions[i]);
  }

  // Wait for user reaction
  const filter = (reaction: any, user: any) => {
    return reactions.slice(0, options.length).includes(reaction.emoji.name || '') && !user.bot;
  };

  try {
    const collected = await decisionMsg.awaitReactions({
      filter,
      max: 1,
      time: 5 * 60 * 1000, // 5 minutes
    });

    const reaction = collected.first();
    if (reaction) {
      const choiceIndex = reactions.indexOf(reaction.emoji.name || '');
      const choice = options[choiceIndex] || `Option ${choiceIndex + 1}`;

      // Get the user who reacted
      const users = await reaction.users.fetch();
      const reactUser = users.find((u) => !u.bot);
      const userName = reactUser?.username || 'User';

      await groupchat.send(`✅ **${userName}** chose: **${choice}**`);

      // Feed the decision back to Riley
      const decisionMessage = `${userName} chose option ${choiceIndex + 1}: ${choice}`;
      await handleRileyMessage(decisionMessage, userName, groupchat);
    }
  } catch {
    await groupchat.send('⏰ Decision timed out. Please tell Riley what you want to do.');
  }
}

function trimHistory(): void {
  if (groupHistory.length > MAX_HISTORY * 2) {
    groupHistory.splice(0, groupHistory.length - MAX_HISTORY * 2);
  }
}
