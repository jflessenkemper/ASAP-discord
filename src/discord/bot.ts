import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  ChatInputCommandInteraction,
} from 'discord.js';
import { setupChannels, BotChannels } from './setup';
import { getAgentByChannelName } from './agents';
import { handleAgentMessage } from './handlers/textChannel';
import { setCommandAuditCallback, setPRReviewCallback, setDiscordGuild, setToolAuditCallback, setAgentChannelResolver } from './tools';
import { autoReviewPR } from './handlers/review';
import { handleGroupchatMessage } from './handlers/groupchat';
import { setDecisionsChannel, setThreadStatusChannel, handleDecisionReply } from './handlers/groupchat';
import { endCall, isCallActive, processTesterVoiceTurnForCall } from './handlers/callSession';
import { setVoiceErrorChannel } from './handlers/callSession';
import { setBotChannels } from './handlers/documentation';
import { setAgentErrorChannel, postAgentErrorLog } from './services/agentErrors';
import { registerCommands } from './commands';
import { setGitHubChannel } from './handlers/github';
import { setLimitsChannel, setCostChannel, startDashboardUpdates, stopDashboardUpdates, initUsageCounters, flushUsageCounters, getUsageReport, getCostOpsSummaryLine } from './usage';
import { flushPendingWrites, initMemory } from './memory';
import { setScreenshotsChannel } from './services/screenshots';
import { setTelephonyChannels, isTelephonyAvailable, initContacts } from './services/telephony';
import { runModelHealthChecks } from './services/modelHealth';
import { flushAllOpsDigests, postOpsLine } from './services/opsFeed';
import { getThreadStatusOpsLine } from './handlers/groupchat';
import pool from '../db/pool';

/**
 * Discord runtime bootstrap.
 *
 * Responsibilities:
 * 1) Resolve and wire channels/services at startup.
 * 2) Route inbound messages to agent/groupchat handlers.
 * 3) Keep shared callbacks (tool audit, PR review, usage dashboards) connected.
 */
let client: Client | null = null;
let botChannels: BotChannels | null = null;
const DEFAULT_TESTER_BOT_ID = '1487426371209789450';
const RUNTIME_INSTANCE_TAG = (process.env.RUNTIME_INSTANCE_TAG || process.env.HOSTNAME || `pid-${process.pid}`).slice(0, 80);
let dedupeTableReady = false;
let lastDedupePruneAt = 0;

function isTesterBotId(userId: string): boolean {
  const configured = String(process.env.DISCORD_TESTER_BOT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const allowed = new Set([DEFAULT_TESTER_BOT_ID, ...configured]);
  return allowed.has(userId);
}

async function ensureDedupeTable(): Promise<void> {
  if (dedupeTableReady) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS discord_message_dedupe (
      message_id TEXT PRIMARY KEY,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  );
  dedupeTableReady = true;
}

async function claimDiscordMessage(messageId: string): Promise<boolean> {
  await ensureDedupeTable();
  const res = await pool.query(
    'INSERT INTO discord_message_dedupe (message_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_id',
    [messageId]
  );

  const now = Date.now();
  if (now - lastDedupePruneAt > 60 * 60 * 1000) {
    lastDedupePruneAt = now;
    void pool.query("DELETE FROM discord_message_dedupe WHERE claimed_at < NOW() - INTERVAL '3 days'").catch(() => {});
  }

  return (res.rowCount || 0) > 0;
}

function getTesterSpeechBridgeText(content: string): string | null {
  const normalized = String(content || '').trim();
  if (!normalized) return null;
  const match = normalized.match(/^(?:riley\s+)?(?:tester\s+)?(?:say|voice|speak)\s*(?::|-)\s*(.{1,260})$/i);
  if (!match) return null;
  return match[1].trim() || null;
}

/**
 * Get the current bot channels (used by webhook route).
 */
export function getBotChannels(): BotChannels | null {
  return botChannels;
}

/**
 * Initialize and start the Discord bot.
 * Requires DISCORD_BOT_TOKEN and DISCORD_GUILD_ID environment variables.
 */
export async function startBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token) {
    console.log('DISCORD_BOT_TOKEN not set — Discord bot disabled');
    return;
  }

  if (!guildId) {
    console.log('DISCORD_GUILD_ID not set — Discord bot disabled');
    return;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Discord bot logged in as ${readyClient.user.tag}`);

    let guild = readyClient.guilds.cache.get(guildId);
    if (!guild) {
      try {
        guild = await readyClient.guilds.fetch(guildId);
      } catch {
        console.error(`Guild ${guildId} not found. Invite the bot first.`);
        return;
      }
    }

    try {
      await initMemory();
      await initUsageCounters();
      botChannels = await setupChannels(guild);
      const configuredChannels = botChannels;
      setBotChannels(configuredChannels);
      setGitHubChannel(configuredChannels.github);
      setLimitsChannel(configuredChannels.limits);
      setCostChannel(configuredChannels.cost);
      setScreenshotsChannel(configuredChannels.screenshots);
      setVoiceErrorChannel(configuredChannels.voiceErrors);
      setAgentErrorChannel(configuredChannels.agentErrors);
      setDiscordGuild(guild);
      setAgentChannelResolver((agentId: string) => configuredChannels.agentChannels.get(agentId) || null);
      setDecisionsChannel(configuredChannels.decisions);
      setThreadStatusChannel(configuredChannels.threadStatus, configuredChannels.groupchat);
      if (isTelephonyAvailable()) {
        setTelephonyChannels(configuredChannels.callLog, configuredChannels.groupchat);
        await initContacts();
      }
      await startDashboardUpdates();
      runModelHealthChecks().catch((err) => {
        const msg = err instanceof Error ? err.message : 'Unknown';
        console.error('Model health check failed:', msg);
        void postAgentErrorLog('discord:model-health', 'Model health check failed', { detail: msg, level: 'warn' });
      });

      setCommandAuditCallback((cmd, allowed, reason) => {
        const githubChannel = configuredChannels.github;
        if (!githubChannel) return;
        const truncated = cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd;
        void postOpsLine(githubChannel, {
          actor: 'system',
          scope: 'command-audit',
          metric: `run-command allowed=${allowed}`,
          delta: `${truncated.replace(/\s+/g, ' ')} reason=${reason.replace(/\s+/g, ' ')}`,
          action: allowed ? 'none' : 'review blocked command request',
          severity: allowed ? 'info' : 'warn',
        });
      });

      let lastDbAuditPost = 0;
      let suppressedDbAudits = 0;
      const DB_AUDIT_POST_INTERVAL_MS = 30_000;
      const toAgentTag = (name: string): string => {
        const normalized = String(name || '').toLowerCase();
        if (normalized.includes('riley')) return 'executive-assistant';
        if (normalized.includes('ace')) return 'developer';
        if (normalized.includes('max')) return 'qa';
        if (normalized.includes('sophie')) return 'ux-reviewer';
        if (normalized.includes('kane')) return 'security-auditor';
        if (normalized.includes('raj')) return 'api-reviewer';
        if (normalized.includes('elena')) return 'dba';
        if (normalized.includes('kai')) return 'performance';
        if (normalized.includes('jude')) return 'devops';
        if (normalized.includes('liv')) return 'copywriter';
        if (normalized.includes('harper')) return 'lawyer';
        if (normalized.includes('mia')) return 'ios-engineer';
        if (normalized.includes('leo')) return 'android-engineer';
        return normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
      };
      setToolAuditCallback((agentName, toolName, summary) => {
        const terminalChannel = configuredChannels.terminal;
        if (!terminalChannel) return;

        const tag = toAgentTag(agentName);
        const isDbTool = toolName === 'db_query' || toolName === 'db_query_readonly';

        if (isDbTool) {
          const now = Date.now();
          if (now - lastDbAuditPost < DB_AUDIT_POST_INTERVAL_MS) {
            suppressedDbAudits++;
            return;
          }

          const suppressedNote = suppressedDbAudits > 0
            ? ` (+${suppressedDbAudits} db queries suppressed in last ${Math.round(DB_AUDIT_POST_INTERVAL_MS / 1000)}s)`
            : '';
          suppressedDbAudits = 0;
          lastDbAuditPost = now;
          void postOpsLine(terminalChannel, {
            actor: tag,
            scope: 'tool-audit:db',
            metric: toolName,
            delta: `batched${suppressedNote}`,
            action: 'none',
            severity: 'info',
          });
          return;
        }

        void postOpsLine(terminalChannel, {
          actor: tag,
          scope: 'tool-audit',
          metric: toolName,
          delta: summary.replace(/\s+/g, ' ').trim(),
          action: 'none',
          severity: 'info',
        });
      });

      setPRReviewCallback(async (prNumber, prTitle, changedFiles, diffSummary) => {
        await autoReviewPR(prNumber, prTitle, changedFiles, diffSummary, configuredChannels.groupchat);
      });
      console.log(`Discord channels configured in "${guild.name}"`);

      await registerCommands(readyClient, guildId);
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
      console.error('Channel setup error:', err instanceof Error ? err.message : 'Unknown');
      void postAgentErrorLog('discord:startup', 'Channel setup error', { detail: msg });
      console.error('Bot initialization failed — destroying client');
      readyClient.destroy();
      client = null;
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (botChannels && message.channel.id === botChannels.groupchat.id) {
      const linkSpam = message.author.bot
        && /🔗\s*\*\*ASAP Links\*\*|Cloud Build\*\*:\s*https?:\/\//i.test(String(message.content || ''));
      if (linkSpam) {
        await message.delete().catch(() => {});
        await botChannels.groupchat.send('🔗 Detailed links are available in #url.').catch(() => {});
        return;
      }
    }

    // Ignore bot traffic except the dedicated smoke-test bot so e2e tests can
    // still exercise the same production routing path.
    if (message.author.bot && !isTesterBotId(message.author.id)) return;
    if (!botChannels) return;

    const claimed = await claimDiscordMessage(message.id).catch((err) => {
      console.warn('Discord message dedupe check failed:', err instanceof Error ? err.message : 'Unknown');
      return true;
    });
    if (!claimed) return;

    const channelId = message.channel.id;

    try {
      for (const [agentId, channel] of botChannels.agentChannels) {
        if (channel.id === channelId) {
          const agent = getAgentByChannelName(agentId);
          if (agent) {
            await handleAgentMessage(message, agent);
          }
          return;
        }
      }

      if (channelId === botChannels.groupchat.id) {
        if (isTesterBotId(message.author.id)) {
          const testerSpeech = getTesterSpeechBridgeText(message.content);
          if (testerSpeech) {
            const injected = await processTesterVoiceTurnForCall({
              userId: message.author.id,
              username: message.member?.displayName || message.author.username || 'ASAPTester',
              text: testerSpeech,
            });
            if (injected.ok) {
              const modeLabel = injected.mode === 'voice' ? 'ASAPTester spoke in voice' : 'Tester speech injected into voice turn';
              await botChannels.groupchat.send(`🧪 ${modeLabel} [${RUNTIME_INSTANCE_TAG}]: "${testerSpeech.slice(0, 120)}"`).catch(() => {});
            } else {
              await botChannels.groupchat.send(`⚠️ ASAPTester voice turn failed [${RUNTIME_INSTANCE_TAG}]: ${injected.reason || 'unknown error'}`).catch(() => {});
            }
            return;
          }
        }

        await handleGroupchatMessage(message, botChannels.groupchat);
        return;
      }

      if (channelId === botChannels.decisions.id) {
        await handleDecisionReply(message, botChannels.groupchat);
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
      console.error('Message handler error:', err instanceof Error ? err.message : 'Unknown');
      void postAgentErrorLog('discord:message-handler', 'Message handler error', { detail: msg });
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'ops') return;

    try {
      await handleOpsInteraction(interaction);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unknown';
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: `Ops command failed: ${detail}`, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: `Ops command failed: ${detail}`, ephemeral: true }).catch(() => {});
      }
    }
  });

  try {
    await client.login(token);
  } catch (err) {
    const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
    console.error('Discord bot login failed:', err instanceof Error ? err.message : 'Unknown');
    void postAgentErrorLog('discord:login', 'Discord bot login failed', { detail: msg });
  }
}

/**
 * Gracefully shut down the Discord bot.
 */
export async function stopBot(): Promise<void> {
  stopDashboardUpdates();
  setCommandAuditCallback(() => {});
  setToolAuditCallback(() => {});
  setPRReviewCallback(async () => {});
  setCostChannel(null);
  setVoiceErrorChannel(null);
  setAgentErrorChannel(null);
  setThreadStatusChannel(null);
  await flushUsageCounters().catch(() => {});
  await flushAllOpsDigests().catch(() => {});
  if (isCallActive()) {
    await endCall();
  }
  await flushPendingWrites();
  if (client) {
    client.destroy();
    client = null;
    botChannels = null;
    console.log('Discord bot disconnected');
  }
}

async function handleOpsInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  const view = interaction.options.getSubcommand(true);

  if (view === 'deploy-checklist') {
    const phase = interaction.options.getString('phase') || 'full';
    const content = buildDeployChecklist(phase);
    await interaction.reply({ content: content.slice(0, 1900), ephemeral: true });
    return;
  }

  if (view === 'costs') {
    await interaction.reply({
      content: `💸 Ops costs\n${getCostOpsSummaryLine()}\n${getUsageReport().split('\n')[1] || ''}`.slice(0, 1900),
      ephemeral: true,
    });
    return;
  }

  if (view === 'threads') {
    const threadLine = await getThreadStatusOpsLine();
    await interaction.reply({
      content: `🧵 Ops threads\n${threadLine}`.slice(0, 1900),
      ephemeral: true,
    });
    return;
  }

  const threadLine = await getThreadStatusOpsLine();
  const costLine = getCostOpsSummaryLine();
  const liveLine = getUsageReport().split('\n')[1] || '';
  const payload = `📡 Ops now\n${costLine}\n${liveLine}\n${threadLine}`;
  await interaction.reply({ content: payload.slice(0, 1900), ephemeral: true });
}

function buildDeployChecklist(phase: string): string {
  const pre = [
    '🧰 PRE-DEPLOY',
    '1) Build/typecheck: npm run build',
    '2) Quality: npm run quality:app && (cd server && npm run quality)',
    '3) Security quick-pass: npm run security:semgrep && (cd server && npm run security:semgrep)',
    '4) Confirm env/secrets present for deploy target',
    '5) Commit + push with release notes and rollback commit hash',
  ];

  const post = [
    '✅ POST-DEPLOY',
    '1) Restart process and verify online status',
    '2) Run full Discord smoke suite (pre-clear enabled)',
    '3) Check /ops now + /ops threads + /ops costs outputs',
    '4) Confirm error channels stayed quiet (voice-errors, agent-errors)',
    '5) If failed: rollback immediately to previous known-good commit',
  ];

  if (phase === 'pre') return pre.join('\n');
  if (phase === 'post') return post.join('\n');
  return [...pre, '', ...post].join('\n');
}
