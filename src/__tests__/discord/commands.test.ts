jest.mock('discord.js', () => ({
  Client: jest.fn(),
  REST: jest.fn().mockImplementation(() => ({
    setToken: jest.fn().mockReturnThis(),
    put: jest.fn().mockResolvedValue(undefined),
  })),
  Routes: {
    applicationGuildCommands: jest.fn().mockReturnValue('/mock-route'),
  },
  SlashCommandBuilder: jest.fn().mockImplementation(() => {
    const builder: any = {};
    builder.setName = jest.fn().mockReturnValue(builder);
    builder.setDescription = jest.fn().mockReturnValue(builder);
    builder.addSubcommand = jest.fn().mockImplementation((cb) => {
      const sub: any = {};
      sub.setName = jest.fn().mockReturnValue(sub);
      sub.setDescription = jest.fn().mockReturnValue(sub);
      sub.addStringOption = jest.fn().mockImplementation((optCb) => {
        const opt: any = {};
        opt.setName = jest.fn().mockReturnValue(opt);
        opt.setDescription = jest.fn().mockReturnValue(opt);
        opt.setRequired = jest.fn().mockReturnValue(opt);
        opt.addChoices = jest.fn().mockReturnValue(opt);
        optCb(opt);
        return sub;
      });
      cb(sub);
      return builder;
    });
    builder.toJSON = jest.fn().mockReturnValue({ name: 'ops' });
    return builder;
  }),
}));

import { registerCommands } from '../../discord/commands';

describe('registerCommands', () => {
  const mockPut = jest.fn().mockResolvedValue(undefined);
  const mockClient = {
    token: 'test-token',
    user: { id: '123456' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    const { REST } = require('discord.js');
    REST.mockImplementation(() => ({
      setToken: jest.fn().mockReturnThis(),
      put: mockPut,
    }));
  });

  it('registers slash commands without throwing', async () => {
    await expect(registerCommands(mockClient, 'guild-123')).resolves.toBeUndefined();
  });

  it('calls REST.put with guild commands route', async () => {
    await registerCommands(mockClient, 'guild-123');
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it('handles REST errors gracefully', async () => {
    mockPut.mockRejectedValueOnce(new Error('Discord API error'));
    const spy = jest.spyOn(console, 'error').mockImplementation();
    await expect(registerCommands(mockClient, 'guild-123')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Slash command'), expect.any(String));
    spy.mockRestore();
  });
});
