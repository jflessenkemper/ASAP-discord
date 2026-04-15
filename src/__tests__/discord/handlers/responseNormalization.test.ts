/**
 * Tests for src/discord/handlers/responseNormalization.ts
 * Low-signal completion detection — regex and helper function.
 */

import {
  LOW_SIGNAL_COMPLETION_RE,
  isLowSignalCompletion,
} from '../../../discord/handlers/responseNormalization';

describe('responseNormalization', () => {
  describe('LOW_SIGNAL_COMPLETION_RE', () => {
    it.each([
      'Done', 'done', 'Done.', 'DONE',
      'Fixed', 'fixed', 'Fixed.',
      'Resolved', 'resolved', 'Resolved.',
      'Completed', 'completed', 'Completed.',
      'All good', 'all good', 'All good.',
      'Finished', 'finished', 'Finished.',
      '  done  ', ' Fixed. ',
    ])('matches low-signal phrase: "%s"', (phrase) => {
      expect(LOW_SIGNAL_COMPLETION_RE.test(phrase)).toBe(true);
    });

    it.each([
      'Done with the migration',
      'I fixed the bug in auth.ts',
      'Resolved the merge conflict and updated tests',
      'Not done yet',
      '',
      'Here is the completed output',
    ])('does not match non-low-signal text: "%s"', (phrase) => {
      expect(LOW_SIGNAL_COMPLETION_RE.test(phrase)).toBe(false);
    });
  });

  describe('isLowSignalCompletion()', () => {
    it('returns true for low-signal completions', () => {
      expect(isLowSignalCompletion('Done.')).toBe(true);
      expect(isLowSignalCompletion('fixed')).toBe(true);
      expect(isLowSignalCompletion('All good')).toBe(true);
      expect(isLowSignalCompletion('  Finished.  ')).toBe(true);
    });

    it('returns false for substantive responses', () => {
      expect(isLowSignalCompletion('I fixed the login bug by updating the JWT validation')).toBe(false);
      expect(isLowSignalCompletion('')).toBe(false);
      expect(isLowSignalCompletion('The task is completed and deployed')).toBe(false);
    });
  });
});
