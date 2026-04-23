import { TextChannel } from 'discord.js';

import { addPRComment } from '../../services/github';
import { getAgent, AgentId } from '../agents';
import { agentRespond } from '../claude';
import { getMemoryContext, appendToMemory } from '../memory';

import { documentToChannel } from './documentation';
import { errMsg } from '../../utils/errors';

/**
 * Patterns of files that trigger automatic review by Themis (Lawyer) and/or Athena (Security).
 * When a PR touches these files, the relevant agents are auto-consulted.
 */
const SENSITIVE_PATTERNS: Array<{
  pattern: RegExp;
  agents: Array<'lawyer' | 'security-auditor'>;
  reason: string;
}> = [
  { pattern: /\bauth\b/i, agents: ['security-auditor', 'lawyer'], reason: 'Authentication code' },
  { pattern: /\bpassword|bcrypt|jwt|token\b/i, agents: ['security-auditor'], reason: 'Credential handling' },
  { pattern: /middleware\/auth/i, agents: ['security-auditor'], reason: 'Auth middleware' },

  { pattern: /migrations\//i, agents: ['lawyer', 'security-auditor'], reason: 'Database migration' },

  { pattern: /\bprivacy|gdpr|consent|personal.?data|user.?data\b/i, agents: ['lawyer'], reason: 'Privacy-related code' },

  { pattern: /\bpayment|billing|invoice|stripe|charge\b/i, agents: ['lawyer', 'security-auditor'], reason: 'Payment processing' },

  { pattern: /\bterms|tos|privacy.?policy|disclaimer\b/i, agents: ['lawyer'], reason: 'Legal document' },

  { pattern: /\.env|secret|credential/i, agents: ['security-auditor'], reason: 'Secret/credential file' },

  { pattern: /Dockerfile|cloudbuild|gcp-setup/i, agents: ['security-auditor'], reason: 'Infrastructure config' },
];

/**
 * Determine which agents should auto-review based on changed file paths.
 */
export function getRequiredReviewers(changedFiles: string[]): Map<string, string[]> {
  const reviewers = new Map<string, string[]>(); // agentId → reasons[]

  for (const file of changedFiles) {
    for (const rule of SENSITIVE_PATTERNS) {
      if (rule.pattern.test(file)) {
        for (const agentId of rule.agents) {
          const reasons = reviewers.get(agentId) || [];
          const reason = `${rule.reason}: \`${file}\``;
          if (!reasons.includes(reason)) reasons.push(reason);
          reviewers.set(agentId, reasons);
        }
      }
    }
  }

  return reviewers;
}

/**
 * Auto-consult agents on a pull request.
 * Posts their review as a PR comment and to the groupchat.
 * Reviewers are called in parallel for speed.
 */
export async function autoReviewPR(
  prNumber: number,
  prTitle: string,
  changedFiles: string[],
  diffSummary: string,
  groupchat: TextChannel
): Promise<void> {
  const reviewers = getRequiredReviewers(changedFiles);
  if (reviewers.size === 0) return;

  const prUrl = `https://github.com/${process.env.GITHUB_REPO || 'jflessenkemper/ASAP'}/pull/${prNumber}`;

  const reviewEntries = [...reviewers];
  const MAX_PARALLEL_REVIEWS = 3;

  for (let i = 0; i < reviewEntries.length; i += MAX_PARALLEL_REVIEWS) {
    const batch = reviewEntries.slice(i, i + MAX_PARALLEL_REVIEWS);
    await Promise.allSettled(
      batch.map(async ([agentId, reasons]) => {
    const agent = getAgent(agentId as AgentId);
    if (!agent) return;

    const reasonList = reasons.map((r) => `- ${r}`).join('\n');
    const reviewPrompt = `[AUTO-REVIEW] PR #${prNumber}: "${prTitle}"

You are being automatically consulted because this PR touches sensitive files:
${reasonList}

Changed files: ${changedFiles.join(', ')}

Diff summary:
${diffSummary.slice(0, 3000)}

Please review for ${agentId === 'lawyer' ? 'legal/compliance issues (Australian law, privacy, data handling)' : 'security vulnerabilities (OWASP Top 10, auth bypass, injection, data exposure)'}.

Respond with:
- ✅ **APPROVED** if no issues found
- ⚠️ **CONCERNS** followed by specific issues
- ❌ **BLOCKED** if there are critical problems that must be fixed

Keep your review under 300 words.`;

    try {
      await documentToChannel(agentId, `🔍 Auto-reviewing PR #${prNumber}: ${prTitle}`);

      const agentMemory = getMemoryContext(agentId);
      const response = await agentRespond(agent, agentMemory, reviewPrompt);

      try {
        await addPRComment(prNumber, `## ${agent.emoji} ${agent.name} — Auto-Review\n\n${response}`);
      } catch {
      }

      await groupchat.send(`${agent.emoji} **${agent.name.split(' ')[0]}** reviewed [PR #${prNumber}](${prUrl}):\n${response.slice(0, 1800)}`);

      await documentToChannel(agentId, `✅ Review posted for PR #${prNumber}`);
      appendToMemory(agentId, [
        { role: 'user', content: `Auto-review PR #${prNumber}: ${prTitle}` },
        { role: 'assistant', content: response },
      ]);
    } catch (err) {
      console.error(`Auto-review error (${agentId}):`, errMsg(err));
      await groupchat.send(`⚠️ ${agent.emoji} ${agent.name.split(' ')[0]} could not review PR #${prNumber}`);
    }
      })
    );
  }
}
