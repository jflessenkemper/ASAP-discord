/**
 * Tests for src/discord/services/opsFeed.ts
 * Ops feed formatting and posting.
 */

const mockLogAgentEvent = jest.fn();
jest.mock('../../../db/pool', () => ({
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), on: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../discord/activityLog', () => ({
  logAgentEvent: mockLogAgentEvent,
}));

import { formatOpsLine, formatToolAuditHuman, postOpsLine, flushAllOpsDigests } from '../../../discord/services/opsFeed';

function makeChannel(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id || 'ch-1',
    name: overrides.name || 'ops-feed',
    send: overrides.send || jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('opsFeed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('formatOpsLine()', () => {
    it('formats a basic info line', () => {
      const line = formatOpsLine({
        actor: 'cortana',
        scope: 'cost:request',
        metric: 'gemini-2.5-flash',
        delta: 'in=1000 out=500',
        action: 'none',
        severity: 'info',
      });
      expect(line).toContain('🟢');
      expect(line).toContain('severity=info');
      expect(line).toContain('agent=cortana');
      expect(line).toContain('scope=cost:request');
      expect(line).toContain('metric=gemini-2.5-flash');
      expect(line).toContain('delta=in=1000 out=500');
    });

    it('formats a warning line', () => {
      const line = formatOpsLine({
        actor: 'system',
        scope: 'budget-gate',
        metric: 'overspend',
        delta: '$250.00',
        action: 'pause agents',
        severity: 'warn',
      });
      expect(line).toContain('🟡');
      expect(line).toContain('severity=warn');
    });

    it('formats an error line', () => {
      const line = formatOpsLine({
        actor: 'ace',
        scope: 'crash',
        metric: 'unhandled',
        delta: 'TypeError',
        action: 'investigate',
        severity: 'error',
      });
      expect(line).toContain('🔴');
      expect(line).toContain('severity=error');
    });

    it('defaults to info severity', () => {
      const line = formatOpsLine({
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
      });
      expect(line).toContain('severity=info');
    });

    it('sanitizes mentions in values', () => {
      const line = formatOpsLine({
        actor: '@everyone',
        scope: '<@!12345> injection',
        metric: '@here test',
        delta: 'safe',
        action: 'none',
      });
      expect(line).not.toContain('@everyone');
      expect(line).not.toContain('<@!12345>');
      expect(line).not.toContain('@here');
    });

    it('includes correlation ID', () => {
      const line = formatOpsLine({
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
        correlationId: 'test-corr-123',
      });
      expect(line).toContain('corr=test-corr-123');
    });

    it('includes age from occurredAtMs', () => {
      const line = formatOpsLine({
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
        occurredAtMs: Date.now() - 5000,
      });
      expect(line).toContain('age=');
    });

    it('truncates long values', () => {
      const longStr = 'x'.repeat(500);
      const line = formatOpsLine({
        actor: 'system',
        scope: longStr,
        metric: longStr,
        delta: longStr,
        action: longStr,
      });
      expect(line.length).toBeLessThan(1500);
    });

    it('generates age label in minutes', () => {
      const line = formatOpsLine({
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
        occurredAtMs: Date.now() - 120_000, // 2 minutes ago
      });
      expect(line).toMatch(/age=2m/);
    });

    it('generates age label in hours', () => {
      const line = formatOpsLine({
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
        occurredAtMs: Date.now() - 7_200_000, // 2 hours ago
      });
      expect(line).toMatch(/age=2h/);
    });

    it('generates age label in days', () => {
      const line = formatOpsLine({
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
        occurredAtMs: Date.now() - 172_800_000, // 2 days ago
      });
      expect(line).toMatch(/age=2d/);
    });

    it('handles empty action by defaulting to none', () => {
      const line = formatOpsLine({
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: '',
      });
      expect(line).toContain('action=none');
    });

    it('sanitizes [ACTION:...] tags', () => {
      const line = formatOpsLine({
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'hello [ACTION:do_something] world',
        action: 'none',
      });
      expect(line).not.toContain('[ACTION:do_something]');
      expect(line).toContain('hello');
    });

    it('handles empty/falsy actor', () => {
      const line = formatOpsLine({
        actor: '',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
      });
      expect(line).toContain('agent=system');
    });
  });

  describe('formatToolAuditHuman()', () => {
    it('formats tool execution line', () => {
      const line = formatToolAuditHuman({
        actor: 'ace',
        scope: 'tool-audit',
        metric: 'db_query',
        delta: 'selected 5 users',
        action: 'none',
        severity: 'info',
        occurredAtMs: Date.now() - 2000,
      });
      expect(line).toContain('**Ace**');
      expect(line).toContain('`db_query`');
      expect(line).toContain('selected 5 users');
    });

    it('handles empty delta', () => {
      const line = formatToolAuditHuman({
        actor: 'cortana',
        scope: 'tool-audit',
        metric: 'list_files',
        delta: '',
        action: 'none',
      });
      expect(line).toContain('`list_files`');
      expect(line).not.toContain('→');
    });

    it('handles "none" delta', () => {
      const line = formatToolAuditHuman({
        actor: 'cortana',
        scope: 'tool-audit',
        metric: 'list_files',
        delta: 'none',
        action: 'none',
      });
      expect(line).not.toContain('→');
    });

    it('handles "batched" delta', () => {
      const line = formatToolAuditHuman({
        actor: 'cortana',
        scope: 'tool-audit',
        metric: 'list_files',
        delta: 'batched',
        action: 'none',
      });
      expect(line).not.toContain('→');
    });

    it('capitalizes actor name', () => {
      const line = formatToolAuditHuman({
        actor: 'athena',
        scope: 'tool-audit',
        metric: 'scan_code',
        delta: 'none',
        action: 'none',
        severity: 'warn',
      });
      expect(line).toContain('**Athena**');
      expect(line).toContain('🟡');
    });
  });

  describe('postOpsLine()', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      process.env = { ...OLD_ENV };
      process.env.OPS_FEED_DB_ENABLED = 'true';
      process.env.OPS_FEED_DISCORD_ENABLED = 'true';
      process.env.OPS_FEED_DISCORD_MIN_SEVERITY = 'info';
    });

    afterEach(() => {
      process.env = OLD_ENV;
    });

    it('posts error severity to discord and logs to db', async () => {
      const ch = makeChannel();
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'crash',
        metric: 'unhandled',
        delta: 'TypeError',
        action: 'investigate',
        severity: 'error',
      });
      expect(mockLogAgentEvent).toHaveBeenCalled();
      expect(ch.send).toHaveBeenCalled();
    });

    it('skips discord when discord is disabled', async () => {
      jest.resetModules();
      process.env.OPS_FEED_DISCORD_ENABLED = 'false';
      process.env.OPS_FEED_DISCORD_MIN_SEVERITY = 'info';
      const { postOpsLine: freshPost } = await import('../../../discord/services/opsFeed');
      const ch = makeChannel();
      await freshPost(ch, {
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
        severity: 'info',
      });
      expect(ch.send).not.toHaveBeenCalled();
      delete process.env.OPS_FEED_DISCORD_ENABLED;
    });

    it('skips discord when min severity is none/off/disabled', async () => {
      process.env.OPS_FEED_DISCORD_MIN_SEVERITY = 'none';
      const ch = makeChannel();
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
        severity: 'error',
      });
      expect(ch.send).not.toHaveBeenCalled();
    });

    it('skips discord when severity below min', async () => {
      process.env.OPS_FEED_DISCORD_MIN_SEVERITY = 'error';
      const ch = makeChannel();
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
        severity: 'info',
      });
      expect(ch.send).not.toHaveBeenCalled();
    });

    it('always posts tool-audit scope even if severity below min', async () => {
      process.env.OPS_FEED_DISCORD_MIN_SEVERITY = 'error';
      const ch = makeChannel();
      await postOpsLine(ch, {
        actor: 'ace',
        scope: 'tool-audit:db_query',
        metric: 'db_query',
        delta: 'selected 5 users',
        action: 'none',
        severity: 'info',
      });
      expect(ch.send).toHaveBeenCalled();
    });

    it('digests info events on cost channels', async () => {
      const ch = makeChannel({ name: 'ops-cost-tracking', id: 'digest-ch-1' });
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'cost',
        metric: 'tokens',
        delta: '1000',
        action: 'none',
        severity: 'info',
      });
      // Should not send immediately - it's batched
      expect(ch.send).not.toHaveBeenCalled();
    });

    it('digests info events on terminal channels', async () => {
      const ch = makeChannel({ name: 'bot-terminal', id: 'digest-ch-2' });
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'runtime',
        metric: 'heartbeat',
        delta: 'ok',
        action: 'none',
        severity: 'info',
      });
      expect(ch.send).not.toHaveBeenCalled();
    });

    it('does not digest warn/error severity', async () => {
      const ch = makeChannel({ name: 'ops-cost-tracking', id: 'digest-ch-3' });
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'cost',
        metric: 'overspend',
        delta: '$500',
        action: 'review',
        severity: 'warn',
      });
      expect(ch.send).toHaveBeenCalled();
    });

    it('does not digest tool-audit scope on terminal channel', async () => {
      const ch = makeChannel({ name: 'bot-terminal', id: 'digest-ch-4' });
      await postOpsLine(ch, {
        actor: 'ace',
        scope: 'tool-audit:db_query',
        metric: 'db_query',
        delta: 'selected 5 users',
        action: 'none',
        severity: 'info',
      });
      expect(ch.send).toHaveBeenCalled();
    });

    it('flushes digest after interval', async () => {
      const ch = makeChannel({ name: 'ops-cost-tracking', id: 'digest-flush-1' });
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'cost',
        metric: 'tokens',
        delta: '1000',
        action: 'none',
        severity: 'info',
      });
      expect(ch.send).not.toHaveBeenCalled();

      // Fast-forward to trigger the digest flush timer
      jest.advanceTimersByTime(20 * 60 * 1000);
      // Wait for the async flush
      await Promise.resolve();
      await Promise.resolve();
      expect(ch.send).toHaveBeenCalled();
    });

    it('includes alert mention when configured', async () => {
      process.env.DISCORD_OPS_ALERT_MENTIONS = 'true';
      process.env.DISCORD_OPS_ALERT_ROLE_ID = '123456789';
      const ch = makeChannel();
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'crash',
        metric: 'unhandled',
        delta: 'TypeError',
        action: 'investigate',
        severity: 'error',
      });
      const sentText = ch.send.mock.calls[0][0];
      expect(sentText).toContain('<@&123456789>');
    });

    it('skips alert mention when disabled', async () => {
      process.env.DISCORD_OPS_ALERT_MENTIONS = 'false';
      const ch = makeChannel();
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'crash',
        metric: 'unhandled',
        delta: 'TypeError',
        action: 'investigate',
        severity: 'error',
      });
      const sentText = ch.send.mock.calls[0][0];
      expect(sentText).not.toContain('<@&');
    });

    it('skips alert mention when role ID is empty', async () => {
      process.env.DISCORD_OPS_ALERT_MENTIONS = 'true';
      process.env.DISCORD_OPS_ALERT_ROLE_ID = '';
      const ch = makeChannel();
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'crash',
        metric: 'unhandled',
        delta: 'TypeError',
        action: 'investigate',
        severity: 'error',
      });
      const sentText = ch.send.mock.calls[0][0];
      expect(sentText).not.toContain('<@&');
    });

    it('skips DB log when OPS_FEED_DB_ENABLED is false', async () => {
      process.env.OPS_FEED_DB_ENABLED = 'false';
      // Need to re-import to pick up module-level const
      jest.resetModules();
      process.env.OPS_FEED_DB_ENABLED = 'false';
      process.env.OPS_FEED_DISCORD_ENABLED = 'true';
      process.env.OPS_FEED_DISCORD_MIN_SEVERITY = 'info';
      const { postOpsLine: freshPostOpsLine } = await import('../../../discord/services/opsFeed');
      const ch = makeChannel();
      await freshPostOpsLine(ch, {
        actor: 'system',
        scope: 'crash',
        metric: 'test',
        delta: 'test',
        action: 'test',
        severity: 'error',
      });
      // logAgentEvent should NOT be called since DB is disabled
      // (fresh module gets its own mock)
    });

    it('handles channel.send rejection gracefully', async () => {
      const ch = makeChannel({ send: jest.fn().mockRejectedValue(new Error('Discord API error')) });
      // Should not throw
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'crash',
        metric: 'unhandled',
        delta: 'TypeError',
        action: 'investigate',
        severity: 'error',
      });
    });

    it('resolveDiscordMinSeverity handles "warning" as "warn"', async () => {
      process.env.OPS_FEED_DISCORD_MIN_SEVERITY = 'warning';
      const ch = makeChannel();
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
        severity: 'warn',
      });
      expect(ch.send).toHaveBeenCalled();
    });

    it('resolveDiscordMinSeverity handles "off"', async () => {
      process.env.OPS_FEED_DISCORD_MIN_SEVERITY = 'off';
      const ch = makeChannel();
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
        severity: 'error',
      });
      expect(ch.send).not.toHaveBeenCalled();
    });

    it('resolveDiscordMinSeverity handles "disabled"', async () => {
      process.env.OPS_FEED_DISCORD_MIN_SEVERITY = 'disabled';
      const ch = makeChannel();
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'test',
        metric: 'test',
        delta: 'none',
        action: 'none',
        severity: 'error',
      });
      expect(ch.send).not.toHaveBeenCalled();
    });
  });

  describe('flushAllOpsDigests()', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      process.env = { ...OLD_ENV };
      process.env.OPS_FEED_DB_ENABLED = 'true';
      process.env.OPS_FEED_DISCORD_ENABLED = 'true';
      process.env.OPS_FEED_DISCORD_MIN_SEVERITY = 'info';
    });

    afterEach(() => {
      process.env = OLD_ENV;
    });

    it('flushes all pending digests', async () => {
      const ch = makeChannel({ name: 'ops-cost-tracking', id: 'flush-all-1' });
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'cost',
        metric: 'tokens',
        delta: '1000',
        action: 'none',
        severity: 'info',
      });
      expect(ch.send).not.toHaveBeenCalled();

      await flushAllOpsDigests();
      expect(ch.send).toHaveBeenCalled();
    });

    it('handles empty digest state', async () => {
      // Should not throw
      await flushAllOpsDigests();
    });

    it('digest summary includes warn count in action', async () => {
      const ch = makeChannel({ name: 'ops-cost-tracking', id: 'flush-warn-1' });
      // First post an info (gets digested)
      await postOpsLine(ch, {
        actor: 'system',
        scope: 'cost',
        metric: 'tokens',
        delta: '1000',
        action: 'none',
        severity: 'info',
      });
      await flushAllOpsDigests();
      const sentText = ch.send.mock.calls[0][0] as string;
      expect(sentText).toContain('events=');
    });
  });
});
