import { Client, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { errMsg } from '../utils/errors';

export async function registerCommands(client: Client, guildId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(client.token!);
  const ops = new SlashCommandBuilder()
    .setName('ops')
    .setDescription('Show operational snapshots')
    .addSubcommand((sub) =>
      sub
        .setName('now')
        .setDescription('Combined ops snapshot (cost, live billing, thread status)')
    )
    .addSubcommand((sub) =>
      sub
        .setName('costs')
        .setDescription('Cost and budget snapshot')
    )
    .addSubcommand((sub) =>
      sub
        .setName('threads')
        .setDescription('Thread status snapshot')
    )
    .addSubcommand((sub) =>
      sub
        .setName('deploy-checklist')
        .setDescription('Riley pre/post deploy checklist for reliable releases')
        .addStringOption((opt) =>
          opt
            .setName('phase')
            .setDescription('Checklist phase')
            .setRequired(false)
            .addChoices(
              { name: 'pre', value: 'pre' },
              { name: 'post', value: 'post' },
              { name: 'full', value: 'full' },
            )
        )
    );

  try {
    await rest.put(Routes.applicationGuildCommands(client.user!.id, guildId), {
      body: [ops.toJSON()],
    });
    console.log('Registered guild slash commands: /ops now|costs|threads|deploy-checklist');
  } catch (err) {
    console.error('Slash command registration error:', errMsg(err));
  }
}
