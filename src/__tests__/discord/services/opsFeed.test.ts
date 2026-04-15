/**
 * Tests for src/discord/services/opsFeed.ts
 * Ops feed formatting and posting.
 */

jest.mock('../../../db/pool', () => ({
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), on: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../discord/activityLog', () => ({
  logAgentEvent: jest.fn(),
}));

import { formatOpsLine, formatToolAuditHuman } from '../../../discord/services/opsFeed';

describe('opsFeed', () => {
  describe('formatOpsLine()', () => {
    it('formats a basic info line', () => {
      const line = formatOpsLine({
        actor: 'riley',
        scope: 'cost:request',
        metric: 'gemini-2.5-flash',
        delta: 'in=1000 out=500',
        action: 'none',
        severity: 'info',
      });
      expect(line).toContain('🟢');
      expect(line).toContain('severity=info');
      expect(line).toContain('agent=riley');
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
        actor: 'riley',
        scope: 'tool-audit',
        metric: 'list_files',
        delta: '',
        action: 'none',
      });
      expect(line).toContain('`list_files`');
    });

    it('capitalizes actor name', () => {
      const line = formatToolAuditHuman({
        actor: 'kane',
        scope: 'tool-audit',
        metric: 'scan_code',
        delta: 'none',
        action: 'none',
        severity: 'warn',
      });
      expect(line).toContain('**Kane**');
      expect(line).toContain('🟡');
    });
  });
});
