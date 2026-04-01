import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
} from 'discord.js';
import { setupChannels, BotChannels } from './setup';
import { getAgentByChannelName } from './agents';
import { handleAgentMessage } from './handlers/textChannel';
import { setCommandAuditCallback, setPRReviewCallback, setDiscordGuild, setToolAuditCallback, setAgentChannelResolver } from './tools';
import { autoReviewPR } from './handlers/review';
import { handleGroupchatMessage } from './handlers/groupchat';
import { setDecisionsChannel, setThreadStatusChannel, handleDecisionReply } from './handlers/groupchat';
import { endCall, isCallActive } from './handlers/callSession';
import { setVoiceErrorChannel } from './handlers/callSession';
import { setBotChannels } from './handlers/documentation';
import { setAgentErrorChannel, postAgentErrorLog } from './services/agentErrors';
import { unregisterCommands } from './commands';
import { setGitHubChannel } from './handlers/github';
import { setLimitsChannel, startDashboardUpdates, stopDashboardUpdates, initUsageCounters, flushUsageCounters } from './usage';
import { flushPendingWrites, initMemory } from './memory';
import { setScreenshotsChannel } from './services/screenshots';
import { setTelephonyChannels, isTelephonyAvailable, initContacts } from './services/telephony';
import { runModelHealthChecks } from './services/modelHealth';

let client: Client | null = null;
let botChannels: BotChannels | null = null;

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
      // Startup health snapshot to bot-diagnostics webhook
      runModelHealthChecks().catch((err) => {
        const msg = err instanceof Error ? err.message : 'Unknown';
        console.error('Model health check failed:', msg);
        void postAgentErrorLog('discord:model-health', 'Model health check failed', { detail: msg, level: 'warn' });
      });

      // Wire command audit to #github channel
      setCommandAuditCallback((cmd, allowed, reason) => {
        const githubChannel = configuredChannels.github;
        if (!githubChannel) return;
        const icon = allowed ? '✅' : '🚫';
        const truncated = cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd;
        githubChannel.send(`${icon} \`run_command\`: \`${truncated}\` — ${reason}`).catch(() => {});
      });

      // Wire tool audit to #terminal channel — every tool invocation from every agent
      let lastDbAuditPost = 0;
      let suppressedDbAudits = 0;
      const DB_AUDIT_POST_INTERVAL_MS = 30_000;
      setToolAuditCallback((agentName, toolName, summary) => {
        const terminalChannel = configuredChannels.terminal;
        if (!terminalChannel) return;

        const firstName = agentName.split(' ')[0];
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
          terminalChannel.send(`🧮 **${firstName}** → \`${toolName}\`${suppressedNote}`).catch(() => {});
          return;
        }

        terminalChannel.send(`🔧 **${firstName}** → \`${toolName}\`: ${summary}`).catch(() => {});
      });

      // Wire PR auto-review (Harper + Kane on sensitive files)
      setPRReviewCallback(async (prNumber, prTitle, changedFiles, diffSummary) => {
        await autoReviewPR(prNumber, prTitle, changedFiles, diffSummary, configuredChannels.groupchat);
      });
      console.log(`Discord channels configured in "${guild.name}"`);

      // Remove any old slash commands — everything is natural language now
      await unregisterCommands(readyClient, guildId);
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : 'Unknown';
      console.error('Channel setup error:', err instanceof Error ? err.message : 'Unknown');
      void postAgentErrorLog('discord:startup', 'Channel setup error', { detail: msg });
      // Fatal — bot cannot function without channels
      console.error('Bot initialization failed — destroying client');
      readyClient.destroy();
      client = null;
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    // Ignore bot messages — unless it's ASAPTester.
    // Keep a safe default so test automation survives env drift/restarts.
    const testerBotId = process.env.DISCORD_TESTER_BOT_ID || '1487426371209789450';
    if (message.author.bot && message.author.id !== testerBotId) return;
    if (!botChannels) return;

    const channelId = message.channel.id;

    try {
      // Check if this is an agent text channel
      for (const [agentId, channel] of botChannels.agentChannels) {
        if (channel.id === channelId) {
          const agent = getAgentByChannelName(agentId);
          if (agent) {
            await handleAgentMessage(message, agent);
          }
          return;
        }
      }

      // Check if this is the groupchat
      if (channelId === botChannels.groupchat.id) {
        await handleGroupchatMessage(message, botChannels.groupchat);
        return;
      }

      // Check if this is the decisions channel — route replies to Riley
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
  setVoiceErrorChannel(null);
  setAgentErrorChannel(null);
  setThreadStatusChannel(null);
  await flushUsageCounters().catch(() => {});
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
