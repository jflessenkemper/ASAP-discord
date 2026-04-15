import {
  STATUS_COLORS,
  JOB_COLORS,
  SYSTEM_COLORS,
  BUTTON_IDS,
  jobScoreColor,
  statusColor,
} from '../../../discord/ui/constants';

describe('constants exports', () => {
  it('STATUS_COLORS has ok/warn/error', () => {
    expect(STATUS_COLORS.ok).toBe(0x57F287);
    expect(STATUS_COLORS.warn).toBe(0xFEE75C);
    expect(STATUS_COLORS.error).toBe(0xED4245);
  });

  it('JOB_COLORS has high/med/low', () => {
    expect(JOB_COLORS.high).toBe(0x00CC44);
    expect(JOB_COLORS.med).toBe(0xFFAA00);
    expect(JOB_COLORS.low).toBe(0xCC4400);
  });

  it('SYSTEM_COLORS has all keys', () => {
    expect(SYSTEM_COLORS).toHaveProperty('default');
    expect(SYSTEM_COLORS).toHaveProperty('decision');
    expect(SYSTEM_COLORS).toHaveProperty('success');
    expect(SYSTEM_COLORS).toHaveProperty('draft');
    expect(SYSTEM_COLORS).toHaveProperty('info');
  });

  it('BUTTON_IDS has all prefix keys', () => {
    expect(BUTTON_IDS.DECISION_PREFIX).toBe('decision_');
    expect(BUTTON_IDS.JOB_APPROVE_PREFIX).toBe('job_approve_');
    expect(BUTTON_IDS.JOB_REJECT_PREFIX).toBe('job_reject_');
    expect(BUTTON_IDS.JOB_VIEW_PREFIX).toBe('job_view_');
    expect(BUTTON_IDS.DRAFT_APPROVE_PREFIX).toBe('draft_approve_');
    expect(BUTTON_IDS.DRAFT_REJECT_PREFIX).toBe('draft_reject_');
    expect(BUTTON_IDS.PAGE_NEXT_PREFIX).toBe('page_next_');
    expect(BUTTON_IDS.PAGE_PREV_PREFIX).toBe('page_prev_');
  });
});

describe('jobScoreColor', () => {
  it('returns high color for score >= 4', () => {
    expect(jobScoreColor(4)).toBe(JOB_COLORS.high);
    expect(jobScoreColor(5)).toBe(JOB_COLORS.high);
  });

  it('returns med color for score >= 3 and < 4', () => {
    expect(jobScoreColor(3)).toBe(JOB_COLORS.med);
    expect(jobScoreColor(3.5)).toBe(JOB_COLORS.med);
  });

  it('returns low color for score < 3', () => {
    expect(jobScoreColor(2)).toBe(JOB_COLORS.low);
    expect(jobScoreColor(0)).toBe(JOB_COLORS.low);
    expect(jobScoreColor(1)).toBe(JOB_COLORS.low);
  });

  it('returns low color for null/undefined', () => {
    expect(jobScoreColor(null)).toBe(JOB_COLORS.low);
    expect(jobScoreColor(undefined)).toBe(JOB_COLORS.low);
  });
});

describe('statusColor', () => {
  it('returns error color for ratio >= 0.9', () => {
    expect(statusColor(0.9)).toBe(STATUS_COLORS.error);
    expect(statusColor(1.0)).toBe(STATUS_COLORS.error);
  });

  it('returns warn color for ratio >= 0.7 and < 0.9', () => {
    expect(statusColor(0.7)).toBe(STATUS_COLORS.warn);
    expect(statusColor(0.85)).toBe(STATUS_COLORS.warn);
  });

  it('returns ok color for ratio < 0.7', () => {
    expect(statusColor(0.0)).toBe(STATUS_COLORS.ok);
    expect(statusColor(0.5)).toBe(STATUS_COLORS.ok);
    expect(statusColor(0.69)).toBe(STATUS_COLORS.ok);
  });
});
