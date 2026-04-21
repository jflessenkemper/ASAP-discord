const DIRECT_GROUPCHAT_SHORT_PROMPT_MAX_WORDS = parseInt(process.env.DIRECT_GROUPCHAT_SHORT_PROMPT_MAX_WORDS || '30', 10);

function normalizeDirectedPrompt(prompt: string): string {
  return String(prompt || '')
    .replace(/<@[!&]?\d+>/g, ' ')
    .replace(/^(?:\[[^\]]+\]\s*)+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDirectRileyPrompt(prompt: string): boolean {
  return /^(?:hey|hi|yo)?\s*(?:riley|asap)\b[\s,!:;-]*/i.test(prompt);
}

function isLikelyWorkspaceTask(prompt: string): boolean {
  return /\b(?:fix|build|implement|investigate|audit|debug|analy[sz]e|review|search|write|create|deploy|restart|install|update|refactor|test|work\s+on|continue|resume|handle|solve)\b/i.test(prompt);
}

export function shouldKeepGroupchatPromptInChannel(agentIds: string[], userMessage: string): boolean {
  if (agentIds.length > 1) return false;
  if (agentIds.length === 1 && agentIds[0] !== 'executive-assistant') return false;

  const normalized = normalizeDirectedPrompt(userMessage);
  if (!normalized) return false;
  if (normalized.length > 180) return false;
  if (normalized.split(/\s+/).length > DIRECT_GROUPCHAT_SHORT_PROMPT_MAX_WORDS) return false;
  if (isLikelyWorkspaceTask(normalized)) return false;
  return isDirectRileyPrompt(normalized) || agentIds.length === 0;
}

export function shouldEchoDirectedResponseToGroupchat(agentIds: string[], userMessage: string): boolean {
  return shouldKeepGroupchatPromptInChannel(agentIds, userMessage);
}
