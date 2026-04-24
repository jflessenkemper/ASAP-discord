/**
 * Regex-based prompt classifiers used by model routing.
 *
 * Extracted from claude.ts so the patterns live in one place, can be unit
 * tested in isolation, and the model-selection code stays focused on
 * orchestration rather than pattern matching.
 *
 * Each classifier normalizes the prompt once up front — strips the
 * `[Name]:` speaker prefix, Discord mentions, and whitespace — so callers
 * don't need to pre-clean.
 */

const CODE_WORK_RE = /\b(?:code|coding|implement(?:ation)?|fix(?:ing)?\s+(?:bug|error|crash|issue)|bug(?:fix)?|debug(?:ging)?|refactor(?:ing)?|build(?:ing)?\s+(?:the|a|this)|compile|lint(?:ing)?|typecheck(?:ing)?|deploy(?:ing|ment)?|migration|schema\s+(?:change|update|migration)|pull\s*request|merge\s+(?:pr|branch)|tsx|jsx|react\s+(?:native|component)|expo\s+(?:build|update))\b/i;
const CODE_EDIT_ACTION_RE = /\b(?:edit|modify|change|patch|update|write|rewrite|create|delete|remove|rename|move|add|insert)\b/i;
const CODE_ARTIFACT_RE = /(?:^|[\s(])(?:[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|py|rb|go|java|kt|swift|yaml|yml|css|scss|html))(?:\b|[):])/i;
const CODE_STRUCTURE_RE = /\b(?:file|files|codebase|repo(?:sitory)?|function|class|component|module|method|variable|comment|import|test|types?|interface|schema|migration|tsconfig|package\.json|readme)\b/i;
const TOOL_ACTION_RE = /\b(?:run|read|search|grep|inspect|check|verify|edit|change|update|deploy|build|test|commit|push|rollback|migrate|open)\b/i;
const SIMPLE_FAST_PATH_RE = /^(?:ok(?:ay)?|yes|no|thanks?|thank you|status|summary|summari[sz]e|what happened|why|how|help|ping|continue|proceed|looks good|sounds good)\b/i;
const DIRECT_ANSWER_ONLY_RE = /^(?:ok(?:ay)?|yes|no|thanks?|thank you|understood|sounds good|what does|what is|why is|how does|explain|summari[sz]e|clarify)\b/i;
const VERIFICATION_TASK_RE = /\b(?:verify|verification|confirm|smoke(?:\s+test)?|evidence|prove|check(?:\s+that)?|regression|screenshot|snapshot|next\s*steps)\b/i;
const HIGH_STAKES_RE = /(high[-\s]?stakes|critical|prod(?:uction)?|hotfix|incident|security|auth|migration|rollback|data\s+loss|schema|deploy)/i;

export function normalizePromptForHeuristics(userMessage: string): string {
  return String(userMessage || '')
    .replace(/^\[[^\]]+\]:\s*/, '')
    .replace(/<@[!&]?\d+>/g, ' ')
    .replace(/^(?:\[[^\]]+\]\s*)+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isHighStakesPrompt(userMessage: string): boolean {
  return HIGH_STAKES_RE.test(userMessage);
}

export function isCodeWorkPrompt(userMessage: string): boolean {
  return CODE_WORK_RE.test(normalizePromptForHeuristics(userMessage));
}

export function isCodeEditingPrompt(userMessage: string): boolean {
  const normalized = normalizePromptForHeuristics(userMessage);
  if (!normalized) return false;
  return CODE_EDIT_ACTION_RE.test(normalized) && (CODE_ARTIFACT_RE.test(normalized) || CODE_STRUCTURE_RE.test(normalized));
}

export function isCodingTaskPrompt(userMessage: string): boolean {
  return isCodeWorkPrompt(userMessage) || isCodeEditingPrompt(userMessage);
}

/**
 * Narrower gate for Opus pinning: true only when the prompt names an action
 * AND references a concrete code artifact (file path, class, function…).
 * Read-only questions like "what does this tsx do?" return false.
 */
export function isCodeEditIntent(userMessage: string): boolean {
  return isCodeEditingPrompt(userMessage);
}

export function isSimpleFastPathPrompt(userMessage: string): boolean {
  const trimmed = normalizePromptForHeuristics(userMessage);
  if (!trimmed || trimmed.length > 220) return false;
  if (TOOL_ACTION_RE.test(trimmed) || CODE_WORK_RE.test(trimmed)) return false;
  return SIMPLE_FAST_PATH_RE.test(trimmed) || trimmed.split(/\s+/).length <= 10;
}

export function isDirectAnswerOnlyPrompt(userMessage: string): boolean {
  const trimmed = normalizePromptForHeuristics(userMessage);
  if (!trimmed || trimmed.length > 240) return false;
  if (TOOL_ACTION_RE.test(trimmed) || CODE_WORK_RE.test(trimmed)) return false;
  return DIRECT_ANSWER_ONLY_RE.test(trimmed) || /^(?:who|what|why|how)\b/i.test(trimmed);
}

export function isVerificationTaskPrompt(userMessage: string): boolean {
  const trimmed = normalizePromptForHeuristics(userMessage);
  if (!trimmed || trimmed.length > 500) return false;
  return VERIFICATION_TASK_RE.test(trimmed);
}

/**
 * One-shot classifier for callers that need multiple flags — avoids
 * normalizing the same prompt several times in the same decision path.
 */
export interface PromptClassification {
  isCodeWork: boolean;
  isCodeEdit: boolean;
  isCodingTask: boolean;
  isHighStakes: boolean;
  isSimpleFast: boolean;
  isDirectAnswerOnly: boolean;
  isVerification: boolean;
}

export function classifyPrompt(userMessage: string): PromptClassification {
  const normalized = normalizePromptForHeuristics(userMessage);
  const codeWork = CODE_WORK_RE.test(normalized);
  const codeEdit = !!normalized && CODE_EDIT_ACTION_RE.test(normalized)
    && (CODE_ARTIFACT_RE.test(normalized) || CODE_STRUCTURE_RE.test(normalized));
  const blocksFastPath = TOOL_ACTION_RE.test(normalized) || codeWork;
  return {
    isCodeWork: codeWork,
    isCodeEdit: codeEdit,
    isCodingTask: codeWork || codeEdit,
    isHighStakes: HIGH_STAKES_RE.test(userMessage),
    isSimpleFast: !!normalized && normalized.length <= 220 && !blocksFastPath
      && (SIMPLE_FAST_PATH_RE.test(normalized) || normalized.split(/\s+/).length <= 10),
    isDirectAnswerOnly: !!normalized && normalized.length <= 240 && !blocksFastPath
      && (DIRECT_ANSWER_ONLY_RE.test(normalized) || /^(?:who|what|why|how)\b/i.test(normalized)),
    isVerification: !!normalized && normalized.length <= 500 && VERIFICATION_TASK_RE.test(normalized),
  };
}
