/**
 * ASAP Agent Smoke Test Suite (Full Capability Matrix)
 *
 * Validates:
 * - Per-agent capability responses
 * - Tool execution evidence via terminal audit feed
 * - Cross-agent orchestration behavior
 * - Upgrades-channel posting behavior
 * - Repo-memory workflow behavior
 * - Optional ElevenLabs API/TTS + voice-bridge checks
 * - Readiness scoring and report artifacts
 *
 * Usage:
 *   npm run discord:test:dist
 *   npm run discord:test:dist -- --agent=developer
 *
 * Env vars:
 *   DISCORD_TEST_BOT_TOKEN                     required
 *   DISCORD_GUILD_ID                           required
 *   DISCORD_TEST_TIMEOUT_MS                    optional (default 90000)
 *   DISCORD_GROUPCHAT_ID                       optional
 *   DISCORD_SMOKE_PRE_CLEAR                    optional (default true)
 *   DISCORD_SMOKE_PRE_CLEAR_MAX_MS             optional (default 600000)
 *   DISCORD_SMOKE_PRE_CLEAR_PER_CHANNEL_MAX    optional (default 500)
 *   DISCORD_SMOKE_HYGIENE_MAX_MESSAGES         optional (default 8)
 *   DISCORD_SMOKE_ELEVENLABS_CHECK             optional (default true)
 *   DISCORD_SMOKE_ELEVENLABS_TTS               optional (default true)
 *   DISCORD_SMOKE_ELEVENLABS_VOICE_BRIDGE      optional (default true)
 *   DISCORD_SMOKE_VOICE_ACTIVE_CALL            optional (default false)
 *   DISCORD_SMOKE_POST_SUCCESS_RESET_AND_ANNOUNCE optional (default false)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ChannelType, Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { getAgent, resolveAgentId } from './agents';

type CheckPattern = RegExp;
type Category = 'core' | 'specialist' | 'tool-proof' | 'orchestration' | 'upgrades' | 'memory';

interface AgentCapabilityTest {
  id: string;
  category: Category;
  capability: string;
  prompt: string;
  expectAny?: CheckPattern[];
  expectAll?: CheckPattern[];
  requireTokenEcho?: boolean;
  expectToolAudit?: string[];
  expectUpgradesPost?: boolean;
  minBotRepliesAfterPrompt?: number;
}

interface TestResult {
  agent: string;
  capability: string;
  category: Category;
  passed: boolean;
  elapsed: number;
  snippet: string;
  reason?: string;
}

interface CleanupStats {
  channelName: string;
  deleted: number;
  failed: number;
  timedOut: boolean;
}

interface ExtraCheckResult {
  name: string;
  passed: boolean;
  detail: string;
  critical: boolean;
}

const AGENT_CAPABILITY_TESTS: AgentCapabilityTest[] = [
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'routing-and-next-step',
    prompt: 'Summarize your role in one sentence and give one concrete next step.',
    expectAll: [/next step|first step|action/i],
    requireTokenEcho: false,
  },
  {
    id: 'executive-assistant',
    category: 'memory',
    capability: 'repo-memory-tool-awareness',
    prompt: 'Name the two tools you should use to index and search repo memory before broad file scans.',
    expectAll: [/repo_memory_index/i, /repo_memory_search/i],
  },
  {
    id: 'executive-assistant',
    category: 'orchestration',
    capability: 'delegate-ace-qa',
    prompt: 'Briefly delegate a code task to Ace and a validation task to QA in your reply.',
    expectAny: [/ace|developer/i, /qa|max/i],
    minBotRepliesAfterPrompt: 2,
  },
  {
    id: 'executive-assistant',
    category: 'memory',
    capability: 'repo-memory-evidence',
    prompt: 'Run repo_memory_index and repo_memory_search for setupChannels, then reply with one source key.',
    expectAny: [/setupchannels|server\/src\//i],
    expectToolAudit: ['repo_memory_index', 'repo_memory_search'],
  },

  {
    id: 'developer',
    category: 'core',
    capability: 'evidence-format-contract',
    prompt: 'Return exactly this structure with concrete placeholders: Result: ... Evidence: ... Risk/Follow-up: ...',
    expectAll: [/result:/i, /evidence:/i, /risk\/follow-up:/i],
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'tool-audit-proof',
    prompt: 'Use read_file on server/package.json and search_files for quality script, then summarize in one line.',
    expectAny: [/quality|typecheck|lint|jest/i],
    expectToolAudit: ['read_file', 'search_files'],
  },
  {
    id: 'developer',
    category: 'upgrades',
    capability: 'upgrades-post',
    prompt: 'Post one blocker-removal or token-saving improvement line in #upgrades and include the token exactly.',
    expectUpgradesPost: true,
  },

  {
    id: 'qa',
    category: 'specialist',
    capability: 'regression-test-design',
    prompt: 'Provide one high-risk regression test for jobs matching in one sentence.',
    expectAny: [/regression|edge case|negative|timeout|retry/i],
  },
  {
    id: 'qa',
    category: 'tool-proof',
    capability: 'tool-audit-proof',
    prompt: 'Use list_threads and report one readiness signal in one sentence.',
    expectAny: [/thread|ready|active|idle/i],
    expectToolAudit: ['list_threads'],
  },
  {
    id: 'qa',
    category: 'upgrades',
    capability: 'upgrades-post',
    prompt: 'Post one test-automation enhancement in #upgrades and include the token exactly.',
    expectUpgradesPost: true,
  },

  {
    id: 'security-auditor',
    category: 'specialist',
    capability: 'auth-risk-and-mitigation',
    prompt: 'Name one auth vulnerability and one mitigation in one sentence.',
    expectAll: [/auth|token|session|jwt|password/i, /mitigat|prevent|rotate|validate|mfa/i],
  },
  {
    id: 'security-auditor',
    category: 'upgrades',
    capability: 'upgrades-post',
    prompt: 'Post one security-hardening upgrade in #upgrades and include the token exactly.',
    expectUpgradesPost: true,
  },

  {
    id: 'ux-reviewer',
    category: 'specialist',
    capability: 'a11y-priority',
    prompt: 'Name one accessibility requirement to verify first.',
    expectAny: [/contrast|keyboard|screen reader|touch target|wcag|aria/i],
  },
  {
    id: 'api-reviewer',
    category: 'specialist',
    capability: 'http-semantics',
    prompt: 'What status code should be returned for missing resource?',
    expectAny: [/\b404\b/],
  },
  {
    id: 'dba',
    category: 'specialist',
    capability: 'postgres-safety',
    prompt: 'Name one PostgreSQL migration safety practice in one sentence.',
    expectAny: [/transaction|rollback|lock|backfill|index/i],
  },
  {
    id: 'performance',
    category: 'specialist',
    capability: 'measurement',
    prompt: 'Name one metric you would track first for app performance.',
    expectAny: [/latency|fps|memory|p95|p99|lighthouse|ttfb/i],
    requireTokenEcho: false,
  },
  {
    id: 'devops',
    category: 'tool-proof',
    capability: 'tool-audit-proof',
    prompt: 'Use gcp_run_describe and summarize one deployment status signal in one sentence.',
    expectAny: [/cloud run|revision|traffic|ready|service/i],
    expectToolAudit: ['gcp_run_describe'],
  },
  {
    id: 'copywriter',
    category: 'specialist',
    capability: 'microcopy-tone',
    prompt: 'Rewrite "Authentication failed" in a calm, user-friendly sentence.',
    expectAny: [/try again|please|check|couldn|unable/i],
  },
  {
    id: 'lawyer',
    category: 'specialist',
    capability: 'au-contractor-distinction',
    prompt: 'State one legal distinction between employee and contractor in Australia.',
    expectAny: [/control|independent|abn|super|entitlement|contractor/i],
  },
  {
    id: 'ios-engineer',
    category: 'specialist',
    capability: 'ios-stack',
    prompt: 'Name the primary iOS language/framework in one sentence.',
    expectAny: [/swift|swiftui|uikit/i],
  },
  {
    id: 'android-engineer',
    category: 'specialist',
    capability: 'android-stack',
    prompt: 'Name the primary Android language/framework in one sentence.',
    expectAny: [/kotlin|jetpack|compose|gradle/i],
  },
];

function getAgentName(id: string): string {
  return getAgent(id as never)?.name || id;
}

function shouldPreClear(): boolean {
  const raw = String(process.env.DISCORD_SMOKE_PRE_CLEAR ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function shouldRunElevenLabsCheck(): boolean {
  const raw = String(process.env.DISCORD_SMOKE_ELEVENLABS_CHECK ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function shouldRunElevenLabsTtsCheck(): boolean {
  const raw = String(process.env.DISCORD_SMOKE_ELEVENLABS_TTS ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function shouldRunVoiceBridgeCheck(): boolean {
  const raw = String(process.env.DISCORD_SMOKE_ELEVENLABS_VOICE_BRIDGE ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function shouldRunActiveVoiceCallCheck(): boolean {
  const raw = String(process.env.DISCORD_SMOKE_VOICE_ACTIVE_CALL ?? 'false').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function shouldRunPostSuccessResetAndAnnounce(): boolean {
  const raw = String(process.env.DISCORD_SMOKE_POST_SUCCESS_RESET_AND_ANNOUNCE ?? 'false').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
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

function getHygieneMaxMessages(): number {
  const value = Number(process.env.DISCORD_SMOKE_HYGIENE_MAX_MESSAGES ?? '8');
  if (!Number.isFinite(value) || value < 0) return 8;
  return Math.min(Math.max(0, Math.floor(value)), 100);
}

function getCapabilityAttempts(): number {
  const value = Number(process.env.DISCORD_SMOKE_CAPABILITY_ATTEMPTS ?? '2');
  if (!Number.isFinite(value) || value < 1) return 2;
  return Math.min(Math.max(1, Math.floor(value)), 4);
}

function makeToken(agentId: string, capability: string): string {
  const left = agentId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase() || 'AGENT';
  const right = capability.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase() || 'CAP';
  return `SMOKE_${left}_${right}_${Date.now().toString().slice(-6)}`;
}

function buildPrompt(test: AgentCapabilityTest, mention: string, token: string): string {
  return `${mention} [smoke test:${test.capability}] ${test.prompt}\nInclude this exact token in your reply: ${token}`;
}

function extractReplyText(msg: Message): string {
  return (msg.content || msg.embeds[0]?.description || msg.embeds[0]?.title || '').slice(0, 2000);
}

function findTextChannelByNameIncludes(guild: any, needle: string): TextChannel | undefined {
  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildText && String(ch.name || '').toLowerCase().includes(needle.toLowerCase())) {
      return ch as TextChannel;
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (!channelRes.ok) throw new Error(`Failed to list guild channels: ${channelRes.status}`);

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
      if (deleted >= perChannelCap) break;

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
        if (deleted >= perChannelCap) break;

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
      if (deleted >= perChannelCap || timedOut) break;
    }

    results.push({ channelName: channel.name, deleted, failed, timedOut });
  }

  return results;
}

async function assertChannelHygiene(guild: any): Promise<{ passed: boolean; detail: string }> {
  const max = getHygieneMaxMessages();
  const names = ['groupchat', 'terminal', 'upgrades'];
  const lines: string[] = [];
  let passed = true;

  for (const name of names) {
    const ch = findTextChannelByNameIncludes(guild, name);
    if (!ch) {
      lines.push(`${name}:missing`);
      passed = false;
      continue;
    }
    const msgs = await ch.messages.fetch({ limit: Math.min(max + 20, 100) });
    const count = msgs.size;
    lines.push(`${name}:${count}`);
    if (count > max) passed = false;
  }

  return { passed, detail: lines.join(' | ') };
}

function isBotOrWebhookReply(msg: Message, sent: Message, selfId: string): boolean {
  if (msg.id === sent.id) return false;
  if (msg.createdTimestamp < sent.createdTimestamp) return false;
  if (msg.author.id === selfId) return false;
  return msg.author.bot || !!msg.webhookId;
}

function validateReplyShape(test: AgentCapabilityTest, replyText: string, token: string): { ok: boolean; reason?: string } {
  const requireTokenEcho = test.requireTokenEcho !== false;
  if (requireTokenEcho && !replyText.includes(token)) return { ok: false, reason: 'missing token echo' };

  if (test.expectAll && test.expectAll.length > 0) {
    for (const pattern of test.expectAll) {
      if (!pattern.test(replyText)) return { ok: false, reason: `missing expected pattern ${pattern}` };
    }
  }

  if (test.expectAny && test.expectAny.length > 0) {
    if (!test.expectAny.some((pattern) => pattern.test(replyText))) {
      return { ok: false, reason: 'missing any-of expected patterns' };
    }
  }

  return { ok: true };
}

async function hasToolAuditEvidence(channels: TextChannel[], toolNames: string[], sinceTs: number): Promise<boolean> {
  if (toolNames.length === 0) return true;
  const batches = await Promise.all(
    channels.map(async (ch) => {
      try {
        const msgs = await ch.messages.fetch({ limit: 60 });
        return [...msgs.values()];
      } catch {
        return [] as Message[];
      }
    })
  );
  const textBlob = batches
    .flat()
    .filter((m) => (m.createdTimestamp || 0) >= sinceTs)
    .map((m) => extractReplyText(m).toLowerCase())
    .join('\n');

  return toolNames.every((tool) => textBlob.includes(tool.toLowerCase()));
}

async function hasUpgradesPostEvidence(upgrades: TextChannel | undefined, token: string, sinceTs: number): Promise<boolean> {
  if (!upgrades) return false;
  const msgs = await upgrades.messages.fetch({ limit: 100 });
  return [...msgs.values()].some((m) => (m.createdTimestamp || 0) >= sinceTs && extractReplyText(m).includes(token));
}

async function runCapabilityTest(
  groupchat: TextChannel,
  candidateChannels: TextChannel[],
  terminal: TextChannel | undefined,
  upgrades: TextChannel | undefined,
  test: AgentCapabilityTest,
  mention: string,
  selfId: string,
  timeoutMs: number,
): Promise<{ passed: boolean; elapsed: number; snippet: string; reason?: string }> {
  const started = Date.now();
  const token = makeToken(test.id, test.capability);
  const prompt = buildPrompt(test, mention, token);

  let sent: Message;
  try {
    sent = await groupchat.send(prompt);
  } catch (err) {
    return {
      passed: false,
      elapsed: Date.now() - started,
      snippet: `Send failed: ${err instanceof Error ? err.message : String(err)}`,
      reason: 'send failed',
    };
  }

  let matchedSnippet = '';
  let lastReason = 'no valid reply observed';

  while (Date.now() - started < timeoutMs) {
    const channelBatches = await Promise.all(
      candidateChannels.map(async (ch) => {
        try {
          const msgs = await ch.messages.fetch({ limit: 40 });
          return [...msgs.values()];
        } catch {
          return [] as Message[];
        }
      })
    );
    const ordered = channelBatches
      .flat()
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const replies = ordered.filter((m) => isBotOrWebhookReply(m, sent, selfId));

    let shapeOk = false;
    for (const msg of replies) {
      const text = extractReplyText(msg);
      const verdict = validateReplyShape(test, text, token);
      if (verdict.ok) {
        shapeOk = true;
        matchedSnippet = text.slice(0, 300);
        break;
      }
      lastReason = verdict.reason || lastReason;
    }

    const minRepliesOk = (test.minBotRepliesAfterPrompt || 1) <= replies.length;
    if (!minRepliesOk) lastReason = `expected at least ${test.minBotRepliesAfterPrompt} bot/webhook replies`;

    const toolChannels = terminal
      ? [terminal, ...candidateChannels.filter((ch) => ch.id !== terminal.id)]
      : candidateChannels;
    const toolOk = await hasToolAuditEvidence(toolChannels, test.expectToolAudit || [], sent.createdTimestamp || started);
    if (!toolOk && (test.expectToolAudit || []).length > 0) {
      lastReason = `missing tool-audit evidence for ${String(test.expectToolAudit).replace(/,/g, ', ')}`;
    }

    const upgradesOk = !test.expectUpgradesPost || await hasUpgradesPostEvidence(upgrades, token, sent.createdTimestamp || started);
    if (!upgradesOk && test.expectUpgradesPost) {
      lastReason = 'missing upgrades channel post with token';
    }

    if (shapeOk && minRepliesOk && toolOk && upgradesOk) {
      return {
        passed: true,
        elapsed: Date.now() - started,
        snippet: matchedSnippet || 'Capability validated',
      };
    }

    await sleep(2200);
  }

  return {
    passed: false,
    elapsed: Date.now() - started,
    snippet: matchedSnippet || 'Timeout while waiting for full capability evidence',
    reason: lastReason,
  };
}

async function runElevenLabsApiCheck(): Promise<ExtraCheckResult> {
  const key = String(process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) {
    return { name: 'elevenlabs_api', passed: false, detail: 'ELEVENLABS_API_KEY missing', critical: true };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      method: 'GET',
      headers: { 'xi-api-key': key },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { name: 'elevenlabs_api', passed: false, detail: `HTTP ${res.status} ${body.slice(0, 120)}`, critical: true };
    }
    return { name: 'elevenlabs_api', passed: true, detail: 'API reachable', critical: true };
  } catch (err) {
    return { name: 'elevenlabs_api', passed: false, detail: err instanceof Error ? err.message : 'request failed', critical: true };
  }
}

async function runElevenLabsTtsCheck(): Promise<ExtraCheckResult> {
  const key = String(process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return { name: 'elevenlabs_tts', passed: false, detail: 'ELEVENLABS_API_KEY missing', critical: false };

  try {
    const voicesRes = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
    });
    if (!voicesRes.ok) {
      const body = await voicesRes.text().catch(() => '');
      return { name: 'elevenlabs_tts', passed: false, detail: `voices HTTP ${voicesRes.status} ${body.slice(0, 120)}`, critical: false };
    }

    const voicesJson: any = await voicesRes.json().catch(() => ({}));
    const voiceId = voicesJson?.voices?.[0]?.voice_id as string | undefined;
    if (!voiceId) {
      return { name: 'elevenlabs_tts', passed: false, detail: 'No voice_id available', critical: false };
    }

    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: 'ASAP ElevenLabs smoke test.',
        model_id: process.env.ELEVENLABS_TTS_MODEL_ID || 'eleven_multilingual_v2',
      }),
    });

    if (!ttsRes.ok) {
      const body = await ttsRes.text().catch(() => '');
      return { name: 'elevenlabs_tts', passed: false, detail: `tts HTTP ${ttsRes.status} ${body.slice(0, 120)}`, critical: false };
    }

    const buf = Buffer.from(await ttsRes.arrayBuffer());
    if (buf.length < 300) {
      return { name: 'elevenlabs_tts', passed: false, detail: `audio too small (${buf.length} bytes)`, critical: false };
    }

    return { name: 'elevenlabs_tts', passed: true, detail: `audio bytes=${buf.length}`, critical: false };
  } catch (err) {
    return { name: 'elevenlabs_tts', passed: false, detail: err instanceof Error ? err.message : 'request failed', critical: false };
  }
}

async function runVoiceBridgeNoActiveCallCheck(groupchat: TextChannel, selfId: string, timeoutMs: number): Promise<ExtraCheckResult> {
  const token = `VOICE_BRIDGE_${Date.now().toString().slice(-6)}`;
  const sent = await groupchat.send(`tester say: voice smoke token ${token}`);
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const msgs = await groupchat.messages.fetch({ limit: 40 });
    const ordered = [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const hit = ordered.find((m) => isBotOrWebhookReply(m, sent, selfId) && /ASAPTester voice turn failed|ASAPTester spoke in voice|speech injected into voice turn|No active voice call/i.test(extractReplyText(m)));
    if (hit) {
      const text = extractReplyText(hit).slice(0, 220);
      const ok = /No active voice call|spoke in voice|speech injected/i.test(text);
      return { name: 'voice_bridge_no_active_call', passed: ok, detail: text, critical: false };
    }
    await sleep(2200);
  }

  return { name: 'voice_bridge_no_active_call', passed: false, detail: 'No bridge response observed', critical: false };
}

async function runVoiceBridgeActiveCallCheck(groupchat: TextChannel, rileyMention: string, selfId: string, timeoutMs: number): Promise<ExtraCheckResult> {
  const token = `VOICE_ACTIVE_${Date.now().toString().slice(-6)}`;
  const startMsg = await groupchat.send(`${rileyMention} [smoke test:voice-active] Start a voice call now and confirm with token ${token}.`);

  const started = Date.now();
  let sawStart = false;
  while (Date.now() - started < timeoutMs) {
    const msgs = await groupchat.messages.fetch({ limit: 60 });
    const ordered = [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const startHit = ordered.find((m) => isBotOrWebhookReply(m, startMsg, selfId) && extractReplyText(m).includes(token));
    if (startHit) {
      sawStart = true;
      break;
    }
    await sleep(2200);
  }

  if (!sawStart) {
    return { name: 'voice_bridge_active_call', passed: false, detail: 'No active-call confirmation from Riley', critical: false };
  }

  const bridge = await runVoiceBridgeNoActiveCallCheck(groupchat, selfId, Math.min(timeoutMs, 45000));
  await groupchat.send(`${rileyMention} [smoke test:voice-active] End call now.`).catch(() => {});

  return {
    name: 'voice_bridge_active_call',
    passed: bridge.passed,
    detail: bridge.detail,
    critical: false,
  };
}

function buildReadinessSummary(results: TestResult[], extras: ExtraCheckResult[]): { score: number; criticalPassed: boolean; detail: string } {
  const byCategory = new Map<Category, { total: number; passed: number }>();
  for (const r of results) {
    const cur = byCategory.get(r.category) || { total: 0, passed: 0 };
    cur.total += 1;
    if (r.passed) cur.passed += 1;
    byCategory.set(r.category, cur);
  }

  const weights: Record<Category, number> = {
    core: 0.25,
    specialist: 0.20,
    'tool-proof': 0.20,
    orchestration: 0.15,
    upgrades: 0.10,
    memory: 0.10,
  };

  let score = 0;
  for (const key of Object.keys(weights) as Category[]) {
    const row = byCategory.get(key);
    if (!row || row.total === 0) continue;
    score += (row.passed / row.total) * weights[key] * 100;
  }

  const coreFailures = results.filter((r) => r.category === 'core' && !r.passed);
  const orchestrationFailures = results.filter((r) => r.category === 'orchestration' && !r.passed);
  const upgradesFailures = results.filter((r) => r.category === 'upgrades' && !r.passed);
  const criticalExtraFailures = extras.filter((e) => e.critical && !e.passed);

  const criticalPassed = coreFailures.length === 0
    && orchestrationFailures.length === 0
    && upgradesFailures.length === 0
    && criticalExtraFailures.length === 0;

  const detail = [
    `core_fail=${coreFailures.length}`,
    `orchestration_fail=${orchestrationFailures.length}`,
    `upgrades_fail=${upgradesFailures.length}`,
    `critical_extra_fail=${criticalExtraFailures.length}`,
  ].join(' | ');

  return {
    score: Math.round(score * 10) / 10,
    criticalPassed,
    detail,
  };
}

function ensureReportsDir(): string {
  const dir = path.join(process.cwd(), 'smoke-reports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSmokeReports(report: {
  startedAt: string;
  endedAt: string;
  summary: { capabilityPassed: number; capabilityFailed: number; extraFailed: number; score: number; criticalPassed: boolean; detail: string };
  results: TestResult[];
  extras: ExtraCheckResult[];
  config: Record<string, any>;
}): { jsonPath: string; mdPath: string } {
  const dir = ensureReportsDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(dir, `smoke-${stamp}.json`);
  const mdPath = path.join(dir, `smoke-${stamp}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

  const lines: string[] = [];
  lines.push('# Smoke Report');
  lines.push('');
  lines.push(`Started: ${report.startedAt}`);
  lines.push(`Ended: ${report.endedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Capability passed: ${report.summary.capabilityPassed}`);
  lines.push(`- Capability failed: ${report.summary.capabilityFailed}`);
  lines.push(`- Extra checks failed: ${report.summary.extraFailed}`);
  lines.push(`- Readiness score: ${report.summary.score}`);
  lines.push(`- Critical gates passed: ${report.summary.criticalPassed}`);
  lines.push(`- Critical detail: ${report.summary.detail}`);
  lines.push('');
  lines.push('## Capability Results');
  for (const r of report.results) {
    lines.push(`- ${r.passed ? 'PASS' : 'FAIL'} | ${r.agent} | ${r.category}/${r.capability} | ${r.reason || 'ok'}`);
  }
  lines.push('');
  lines.push('## Extra Checks');
  for (const e of report.extras) {
    lines.push(`- ${e.passed ? 'PASS' : 'FAIL'} | ${e.name} | critical=${e.critical} | ${e.detail}`);
  }

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf-8');
  return { jsonPath, mdPath };
}

async function postSuccessResetAndAnnounce(token: string, guildId: string, groupchat: TextChannel): Promise<string> {
  const cleanup = await preClearGuildChannels(token, guildId);
  const totalDeleted = cleanup.reduce((sum, row) => sum + row.deleted, 0);
  await groupchat.send('ASAP bot smoke suite complete. Bot is ready for app development.').catch(() => {});
  return `channels=${cleanup.length} deleted=${totalDeleted}`;
}

async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  const token = process.env.DISCORD_TEST_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  const timeoutMs = Number(process.env.DISCORD_TEST_TIMEOUT_MS ?? '90000');
  const preClear = shouldPreClear();
  const runElevenApi = shouldRunElevenLabsCheck();
  const runElevenTts = shouldRunElevenLabsTtsCheck();
  const runVoiceBridge = shouldRunVoiceBridgeCheck();
  const runVoiceActive = shouldRunActiveVoiceCallCheck();
  const runPostSuccessAction = shouldRunPostSuccessResetAndAnnounce();
  const capabilityAttempts = getCapabilityAttempts();
  const agentFilter = process.argv.find((a) => a.startsWith('--agent='))?.slice('--agent='.length);

  if (!token) throw new Error('Missing DISCORD_TEST_BOT_TOKEN');
  if (!guildId) throw new Error('Missing DISCORD_GUILD_ID');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid DISCORD_TEST_TIMEOUT_MS');

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
  await guild.roles.fetch();

  if (preClear) {
    console.log('Pre-smoke cleanup: clearing messages from text/news/thread channels...');
    const cleanup = await preClearGuildChannels(token, guildId);
    const totalDeleted = cleanup.reduce((sum, row) => sum + row.deleted, 0);
    const failures = cleanup.filter((row) => row.failed > 0).length;
    const timedOut = cleanup.filter((row) => row.timedOut).length;
    console.log(`Cleanup done: channels=${cleanup.length} deleted=${totalDeleted} failed_channels=${failures} timeout_channels=${timedOut}`);
  }

  const groupchat = findTextChannelByNameIncludes(guild, 'groupchat');
  const terminal = findTextChannelByNameIncludes(guild, 'terminal');
  const upgrades = findTextChannelByNameIncludes(guild, 'upgrades');
  const candidateChannels = [...guild.channels.cache.values()]
    .filter((ch: any) => ch?.type === ChannelType.GuildText)
    .map((ch: any) => ch as TextChannel);
  if (!groupchat) {
    await client.destroy();
    throw new Error('Could not find groupchat channel. Set DISCORD_GROUPCHAT_ID if needed.');
  }

  const hygiene = await assertChannelHygiene(guild);

  console.log('\n=== ASAP Agent Full Capability Smoke Matrix ===');
  console.log(`Guild                 : ${guild.name}`);
  console.log(`Groupchat             : #${groupchat.name}`);
  console.log(`Terminal channel      : ${terminal ? '#' + terminal.name : 'missing'}`);
  console.log(`Upgrades channel      : ${upgrades ? '#' + upgrades.name : 'missing'}`);
  console.log(`Timeout               : ${timeoutMs / 1000}s`);
  console.log(`Pre-clear             : ${preClear ? 'enabled' : 'disabled'}`);
  console.log(`Hygiene               : ${hygiene.passed ? 'pass' : 'fail'} (${hygiene.detail})`);
  console.log(`ElevenLabs API check  : ${runElevenApi ? 'enabled' : 'disabled'}`);
  console.log(`ElevenLabs TTS check  : ${runElevenTts ? 'enabled' : 'disabled'}`);
  console.log(`Voice bridge check    : ${runVoiceBridge ? 'enabled' : 'disabled'}`);
  console.log(`Voice active-call     : ${runVoiceActive ? 'enabled' : 'disabled'}`);
  console.log(`Capability attempts   : ${capabilityAttempts}`);
  console.log(`Post-success reset+announce: ${runPostSuccessAction ? 'enabled' : 'disabled'}`);
  if (agentFilter) console.log(`Filter                : --agent=${agentFilter}`);

  const roleMentions = new Map<string, string>();
  for (const test of AGENT_CAPABILITY_TESTS) {
    const agent = getAgent(test.id as never);
    if (!agent) continue;
    const role = guild.roles.cache.find((candidate) => candidate.name === agent.roleName);
    if (role) roleMentions.set(test.id, `<@&${role.id}>`);
  }

  const testsToRun = agentFilter
    ? AGENT_CAPABILITY_TESTS.filter(
        (t) => t.id === agentFilter
          || resolveAgentId(agentFilter || '') === t.id
          || getAgentName(t.id).toLowerCase().includes(agentFilter.toLowerCase())
      )
    : AGENT_CAPABILITY_TESTS;

  if (testsToRun.length === 0) {
    await client.destroy();
    throw new Error(`No agents matched filter: ${agentFilter}`);
  }

  const results: TestResult[] = [];
  for (const test of testsToRun) {
    const mention = roleMentions.get(test.id) || `@${getAgent(test.id as never)?.handle || test.id}`;
    process.stdout.write(`Testing ${getAgentName(test.id)} :: ${test.category}/${test.capability} ... `);

    let result = await runCapabilityTest(
      groupchat,
      candidateChannels,
      terminal,
      upgrades,
      test,
      mention,
      client.user!.id,
      timeoutMs,
    );

    for (let attempt = 2; attempt <= capabilityAttempts && !result.passed; attempt += 1) {
      process.stdout.write(`retry ${attempt}/${capabilityAttempts} ... `);
      await sleep(1200);
      result = await runCapabilityTest(
        groupchat,
        candidateChannels,
        terminal,
        upgrades,
        test,
        mention,
        client.user!.id,
        timeoutMs,
      );
    }

    console.log(`${result.passed ? 'PASS' : 'FAIL'} (${(result.elapsed / 1000).toFixed(1)}s)`);
    console.log(`  -> ${result.snippet}`);

    results.push({
      agent: getAgentName(test.id),
      capability: test.capability,
      category: test.category,
      passed: result.passed,
      elapsed: result.elapsed,
      snippet: result.snippet,
      reason: result.reason,
    });

    await sleep(2000);
  }

  const extras: ExtraCheckResult[] = [];
  extras.push({ name: 'channel_hygiene', passed: hygiene.passed, detail: hygiene.detail, critical: true });

  if (runElevenApi) {
    process.stdout.write('Testing ElevenLabs API ... ');
    const r = await runElevenLabsApiCheck();
    extras.push(r);
    console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.detail}`);
  }

  if (runElevenTts) {
    process.stdout.write('Testing ElevenLabs TTS ... ');
    const r = await runElevenLabsTtsCheck();
    extras.push(r);
    console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.detail}`);
  }

  if (runVoiceBridge) {
    process.stdout.write('Testing voice bridge (no active call) ... ');
    const r = await runVoiceBridgeNoActiveCallCheck(groupchat, client.user!.id, Math.min(timeoutMs, 45000));
    extras.push(r);
    console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.detail}`);
  }

  if (runVoiceActive) {
    process.stdout.write('Testing voice bridge (active call flow) ... ');
    const rileyMention = roleMentions.get('executive-assistant') || '@riley';
    const r = await runVoiceBridgeActiveCallCheck(groupchat, rileyMention, client.user!.id, Math.min(timeoutMs, 120000));
    extras.push(r);
    console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.detail}`);
  }

  const capabilityPassed = results.filter((r) => r.passed).length;
  const capabilityFailed = results.length - capabilityPassed;
  const extraFailed = extras.filter((e) => !e.passed).length;
  const readiness = buildReadinessSummary(results, extras);

  console.log('\n=== Full Smoke Summary ===');
  console.log(`Capabilities: ${capabilityPassed} passed, ${capabilityFailed} failed`);
  console.log(`Extra checks: ${extras.length - extraFailed} passed, ${extraFailed} failed`);
  console.log(`Readiness score: ${readiness.score}`);
  console.log(`Critical gates passed: ${readiness.criticalPassed}`);
  console.log(`Critical detail: ${readiness.detail}`);

  const endedAt = new Date().toISOString();
  const reportPaths = writeSmokeReports({
    startedAt,
    endedAt,
    summary: {
      capabilityPassed,
      capabilityFailed,
      extraFailed,
      score: readiness.score,
      criticalPassed: readiness.criticalPassed,
      detail: readiness.detail,
    },
    results,
    extras,
    config: {
      timeoutMs,
      preClear,
      runElevenApi,
      runElevenTts,
      runVoiceBridge,
      runVoiceActive,
      capabilityAttempts,
      runPostSuccessAction,
      agentFilter: agentFilter || null,
    },
  });

  console.log(`Report JSON: ${reportPaths.jsonPath}`);
  console.log(`Report MD  : ${reportPaths.mdPath}`);

  if (readiness.criticalPassed && capabilityFailed === 0 && extraFailed === 0 && runPostSuccessAction) {
    const post = await postSuccessResetAndAnnounce(token, guildId, groupchat);
    console.log(`Post-success reset+announce complete: ${post}`);
  }

  await client.destroy();
  process.exit(readiness.criticalPassed && capabilityFailed === 0 && extraFailed === 0 ? 0 : 1);
}

void run().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
