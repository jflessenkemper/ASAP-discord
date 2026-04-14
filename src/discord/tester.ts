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
 *   npm run discord:test:dist -- --rerun-failed          # rerun only tests that failed in the last report
 *   npm run discord:test:dist -- --rerun-failed --pm2-logs  # rerun failures + capture bot-side PM2 logs
 *   npm run discord:test:dist -- --goal="build X"        # goal mode: post a complex task, observe all agents (60min timeout)
 *   npm run discord:test:dist -- --prompt="quick check"  # freeform mode: observe agents for 10min
 *
 * Env vars:
 *   DISCORD_TEST_BOT_TOKEN                     required
 *   DISCORD_GUILD_ID                           required
 *   DISCORD_TEST_TIMEOUT_MS                    optional (default 300000)
 *   DISCORD_SMOKE_PROFILE                      optional (default full) — full | readiness | matrix
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
 *   DISCORD_SMOKE_FREEFORM_TIMEOUT_MS             optional (default 600000; goal mode default 3600000)
 *   DISCORD_SMOKE_FREEFORM_SILENCE_MS             optional (default 300000; goal mode default 600000)
 *   DISCORD_SMOKE_REQUIRE_LIVE_ROUTER          optional (readiness default true)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import { ChannelType, Client, GatewayIntentBits, Guild, Message, TextChannel, ThreadChannel } from 'discord.js';

import { getAgent, getAgentAliases, resolveAgentId } from './agents';
import { setupChannels } from './setup';
import {
  type AgentCapabilityTest,
  type Category,
  type CheckPattern,
  type SmokeProfile,
  AGENT_CAPABILITY_TESTS,
  READINESS_TEST_KEYS,
  testKey,
} from './test-definitions';

type FailureCategory = 'PATTERN_MISMATCH' | 'TOOL_AUDIT_MISSING' | 'TIMEOUT' | 'TOKEN_ECHO_MISSING' | 'BOT_UNAVAILABLE' | 'QUALITY_CHECK_FAILED' | 'SEND_FAILED';

function categorizeFailure(reason?: string): FailureCategory {
  if (!reason) return 'TIMEOUT';
  // Timeout checks FIRST — a timed-out test may also carry pattern/tool text in reason
  if (reason.includes('idle timeout') || reason.includes('hard ceiling') || reason.includes('timed out')) return 'TIMEOUT';
  if (reason.includes('missing token echo')) return 'TOKEN_ECHO_MISSING';
  if (reason.includes('missing tool-audit evidence')) return 'TOOL_AUDIT_MISSING';
  if (reason.includes('missing expected pattern') || reason.includes('missing any-of expected patterns')) return 'PATTERN_MISMATCH';
  if (reason.includes('send failed')) return 'SEND_FAILED';
  if (reason.includes('expected at least')) return 'BOT_UNAVAILABLE';
  if (reason.includes('capacity or limit error')) return 'QUALITY_CHECK_FAILED';
  if (reason.includes('timeout')) return 'TIMEOUT';
  return 'PATTERN_MISMATCH';
}

interface TestResult {
  agent: string;
  capability: string;
  category: Category;
  passed: boolean;
  elapsed: number;
  snippet: string;
  reason?: string;
  critical?: boolean;
  failureCategory?: FailureCategory;
  flaky?: boolean;
  retryPassed?: boolean;
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


function getSmokeProfile(): SmokeProfile {
  const raw = String(process.env.DISCORD_SMOKE_PROFILE || 'full').trim().toLowerCase();
  if (raw === 'readiness') return 'readiness';
  if (raw === 'matrix') return 'matrix';
  return 'full';
}

function getTestTimeoutMs(profile: SmokeProfile): number {
  const explicit = process.env.DISCORD_TEST_TIMEOUT_MS;
  const fallback = profile === 'matrix' ? 240_000 : 300_000;
  const value = Number(explicit ?? String(fallback));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(8_000, Math.floor(value)), 600_000);
}

function getAgentName(id: string): string {
  return getAgent(id as never)?.name || id;
}

function shouldPreClear(profile: SmokeProfile): boolean {
  const fallback = profile === 'readiness' ? 'false' : 'true';
  const raw = String(process.env.DISCORD_SMOKE_PRE_CLEAR ?? fallback).trim().toLowerCase();
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

function shouldRunVoiceBridgeCheck(profile: SmokeProfile): boolean {
  const fallback = profile === 'readiness' || profile === 'matrix' ? 'false' : 'true';
  const raw = String(process.env.DISCORD_SMOKE_ELEVENLABS_VOICE_BRIDGE ?? fallback).trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function shouldRunActiveVoiceCallCheck(): boolean {
  const raw = String(process.env.DISCORD_SMOKE_VOICE_ACTIVE_CALL ?? 'false').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function shouldRunVoiceRoundTripCheck(): boolean {
  const raw = String(process.env.DISCORD_SMOKE_VOICE_ROUND_TRIP ?? 'false').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function shouldRunPostSuccessResetAndAnnounce(): boolean {
  const raw = String(process.env.DISCORD_SMOKE_POST_SUCCESS_RESET_AND_ANNOUNCE ?? 'false').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function shouldRequireLiveRouter(profile: SmokeProfile): boolean {
  const fallback = profile === 'readiness' || profile === 'matrix' ? 'true' : 'false';
  const raw = String(process.env.DISCORD_SMOKE_REQUIRE_LIVE_ROUTER ?? fallback).trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function getRouterHealthTimeoutMs(profile: SmokeProfile): number {
  const fallback = profile === 'readiness' ? 25_000 : 12_000;
  const value = Number(process.env.DISCORD_SMOKE_ROUTER_HEALTH_TIMEOUT_MS ?? String(fallback));
  if (!Number.isFinite(value) || value < 3_000) return fallback;
  return Math.min(Math.max(3_000, Math.floor(value)), 60_000);
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

function getHygieneMaxMessages(profile: SmokeProfile): number {
  const fallback = profile === 'readiness' ? 250 : 8;
  const value = Number(process.env.DISCORD_SMOKE_HYGIENE_MAX_MESSAGES ?? String(fallback));
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.max(0, Math.floor(value)), 500);
}

function getCapabilityAttempts(profile: SmokeProfile): number {
  const fallback = profile === 'readiness' ? 2 : 2;
  const value = Number(process.env.DISCORD_SMOKE_CAPABILITY_ATTEMPTS ?? String(fallback));
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), 4);
}

function getBudgetBoostAmount(profile: SmokeProfile): number {
  const fallback = profile === 'matrix' ? 120 : profile === 'readiness' ? 40 : 80;
  const value = Number(process.env.DISCORD_SMOKE_BUDGET_BOOST ?? String(fallback));
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.max(10, Math.floor(value)), 1000);
}

function getInterTestDelayMs(profile: SmokeProfile): number {
  return profile === 'matrix' ? 250 : profile === 'readiness' ? 250 : 2000;
}

function getPollIntervalMs(profile: SmokeProfile): number {
  const fallback = profile === 'matrix' ? 500 : profile === 'readiness' ? 900 : 1600;
  const value = Number(process.env.DISCORD_SMOKE_POLL_INTERVAL_MS ?? String(fallback));
  if (!Number.isFinite(value) || value < 250) return fallback;
  return Math.min(Math.max(250, Math.floor(value)), 5000);
}

function makeToken(agentId: string, capability: string): string {
  const left = agentId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase() || 'AGENT';
  const right = capability.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase() || 'CAP';
  return `SMOKE_${left}_${right}_${Date.now().toString().slice(-6)}`;
}

function buildPrompt(test: AgentCapabilityTest, mention: string, token: string): string {
  return `${mention} [smoke test:${test.capability}] ${test.prompt}\nInclude this exact token in your reply: ${token}`;
}

function normalizeRoleLabel(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function resolveRoleMentionForAgent(guild: any, agentId: string): string | null {
  const agent = getAgent(agentId as never);
  if (!agent) return null;

  const wanted = new Set<string>();
  wanted.add(normalizeRoleLabel(agent.roleName));
  wanted.add(normalizeRoleLabel(agent.name));
  wanted.add(normalizeRoleLabel(agent.handle));
  for (const alias of getAgentAliases(agentId as never)) wanted.add(normalizeRoleLabel(alias));

  const role = guild.roles.cache.find((candidate: any) => {
    const name = String(candidate?.name || '');
    const normalized = normalizeRoleLabel(name);
    if (!normalized) return false;
    if (wanted.has(normalized)) return true;
    for (const target of wanted) {
      if (!target) continue;
      if (normalized.includes(target) || target.includes(normalized)) return true;
    }
    return false;
  });

  return role ? `<@&${role.id}>` : null;
}

function extractReplyText(msg: Message): string {
  return (msg.content || msg.embeds[0]?.description || msg.embeds[0]?.title || '').slice(0, 2000);
}

// ── Live Monitor: event-driven message collection with real-time logging ──

interface LiveEvent {
  ts: number;
  channel: string;
  channelId: string;
  author: string;
  authorId: string;
  isBot: boolean;
  isWebhook: boolean;
  content: string;
  msgId: string;
  attachments: number;
  embeds: number;
  threadId?: string;
  threadName?: string;
}

class LiveMonitor {
  private events: LiveEvent[] = [];
  private listeners: Array<(event: LiveEvent) => void> = [];
  private client: Client;
  private selfId: string;
  private channelNames = new Map<string, string>();
  private startTs: number;
  private eventCount = 0;
  private logEnabled = true;

  constructor(client: Client, selfId: string) {
    this.client = client;
    this.selfId = selfId;
    this.startTs = Date.now();
    this.client.on('messageCreate', this.handleMessage);
    this.client.on('messageUpdate', this.handleMessageUpdate);
  }

  registerChannels(channels: TextChannel[]) {
    for (const ch of channels) {
      this.channelNames.set(ch.id, ch.name);
    }
  }

  private handleMessageUpdate = (_old: Message | any, msg: Message | any) => {
    if (!msg?.author || msg.author.id === this.selfId) return;
    const channelName = this.channelNames.get(msg.channelId) || (msg.channel as any)?.name || msg.channelId;
    const existing = this.events.find((e) => e.msgId === msg.id);
    if (existing) {
      const oldLen = existing.content.length;
      existing.content = extractReplyText(msg);
      existing.attachments = msg.attachments?.size ?? 0;
      existing.embeds = msg.embeds?.length ?? 0;
      if (this.logEnabled) {
        const elapsed = ((Date.now() - this.startTs) / 1000).toFixed(1);
        const location = existing.threadName ? `🧵${existing.threadName}` : `#${channelName}`;
        const preview = existing.content.slice(0, 120).replace(/\n/g, ' ');
        console.log(`  ✏️  [${elapsed}s] ${existing.author} edited → ${location}: ${oldLen}→${existing.content.length} chars | ${preview}`);
      }
      // Re-notify listeners so waitFor can re-evaluate conditions
      for (const listener of this.listeners) {
        try { listener(existing); } catch { /* */ }
      }
    }
  };

  logSelf(channelName: string, content: string) {
    if (!this.logEnabled) return;
    const elapsed = ((Date.now() - this.startTs) / 1000).toFixed(1);
    const preview = content.slice(0, 160).replace(/\n/g, ' ');
    console.log(`  📤 [${elapsed}s] 🧪 TEST → #${channelName}: ${preview}`);
  }

  private handleMessage = (msg: Message) => {
    if (msg.author.id === this.selfId) return;

    const channelName = this.channelNames.get(msg.channelId)
      || (msg.channel as any)?.name
      || msg.channelId;

    const isThread = msg.channel?.isThread?.() ?? false;
    const threadName = isThread ? (msg.channel as ThreadChannel).name : undefined;
    const threadId = isThread ? msg.channel.id : undefined;
    if (isThread && !this.channelNames.has(msg.channelId)) {
      this.channelNames.set(msg.channelId, threadName || msg.channelId);
    }

    const event: LiveEvent = {
      ts: msg.createdTimestamp,
      channel: channelName,
      channelId: msg.channelId,
      author: msg.author.username || msg.author.id,
      authorId: msg.author.id,
      isBot: msg.author.bot,
      isWebhook: !!msg.webhookId,
      content: extractReplyText(msg),
      msgId: msg.id,
      attachments: msg.attachments.size,
      embeds: msg.embeds.length,
      threadId,
      threadName,
    };
    this.events.push(event);
    this.eventCount++;

    for (const listener of this.listeners) {
      try { listener(event); } catch { /* listener errors don't stop the monitor */ }
    }

    if (this.logEnabled) {
      const elapsed = ((Date.now() - this.startTs) / 1000).toFixed(1);
      const location = threadName ? `🧵${threadName}` : `#${channelName}`;
      const tag = event.isWebhook ? '🔗' : event.isBot ? '🤖' : '👤';
      const preview = event.content.slice(0, 160).replace(/\n/g, ' ');
      const extras: string[] = [];
      if (event.attachments > 0) extras.push(`${event.attachments} attach`);
      if (event.embeds > 0) extras.push(`${event.embeds} embed`);
      const suffix = extras.length > 0 ? ` [${extras.join(', ')}]` : '';
      const toolMatch = event.content.match(/\[TOOL:(\w+)\]/);
      const toolTag = toolMatch ? ` ⚙️${toolMatch[1]}` : '';
      console.log(`  📡 [${elapsed}s] ${tag} ${event.author} → ${location}: ${preview}${suffix}${toolTag}`);
    }
  };

  onMessage(listener: (event: LiveEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  getEventsSince(sinceTs: number, filter?: { channelIds?: Set<string>; botsOnly?: boolean }): LiveEvent[] {
    return this.events.filter((e) => {
      if (e.ts < sinceTs) return false;
      if (filter?.channelIds && !filter.channelIds.has(e.channelId)) return false;
      if (filter?.botsOnly && !e.isBot && !e.isWebhook) return false;
      return true;
    });
  }

  hasToolEvidence(toolNames: string[], sinceTs: number, channelIds: Set<string>): boolean {
    if (toolNames.length === 0) return true;
    const relevantEvents = this.getEventsSince(sinceTs, { channelIds });
    const textBlob = relevantEvents.map((e) => e.content.toLowerCase()).join('\n');
    return toolNames.every((tool) => {
      const t = tool.toLowerCase();
      return textBlob.includes(t) || textBlob.includes(`\`${t}\``) || textBlob.includes(`[tool:${t}]`);
    });
  }

  hasUpgradesEvidence(token: string, sinceTs: number, upgradesChannelId: string): boolean {
    const events = this.getEventsSince(sinceTs, { channelIds: new Set([upgradesChannelId]) });
    return events.some((e) => {
      if (e.content.includes(token)) return true;
      return /\b(upgrade|improvement|enhancement|token|optimi[sz]e|blocker)\b/i.test(e.content);
    });
  }

  waitFor(
    condition: (events: LiveEvent[]) => boolean,
    opts: { sinceTs: number; timeoutMs: number; channelIds?: Set<string>; botsOnly?: boolean; idleTimeoutMs?: number },
  ): Promise<{ met: boolean; elapsed: number; idleTimedOut?: boolean }> {
    const started = Date.now();
    let lastEventTs = Date.now();
    const idleTimeoutMs = opts.idleTimeoutMs || opts.timeoutMs;

    const existing = this.getEventsSince(opts.sinceTs, { channelIds: opts.channelIds, botsOnly: opts.botsOnly });
    if (condition(existing)) {
      return Promise.resolve({ met: true, elapsed: Date.now() - started });
    }

    return new Promise((resolve) => {
      let idleTimer: ReturnType<typeof setInterval> | null = null;

      const hardTimer = setTimeout(() => {
        cleanup();
        resolve({ met: false, elapsed: Date.now() - started });
      }, opts.timeoutMs);

      if (idleTimeoutMs < opts.timeoutMs) {
        idleTimer = setInterval(() => {
          const idle = Date.now() - lastEventTs;
          if (idle >= idleTimeoutMs && this.getEventsSince(opts.sinceTs, { channelIds: opts.channelIds, botsOnly: opts.botsOnly }).length > 0) {
            cleanup();
            resolve({ met: false, elapsed: Date.now() - started, idleTimedOut: true });
          }
        }, 2000);
      }

      const unsub = this.onMessage(() => {
        lastEventTs = Date.now();
        const events = this.getEventsSince(opts.sinceTs, { channelIds: opts.channelIds, botsOnly: opts.botsOnly });
        if (condition(events)) {
          cleanup();
          resolve({ met: true, elapsed: Date.now() - started });
        }
      });

      const cleanup = () => {
        clearTimeout(hardTimer);
        if (idleTimer) clearInterval(idleTimer);
        unsub();
      };
    });
  }

  get totalEvents() { return this.eventCount; }
  setLogging(enabled: boolean) { this.logEnabled = enabled; }

  destroy() {
    this.client.off('messageCreate', this.handleMessage);
    this.client.off('messageUpdate', this.handleMessageUpdate);
    this.listeners.length = 0;
  }

  printSummary() {
    const byChannel = new Map<string, number>();
    const byAuthor = new Map<string, number>();
    const toolsDetected = new Set<string>();
    for (const e of this.events) {
      byChannel.set(e.channel, (byChannel.get(e.channel) || 0) + 1);
      byAuthor.set(e.author, (byAuthor.get(e.author) || 0) + 1);
      const tm = e.content.match(/\[TOOL:(\w+)\]/g);
      if (tm) tm.forEach((t) => toolsDetected.add(t.replace(/\[TOOL:|]/g, '')));
    }
    console.log(`\n📊 Live Monitor: ${this.eventCount} events in ${((Date.now() - this.startTs) / 1000).toFixed(0)}s`);
    console.log(`  Channels: ${[...byChannel.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(' ')}`);
    console.log(`  Authors:  ${[...byAuthor.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(' ')}`);
    if (toolsDetected.size > 0) {
      console.log(`  Tools:    ${[...toolsDetected].join(', ')}`);
    }
    const edits = this.events.filter((e) => e.content.length !== e.content.length).length; // placeholder
    const threadEvents = this.events.filter((e) => !!e.threadId).length;
    if (threadEvents > 0) console.log(`  Threads:  ${threadEvents} events in threads`);
  }
}

let monitor: LiveMonitor | null = null;

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

async function assertChannelHygiene(guild: any, profile: SmokeProfile): Promise<{ passed: boolean; detail: string }> {
  const max = getHygieneMaxMessages(profile);
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
  // Normalize: strip markdown formatting, collapse whitespace
  const normalized = replyText
    .replace(/```[\s\S]*?```/g, ' ')     // remove code blocks
    .replace(/`([^`]+)`/g, '$1')          // unwrap inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')    // unwrap bold
    .replace(/__([^_]+)__/g, '$1')        // unwrap bold alt
    .replace(/\*([^*]+)\*/g, '$1')        // unwrap italic
    .replace(/_([^_]+)_/g, '$1')          // unwrap italic alt
    .replace(/~~([^~]+)~~/g, '$1')        // unwrap strikethrough
    .replace(/\s+/g, ' ')                 // collapse whitespace
    .trim();

  const requireTokenEcho = test.requireTokenEcho === true;
  if (requireTokenEcho && !replyText.includes(token)) return { ok: false, reason: 'missing token echo' };

  if (test.expectAll && test.expectAll.length > 0) {
    for (const pattern of test.expectAll) {
      if (!pattern.test(replyText) && !pattern.test(normalized)) return { ok: false, reason: `missing expected pattern ${pattern}` };
    }
  }

  if (test.expectAny && test.expectAny.length > 0) {
    if (!test.expectAny.some((pattern) => pattern.test(replyText) || pattern.test(normalized))) {
      return { ok: false, reason: 'missing any-of expected patterns' };
    }
  }

  if (test.expectNone && test.expectNone.length > 0) {
    for (const pattern of test.expectNone) {
      if (pattern.test(replyText) || pattern.test(normalized)) return { ok: false, reason: `matched forbidden pattern ${pattern}` };
    }
  }

  return { ok: true };
}

async function hasToolAuditEvidence(channels: TextChannel[], toolNames: string[], sinceTs: number): Promise<boolean> {
  if (toolNames.length === 0) return true;

  // Collect messages from channels AND their active threads
  const batches = await Promise.all(
    channels.map(async (ch) => {
      const msgs: Message[] = [];
      try {
        const channelMsgs = await ch.messages.fetch({ limit: 120 });
        msgs.push(...channelMsgs.values());
      } catch { /* ignore fetch errors */ }
      try {
        const threads = await ch.threads.fetchActive();
        const threadFetches = [...threads.threads.values()].map(async (thread) => {
          try {
            const threadMsgs = await thread.messages.fetch({ limit: 40 });
            return [...threadMsgs.values()];
          } catch {
            return [] as Message[];
          }
        });
        const threadResults = await Promise.all(threadFetches);
        msgs.push(...threadResults.flat());
      } catch { /* threads not available */ }
      return msgs;
    })
  );
  const textBlob = batches
    .flat()
    .filter((m) => (m.createdTimestamp || 0) >= sinceTs)
    .map((m) => extractReplyText(m).toLowerCase())
    .join('\n');

  return toolNames.every((tool) => {
    const t = tool.toLowerCase();
    // Match raw tool name, backtick-wrapped, or structured [TOOL:name] tag
    return textBlob.includes(t) || textBlob.includes(`\`${t}\``) || textBlob.includes(`[tool:${t}]`);
  });
}

async function hasUpgradesPostEvidence(upgrades: TextChannel | undefined, token: string, sinceTs: number): Promise<boolean> {
  if (!upgrades) return false;
  const msgs = await upgrades.messages.fetch({ limit: 100 });
  return [...msgs.values()].some((m) => {
    if ((m.createdTimestamp || 0) < sinceTs) return false;
    const text = extractReplyText(m);
    if (text.includes(token)) return true;
    return /\b(upgrade|improvement|enhancement|token|optimi[sz]e|blocker)\b/i.test(text);
  });
}

async function runCapabilityTest(
  groupchat: TextChannel,
  responseChannels: TextChannel[],
  terminal: TextChannel | undefined,
  upgrades: TextChannel | undefined,
  test: AgentCapabilityTest,
  mention: string,
  selfId: string,
  timeoutMs: number,
  _pollIntervalMs: number,
): Promise<{ passed: boolean; elapsed: number; snippet: string; reason?: string }> {
  const started = Date.now();
  const token = makeToken(test.id, test.capability);
  const prompt = buildPrompt(test, mention, token);

  let sent: Message;
  try {
    sent = await groupchat.send(prompt);
    if (monitor) monitor.logSelf(groupchat.name, prompt);
  } catch (err) {
    return {
      passed: false,
      elapsed: Date.now() - started,
      snippet: `Send failed: ${err instanceof Error ? err.message : String(err)}`,
      reason: 'send failed',
    };
  }

  const IDLE_TIMEOUT_MS = Math.min(timeoutMs, test.heavyTool ? 100_000 : 90_000);
  const HARD_CEILING_MS = Math.max(timeoutMs, test.heavyTool ? 420_000 : 360_000);

  // Build channel ID sets for monitor queries
  const responseChannelIds = new Set(responseChannels.map((ch) => ch.id));
  const toolChannelIds = new Set<string>();
  if (terminal) toolChannelIds.add(terminal.id);
  for (const ch of responseChannels) toolChannelIds.add(ch.id);
  const upgradesChannelId = upgrades?.id;

  // If monitor is available, use event-driven approach (zero polling)
  if (monitor) {
    const sinceTs = sent.createdTimestamp || started;
    let condEvalCount = 0;

    const result = await monitor.waitFor(
      (events) => {
        condEvalCount++;
        const botEvents = events.filter((e) =>
          (e.isBot || e.isWebhook) && e.ts >= sinceTs && responseChannelIds.has(e.channelId)
        );

        // Diagnostic: log first few condition evaluations to debug first-attempt failures
        if (condEvalCount <= 3 || (condEvalCount <= 20 && botEvents.length > 0)) {
          const responseChIds = [...responseChannelIds].join(',');
          const allEvCount = events.length;
          const sinceEvCount = events.filter(e => e.ts >= sinceTs).length;
          console.log(`    [cond-debug] eval#${condEvalCount} test=${test.capability} sinceTs=${sinceTs} allEvents=${allEvCount} sinceTsEvents=${sinceEvCount} botEvents=${botEvents.length} responseChIds=${responseChIds}`);
          if (botEvents.length > 0) {
            for (const be of botEvents.slice(0, 3)) {
              const shape = validateReplyShape(test, be.content, token);
              console.log(`    [cond-debug]   botEvent ch=${be.channelId} author=${be.author} isBot=${be.isBot} isWH=${be.isWebhook} ts=${be.ts} content=${be.content.slice(0, 120)} shape=${JSON.stringify(shape)}`);
            }
          }
        }

        // Check for capacity errors — return true to break out, we re-check below
        for (const e of botEvents) {
          if (/daily token limit reached|rate limit|quota exhausted|budget exceeded|request interrupted by user/i.test(e.content)) {
            return true;
          }
        }

        const minRepliesOk = (test.minBotRepliesAfterPrompt || 1) <= botEvents.length;
        if (!minRepliesOk) return false;

        let shapeOk = false;
        for (const e of botEvents) {
          if (validateReplyShape(test, e.content, token).ok) { shapeOk = true; break; }
        }
        if (!shapeOk) return false;

        if (!monitor!.hasToolEvidence(test.expectToolAudit || [], sinceTs, toolChannelIds)) return false;

        if (test.expectUpgradesPost && upgradesChannelId) {
          if (!monitor!.hasUpgradesEvidence(token, sinceTs, upgradesChannelId)) return false;
        }

        return true;
      },
      { sinceTs, timeoutMs: HARD_CEILING_MS, idleTimeoutMs: IDLE_TIMEOUT_MS },
    );

    // Gather final state
    const botEvents = monitor.getEventsSince(sinceTs, { botsOnly: true })
      .filter((e) => responseChannelIds.has(e.channelId));

    // Log condition breakdown for diagnostics
    {
      const minReplies = test.minBotRepliesAfterPrompt || 1;
      const gotReplies = botEvents.length;
      let shapeMatched = false;
      for (const e of botEvents) {
        if (validateReplyShape(test, e.content, token).ok) { shapeMatched = true; break; }
      }
      const toolsNeeded = test.expectToolAudit || [];
      const toolsOk = monitor.hasToolEvidence(toolsNeeded, sinceTs, toolChannelIds);
      const upgradesOk = !test.expectUpgradesPost || !upgradesChannelId || monitor.hasUpgradesEvidence(token, sinceTs, upgradesChannelId);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const conds = [
        `replies:${gotReplies}/${minReplies}${gotReplies >= minReplies ? '✓' : '✗'}`,
        `shape:${shapeMatched ? '✓' : '✗'}`,
        toolsNeeded.length > 0 ? `tools[${toolsNeeded.join(',')}]:${toolsOk ? '✓' : '✗'}` : null,
        test.expectUpgradesPost ? `upgrades:${upgradesOk ? '✓' : '✗'}` : null,
      ].filter(Boolean).join(' ');
      console.log(`    🔍 [${elapsed}s] ${result.met ? '✅' : '❌'} conditions: ${conds}${result.idleTimedOut ? ' (idle timeout)' : ''}`);
    }

    // Check for capacity errors (use specific phrases to avoid false positives
    // when agents legitimately discuss rate-limiting as a security topic)
    for (const e of botEvents) {
      if (/daily token limit reached|rate limit(?:ed| exceeded| error)|quota exhausted|budget exceeded|request interrupted by user/i.test(e.content)) {
        return { passed: false, elapsed: Date.now() - started, snippet: e.content.slice(0, 300), reason: 'agent capacity or limit error' };
      }
    }

    if (result.met) {
      const matchedEvent = botEvents.find((e) => validateReplyShape(test, e.content, token).ok);
      return { passed: true, elapsed: Date.now() - started, snippet: matchedEvent?.content.slice(0, 300) || 'Capability validated' };
    }

    // Determine failure reason
    let reason = 'no valid reply observed';
    const minRepliesOk = (test.minBotRepliesAfterPrompt || 1) <= botEvents.length;
    if (!minRepliesOk) {
      reason = `expected at least ${test.minBotRepliesAfterPrompt ?? 1} bot/webhook replies`;
    } else {
      let shapeOk = false;
      for (const e of botEvents) {
        const verdict = validateReplyShape(test, e.content, token);
        if (verdict.ok) { shapeOk = true; break; }
        reason = verdict.reason || reason;
      }
      if (shapeOk) {
        if (!monitor.hasToolEvidence(test.expectToolAudit || [], sinceTs, toolChannelIds)) {
          reason = `missing tool-audit evidence for ${String(test.expectToolAudit).replace(/,/g, ', ')}`;
        } else if (test.expectUpgradesPost) {
          reason = 'missing upgrades channel post with token';
        }
      }
    }

    const timeoutType = result.idleTimedOut
      ? 'idle timeout (no new messages)'
      : (Date.now() - started >= HARD_CEILING_MS ? 'hard ceiling reached' : 'timed out');

    const matchedEvent = botEvents.find((e) => validateReplyShape(test, e.content, token).ok);
    // Prefix timeout type into reason so categorizeFailure correctly classifies TIMEOUT
    const timeoutReason = reason ? `${timeoutType}: ${reason}` : timeoutType;
    return {
      passed: false,
      elapsed: Date.now() - started,
      snippet: matchedEvent?.content.slice(0, 300) || `Timeout while waiting for full capability evidence (${timeoutType})`,
      reason: timeoutReason,
    };
  }

  // ── Fallback: original polling approach if monitor is not available ──
  let matchedSnippet = '';
  let lastReason = 'no valid reply observed';
  let lastActivityTs = Date.now();
  let seenMessageIds = new Set<string>();

  while (true) {
    const now = Date.now();
    const elapsed = now - started;
    const idleMs = now - lastActivityTs;
    if (elapsed >= HARD_CEILING_MS) break;
    if (idleMs >= IDLE_TIMEOUT_MS && seenMessageIds.size > 0) break;
    if (elapsed >= timeoutMs && seenMessageIds.size === 0) break;

    const channelBatches = await Promise.all(
      responseChannels.map(async (channel) => {
        try {
          const msgs = await channel.messages.fetch({ limit: 120 });
          return [...msgs.values()];
        } catch {
          return [] as Message[];
        }
      })
    );
    const ordered = channelBatches.flat().sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const replies = ordered.filter((m) => isBotOrWebhookReply(m, sent, selfId));
    for (const msg of replies) {
      if (!seenMessageIds.has(msg.id)) { seenMessageIds.add(msg.id); lastActivityTs = Date.now(); }
    }
    let shapeOk = false;
    for (const msg of replies) {
      const text = extractReplyText(msg);
      if (/daily token limit reached|rate limit(?:ed| exceeded| error)|quota exhausted|budget exceeded|request interrupted by user/i.test(text)) {
        return { passed: false, elapsed: Date.now() - started, snippet: text.slice(0, 300), reason: 'agent capacity or limit error' };
      }
      const verdict = validateReplyShape(test, text, token);
      if (verdict.ok) { shapeOk = true; matchedSnippet = text.slice(0, 300); break; }
      lastReason = verdict.reason || lastReason;
    }
    const minRepliesOk = (test.minBotRepliesAfterPrompt || 1) <= replies.length;
    if (!minRepliesOk) lastReason = `expected at least ${test.minBotRepliesAfterPrompt ?? 1} bot/webhook replies`;
    const toolChannels = terminal ? [terminal, ...responseChannels.filter((ch) => ch.id !== terminal.id)] : responseChannels;
    const toolOk = await hasToolAuditEvidence(toolChannels, test.expectToolAudit || [], sent.createdTimestamp || started);
    if (!toolOk && (test.expectToolAudit || []).length > 0) lastReason = `missing tool-audit evidence for ${String(test.expectToolAudit).replace(/,/g, ', ')}`;
    const upgradesOk = !test.expectUpgradesPost || await hasUpgradesPostEvidence(upgrades, token, sent.createdTimestamp || started);
    if (!upgradesOk && test.expectUpgradesPost) lastReason = 'missing upgrades channel post with token';
    if (shapeOk && minRepliesOk && toolOk && upgradesOk) {
      return { passed: true, elapsed: Date.now() - started, snippet: matchedSnippet || 'Capability validated' };
    }
    await sleep(_pollIntervalMs);
  }

  const idleMs = Date.now() - lastActivityTs;
  const timeoutType = idleMs >= IDLE_TIMEOUT_MS && seenMessageIds.size > 0
    ? `idle timeout (no new messages for ${Math.ceil(idleMs / 1000)}s)`
    : (Date.now() - started >= HARD_CEILING_MS ? 'hard ceiling reached' : 'timed out');

  // Prefix timeout type into reason so categorizeFailure correctly classifies TIMEOUT
  const timeoutReason = lastReason ? `${timeoutType}: ${lastReason}` : timeoutType;
  return {
    passed: false,
    elapsed: Date.now() - started,
    snippet: matchedSnippet || `Timeout while waiting for full capability evidence (${timeoutType})`,
    reason: timeoutReason,
  };
}

async function verifyLiveRouter(
  groupchat: TextChannel,
  mention: string,
  selfId: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const sent = await groupchat.send(`${mention} status`);
  if (monitor) monitor.logSelf(groupchat.name, `${mention} status`);
  const sinceTs = sent.createdTimestamp || Date.now();

  if (monitor) {
    const result = await monitor.waitFor(
      (events) => events.some((e) => (e.isBot || e.isWebhook) && e.ts >= sinceTs && e.channelId === groupchat.id),
      { sinceTs, timeoutMs, channelIds: new Set([groupchat.id]), botsOnly: true },
    );
    if (result.met) {
      const hit = monitor.getEventsSince(sinceTs, { channelIds: new Set([groupchat.id]), botsOnly: true })[0];
      return { ok: true, detail: `live reply from ${hit?.author || 'bot'}` };
    }
    return { ok: false, detail: `No bot/webhook reply observed within ${Math.round(timeoutMs / 1000)}s` };
  }

  // Fallback polling
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const msgs = await groupchat.messages.fetch({ limit: 50 }).catch(() => null);
    if (!msgs) {
      await sleep(500);
      continue;
    }
    const ordered = [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const hit = ordered.find((m) => isBotOrWebhookReply(m, sent, selfId));
    if (hit) {
      return { ok: true, detail: `live reply from ${hit.author.username}` };
    }
    await sleep(500);
  }

  return { ok: false, detail: `No bot/webhook reply observed within ${Math.round(timeoutMs / 1000)}s` };
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

/**
 * Full voice round-trip test:
 * 1. Ask Riley to join voice via groupchat
 * 2. Wait for join confirmation
 * 3. Send "tester say:" to trigger TTS playback
 * 4. Wait for "spoke in voice" confirmation
 * 5. Ask Riley to leave voice
 */
async function runVoiceRoundTripCheck(
  groupchat: TextChannel,
  rileyMention: string,
  selfId: string,
  timeoutMs: number,
): Promise<ExtraCheckResult> {
  const token = `VOICE_RT_${Date.now().toString().slice(-6)}`;
  const stepTimeout = Math.min(timeoutMs, 60_000);

  // Step 1: Ask Riley to join voice
  const joinMsg = await groupchat.send(`${rileyMention} join voice`);
  const joinStart = Date.now();
  let joinConfirmed = false;

  while (Date.now() - joinStart < stepTimeout) {
    const msgs = await groupchat.messages.fetch({ limit: 40 });
    const ordered = [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const hit = ordered.find((m) =>
      m.createdTimestamp > joinMsg.createdTimestamp &&
      (m.author.bot || m.webhookId) &&
      /joined voice|voice call started|already in progress|listening is unavailable|can't join voice/i.test(extractReplyText(m))
    );
    if (hit) {
      const text = extractReplyText(hit);
      if (/listening is unavailable|can't join voice/i.test(text)) {
        return { name: 'voice_round_trip', passed: false, detail: `Riley cannot join voice: ${text.slice(0, 200)}`, critical: false };
      }
      joinConfirmed = true;
      break;
    }
    await sleep(2500);
  }

  if (!joinConfirmed) {
    // Cleanup: try to end call just in case
    await groupchat.send(`${rileyMention} leave voice`).catch(() => {});
    return { name: 'voice_round_trip', passed: false, detail: 'Riley did not confirm joining voice within timeout', critical: false };
  }

  // Step 2: Wait a moment for voice pipeline to initialize
  await sleep(3000);

  // Step 3: Send "tester say:" to trigger TTS playback
  const sayMsg = await groupchat.send(`tester say: voice round trip smoke check token ${token}`);
  const sayStart = Date.now();
  let spokeInVoice = false;
  let resultDetail = '';

  while (Date.now() - sayStart < stepTimeout) {
    const msgs = await groupchat.messages.fetch({ limit: 40 });
    const ordered = [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const hit = ordered.find((m) =>
      m.createdTimestamp > sayMsg.createdTimestamp &&
      (m.author.bot || m.webhookId) &&
      /spoke in voice|speech injected|voice turn failed|No active voice call/i.test(extractReplyText(m))
    );
    if (hit) {
      const text = extractReplyText(hit);
      spokeInVoice = /spoke in voice|speech injected/i.test(text);
      resultDetail = text.slice(0, 220);
      break;
    }
    await sleep(2500);
  }

  // Step 4: Cleanup — ask Riley to leave voice
  await groupchat.send(`${rileyMention} leave voice`).catch(() => {});
  await sleep(2000);

  if (!resultDetail) {
    return { name: 'voice_round_trip', passed: false, detail: 'No voice playback response observed', critical: false };
  }

  return {
    name: 'voice_round_trip',
    passed: spokeInVoice,
    detail: resultDetail,
    critical: false,
  };
}

function buildReadinessSummary(results: TestResult[], extras: ExtraCheckResult[], profile: SmokeProfile = 'full'): { score: number; criticalPassed: boolean; detail: string } {
  const byCategory = new Map<Category, { total: number; passed: number }>();
  for (const r of results) {
    const cur = byCategory.get(r.category) || { total: 0, passed: 0 };
    cur.total += 1;
    if (r.passed) cur.passed += 1;
    byCategory.set(r.category, cur);
  }

  const weights: Record<Category, number> = profile === 'matrix'
    ? { core: 0.14, specialist: 0.10, 'tool-proof': 0.18, orchestration: 0.10, upgrades: 0.07, memory: 0.09, ux: 0.07, 'self-improvement': 0.10, infrastructure: 0.09, 'discord-management': 0.06 }
    : { core: 0.16, specialist: 0.12, 'tool-proof': 0.16, orchestration: 0.10, upgrades: 0.07, memory: 0.07, ux: 0.08, 'self-improvement': 0.10, infrastructure: 0.08, 'discord-management': 0.06 };

  let score = 0;
  for (const key of Object.keys(weights) as Category[]) {
    const row = byCategory.get(key);
    if (!row || row.total === 0) continue;
    score += (row.passed / row.total) * weights[key] * 100;
  }

  const isCritical = (r: TestResult) => r.critical !== false;
  const coreFailures = results.filter((r) => r.category === 'core' && !r.passed && isCritical(r));
  const orchestrationFailures = results.filter((r) => r.category === 'orchestration' && !r.passed && isCritical(r));
  const upgradesFailures = results.filter((r) => r.category === 'upgrades' && !r.passed && isCritical(r));
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

interface FreeformResponse {
  channel: string;
  author: string;
  content: string;
  timestamp: string;
}

interface FreeformResult {
  elapsed: number;
  responses: FreeformResponse[];
  observations: string[];
}

async function runFreeformObservation(
  groupchat: TextChannel,
  allChannels: TextChannel[],
  prompt: string,
  rileyMention: string,
  selfId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  silenceMs?: number,
): Promise<FreeformResult> {
  const started = Date.now();
  const observations: string[] = [];

  // Post the freeform prompt
  const fullPrompt = prompt.includes('@') ? prompt : `${rileyMention} ${prompt}`;
  console.log('\n=== Freeform Observation Mode ===');
  console.log(`Prompt: ${fullPrompt}`);
  console.log(`Timeout: ${timeoutMs / 1000}s`);
  console.log(`Polling: ${monitor ? 'event-driven (LiveMonitor)' : `${pollIntervalMs}ms`}\n`);

  let sent: Message;
  try {
    sent = await groupchat.send(fullPrompt);
    if (monitor) monitor.logSelf(groupchat.name, fullPrompt);
  } catch (err) {
    return {
      elapsed: Date.now() - started,
      responses: [],
      observations: [`Failed to send prompt: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const seenIds = new Set<string>();
  const responses: FreeformResponse[] = [];
  let lastNewResponseAt = Date.now();
  const silenceThresholdMs = silenceMs ?? (timeoutMs > 600_000 ? 600_000 : 300_000); // longer silence window for goal-mode

  console.log('Watching for responses (channels + threads)...\n');

  // Track discovered threads so we poll them on subsequent cycles
  const knownThreadIds = new Set<string>();
  const knownThreads = new Map<string, { thread: any; name: string }>();
  const THREAD_DISCOVERY_INTERVAL = 5; // Re-discover threads every N poll cycles
  let pollCycle = 0;

  while (Date.now() - started < timeoutMs) {
    // ── Discover new threads periodically, always poll known ones ──
    const threadBatches: { msg: Message; channelName: string }[][] = [];
    const shouldDiscoverThreads = pollCycle % THREAD_DISCOVERY_INTERVAL === 0;
    pollCycle++;

    if (shouldDiscoverThreads) {
      try {
        for (const channel of allChannels) {
          const activeThreads = await channel.threads.fetchActive().catch(() => null);
          if (activeThreads) {
            for (const [threadId, thread] of activeThreads.threads) {
              if (knownThreadIds.has(threadId)) continue;
              knownThreadIds.add(threadId);
              knownThreads.set(threadId, { thread, name: thread.name });
              console.log(`  📎 Discovered thread: #${thread.name} (${threadId})`);
            }
          }
        }
      } catch { /* thread enumeration failed */ }
    }

    // Always poll messages from all known threads
    for (const { thread, name } of knownThreads.values()) {
      try {
        const msgs = await thread.messages.fetch({ limit: 30 });
        threadBatches.push([...msgs.values()].map((m: Message) => ({ msg: m, channelName: `🧵${name}` })));
      } catch { /* thread may be inaccessible */ }
    }

    const channelBatches = await Promise.all(
      allChannels.map(async (channel) => {
        try {
          const msgs = await channel.messages.fetch({ limit: 30 });
          return [...msgs.values()].map((m) => ({ msg: m, channelName: channel.name }));
        } catch {
          return [] as { msg: Message; channelName: string }[];
        }
      })
    );

    let foundNew = false;
    for (const { msg, channelName } of [...channelBatches.flat(), ...threadBatches.flat()]) {
      if (seenIds.has(msg.id)) continue;
      if (!isBotOrWebhookReply(msg, sent, selfId)) continue;

      seenIds.add(msg.id);
      foundNew = true;
      lastNewResponseAt = Date.now();

      const content = msg.content || msg.embeds[0]?.description || '';
      const author = msg.author?.username || 'unknown';
      const ts = new Date(msg.createdTimestamp).toISOString();
      const attachments = [...msg.attachments.values()];

      const entry: FreeformResponse = {
        channel: channelName,
        author,
        content: content.slice(0, 4000) + (attachments.length > 0 ? `\n[${attachments.length} attachment(s)]` : ''),
        timestamp: ts,
      };
      responses.push(entry);

      const preview = content.slice(0, 120).replace(/\n/g, ' ');
      console.log(`  [${channelName}] ${author}: ${preview}${content.length > 120 ? '...' : ''}`);

      // Detect pain points automatically
      if (content.length >= 1900) observations.push(`Long message (${content.length} chars) in #${channelName} by ${author} — likely split`);
      if (/quality check|quality retry/i.test(content)) observations.push(`Quality retry triggered in #${channelName}`);
      if (/timed out|timeout/i.test(content)) observations.push(`Timeout detected in #${channelName}`);
      if (/did not generate a usable message/i.test(content)) observations.push(`Empty response in #${channelName} by ${author}`);
      if (/blocked.*screenshot|verification.*evidence|runtime.*evidence/i.test(content)) observations.push(`Verification gate blocking in #${channelName}`);
      if (/daily.*limit|budget.*exceeded|quota.*exhausted/i.test(content)) observations.push(`Budget/quota issue in #${channelName}`);
      if (attachments.length > 0) observations.push(`File attachment posted in #${channelName} by ${author}`);
    }

    // If we've had responses and then 2 min silence, consider it done
    if (responses.length > 0 && Date.now() - lastNewResponseAt > silenceThresholdMs) {
      console.log(`\n5 minutes of silence after ${responses.length} responses — ending observation.`);
      break;
    }

    await sleep(pollIntervalMs);
  }

  const elapsed = Date.now() - started;
  console.log(`\nObservation complete: ${responses.length} responses in ${(elapsed / 1000).toFixed(1)}s`);
  if (observations.length > 0) {
    console.log('\nAuto-detected observations:');
    for (const obs of observations) console.log(`  ⚠ ${obs}`);
  }

  return { elapsed, responses, observations };
}

// ── Recursive engine helpers ────────────────────────────────────────────────

/**
 * Read the most recent smoke report JSON and extract the set of failed test keys.
 * Returns an empty set if no report exists or all tests passed.
 */
function getFailedKeysFromLastReport(): Set<string> {
  const dir = path.join(process.cwd(), 'smoke-reports');
  if (!fs.existsSync(dir)) return new Set();
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('smoke-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length === 0) return new Set();

  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8'));
    const failed = new Set<string>();
    for (const r of data.results || []) {
      if (!r.passed) {
        // Reverse-lookup the test key from agent name + capability
        const match = AGENT_CAPABILITY_TESTS.find(
          (t) => t.capability === r.capability && getAgentName(t.id) === r.agent,
        );
        if (match) failed.add(testKey(match));
      }
    }
    console.log(`📄 Last report: ${files[0]} — ${(data.results || []).length} tests, ${failed.size} failed`);
    return failed;
  } catch (err) {
    console.warn(`⚠ Failed to parse last smoke report: ${err instanceof Error ? err.message : String(err)}`);
    return new Set();
  }
}

/**
 * Suggest a concrete fix action for each failure category.
 */
function suggestFix(result: TestResult): string {
  const cat = result.failureCategory || categorizeFailure(result.reason);
  switch (cat) {
    case 'PATTERN_MISMATCH':
      return `Broaden expectAny/expectAll regex for "${result.capability}", or verify the agent prompt produces the expected pattern. Snippet: "${result.snippet?.slice(0, 100)}"`;
    case 'TOOL_AUDIT_MISSING':
      return `Verify tool is in agent's toolset (agents.ts). Check bot.ts setToolAuditCallback emits [TOOL:name]. The agent may not have invoked the tool — check if the prompt is specific enough.`;
    case 'TIMEOUT':
      return `Agent did not respond in time. Check PM2 logs for errors, Claude API rate limits, or bot crash. Consider increasing timeoutMs for this test or marking as heavyTool.`;
    case 'TOKEN_ECHO_MISSING':
      return `Bot response didn't contain the expected confirmation token. Check if the agent's response was truncated or if the token pattern is too strict.`;
    case 'BOT_UNAVAILABLE':
      return `Bot produced fewer replies than expected. Check if bot is running (pm2 status), if the channel exists, and if the agent is routing correctly.`;
    case 'QUALITY_CHECK_FAILED':
      return `Response hit a quality/capacity filter. Check Claude API quota, daily budget limits, or content moderation triggers.`;
    case 'SEND_FAILED':
      return `Could not send the test prompt to Discord. Check bot permissions, channel existence, and rate limits.`;
    default:
      return `Unknown failure — check PM2 logs and bot console output for errors.`;
  }
}

/**
 * Capture PM2 logs from the bot VM for the test window via SSH.
 * Returns the log text or an error message.
 */
async function capturePm2LogsFromVM(testStartedAt: string): Promise<string> {
  const { execSync } = await import('child_process');
  const zone = process.env.GCP_VM_ZONE || 'australia-southeast1-c';
  const vmName = process.env.GCP_VM_NAME || 'asap-bot-vm';
  const project = process.env.GCP_PROJECT || 'asap-489910';

  try {
    // Get the last 300 lines of PM2 logs (covers ~10-15 min of activity)
    const cmd = `gcloud compute ssh ${vmName} --zone=${zone} --project=${project} --command="pm2 logs asap-bot --lines 300 --nostream 2>&1" --quiet 2>&1`;
    const output = execSync(cmd, { timeout: 30_000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    return output;
  } catch (err) {
    return `⚠ PM2 log capture failed: ${err instanceof Error ? err.message : String(err)}`;
  }
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
  pm2Logs?: string;
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
    const tag = r.flaky ? ' [FLAKY]' : '';
    const cat = r.failureCategory ? ` [${r.failureCategory}]` : '';
    const retryTag = r.retryPassed ? ' (retry-pass)' : '';
    lines.push(`- ${r.passed ? 'PASS' : 'FAIL'}${retryTag}${tag}${cat} | ${r.agent} | ${r.category}/${r.capability} | ${r.reason || 'ok'}`);
  }

  // Failure breakdown by category
  const failedResults = report.results.filter((r) => !r.passed);
  if (failedResults.length > 0) {
    lines.push('');
    lines.push('## Failure Breakdown');
    const byCategory = new Map<string, number>();
    for (const r of failedResults) {
      const cat = r.failureCategory || 'UNKNOWN';
      byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
    }
    for (const [cat, count] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${cat}: ${count}`);
    }
    const flakyFails = failedResults.filter((r) => r.flaky);
    if (flakyFails.length > 0) {
      lines.push(`- Known flaky (excluded from critical gate): ${flakyFails.length}`);
    }

    // Fix suggestions for each failure
    lines.push('');
    lines.push('## Fix Suggestions');
    for (const r of failedResults) {
      lines.push(`- **${r.agent}/${r.capability}** [${r.failureCategory || 'UNKNOWN'}]: ${suggestFix(r)}`);
    }

    // Rerun command
    lines.push('');
    lines.push('## Rerun Failed Tests');
    lines.push('```sh');
    lines.push('npm run discord:test:dist -- --rerun-failed');
    lines.push('```');
  }
  lines.push('');
  lines.push('## Extra Checks');
  for (const e of report.extras) {
    lines.push(`- ${e.passed ? 'PASS' : 'FAIL'} | ${e.name} | critical=${e.critical} | ${e.detail}`);
  }

  if (report.pm2Logs) {
    lines.push('');
    lines.push('## Bot PM2 Logs (last 300 lines)');
    lines.push('');
    lines.push('<details><summary>PM2 log output</summary>');
    lines.push('');
    lines.push('```');
    lines.push(report.pm2Logs.slice(-15000)); // Cap at 15KB to keep report manageable
    lines.push('```');
    lines.push('');
    lines.push('</details>');
  }

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf-8');
  return { jsonPath, mdPath };
}

async function postSuccessResetAndAnnounce(token: string, guildId: string, groupchat: TextChannel, guild?: Guild): Promise<string> {
  const cleanup = await preClearGuildChannels(token, guildId);
  const totalDeleted = cleanup.reduce((sum, row) => sum + row.deleted, 0);
  if (guild) {
    try {
      await setupChannels(guild);
    } catch (err) {
      console.warn(`setupChannels failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await groupchat.send('✅ Full smoke suite complete — all tests passed. Channels reset and ready for development.').catch(() => {});
  return `channels=${cleanup.length} deleted=${totalDeleted}${guild ? ' repopulated=true' : ''}`;
}

async function executeSingleTest(
  test: AgentCapabilityTest,
  groupchat: TextChannel,
  candidateChannels: TextChannel[],
  terminal: TextChannel | undefined,
  upgrades: TextChannel | undefined,
  roleMentions: Map<string, string>,
  selfId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  capabilityAttempts: number,
  interTestDelayMs: number,
  sendToChannel?: TextChannel,
): Promise<TestResult> {
  const mention = roleMentions.get(test.id) || `@${getAgent(test.id as never)?.handle || test.id}`;
  const agentChannelName = getAgent(test.id as never)?.channelName;
  const agentChannel = agentChannelName
    ? candidateChannels.find((channel) => channel.name === agentChannelName)
      || candidateChannels.find((channel) => channel.name.toLowerCase().includes(test.id.toLowerCase()))
      || candidateChannels.find((channel) => channel.name.toLowerCase().includes((getAgent(test.id as never)?.handle || '').toLowerCase()))
    : undefined;

  const effectiveSendChannel = sendToChannel || groupchat;
  const responseChannels = sendToChannel
    ? [sendToChannel]
    : agentChannel ? [groupchat, agentChannel] : [groupchat];

  if (!roleMentions.get(test.id)) {
    console.warn(`Role mention not found for ${test.id}; falling back to handle ${mention}`);
  }
  const sendChName = effectiveSendChannel.name;
  const watchChNames = responseChannels.map((ch) => ch.name).join(', ');
  process.stdout.write(`Testing ${getAgentName(test.id)} :: ${test.category}/${test.capability} [send:#${sendChName} watch:#${watchChNames}] ... `);

  const effectiveTimeoutMs = test.timeoutMs ?? timeoutMs;
  let result: { passed: boolean; elapsed: number; snippet: string; reason?: string } = {
    passed: false,
    elapsed: 0,
    snippet: 'not run',
  };
  for (let attempt = 1; attempt <= (test.attempts ?? capabilityAttempts); attempt += 1) {
    if (attempt > 1) {
      process.stdout.write(`retry ${attempt}/${test.attempts ?? capabilityAttempts} ... `);
      await sleep(600);
    }
    const attemptTimeoutMs = attempt === 1
      ? effectiveTimeoutMs
      : Math.min(Math.max(Math.floor(effectiveTimeoutMs * 1.2), effectiveTimeoutMs + 10_000), 300_000);
    result = await runCapabilityTest(
      effectiveSendChannel,
      responseChannels,
      terminal,
      upgrades,
      test,
      mention,
      selfId,
      attemptTimeoutMs,
      pollIntervalMs,
    );
    if (result.passed) break;
  }

  const retryPassed = result.passed && (test.attempts ?? capabilityAttempts) > 1;
  console.log(`${result.passed ? (retryPassed ? 'FLAKY-PASS' : 'PASS') : 'FAIL'} (${(result.elapsed / 1000).toFixed(1)}s)`);
  console.log(`  -> ${result.snippet}`);
  if (!result.passed && result.reason) {
    console.log(`  -> Failure: [${categorizeFailure(result.reason)}] ${result.reason}`);
  }

  await sleep(interTestDelayMs);

  return {
    agent: getAgentName(test.id),
    capability: test.capability,
    category: test.category,
    passed: result.passed,
    elapsed: result.elapsed,
    snippet: result.snippet,
    reason: result.reason,
    critical: test.flaky ? false : test.critical,
    failureCategory: result.passed ? undefined : categorizeFailure(result.reason),
    flaky: test.flaky,
    retryPassed,
  };
}

async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  const token = process.env.DISCORD_TEST_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  const profile = getSmokeProfile();
  const timeoutMs = getTestTimeoutMs(profile);
  const preClear = shouldPreClear(profile);
  const runElevenApi = shouldRunElevenLabsCheck();
  const runElevenTts = shouldRunElevenLabsTtsCheck();
  const runVoiceBridge = shouldRunVoiceBridgeCheck(profile);
  const runVoiceActive = shouldRunActiveVoiceCallCheck();
  const runVoiceRoundTrip = shouldRunVoiceRoundTripCheck();
  const runPostSuccessAction = shouldRunPostSuccessResetAndAnnounce();
  const requireLiveRouter = shouldRequireLiveRouter(profile);
  const routerHealthTimeoutMs = getRouterHealthTimeoutMs(profile);
  const capabilityAttempts = getCapabilityAttempts(profile);
  const budgetBoostAmount = getBudgetBoostAmount(profile);
  const interTestDelayMs = getInterTestDelayMs(profile);
  const pollIntervalMs = getPollIntervalMs(profile);
  const agentFilter = process.argv.find((a) => a.startsWith('--agent='))?.slice('--agent='.length);
  const testsFilter = process.argv.find((a) => a.startsWith('--tests='))?.slice('--tests='.length);
  const freeformPrompt = process.argv.find((a) => a.startsWith('--prompt='))?.slice('--prompt='.length)
    || process.argv.find((a) => a.startsWith('--goal='))?.slice('--goal='.length);
  const isGoalMode = process.argv.some((a) => a.startsWith('--goal='));
  const rerunFailed = process.argv.includes('--rerun-failed');
  const capturePm2Logs = process.argv.includes('--pm2-logs');
  const freeformTimeoutMs = parseInt(process.env.DISCORD_SMOKE_FREEFORM_TIMEOUT_MS || (isGoalMode ? '3600000' : '600000'), 10);
  const freeformSilenceMs = parseInt(process.env.DISCORD_SMOKE_FREEFORM_SILENCE_MS || (isGoalMode ? '600000' : '300000'), 10);

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

  // ── Initialize live monitor for event-driven test observation ──
  monitor = new LiveMonitor(client, client.user!.id);
  monitor.registerChannels(candidateChannels);
  console.log(`📡 Live monitor active — watching ${candidateChannels.length} channels in real-time`);

  const hygiene = await assertChannelHygiene(guild, profile);

  console.log('\n=== ASAP Agent Full Capability Smoke Matrix ===');
  console.log(`Profile               : ${profile}`);
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
  console.log(`Voice round-trip      : ${runVoiceRoundTrip ? 'enabled' : 'disabled'}`);
  console.log(`Voice active-call     : ${runVoiceActive ? 'enabled' : 'disabled'}`);
  console.log(`Capability attempts   : ${capabilityAttempts}`);
  console.log(`Poll interval        : ${monitor ? 'event-driven (LiveMonitor)' : `${pollIntervalMs}ms`}`);
  console.log(`Budget boost          : ${budgetBoostAmount > 0 ? `$${budgetBoostAmount}` : 'disabled'}`);
  console.log(`Require live router   : ${requireLiveRouter ? 'enabled' : 'disabled'}`);
  console.log(`Router health timeout : ${Math.round(routerHealthTimeoutMs / 1000)}s`);
  console.log(`Post-success reset+announce: ${runPostSuccessAction ? 'enabled' : 'disabled'}`);
  if (agentFilter) console.log(`Filter                : --agent=${agentFilter}`);
  if (testsFilter) console.log(`Filter                : --tests=${testsFilter}`);
  if (rerunFailed) console.log(`Rerun failed          : enabled`);
  if (capturePm2Logs) console.log(`PM2 log capture       : enabled`);
  if (freeformPrompt) console.log(`Freeform prompt       : ${freeformPrompt.slice(0, 80)}${freeformPrompt.length > 80 ? '...' : ''}`);

  if (budgetBoostAmount > 0) {
    await groupchat.send(`approve budget $${budgetBoostAmount} for smoke test run`).catch(() => {});
    await sleep(1500);
  }

  const roleMentions = new Map<string, string>();
  for (const test of AGENT_CAPABILITY_TESTS) {
    const mention = resolveRoleMentionForAgent(guild, test.id);
    if (mention) roleMentions.set(test.id, mention);
  }

  if (requireLiveRouter) {
    const routerMention = roleMentions.get('executive-assistant') || '@riley';
    const health = await verifyLiveRouter(groupchat, routerMention, client.user!.id, routerHealthTimeoutMs);
    if (!health.ok) {
      await client.destroy();
      throw new Error(`Router health check failed: ${health.detail}. Start the main Discord bot (server dev/prod) before running smoke.`);
    }
  }

  // ── Freeform prompt mode: post a custom message, observe all agent responses ──
  if (freeformPrompt) {
    console.log(`${isGoalMode ? '🎯 Goal' : '💬 Freeform'} mode — timeout ${Math.round(freeformTimeoutMs / 60000)}min, silence threshold ${Math.round(freeformSilenceMs / 60000)}min`);
    const freeformResult = await runFreeformObservation(
      groupchat,
      candidateChannels,
      freeformPrompt,
      roleMentions.get('executive-assistant') || '@riley',
      client.user!.id,
      freeformTimeoutMs,
      pollIntervalMs,
      freeformSilenceMs,
    );

    const dir = ensureReportsDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const mdPath = path.join(dir, `freeform-${stamp}.md`);

    const mdLines: string[] = [];
    mdLines.push('# Freeform Observation Report');
    mdLines.push('');
    mdLines.push(`Started: ${startedAt}`);
    mdLines.push(`Ended: ${new Date().toISOString()}`);
    mdLines.push(`Elapsed: ${((freeformResult.elapsed) / 1000).toFixed(1)}s`);
    mdLines.push('');
    mdLines.push('## Prompt');
    mdLines.push('');
    mdLines.push(`> ${freeformPrompt}`);
    mdLines.push('');
    mdLines.push(`## Responses (${freeformResult.responses.length})`);
    mdLines.push('');
    for (const resp of freeformResult.responses) {
      mdLines.push(`### ${resp.channel} — ${resp.author} (${resp.timestamp})`);
      mdLines.push('');
      mdLines.push(resp.content);
      mdLines.push('');
    }
    if (freeformResult.observations.length > 0) {
      mdLines.push('## Observations');
      mdLines.push('');
      for (const obs of freeformResult.observations) {
        mdLines.push(`- ${obs}`);
      }
      mdLines.push('');
    }

    fs.writeFileSync(mdPath, mdLines.join('\n'), 'utf-8');
    console.log(`\nFreeform report: ${mdPath}`);
    await client.destroy();
    process.exit(0);
  }

  const profileTests = profile === 'readiness'
    ? AGENT_CAPABILITY_TESTS.filter((test) => READINESS_TEST_KEYS.has(testKey(test)))
    : AGENT_CAPABILITY_TESTS;

  let testsToRun = agentFilter
    ? profileTests.filter(
        (t) => t.id === agentFilter
          || resolveAgentId(agentFilter || '') === t.id
          || getAgentName(t.id).toLowerCase().includes(agentFilter.toLowerCase())
      )
    : testsFilter
    ? profileTests.filter((t) => {
        const caps = testsFilter.split(',').map((s) => s.trim().toLowerCase());
        return caps.some((c) => t.capability.toLowerCase() === c || testKey(t).toLowerCase().includes(c));
      })
    : profileTests;

  // ── --rerun-failed: read the most recent smoke report, filter to only failed tests ──
  if (rerunFailed) {
    const failedKeys = getFailedKeysFromLastReport();
    if (failedKeys.size === 0) {
      console.log('⚠ --rerun-failed: no previous failures found (or no smoke report exists). Running all tests.');
    } else {
      testsToRun = testsToRun.filter((t) => failedKeys.has(testKey(t)));
      console.log(`🔄 --rerun-failed: ${failedKeys.size} failures found → running ${testsToRun.length} matching tests`);
    }
  }

  if (testsToRun.length === 0) {
    await client.destroy();
    throw new Error(`No agents matched filter: ${agentFilter}`);
  }

  const results: TestResult[] = [];

  if (profile === 'matrix') {
    // ── Matrix profile: parallel execution via agent channels ──
    const groupchatTests = testsToRun.filter(
      (t) => t.id === 'executive-assistant' || t.category === 'orchestration',
    );
    const agentChannelTests = testsToRun.filter(
      (t) => t.id !== 'executive-assistant' && t.category !== 'orchestration' && !t.heavyTool,
    );
    const heavyToolTests = testsToRun.filter(
      (t) => t.id !== 'executive-assistant' && t.category !== 'orchestration' && t.heavyTool,
    );

    // Phase 1: Groupchat tests (serial — Riley + orchestration)
    const phase1Start = Date.now();
    console.log(`\n--- Matrix Phase 1: ${groupchatTests.length} groupchat tests (serial) ---`);
    let failFastTriggered = false;
    for (const test of groupchatTests) {
      // Fail-fast: after running all core tests, if >60% failed, skip remaining tool-proof tests
      if (!failFastTriggered && test.category !== 'core' && test.category !== 'orchestration') {
        const coreResults = results.filter((r) => r.category === 'core');
        if (coreResults.length >= 8) {
          const coreFailed = coreResults.filter((r) => !r.passed).length;
          if (coreFailed / coreResults.length > 0.6) {
            failFastTriggered = true;
            console.log(`\n⚡ FAIL-FAST: ${coreFailed}/${coreResults.length} core tests failed (>${60}%). Skipping remaining Phase 1 tool-proof tests.`);
          }
        }
      }
      if (failFastTriggered && test.category !== 'core' && test.category !== 'orchestration') {
        results.push({
          agent: getAgentName(test.id),
          capability: test.capability,
          category: test.category,
          passed: false,
          elapsed: 0,
          snippet: 'SKIPPED (fail-fast)',
          reason: 'Skipped due to fail-fast: too many core test failures',
          critical: test.critical,
        });
        continue;
      }
      results.push(
        await executeSingleTest(
          test, groupchat, candidateChannels, terminal, upgrades, roleMentions,
          client.user!.id, timeoutMs, pollIntervalMs, capabilityAttempts, interTestDelayMs,
        ),
      );
    }

    // ── Health-check gate between Phase 1 and Phase 2 ──
    const phase1Elapsed = ((Date.now() - phase1Start) / 1000).toFixed(1);
    const phase1Passed = results.filter((r) => r.passed).length;
    const phase1Failed = results.length - phase1Passed;
    console.log(`\n  Phase 1 complete: ${phase1Passed} passed, ${phase1Failed} failed in ${phase1Elapsed}s (${monitor?.totalEvents ?? 0} events captured)`);
    console.log('  Verifying bot responsiveness before Phase 2...');
    const rileyMentionGate = roleMentions.get('executive-assistant') || '@riley';
    const phase2Gate = await verifyLiveRouter(groupchat, rileyMentionGate, client.user!.id, 30_000);
    if (!phase2Gate.ok) {
      console.warn('  ⚠ Bot unresponsive after Phase 1 — waiting 15s before continuing');
      await sleep(15_000);
    } else {
      console.log('  ✓ Bot responsive');
      await sleep(3_000); // Brief cooldown between phases
    }

    // Phase 2: Agent channel tests (parallel by agent)
    const phase2Start = Date.now();
    console.log(`\n--- Matrix Phase 2: ${agentChannelTests.length} agent channel tests (parallel by agent) ---`);
    const testsByAgent = new Map<string, AgentCapabilityTest[]>();
    for (const test of agentChannelTests) {
      if (!testsByAgent.has(test.id)) testsByAgent.set(test.id, []);
      testsByAgent.get(test.id)!.push(test);
    }
    console.log(`  Agents (${testsByAgent.size}): ${[...testsByAgent.keys()].map((id) => `${getAgentName(id)}(${testsByAgent.get(id)!.length})`).join(', ')}`);

    const parallelResults = await Promise.all(
      [...testsByAgent.entries()].map(async ([agentId, agentTests]) => {
        const agentChannelName = getAgent(agentId as never)?.channelName;
        const sendChannel = agentChannelName
          ? candidateChannels.find((ch) => ch.name === agentChannelName)
            || candidateChannels.find((ch) => ch.name.toLowerCase().includes(agentId.toLowerCase()))
            || candidateChannels.find((ch) => ch.name.toLowerCase().includes((getAgent(agentId as never)?.handle || '').toLowerCase()))
          : undefined;

        const agentResults: TestResult[] = [];
        for (const test of agentTests) {
          agentResults.push(
            await executeSingleTest(
              test, groupchat, candidateChannels, terminal, upgrades, roleMentions,
              client.user!.id, timeoutMs, pollIntervalMs, capabilityAttempts, interTestDelayMs,
              sendChannel || groupchat,
            ),
          );
        }
        return agentResults;
      }),
    );
    results.push(...parallelResults.flat());

    // Phase 2 summary
    {
      const phase2Elapsed = ((Date.now() - phase2Start) / 1000).toFixed(1);
      const p2results = parallelResults.flat();
      const p2passed = p2results.filter((r) => r.passed).length;
      console.log(`\n  Phase 2 complete: ${p2passed}/${p2results.length} passed in ${phase2Elapsed}s (${monitor?.totalEvents ?? 0} total events)`);
    }

    // Phase 3: Heavy tool tests (serial — CPU-intensive commands need dedicated VM resources)
    if (heavyToolTests.length > 0) {
      // ── Health-check gate between Phase 2 and Phase 3 ──
      console.log('\n  Verifying bot responsiveness before Phase 3...');
      const phase3Gate = await verifyLiveRouter(groupchat, rileyMentionGate, client.user!.id, 30_000);
      if (!phase3Gate.ok) {
        console.warn('  ⚠ Bot unresponsive after Phase 2 — waiting 15s before continuing');
        await sleep(15_000);
      } else {
        console.log('  ✓ Bot responsive');
        await sleep(3_000);
      }

      const phase3Start = Date.now();
      console.log(`\n--- Matrix Phase 3: ${heavyToolTests.length} heavy tool tests (serial) ---`);
      for (const test of heavyToolTests) {
        const agentChannelName = getAgent(test.id as never)?.channelName;
        const sendChannel = agentChannelName
          ? candidateChannels.find((ch) => ch.name === agentChannelName)
            || candidateChannels.find((ch) => ch.name.toLowerCase().includes(test.id.toLowerCase()))
            || candidateChannels.find((ch) => ch.name.toLowerCase().includes((getAgent(test.id as never)?.handle || '').toLowerCase()))
          : undefined;
        results.push(
          await executeSingleTest(
            test, groupchat, candidateChannels, terminal, upgrades, roleMentions,
            client.user!.id, timeoutMs, pollIntervalMs, capabilityAttempts, interTestDelayMs,
            sendChannel || groupchat,
          ),
        );
      }
      const phase3Elapsed = ((Date.now() - phase3Start) / 1000).toFixed(1);
      const p3passed = results.slice(-heavyToolTests.length).filter((r) => r.passed).length;
      console.log(`\n  Phase 3 complete: ${p3passed}/${heavyToolTests.length} passed in ${phase3Elapsed}s`);
    }
  } else {
    // ── Standard serial execution (full / readiness profiles) ──
    for (const test of testsToRun) {
      results.push(
        await executeSingleTest(
          test, groupchat, candidateChannels, terminal, upgrades, roleMentions,
          client.user!.id, timeoutMs, pollIntervalMs, capabilityAttempts, interTestDelayMs,
        ),
      );
    }
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

  if (runVoiceRoundTrip) {
    process.stdout.write('Testing voice round-trip (join → TTS → leave) ... ');
    const rileyMention = roleMentions.get('executive-assistant') || '@riley';
    const r = await runVoiceRoundTripCheck(groupchat, rileyMention, client.user!.id, Math.min(timeoutMs, 120000));
    extras.push(r);
    console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.detail}`);
  }

  const capabilityPassed = results.filter((r) => r.passed).length;
  const capabilityFailed = results.length - capabilityPassed;
  const extraFailed = extras.filter((e) => !e.passed).length;
  const readiness = buildReadinessSummary(results, extras, profile);

  console.log('\n=== Full Smoke Summary ===');
  console.log(`Capabilities: ${capabilityPassed} passed, ${capabilityFailed} failed`);
  const flakyPassed = results.filter((r) => r.retryPassed).length;
  const flakyFailed = results.filter((r) => !r.passed && r.flaky).length;
  if (flakyPassed > 0) console.log(`  Flaky passes (retry-pass): ${flakyPassed}`);
  if (flakyFailed > 0) console.log(`  Known-flaky failures (excluded from critical): ${flakyFailed}`);
  console.log(`Extra checks: ${extras.length - extraFailed} passed, ${extraFailed} failed`);
  console.log(`Readiness score: ${readiness.score}`);
  console.log(`Critical gates passed: ${readiness.criticalPassed}`);
  console.log(`Critical detail: ${readiness.detail}`);

  // Failure breakdown by category
  const failedByCategory = new Map<string, number>();
  for (const r of results.filter((r) => !r.passed)) {
    const cat = r.failureCategory || 'UNKNOWN';
    failedByCategory.set(cat, (failedByCategory.get(cat) || 0) + 1);
  }
  if (failedByCategory.size > 0) {
    console.log('\nFailure breakdown:');
    for (const [cat, count] of [...failedByCategory.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat}: ${count}`);
    }

    // Print fix suggestions for failed tests
    console.log('\n📋 Fix Suggestions:');
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ${r.agent}/${r.capability}: ${suggestFix(r)}`);
    }
  }

  // ── Capture PM2 logs from bot VM if requested ──
  let pm2LogOutput: string | undefined;
  if (capturePm2Logs) {
    console.log('\n📦 Capturing PM2 logs from bot VM...');
    pm2LogOutput = await capturePm2LogsFromVM(startedAt);
    const lineCount = pm2LogOutput.split('\n').length;
    console.log(`  Captured ${lineCount} lines of PM2 logs`);
  }

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
      profile,
      preClear,
      runElevenApi,
      runElevenTts,
      runVoiceBridge,
      runVoiceActive,
      runVoiceRoundTrip,
      capabilityAttempts,
      runPostSuccessAction,
      agentFilter: agentFilter || null,
      rerunFailed,
      capturePm2Logs,
    },
    pm2Logs: pm2LogOutput,
  });

  console.log(`Report JSON: ${reportPaths.jsonPath}`);
  console.log(`Report MD  : ${reportPaths.mdPath}`);

  // Print live monitor summary
  if (monitor) {
    monitor.printSummary();
    monitor.destroy();
    monitor = null;
  }

  if (readiness.criticalPassed && (runPostSuccessAction || profile === 'matrix')) {
    const post = await postSuccessResetAndAnnounce(token, guildId, groupchat, guild);
    console.log(`Post-success reset+announce complete: ${post}`);
  }

  await client.destroy();
  const strictPass = readiness.criticalPassed && capabilityFailed === 0 && extraFailed === 0;
  const readinessPass = profile === 'readiness' && readiness.criticalPassed;
  process.exit(strictPass || readinessPass ? 0 : 1);
}

void run().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
