const mockGenerateAnthropicText = jest.fn();

jest.mock('../../services/anthropicText', () => ({
  generateAnthropicText: (...args: any[]) => mockGenerateAnthropicText(...args),
}));

describe('discordOutputSanitizer', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.DISCORD_OUTPUT_SANITIZER_MODEL;
  });

  it('uses the configured fast Anthropic model instead of the stale Haiku alias', async () => {
    jest.doMock('../../services/modelConfig', () => ({
      DEFAULT_FAST_MODEL: 'claude-sonnet-4-20250514',
      isAnthropicModel: (modelName: string) => String(modelName || '').includes('claude'),
    }));
    mockGenerateAnthropicText.mockResolvedValue('clean output');

    const { sanitizeDiscordVisibleOutput } = await import('../../discord/services/discordOutputSanitizer');
    await sanitizeDiscordVisibleOutput('test message');

    expect(mockGenerateAnthropicText).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-4-20250514',
    }));
  });

  it('skips the Anthropic sanitizer rewrite when configured with a non-Anthropic model', async () => {
    process.env.DISCORD_OUTPUT_SANITIZER_MODEL = 'gemini-2.5-flash';
    jest.doMock('../../services/modelConfig', () => ({
      DEFAULT_FAST_MODEL: 'claude-sonnet-4-20250514',
      isAnthropicModel: (modelName: string) => String(modelName || '').includes('claude'),
    }));

    const { sanitizeDiscordVisibleOutput } = await import('../../discord/services/discordOutputSanitizer');
    const result = await sanitizeDiscordVisibleOutput('hello @everyone');

    expect(result).toBe('hello @\u200beveryone');
    expect(mockGenerateAnthropicText).not.toHaveBeenCalled();
  });
});
