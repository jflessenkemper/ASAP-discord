/**
 * ASAP Agent Smoke Test Suite
 *
 * Sends @mention prompts to each agent through 💬-groupchat and waits for a
 * bot/webhook reply in that same channel.  Uses ASAPTester bot.
 *
 * Usage:
 *   npm run discord:test:dist                        # run all agents
 *   npm run discord:test:dist -- --agent=developer   # run one agent
 *
 * Env vars:
 *   DISCORD_TEST_BOT_TOKEN  required
 *   DISCORD_GUILD_ID        required
 *   DISCORD_TEST_TIMEOUT_MS optional (default 90000 ms per agent)
 *   DISCORD_GROUPCHAT_ID    optional — override groupchat channel ID lookup
 *   DISCORD_SMOKE_PRE_CLEAR optional (default true) — clear message history in text/news/thread channels before each smoke run
 *   DISCORD_SMOKE_PRE_CLEAR_MAX_MS optional (default 600000) — abort pre-clear if elapsed time exceeds this limit
 *   DISCORD_SMOKE_PRE_CLEAR_PER_CHANNEL_MAX optional (default 500) — max messages deleted per channel during pre-clear
 */
import 'dotenv/config';
import { ChannelType, Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { getAgent, resolveAgentId } from './agents';

interface AgentTestCase {
  id: string;
  prompt: string;
}

interface TestResult {
  agent: string;
  passed: boolean;
  elapsed: number;
  snippet: string;
}

interface CleanupStats {
  channelName: string;
  deleted: number;
  failed: number;
  timedOut: boolean;
}

const AGENT_TESTS: AgentTestCase[] = [
  {
    id: 'executive-assistant',
    prompt: 'What is your primary role on this team? Reply in 1–2 sentences.',
  },
  {
    id: 'developer',
    prompt: 'What programming language does the ASAP mobile app use? Reply in 1 sentence.',
  },
  {
    id: 'qa',
    prompt: 'Name one critical test case for a job-matching feature. Reply in 1 sentence.',
  },
  {
    id: 'ux-reviewer',
    prompt: 'What is the most important UX principle for a gig economy mobile app? Reply in 1 sentence.',
  },
  {
    id: 'security-auditor',
    prompt: 'What is the most common authentication vulnerability in mobile apps? Reply in 1 sentence.',
  },
  {
    id: 'api-reviewer',
    prompt: 'What HTTP status code should a REST API return when a resource is not found? Reply in 1 sentence.',
  },
  {
    id: 'dba',
    prompt: 'What database does this project use? Reply in 1 sentence.',
  },
  {
    id: 'performance',
    prompt: 'What is the single most impactful performance optimisation for a React Native app? Reply in 1 sentence.',
  },
  {
    id: 'devops',
    prompt: 'What CI/CD platform does this project use? Reply in 1 sentence.',
  },
  {
    id: 'copywriter',
    prompt: 'Write a 5-word tagline for the ASAP gig worker app.',
  },
  {
    id: 'lawyer',
    prompt: 'What is the key legal distinction between an employee and a contractor in Australia? Reply in 1 sentence.',
  },
  {
    id: 'ios-engineer',
    prompt: 'What is the primary programming language for iOS development? Reply in 1 sentence.',
  },
  {
    id: 'android-engineer',
    prompt: 'What is the primary programming language for Android development? Reply in 1 sentence.',
  },
];

function getAgentName(id: string): string {
  return getAgent(id as never)?.name || id;
}

function buildPrompt(test: AgentTestCase, roleMentions: Map<string, string>): string {
  const agent = getAgent(test.id as never);
  const mention = roleMentions.get(test.id) || `@${agent?.handle || test.id}`;
  return `${mention} [smoke test] ${test.prompt}`;
}

function findGroupchat(guild: { channels: { cache: Map<string, any> } }): TextChannel | undefined {
  const overrideId = process.env.DISCORD_GROUPCHAT_ID;
  if (overrideId) {
    const ch = guild.channels.cache.get(overrideId);
    if (ch?.type === ChannelType.GuildText) return ch as TextChannel;
  }
  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildText && (ch.name as string).includes('groupchat')) {
      return ch as TextChannel;
    }
  }
  return undefined;
}

function shouldPreClear(): boolean {
  const raw = String(process.env.DISCORD_SMOKE_PRE_CLEAR ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPreClearMaxMs(): number {
  const value = Number(process.env.DISCORD_SMOKE_PRE_CLEAR_MAX_MS ?? '600000');
  if (!Number.isFinite(value) || value <= 0) return 600000;
  return Math.min(Math.max(60_000, Math.floor(value)), 3_600_000);
}

function getPerChannelDeleteCap(): number {
  const value = Number(process.env.DISCORD_SMOKE_PRE_CLEAR_PER_CHANNEL_MAX ?? '500');
  if (!Number.isFinite(value) || value <= 0) return 500;
  return Math.min(Math.max(50, Math.floor(value)), 5_000);
}

async function discordApi(token: string, url: string, options: RequestInit = {}, retry = 0): Promise<Response> {
  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const res = await fetch(url, { ...options, headers });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({})) as { retry_after?: number };
    const retryMs = Math.ceil((Number(body.retry_after) || 1) * 1000) + 100;
    await sleep(retryMs);
    if (retry < 8) return discordApi(token, url, options, retry + 1);
  }
  return res;
}

async function preClearGuildChannels(token: string, guildId: string): Promise<CleanupStats[]> {
  const startedAt = Date.now();
  const maxElapsedMs = getPreClearMaxMs();
  const perChannelCap = getPerChannelDeleteCap();
  const channelRes = await discordApi(token, `https://discord.com/api/v10/guilds/${guildId}/channels`);
  if (!channelRes.ok) {
    throw new Error(`Failed to list guild channels: ${channelRes.status}`);
  }

  const channels = await channelRes.json() as Array<{ id: string; name: string; type: number }>;
  const messageChannels = channels.filter((channel) => [0, 5, 10, 11, 12].includes(channel.type));
  const results: CleanupStats[] = [];

  for (const channel of messageChannels) {
    if (Date.now() - startedAt > maxElapsedMs) {
      results.push({ channelName: channel.name, deleted: 0, failed: 0, timedOut: true });
      continue;
    }

    let deleted = 0;
    let failed = 0;
    let timedOut = false;
    let before: string | undefined;

    while (true) {
      if (Date.now() - startedAt > maxElapsedMs) {
        timedOut = true;
        break;
      }
      if (deleted >= perChannelCap) {
        break;
      }

      const qs = new URLSearchParams({ limit: '100' });
      if (before) qs.set('before', before);

      const listRes = await discordApi(token, `https://discord.com/api/v10/channels/${channel.id}/messages?${qs.toString()}`);
      if (!listRes.ok) {
        failed += 1;
        break;
      }

      const messages = await listRes.json() as Array<{ id: string }>;
      if (!Array.isArray(messages) || messages.length === 0) break;

      for (const msg of messages) {
        if (Date.now() - startedAt > maxElapsedMs) {
          timedOut = true;
          break;
        }
        if (deleted >= perChannelCap) {
          break;
        }

        const delRes = await discordApi(token, `https://discord.com/api/v10/channels/${channel.id}/messages/${msg.id}`, { method: 'DELETE' });
        if (delRes.status === 204 || delRes.status === 200 || delRes.status === 404) {
          deleted += 1;
        } else {
          failed += 1;
        }
        await sleep(120);
      }

      before = messages[messages.length - 1]?.id;
      await sleep(200);

      if (deleted >= perChannelCap || timedOut) {
        break;
      }
    }

    results.push({ channelName: channel.name, deleted, failed, timedOut });
  }

  return results;
}

/** Returns true if the message is a bot/webhook reply (not our own sent message). */
function isBotOrWebhookReply(msg: Message, sent: Message, selfId: string): boolean {
  if (msg.id === sent.id) return false;
  if (msg.createdTimestamp < sent.createdTimestamp) return false;
  if (msg.author.id === selfId) return false;
  return msg.author.bot || !!msg.webhookId;
}

async function testAgent(
  channel: TextChannel,
  test: AgentTestCase,
  selfId: string,
  timeoutMs: number,
  roleMentions: Map<string, string>,
): Promise<{ passed: boolean; elapsed: number; snippet: string }> {
  const start = Date.now();

  return new Promise(async (resolve) => {
    let sent: Message;
    try {
      sent = await Promise.race([
        channel.send(buildPrompt(test, roleMentions)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Send timed out')), Math.min(timeoutMs, 15000))),
      ]);
    } catch (err) {
      resolve({
        passed: false,
        elapsed: Date.now() - start,
        snippet: `Send failed: ${err instanceof Error ? err.message : err}`,
      });
      return;
    }

    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        collector.stop('timeout');
      }
    }, timeoutMs);

    const collector = channel.createMessageCollector({ time: timeoutMs + 2000 });

    collector.on('collect', (msg) => {
      if (!isBotOrWebhookReply(msg, sent, selfId)) return;
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      collector.stop('matched');

      const snippet =
        msg.content?.slice(0, 300) ||
        msg.embeds[0]?.description?.slice(0, 300) ||
        msg.embeds[0]?.title ||
        '(response received — enable MessageContent privileged intent for preview)';

      resolve({ passed: true, elapsed: Date.now() - start, snippet });
    });

    collector.on('end', (_, reason) => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        resolve({
          passed: false,
          elapsed: Date.now() - start,
          snippet: 'Timeout — no bot/webhook response received',
        });
      }
    });
  });
}

async function run(): Promise<void> {
  const token = process.env.DISCORD_TEST_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  const timeoutMs = Number(process.env.DISCORD_TEST_TIMEOUT_MS ?? '90000');
  const preClear = shouldPreClear();
  const agentFilter = process.argv.find((a) => a.startsWith('--agent='))?.slice('--agent='.length);

  if (!token) throw new Error('Missing DISCORD_TEST_BOT_TOKEN');
  if (!guildId) throw new Error('Missing DISCORD_GUILD_ID');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid DISCORD_TEST_TIMEOUT_MS');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    void client.login(token).catch(reject);
  });

  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();
  await guild.roles.fetch();

  if (preClear) {
    console.log('🧹 Pre-smoke cleanup: clearing messages from text/news/thread channels...');
    const cleanup = await preClearGuildChannels(token, guildId);
    const totalDeleted = cleanup.reduce((sum, row) => sum + row.deleted, 0);
    const failures = cleanup.filter((row) => row.failed > 0).length;
    const timedOut = cleanup.filter((row) => row.timedOut).length;
    console.log(`🧹 Cleanup done: channels=${cleanup.length} deleted=${totalDeleted} failed_channels=${failures} timeout_channels=${timedOut}`);
  }

  const groupchat = findGroupchat(guild);
  if (!groupchat) {
    console.error('FATAL: Could not find 💬-groupchat channel. Set DISCORD_GROUPCHAT_ID env var.');
    await client.destroy();
    process.exit(1);
  }

  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║    ASAP Agent Smoke Test Suite       ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`Guild    : ${guild.name}`);
  console.log(`Channel  : #${groupchat.name} (${groupchat.id})`);
  console.log(`Timeout  : ${timeoutMs / 1000}s per agent`);
  console.log(`Pre-clear: ${preClear ? 'enabled' : 'disabled'}`);
  if (agentFilter) console.log(`Filter   : --agent=${agentFilter}`);
  console.log('');

  const roleMentions = new Map<string, string>();
  for (const test of AGENT_TESTS) {
    const agent = getAgent(test.id as never);
    if (!agent) continue;
    const role = guild.roles.cache.find((candidate) => candidate.name === agent.roleName);
    if (role) roleMentions.set(test.id, `<@&${role.id}>`);
  }

  const testsToRun = agentFilter
    ? AGENT_TESTS.filter(
        (t) =>
          t.id === agentFilter ||
          resolveAgentId(agentFilter || '') === t.id ||
          getAgentName(t.id).toLowerCase().includes(agentFilter.toLowerCase()),
      )
    : AGENT_TESTS;

  if (testsToRun.length === 0) {
    console.error(`No agents matched filter: ${agentFilter}`);
    await client.destroy();
    process.exit(1);
  }

  const results: TestResult[] = [];

  for (const test of testsToRun) {
    process.stdout.write(`⏳  ${getAgentName(test.id)} ... `);

    const { passed, elapsed, snippet } = await testAgent(groupchat, test, client.user!.id, timeoutMs, roleMentions);

    if (passed) {
      console.log(`✅ PASS (${(elapsed / 1000).toFixed(1)}s)`);
    } else {
      console.log(`❌ FAIL (${(elapsed / 1000).toFixed(1)}s)`);
    }
    console.log(`   → ${snippet}`);

    results.push({ agent: getAgentName(test.id), passed, elapsed, snippet });

    await new Promise((r) => setTimeout(r, 3000));
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('\n══════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════');
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`${icon}  ${r.agent}`);
  }

  await client.destroy();
  process.exit(failed > 0 ? 1 : 0);
}

void run().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
