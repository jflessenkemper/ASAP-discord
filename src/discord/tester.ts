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
 */
import 'dotenv/config';
import { ChannelType, Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';

interface AgentTestCase {
  id: string;
  /** Mention handle used in the groupchat message (maps to NAME_TO_ID in groupchat handler) */
  mention: string;
  name: string;
  prompt: string;
}

interface TestResult {
  agent: string;
  passed: boolean;
  elapsed: number;
  snippet: string;
}

const AGENT_TESTS: AgentTestCase[] = [
  {
    id: 'executive-assistant',
    mention: 'riley',
    name: 'Riley (Executive Assistant)',
    prompt: '@riley [smoke test] What is your primary role on this team? Reply in 1–2 sentences.',
  },
  {
    id: 'developer',
    mention: 'ace',
    name: 'Ace (Developer)',
    prompt: '@ace [smoke test] What programming language does the ASAP mobile app use? Reply in 1 sentence.',
  },
  {
    id: 'qa',
    mention: 'max',
    name: 'Max (QA)',
    prompt: '@max [smoke test] Name one critical test case for a job-matching feature. Reply in 1 sentence.',
  },
  {
    id: 'ux-reviewer',
    mention: 'sophie',
    name: 'Sophie (UX Reviewer)',
    prompt: '@sophie [smoke test] What is the most important UX principle for a gig economy mobile app? Reply in 1 sentence.',
  },
  {
    id: 'security-auditor',
    mention: 'kane',
    name: 'Kane (Security Auditor)',
    prompt: '@kane [smoke test] What is the most common authentication vulnerability in mobile apps? Reply in 1 sentence.',
  },
  {
    id: 'api-reviewer',
    mention: 'raj',
    name: 'Raj (API Reviewer)',
    prompt: '@raj [smoke test] What HTTP status code should a REST API return when a resource is not found? Reply in 1 sentence.',
  },
  {
    id: 'dba',
    mention: 'elena',
    name: 'Elena (DBA)',
    prompt: '@elena [smoke test] What database does this project use? Reply in 1 sentence.',
  },
  {
    id: 'performance',
    mention: 'kai',
    name: 'Kai (Performance)',
    prompt: '@kai [smoke test] What is the single most impactful performance optimisation for a React Native app? Reply in 1 sentence.',
  },
  {
    id: 'devops',
    mention: 'jude',
    name: 'Jude (DevOps)',
    prompt: '@jude [smoke test] What CI/CD platform does this project use? Reply in 1 sentence.',
  },
  {
    id: 'copywriter',
    mention: 'liv',
    name: 'Liv (Copywriter)',
    prompt: '@liv [smoke test] Write a 5-word tagline for the ASAP gig worker app.',
  },
  {
    id: 'lawyer',
    mention: 'harper',
    name: 'Harper (Lawyer)',
    prompt: '@harper [smoke test] What is the key legal distinction between an employee and a contractor in Australia? Reply in 1 sentence.',
  },
  {
    id: 'ios-engineer',
    mention: 'mia',
    name: 'Mia (iOS Engineer)',
    prompt: '@mia [smoke test] What is the primary programming language for iOS development? Reply in 1 sentence.',
  },
  {
    id: 'android-engineer',
    mention: 'leo',
    name: 'Leo (Android Engineer)',
    prompt: '@leo [smoke test] What is the primary programming language for Android development? Reply in 1 sentence.',
  },
];

function findGroupchat(guild: { channels: { cache: Map<string, any> } }): TextChannel | undefined {
  // Allow explicit override via env var
  const overrideId = process.env.DISCORD_GROUPCHAT_ID;
  if (overrideId) {
    const ch = guild.channels.cache.get(overrideId);
    if (ch?.type === ChannelType.GuildText) return ch as TextChannel;
  }
  // Fall back to name match
  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildText && (ch.name as string).includes('groupchat')) {
      return ch as TextChannel;
    }
  }
  return undefined;
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
): Promise<{ passed: boolean; elapsed: number; snippet: string }> {
  const start = Date.now();

  return new Promise(async (resolve) => {
    let sent: Message;
    try {
      sent = await channel.send(test.prompt);
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

      // Content may be empty without the MessageContent privileged intent.
      // Agent webhook messages still populate content; fallback to embed description.
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
  if (agentFilter) console.log(`Filter   : --agent=${agentFilter}`);
  console.log('');

  const testsToRun = agentFilter
    ? AGENT_TESTS.filter(
        (t) =>
          t.id === agentFilter ||
          t.mention === agentFilter ||
          t.name.toLowerCase().includes(agentFilter.toLowerCase()),
      )
    : AGENT_TESTS;

  if (testsToRun.length === 0) {
    console.error(`No agents matched filter: ${agentFilter}`);
    await client.destroy();
    process.exit(1);
  }

  const results: TestResult[] = [];

  for (const test of testsToRun) {
    process.stdout.write(`⏳  ${test.name} ... `);

    const { passed, elapsed, snippet } = await testAgent(groupchat, test, client.user!.id, timeoutMs);

    if (passed) {
      console.log(`✅ PASS (${(elapsed / 1000).toFixed(1)}s)`);
    } else {
      console.log(`❌ FAIL (${(elapsed / 1000).toFixed(1)}s)`);
    }
    console.log(`   → ${snippet}`);

    results.push({ agent: test.name, passed, elapsed, snippet });

    // Pause between agents to let the bot finish its response
    await new Promise((r) => setTimeout(r, 3000));
  }

  // ── Summary ────────────────────────────────────────────
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
