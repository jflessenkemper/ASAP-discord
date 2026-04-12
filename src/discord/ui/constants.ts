/**
 * Centralized UI constants for Discord embeds, buttons, and messages.
 * All hex colors, emoji shorthand, and system identifiers live here.
 */

// ── Status colors (traffic-light pattern) ────────────────────────────
export const STATUS_COLORS = {
  ok:    0x57F287,  // green
  warn:  0xFEE75C,  // yellow
  error: 0xED4245,  // red
} as const;

// ── Job scoring colors ───────────────────────────────────────────────
export const JOB_COLORS = {
  high: 0x00CC44,  // score >= 4
  med:  0xFFAA00,  // score >= 3
  low:  0xCC4400,  // score < 3
} as const;

export function jobScoreColor(score: number | null | undefined): number {
  const s = score ?? 0;
  if (s >= 4) return JOB_COLORS.high;
  if (s >= 3) return JOB_COLORS.med;
  return JOB_COLORS.low;
}

// ── System / feature colors ──────────────────────────────────────────
export const SYSTEM_COLORS = {
  default:   0x3498DB,  // blue — general embeds
  decision:  0x3A8DFF,  // brighter blue — decisions
  success:   0x2ECC71,  // green — success operations
  draft:     0x3498DB,  // blue — draft embeds
  info:      0x5865F2,  // blurple — informational
} as const;

export function statusColor(ratio: number): number {
  if (ratio >= 0.9) return STATUS_COLORS.error;
  if (ratio >= 0.7) return STATUS_COLORS.warn;
  return STATUS_COLORS.ok;
}

// ── Custom IDs for persistent button interactions ────────────────────
export const BUTTON_IDS = {
  // Decision buttons: `decision_<index>_<messageId>`
  DECISION_PREFIX: 'decision_',
  // Job card buttons: `job_approve_<listingId>`, `job_reject_<listingId>`
  JOB_APPROVE_PREFIX: 'job_approve_',
  JOB_REJECT_PREFIX:  'job_reject_',
  JOB_VIEW_PREFIX:    'job_view_',
  // Draft approval: `draft_approve_<listingId>`, `draft_reject_<listingId>`
  DRAFT_APPROVE_PREFIX: 'draft_approve_',
  DRAFT_REJECT_PREFIX:  'draft_reject_',
  // Pagination: `page_next_<context>`, `page_prev_<context>`
  PAGE_NEXT_PREFIX: 'page_next_',
  PAGE_PREV_PREFIX: 'page_prev_',
} as const;
