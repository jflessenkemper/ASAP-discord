/**
 * Tests for src/discord/upgradeApproval.ts
 * Blocker parsing + upgrade-card recognition (no network calls).
 */

import { isUpgradeApprovalCard, parseBlockerMessage, UPGRADE_CARD_MARKER } from '../../discord/upgradeApproval';

describe('upgradeApproval', () => {
  describe('parseBlockerMessage', () => {
    it('parses a full blocker with all optional fields', () => {
      const raw = [
        '[BLOCKER] **from:** qa',
        '**issue:** cannot run mobile harness — missing android emulator.',
        '**suggested fix:** add a tool that wraps adb-install.',
        '**impact:** cannot verify mobile PRs end-to-end.',
      ].join('\n');
      const parsed = parseBlockerMessage(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.fromAgent).toBe('qa');
      expect(parsed!.issue).toContain('cannot run mobile harness');
      expect(parsed!.suggestedFix).toContain('adb-install');
      expect(parsed!.impact).toContain('mobile PRs');
    });

    it('parses a blocker with only the required issue', () => {
      const raw = '[BLOCKER] **from:** security-auditor\n**issue:** no access to secret manager.';
      const parsed = parseBlockerMessage(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.fromAgent).toBe('security-auditor');
      expect(parsed!.suggestedFix).toBeNull();
      expect(parsed!.impact).toBeNull();
    });

    it('returns null for unrelated content', () => {
      expect(parseBlockerMessage('just a regular message')).toBeNull();
      expect(parseBlockerMessage('')).toBeNull();
    });

    it('returns null when the BLOCKER tag is present but issue is missing', () => {
      expect(parseBlockerMessage('[BLOCKER] **from:** qa')).toBeNull();
    });
  });

  describe('isUpgradeApprovalCard', () => {
    it('matches Cortana-authored cards by prefix', () => {
      expect(isUpgradeApprovalCard(`${UPGRADE_CARD_MARKER} <@123> — qa is blocked.`)).toBe(true);
    });

    it('does not match raw blocker posts', () => {
      expect(isUpgradeApprovalCard('[BLOCKER] **from:** qa')).toBe(false);
    });

    it('does not match empty or unrelated strings', () => {
      expect(isUpgradeApprovalCard('')).toBe(false);
      expect(isUpgradeApprovalCard('hello world')).toBe(false);
    });
  });
});
