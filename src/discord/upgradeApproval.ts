/**
 * Upgrade-approval flow.
 *
 * Wraps a specialist-submitted blocker (posted by `report_blocker`) into a
 * Cortana-authored approval card in #🆙-upgrades, with ✅/❌ reactions
 * pre-seeded for Jordan to click. No LLM in the middle — the card is a
 * structured rewrite of the raw blocker.
 *
 * Reactions are handled in bot.ts (messageReactionAdd); see
 * handleUpgradeApprovalReaction below for the approve/reject dispatcher.
 */

import { Message, TextChannel } from 'discord.js';

import { getAgent, type AgentId } from './agents';
import { sendWebhookMessage, WebhookCapableChannel } from './services/webhooks';
import { errMsg } from '../utils/errors';

/** Marker prefix on Cortana-authored approval cards, so the reaction handler can spot them. */
export const UPGRADE_CARD_MARKER = '[UPGRADE CARD]';

interface ParsedBlocker {
  fromAgent: string | null;
  issue: string;
  suggestedFix: string | null;
  impact: string | null;
}

/**
 * Parse the structured `[BLOCKER]` message posted by `report_blocker`.
 * Returns null if the message isn't one of ours.
 */
export function parseBlockerMessage(content: string): ParsedBlocker | null {
  if (!content.includes('[BLOCKER]')) return null;
  const match = (re: RegExp): string | null => {
    const m = content.match(re);
    return m ? m[1].trim() : null;
  };
  const fromAgent = match(/\*\*from:\*\*\s*([^\n]+)/);
  const issue = match(/\*\*issue:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/);
  const suggestedFix = match(/\*\*suggested fix:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/);
  const impact = match(/\*\*impact:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/);
  if (!issue) return null;
  return { fromAgent, issue, suggestedFix, impact };
}

/**
 * Draft + post Cortana's approval card wrapping the specialist's blocker.
 * Seeds ✅/❌ reactions so Jordan can approve or dismiss with one click.
 *
 * Returns the posted Message (so tests / reaction handlers can reference it).
 */
export async function postUpgradeApprovalCard(
  upgradesChannel: TextChannel,
  blocker: ParsedBlocker,
): Promise<Message | null> {
  const cortana = getAgent('executive-assistant' as AgentId);
  if (!cortana) return null;

  const primaryUserId = (process.env.DISCORD_PRIMARY_USER_ID || '').trim();
  const mention = primaryUserId ? `<@${primaryUserId}> ` : '';
  const fromAgentLine = blocker.fromAgent ? `**${blocker.fromAgent}** is blocked` : 'A specialist is blocked';

  const lines: string[] = [
    `${UPGRADE_CARD_MARKER} ${mention}— ${fromAgentLine}.`,
    '',
    `**Issue:** ${blocker.issue}`,
  ];
  if (blocker.suggestedFix) lines.push(`**Proposed fix:** ${blocker.suggestedFix}`);
  if (blocker.impact) lines.push(`**Impact if skipped:** ${blocker.impact}`);
  lines.push('');
  lines.push('React ✅ to approve — I\'ll implement it. React ❌ to dismiss.');

  const body = lines.join('\n');

  let posted: Message | null = null;
  try {
    posted = await sendWebhookMessage(upgradesChannel as unknown as WebhookCapableChannel, {
      content: body,
      username: `${cortana.emoji} ${cortana.name}`,
      avatarURL: cortana.avatarUrl,
    });
  } catch (err) {
    console.warn('[upgradeApproval] webhook send failed:', errMsg(err));
    try {
      posted = await upgradesChannel.send(body);
    } catch (innerErr) {
      console.warn('[upgradeApproval] fallback send failed:', errMsg(innerErr));
      return null;
    }
  }

  if (posted) {
    try {
      await posted.react('✅');
      await posted.react('❌');
    } catch (err) {
      console.warn('[upgradeApproval] seed reactions failed:', errMsg(err));
    }
  }
  return posted;
}

/**
 * Return true if the given message is a Cortana-authored upgrade approval
 * card (so the reaction handler knows to act on ✅/❌).
 */
export function isUpgradeApprovalCard(content: string): boolean {
  return typeof content === 'string' && content.startsWith(UPGRADE_CARD_MARKER);
}
