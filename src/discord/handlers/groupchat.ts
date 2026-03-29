import { Message, TextChannel, GuildMember, EmbedBuilder } from 'discord.js';
import { getAgents, getAgent, AgentConfig, AgentId } from '../agents';
import { agentRespond, ConversationMessage } from '../claude';
import { appendToMemory, getMemoryContext, loadMemory, saveMemory, clearMemory, compressMemory } from '../memory';
import { documentToChannel } from './documentation';
import { sendAgentMessage, clearHistory } from './textChannel';
import { startCall, endCall, isCallActive } from './callSession';
import { makeOutboundCall, startConferenceCall, isTelephonyAvailable } from '../services/telephony';
import { getBotChannels } from '../bot';
import { approveAdditionalBudget, getUsageReport, refreshLiveBillingData, refreshUsageDashboard } from '../usage';
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

// Goal stall auto-recovery: if Riley workflow goes quiet, nudge and continue automatically.
const GOAL_STALL_TIMEOUT_MS = parseInt(process.env.GOAL_STALL_TIMEOUT_MS || '180000', 10);
const GOAL_STALL_CHECK_INTERVAL_MS = parseInt(process.env.GOAL_STALL_CHECK_INTERVAL_MS || '30000', 10);
const GOAL_STALL_MAX_RECOVERY_ATTEMPTS = parseInt(process.env.GOAL_STALL_MAX_RECOVERY_ATTEMPTS || '3', 10);
let lastGoalProgressAt = Date.now();
let goalRecoveryAttempts = 0;
let goalWatchdog: ReturnType<typeof setInterval> | null = null;

function markGoalProgress(status?: string): void {
  lastGoalProgressAt = Date.now();
  goalRecoveryAttempts = 0;
  if (status) goalStatus = status;
}

function compactAuditField(value: string | undefined | null, maxLen = 80): string {
  const normalized = (value || 'n/a').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1)}…`;
}

async function sendAutopilotAudit(
  groupchat: TextChannel,
  event: string,
  detail: string,
  extra?: { action?: string; buildId?: string; attempt?: number }
): Promise<void> {
  const riley = getAgent('executive-assistant' as AgentId);
  const goal = compactAuditField(activeGoal || 'none', 64);
  const status = compactAuditField(goalStatus || 'n/a', 48);
  const bits = [
    `event=${event}`,
    extra?.action ? `action=${compactAuditField(extra.action, 24)}` : null,
    Number.isFinite(extra?.attempt) ? `attempt=${extra!.attempt}` : null,
    extra?.buildId ? `build=${compactAuditField(extra.buildId, 24)}` : null,
    `goal="${goal}"`,
    `status="${status}"`,
    `detail="${compactAuditField(detail, 120)}"`,
  ].filter(Boolean);
  const line = `AUTOPILOT_AUDIT ${bits.join(' ')}`;

  if (!riley) {
    await groupchat.send(line).catch(() => {});
    return;
  }

  try {
    const wh = await getWebhook(groupchat);
    await wh.send({ content: line, username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
  } catch {
    await groupchat.send(line).catch(() => {});
  }
}

function inferImplicitActionTags(text: string): string {
  const tags = new Set<string>();
  const normalized = text.toLowerCase();

  if (/(build triggered|triggered build|deploying|deployment triggered|rolling out|release started)/i.test(normalized)) {
    tags.add('[ACTION:DEPLOY]');
  }
  if (/(capturing screenshots|taking screenshots|screenshot capture|posting screenshots)/i.test(normalized)) {
    tags.add('[ACTION:SCREENSHOTS]');
  }
  if (/(asap links|live url|app url|posting.*url|paste.*url|share.*url)/i.test(normalized)) {
    tags.add('[ACTION:URLS]');
  }
  if (/(usage report|limits report|budget report|token report)/i.test(normalized)) {
    tags.add('[ACTION:LIMITS]');
  }

  return [...tags].join('\n');
}

function ensureGoalWatchdog(groupchat: TextChannel): void {
  if (goalWatchdog) return;

  goalWatchdog = setInterval(() => {
    if (!activeGoal) return;
    if (activeAbortController) return;
    if (Date.now() - lastGoalProgressAt < GOAL_STALL_TIMEOUT_MS) return;
    if (goalRecoveryAttempts >= GOAL_STALL_MAX_RECOVERY_ATTEMPTS) return;

    goalRecoveryAttempts += 1;
    goalStatus = `⚠️ Auto-recovery nudge ${goalRecoveryAttempts}/${GOAL_STALL_MAX_RECOVERY_ATTEMPTS}`;
    lastGoalProgressAt = Date.now();

    sendAutopilotAudit(
      groupchat,
      'watchdog_recovery',
      'Goal was stalled; sending system nudge to Riley for continuation and pending actions.',
      { attempt: goalRecoveryAttempts }
    ).catch(() => {});

    handleRileyMessage(
      `[System auto-recovery] This goal appears stalled: "${activeGoal}". Summarize current state in one short paragraph, execute any pending deploy/screenshots/urls actions now using explicit [ACTION:...] tags, and continue without waiting for user follow-up.`,
      'System',
      undefined,
      groupchat
    ).catch((err) => {
      console.error('Goal watchdog recovery error:', err instanceof Error ? err.message : 'Unknown');
    });
  }, GOAL_STALL_CHECK_INTERVAL_MS);
}

// Dedicated channel for overnight decision queuing (set from bot.ts)
let decisionsChannel: TextChannel | null = null;

/** Wire up the #decisions channel from bot startup. */
export function setDecisionsChannel(channel: TextChannel): void {
  decisionsChannel = channel;
}

/** Generic @mention parser, aliases resolved through NAME_TO_ID + known agent IDs. */
const AGENT_MENTION_RE = /@([a-z0-9-]+)\b/gi;

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

function resolveMentionedAgentId(raw: string): string | null {
  const key = raw.toLowerCase();
  const mapped = NAME_TO_ID[key] || key;
  if (getAgents().has(mapped as AgentId)) return mapped;
  return null;
}

function parseMentionedAgentIds(text: string, allowedIds?: Set<string>): string[] {
  const found = new Set<string>();
  AGENT_MENTION_RE.lastIndex = 0;
  for (const match of text.matchAll(AGENT_MENTION_RE)) {
    const resolved = resolveMentionedAgentId(match[1]);
    if (!resolved) continue;
    if (allowedIds && !allowedIds.has(resolved)) continue;
    found.add(resolved);
  }
  return [...found];
}

// Keep groupchat concise: specialist agents work in their own channels, then
// Riley posts a single consolidated summary to groupchat.
const GROUPCHAT_SUMMARY_ONLY = process.env.GROUPCHAT_SUMMARY_ONLY !== 'false';

function summarizeForRiley(raw: string, maxChars = 420): string {
  const singleLine = raw.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxChars) return singleLine;
  const sentenceWindow = singleLine.slice(0, Math.min(singleLine.length, maxChars + 120));
  const sentenceBreak = Math.max(
    sentenceWindow.lastIndexOf('. '),
    sentenceWindow.lastIndexOf('! '),
    sentenceWindow.lastIndexOf('? ')
  );
  if (sentenceBreak >= Math.floor(maxChars * 0.65)) {
    return `${sentenceWindow.slice(0, sentenceBreak + 1).trim()}…`;
  }
  return `${singleLine.slice(0, maxChars - 1)}…`;
}

function parseBudgetApproval(text: string): number | undefined | null {
  const normalized = text.toLowerCase().trim();

  // Simple one-word / short confirmations — "yes", "yep", "yeah", "ok", "sure", "go", "continue", "resume", "proceed"
  const simpleYes = /^(yes|yep|yeah|yup|ok|okay|sure|go|go ahead|continue|resume|proceed|approved?|keep going|carry on|do it|let'?s? go)$/i.test(normalized);
  if (simpleYes) return undefined; // undefined → use default increment

  // Must mention approval intent AND budget/spend subject, OR say standalone "approve"
  const hasApprovalWord = /(approve|approved|increase|raise|bump|add|authorise|authorize)/i.test(normalized);
  const hasBudgetWord = /(budget|spend|limit|credits?|more|extra|funds?)/i.test(normalized);
  const standaloneApprove = /^approve[sd]?[!.]*$/i.test(normalized);

  if (!standaloneApprove && !(hasApprovalWord && hasBudgetWord)) return null;

  const dollarMatch = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  if (dollarMatch) return parseFloat(dollarMatch[1]);

  const numberMatch = text.match(/\b(\d+(?:\.\d{1,2})?)\b/);
  if (numberMatch) return parseFloat(numberMatch[1]);

  return undefined;
}

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
  ensureGoalWatchdog(groupchat);

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
  markGoalProgress();

  const approvedAmount = parseBudgetApproval(content);
  if (approvedAmount !== null) {
    const riley = getAgent('executive-assistant' as AgentId);
    const result = approveAdditionalBudget(Number.isFinite(approvedAmount) ? approvedAmount : undefined);
    await refreshUsageDashboard().catch(() => {});

    if (riley) {
      await sendAgentMessage(
        groupchat,
        riley,
        `Budget approval recorded. I added $${result.added.toFixed(2)} of extra budget for today, so the new limit is $${result.limit.toFixed(2)}. We've spent $${result.spent.toFixed(2)} so far and have $${result.remaining.toFixed(2)} remaining.`
      );
    }

    if (activeGoal) {
      markGoalProgress('▶️ Resuming after budget approval');
      await handleRileyMessage(
        `Budget approval has been granted by ${senderName}. Resume the paused work on this goal: ${activeGoal}`,
        senderName,
        message.member || undefined,
        groupchat,
        signal
      );
    }
    return;
  }

  // Check for explicit @agent mentions — route directly
  const uniqueMentions = parseMentionedAgentIds(content);

  if (uniqueMentions.length > 0) {
    // If user only mentions Riley, keep full Riley orchestration path so
    // action tags, watchdog, and fire-and-forget behavior all run.
    if (uniqueMentions.length === 1 && uniqueMentions[0] === 'executive-assistant') {
      activeGoal = content;
      markGoalProgress('⏳ Riley planning...');
      await handleRileyMessage(content, senderName, message.member || undefined, groupchat, signal);
    } else {
      // User explicitly @mentioned non-Riley agents — route to them directly
      await handleDirectedMessage(content, senderName, uniqueMentions, groupchat, signal);
    }
  } else {
    // No @mentions — goes to Riley, she coordinates
    activeGoal = content;
    markGoalProgress('⏳ Riley planning...');
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
  markGoalProgress('⏳ Planning...');

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
      markGoalProgress('🧭 Riley coordinating...');
    }

    appendToMemory('executive-assistant', [
      { role: 'user', content: contextMessage },
      { role: 'assistant', content: `[Riley]: ${response}` },
    ]);

    groupHistory.push({ role: 'user', content: contextMessage });
    groupHistory.push({ role: 'assistant', content: `[Riley]: ${response}` });
    persistGroupHistory();

    if (signal?.aborted) return;

    // Execute explicit tags and implied actions when Riley says actions are underway but omits tags.
    const implicitTags = inferImplicitActionTags(displayResponse);
    const actionPayload = implicitTags ? `${response}\n${implicitTags}` : response;
    if (implicitTags) {
      await sendAgentMessage(groupchat, riley, `Autopilot: executing implied actions.\n${implicitTags}`);
      await sendAutopilotAudit(
        groupchat,
        'implied_actions',
        'Riley response implied operational actions without explicit tags; autopilot synthesized tags.',
        { action: implicitTags.replace(/\s+/g, ',') }
      );
    }
    await executeActions(actionPayload, member, groupchat);
    markGoalProgress();

    // Check if Riley presented a decision (🛑)
    // Fire-and-forget: post to #decisions without blocking so Riley continues with stated assumption
    if (displayResponse.includes('🛑') || displayResponse.includes('Decision Required')) {
      const target = decisionsChannel || groupchat;
      postDecisionEmbed(target, groupchat, displayResponse).catch(() => {});
      // Riley does NOT stop here — she proceeds with her stated assumption
    }

    if (signal?.aborted) return;

    // Check if Riley directed Ace or other agents
    await handleAgentChain(response, groupchat, signal);
    markGoalProgress('✅ Riley cycle completed');
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

    // Fallback keeps action visibility even if webhook provisioning is stale.
    await groupchat.send(msg).catch(() => {});
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
            markGoalProgress('🚀 Deploy triggered');
            await sendAutopilotAudit(groupchat, 'action_executed', 'Cloud Build deployment was triggered.', {
              action: 'DEPLOY',
              buildId,
            });
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
          markGoalProgress('📸 Screenshot capture started');
          await sendAutopilotAudit(groupchat, 'action_executed', 'Screenshot capture workflow started.', {
            action: 'SCREENSHOTS',
          });
          await sendAsRiley('📸 Capturing screenshots...');
          break;
        }
        case 'URLS': {
          const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
          const projectId = process.env.GCS_PROJECT_ID || 'asap-489910';
          const region = process.env.CLOUD_RUN_REGION || 'australia-southeast1';
          markGoalProgress('🔗 URLs posted');
          await sendAutopilotAudit(groupchat, 'action_executed', 'ASAP links were posted.', {
            action: 'URLS',
          });
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
          await refreshLiveBillingData().catch(() => {});
          const report = getUsageReport();
          markGoalProgress('📊 Usage report posted');
          await sendAsRiley(report);
          break;
        }
        case 'CLEAR': {
          clearHistory(groupchat.id);
          groupHistory.splice(0);
          clearMemory('groupchat');
          markGoalProgress('🧹 Context cleared');
          await sendAsRiley('🧹 Conversation context cleared.');
          break;
        }
        case 'ROLLBACK': {
          if (param) {
            try {
              const result = await rollbackToRevision(param);
              markGoalProgress('↩️ Rollback complete');
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
          const verifiedNumbers = (process.env.TWILIO_VERIFIED_NUMBERS || '0436012231')
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean);
          const phoneNumber = param.trim();
          if (!verifiedNumbers.includes(phoneNumber)) {
            await sendAsRiley(`📞 ${phoneNumber} is not in the verified list for this Twilio account. Verified numbers: ${verifiedNumbers.join(', ')}`);
            break;
          }
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
          const verifiedNumbers = new Set(
            (process.env.TWILIO_VERIFIED_NUMBERS || '0436012231')
              .split(',')
              .map((n) => n.trim())
              .filter(Boolean)
          );
          const requested = param
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean);
          const numbers = requested.filter((n) => verifiedNumbers.has(n));
          if (numbers.length === 0) {
            await sendAsRiley(`📞 None of the requested numbers are verified for this Twilio account. Verified numbers: ${[...verifiedNumbers].join(', ')}`);
            break;
          }
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
const DIRECTED_AGENT_IDS = new Set<string>([
  'developer', 'qa', 'ux-reviewer', 'security-auditor', 'api-reviewer',
  'dba', 'performance', 'devops', 'copywriter', 'lawyer',
  'ios-engineer', 'android-engineer',
]);

const RILEY_USE_ALL_AGENTS = process.env.RILEY_USE_ALL_AGENTS !== 'false';

function parseDirectives(text: string): string[] {
  return parseMentionedAgentIds(text, DIRECTED_AGENT_IDS);
}

function shouldFanOutAllAgents(rileyResponse: string): boolean {
  const text = rileyResponse.toLowerCase();
  if (text.includes('no action needed') || text.includes('for awareness only')) return false;
  if (/(only|just)\s+@(ace|max|sophie|kane|raj|elena|kai|jude|liv|harper|mia|leo)\b/i.test(rileyResponse)) return false;
  return true;
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
  const wantsFullTeam = RILEY_USE_ALL_AGENTS && shouldFanOutAllAgents(rileyResponse);
  const effectiveAgents = wantsFullTeam
    ? [...DIRECTED_AGENT_IDS]
    : directedAgents;
  if (effectiveAgents.length === 0) return;
  markGoalProgress('🧩 Coordinating specialist agents...');

  // If Ace was directed, he gets Riley's full plan
  const aceDirected = effectiveAgents.includes('developer');
  const otherDirected = effectiveAgents.filter((id) => id !== 'developer');
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
        if (GROUPCHAT_SUMMARY_ONLY && aceChannel.id !== groupchat.id) {
          await sendAgentMessage(groupchat, ace, summarizeForRiley(aceResponse));
        }
        appendToMemory('developer', [
          { role: 'user', content: `[Riley directed]: ${rileyResponse.slice(0, 1000)}` },
          { role: 'assistant', content: `[Ace]: ${aceResponse}` },
        ]);
        documentToChannel('developer', aceResponse.slice(0, 300)).catch(() => {});

        groupHistory.push({ role: 'assistant', content: `[Ace]: ${aceResponse}` });
        markGoalProgress('💻 Ace implementing...');

        // Ace may direct sub-agents
        const aceSubDirectives = parseDirectives(aceResponse);
        if (aceSubDirectives.length > 0) {
          await handleSubAgents(aceSubDirectives, aceResponse, groupchat, signal);
        }
      } catch (err) {
        console.error('Ace error:', err instanceof Error ? err.message : 'Unknown');
        try {
          const wh = await getWebhook(groupchat);
          await wh.send({ content: `⚠️ Ace had an error.`, username: `${ace.emoji} ${ace.name}`, avatarURL: ace.avatarUrl });
        } catch (webhookErr) {
          console.warn('Webhook error notification failed for Ace:', webhookErr instanceof Error ? webhookErr.message : 'Unknown');
        }
      }
    }
  }

  // Handle other agents Riley directed directly (not through Ace)
  if (otherDirected.length > 0) {
    await handleSubAgents(otherDirected, rileyResponse, groupchat, signal);
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
  markGoalProgress('🛠️ Sub-agents running...');

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
        if (GROUPCHAT_SUMMARY_ONLY && outChannel.id !== groupchat.id) {
          await sendAgentMessage(groupchat, agent, summarizeForRiley(agentResponse));
        }
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
        try {
          const wh = await getWebhook(groupchat);
          await wh.send({ content: `⚠️ ${agent.name.split(' ')[0]} had an error.`, username: `${agent.emoji} ${agent.name}`, avatarURL: agent.avatarUrl });
        } catch (webhookErr) {
          console.warn(`Webhook error notification failed for ${agent.name}:`, webhookErr instanceof Error ? webhookErr.message : 'Unknown');
        }
      }
    }
  }
  persistGroupHistory();
  markGoalProgress('📝 Sub-agent cycle completed');
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
  markGoalProgress('🎯 Direct specialist routing...');
  groupchat.sendTyping().catch(() => {});

  const validAgents = agentIds
    .map((id) => ({ id, agent: getAgent(id as AgentId) }))
    .filter((a): a is { id: string; agent: AgentConfig } => a.agent !== null && a.agent !== undefined);

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
      if (GROUPCHAT_SUMMARY_ONLY && outChannel.id !== groupchat.id) {
        await sendAgentMessage(groupchat, agent, summarizeForRiley(response));
      }
      appendToMemory(id, [
        { role: 'user', content: contextMessage },
        { role: 'assistant', content: `[${agent.name}]: ${response}` },
      ]);
      documentToChannel(id, `Direct @mention from ${senderName}: ${response.slice(0, 200)}`).catch(() => {});
      groupHistory.push({ role: 'assistant', content: `[${agent.name.split(' ')[0]}]: ${response}` });
    })
  );

  // Report errors
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      const { agent } = validAgents[i];
      console.error(`${agent.name} error:`, (results[i] as PromiseRejectedResult).reason);
      try {
        const wh = await getWebhook(groupchat);
        await wh.send({ content: `⚠️ ${agent.name.split(' ')[0]} had an error.`, username: `${agent.emoji} ${agent.name}`, avatarURL: agent.avatarUrl });
      } catch (webhookErr) {
        console.warn(`Webhook error notification failed for ${agent.name}:`, webhookErr instanceof Error ? webhookErr.message : 'Unknown');
      }
    }
  }

  groupHistory.push({ role: 'user', content: contextMessage });
  persistGroupHistory();
  markGoalProgress('✅ Directed response completed');
}

/**
 * Handle a reply typed in the #decisions channel.
 * Routes the answer back to Riley in groupchat so she can continue blocked work.
 */
export async function handleDecisionReply(
  message: Message,
  groupchat: TextChannel
): Promise<void> {
  const userName = message.member?.displayName || message.author.username;
  const content = message.content.trim();
  if (!content) return;

  // Acknowledge inline so the user knows it was received
  try {
    await message.react('✅');
  } catch { /* ignore — bot may lack reaction perms */ }

  await handleRileyMessage(
    `[Decision response from ${userName} in #decisions]: ${content}`,
    userName,
    message.member || undefined,
    groupchat
  );
}

/**
 * Post a reaction-based decision embed.
 * Parses numbered options from Riley's response and adds reaction buttons.
 */
async function postDecisionEmbed(
  targetChannel: TextChannel,
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

  const isDecisionsChannel = decisionsChannel && targetChannel.id === decisionsChannel.id;

  const embed = new EmbedBuilder()
    .setTitle('🛑 Decision Required')
    .setDescription(
      options
        .slice(0, 5)
        .map((opt, i) => `${reactions[i]} ${opt}`)
        .join('\n\n')
    )
    .setColor(0xff4444)
    .setFooter({ text: isDecisionsChannel ? 'React to choose or type your answer here' : 'React to choose • Times out in 5 minutes' });

  const decisionMsg = await targetChannel.send({ embeds: [embed] });

  // Add reaction buttons
  for (let i = 0; i < Math.min(options.length, 5); i++) {
    await decisionMsg.react(reactions[i]).catch(() => {});
  }

  // Background reaction listener:
  // - In #decisions: 12h window (overnight) — non-blocking
  // - In groupchat fallback: 5-min window as before, but still non-blocking
  const timeoutMs = isDecisionsChannel ? 12 * 60 * 60 * 1000 : 5 * 60 * 1000;
  const filter = (reaction: any, user: any) => {
    return reactions.slice(0, options.length).includes(reaction.emoji.name || '') && !user.bot;
  };

  decisionMsg.awaitReactions({ filter, max: 1, time: timeoutMs })
    .then(async (collected) => {
      const reaction = collected.first();
      if (!reaction) return;
      const choiceIndex = reactions.indexOf(reaction.emoji.name || '');
      const choice = options[choiceIndex] || `Option ${choiceIndex + 1}`;
      const users = await reaction.users.fetch();
      const reactUser = users.find((u) => !u.bot);
      const userName = reactUser?.username || 'User';

      console.log(`Decision: ${userName} chose option ${choiceIndex + 1}: "${choice}"`);

      const riley = getAgent('executive-assistant' as AgentId);
      if (riley) {
        try {
          const wh = await getWebhook(targetChannel);
          await wh.send({ content: `✅ **${userName}** chose: **${choice}**`, username: `${riley.emoji} ${riley.name}`, avatarURL: riley.avatarUrl });
        } catch {
          await targetChannel.send(`✅ **${userName}** chose: **${choice}**`);
        }
      } else {
        await targetChannel.send(`✅ **${userName}** chose: **${choice}**`);
      }

      // Feed the decision back to Riley
      const decisionMessage = `${userName} chose option ${choiceIndex + 1}: ${choice}`;
      await handleRileyMessage(decisionMessage, userName, undefined, groupchat);
    })
    .catch(() => {
      // Timeout — silent, user can still reply in #decisions or groupchat
    });
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
