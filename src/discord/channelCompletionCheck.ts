import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import { Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';

import { getAgents } from './agents';

type AttemptResult = {
  ok: boolean;
  reason?: string;
  length?: number;
  sample?: string;
  elapsedMs: number;
};

type AgentResult = {
  id: string;
  name: string;
  channel: string;
  ok: boolean;
  attempts: AttemptResult[];
};

type RunOptions = {
  agentFilter: Set<string> | null;
  batchSize: number;
  timeoutMs: number;
  retries: number;
  interAgentStaggerMs: number;
  retryBaseDelayMs: number;
  retryJitterMs: number;
  interBatchDelayMs: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseListArg(name: string): Set<string> | null {
  const arg = process.argv.find((a) => a.startsWith(`${name}=`));
  if (!arg) return null;
  const raw = arg.slice(name.length + 1).trim();
  if (!raw) return null;
  const values = raw.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  return values.length ? new Set(values) : null;
}

function parseNumberArg(name: string, fallback: number, min: number, max: number): number {
  const arg = process.argv.find((a) => a.startsWith(`${name}=`));
  if (!arg) return fallback;
  const raw = Number(arg.slice(name.length + 1));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

function loadOptions(): RunOptions {
  return {
    agentFilter: parseListArg('--agents'),
    batchSize: parseNumberArg('--batch-size', 4, 1, 13),
    timeoutMs: parseNumberArg('--timeout-ms', 300000, 10000, 600000),
    retries: parseNumberArg('--retries', 2, 1, 5),
    interAgentStaggerMs: parseNumberArg('--inter-agent-stagger-ms', 700, 0, 10000),
    retryBaseDelayMs: parseNumberArg('--retry-base-delay-ms', 1500, 0, 60000),
    retryJitterMs: parseNumberArg('--retry-jitter-ms', 1000, 0, 60000),
    interBatchDelayMs: parseNumberArg('--inter-batch-delay-ms', 3000, 0, 60000),
  };
}

function jitter(maxMs: number): number {
  if (!Number.isFinite(maxMs) || maxMs <= 0) return 0;
  return Math.floor(Math.random() * maxMs);
}

function extractText(msg: Message): string {
  const content = msg.content || '';
  const embedText = msg.embeds?.[0]?.description || msg.embeds?.[0]?.title || '';
  return `${content}${embedText ? `\n${embedText}` : ''}`.trim();
}

function isProgressPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  if (/^Thinking…$/i.test(trimmed)) return true;
  if (/^⏳\s+.+still working/i.test(trimmed)) return true;
  return false;
}

async function waitForTokenReply(
  channel: TextChannel,
  sentId: string,
  selfId: string,
  token: string,
  timeoutMs: number
): Promise<AttemptResult> {
  const started = Date.now();
  let latestCandidate = '';

  while (Date.now() - started < timeoutMs) {
    const recent = await channel.messages.fetch({ limit: 60, after: sentId }).catch(() => null);
    if (recent) {
      const ordered = [...recent.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const msg of ordered) {
        if (msg.author.id === selfId) continue;
        if (!(msg.webhookId || msg.author.bot)) continue;
        const text = extractText(msg);
        if (!text || isProgressPlaceholder(text)) continue;

        latestCandidate = text;
        if (text.includes(`TOKEN:${token}`)) {
          return {
            ok: true,
            length: text.length,
            sample: text.slice(0, 700),
            elapsedMs: Date.now() - started,
          };
        }
      }
    }
    await sleep(2200);
  }

  if (latestCandidate) {
    return {
      ok: false,
      reason: 'Final reply observed but completion token missing',
      length: latestCandidate.length,
      sample: latestCandidate.slice(0, 700),
      elapsedMs: Date.now() - started,
    };
  }

  return {
    ok: false,
    reason: `No final bot/webhook reply within ${Math.round(timeoutMs / 1000)}s`,
    elapsedMs: Date.now() - started,
  };
}

function buildPrompt(agentId: string, runToken: string): string {
  return [
    `[channel-completion-check:${agentId}]`,
    'Please reply with two substantial paragraphs (at least 900 characters total) about your role and one concrete improvement for ASAP.',
    `End your final line with exactly: TOKEN:${runToken}`,
    'Do not omit the token.',
  ].join(' ');
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function shouldIncludeAgent(id: string, name: string, filter: Set<string> | null): boolean {
  if (!filter) return true;
  const normalizedName = name.toLowerCase();
  if (filter.has(id.toLowerCase())) return true;
  for (const token of filter) {
    if (normalizedName.includes(token)) return true;
  }
  return false;
}

function ensureReportsDir(): string {
  const dir = path.join(process.cwd(), 'smoke-reports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeReport(payload: Record<string, unknown>): { latest: string; stamped: string } {
  const dir = ensureReportsDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const latest = path.join(dir, 'agent-channel-completion-check-latest.json');
  const stamped = path.join(dir, `agent-channel-completion-check-${stamp}.json`);
  const text = JSON.stringify(payload, null, 2);
  fs.writeFileSync(latest, text, 'utf-8');
  fs.writeFileSync(stamped, text, 'utf-8');
  return { latest, stamped };
}

async function runAttempt(
  channel: TextChannel,
  selfId: string,
  agentId: string,
  timeoutMs: number
): Promise<AttemptResult> {
  const runToken = `${agentId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase()}${Date.now().toString().slice(-6)}`;
  const sent = await channel.send(buildPrompt(agentId, runToken));
  return waitForTokenReply(channel, sent.id, selfId, runToken, timeoutMs);
}

async function main(): Promise<void> {
  const options = loadOptions();
  const token = process.env.DISCORD_TEST_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token) throw new Error('Missing DISCORD_TEST_BOT_TOKEN');
  if (!guildId) throw new Error('Missing DISCORD_GUILD_ID');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    void client.login(token).catch(reject);
  });

  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch();

  const selectedAgents = [...getAgents().values()].filter((agent) =>
    shouldIncludeAgent(agent.id, agent.name, options.agentFilter)
  );

  if (selectedAgents.length === 0) {
    await client.destroy();
    throw new Error('No agents matched selection.');
  }

  console.log(
    `Channel completion check: agents=${selectedAgents.length} batchSize=${options.batchSize} timeout=${Math.round(options.timeoutMs / 1000)}s retries=${options.retries} stagger=${options.interAgentStaggerMs}ms retryJitter=${options.retryJitterMs}ms`
  );

  const results: AgentResult[] = [];
  const batches = chunk(selectedAgents, options.batchSize);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    console.log(`\nBatch ${batchIndex + 1}/${batches.length}: ${batch.map((a) => a.id).join(', ')}`);

    const batchResults = await Promise.all(batch.map(async (agent, index): Promise<AgentResult> => {
      if (index > 0 && options.interAgentStaggerMs > 0) {
        await sleep(options.interAgentStaggerMs * index + jitter(Math.max(250, options.interAgentStaggerMs)));
      }

      const channel = guild.channels.cache.find(
        (c) => c.isTextBased() && c.type === 0 && c.name === agent.channelName
      ) as TextChannel | undefined;

      if (!channel) {
        return {
          id: agent.id,
          name: agent.name,
          channel: agent.channelName,
          ok: false,
          attempts: [{ ok: false, reason: 'Channel not found', elapsedMs: 0 }],
        };
      }

      const attempts: AttemptResult[] = [];
      for (let attempt = 1; attempt <= options.retries; attempt += 1) {
        const result = await runAttempt(channel, client.user!.id, agent.id, options.timeoutMs);
        attempts.push(result);
        if (result.ok) break;
        const backoff = options.retryBaseDelayMs * attempt + jitter(options.retryJitterMs);
        if (backoff > 0) await sleep(backoff);
      }

      const ok = attempts.some((a) => a.ok);
      return {
        id: agent.id,
        name: agent.name,
        channel: channel.name,
        ok,
        attempts,
      };
    }));

    for (const row of batchResults) {
      const final = row.attempts[row.attempts.length - 1];
      const status = row.ok ? 'PASS' : 'FAIL';
      const reason = row.ok ? '' : ` | ${final.reason || 'unknown'}`;
      const length = final.length ? ` len=${final.length}` : '';
      console.log(`${status} ${row.name} (#${row.channel})${length}${reason}`);
    }

    results.push(...batchResults);

    if (batchIndex < batches.length - 1 && options.interBatchDelayMs > 0) {
      await sleep(options.interBatchDelayMs + jitter(Math.max(300, Math.floor(options.interBatchDelayMs / 2))));
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  console.log('\n=== Channel Completion Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  for (const row of results.filter((r) => !r.ok)) {
    const final = row.attempts[row.attempts.length - 1];
    console.log(`- ${row.id}: ${final.reason || 'unknown'}`);
  }

  const report = {
    ranAt: new Date().toISOString(),
    options,
    passed,
    failed,
    results,
  };
  const reportPaths = writeReport(report);
  console.log(`Report latest: ${reportPaths.latest}`);
  console.log(`Report stamp : ${reportPaths.stamped}`);

  await client.destroy();
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
