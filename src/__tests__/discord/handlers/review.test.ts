/* ── mocks ─────────────────────────────────────────────── */

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../../services/github', () => ({
  addPRComment: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../discord/agents', () => ({
  getAgent: jest.fn(),
}));

jest.mock('../../../discord/claude', () => ({
  agentRespond: jest.fn().mockResolvedValue('review response'),
}));

jest.mock('../../../discord/memory', () => ({
  getMemoryContext: jest.fn().mockReturnValue('memory'),
  appendToMemory: jest.fn(),
}));

jest.mock('../../../discord/handlers/documentation', () => ({
  documentToChannel: jest.fn().mockResolvedValue(undefined),
}));

import { getRequiredReviewers } from '../../../discord/handlers/review';

describe('getRequiredReviewers', () => {
  it('returns empty map when no files match', () => {
    expect(getRequiredReviewers(['README.md', 'package.json'])).toEqual(new Map());
  });

  it('detects auth files → security-auditor + lawyer', () => {
    const result = getRequiredReviewers(['src/middleware/auth.ts']);
    expect(result.has('security-auditor')).toBe(true);
    expect(result.has('lawyer')).toBe(true);
  });

  it('detects password/jwt → security-auditor only', () => {
    const result = getRequiredReviewers(['lib/jwt-verify.ts']);
    expect(result.has('security-auditor')).toBe(true);
    expect(result.has('lawyer')).toBe(false);
  });

  it('detects migrations → lawyer + security-auditor', () => {
    const result = getRequiredReviewers(['src/db/migrations/001.sql']);
    expect(result.has('security-auditor')).toBe(true);
    expect(result.has('lawyer')).toBe(true);
  });

  it('detects privacy-related keywords → lawyer', () => {
    const result = getRequiredReviewers(['docs/privacy-policy.md']);
    expect(result.has('lawyer')).toBe(true);
  });

  it('detects payment keywords → lawyer + security-auditor', () => {
    const result = getRequiredReviewers(['src/billing.ts']);
    expect(result.has('lawyer')).toBe(true);
    expect(result.has('security-auditor')).toBe(true);
  });

  it('detects env/secret/credential files → security-auditor', () => {
    const result = getRequiredReviewers(['.env.production']);
    expect(result.has('security-auditor')).toBe(true);
  });

  it('detects Dockerfile → security-auditor', () => {
    const result = getRequiredReviewers(['Dockerfile']);
    expect(result.has('security-auditor')).toBe(true);
  });

  it('aggregates multiple reasons per agent', () => {
    const result = getRequiredReviewers([
      'src/middleware/auth.ts',
      'src/routes/auth/login.ts',
      'src/db/migrations/002.sql',
    ]);
    const secReasons = result.get('security-auditor')!;
    expect(secReasons.length).toBeGreaterThanOrEqual(2);
  });

  it('deduplicates identical reasons', () => {
    // same file twice should not duplicate the reason
    const result = getRequiredReviewers(['src/middleware/auth.ts', 'src/middleware/auth.ts']);
    const secReasons = result.get('security-auditor')!;
    const unique = new Set(secReasons);
    expect(secReasons.length).toBe(unique.size);
  });
});
