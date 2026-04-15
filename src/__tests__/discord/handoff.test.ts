/**
 * Tests for src/discord/handoff.ts
 * Agent handoff protocol — pure functions, no external dependencies.
 */

import {
  buildHandoffContext,
  formatHandoffPrompt,
  buildHandoffResult,
  formatHandoffResult,
  canRunInParallel,
} from '../../discord/handoff';

describe('handoff', () => {
  describe('buildHandoffContext()', () => {
    it('builds minimal context', () => {
      const ctx = buildHandoffContext({
        fromAgent: 'riley',
        toAgent: 'ace',
        traceId: 'abc123',
        task: 'Fix the login bug',
      });
      expect(ctx.fromAgent).toBe('riley');
      expect(ctx.toAgent).toBe('ace');
      expect(ctx.traceId).toBe('abc123');
      expect(ctx.task).toBe('Fix the login bug');
      expect(ctx.priority).toBe('normal');
      expect(ctx.relevantContext).toEqual([]);
      expect(ctx.constraints).toEqual([]);
      expect(ctx.timestamp).toBeGreaterThan(0);
    });

    it('includes conversation summary in context', () => {
      const ctx = buildHandoffContext({
        fromAgent: 'riley',
        toAgent: 'ace',
        traceId: 'abc',
        task: 'task',
        conversationSummary: 'User reported a crash on iOS',
      });
      expect(ctx.relevantContext).toContain('User reported a crash on iOS');
    });

    it('includes files modified in context', () => {
      const ctx = buildHandoffContext({
        fromAgent: 'riley',
        toAgent: 'ace',
        traceId: 'abc',
        task: 'task',
        filesModified: ['src/app.ts', 'src/index.ts'],
      });
      expect(ctx.relevantContext).toEqual(
        expect.arrayContaining([expect.stringContaining('src/app.ts')])
      );
    });

    it('includes tools used in context', () => {
      const ctx = buildHandoffContext({
        fromAgent: 'riley',
        toAgent: 'ace',
        traceId: 'abc',
        task: 'task',
        toolsUsed: ['read_file', 'write_file'],
      });
      expect(ctx.relevantContext).toEqual(
        expect.arrayContaining([expect.stringContaining('read_file')])
      );
    });

    it('applies custom priority', () => {
      const ctx = buildHandoffContext({
        fromAgent: 'riley',
        toAgent: 'ace',
        traceId: 'abc',
        task: 'task',
        priority: 'high',
      });
      expect(ctx.priority).toBe('high');
    });

    it('passes constraints and expectedOutput', () => {
      const ctx = buildHandoffContext({
        fromAgent: 'riley',
        toAgent: 'ace',
        traceId: 'abc',
        task: 'task',
        constraints: ['No breaking changes', 'TypeScript only'],
        expectedOutput: 'A PR with the fix',
      });
      expect(ctx.constraints).toEqual(['No breaking changes', 'TypeScript only']);
      expect(ctx.expectedOutput).toBe('A PR with the fix');
    });
  });

  describe('formatHandoffPrompt()', () => {
    it('formats minimal handoff', () => {
      const ctx = buildHandoffContext({
        fromAgent: 'riley',
        toAgent: 'ace',
        traceId: 'tr123',
        task: 'Fix login',
      });
      const prompt = formatHandoffPrompt(ctx);
      expect(prompt).toContain('[Handoff from riley]');
      expect(prompt).toContain('Task: Fix login');
      expect(prompt).toContain('Trace: tr123');
    });

    it('includes priority when not normal', () => {
      const ctx = buildHandoffContext({
        fromAgent: 'riley',
        toAgent: 'ace',
        traceId: 'tr',
        task: 'Urgent fix',
        priority: 'high',
      });
      expect(formatHandoffPrompt(ctx)).toContain('Priority: high');
    });

    it('omits priority when normal', () => {
      const ctx = buildHandoffContext({
        fromAgent: 'riley',
        toAgent: 'ace',
        traceId: 'tr',
        task: 'task',
      });
      expect(formatHandoffPrompt(ctx)).not.toContain('Priority:');
    });

    it('includes parent goal', () => {
      const ctx = buildHandoffContext({
        fromAgent: 'riley',
        toAgent: 'ace',
        traceId: 'tr',
        task: 'task',
        parentGoal: 'Ship v2.0',
      });
      expect(formatHandoffPrompt(ctx)).toContain('Parent goal: Ship v2.0');
    });

    it('includes constraints list', () => {
      const ctx = buildHandoffContext({
        fromAgent: 'riley',
        toAgent: 'ace',
        traceId: 'tr',
        task: 'task',
        constraints: ['No breaking changes'],
      });
      const prompt = formatHandoffPrompt(ctx);
      expect(prompt).toContain('Constraints:');
      expect(prompt).toContain('No breaking changes');
    });
  });

  describe('buildHandoffResult()', () => {
    it('builds result with defaults', () => {
      const result = buildHandoffResult({
        agentId: 'ace',
        status: 'completed',
        summary: 'Fixed the bug',
        durationMs: 5000,
      });
      expect(result.agentId).toBe('ace');
      expect(result.status).toBe('completed');
      expect(result.summary).toBe('Fixed the bug');
      expect(result.filesModified).toEqual([]);
      expect(result.toolsUsed).toEqual([]);
      expect(result.durationMs).toBe(5000);
    });

    it('includes files and tools', () => {
      const result = buildHandoffResult({
        agentId: 'ace',
        status: 'completed',
        summary: 'Done',
        filesModified: ['app.ts'],
        toolsUsed: ['write_file'],
        nextSteps: ['Run tests'],
        durationMs: 1000,
      });
      expect(result.filesModified).toEqual(['app.ts']);
      expect(result.toolsUsed).toEqual(['write_file']);
      expect(result.nextSteps).toEqual(['Run tests']);
    });
  });

  describe('formatHandoffResult()', () => {
    it('formats completed result', () => {
      const result = buildHandoffResult({
        agentId: 'ace',
        status: 'completed',
        summary: 'Bug fixed in auth module',
        durationMs: 3000,
      });
      const text = formatHandoffResult(result);
      expect(text).toContain('[Result from ace]');
      expect(text).toContain('completed');
      expect(text).toContain('Bug fixed in auth module');
    });

    it('includes files and next steps', () => {
      const result = buildHandoffResult({
        agentId: 'ace',
        status: 'partial',
        summary: 'Partial fix',
        filesModified: ['auth.ts'],
        nextSteps: ['Review edge cases', 'Run integration tests'],
        durationMs: 2000,
      });
      const text = formatHandoffResult(result);
      expect(text).toContain('Files touched: auth.ts');
      expect(text).toContain('Next steps: Review edge cases; Run integration tests');
    });
  });

  describe('canRunInParallel()', () => {
    it('returns true for empty array', () => {
      expect(canRunInParallel([])).toBe(true);
    });

    it('returns true for single handoff', () => {
      const ctx = buildHandoffContext({
        fromAgent: 'riley',
        toAgent: 'ace',
        traceId: 'tr',
        task: 'task',
        filesModified: ['a.ts'],
      });
      expect(canRunInParallel([ctx])).toBe(true);
    });

    it('returns true when no file overlap', () => {
      const a = buildHandoffContext({
        fromAgent: 'riley', toAgent: 'ace', traceId: 'tr', task: 'task',
        filesModified: ['a.ts'],
      });
      const b = buildHandoffContext({
        fromAgent: 'riley', toAgent: 'max', traceId: 'tr', task: 'task',
        filesModified: ['b.ts'],
      });
      expect(canRunInParallel([a, b])).toBe(true);
    });

    it('returns false when files overlap', () => {
      const a = buildHandoffContext({
        fromAgent: 'riley', toAgent: 'ace', traceId: 'tr', task: 'task',
        filesModified: ['shared.ts'],
      });
      const b = buildHandoffContext({
        fromAgent: 'riley', toAgent: 'max', traceId: 'tr', task: 'task',
        filesModified: ['shared.ts'],
      });
      expect(canRunInParallel([a, b])).toBe(false);
    });

    it('returns true when filesModified is undefined', () => {
      const a = buildHandoffContext({
        fromAgent: 'riley', toAgent: 'ace', traceId: 'tr', task: 'task',
      });
      const b = buildHandoffContext({
        fromAgent: 'riley', toAgent: 'max', traceId: 'tr', task: 'task',
      });
      expect(canRunInParallel([a, b])).toBe(true);
    });
  });
});
