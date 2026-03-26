import { Message, TextChannel, GuildMember, EmbedBuilder } from 'discord.js';
import { getAgents, getAgent, AgentConfig, AgentId } from '../agents';
import { agentRespond, ConversationMessage } from '../claude';
import { appendToMemory, getMemoryContext, loadMemory, saveMemory, clearMemory, compressMemory } from '../memory';
import { documentToChannel } from './documentation';
import { sendAgentMessage, sendLongMessage, clearHistory } from './textChannel';
import { startCall, endCall, isCallActive } from './callSession';
import { makeOutboundCall, startConferenceCall, isTelephonyAvailable } from '../services/telephony';
import { getBotChannels } from '../bot';
import { getUsageReport } from '../usage';
import { triggerCloudBuild, listRevisions, getCurrentRevision, rollbackToRevision } from '../../services/cloudrun';
import { captureAndPostScreenshots } from '../services/screenshots';

// Shared groupchat conversation history — persisted to disk via memory system
let groupHistory: ConversationMessage[] = loadMemory('groupchat');

/**
 * Pipeline order for agent consultation.
 * Earlier agents inform later ones — e.g. designer before QA, security before deploy.
 */
const AGENT_PIPELINE_ORDER: string[] = [
  'ux-reviewer',       // Sophie — design/UX decisions first
  'dba',               // Elena — schema/data design
  'api-reviewer',      // Raj — API design
  'developer',         // Ace — implementation
  'security-auditor',  // Kane — security review
  'lawyer',            // Harper — compliance
  'qa',                // Max — testing
  'performance',       // Kai — performance check
  'copywriter',        // Liv — user-facing text
  'devops',            // Jude — deployment/infra
  'ios-engineer',      // Mia
  'android-engineer',  // Leo
];

// Serial message queue to prevent race conditions on groupHistory
let messageQueue: Promise<void> = Promise.resolve();

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
 * Riley can trigger actions via [ACTION:xxx] tags in her responses.
 */
export async function handleGroupchatMessage(
  message: Message,
  groupchat: TextChannel
): Promise<void> {
  const content = message.content.trim();
  if (!content) return;

  // Serialize all groupchat processing to prevent race conditions on shared history
  messageQueue = messageQueue.then(() =>
    processGroupchatMessage(message, content, groupchat)
  ).catch((err) => {
    console.error('Groupchat queue error:', err instanceof Error ? err.message : 'Unknown');
  });
  await messageQueue;
}

async function processGroupchatMessage(
  message: Message,
  content: string,
  groupchat: TextChannel
): Promise<void> {
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
    await handleRileyMessage(content, senderName, message.member || undefined, groupchat);
  }
}

/**
 * Handle a goal or request — Riley receives it and orchestrates.
 * Also used internally when feeding decisions back.
 */
export async function handleGoalCommand(
  description: string,
  member: GuildMember,
  groupchat: TextChannel
): Promise<void> {
  const senderName = member.displayName || member.user.username;
  activeGoal = description;
  goalStatus = '⏳ Planning...';

  await handleRileyMessage(description, senderName, member, groupchat);
}

/**
 * Get current status summary.
 */
export function getStatusSummary(): string | null {
  if (!activeGoal) return null;
  return `📋 **Current Goal:** ${activeGoal}\n**Status:** ${goalStatus || 'In progress...'}`;
}

/**
 * Riley receives the message, responds, and orchestrates Ace + sub-agents.
 * She can trigger system actions by including [ACTION:xxx] tags in her response.
 */
async function handleRileyMessage(
  userMessage: string,
  senderName: string,
  member: GuildMember | undefined,
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

    // Strip action tags before displaying to user
    const displayResponse = response.replace(/\[ACTION:[^\]]+\]/g, '').trim();
    if (displayResponse) {
      await sendAgentMessage(groupchat, riley, displayResponse);
    }

    appendToMemory('executive-assistant', [
      { role: 'user', content: contextMessage },
      { role: 'assistant', content: `[Riley]: ${response}` },
    ]);

    groupHistory.push({ role: 'user', content: contextMessage });
    groupHistory.push({ role: 'assistant', content: `[Riley]: ${response}` });
    persistGroupHistory();

    // Execute any actions Riley triggered
    await executeActions(response, member, groupchat);

    // Check if Riley presented a decision (🛑)
    if (displayResponse.includes('🛑') || displayResponse.includes('Decision Required')) {
      await postDecisionEmbed(groupchat, displayResponse);
    }

    // Check if Riley directed Ace or other agents
    await handleAgentChain(response, groupchat);
  } catch (err) {
    console.error('Riley error:', err instanceof Error ? err.message : 'Unknown');
    await groupchat.send('⚠️ Riley encountered an error. Try again.');
  }
}

/**
 * Parse and execute [ACTION:xxx] tags from Riley's response.
 */
async function executeActions(
  response: string,
  member: GuildMember | undefined,
  groupchat: TextChannel
): Promise<void> {
  const actionRe = /\[ACTION:(\w+)(?::([^\]]*))?\]/g;
  const actions = [...response.matchAll(actionRe)];

  for (const [, action, param] of actions) {
    try {
      switch (action.toUpperCase()) {
        case 'JOIN_VC': {
          const channels = getBotChannels();
          if (!channels) break;
          if (isCallActive()) {
            await groupchat.send('📞 Already in a voice call.');
            break;
          }
          if (member) {
            await startCall(channels.voiceChannel, groupchat, channels.callLog, member);
          } else {
            await groupchat.send('📞 I need you to be in the server to join VC.');
          }
          break;
        }
        case 'LEAVE_VC': {
          if (isCallActive()) {
            await endCall();
          } else {
            await groupchat.send('No active voice call to leave.');
          }
          break;
        }
        case 'DEPLOY': {
          try {
            const { buildId, logUrl } = await triggerCloudBuild(param || 'latest');
            await groupchat.send(
              `🚀 **Build triggered**\nBuild ID: \`${buildId}\`\n[View logs](${logUrl})`
            );
            const channels = getBotChannels();
            if (channels?.url) {
              const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
              await channels.url.send(
                `🚀 **Build triggered** — ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}\n` +
                `🔨 Build: \`${buildId}\` — [View logs](${logUrl})\n` +
                `🌐 App: ${appUrl}`
              );
            }
          } catch (err) {
            await groupchat.send(`❌ Deploy failed: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          break;
        }
        case 'SCREENSHOTS': {
          const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
          captureAndPostScreenshots(appUrl, param || 'manual').catch((err) => {
            groupchat.send(`❌ Screenshot capture failed: ${err instanceof Error ? err.message : 'Unknown'}`).catch(() => {});
          });
          await groupchat.send('📸 Capturing screenshots...');
          break;
        }
        case 'URLS': {
          const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
          const projectId = process.env.GCS_PROJECT_ID || 'asap-489910';
          const region = process.env.CLOUD_RUN_REGION || 'australia-southeast1';
          await groupchat.send(
            `🔗 **ASAP Links**\n\n` +
            `🌐 **App**: ${appUrl}\n` +
            `📦 **Cloud Build**: https://console.cloud.google.com/cloud-build/builds?project=${projectId}\n` +
            `☁️ **Cloud Run**: https://console.cloud.google.com/run/detail/${region}/asap?project=${projectId}\n` +
            `📊 **Logs**: https://console.cloud.google.com/logs/query?project=${projectId}`
          );
          break;
        }
        case 'STATUS': {
          const summary = getStatusSummary();
          await groupchat.send(summary || '📋 No active tasks.');
          break;
        }
        case 'LIMITS': {
          const report = getUsageReport();
          await groupchat.send(report);
          break;
        }
        case 'CLEAR': {
          clearHistory(groupchat.id);
          groupHistory.splice(0);
          clearMemory('groupchat');
          await groupchat.send('🧹 Conversation context cleared.');
          break;
        }
        case 'ROLLBACK': {
          if (param) {
            try {
              const result = await rollbackToRevision(param);
              await groupchat.send(result);
            } catch (err) {
              await groupchat.send(`❌ Rollback failed: ${err instanceof Error ? err.message : 'Unknown'}`);
            }
          } else {
            try {
              const current = await getCurrentRevision();
              const revisions = await listRevisions(5);
              const list = revisions.map((r) => {
                const date = new Date(r.createTime).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
                const tag = r.image.split(':').pop()?.slice(0, 12) || '?';
                const active = r.name === current ? ' ← **active**' : '';
                return `\`${r.name}\` — ${date} (${tag})${active}`;
              }).join('\n');
              await groupchat.send(`📦 **Cloud Run Revisions**\n\n${list}`);
            } catch (err) {
              await groupchat.send(`❌ Failed to list revisions: ${err instanceof Error ? err.message : 'Unknown'}`);
            }
          }
          break;
        }
        case 'AGENTS': {
          const agents = getAgents();
          const list = Array.from(agents.values())
            .map((a) => `${a.emoji} **${a.name}**`)
            .join('\n');
          await groupchat.send(`**ASAP Agent Team**\n\n${list}`);
          break;
        }
        case 'CALL': {
          if (!isTelephonyAvailable()) {
            await groupchat.send('📞 Phone system not configured (missing Twilio credentials).');
            break;
          }
          const phoneNumber = param || '0436012231';
          try {
            await makeOutboundCall(phoneNumber, "Hey Jordan, it's Riley! You asked me to give you a call.");
            await groupchat.send(`📞 Calling ${phoneNumber}...`);
          } catch (err) {
            await groupchat.send(`❌ Call failed: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          break;
        }
        case 'CONFERENCE': {
          if (!isTelephonyAvailable()) {
            await groupchat.send('📞 Phone system not configured (missing Twilio credentials).');
            break;
          }
          // param format: "0436012231,0412345678" (comma-separated numbers)
          const numbers = param ? param.split(',').map(n => n.trim()) : ['0436012231'];
          try {
            const confName = await startConferenceCall(numbers);
            await groupchat.send(`📞 **Conference call started** — ${confName}\nCalling: ${numbers.join(', ')} + Riley`);
          } catch (err) {
            await groupchat.send(`❌ Conference failed: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          break;
        }
      }
    } catch (err) {
      console.error(`Action ${action} error:`, err instanceof Error ? err.message : 'Unknown');
    }
  }
}

/**
 * Parse Riley/Ace's response for @agent directives using strict word-boundary regex.
 * Only matches explicit @name patterns to avoid false positives.
 */
const DIRECTIVE_RE = /@(ace|max|sophie|kane|raj|elena|kai|jude|liv|harper|mia|leo)\b/gi;
const DIRECTIVE_NAME_TO_ID: Record<string, string> = {
  ace: 'developer', max: 'qa', sophie: 'ux-reviewer',
  kane: 'security-auditor', raj: 'api-reviewer', elena: 'dba',
  kai: 'performance', jude: 'devops', liv: 'copywriter', harper: 'lawyer',
  mia: 'ios-engineer', leo: 'android-engineer',
};

function parseDirectives(text: string): string[] {
  const found = new Set<string>();
  // Reset lastIndex since the regex has the global flag
  DIRECTIVE_RE.lastIndex = 0;
  for (const match of text.matchAll(DIRECTIVE_RE)) {
    const name = match[1].toLowerCase();
    if (DIRECTIVE_NAME_TO_ID[name]) found.add(DIRECTIVE_NAME_TO_ID[name]);
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
        const aceSubDirectives = parseDirectives(aceResponse);
        if (aceSubDirectives.length > 0) {
          await handleSubAgents(aceSubDirectives, aceResponse, groupchat);
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
 * Sub-agents run sequentially in pipeline order so earlier agents' output
 * informs later agents (e.g. designer before QA, security before deploy).
 */
async function handleSubAgents(
  agentIds: string[],
  directiveContext: string,
  groupchat: TextChannel
): Promise<void> {
  const validAgents = agentIds
    .filter((id) => id !== 'executive-assistant')
    .map((id) => ({ id, agent: getAgent(id as AgentId) }))
    .filter((a): a is { id: string; agent: AgentConfig } => a.agent !== null && a.agent !== undefined);

  if (validAgents.length === 0) return;

  // Sort agents by pipeline order — earlier phases first
  validAgents.sort((a, b) => {
    const aIdx = AGENT_PIPELINE_ORDER.indexOf(a.id);
    const bIdx = AGENT_PIPELINE_ORDER.indexOf(b.id);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

  // Accumulate earlier agents' findings so later agents can build on them
  const priorFindings: string[] = [];

  for (const { id, agent } of validAgents) {
    try {
      await groupchat.sendTyping();
      await documentToChannel(id, `📥 Received task from groupchat. Working...`);
      const agentMemory = getMemoryContext(id);
      const priorContext = priorFindings.length > 0
        ? `\n\n**Prior agent findings (use these to inform your work):**\n${priorFindings.join('\n')}` : '';
      const agentContext = `[Directive from groupchat]: ${directiveContext}${priorContext}\n\nDo your job. Be concise in your response — max 200 words. Report what you found or did.`;
      const agentResponse = await agentRespond(agent, [...agentMemory, ...groupHistory], agentContext, async (_toolName, summary) => {
        await documentToChannel(id, `🔧 ${summary}`);
      });

      await sendAgentMessage(groupchat, agent, agentResponse);
      appendToMemory(id, [
        { role: 'user', content: `[Groupchat directive]: ${directiveContext.slice(0, 500)}` },
        { role: 'assistant', content: `[${agent.name}]: ${agentResponse}` },
      ]);
      await documentToChannel(id, `✅ ${agentResponse.slice(0, 300)}`);
      groupHistory.push({ role: 'assistant', content: `[${agent.name.split(' ')[0]}]: ${agentResponse}` });
      priorFindings.push(`[${agent.name.split(' ')[0]}]: ${agentResponse.slice(0, 500)}`);
    } catch (err) {
      console.error(`${agent.name} error:`, err instanceof Error ? err.message : 'Unknown');
      await groupchat.send(`⚠️ ${agent.emoji} ${agent.name.split(' ')[0]} had an error.`);
    }
  }
  persistGroupHistory();
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
  persistGroupHistory();
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

      console.log(`Decision: ${userName} chose option ${choiceIndex + 1}: "${choice}"`);
      await groupchat.send(`✅ **${userName}** chose: **${choice}**`);

      // Feed the decision back to Riley
      const decisionMessage = `${userName} chose option ${choiceIndex + 1}: ${choice}`;
      await handleRileyMessage(decisionMessage, userName, undefined, groupchat);
    }
  } catch {
    // Timeout — delete the stale decision embed and notify
    try { await decisionMsg.delete(); } catch { /* already deleted */ }
    await groupchat.send('⏰ Decision timed out. Please tell Riley what you want to do.');
  }
}

/** Persist groupHistory to disk. Called after every interaction. */
function persistGroupHistory(): void {
  saveMemory('groupchat', groupHistory);
  // Trigger compression when history gets long (runs in background)
  if (groupHistory.length >= 60) {
    compressMemory('groupchat').then(() => {
      // Reload the compressed history
      groupHistory = loadMemory('groupchat');
    }).catch(() => {});
  }
}
