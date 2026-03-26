import { Client, REST, Routes } from 'discord.js';

/**
 * Unregister all slash commands — we use natural language through Riley now.
 * This runs once on startup to clean up old slash commands.
 */
export async function unregisterCommands(client: Client, guildId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(client.token!);

  try {
    await rest.put(Routes.applicationGuildCommands(client.user!.id, guildId), {
      body: [],
    });
    console.log('Unregistered all slash commands — natural language mode');
  } catch (err) {
    console.error('Slash command cleanup error:', err instanceof Error ? err.message : 'Unknown');
  }
}
