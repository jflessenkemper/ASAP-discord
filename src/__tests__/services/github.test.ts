const mockCreate = jest.fn();
const mockGetRef = jest.fn();
const mockCreateRef = jest.fn();
const mockPullsCreate = jest.fn();
const mockPullsMerge = jest.fn();
const mockPullsList = jest.fn();
const mockCreateComment = jest.fn();
const mockSearchCode = jest.fn();
const mockSearchIssues = jest.fn();
const mockSearchCommits = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    git: { getRef: mockGetRef, createRef: mockCreateRef },
    pulls: { create: mockPullsCreate, merge: mockPullsMerge, list: mockPullsList },
    issues: { createComment: mockCreateComment },
    search: { code: mockSearchCode, issuesAndPullRequests: mockSearchIssues, commits: mockSearchCommits },
  })),
}));

import {
  createBranch,
  createPullRequest,
  mergePullRequest,
  addPRComment,
  listPullRequests,
  searchGitHub,
} from '../../services/github';

describe('services/github', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GITHUB_TOKEN = 'test-token';
  });

  describe('createBranch', () => {
    it('creates a branch from base SHA', async () => {
      mockGetRef.mockResolvedValueOnce({ data: { object: { sha: 'abc1234567' } } });
      mockCreateRef.mockResolvedValueOnce({});

      const result = await createBranch('feature/x', 'main');
      expect(result).toContain('feature/x');
      expect(result).toContain('abc1234');
      expect(mockCreateRef).toHaveBeenCalledWith(
        expect.objectContaining({ ref: 'refs/heads/feature/x', sha: 'abc1234567' })
      );
    });
  });

  describe('createPullRequest', () => {
    it('returns PR number and URL', async () => {
      mockPullsCreate.mockResolvedValueOnce({
        data: { number: 42, html_url: 'https://github.com/test/pr/42' },
      });

      const result = await createPullRequest('Title', 'Body', 'feature/x');
      expect(result).toEqual({ number: 42, url: 'https://github.com/test/pr/42' });
    });
  });

  describe('mergePullRequest', () => {
    it('returns merge message', async () => {
      mockPullsMerge.mockResolvedValueOnce({ data: { message: 'Pull Request successfully merged' } });

      const result = await mergePullRequest(42);
      expect(result).toContain('merged');
    });
  });

  describe('addPRComment', () => {
    it('creates issue comment', async () => {
      mockCreateComment.mockResolvedValueOnce({});
      await addPRComment(42, 'LGTM');
      expect(mockCreateComment).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 42, body: 'LGTM' })
      );
    });
  });

  describe('listPullRequests', () => {
    it('returns formatted PR list', async () => {
      mockPullsList.mockResolvedValueOnce({
        data: [{ number: 1, title: 'Fix bug', head: { ref: 'fix/bug' } }],
      });

      const result = await listPullRequests();
      expect(result).toEqual([{ number: 1, title: 'Fix bug', head: 'fix/bug' }]);
    });
  });

  describe('searchGitHub', () => {
    it('searches code', async () => {
      mockSearchCode.mockResolvedValueOnce({
        data: {
          total_count: 1,
          items: [{ path: 'src/index.ts', name: 'index.ts', html_url: 'https://github.com/test' }],
        },
      });
      const result = await searchGitHub('function', 'code');
      expect(result).toContain('index.ts');
    });

    it('returns no matches message for empty code search', async () => {
      mockSearchCode.mockResolvedValueOnce({ data: { total_count: 0, items: [] } });
      const result = await searchGitHub('nonexistent');
      expect(result).toContain('No code matches');
    });

    it('searches issues', async () => {
      mockSearchIssues.mockResolvedValueOnce({
        data: {
          total_count: 1,
          items: [{ number: 5, state: 'open', title: 'Bug', html_url: 'https://github.com/issue/5' }],
        },
      });
      const result = await searchGitHub('bug', 'issues');
      expect(result).toContain('#5');
    });

    it('searches commits', async () => {
      mockSearchCommits.mockResolvedValueOnce({
        data: {
          total_count: 1,
          items: [{ sha: 'abc1234567890', commit: { message: 'fix: thing' }, html_url: 'https://gh.com/c' }],
        },
      });
      const result = await searchGitHub('fix', 'commits');
      expect(result).toContain('abc1234');
    });
  });
});
