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
import { setCommandAuditCallback, setPRReviewCallback } from './tools';
import { autoReviewPR } from './handlers/review';
import { handleGroupchatMessage } from './handlers/groupchat';
import { endCall, isCallActive } from './handlers/callSession';
import { setBotChannels } from './handlers/documentation';
import { registerCommands, handleCommand } from './commands';
import { setGitHubChannel } from './handlers/github';
import { setLimitsChannel, startDashboardUpdates, stopDashboardUpdates } from './usage';

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
      botChannels = await setupChannels(guild);
      setBotChannels(botChannels);
      setGitHubChannel(botChannels.github);
      setLimitsChannel(botChannels.limits);
      await startDashboardUpdates();

      // Wire command audit to #github channel
      setCommandAuditCallback((cmd, allowed, reason) => {
        const icon = allowed ? '✅' : '🚫';
        const truncated = cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd;
        botChannels!.github.send(`${icon} \`run_command\`: \`${truncated}\` — ${reason}`).catch(() => {});
      });

      // Wire PR auto-review (Harper + Kane on sensitive files)
      setPRReviewCallback(async (prNumber, prTitle, changedFiles, diffSummary) => {
        await autoReviewPR(prNumber, prTitle, changedFiles, diffSummary, botChannels!.groupchat);
      });
      console.log(`Discord channels configured in "${guild.name}"`);

      // Register slash commands
      await registerCommands(readyClient, guildId);
    } catch (err) {
      console.error('Channel setup error:', err instanceof Error ? err.message : 'Unknown');
    }
  });

  // Handle slash commands
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!botChannels) return;

    await handleCommand(interaction as ChatInputCommandInteraction, botChannels);
  });

  client.on(Events.MessageCreate, async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;
    if (!botChannels) return;

    const channelId = message.channel.id;

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
  });

  try {
    await client.login(token);
  } catch (err) {
    console.error('Discord bot login failed:', err instanceof Error ? err.message : 'Unknown');
  }
}

/**
 * Gracefully shut down the Discord bot.
 */
export async function stopBot(): Promise<void> {
  stopDashboardUpdates();
  if (isCallActive()) {
    await endCall();
  }
  if (client) {
    client.destroy();
    client = null;
    botChannels = null;
    console.log('Discord bot disconnected');
  }
}
