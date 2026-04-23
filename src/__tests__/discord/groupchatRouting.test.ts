import {
  shouldEchoDirectedResponseToGroupchat,
  shouldKeepGroupchatPromptInChannel,
} from '../../discord/services/groupchatRouting';

describe('groupchatRouting', () => {
  it('keeps short Cortana-directed questions in groupchat', () => {
    expect(shouldKeepGroupchatPromptInChannel(['executive-assistant'], 'Cortana why did that fail?')).toBe(true);
    expect(shouldEchoDirectedResponseToGroupchat(['executive-assistant'], 'Cortana why did that fail?')).toBe(true);
  });

  it('routes real task requests to a workspace', () => {
    expect(shouldKeepGroupchatPromptInChannel(['executive-assistant'], 'Cortana investigate the token blocker failure and fix it')).toBe(false);
  });

  it('does not keep specialist requests in groupchat', () => {
    expect(shouldKeepGroupchatPromptInChannel(['qa'], 'Cortana why did that fail?')).toBe(false);
  });

  it('keeps short conversational messages with no agent mentions in groupchat', () => {
    expect(shouldKeepGroupchatPromptInChannel([], 'ok can you talk to me here now')).toBe(true);
    expect(shouldKeepGroupchatPromptInChannel([], 'why do you keep posting that')).toBe(true);
  });

  it('routes task-like no-mention messages to a workspace', () => {
    expect(shouldKeepGroupchatPromptInChannel([], 'can you build me an app')).toBe(false);
    expect(shouldKeepGroupchatPromptInChannel([], 'fix the voice bug')).toBe(false);
  });

  it('keeps groupchat for messages with check/run verbs that are conversational', () => {
    expect(shouldKeepGroupchatPromptInChannel(['executive-assistant'], 'Cortana can you check on that')).toBe(true);
    expect(shouldKeepGroupchatPromptInChannel(['executive-assistant'], 'Cortana run me through what happened')).toBe(true);
  });
});
