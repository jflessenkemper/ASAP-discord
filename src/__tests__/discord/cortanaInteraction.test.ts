import {
  buildGroupchatDecisionAttention,
  buildTextStatusSummary,
  buildVoiceDecisionPolicy,
  DEFAULT_PRIMARY_DECISION_USER_ID,
  resolvePrimaryDecisionUserId,
} from '../../discord/cortanaInteraction';

describe('cortanaInteraction', () => {
  it('uses the configured primary decision user id when present', () => {
    expect(resolvePrimaryDecisionUserId('12345')).toBe('12345');
  });

  it('falls back to the default primary decision user id', () => {
    expect(resolvePrimaryDecisionUserId('')).toBe(DEFAULT_PRIMARY_DECISION_USER_ID);
  });

  it('builds a groupchat-only decision attention line', () => {
    expect(buildGroupchatDecisionAttention('groupchat', 'groupchat', '999')).toBe('<@999> Cortana needs a decision from you here.');
    expect(buildGroupchatDecisionAttention('decisions', 'groupchat', '999')).toBe('');
  });

  it('builds a text status summary with loop details', () => {
    const summary = buildTextStatusSummary('📋 Working on ASAP app', 'Loops\n✅ channel-heartbeat: just now');
    expect(summary).toContain('📋 Working on ASAP app');
    expect(summary).toContain('Loops');
  });

  it('tells Cortana to ask for decisions directly in live voice', () => {
    expect(buildVoiceDecisionPolicy()).toContain('ask the caller directly in voice');
    expect(buildVoiceDecisionPolicy()).toContain('Do not defer them to the decisions channel');
  });
});