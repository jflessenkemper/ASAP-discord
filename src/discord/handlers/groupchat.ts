import { Message, TextChannel, GuildMember, EmbedBuilder } from 'discord.js';
import { getAgents, getAgent, AgentConfig, AgentId } from '../agents';
import { agentRespond, ConversationMessage } from '../claude';
import { appendToMemory, getMemoryContext, loadMemory, saveMemory, clearMemory, compressMemory } from '../memory';
import { documentToChannel } from './documentation';
import { sendAgentMessage, clearHistory } from './textChannel';
import { startCall, endCall, isCallActive } from './callSession';
import { makeOutboundCall, startConferenceCall, isTelephonyAvailable } from '../services/telephony';
import { getBotChannels } from '../bot';
import { getUsageReport } from '../usage';
import { getWebhook } from '../services/webhooks';

/** Send a tool-use notification as the agent (via webhook). */
async function sendToolNotification(channel: TextChannel, agent: AgentConfig, summary: string): Promise<void> {
  try {
    const webhook = await getWebhook(channel);
    await webhook.send({
      content: `🔧 ${summary}`,
      username: `${agent.emoji} ${agent.name}`,
      avatarURL: agent.avatarUrl,
    });
  } catch (err) {
    console.warn(`Webhook tool notification failed for ${agent.name}:`, err instanceof Error ? err.message : 'Unknown');
  }
}
import { triggerCloudBuild, listRevisions, getCurrentRevision, rollbackToRevision } from '../../services/cloudrun';
import { captureAndPostScreenshots } from '../services/screenshots';

// Shared groupchat conversation history — persisted to disk via memory system
let groupHistory: ConversationMessage[] = loadMemory('groupchat');

// Serial message queue to prevent race conditions on groupHistory
let messageQueue: Promise<void> = Promise.resolve();

// Tracks in-flight message processing so a new message can interrupt it
let activeAbortController: AbortController | null = null;

// Active goal tracking for /status
let activeGoal: string | null = null;
let goalStatus: string | null = null;

/** Regex to detect @agent mentions — requires @ prefix for explicit mentions */
const MENTION_RE = /@(qa|max|ux-reviewer|sophie|security-auditor|kane|api-reviewer|raj|dba|elena|performance|kai|devops|jude|copywriter|liv|developer|ace|lawyer|harper|executive-assistant|riley|ios-engineer|mia|android-engineer|leo)\b/gi;

/** Keep typing indicator alive during long agent operations. Returns a stop function. */
function startTypingLoop(channel: TextChannel): () => void {
  channel.sendTyping().catch(() => {});
  const interval = setInterval(() => { channel.sendTyping().catch(() => {}); }, 8000);
  return () => clearInterval(interval);
}

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

// Keep groupchat concise: specialist agents work in their own channels, then
// Riley posts a single consolidated summary to groupchat.
const GROUPCHAT_SUMMARY_ONLY = process.env.GROUPCHAT_SUMMARY_ONLY !== 'false';

function getAgentWorkChannel(agentId: string, fallback: TextChannel): TextChannel {
  const channels = getBotChannels();
  return channels?.agentChannels.get(agentId) || fallback;
}

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

  // Interrupt any in-progress response — user has already moved on
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }

  const controller = new AbortController();
  activeAbortController = controller;

  // Still queue to serialise history writes, but in-progress work exits early on abort
  messageQueue = messageQueue.then(async () => {
    if (controller.signal.aborted) return;
    try {
      await processGroupchatMessage(message, content, groupchat, controller.signal);
    } finally {
      if (activeAbortController === controller) activeAbortController = null;
    }
  }).catch((err) => {
    console.error('Groupchat queue error:', err instanceof Error ? err.message : 'Unknown');
  });
}

async function processGroupchatMessage(
  message: Message,
  content: string,
  groupchat: TextChannel,
  signal?: AbortSignal
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
    await handleDirectedMessage(content, senderName, uniqueMentions, groupchat, signal);
  } else {
    // No @mentions — goes to Riley, she coordinates
    await handleRileyMessage(content, senderName, message.member || undefined, groupchat, signal);
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
  groupchat: TextChannel,
  signal?: AbortSignal
): Promise<void> {
  const riley = getAgent('executive-assistant' as AgentId);
  if (!riley) return;

  let stopTyping: () => void = () => {};
  try {
    stopTyping = startTypingLoop(groupchat);

    const rileyMemory = getMemoryContext('executive-assistant');
    const contextMessage = `[${senderName}]: ${userMessage}`;

    const response = await agentRespond(riley, [...rileyMemory, ...groupHistory], contextMessage, async (_toolName, summary) => {
      sendToolNotification(groupchat, riley, summary).catch(() => {});
    }, { signal });

    if (signal?.aborted) return;

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

    if (signal?.aborted) return;

    // Execute any actions Riley triggered
    await executeActions(response, member, groupchat);

    // Check if Riley presented a decision (🛑)
    if (displayResponse.includes('🛑') || displayResponse.includes('Decision Required')) {
      await postDecisionEmbed(groupchat, displayResponse);
      return;
    }

    if (signal?.aborted) return;

    // Check if Riley directed Ace or other agents
    await handleAgentChain(response, groupchat, signal);
  } catch (err) {
    const abortLike = String((err as any)?.name || '').includes('Abort') || String((err as any)?.message || '').toLowerCase().includes('abort');
    if (abortLike || signal?.aborted) return;
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Riley error:', errMsg);
    const short = errMsg.length > 200 ? errMsg.slice(0, 200) + '…' : errMsg;
    try {
      const wh = await getWebhook(groupchat);
      await wh.send({
        content: `⚠️ Riley encountered an error:\n\`\`\`${short}\`\`\``,
        username: `${riley.emoji} ${riley.name}`,
        avatarURL: riley.avatarUrl,
      });
    } catch {
      await groupchat.send(`⚠️ Riley encountered an error:\n\`\`\`${short}\`\`\``);
    }
  } finally {
    stopTyping();
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

  const riley = getAgent('executive-assistant' as AgentId);

  /** Send a message as Riley via webhook, fallback to bot if webhook fails */
  async function sendAsRiley(msg: string): Promise<void> {
    if (riley) {
      try {
        const wh = await getWebhook(groupchat);
        await wh.send({ content: msg, username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
        return;
      } catch (err) {
        console.warn('Webhook send failed for Riley action response:', err instanceof Error ? err.message : 'Unknown');
      }
    }
  }

  for (const [, action, param] of actions) {
    try {
      switch (action.toUpperCase()) {
        case 'JOIN_VC': {
          const channels = getBotChannels();
          if (!channels) break;
          if (isCallActive()) {
            await sendAsRiley('📞 Already in a voice call.');
            break;
          }
          if (member) {
            await startCall(channels.voiceChannel, groupchat, channels.callLog, member);
          } else {
            await sendAsRiley('📞 I need you to be in the server to join VC.');
          }
          break;
        }
        case 'LEAVE_VC': {
          if (isCallActive()) {
            await endCall();
          } else {
            await sendAsRiley('No active voice call to leave.');
          }
          break;
        }
        case 'DEPLOY': {
          try {
            const { buildId, logUrl } = await triggerCloudBuild(param || 'latest');
            await sendAsRiley(
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
            await sendAsRiley(`❌ Deploy failed: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          break;
        }
        case 'SCREENSHOTS': {
          const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
          captureAndPostScreenshots(appUrl, param || 'manual').catch((err) => {
            sendAsRiley(`❌ Screenshot capture failed: ${err instanceof Error ? err.message : 'Unknown'}`).catch(() => {});
          });
          await sendAsRiley('📸 Capturing screenshots...');
          break;
        }
        case 'URLS': {
          const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
          const projectId = process.env.GCS_PROJECT_ID || 'asap-489910';
          const region = process.env.CLOUD_RUN_REGION || 'australia-southeast1';
          await sendAsRiley(
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
          await sendAsRiley(summary || '📋 No active tasks.');
          break;
        }
        case 'LIMITS': {
          const report = getUsageReport();
          await sendAsRiley(report);
          break;
        }
        case 'CLEAR': {
          clearHistory(groupchat.id);
          groupHistory.splice(0);
          clearMemory('groupchat');
          await sendAsRiley('🧹 Conversation context cleared.');
          break;
        }
        case 'ROLLBACK': {
          if (param) {
            try {
              const result = await rollbackToRevision(param);
              await sendAsRiley(result);
            } catch (err) {
              await sendAsRiley(`❌ Rollback failed: ${err instanceof Error ? err.message : 'Unknown'}`);
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
              await sendAsRiley(`📦 **Cloud Run Revisions**\n\n${list}`);
            } catch (err) {
              await sendAsRiley(`❌ Failed to list revisions: ${err instanceof Error ? err.message : 'Unknown'}`);
            }
          }
          break;
        }
        case 'AGENTS': {
          const agents = getAgents();
          const list = Array.from(agents.values())
            .map((a) => `${a.emoji} **${a.name}**`)
            .join('\n');
          await sendAsRiley(`**ASAP Agent Team**\n\n${list}`);
          break;
        }
        case 'CALL': {
          if (!isTelephonyAvailable()) {
            await sendAsRiley('📞 Phone system not configured (missing Twilio credentials).');
            break;
          }
          if (!param) {
            await sendAsRiley('📞 No phone number specified. Riley, include a number with [ACTION:CALL:number].');
            break;
          }
          // Twilio free trial only allows calls to verified numbers
          const phoneNumber = '0436012231';
          try {
            await makeOutboundCall(phoneNumber, "Hey Jordan, it's Riley! You asked me to give you a call.");
            await sendAsRiley(`📞 Calling ${phoneNumber}...`);
          } catch (err) {
            await sendAsRiley(`❌ Call failed: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          break;
        }
        case 'CONFERENCE': {
          if (!isTelephonyAvailable()) {
            await sendAsRiley('📞 Phone system not configured (missing Twilio credentials).');
            break;
          }
          // param format: "0436012231,0412345678" (comma-separated numbers)
          if (!param) {
            await sendAsRiley('📞 No phone numbers specified. Riley, include numbers with [ACTION:CONFERENCE:num1,num2].');
            break;
          }
          // Twilio free trial only allows calls to verified numbers
          const numbers = ['0436012231'];
          try {
            const confName = await startConferenceCall(numbers);
            await sendAsRiley(`📞 **Conference call started** — ${confName}\nCalling: ${numbers.join(', ')} + Riley`);
          } catch (err) {
            await sendAsRiley(`❌ Conference failed: ${err instanceof Error ? err.message : 'Unknown'}`);
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
  groupchat: TextChannel,
  signal?: AbortSignal
): Promise<void> {
  const directedAgents = parseDirectives(rileyResponse);
  if (directedAgents.length === 0) return;

  // If Ace was directed, he gets Riley's full plan
  const aceDirected = directedAgents.includes('developer');
  const otherDirected = directedAgents.filter((id) => id !== 'developer');
  const summaryLines: string[] = [];
  const errorLines: string[] = [];

  if (aceDirected) {
    const ace = getAgent('developer' as AgentId);
    if (ace) {
      try {
        if (signal?.aborted) return;
        const aceChannel = GROUPCHAT_SUMMARY_ONLY ? getAgentWorkChannel('developer', groupchat) : groupchat;
        aceChannel.sendTyping().catch(() => {});
        const aceMemory = getMemoryContext('developer');
        const aceContext = `[Riley directed you]: ${rileyResponse}\n\nImplement what Riley asked. Use repo tools. If you need a sub-agent's help, @mention them (e.g., @kane for security review, @elena for DB schema). Report back concisely when done.`;

        const aceResponse = await agentRespond(ace, [...aceMemory, ...groupHistory], aceContext, async (_toolName, summary) => {
          sendToolNotification(aceChannel, ace, summary).catch(() => {});
        }, { signal });

        if (signal?.aborted) return;

        await sendAgentMessage(aceChannel, ace, aceResponse);
        appendToMemory('developer', [
          { role: 'user', content: `[Riley directed]: ${rileyResponse.slice(0, 1000)}` },
          { role: 'assistant', content: `[Ace]: ${aceResponse}` },
        ]);
        documentToChannel('developer', aceResponse.slice(0, 300)).catch(() => {});

        summaryLines.push(`Ace: ${aceResponse.slice(0, 180)}`);

        groupHistory.push({ role: 'assistant', content: `[Ace]: ${aceResponse}` });
        goalStatus = '💻 Ace implementing...';

        // Ace may direct sub-agents
        const aceSubDirectives = parseDirectives(aceResponse);
        if (aceSubDirectives.length > 0) {
          const sub = await handleSubAgents(aceSubDirectives, aceResponse, groupchat, signal);
          summaryLines.push(...sub.findings);
          errorLines.push(...sub.errors);
        }
      } catch (err) {
        console.error('Ace error:', err instanceof Error ? err.message : 'Unknown');
        errorLines.push('Ace: error');
        if (!GROUPCHAT_SUMMARY_ONLY) {
          try {
            const wh = await getWebhook(groupchat);
            await wh.send({ content: `⚠️ Ace had an error.`, username: `${ace.emoji} ${ace.name}`, avatarURL: ace.avatarUrl });
          } catch (webhookErr) {
            console.warn('Webhook error notification failed for Ace:', webhookErr instanceof Error ? webhookErr.message : 'Unknown');
          }
        }
      }
    }
  }

  // Handle other agents Riley directed directly (not through Ace)
  if (otherDirected.length > 0) {
    const sub = await handleSubAgents(otherDirected, rileyResponse, groupchat, signal);
    summaryLines.push(...sub.findings);
    errorLines.push(...sub.errors);
  }

  if (GROUPCHAT_SUMMARY_ONLY && (summaryLines.length > 0 || errorLines.length > 0)) {
    const riley = getAgent('executive-assistant' as AgentId);
    if (riley) {
      const summary =
        `Quick update from the team.\n\n` +
        (summaryLines.length > 0
          ? `What came back:\n${summaryLines.slice(0, 12).map((s) => `- ${s}`).join('\n')}`
          : 'What came back:\n- No agent findings returned yet.') +
        (errorLines.length > 0
          ? `\n\nA couple blockers showed up:\n${errorLines.slice(0, 8).map((e) => `- ${e}`).join('\n')}`
          : '');
      await sendAgentMessage(groupchat, riley, summary);
    }
  }
}

/**
 * Tier-based parallelism: agents in the same tier run concurrently.
 * Earlier tiers complete before later tiers start, so designer output
 * informs implementation, and implementation informs reviewers.
 */
const AGENT_TIER: Record<string, number> = {
  'ux-reviewer': 0,      // Sophie — design first
  'dba': 0,              // Elena — schema design (parallel with Sophie)
  'api-reviewer': 0,     // Raj — API design (parallel with Sophie/Elena)
  'developer': 1,        // Ace — implementation (after design)
  'security-auditor': 2, // Kane — review (parallel with other reviewers)
  'lawyer': 2,           // Harper — compliance review
  'qa': 2,               // Max — testing review
  'performance': 2,      // Kai — perf review
  'copywriter': 2,       // Liv — copy review
  'devops': 3,           // Jude — deploy (after review)
  'ios-engineer': 3,     // Mia — platform (parallel with deploy)
  'android-engineer': 3, // Leo — platform
};

async function handleSubAgents(
  agentIds: string[],
  directiveContext: string,
  groupchat: TextChannel,
  signal?: AbortSignal
): Promise<{ findings: string[]; errors: string[] }> {
  const validAgents = agentIds
    .filter((id) => id !== 'executive-assistant')
    .map((id) => ({ id, agent: getAgent(id as AgentId) }))
    .filter((a): a is { id: string; agent: AgentConfig } => a.agent !== null && a.agent !== undefined);

  if (validAgents.length === 0) return { findings: [], errors: [] };

  // Group agents by tier
  const tiers = new Map<number, typeof validAgents>();
  for (const entry of validAgents) {
    const tier = AGENT_TIER[entry.id] ?? 99;
    if (!tiers.has(tier)) tiers.set(tier, []);
    tiers.get(tier)!.push(entry);
  }

  // Execute tiers in order; agents within each tier run in parallel
  const sortedTiers = [...tiers.keys()].sort((a, b) => a - b);
  const priorFindings: string[] = [];
  const errorLines: string[] = [];

  for (const tierNum of sortedTiers) {
    const tierAgents = tiers.get(tierNum)!;
    if (signal?.aborted) break;
    groupchat.sendTyping().catch(() => {});

    const priorContext = priorFindings.length > 0
      ? `\n\n**Prior agent findings (use these to inform your work):**\n${priorFindings.join('\n')}` : '';

    const tierResults = await Promise.allSettled(
      tierAgents.map(async ({ id, agent }) => {
        if (signal?.aborted) return;
        documentToChannel(id, `📥 Received task from groupchat. Working...`).catch(() => {});
        const agentMemory = getMemoryContext(id, 10);
        const agentContext = `[Directive from groupchat]: ${directiveContext}${priorContext}\n\nDo your job. Be concise in your response — max 200 words. Report what you found or did.`;
        const agentResponse = await agentRespond(agent, [...agentMemory, ...groupHistory], agentContext, async (_toolName, summary) => {
          documentToChannel(id, `🔧 ${summary}`).catch(() => {});
        }, { maxTokens: 4096, signal });

        if (signal?.aborted) return;

        const outChannel = GROUPCHAT_SUMMARY_ONLY ? getAgentWorkChannel(id, groupchat) : groupchat;
        await sendAgentMessage(outChannel, agent, agentResponse);
        appendToMemory(id, [
          { role: 'user', content: `[Groupchat directive]: ${directiveContext.slice(0, 500)}` },
          { role: 'assistant', content: `[${agent.name}]: ${agentResponse}` },
        ]);
        documentToChannel(id, `✅ ${agentResponse.slice(0, 300)}`).catch(() => {});
        groupHistory.push({ role: 'assistant', content: `[${agent.name.split(' ')[0]}]: ${agentResponse}` });
        return `[${agent.name.split(' ')[0]}]: ${agentResponse.slice(0, 500)}`;
      })
    );

    // Collect findings from this tier for the next tier
    for (const result of tierResults) {
      if (result.status === 'fulfilled') {
        if (typeof result.value === 'string' && result.value.length > 0) {
          priorFindings.push(result.value);
        }
      } else {
        console.error('Sub-agent tier error:', result.reason);
      }
    }

    // Report errors for failed agents
    for (let i = 0; i < tierResults.length; i++) {
      if (tierResults[i].status === 'rejected') {
        const { agent } = tierAgents[i];
        errorLines.push(`${agent.name.split(' ')[0]}: error`);
        if (!GROUPCHAT_SUMMARY_ONLY) {
          try {
            const wh = await getWebhook(groupchat);
            await wh.send({ content: `⚠️ ${agent.name.split(' ')[0]} had an error.`, username: `${agent.emoji} ${agent.name}`, avatarURL: agent.avatarUrl });
          } catch (webhookErr) {
            console.warn(`Webhook error notification failed for ${agent.name}:`, webhookErr instanceof Error ? webhookErr.message : 'Unknown');
          }
        }
      }
    }
  }
  persistGroupHistory();
  return { findings: priorFindings, errors: errorLines };
}

/**
 * User explicitly @mentioned agents — route directly to them in parallel.
 */
async function handleDirectedMessage(
  userMessage: string,
  senderName: string,
  agentIds: string[],
  groupchat: TextChannel,
  signal?: AbortSignal
): Promise<void> {
  const contextMessage = `[${senderName}]: ${userMessage}`;
  groupchat.sendTyping().catch(() => {});

  const validAgents = agentIds
    .map((id) => ({ id, agent: getAgent(id as AgentId) }))
    .filter((a): a is { id: string; agent: AgentConfig } => a.agent !== null && a.agent !== undefined);

  const summaryLines: string[] = [];
  const errorLines: string[] = [];

  const results = await Promise.allSettled(
    validAgents.map(async ({ id, agent }) => {
      if (signal?.aborted) return;
      const agentMemory = getMemoryContext(id, 10);
      const response = await agentRespond(agent, [...agentMemory, ...groupHistory], contextMessage, async (_toolName, summary) => {
        const outChannel = GROUPCHAT_SUMMARY_ONLY ? getAgentWorkChannel(id, groupchat) : groupchat;
        sendToolNotification(outChannel, agent, summary).catch(() => {});
      }, { maxTokens: 4096, signal });

      if (signal?.aborted) return;

      const outChannel = GROUPCHAT_SUMMARY_ONLY ? getAgentWorkChannel(id, groupchat) : groupchat;
      await sendAgentMessage(outChannel, agent, response);
      appendToMemory(id, [
        { role: 'user', content: contextMessage },
        { role: 'assistant', content: `[${agent.name}]: ${response}` },
      ]);
      documentToChannel(id, `Direct @mention from ${senderName}: ${response.slice(0, 200)}`).catch(() => {});
      groupHistory.push({ role: 'assistant', content: `[${agent.name.split(' ')[0]}]: ${response}` });
      summaryLines.push(`${agent.name.split(' ')[0]}: ${response.slice(0, 180)}`);
    })
  );

  // Report errors
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      const { agent } = validAgents[i];
      console.error(`${agent.name} error:`, (results[i] as PromiseRejectedResult).reason);
      errorLines.push(`${agent.name.split(' ')[0]}: error`);
      if (!GROUPCHAT_SUMMARY_ONLY) {
        try {
          const wh = await getWebhook(groupchat);
          await wh.send({ content: `⚠️ ${agent.name.split(' ')[0]} had an error.`, username: `${agent.emoji} ${agent.name}`, avatarURL: agent.avatarUrl });
        } catch (webhookErr) {
          console.warn(`Webhook error notification failed for ${agent.name}:`, webhookErr instanceof Error ? webhookErr.message : 'Unknown');
        }
      }
    }
  }

  if (GROUPCHAT_SUMMARY_ONLY) {
    const riley = getAgent('executive-assistant' as AgentId);
    if (riley) {
      const summary =
        `Quick update from the people you tagged.\n\n` +
        `What they said:\n${(summaryLines.length > 0 ? summaryLines : ['No agent findings returned yet.'])
          .slice(0, 12)
          .map((s) => `- ${s}`)
          .join('\n')}` +
        (errorLines.length > 0
          ? `\n\nA couple blockers showed up:\n${errorLines.slice(0, 8).map((e) => `- ${e}`).join('\n')}`
          : '');
      await sendAgentMessage(groupchat, riley, summary);
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

      const riley = getAgent('executive-assistant' as AgentId);
      if (riley) {
        try {
          const wh = await getWebhook(groupchat);
          await wh.send({ content: `✅ **${userName}** chose: **${choice}**`, username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
        } catch {
          await groupchat.send(`✅ **${userName}** chose: **${choice}**`);
        }
      } else {
        await groupchat.send(`✅ **${userName}** chose: **${choice}**`);
      }

      // Feed the decision back to Riley
      const decisionMessage = `${userName} chose option ${choiceIndex + 1}: ${choice}`;
      await handleRileyMessage(decisionMessage, userName, undefined, groupchat);
    }
  } catch {
    // Timeout — delete the stale decision embed and notify
    try { await decisionMsg.delete(); } catch { /* already deleted */ }
    const riley = getAgent('executive-assistant' as AgentId);
    if (riley) {
      try {
        const wh = await getWebhook(groupchat);
        await wh.send({ content: '⏰ Decision timed out. Please tell Riley what you want to do.', username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
      } catch {
        await groupchat.send('⏰ Decision timed out. Please tell Riley what you want to do.');
      }
    } else {
      await groupchat.send('⏰ Decision timed out. Please tell Riley what you want to do.');
    }
  }
}

/** Persist groupHistory to disk. Called after every interaction. */
function persistGroupHistory(): void {
  saveMemory('groupchat', groupHistory);
  // Trigger compression when history gets long (runs in background).
  // compressMemory mutates the cached array in-place, and groupHistory
  // IS that cached array, so no post-compression sync is needed.
  if (groupHistory.length >= 60) {
    compressMemory('groupchat').catch(() => {});
  }
}
