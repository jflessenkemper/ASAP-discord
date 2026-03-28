/**
 * ASAP Agent Smoke Test Suite
 *
 * Sends a domain-specific prompt to each of the 13 agent channels and waits
 * for a bot/webhook reply.  Uses ASAPTester bot (DISCORD_TEST_BOT_TOKEN).
 *
 * Usage:
 *   npm run discord:test:dist                        # run all agents
 *   npm run discord:test:dist -- --agent=developer   # run one agent
 *
 * Env vars:
 *   DISCORD_TEST_BOT_TOKEN  required
 *   DISCORD_GUILD_ID        required
 *   DISCORD_TEST_TIMEOUT_MS optional (default 60000 ms per agent)
 */
import 'dotenv/config';
import { ChannelType, Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';

interface AgentTestCase {
  id: string;
  /** Channel name suffix after the emoji, e.g. "qa", "ux-reviewer" */
  slug: string;
  name: string;
  prompt: string;
}

interface TestResult {
  agent: string;
  passed: boolean;
  elapsed: number;
  snippet: string;
  skipped?: boolean;
}

const AGENT_TESTS: AgentTestCase[] = [
  {
    id: 'executive-assistant',
    slug: 'executive-assistant',
    name: 'Riley (Executive Assistant)',
    prompt: '[ASAPTester smoke test] What is your primary role on this team? Reply in 1–2 sentences.',
  },
  {
    id: 'developer',
    slug: 'developer',
    name: 'Ace (Developer)',
    prompt: '[ASAPTester smoke test] What programming language does the ASAP mobile app use? Reply in 1 sentence.',
  },
  {
    id: 'qa',
    slug: 'qa',
    name: 'Max (QA)',
    prompt: '[ASAPTester smoke test] Name one critical test case for a job-matching feature. Reply in 1 sentence.',
  },
  {
    id: 'ux-reviewer',
    slug: 'ux-reviewer',
    name: 'Sophie (UX Reviewer)',
    prompt: '[ASAPTester smoke test] What is the most important UX principle for a gig economy mobile app? Reply in 1 sentence.',
  },
  {
    id: 'security-auditor',
    slug: 'security-auditor',
    name: 'Kane (Security Auditor)',
    prompt: '[ASAPTester smoke test] What is the most common authentication vulnerability in mobile apps? Reply in 1 sentence.',
  },
  {
    id: 'api-reviewer',
    slug: 'api-reviewer',
    name: 'Raj (API Reviewer)',
    prompt: '[ASAPTester smoke test] What HTTP status code should a REST API return when a resource is not found? Reply in 1 sentence.',
  },
  {
    id: 'dba',
    slug: 'dba',
    name: 'Elena (DBA)',
    prompt: '[ASAPTester smoke test] What database does this project use? Reply in 1 sentence.',
  },
  {
    id: 'performance',
    slug: 'performance',
    name: 'Kai (Performance)',
    prompt: '[ASAPTester smoke test] What is the single most impactful performance optimisation for a React Native app? Reply in 1 sentence.',
  },
  {
    id: 'devops',
    slug: 'devops',
    name: 'Jude (DevOps)',
    prompt: '[ASAPTester smoke test] What CI/CD platform does this project use? Reply in 1 sentence.',
  },
  {
    id: 'copywriter',
    slug: 'copywriter',
    name: 'Liv (Copywriter)',
    prompt: '[ASAPTester smoke test] Write a 5-word tagline for the ASAP gig worker app.',
  },
  {
    id: 'lawyer',
    slug: 'lawyer',
    name: 'Harper (Lawyer)',
    prompt: '[ASAPTester smoke test] What is the key legal distinction between an employee and a contractor in Australia? Reply in 1 sentence.',
  },
  {
    id: 'ios-engineer',
    slug: 'ios-engineer',
    name: 'Mia (iOS Engineer)',
    prompt: '[ASAPTester smoke test] What is the primary programming language for iOS development? Reply in 1 sentence.',
  },
  {
    id: 'android-engineer',
    slug: 'android-engineer',
    name: 'Leo (Android Engineer)',
    prompt: '[ASAPTester smoke test] What is the primary programming language for Android development? Reply in 1 sentence.',
  },
];

function findChannelBySlug(guild: { channels: { cache: Map<string, any> } }, slug: string): TextChannel | undefined {
  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildText && (ch.name as string).endsWith(slug)) {
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
  const timeoutMs = Number(process.env.DISCORD_TEST_TIMEOUT_MS ?? '60000');
  const agentFilter = process.argv.find((a) => a.startsWith('--agent='))?.slice('--agent='.length);

  if (!token) throw new Error('Missing DISCORD_TEST_BOT_TOKEN');
  if (!guildId) throw new Error('Missing DISCORD_GUILD_ID');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid DISCORD_TEST_TIMEOUT_MS');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    void client.login(token).catch(reject);
  });

  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();

  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║    ASAP Agent Smoke Test Suite       ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`Guild  : ${guild.name}`);
  console.log(`Timeout: ${timeoutMs / 1000}s per agent`);
  if (agentFilter) console.log(`Filter : --agent=${agentFilter}`);
  console.log('');

  const testsToRun = agentFilter
    ? AGENT_TESTS.filter(
        (t) =>
          t.id === agentFilter ||
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
    const channel = findChannelBySlug(guild, test.slug);

    if (!channel) {
      console.log(`⚠️  SKIP  ${test.name} — no channel ending in '${test.slug}'`);
      results.push({ agent: test.name, passed: false, elapsed: 0, snippet: 'Channel not found', skipped: true });
      continue;
    }

    process.stdout.write(`⏳  ${test.name} (#${channel.name}) ... `);

    const { passed, elapsed, snippet } = await testAgent(channel, test, client.user!.id, timeoutMs);

    if (passed) {
      console.log(`✅ PASS (${(elapsed / 1000).toFixed(1)}s)`);
    } else {
      console.log(`❌ FAIL (${(elapsed / 1000).toFixed(1)}s)`);
    }
    console.log(`   → ${snippet}`);

    results.push({ agent: test.name, passed, elapsed, snippet });

    // Small pause between agents to avoid flooding
    await new Promise((r) => setTimeout(r, 1500));
  }

  // ── Summary ────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.passed && !r.skipped).length;

  console.log('\n══════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('══════════════════════════════════════');
  for (const r of results) {
    const icon = r.passed ? '✅' : r.skipped ? '⚠️ ' : '❌';
    console.log(`${icon}  ${r.agent}`);
  }

  await client.destroy();
  process.exit(failed > 0 ? 1 : 0);
}

void run().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
