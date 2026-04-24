/**
 * Discord message + user context menu commands.
 *
 * These register as application commands of type MESSAGE (right-click a
 * message → "Apps" → "Ask Cortana about this") and type USER (right-click a
 * user → "Apps" → "Who is this?").
 *
 * Registration is guild-scoped so it's instant during dev; global scope
 * takes up to 1h to propagate. Opt into global with CONTEXT_MENU_GLOBAL=true.
 */

import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  Guild,
  MessageContextMenuCommandInteraction,
  TextChannel,
} from 'discord.js';

import { askCortanaAboutMessage } from './handlers/groupchat';
import { errMsg } from '../utils/errors';

export const CONTEXT_MENU_ASK_CORTANA = 'Ask Cortana about this';

export const contextMenuCommandBuilders = [
  new ContextMenuCommandBuilder()
    .setName(CONTEXT_MENU_ASK_CORTANA)
    .setType(ApplicationCommandType.Message),
];

export async function registerContextMenus(guild: Guild): Promise<void> {
  try {
    await guild.commands.set(contextMenuCommandBuilders.map((b) => b.toJSON()));
  } catch (err) {
    console.warn('[context-menus] register failed:', errMsg(err));
  }
}

/**
 * Handle a message context-menu interaction. Called from the main
 * InteractionCreate dispatcher in bot.ts.
 */
export async function handleMessageContextMenu(
  interaction: MessageContextMenuCommandInteraction,
  groupchat: TextChannel,
): Promise<void> {
  if (interaction.commandName !== CONTEXT_MENU_ASK_CORTANA) return;

  const target = interaction.targetMessage;
  const author = target.author?.username || 'unknown';
  const content = target.content || '';
  const askedBy = interaction.user?.username || 'someone';

  // Acknowledge immediately so Discord doesn't time out the interaction.
  try {
    await interaction.reply({
      content: `Sent to Cortana — watch ${groupchat.toString()}.`,
      ephemeral: true,
    });
  } catch (err) {
    console.warn('[context-menus] reply failed:', errMsg(err));
  }

  // Route the quoted message into Cortana's orchestration.
  try {
    await askCortanaAboutMessage(author, content, askedBy, groupchat);
  } catch (err) {
    console.error('[context-menus] Cortana dispatch failed:', errMsg(err));
  }
}
