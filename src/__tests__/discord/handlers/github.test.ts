import crypto from 'crypto';

import { verifySignature, setGitHubChannel, handleGitHubEvent } from '../../../discord/handlers/github';

/* ── mocks ─────────────────────────────────────────────────── */

jest.mock('../../../discord/services/opsFeed', () => ({
  formatOpsLine: jest.fn(({ scope, metric }) => `[${scope}] ${metric}`),
}));

jest.mock('../../../discord/services/screenshots', () => ({
  captureAndPostScreenshots: jest.fn().mockResolvedValue(undefined),
}));

/* ── verifySignature ───────────────────────────────────────── */

describe('verifySignature', () => {
  const SECRET = 'test-webhook-secret';

  beforeEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  it('returns true when no secret is configured (legacy mode)', () => {
    expect(verifySignature('some body', undefined)).toBe(true);
  });

  it('returns false when secret is configured but no signature provided', () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    expect(verifySignature('body', undefined)).toBe(false);
  });

  it('returns true for valid HMAC signature', () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const payload = '{"action":"push"}';
    const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    expect(verifySignature(payload, sig)).toBe(true);
  });

  it('returns false for invalid signature', () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    expect(verifySignature('body', 'sha256=0000000000')).toBe(false);
  });

  it('returns false when signature length differs', () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    expect(verifySignature('body', 'sha256=short')).toBe(false);
  });
});

/* ── handleGitHubEvent ─────────────────────────────────────── */

describe('handleGitHubEvent', () => {
  const mockSend = jest.fn().mockResolvedValue(undefined);
  const fakeChannel = { send: mockSend } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    setGitHubChannel(fakeChannel);
  });

  it('posts push events to channel', async () => {
    await handleGitHubEvent('push', {
      ref: 'refs/heads/main',
      commits: [{ id: 'abc1234567', message: 'fix: thing' }],
      pusher: { name: 'dev' },
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('ignores push with no commits', async () => {
    await handleGitHubEvent('push', { ref: 'refs/heads/main', commits: [] });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('posts pull_request events', async () => {
    await handleGitHubEvent('pull_request', {
      action: 'opened',
      pull_request: { number: 42, title: 'New feature', user: { login: 'dev' } },
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('posts issue events', async () => {
    await handleGitHubEvent('issues', {
      action: 'opened',
      issue: { number: 7, title: 'Bug', user: { login: 'u' } },
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('posts issue_comment events', async () => {
    await handleGitHubEvent('issue_comment', {
      issue: { number: 7 },
      comment: { body: 'looks good', user: { login: 'u' } },
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('posts create events', async () => {
    await handleGitHubEvent('create', {
      ref_type: 'branch',
      ref: 'feature/x',
      sender: { login: 'u' },
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('posts delete events', async () => {
    await handleGitHubEvent('delete', {
      ref_type: 'branch',
      ref: 'old-branch',
      sender: { login: 'u' },
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('posts release events', async () => {
    await handleGitHubEvent('release', {
      release: { tag_name: 'v1.0', name: 'First', author: { login: 'u' } },
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('posts deployment_status events', async () => {
    await handleGitHubEvent('deployment_status', {
      deployment_status: { state: 'success', environment: 'prod' },
      sender: { login: 'system' },
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('posts workflow_run completed events', async () => {
    await handleGitHubEvent('workflow_run', {
      action: 'completed',
      workflow_run: { conclusion: 'success', name: 'CI', head_branch: 'main', actor: { login: 'bot' } },
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('ignores non-completed workflow_run events', async () => {
    await handleGitHubEvent('workflow_run', { action: 'requested', workflow_run: {} });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('posts star events', async () => {
    await handleGitHubEvent('star', { action: 'created', sender: { login: 'fan' } });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('ignores star deleted', async () => {
    await handleGitHubEvent('star', { action: 'deleted', sender: { login: 'fan' } });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('posts fork events', async () => {
    await handleGitHubEvent('fork', { sender: { login: 'forker' } });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown events', async () => {
    await handleGitHubEvent('ping', {});
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does nothing when no channel is set', async () => {
    setGitHubChannel(null as any);
    await handleGitHubEvent('push', {
      ref: 'refs/heads/main',
      commits: [{ id: 'abc', message: 'hi' }],
      pusher: { name: 'dev' },
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
