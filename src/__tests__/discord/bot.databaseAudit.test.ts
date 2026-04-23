export {};

const mockQuery = jest.fn();
const mockPostOpsLine = jest.fn().mockResolvedValue(undefined);
const mockPostAgentErrorLog = jest.fn().mockResolvedValue(undefined);

jest.mock('discord.js', () => ({
  Client: class {},
  GatewayIntentBits: {},
  Events: {},
  Partials: {},
  ChannelType: {},
  ApplicationCommandType: { Message: 3, User: 2 },
  ContextMenuCommandBuilder: class {
    setName() { return this; }
    setType() { return this; }
    toJSON() { return {}; }
  },
  EmbedBuilder: class {
    setTitle() { return this; }
    setDescription() { return this; }
    setColor() { return this; }
    setFooter() { return this; }
    setTimestamp() { return this; }
  },
  ButtonBuilder: class {
    setCustomId() { return this; }
    setLabel() { return this; }
    setEmoji() { return this; }
    setStyle() { return this; }
  },
  ActionRowBuilder: class {
    addComponents() { return this; }
  },
  ButtonStyle: {},
  ComponentType: {},
}));

jest.mock('../../db/pool', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => mockQuery(...args) },
}));

jest.mock('../../discord/agents', () => ({
  getAgentByChannelName: jest.fn(),
  getAgent: jest.fn(),
  loadDynamicAgentsFromDb: jest.fn(),
}));
jest.mock('../../discord/handlers/callSession', () => ({
  setVoiceErrorChannel: jest.fn(),
  startCall: jest.fn(),
  endCall: jest.fn(),
  isCallActive: jest.fn(() => false),
  processTesterVoiceTurnForCall: jest.fn(),
}));
jest.mock('../../discord/handlers/documentation', () => ({ setBotChannels: jest.fn() }));
jest.mock('../../discord/handlers/github', () => ({ setGitHubChannel: jest.fn() }));
jest.mock('../../discord/handlers/groupchat', () => ({
  setDecisionsChannel: jest.fn(),
  setThreadStatusChannel: jest.fn(),
  handleDecisionReply: jest.fn(),
  handleGroupchatMessage: jest.fn(),
  dispatchUpgradeToRiley: jest.fn(),
  getThreadStatusOpsLine: jest.fn(),
  startSelfImprovementQueueWorker: jest.fn(),
  stopSelfImprovementQueueWorker: jest.fn(),
}));
jest.mock('../../discord/handlers/review', () => ({ autoReviewPR: jest.fn() }));
jest.mock('../../discord/handlers/textChannel', () => ({ handleAgentMessage: jest.fn() }));
jest.mock('../../discord/memory', () => ({ flushPendingWrites: jest.fn(), initMemory: jest.fn() }));
jest.mock('../../discord/activityLog', () => ({
  flushAllOpsDigests: jest.fn(),
  formatToolAuditHuman: jest.fn(),
  postOpsLine: (...args: any[]) => mockPostOpsLine(...args),
}));
jest.mock('../../discord/services/agentErrors', () => ({
  setAgentErrorChannel: jest.fn(),
  postAgentErrorLog: (...args: any[]) => mockPostAgentErrorLog(...args),
}));
jest.mock('../../discord/services/modelHealthCheck', () => ({ runModelHealthChecks: jest.fn() }));
jest.mock('../../discord/services/screenshots', () => ({ setScreenshotsChannel: jest.fn() }));
jest.mock('../../discord/services/telephony', () => ({
  setTelephonyChannels: jest.fn(),
  isTelephonyAvailable: jest.fn(() => false),
  initContacts: jest.fn(),
}));
jest.mock('../../discord/setup', () => ({ setupChannels: jest.fn() }));
jest.mock('../../discord/tools', () => ({
  setCommandAuditCallback: jest.fn(),
  setPRReviewCallback: jest.fn(),
  setSmokeTestCallback: jest.fn(),
  smokeTestAgents: jest.fn(),
  setDiscordGuild: jest.fn(),
  setToolAuditCallback: jest.fn(),
  setAgentChannelResolver: jest.fn(),
}));
jest.mock('../../discord/usage', () => ({
  setLimitsChannel: jest.fn(),
  setCostChannel: jest.fn(),
  startDashboardUpdates: jest.fn(),
  stopDashboardUpdates: jest.fn(),
  initUsageCounters: jest.fn(),
  flushUsageCounters: jest.fn(),
  getUsageReport: jest.fn(),
  getCostOpsSummaryLine: jest.fn(),
  refreshUsageDashboard: jest.fn(),
  toAgentTag: jest.fn(),
}));
jest.mock('../../utils/time', () => ({ formatAge: jest.fn(() => '1h') }));
jest.mock('../../discord/tester', () => ({ mapFilesToCategories: jest.fn(), getTestsForCategories: jest.fn() }));
jest.mock('../../discord/vectorMemory', () => ({
  recordAgentDecision: jest.fn(),
  consolidateMemoryInsights: jest.fn(),
  recordSmokeInsight: jest.fn(),
}));
jest.mock('../../discord/handlers/goalState', () => ({ goalState: { isActive: jest.fn(() => false) } }));
jest.mock('../../services/jobSearch', () => ({
  updateListingByMsgId: jest.fn(),
  draftApplication: jest.fn(),
  getProfile: jest.fn(),
  getPortalByCompany: jest.fn(),
  submitToGreenhouse: jest.fn(),
  getListingById: jest.fn(),
  updateListingStatus: jest.fn(),
  setListingDiscordMsg: jest.fn(),
  guessCompanyEmail: jest.fn(),
}));
jest.mock('../../services/email', () => ({ sendJobApplication: jest.fn() }));
jest.mock('../../discord/ui/constants', () => ({ SYSTEM_COLORS: {}, BUTTON_IDS: {}, jobScoreColor: jest.fn() }));
jest.mock('../../utils/errors', () => ({ errMsg: jest.fn((err: unknown) => err instanceof Error ? err.message : String(err)) }));

import { runDatabaseAudit } from '../../discord/bot';

describe('bot runDatabaseAudit', () => {
  const threadStatus = { name: 'thread-status' } as any;
  const channels = { threadStatus } as any;

  function installDatabaseQueryMock(options: {
    appliedMigrations: string[];
    existingTables: string[];
  }) {
    const existing = new Set(options.existingTables);
    mockQuery.mockImplementation(async (sql: string, params?: string[]) => {
      if (sql.includes('SELECT filename FROM applied_migrations')) {
        return { rows: options.appliedMigrations.map((filename) => ({ filename })) };
      }
      if (sql.includes('SELECT to_regclass($1) IS NOT NULL AS exists')) {
        const rawTable = params?.[0] || '';
        const tableName = rawTable.replace(/^public\./, '');
        return { rows: [{ exists: existing.has(tableName) }] };
      }
      throw new Error(`Unexpected query in test: ${sql}`);
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('posts a warn summary when legacy tables remain and drop migration is pending', async () => {
    installDatabaseQueryMock({
      appliedMigrations: ['003_agent_memory.sql', '015_agent_activity_log.sql'],
      existingTables: ['agent_memory', 'agent_activity_log', 'self_improvement_jobs', 'agent_learnings', 'user_events', 'decisions', 'employees', 'clients'],
    });

    await runDatabaseAudit(channels);

    expect(mockPostOpsLine).toHaveBeenCalledWith(threadStatus, expect.objectContaining({
      actor: 'operations-manager',
      scope: 'database-audit',
      severity: 'warn',
      action: 'review legacy-drop migration status',
    }));
    expect(mockPostAgentErrorLog).not.toHaveBeenCalled();
  });

  it('posts an error log when required runtime tables are missing', async () => {
    installDatabaseQueryMock({
      appliedMigrations: ['003_agent_memory.sql'],
      existingTables: ['agent_memory'],
    });

    await runDatabaseAudit(channels);

    expect(mockPostOpsLine).toHaveBeenCalledWith(threadStatus, expect.objectContaining({
      scope: 'database-audit',
      severity: 'error',
    }));
    expect(mockPostAgentErrorLog).toHaveBeenCalledWith(
      'discord:db-audit',
      'Database audit found missing runtime tables',
      expect.objectContaining({ level: 'warn' }),
    );
  });
});