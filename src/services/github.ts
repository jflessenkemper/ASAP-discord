import { Octokit } from '@octokit/rest';

const OWNER = process.env.GITHUB_OWNER || 'jflessenkemper';
const REPO = process.env.GITHUB_REPO || 'ASAP';
/** Separate repo for bot self-improvement PRs (if ASAP app is the default) */
const BOT_REPO = process.env.GITHUB_REPO_BOT || 'ASAP-discord';

export { OWNER as GITHUB_OWNER, REPO as GITHUB_REPO, BOT_REPO as GITHUB_BOT_REPO };

let octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (!octokit) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN not set');
    octokit = new Octokit({ auth: token });
  }
  return octokit;
}

/**
 * Create a new branch from a base branch.
 */
export async function createBranch(branchName: string, baseBranch = 'main'): Promise<string> {
  const ok = getOctokit();

  // Get the SHA of the base branch
  const { data: ref } = await ok.git.getRef({
    owner: OWNER,
    repo: REPO,
    ref: `heads/${baseBranch}`,
  });

  await ok.git.createRef({
    owner: OWNER,
    repo: REPO,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });

  return `Branch '${branchName}' created from '${baseBranch}' at ${ref.object.sha.slice(0, 7)}`;
}

/**
 * Create a pull request.
 */
export async function createPullRequest(
  title: string,
  body: string,
  head: string,
  base = 'main'
): Promise<{ number: number; url: string }> {
  const ok = getOctokit();

  const { data: pr } = await ok.pulls.create({
    owner: OWNER,
    repo: REPO,
    title,
    body,
    head,
    base,
  });

  return { number: pr.number, url: pr.html_url };
}

/**
 * Merge a pull request (squash by default).
 */
export async function mergePullRequest(
  prNumber: number,
  commitTitle?: string
): Promise<string> {
  const ok = getOctokit();

  const { data } = await ok.pulls.merge({
    owner: OWNER,
    repo: REPO,
    pull_number: prNumber,
    merge_method: 'squash',
    commit_title: commitTitle,
  });

  return data.message || `PR #${prNumber} merged`;
}

/**
 * Add a comment to a pull request.
 */
export async function addPRComment(prNumber: number, body: string): Promise<void> {
  const ok = getOctokit();

  await ok.issues.createComment({
    owner: OWNER,
    repo: REPO,
    issue_number: prNumber,
    body,
  });
}

/**
 * List open pull requests.
 */
export async function listPullRequests(): Promise<Array<{ number: number; title: string; head: string }>> {
  const ok = getOctokit();

  const { data } = await ok.pulls.list({
    owner: OWNER,
    repo: REPO,
    state: 'open',
    per_page: 10,
  });

  return data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    head: pr.head.ref,
  }));
}

/**
 * Search the GitHub repository for code, issues, or commits.
 */
export async function searchGitHub(
  query: string,
  type: 'code' | 'issues' | 'commits' = 'code'
): Promise<string> {
  const ok = getOctokit();
  const repoQualifier = `repo:${OWNER}/${REPO}`;
  const fullQuery = `${query} ${repoQualifier}`;

  switch (type) {
    case 'code': {
      const { data } = await ok.search.code({ q: fullQuery, per_page: 15 });
      if (data.total_count === 0) return 'No code matches found.';
      return data.items.map(item =>
        `${item.path}:${item.name} — ${item.html_url}`
      ).join('\n');
    }
    case 'issues': {
      const { data } = await ok.search.issuesAndPullRequests({ q: fullQuery, per_page: 15 });
      if (data.total_count === 0) return 'No matching issues/PRs found.';
      return data.items.map(item =>
        `#${item.number} [${item.state}] ${item.title} — ${item.html_url}`
      ).join('\n');
    }
    case 'commits': {
      const { data } = await ok.search.commits({ q: fullQuery, per_page: 15 });
      if (data.total_count === 0) return 'No matching commits found.';
      return data.items.map(item =>
        `${item.sha.slice(0, 7)} ${item.commit.message.split('\n')[0]} — ${item.html_url}`
      ).join('\n');
    }
  }
}
