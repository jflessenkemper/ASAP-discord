import {
  Guild,
  ChannelType,
  TextChannel,
  VoiceChannel,
  CategoryChannel,
} from 'discord.js';
import { getAgents } from './agents';

const CATEGORY_NAME = 'ASAP Agents';
const GROUPCHAT_NAME = 'groupchat';
const GITHUB_NAME = 'github';
const CALL_LOG_NAME = 'call-log';
const LIMITS_NAME = 'limits';
const VOICE_CHANNEL_NAME = 'command';

export interface BotChannels {
  category: CategoryChannel;
  agentChannels: Map<string, TextChannel>;
  groupchat: TextChannel;
  github: TextChannel;
  callLog: TextChannel;
  limits: TextChannel;
  voiceChannel: VoiceChannel;
}

/**
 * Set up all required channels in the guild.
 * Creates them if they don't exist, finds them if they do.
 */
export async function setupChannels(guild: Guild): Promise<BotChannels> {
  const agents = getAgents();

  // Find or create category
  let category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME
  ) as CategoryChannel | undefined;

  if (!category) {
    category = await guild.channels.create({
      name: CATEGORY_NAME,
      type: ChannelType.GuildCategory,
    });
  }

  const agentChannels = new Map<string, TextChannel>();

  // Create agent text channels (sub-agents work here)
  for (const [agentId, agent] of agents) {
    const channelName = agent.channelName;
    let channel = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        c.name === channelName &&
        c.parentId === category!.id
    ) as TextChannel | undefined;

    if (!channel) {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category,
        topic: `${agent.emoji} ${agent.name} — work log and notes`,
      });

      await channel.send(
        `${agent.emoji} **${agent.name}** work log.\nThis channel shows what ${agent.name.split(' ')[0]} is working on.`
      );
    }

    agentChannels.set(agentId, channel);
  }

  // Create groupchat — main interaction channel
  let groupchat = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.name === GROUPCHAT_NAME &&
      c.parentId === category.id
  ) as TextChannel | undefined;

  if (!groupchat) {
    groupchat = await guild.channels.create({
      name: GROUPCHAT_NAME,
      type: ChannelType.GuildText,
      parent: category,
      topic: '💬 Talk to Riley. She coordinates everything. Use /goal, /call, /status, /agents',
    });

    await groupchat.send(
      `**ASAP Command Center**\n\n` +
        `📋 **Riley (Executive Assistant)** is your point of contact.\n` +
        `💻 **Ace (Developer)** implements what Riley plans.\n\n` +
        `**Slash Commands:**\n` +
        `\`/goal <description>\` — Give Riley a goal to plan and execute\n` +
        `\`/call\` — Start a voice call with Riley and Ace\n` +
        `\`/leave\` — End the voice call\n` +
        `\`/status\` — Show current progress\n` +
        `\`/agents\` — List all available agents\n` +
        `\`/ask <agent> <question>\` — Ask a specific agent directly\n` +
        `\`/clear\` — Reset conversation context\n\n` +
        `Or just type naturally — Riley handles everything. You can @mention agents directly too.`
    );
  }

  // Create github channel — repo activity feed
  let github = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.name === GITHUB_NAME &&
      c.parentId === category.id
  ) as TextChannel | undefined;

  if (!github) {
    github = await guild.channels.create({
      name: GITHUB_NAME,
      type: ChannelType.GuildText,
      parent: category,
      topic: '📦 Live GitHub activity feed — commits, PRs, issues, releases',
    });

    await github.send(
      `📦 **GitHub Activity Feed**\n\n` +
        `This channel shows real-time updates from the ASAP repository.\n` +
        `Commits, pull requests, issues, releases, and more.`
    );
  }

  // Create call log
  let callLog = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.name === CALL_LOG_NAME &&
      c.parentId === category.id
  ) as TextChannel | undefined;

  if (!callLog) {
    callLog = await guild.channels.create({
      name: CALL_LOG_NAME,
      type: ChannelType.GuildText,
      parent: category,
      topic: '📋 Automatic transcripts and summaries of voice calls',
    });
  }

  // Create limits channel — usage dashboard
  let limits = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.name === LIMITS_NAME &&
      c.parentId === category.id
  ) as TextChannel | undefined;

  if (!limits) {
    limits = await guild.channels.create({
      name: LIMITS_NAME,
      type: ChannelType.GuildText,
      parent: category,
      topic: '📊 API usage limits, costs, and remaining credits — updated every 5 minutes',
    });
  }

  // Create voice channel
  let voiceChannel = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildVoice &&
      c.name === VOICE_CHANNEL_NAME &&
      c.parentId === category.id
  ) as VoiceChannel | undefined;

  if (!voiceChannel) {
    voiceChannel = await guild.channels.create({
      name: VOICE_CHANNEL_NAME,
      type: ChannelType.GuildVoice,
      parent: category,
    });
  }

  return { category, agentChannels, groupchat, github, callLog, limits, voiceChannel };
}
