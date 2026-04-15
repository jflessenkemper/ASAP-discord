import { GoalStateManager, GOAL_THREAD_COUNTER_RE } from '../../../discord/handlers/goalState';

describe('GOAL_THREAD_COUNTER_RE', () => {
  it.each([
    ['goal-0001', '0001'],
    ['Goal 0042', '0042'],
    ['goal0099', '0099'],
    ['GOAL-9999', '9999'],
    ['some goal-0005 thread', '0005'],
  ])('matches "%s" → group %s', (input, expected) => {
    const m = GOAL_THREAD_COUNTER_RE.exec(input);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(expected);
  });

  it.each(['no match', 'goal-', 'goal-abc', ''])('does not match "%s"', (input) => {
    // reset lastIndex for global-like usage
    GOAL_THREAD_COUNTER_RE.lastIndex = 0;
    expect(GOAL_THREAD_COUNTER_RE.test(input)).toBe(false);
  });
});

describe('GoalStateManager', () => {
  let gsm: GoalStateManager;

  beforeEach(() => {
    gsm = new GoalStateManager();
  });

  /* ── setGoal / isActive ──────────────────────────────── */

  it('starts inactive with no goal', () => {
    expect(gsm.isActive()).toBe(false);
    expect(gsm.goal).toBeNull();
  });

  it('setGoal activates the manager', () => {
    gsm.setGoal('Deploy staging');
    expect(gsm.isActive()).toBe(true);
    expect(gsm.goal).toBe('Deploy staging');
    expect(gsm.status).toBe('⏳ Riley planning...');
  });

  /* ── markProgress ────────────────────────────────────── */

  it('markProgress resets recoveryAttempts and updates status', () => {
    gsm.recoveryAttempts = 3;
    gsm.markProgress('✅ Done');
    expect(gsm.recoveryAttempts).toBe(0);
    expect(gsm.status).toBe('✅ Done');
  });

  it('markProgress without status leaves status unchanged', () => {
    gsm.status = 'old';
    gsm.markProgress();
    expect(gsm.status).toBe('old');
  });

  /* ── clear ───────────────────────────────────────────── */

  it('clear resets goal and sets completed status', () => {
    gsm.setGoal('task');
    gsm.threadId = '123';
    gsm.clear();
    expect(gsm.goal).toBeNull();
    expect(gsm.threadId).toBeNull();
    expect(gsm.status).toBe('✅ Completed');
    expect(gsm.isActive()).toBe(false);
  });

  /* ── isStalled ───────────────────────────────────────── */

  it('is not stalled when no goal is set', () => {
    expect(gsm.isStalled()).toBe(false);
  });

  it('is not stalled when progress is recent', () => {
    gsm.setGoal('work');
    expect(gsm.isStalled()).toBe(false);
  });

  it('is stalled when lastProgressAt is old and recovery budget remains', () => {
    gsm.setGoal('work');
    // force old timestamp
    gsm.lastProgressAt = Date.now() - 999_999;
    gsm.recoveryAttempts = 0;
    expect(gsm.isStalled()).toBe(true);
  });

  it('is not stalled when recovery budget exhausted', () => {
    gsm.setGoal('work');
    gsm.lastProgressAt = Date.now() - 999_999;
    gsm.recoveryAttempts = 5;     // default max
    expect(gsm.isStalled()).toBe(false);
  });

  /* ── recordRecoveryAttempt ───────────────────────────── */

  it('increments recovery count and updates status', () => {
    gsm.recordRecoveryAttempt();
    expect(gsm.recoveryAttempts).toBe(1);
    expect(gsm.status).toContain('Auto-recovery nudge 1/');
  });

  /* ── getSummary ──────────────────────────────────────── */

  it('returns null when no goal', () => {
    expect(gsm.getSummary()).toBeNull();
  });

  it('returns formatted summary with goal and status', () => {
    gsm.setGoal('Ship it');
    const summary = gsm.getSummary()!;
    expect(summary).toContain('Ship it');
    expect(summary).toContain('⏳ Riley planning...');
  });

  /* ── getCompactGoalLine ──────────────────────────────── */

  it('returns null when no goal', () => {
    expect(gsm.getCompactGoalLine()).toBeNull();
  });

  it('truncates long goal and status', () => {
    gsm.setGoal('x'.repeat(200));
    gsm.status = 'y'.repeat(200);
    const line = gsm.getCompactGoalLine(10, 5)!;
    expect(line).toContain('goal=' + 'x'.repeat(10));
    expect(line).toContain('status=' + 'y'.repeat(5));
  });

  it('collapses whitespace', () => {
    gsm.setGoal('a   b\nc');
    const line = gsm.getCompactGoalLine()!;
    expect(line).toContain('goal=a b c');
  });

  /* ── nextThreadSequence ──────────────────────────────── */

  it('increments and wraps at 10000', () => {
    gsm.sequence = 9999;
    expect(gsm.nextThreadSequence()).toBe(0);
    expect(gsm.nextThreadSequence()).toBe(1);
  });

  /* ── syncSequence ────────────────────────────────────── */

  it('sets sequence to max found across thread groups', async () => {
    const threads1 = [{ name: 'goal-0005' }, { name: 'goal-0010' }];
    const threads2 = [{ name: 'goal-0003' }];
    await gsm.syncSequence([threads1, threads2]);
    expect(gsm.sequence).toBe(10);
    expect(gsm.sequenceInitialized).toBe(true);
  });

  it('no-ops after first sync', async () => {
    await gsm.syncSequence([[{ name: 'goal-0005' }]]);
    await gsm.syncSequence([[{ name: 'goal-9999' }]]);
    expect(gsm.sequence).toBe(5);
  });

  it('handles threads with no name', async () => {
    await gsm.syncSequence([[{} as any, { name: undefined }]]);
    expect(gsm.sequence).toBe(0);
  });
});
