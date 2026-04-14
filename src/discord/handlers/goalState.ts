const GOAL_STALL_TIMEOUT_MS = parseInt(process.env.GOAL_STALL_TIMEOUT_MS || '420000', 10);
const GOAL_STALL_MAX_RECOVERY_ATTEMPTS = parseInt(process.env.GOAL_STALL_MAX_RECOVERY_ATTEMPTS || '5', 10);
export const GOAL_THREAD_COUNTER_RE = /\bgoal[-\s]?(\d{4})\b/i;

function extractGoalSequence(name: string): number {
  const match = GOAL_THREAD_COUNTER_RE.exec(name);
  if (!match) return 0;
  const parsed = parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class GoalStateManager {
  goal: string | null = null;
  status: string | null = null;
  startedAt = Date.now();
  lastProgressAt = Date.now();
  recoveryAttempts = 0;
  threadId: string | null = null;
  sequence = 0;
  sequenceInitialized = false;

  markProgress(status?: string): void {
    this.lastProgressAt = Date.now();
    this.recoveryAttempts = 0;
    if (status) this.status = status;
  }

  setGoal(goal: string): void {
    this.goal = goal;
    this.startedAt = Date.now();
    this.markProgress('⏳ Riley planning...');
  }

  clear(): void {
    this.threadId = null;
    this.goal = null;
    this.status = '✅ Completed';
    this.startedAt = Date.now();
  }

  isActive(): boolean {
    return this.goal !== null;
  }

  isStalled(): boolean {
    if (!this.goal) return false;
    if (Date.now() - this.lastProgressAt < GOAL_STALL_TIMEOUT_MS) return false;
    if (this.recoveryAttempts >= GOAL_STALL_MAX_RECOVERY_ATTEMPTS) return false;
    return true;
  }

  recordRecoveryAttempt(): void {
    this.recoveryAttempts += 1;
    this.status = `⚠️ Auto-recovery nudge ${this.recoveryAttempts}/${GOAL_STALL_MAX_RECOVERY_ATTEMPTS}`;
    this.lastProgressAt = Date.now();
  }

  getSummary(): string | null {
    if (!this.goal) return null;
    return `📋 **Current Goal:** ${this.goal}\n**Status:** ${this.status || 'In progress...'}`;
  }

  getCompactGoalLine(goalMaxLen = 72, statusMaxLen = 48): string | null {
    if (!this.goal) return null;
    return `goal=${this.goal.replace(/\s+/g, ' ').slice(0, goalMaxLen)} status=${(this.status || 'in-progress').replace(/\s+/g, ' ').slice(0, statusMaxLen)}`;
  }

  nextThreadSequence(): number {
    this.sequence = (this.sequence + 1) % 10000;
    return this.sequence;
  }

  async syncSequence(threads: Iterable<{ name?: string }>[]): Promise<void> {
    if (this.sequenceInitialized) return;
    let maxSeen = this.sequence;
    for (const group of threads) {
      for (const thread of group) {
        const seq = extractGoalSequence(thread?.name || '');
        if (seq > maxSeen) maxSeen = seq;
      }
    }
    this.sequence = maxSeen;
    this.sequenceInitialized = true;
  }
}

export const goalState = new GoalStateManager();
