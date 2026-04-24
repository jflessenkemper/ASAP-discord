/**
 * `report_blocker` tool — specialists call this when they hit a capability
 * wall they can't work around (missing tool, missing access, unclear scope).
 *
 * The tool posts a structured line to #🆙-upgrades that Cortana's upgrade
 * watcher (bot.ts) picks up to draft an approval card for Jordan.
 *
 * Format stays machine-parseable so the watcher doesn't have to LLM-analyse
 * each post — the structured prefix gives it everything it needs.
 */

import { ChannelType, TextChannel } from 'discord.js';

import { getAgent, type AgentId } from '../agents';
import { sendWebhookMessage } from '../services/webhooks';
import { requireGuild } from '../guildRegistry';
import { parseBlockerMessage, postUpgradeApprovalCard } from '../upgradeApproval';
import { errMsg } from '../../utils/errors';

/** Structured prefix the watcher keys off. Do not change without updating bot.ts. */
export const BLOCKER_MARKER = '[BLOCKER]';

/**
 * Per-agent cooldown for report_blocker. Stops a specialist from spamming
 * approval cards inside a single turn — if they hit the same wall twice in
 * a row, the second call is suppressed. Test hook resets this between cases.
 */
const BLOCKER_COOLDOWN_MS = Math.max(0, parseInt(process.env.REPORT_BLOCKER_COOLDOWN_MS || '300000', 10));
const lastBlockerCallAt = new Map<string, number>();

export function resetBlockerCooldownsForTests(): void {
  lastBlockerCallAt.clear();
}

export interface ReportBlockerInput {
  issue: string;
  suggested_fix?: string;
  impact?: string;
}

/**
 * Called by the tool dispatcher for `report_blocker`. Posts a formatted
 * blocker entry to #🆙-upgrades as the calling agent via webhook.
 */
export async function runReportBlocker(
  agentId: string | undefined,
  input: ReportBlockerInput,
): Promise<string> {
  const issue = String(input.issue || '').trim();
  if (!issue) return 'Error: report_blocker requires `issue`.';

  const agent = agentId ? getAgent(agentId as AgentId) : null;
  if (!agent) return 'Error: report_blocker called without an agent context.';

  if (BLOCKER_COOLDOWN_MS > 0) {
    const prev = lastBlockerCallAt.get(agent.id) || 0;
    const elapsed = Date.now() - prev;
    if (elapsed < BLOCKER_COOLDOWN_MS) {
      const remainingSec = Math.ceil((BLOCKER_COOLDOWN_MS - elapsed) / 1000);
      return `report_blocker is on cooldown for ${agent.id} (${remainingSec}s remaining). Your prior blocker is still waiting for Jordan's approval — don't re-flag the same wall.`;
    }
    lastBlockerCallAt.set(agent.id, Date.now());
  }

  const guild = requireGuild();
  await guild.channels.fetch().catch(() => {});
  const upgrades = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && /upgrades/i.test(c.name),
  ) as TextChannel | undefined;
  if (!upgrades) return 'Error: #🆙-upgrades channel not found. Ask Cortana to run setup.';

  const lines: string[] = [
    `${BLOCKER_MARKER} **from:** ${agent.id}`,
    `**issue:** ${issue.slice(0, 800)}`,
  ];
  if (input.suggested_fix) lines.push(`**suggested fix:** ${String(input.suggested_fix).slice(0, 600)}`);
  if (input.impact) lines.push(`**impact:** ${String(input.impact).slice(0, 400)}`);

  const body = lines.join('\n');
  try {
    await sendWebhookMessage(upgrades, {
      content: body,
      username: `${agent.emoji} ${agent.name}`,
      avatarURL: agent.avatarUrl,
    });
  } catch (err) {
    console.warn('[report_blocker] webhook send failed:', errMsg(err));
    try {
      await upgrades.send(body);
    } catch (innerErr) {
      return `Error: failed to post blocker to #${upgrades.name}: ${errMsg(innerErr)}`;
    }
  }

  // Fire-and-forget: wrap the blocker in a Cortana approval card so Jordan
  // can ✅/❌ it. If parsing fails (shouldn't, but defensive) we skip — the
  // specialist's raw blocker post remains in the channel as fallback.
  void (async () => {
    const parsed = parseBlockerMessage(body);
    if (parsed) {
      await postUpgradeApprovalCard(upgrades, parsed).catch((err) => {
        console.warn('[report_blocker] approval card failed:', errMsg(err));
      });
    }
  })();

  return `Posted blocker to #${upgrades.name}. Cortana will draft an approval card shortly.`;
}
