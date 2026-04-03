import { Client, REST, Routes, SlashCommandBuilder } from 'discord.js';

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
    );

  try {
    await rest.put(Routes.applicationGuildCommands(client.user!.id, guildId), {
      body: [ops.toJSON()],
    });
    console.log('Registered guild slash commands: /ops now|costs|threads');
  } catch (err) {
    console.error('Slash command registration error:', err instanceof Error ? err.message : 'Unknown');
  }
}
