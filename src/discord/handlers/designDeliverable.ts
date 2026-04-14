import { buildAgentMentionGuide } from '../agents';

const DESIGN_DELIVERABLE_RE = /\bdesign\b.*\b(?:spec|system|html|css|page|route|mockup|wireframe)\b|\b(?:spec|html|css)\b.*\bdesign\b|\bglassmorphism\b/i;

const DESIGN_SKIP_CONTRACT_RE = /\bdesign\s*spec\b|\bglassmorphism\b|\bmockup\b|\bwireframe\b|\bstyle\s*guide\b/i;

const SPECIALIST_IDS = [
  'security-auditor', 'api-reviewer', 'dba', 'performance', 'devops',
  'copywriter', 'lawyer', 'qa', 'ux-reviewer', 'ios-engineer', 'android-engineer',
] as const;

export function isDesignDeliverableDetailed(rileyResponse: string, activeGoal: string | null): {
  match: boolean;
  rileyMatch: boolean;
  goalMatch: boolean;
} {
  const rileyMatch = DESIGN_DELIVERABLE_RE.test(rileyResponse);
  const goalMatch = DESIGN_DELIVERABLE_RE.test(activeGoal || '');
  return { match: rileyMatch || goalMatch, rileyMatch, goalMatch };
}

export function shouldSkipContractEnforcement(text: string): boolean {
  return DESIGN_SKIP_CONTRACT_RE.test(text);
}

export function buildAceDesignContext(rileyResponse: string): string {
  const mentionGuide = buildAgentMentionGuide(SPECIALIST_IDS);
  return `[Riley directed you]: ${rileyResponse}\n\n` +
    `Own execution yourself first. Only bring in extra specialists if they are truly needed. ` +
    `If you do delegate, use the exact Discord mentions from this guide: ${mentionGuide}.\n\n` +
    `This is a design deliverable task. You MUST create the file(s) using the write_file tool. ` +
    `Do not just explore the project — actually write the code. Steps: ` +
    `1) Read the existing route/page patterns to match conventions, ` +
    `2) Use write_file to create the new file(s) with complete HTML/CSS/code, ` +
    `3) After writing, confirm what you created with a short summary including the file path(s). ` +
    `Do NOT use Result/Evidence/Risk format. Do NOT reply with just "Done".`;
}

export function buildAceStandardContext(rileyResponse: string): string {
  const mentionGuide = buildAgentMentionGuide(SPECIALIST_IDS);
  return `[Riley directed you]: ${rileyResponse}\n\n` +
    `Own execution yourself first. Only bring in extra specialists if they are truly needed. ` +
    `If you do delegate, use the exact Discord mentions from this guide: ${mentionGuide}.\n\n` +
    `After making code changes: create a branch, commit, push, create a PR, then merge the PR using merge_pull_request. ` +
    `Do NOT leave changes on an unmerged branch.\n\n` +
    `When you finish, do NOT reply with just "Done". Include these exact sections:\n` +
    `- Result: one sentence outcome.\n` +
    `- Evidence: files changed, commands/tests run, and key output.\n` +
    `- Risk/Follow-up: any caveats or next checks.`;
}
