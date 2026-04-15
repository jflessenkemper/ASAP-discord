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

import { getRequiredReviewers, autoReviewPR } from '../../../discord/handlers/review';
import { getAgent } from '../../../discord/agents';
import { agentRespond } from '../../../discord/claude';
import { addPRComment } from '../../../services/github';
import { appendToMemory } from '../../../discord/memory';
import { documentToChannel } from '../../../discord/handlers/documentation';

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

describe('autoReviewPR', () => {
  const mockSend = jest.fn().mockResolvedValue(undefined);
  const mockGroupchat = { send: mockSend } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    (getAgent as jest.Mock).mockReturnValue({
      name: 'Harper Atkinson',
      emoji: '⚖️',
    });
    (agentRespond as jest.Mock).mockResolvedValue('✅ **APPROVED** — No issues found.');
  });

  it('does nothing when no reviewers match', async () => {
    await autoReviewPR(1, 'Update README', ['README.md'], 'minor changes', mockGroupchat);
    expect(agentRespond).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('calls agentRespond and posts review for matching files', async () => {
    await autoReviewPR(42, 'Fix auth bug', ['src/middleware/auth.ts'], 'diff content', mockGroupchat);
    expect(agentRespond).toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalled();
    expect(addPRComment).toHaveBeenCalledWith(42, expect.stringContaining('Harper'));
    expect(appendToMemory).toHaveBeenCalled();
    expect(documentToChannel).toHaveBeenCalled();
  });

  it('sends error message to groupchat when agentRespond throws', async () => {
    (agentRespond as jest.Mock).mockRejectedValue(new Error('API down'));
    await autoReviewPR(10, 'Auth change', ['src/middleware/auth.ts'], 'diff', mockGroupchat);
    expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('could not review'));
  });

  it('continues when addPRComment throws', async () => {
    (addPRComment as jest.Mock).mockRejectedValue(new Error('GitHub error'));
    await autoReviewPR(10, 'Auth fix', ['src/middleware/auth.ts'], 'diff', mockGroupchat);
    // Should still send to groupchat and append to memory
    expect(mockSend).toHaveBeenCalled();
    expect(appendToMemory).toHaveBeenCalled();
  });

  it('skips agents that are not found', async () => {
    (getAgent as jest.Mock).mockReturnValue(null);
    await autoReviewPR(5, 'Migration', ['src/db/migrations/001.sql'], 'diff', mockGroupchat);
    expect(agentRespond).not.toHaveBeenCalled();
  });

  it('handles multiple batches when more than MAX_PARALLEL_REVIEWS reviewers', async () => {
    // A file that triggers both lawyer and security-auditor
    (getAgent as jest.Mock).mockReturnValue({ name: 'Test Agent', emoji: '🔒' });
    await autoReviewPR(99, 'Big PR', ['src/middleware/auth.ts', 'src/db/migrations/002.sql'], 'big diff', mockGroupchat);
    // Both agents should be called
    expect(agentRespond).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('truncates long diff summaries in the prompt', async () => {
    const longDiff = 'x'.repeat(5000);
    await autoReviewPR(7, 'Big diff', ['src/middleware/auth.ts'], longDiff, mockGroupchat);
    // agentRespond was called — the prompt should have truncated diff
    const prompt = (agentRespond as jest.Mock).mock.calls[0][2];
    expect(prompt.length).toBeLessThan(5000);
  });

  it('truncates long response when sending to groupchat', async () => {
    (agentRespond as jest.Mock).mockResolvedValue('x'.repeat(3000));
    await autoReviewPR(8, 'PR', ['src/middleware/auth.ts'], 'diff', mockGroupchat);
    const sentMsg = mockSend.mock.calls[0][0];
    expect(sentMsg.length).toBeLessThanOrEqual(2000);
  });
});
