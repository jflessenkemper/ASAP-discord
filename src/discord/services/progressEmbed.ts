/**
 * Reusable progress-bar embed for long-running tasks (migrations, deploys,
 * smoke runs, bulk operations).
 *
 * Posts one message with an embed and edits it in place as `update()` is
 * called. The embed renders a Unicode progress bar + current step text,
 * colored by severity.
 *
 * Usage:
 *   const p = await beginProgress(channel, 'Deploying to Cloud Run', 6);
 *   await p.update(1, 'Building image…');
 *   await p.update(3, 'Pushing to Artifact Registry…');
 *   await p.done('Deploy complete — revision asap-00145');
 */

import { EmbedBuilder, Message, TextChannel } from 'discord.js';

import { SYSTEM_COLORS, STATUS_COLORS } from '../ui/constants';
import { errMsg } from '../../utils/errors';

const BAR_WIDTH = 20;
const BAR_FILLED = '█';
const BAR_EMPTY = '░';

export interface ProgressHandle {
  update(step: number, label: string): Promise<void>;
  done(label?: string): Promise<void>;
  fail(label: string): Promise<void>;
  readonly message: Message | null;
}

function renderBar(step: number, total: number): string {
  const clamped = Math.max(0, Math.min(total, step));
  const pct = total > 0 ? clamped / total : 0;
  const filled = Math.round(pct * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const percent = Math.round(pct * 100);
  return `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(empty)}  ${percent}%  (${clamped}/${total})`;
}

export async function beginProgress(
  channel: TextChannel,
  title: string,
  total: number,
  initialLabel = 'Starting…',
): Promise<ProgressHandle> {
  const safeTotal = Math.max(1, total);
  let currentStep = 0;
  let currentLabel = initialLabel;
  let message: Message | null = null;
  let finalized = false;

  const buildEmbed = (color: number, extraFooter?: string): EmbedBuilder =>
    new EmbedBuilder()
      .setTitle(title)
      .setColor(color)
      .setDescription(`\`${renderBar(currentStep, safeTotal)}\`\n\n${currentLabel}`)
      .setFooter(extraFooter ? { text: extraFooter } : null);

  try {
    message = await channel.send({ embeds: [buildEmbed(SYSTEM_COLORS.info)] });
  } catch (err) {
    console.warn('[progressEmbed] begin failed:', errMsg(err));
  }

  return {
    get message() { return message; },
    async update(step: number, label: string): Promise<void> {
      if (finalized || !message) return;
      currentStep = step;
      currentLabel = label.slice(0, 900);
      try {
        await message.edit({ embeds: [buildEmbed(SYSTEM_COLORS.info)] });
      } catch (err) {
        console.warn('[progressEmbed] update failed:', errMsg(err));
      }
    },
    async done(label?: string): Promise<void> {
      if (finalized || !message) { finalized = true; return; }
      finalized = true;
      currentStep = safeTotal;
      if (label) currentLabel = label.slice(0, 900);
      try {
        await message.edit({ embeds: [buildEmbed(STATUS_COLORS.ok, 'Complete')] });
      } catch (err) {
        console.warn('[progressEmbed] done edit failed:', errMsg(err));
      }
    },
    async fail(label: string): Promise<void> {
      if (finalized || !message) { finalized = true; return; }
      finalized = true;
      currentLabel = label.slice(0, 900);
      try {
        await message.edit({ embeds: [buildEmbed(STATUS_COLORS.error, 'Failed')] });
      } catch (err) {
        console.warn('[progressEmbed] fail edit failed:', errMsg(err));
      }
    },
  };
}
