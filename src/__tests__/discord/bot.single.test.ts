jest.mock('../../discord/bot', () => ({
  startBot: jest.fn(),
  stopBot: jest.fn(),
  getBotChannels: jest.fn(),
}));
jest.mock('../../discord/handlers/github', () => ({
  verifySignature: jest.fn(),
  handleGitHubEvent: jest.fn(),
}));
jest.mock('../../discord/services/screenshots', () => ({
  captureAndPostScreenshots: jest.fn(),
}));
jest.mock('../../discord/services/agentErrors', () => ({
  postAgentErrorLog: jest.fn(),
}));
jest.mock('../../discord/services/telephony', () => ({
  getInboundTwiML: jest.fn(),
  attachTelephonyWebSocket: jest.fn(),
  isTelephonyAvailable: jest.fn(),
}));
jest.mock('../../discord/metrics', () => ({
  getMetricsText: jest.fn(),
  PROMETHEUS_CONTENT_TYPE: 'text/plain',
  updateGeminiSpend: jest.fn(),
}));
jest.mock('../../discord/usage', () => ({
  getRemainingBudget: jest.fn(),
}));

import * as botSingle from '../../discord/bot.single';

describe('bot.single re-exports', () => {
  it('exports startBot', () => {
    expect(botSingle).toHaveProperty('startBot');
  });

  it('exports stopBot', () => {
    expect(botSingle).toHaveProperty('stopBot');
  });

  it('exports getBotChannels', () => {
    expect(botSingle).toHaveProperty('getBotChannels');
  });

  it('exports verifySignature', () => {
    expect(botSingle).toHaveProperty('verifySignature');
  });

  it('exports handleGitHubEvent', () => {
    expect(botSingle).toHaveProperty('handleGitHubEvent');
  });

  it('exports captureAndPostScreenshots', () => {
    expect(botSingle).toHaveProperty('captureAndPostScreenshots');
  });

  it('exports postAgentErrorLog', () => {
    expect(botSingle).toHaveProperty('postAgentErrorLog');
  });

  it('exports getInboundTwiML', () => {
    expect(botSingle).toHaveProperty('getInboundTwiML');
  });

  it('exports attachTelephonyWebSocket', () => {
    expect(botSingle).toHaveProperty('attachTelephonyWebSocket');
  });

  it('exports isTelephonyAvailable', () => {
    expect(botSingle).toHaveProperty('isTelephonyAvailable');
  });

  it('exports getMetricsText', () => {
    expect(botSingle).toHaveProperty('getMetricsText');
  });

  it('exports PROMETHEUS_CONTENT_TYPE', () => {
    expect(botSingle.PROMETHEUS_CONTENT_TYPE).toBe('text/plain');
  });

  it('exports updateGeminiSpend', () => {
    expect(botSingle).toHaveProperty('updateGeminiSpend');
  });

  it('exports getRemainingBudget', () => {
    expect(botSingle).toHaveProperty('getRemainingBudget');
  });
});
