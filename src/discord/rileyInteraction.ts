export const DEFAULT_PRIMARY_DECISION_USER_ID = '483131535311110164';

export function resolvePrimaryDecisionUserId(configuredUserId?: string | null): string {
  const normalized = String(configuredUserId || '').trim();
  return normalized || DEFAULT_PRIMARY_DECISION_USER_ID;
}

export function buildGroupchatDecisionAttention(targetChannelId: string, groupchatId: string, configuredUserId?: string | null): string {
  if (!targetChannelId || targetChannelId !== groupchatId) return '';
  const userId = resolvePrimaryDecisionUserId(configuredUserId);
  return `<@${userId}> Riley needs a decision from you here.`;
}

export function buildVoiceDecisionPolicy(): string {
  return 'If you need a major user decision during a live call, ask the caller directly in voice right now. Do not defer them to the decisions channel while the call is active.';
}

export function buildVoiceSingleSpeakerNotice(activeSpeakerName?: string): string {
  const active = String(activeSpeakerName || '').trim();
  if (!active) {
    return '🟡 One speaker at a time please. Riley can only respond to one voice turn right now.';
  }
  return `🟡 One speaker at a time please. Riley is currently handling ${active} and will listen again when that turn is finished.`;
}

export function buildGroupchatSingleUserNotice(activeUserName?: string): string {
  const active = String(activeUserName || '').trim();
  if (!active) {
    return '🟡 One person at a time please. Riley is already handling another request in groupchat.';
  }
  return `🟡 One person at a time please. Riley is currently handling ${active}'s request in groupchat.`;
}

export function buildTextStatusSummary(statusLine: string, loopSummary: string): string {
  return [statusLine, loopSummary].filter(Boolean).join('\n\n');
}