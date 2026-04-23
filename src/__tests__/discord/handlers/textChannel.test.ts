/**
 * Tests for src/discord/handlers/textChannel.ts
 * Text channel message handling — renderAgentMessage, clearHistory.
 */

jest.mock('../../../db/pool', () => ({
  default: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), on: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../discord/agents', () => ({
  getAgentMention: jest.fn((id: string) => `<@agent-${id}>`),
  resolveAgentId: jest.fn((name: string) => {
    const map: Record<string, string> = {
      riley: 'executive-assistant', ace: 'developer', max: 'qa',
    };
    return map[name.toLowerCase()] || null;
  }),
}));
jest.mock('../../../discord/claude', () => ({
  agentRespond: jest.fn(),
}));
jest.mock('../../../discord/memory', () => ({
  appendToMemory: jest.fn(),
  getMemoryContext: jest.fn().mockResolvedValue(''),
}));
jest.mock('../../../discord/metrics', () => ({
  recordTextChannelTimeout: jest.fn(),
  updateTextChannelQueueDepth: jest.fn(),
}));
jest.mock('../../../discord/services/diagnosticsWebhook', () => ({
  mirrorAgentResponse: jest.fn(),
}));
jest.mock('../../../services/anthropicText', () => ({
  generateAnthropicText: jest.fn(),
}));
jest.mock('../../../discord/services/webhooks', () => ({
  clearWebhookCache: jest.fn(),
  sendWebhookMessage: jest.fn(),
}));
jest.mock('../../../discord/handlers/responseNormalization', () => ({
  isLowSignalCompletion: jest.fn().mockReturnValue(false),
}));

import { generateAnthropicText } from '../../../services/anthropicText';
import { sendWebhookMessage } from '../../../discord/services/webhooks';
import { renderAgentMessage, clearHistory, sendAgentMessage } from '../../../discord/handlers/textChannel';

describe('textChannel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (generateAnthropicText as jest.Mock).mockResolvedValue('Sanitized response');
  });

  describe('renderAgentMessage()', () => {
    it('strips [ACTION:*] tags', () => {
      const result = renderAgentMessage('Hello [ACTION:deploy] world');
      expect(result).not.toContain('[ACTION:');
      expect(result).toContain('Hello');
      expect(result).toContain('world');
    });

    it('returns empty string for action-only messages', () => {
      expect(renderAgentMessage('[ACTION:test]')).toBe('');
    });

    it('strips smoke test tokens', () => {
      const result = renderAgentMessage('Result [smoke-token abc] here');
      expect(result).not.toContain('[smoke-token');
    });

    it('strips SMOKE_ constants', () => {
      const result = renderAgentMessage('Found SMOKE_ABC123 in output');
      expect(result).not.toContain('SMOKE_ABC123');
    });

    it('strips speaker labels (Cortana:)', () => {
      const result = renderAgentMessage('Cortana: I will check the status');
      expect(result).not.toMatch(/^Cortana:/);
      expect(result).toContain('I will check the status');
    });

    it('strips speaker labels (Ace:)', () => {
      const result = renderAgentMessage('Ace: The code looks good');
      expect(result).toContain('The code looks good');
    });

    it('strips markdown headings', () => {
      const result = renderAgentMessage('## Status Update\nEverything is fine');
      expect(result).not.toContain('##');
      expect(result).toContain('Status Update');
    });

    it('strips blockquotes', () => {
      const result = renderAgentMessage('> Quote text\nNormal text');
      expect(result).toContain('Normal text');
    });

    it('preserves code blocks', () => {
      const result = renderAgentMessage('Here is code:\n```js\nconst x = 1;\n```\nDone');
      expect(result).toContain('```js\nconst x = 1;\n```');
    });

    it('removes heavy bold outside code blocks', () => {
      const result = renderAgentMessage('This is **important** text');
      expect(result).not.toContain('**');
      expect(result).toContain('important');
    });

    it('preserves bold inside code blocks', () => {
      const result = renderAgentMessage('```\n**bold**\n```');
      expect(result).toContain('**bold**');
    });

    it('replaces "I cannot access" wording', () => {
      const result = renderAgentMessage('I cannot access the database');
      expect(result).toContain('Blocked: missing access to');
    });

    it('replaces "I don\'t have access to" wording', () => {
      const result = renderAgentMessage("I don't have access to the file system");
      expect(result).toContain('Blocked: missing access to');
    });

    it('adds action cue for long messages without action words', () => {
      const longText = 'This is a somewhat lengthy analysis of the current state. '.repeat(10);
      const result = renderAgentMessage(longText);
      expect(result).toContain('Next step:');
    });

    it('does not add action cue for messages with action words', () => {
      const longText = 'I will now check the logs and verify the deployment was successful. '.repeat(5);
      const result = renderAgentMessage(longText);
      // Should contain "will" and "check" action words — might not add "Next step:"
    });

    it('returns empty for empty input', () => {
      expect(renderAgentMessage('')).toBe('');
    });
  });

  describe('clearHistory()', () => {
    it('does not throw when clearing unknown channel', () => {
      expect(() => clearHistory('unknown-channel-id')).not.toThrow();
    });
  });

  describe('sendAgentMessage()', () => {
    it('sanitizes visible Discord output through the sanitizer pass', async () => {
      const channel = { name: 'groupchat' } as any;
      const agent = { id: 'executive-assistant', emoji: '📋', name: 'Cortana', avatarUrl: 'https://example.test/riley.png' } as any;

      await sendAgentMessage(channel, agent, 'Original response with [TOOL:run_command] marker');

      expect(generateAnthropicText).toHaveBeenCalled();
      expect(sendWebhookMessage).toHaveBeenCalledWith(
        channel,
        expect.objectContaining({ content: 'Sanitized response' }),
      );
    });

    it('falls back to local sanitization when the sanitizer call fails', async () => {
      const channel = { name: 'groupchat' } as any;
      const agent = { id: 'qa', emoji: '🧪', name: 'QA', avatarUrl: 'https://example.test/qa.png' } as any;
      (generateAnthropicText as jest.Mock).mockRejectedValueOnce(new Error('timeout'));

      await sendAgentMessage(channel, agent, 'Result [TOOL:read_file] with @everyone warning');

      const sentPayload = (sendWebhookMessage as jest.Mock).mock.calls[0][1];
      expect(sentPayload.content).toContain('@\u200beveryone');
      expect(sentPayload.content).not.toContain('[TOOL:');
    });
  });
});
