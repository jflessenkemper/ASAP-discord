/**
 * Job-search tool handlers — extracted from tools.ts to keep that file
 * from unbounded growth. These wrap the domain services in `jobSearch.ts`
 * and format results for Cortana + specialist consumption.
 *
 * Called only from the central tool dispatcher in tools.ts.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  TextChannel,
} from 'discord.js';

import {
  draftApplication,
  getListingById,
  getListingsByStatus,
  getProfile,
  getTrackerSummary,
  scanAdzuna,
  scanPortals,
  seedDefaultPortals,
  setListingDiscordMsg,
  submitToGreenhouse,
  updateListingScore,
  updateListingStatus,
  upsertProfile,
} from '../../services/jobSearch';
import { requireGuild } from '../guildRegistry';
import { BUTTON_IDS, SYSTEM_COLORS, jobScoreColor } from '../ui/constants';

type ToolInput = Record<string, any>;

export async function toolJobScan(keywords?: string, source?: string): Promise<string> {
  const src = (source || 'all').toLowerCase();
  const parts: string[] = [];

  if (src === 'adzuna' || src === 'all') {
    const adzResult = await scanAdzuna(keywords);
    parts.push(`**Adzuna**: ${adzResult.listings.length} new listings (${adzResult.skipped} skipped, ${adzResult.total} total on API)`);
    for (const l of adzResult.listings.slice(0, 15)) {
      const salary = l.salary_min ? ` | $${Math.round(l.salary_min / 1000)}k–$${Math.round((l.salary_max || l.salary_min) / 1000)}k` : '';
      parts.push(`  • **${l.title}** @ ${l.company} — ${l.location || 'Unknown'}${salary}`);
    }
    if (adzResult.listings.length > 15) parts.push(`  … and ${adzResult.listings.length - 15} more`);
  }

  if (src === 'portals' || src === 'all') {
    const portalResult = await scanPortals();
    parts.push(`**Portals**: ${portalResult.listings.length} new listings`);
    for (const l of portalResult.listings.slice(0, 15)) {
      parts.push(`  • **${l.title}** @ ${l.company} — ${l.location || 'Unknown'}`);
    }
    if (portalResult.listings.length > 15) parts.push(`  … and ${portalResult.listings.length - 15} more`);
    if (portalResult.errors.length > 0) {
      parts.push(`Portal errors: ${portalResult.errors.join('; ')}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : 'No new listings found.';
}

export async function toolJobEvaluate(listingId: number): Promise<string> {
  const listings = await getListingsByStatus('scanned', 500);
  const listing = listings.find((l) => l.id === listingId);
  if (!listing) {
    const evaluated = await getListingsByStatus('evaluated', 500);
    const found = evaluated.find((l) => l.id === listingId);
    if (found) return `Listing #${listingId} already evaluated: score=${found.score}, evaluation: ${found.evaluation}`;
    return `Listing #${listingId} not found in scanned listings.`;
  }

  const profile = await getProfile();
  const profileSummary = profile
    ? `Target roles: ${(profile.target_roles || []).join(', ')} | Location: ${profile.location || 'NSW'} | Salary: $${profile.salary_min || '?'}–$${profile.salary_max || '?'} | Deal-breakers: ${profile.deal_breakers || 'none'}`
    : 'No profile configured — ask the user to set one up first.';

  return [
    `**Listing #${listing.id}**: ${listing.title}`,
    `Company: ${listing.company}`,
    `Location: ${listing.location || 'Unknown'}`,
    listing.salary_min ? `Salary: $${Math.round(listing.salary_min / 1000)}k–$${Math.round((listing.salary_max || listing.salary_min) / 1000)}k` : 'Salary: Not specified',
    `URL: ${listing.url}`,
    listing.description ? `Description: ${listing.description.slice(0, 800)}` : '',
    `Source: ${listing.source}`,
    '',
    `**Your profile**: ${profileSummary}`,
    '',
    'Score this listing 1-5 on: role match, skills alignment, compensation fit, location fit.',
    'Then call job_tracker with action="update" and the listing_id to save your evaluation.',
  ].filter(Boolean).join('\n');
}

export async function toolJobTracker(action?: string, status?: string, listingId?: number): Promise<string> {
  const act = (action || 'summary').toLowerCase();

  if (act === 'summary') {
    const summary = await getTrackerSummary();
    if (Object.keys(summary).length === 0) return 'No job listings in the tracker yet. Run job_scan first.';
    const lines = Object.entries(summary).map(([s, c]) => `  ${s}: ${c}`);
    return `**Job Tracker Summary**\n${lines.join('\n')}\nTotal: ${Object.values(summary).reduce((a, b) => a + b, 0)}`;
  }

  if (act === 'list') {
    const filterStatus = status || 'scanned';
    const listings = await getListingsByStatus(filterStatus, 25);
    if (listings.length === 0) return `No listings with status "${filterStatus}".`;
    const lines = listings.map((l) => {
      const score = l.score != null ? ` | score=${l.score}` : '';
      return `  #${l.id}: **${l.title}** @ ${l.company}${score}`;
    });
    return `**Listings (${filterStatus})** — ${listings.length} results\n${lines.join('\n')}`;
  }

  if (act === 'update') {
    if (!listingId || !status) return 'Provide listing_id and status for update action.';
    await updateListingStatus(listingId, status);
    return `Updated listing #${listingId} → ${status}`;
  }

  if (act === 'score') {
    if (!listingId) return 'Provide listing_id for scoring.';
    const score = parseFloat(status || '3');
    await updateListingScore(listingId, score, '');
    return `Scored listing #${listingId} = ${score}`;
  }

  return `Unknown tracker action: ${act}. Use "summary", "list", "update", or "score".`;
}

export async function toolJobProfileUpdate(input: ToolInput): Promise<string> {
  const fields: Record<string, any> = {};

  if (input.cv_text) fields.cv_text = input.cv_text;
  if (input.target_roles) fields.target_roles = input.target_roles.split(',').map((s: string) => s.trim());
  if (input.keywords_pos) fields.keywords_pos = input.keywords_pos.split(',').map((s: string) => s.trim());
  if (input.keywords_neg) fields.keywords_neg = input.keywords_neg.split(',').map((s: string) => s.trim());
  if (input.salary_min) fields.salary_min = parseInt(input.salary_min, 10);
  if (input.salary_max) fields.salary_max = parseInt(input.salary_max, 10);
  if (input.location) fields.location = input.location;
  if (input.remote_ok) fields.remote_ok = input.remote_ok === 'true';
  if (input.deal_breakers) fields.deal_breakers = input.deal_breakers;
  if (input.preferences) fields.preferences = input.preferences;
  if (input.first_name) fields.first_name = input.first_name;
  if (input.last_name) fields.last_name = input.last_name;
  if (input.email) fields.email = input.email;
  if (input.phone) fields.phone = input.phone;

  if (Object.keys(fields).length === 0) {
    const profile = await getProfile();
    if (!profile) return 'No profile exists yet. Provide at least target_roles to create one.';
    return [
      '**Current Profile**',
      `Name: ${profile.first_name || '?'} ${profile.last_name || '?'}`,
      `Email: ${profile.email || 'Not set'}`,
      `Phone: ${profile.phone || 'Not set'}`,
      `Target roles: ${(profile.target_roles || []).join(', ')}`,
      `Location: ${profile.location || 'Not set'}`,
      `Salary: $${profile.salary_min || '?'}–$${profile.salary_max || '?'}`,
      `Remote OK: ${profile.remote_ok ?? 'Not set'}`,
      `Positive keywords: ${(profile.keywords_pos || []).join(', ') || 'None'}`,
      `Negative keywords: ${(profile.keywords_neg || []).join(', ') || 'None'}`,
      profile.deal_breakers ? `Deal-breakers: ${profile.deal_breakers}` : '',
      profile.preferences ? `Preferences: ${profile.preferences}` : '',
      profile.cv_text ? `CV: (${profile.cv_text.length} chars stored)` : 'CV: Not uploaded',
    ].filter(Boolean).join('\n');
  }

  await upsertProfile(fields);

  const existing = await getProfile();
  if (existing) {
    const seeded = await seedDefaultPortals();
    if (seeded > 0) {
      return `Profile updated. Also seeded ${seeded} default AU company portals for scanning.`;
    }
  }

  return `Profile updated: ${Object.keys(fields).join(', ')}`;
}

export async function toolJobPostApprovals(minScore: number, limit: number): Promise<string> {
  const guild = requireGuild();
  await guild.channels.fetch();
  const channel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === '📋-job-applications'
  ) as TextChannel | undefined;

  if (!channel) return 'Error: #📋-job-applications channel not found. Run setup first.';

  const evaluated = await getListingsByStatus('evaluated', 200);
  const eligible = evaluated.filter((l) => (l.score || 0) >= minScore).slice(0, limit);

  if (eligible.length === 0) return 'No evaluated listings meet the minimum score threshold. Run job_evaluate on scanned listings first.';

  const PAGE_SIZE = 10;
  const page = eligible.slice(0, PAGE_SIZE);
  const hasMore = eligible.length > PAGE_SIZE;

  let posted = 0;
  for (const listing of page) {
    const salary = listing.salary_min
      ? `💰 $${Math.round(listing.salary_min / 1000)}k–$${Math.round((listing.salary_max || listing.salary_min) / 1000)}k`
      : '💰 Not specified';

    const embed = new EmbedBuilder()
      .setTitle(listing.title)
      .setDescription([
        `**Company:** ${listing.company}`,
        `**Location:** ${listing.location || 'Unknown'}`,
        salary,
        `**Score:** ${'⭐'.repeat(Math.round(listing.score || 0))} (${listing.score}/5)`,
        listing.evaluation ? `**Evaluation:** ${listing.evaluation.slice(0, 300)}` : '',
        `**Source:** ${listing.source}`,
        `[View listing](${listing.url})`,
      ].filter(Boolean).join('\n'))
      .setColor(jobScoreColor(listing.score))
      .setFooter({ text: `Listing #${listing.id} · ${posted + 1}/${eligible.length}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_IDS.JOB_APPROVE_PREFIX}${listing.id}`)
        .setLabel('Approve')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_IDS.JOB_REJECT_PREFIX}${listing.id}`)
        .setLabel('Reject')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('View Listing')
        .setEmoji('🔗')
        .setURL(listing.url),
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });
    await setListingDiscordMsg(listing.id!, msg.id);
    posted++;
  }

  const remaining = eligible.length - PAGE_SIZE;
  const moreNote = hasMore ? ` Showing first ${PAGE_SIZE} of ${eligible.length} — ${remaining} more available. Run again with a higher limit to see more.` : '';

  return `Posted ${posted} job approval cards to #📋-job-applications. Click Approve or Reject on each card.${moreNote}`;
}

export async function toolJobDraftApplication(listingId: number): Promise<string> {
  const listing = await getListingById(listingId);
  if (!listing) return `Listing #${listingId} not found.`;

  if (listing.cover_letter) {
    return [
      `Listing #${listingId} already has a draft:`,
      '',
      '**Cover Letter:**',
      listing.cover_letter.slice(0, 1500),
      listing.resume_text ? `\n**Resume Highlights:**\n${listing.resume_text.slice(0, 1000)}` : '',
      '',
      `Status: ${listing.status} | To re-draft, update the listing status back to "approved" and call again.`,
    ].filter(Boolean).join('\n');
  }

  const draft = await draftApplication(listingId);
  if (!draft) return `Failed to draft application — check that a profile exists and GEMINI_API_KEY is set.`;

  const guild = requireGuild();
  await guild.channels.fetch();
  const channel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === '💼-career-ops'
  ) as TextChannel | undefined;

  if (channel) {
    const salary = listing.salary_min
      ? `💰 $${Math.round(listing.salary_min / 1000)}k–$${Math.round((listing.salary_max || listing.salary_min) / 1000)}k`
      : '💰 Not specified';

    await channel.send({ embeds: [new EmbedBuilder()
      .setTitle(`📝 Application Draft: ${listing.title}`)
      .setDescription([
        `**Company:** ${listing.company}`,
        `**Location:** ${listing.location || 'Unknown'}`,
        salary,
        `[View listing](${listing.url})`,
        '',
        '**Cover Letter:**',
        draft.coverLetter.slice(0, 3800),
      ].join('\n'))
      .setColor(SYSTEM_COLORS.draft)
      .setFooter({ text: `Listing #${listing.id}` }),
    ]});

    if (draft.resumeHighlights) {
      await channel.send({ embeds: [new EmbedBuilder()
        .setTitle(`📋 Resume Highlights: ${listing.title}`)
        .setDescription(draft.resumeHighlights.slice(0, 3800))
        .setColor(SYSTEM_COLORS.success)
        .setFooter({ text: `Listing #${listing.id} | Tailored for ${listing.company}` }),
      ]});
    }
  }

  return [
    `✅ Drafted application for **${listing.title}** @ ${listing.company}`,
    '',
    '**Cover Letter:**',
    draft.coverLetter.slice(0, 1500),
    draft.resumeHighlights ? `\n**Resume Highlights:**\n${draft.resumeHighlights.slice(0, 1000)}` : '',
    '',
    `Status updated to "drafted". Apply here: ${listing.url}`,
  ].filter(Boolean).join('\n');
}

export async function toolJobSubmitApplication(listingId: number): Promise<string> {
  const listing = await getListingById(listingId);
  if (!listing) return `Listing #${listingId} not found.`;

  if (!listing.cover_letter) return `Listing #${listingId} has no draft. Run job_draft_application first.`;

  if (listing.source !== 'greenhouse') {
    return `Listing #${listingId} is from ${listing.source} — auto-submit is only supported for Greenhouse listings. Apply manually: ${listing.url}`;
  }

  const profile = await getProfile();
  if (!profile) return 'No profile found. Set one up with job_profile_update first.';
  if (!profile.email) return 'Profile has no email. Update profile with email before submitting.';

  const result = await submitToGreenhouse(listing, profile, listing.cover_letter, listing.resume_text || '');
  if (result.success) {
    await updateListingStatus(listingId, 'applied');
    return `🚀 Successfully submitted application to **${listing.company}** for **${listing.title}** via Greenhouse!`;
  }

  return `❌ Greenhouse submission failed: ${result.error}\nApply manually: ${listing.url}`;
}
