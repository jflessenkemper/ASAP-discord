import {
  Client,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  TextChannel,
  GuildMember,
  VoiceChannel,
} from 'discord.js';
import { getAgents, getAgent, AgentId } from './agents';
import { BotChannels } from './setup';
import { startCall, endCall, isCallActive } from './handlers/callSession';
import { clearHistory } from './handlers/textChannel';
import { handleGoalCommand, getStatusSummary } from './handlers/groupchat';
import { getUsageReport } from './usage';
import { listRevisions, rollbackToRevision, getCurrentRevision } from '../services/cloudrun';

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('goal')
    .setDescription('Give Riley a goal to plan and execute')
    .addStringOption((opt) =>
      opt.setName('description').setDescription('What do you want done?').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('call')
    .setDescription('Start a voice call with Riley and Ace'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('End the current voice call'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show current progress and active tasks'),
  new SlashCommandBuilder()
    .setName('agents')
    .setDescription('List all available agents and their expertise'),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask a specific agent a question (through Riley)')
    .addStringOption((opt) =>
      opt
        .setName('agent')
        .setDescription('Agent name (e.g., kane, elena, max)')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('question').setDescription('Your question').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Reset conversation context'),
  new SlashCommandBuilder()
    .setName('limits')
    .setDescription('Show API usage limits and estimated costs'),
  new SlashCommandBuilder()
    .setName('rollback')
    .setDescription('Rollback to a previous Cloud Run revision')
    .addStringOption((opt) =>
      opt.setName('revision').setDescription('Revision name (leave empty to see list)')
    ),
];

/**
 * Register slash commands with Discord API.
 */
export async function registerCommands(client: Client, guildId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(client.token!);

  try {
    await rest.put(Routes.applicationGuildCommands(client.user!.id, guildId), {
      body: COMMANDS.map((c) => c.toJSON()),
    });
    console.log(`Registered ${COMMANDS.length} slash commands`);
  } catch (err) {
    console.error('Slash command registration error:', err instanceof Error ? err.message : 'Unknown');
  }
}

/**
 * Handle a slash command interaction.
 */
export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  channels: BotChannels
): Promise<void> {
  const { commandName } = interaction;

  switch (commandName) {
    case 'goal':
      await handleGoalSlash(interaction, channels);
      break;
    case 'call':
      await handleCallSlash(interaction, channels);
      break;
    case 'leave':
      await handleLeaveSlash(interaction, channels);
      break;
    case 'status':
      await handleStatusSlash(interaction);
      break;
    case 'agents':
      await handleAgentsSlash(interaction);
      break;
    case 'ask':
      await handleAskSlash(interaction, channels);
      break;
    case 'clear':
      await handleClearSlash(interaction, channels);
      break;
    case 'limits':
      await handleLimitsSlash(interaction);
      break;
    case 'rollback':
      await handleRollbackSlash(interaction);
      break;
    default:
      await interaction.reply({ content: 'Unknown command.', ephemeral: true });
  }
}

async function handleGoalSlash(
  interaction: ChatInputCommandInteraction,
  channels: BotChannels
): Promise<void> {
  const description = interaction.options.getString('description', true);
  await interaction.reply(`🎯 **Goal received:** ${description}\n\nRiley is planning...`);

  // Delegate to the groupchat goal handler (fire and forget — reply already sent)
  handleGoalCommand(
    description,
    interaction.member as GuildMember,
    channels.groupchat
  ).catch((err) => {
    console.error('Goal command error:', err instanceof Error ? err.message : 'Unknown');
    channels.groupchat.send('⚠️ Riley encountered an error planning this goal. Try again.').catch(() => {});
  });
}

async function handleCallSlash(
  interaction: ChatInputCommandInteraction,
  channels: BotChannels
): Promise<void> {
  if (isCallActive()) {
    await interaction.reply({ content: '⚠️ A call is already in progress. Use `/leave` to end it first.', ephemeral: true });
    return;
  }
  const member = interaction.member as GuildMember;
  await interaction.reply('📞 Starting voice call...');
  await startCall(channels.voiceChannel, channels.groupchat, channels.callLog, member);
}

async function handleLeaveSlash(
  interaction: ChatInputCommandInteraction,
  channels: BotChannels
): Promise<void> {
  if (!isCallActive()) {
    await interaction.reply({ content: 'No active call to leave.', ephemeral: true });
    return;
  }
  await interaction.reply('📞 Ending call...');
  await endCall();
}

async function handleStatusSlash(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const summary = getStatusSummary();
  await interaction.reply(summary || '📋 No active tasks. Give Riley a `/goal` to get started.');
}

async function handleAgentsSlash(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const agents = getAgents();
  const list = Array.from(agents.values())
    .map((a) => `${a.emoji} **${a.name}**`)
    .join('\n');

  await interaction.reply(
    `**ASAP Agent Team**\n\n` +
      `${list}\n\n` +
      `Riley coordinates everything. Use \`/ask <agent> <question>\` to direct a question.`
  );
}

async function handleAskSlash(
  interaction: ChatInputCommandInteraction,
  channels: BotChannels
): Promise<void> {
  const agentName = interaction.options.getString('agent', true).toLowerCase();
  const question = interaction.options.getString('question', true);

  // Find agent
  const nameToId: Record<string, string> = {
    ace: 'developer', max: 'qa', sophie: 'ux-reviewer',
    kane: 'security-auditor', raj: 'api-reviewer', elena: 'dba',
    kai: 'performance', jude: 'devops', liv: 'copywriter', harper: 'lawyer',
    riley: 'executive-assistant', mia: 'ios-engineer', leo: 'android-engineer',
  };

  const agentId = nameToId[agentName] || agentName;
  const agent = getAgent(agentId as AgentId);

  if (!agent) {
    await interaction.reply({
      content: `Unknown agent "${agentName}". Use \`/agents\` to see the team.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.reply(`📋 Riley is routing your question to **${agent.name}**...`);

  // Route through groupchat as a directed message
  const member = interaction.member as GuildMember;
  handleGoalCommand(
    `Ask ${agent.name}: ${question}`,
    member,
    channels.groupchat
  ).catch((err) => {
    console.error('Ask command error:', err instanceof Error ? err.message : 'Unknown');
    channels.groupchat.send('⚠️ Riley encountered an error routing this question. Try again.').catch(() => {});
  });
}

async function handleClearSlash(
  interaction: ChatInputCommandInteraction,
  channels: BotChannels
): Promise<void> {
  clearHistory(channels.groupchat.id);
  await interaction.reply({ content: '🧹 Conversation context cleared.', ephemeral: true });
}

async function handleLimitsSlash(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const report = getUsageReport();
  await interaction.reply(report);
}

async function handleRollbackSlash(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const revision = interaction.options.getString('revision');

  if (!revision) {
    // Show available revisions
    await interaction.deferReply();
    try {
      const current = await getCurrentRevision();
      const revisions = await listRevisions(5);
      const list = revisions.map((r) => {
        const date = new Date(r.createTime).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
        const tag = r.image.split(':').pop()?.slice(0, 12) || '?';
        const active = r.name === current ? ' ← **active**' : '';
        return `\`${r.name}\` — ${date} (${tag})${active}`;
      }).join('\n');

      await interaction.editReply(
        `📦 **Cloud Run Revisions**\n\n${list}\n\n` +
        `Use \`/rollback <revision-name>\` to switch to a previous version.`
      );
    } catch (err) {
      await interaction.editReply(`❌ Failed to list revisions: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
    return;
  }

  await interaction.deferReply();
  try {
    const result = await rollbackToRevision(revision);
    await interaction.editReply(result);
  } catch (err) {
    await interaction.editReply(`❌ Rollback failed: ${err instanceof Error ? err.message : 'Unknown'}`);
  }
}
