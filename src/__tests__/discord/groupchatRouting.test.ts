import {
  shouldEchoDirectedResponseToGroupchat,
  shouldKeepGroupchatPromptInChannel,
} from '../../discord/services/groupchatRouting';

describe('groupchatRouting', () => {
  it('keeps short Riley-directed questions in groupchat', () => {
    expect(shouldKeepGroupchatPromptInChannel(['executive-assistant'], 'Riley why did that fail?')).toBe(true);
    expect(shouldEchoDirectedResponseToGroupchat(['executive-assistant'], 'Riley why did that fail?')).toBe(true);
  });

  it('routes real task requests to a workspace', () => {
    expect(shouldKeepGroupchatPromptInChannel(['executive-assistant'], 'Riley investigate the token blocker failure and fix it')).toBe(false);
  });

  it('does not keep specialist requests in groupchat', () => {
    expect(shouldKeepGroupchatPromptInChannel(['qa'], 'Riley why did that fail?')).toBe(false);
  });
});
