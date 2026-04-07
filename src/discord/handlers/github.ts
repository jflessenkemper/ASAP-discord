import crypto from 'crypto';

import { TextChannel } from 'discord.js';

import { formatOpsLine } from '../services/opsFeed';
import { captureAndPostScreenshots } from '../services/screenshots';

let githubChannel: TextChannel | null = null;

export function setGitHubChannel(channel: TextChannel): void {
  githubChannel = channel;
}

/**
 * Verify GitHub webhook signature (optional — if GITHUB_WEBHOOK_SECRET is set).
 */
export function verifySignature(payload: string, signature: string | undefined): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return false; // Reject if no secret configured

  if (!signature) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/**
 * Handle a GitHub webhook event and post to Discord.
 */
export async function handleGitHubEvent(
  event: string,
  payload: Record<string, any>
): Promise<void> {
  if (!githubChannel) return;

  const message = formatEvent(event, payload);
  if (!message) return;

  try {
    await githubChannel.send(message.slice(0, 2000));
  } catch (err) {
    console.error('GitHub webhook post error:', err instanceof Error ? err.message : 'Unknown');
  }

  const shouldScreenshot =
    (event === 'workflow_run' && payload.action === 'completed' && payload.workflow_run?.conclusion === 'success') ||
    (event === 'deployment_status' && payload.deployment_status?.state === 'success');

  if (shouldScreenshot) {
    const appUrl = process.env.FRONTEND_URL || 'https://asap-489910.australia-southeast1.run.app';
    const label = event === 'workflow_run'
      ? payload.workflow_run?.head_sha?.slice(0, 7) || 'latest'
      : 'deploy';
    captureAndPostScreenshots(appUrl, label).catch((err) => {
      console.error('Post-build screenshot error:', err instanceof Error ? err.message : 'Unknown');
    });
  }
}

function formatEvent(event: string, p: Record<string, any>): string | null {
  const actorTag = (raw: unknown): string => {
    const value = String(raw || 'unknown').toLowerCase();
    const slug = value.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'unknown';
  };

  switch (event) {
    case 'push': {
      const branch = (p.ref || '').replace('refs/heads/', '');
      const commits = p.commits || [];
      if (commits.length === 0) return null;
      const pusher = p.pusher?.name || 'unknown';
      const firstCommit = commits[0] || {};
      const firstSha = String(firstCommit.id || '').slice(0, 7) || 'unknown';
      const firstMsg = String(firstCommit.message || '').split('\n')[0].slice(0, 70);
      return formatOpsLine({
        actor: actorTag(pusher),
        scope: 'github:push',
        metric: `branch=${branch || 'unknown'}`,
        delta: `commits=${commits.length} first=${firstSha} msg=${firstMsg}`,
        action: 'none',
        severity: 'info',
      });
    }

    case 'pull_request': {
      const action = p.action;
      const pr = p.pull_request || {};
      const user = pr.user?.login || 'unknown';
      const sev = action === 'closed' && !pr.merged ? 'warn' : 'info';
      return formatOpsLine({
        actor: actorTag(user),
        scope: 'github:pull-request',
        metric: `pr#${pr.number} action=${action}`,
        delta: `title=${String(pr.title || '').slice(0, 100)}`,
        action: sev === 'warn' ? 'review closed-unmerged PR' : 'none',
        severity: sev,
      });
    }

    case 'issues': {
      const action = p.action;
      const issue = p.issue || {};
      const user = issue.user?.login || 'unknown';
      return formatOpsLine({
        actor: actorTag(user),
        scope: 'github:issue',
        metric: `issue#${issue.number} action=${action}`,
        delta: `title=${String(issue.title || '').slice(0, 100)}`,
        action: 'none',
        severity: 'info',
      });
    }

    case 'issue_comment': {
      const issue = p.issue || {};
      const comment = p.comment || {};
      const user = comment.user?.login || 'unknown';
      return formatOpsLine({
        actor: actorTag(user),
        scope: 'github:issue-comment',
        metric: `issue#${issue.number}`,
        delta: `comment=${String(comment.body || '').slice(0, 120)}`,
        action: 'none',
        severity: 'info',
      });
    }

    case 'create': {
      const refType = p.ref_type; // branch or tag
      const ref = p.ref;
      const user = p.sender?.login || 'unknown';
      return formatOpsLine({
        actor: actorTag(user),
        scope: 'github:create',
        metric: `${refType || 'ref'}=${ref || 'unknown'}`,
        delta: 'resource-created',
        action: 'none',
        severity: 'info',
      });
    }

    case 'delete': {
      const refType = p.ref_type;
      const ref = p.ref;
      const user = p.sender?.login || 'unknown';
      return formatOpsLine({
        actor: actorTag(user),
        scope: 'github:delete',
        metric: `${refType || 'ref'}=${ref || 'unknown'}`,
        delta: 'resource-deleted',
        action: 'verify delete was intentional',
        severity: 'warn',
      });
    }

    case 'release': {
      const release = p.release || {};
      const user = release.author?.login || 'unknown';
      return formatOpsLine({
        actor: actorTag(user),
        scope: 'github:release',
        metric: `tag=${release.tag_name || 'unknown'}`,
        delta: `name=${String(release.name || '').slice(0, 90)}`,
        action: 'none',
        severity: 'info',
      });
    }

    case 'deployment_status': {
      const state = p.deployment_status?.state || 'unknown';
      const env = p.deployment_status?.environment || 'unknown';
      const user = p.sender?.login || 'system';
      const sev = state === 'failure' ? 'error' : state === 'success' ? 'info' : 'warn';
      return formatOpsLine({
        actor: actorTag(user),
        scope: 'github:deployment',
        metric: `env=${env}`,
        delta: `state=${state}`,
        action: sev === 'error' ? 'inspect deployment logs and rollback if needed' : 'none',
        severity: sev,
      });
    }

    case 'workflow_run': {
      const run = p.workflow_run || {};
      if (p.action !== 'completed') return null;
      const user = run.actor?.login || p.sender?.login || 'system';
      const ok = run.conclusion === 'success';
      return formatOpsLine({
        actor: actorTag(user),
        scope: 'github:workflow',
        metric: `${run.name || 'workflow'}:${String(run.head_branch || '').slice(0, 30) || 'unknown'}`,
        delta: `result=${run.conclusion || 'unknown'}`,
        action: ok ? 'none' : 'open workflow run and fix failing job',
        severity: ok ? 'info' : 'error',
      });
    }

    case 'star': {
      if (p.action !== 'created') return null;
      const user = p.sender?.login || 'someone';
      return formatOpsLine({
        actor: actorTag(user),
        scope: 'github:star',
        metric: 'repo-starred',
        delta: 'new-star',
        action: 'none',
        severity: 'info',
      });
    }

    case 'fork': {
      const user = p.sender?.login || 'someone';
      return formatOpsLine({
        actor: actorTag(user),
        scope: 'github:fork',
        metric: 'repo-forked',
        delta: 'new-fork',
        action: 'none',
        severity: 'info',
      });
    }

    default:
      return null; // Ignore unhandled events
  }
}
