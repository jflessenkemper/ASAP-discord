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
 *   DISCORD_SMOKE_REQUIRE_LIVE_ROUTER          optional (readiness default true)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import { ChannelType, Client, GatewayIntentBits, Guild, Message, TextChannel, ThreadChannel } from 'discord.js';

import { getAgent, getAgentAliases, resolveAgentId } from './agents';
import { setupChannels } from './setup';

type CheckPattern = RegExp;
type Category = 'core' | 'specialist' | 'tool-proof' | 'orchestration' | 'upgrades' | 'memory';
type SmokeProfile = 'full' | 'readiness' | 'matrix';

interface AgentCapabilityTest {
  id: string;
  category: Category;
  capability: string;
  prompt: string;
  expectAny?: CheckPattern[];
  expectAll?: CheckPattern[];
  expectNone?: CheckPattern[];
  requireTokenEcho?: boolean;
  expectToolAudit?: string[];
  expectUpgradesPost?: boolean;
  minBotRepliesAfterPrompt?: number;
  timeoutMs?: number;
  heavyTool?: boolean;
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
    prompt: 'In a single reply, mention delegating a code task to Ace and a validation task to QA.',
    expectAny: [/ace|developer/i, /qa|max/i],
    requireTokenEcho: false,
  },
  {
    id: 'executive-assistant',
    category: 'orchestration',
    capability: 'ace-only-delegation',
    prompt: 'You need security and QA help. Under your delegation policy you must route ALL execution through Ace only. Explain how you would delegate this through Ace in one short reply.',
    expectAny: [/ace|developer|delegat/i],
    expectNone: [/@kane|@max|@raj|@elena|@kai|@jude|@liv|@harper|@mia|@leo/i],
    requireTokenEcho: false,
    timeoutMs: 240_000,
  },
  {
    id: 'executive-assistant',
    category: 'memory',
    capability: 'repo-memory-evidence',
    prompt: 'Personally execute repo_memory_index and then repo_memory_search with query="setupChannels" right now (do NOT delegate). Reply with one source key or filename from the search results.',
    expectAny: [/setupchannels|channel|server|src|setup|source|key|file/i],
    expectToolAudit: ['repo_memory_index', 'repo_memory_search'],
    timeoutMs: 180_000,
  },

  {
    id: 'developer',
    category: 'core',
    capability: 'evidence-format-contract',
    prompt: 'Return ONLY this exact plain-text structure (no markdown headers):\nResult: <one sentence outcome>\nEvidence: <files changed or tests run>\nRisk/Follow-up: <caveats or next checks>',
    expectAll: [/\bresults?\s*:/i, /\bevidence\s*:/i, /\brisk|follow.?up/i],
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
    prompt: 'Use the send_channel_message tool to post one blocker-removal or token-saving improvement line in the #upgrades channel. You MUST include the exact smoke-token string in the message body.',
    expectUpgradesPost: true,
    timeoutMs: 180_000,
  },

  {
    id: 'qa',
    category: 'specialist',
    capability: 'regression-test-design',
    prompt: 'Provide one high-risk regression test for jobs matching in one sentence.',
    expectAny: [/regression|edge.?case|negative|timeout|retry|test|assert|expect|verif|valid|scenario|fail|bound/i],
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
    prompt: 'Name the single most important WCAG accessibility criterion to test first and explain why in one sentence.',
    expectAny: [/contrast|keyboard|screen.?reader|touch.?target|wcag|aria|focus|color|font|label|alt.?text|tab.?order|heading|semantic|navigation|landmark|role/i],
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
    expectAny: [/transaction|rollback|lock|backfill|index|migration|safe|wrap/i],
    timeoutMs: 240_000,
  },
  {
    id: 'performance',
    category: 'specialist',
    capability: 'measurement',
    prompt: 'Name one metric you would track first for app performance.',
    expectAny: [/latency|fps|memory|p95|p99|lighthouse|ttfb|throughput|response.?time|render|frame|time.?to.?first|tti|fcp|lcp|cls|inp|bundle|cpu|load|speed|perf|metric|network|request|duration|apdex|error.?rate|uptime/i],
    requireTokenEcho: false,
  },
  {
    id: 'devops',
    category: 'tool-proof',
    capability: 'tool-audit-proof',
    prompt: 'Run the gcp_run_describe tool now and summarize the deployment status in one sentence.',
    expectAny: [/cloud run|revision|traffic|ready|service|deploy|active|serving|running|status|gcp|container/i],
    expectToolAudit: ['gcp_run_describe'],
    timeoutMs: 180_000,
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
    expectAny: [/control|independent|abn|super|entitlement|contractor|employ|worker|tax|leave|direction|hours|own tools|business|sham|fair work/i],
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

  // ── Matrix-extended tests (26 additional tests) ──

  // Riley core: ACTION tags
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'action-status',
    prompt: 'Show current goal status and active threads.',
    expectAny: [/\[ACTION:STATUS\]|\[ACTION:THREADS\]|goal|status|thread|active/i],
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'action-agents',
    prompt: 'List all available agents on this team.',
    expectAny: [/\[ACTION:AGENTS\]|ace|riley|kane|max|developer|qa/i],
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'action-health',
    prompt: 'What is the current deployment health status? Reply directly without delegating.',
    expectAny: [/\[ACTION:HEALTH\]|health|cloud run|deployment|status|running|ready|online/i],
    timeoutMs: 150_000,
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'action-urls',
    prompt: 'Show me the app URLs and Cloud Build console links.',
    expectAny: [/\[ACTION:URLS\]|url|console|cloud build|http/i],
    timeoutMs: 150_000,
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'action-limits',
    prompt: 'Show the current budget and token usage.',
    expectAny: [/\[ACTION:LIMITS\]|budget|token|usage|limit/i],
    timeoutMs: 150_000,
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'context-report',
    prompt: 'Show the current context efficiency.',
    expectAny: [/\[ACTION:CONTEXT\]|context|efficiency|token|usage/i],
    timeoutMs: 150_000,
  },

  // Ace developer: tool-proof tests
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'read-and-summarize',
    prompt: 'Use read_file to read server/src/routes/health.ts and summarize its exports in one line.',
    expectAny: [/health|export|route|function|handler/i],
    expectToolAudit: ['read_file'],
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'search-codebase',
    prompt: 'Use search_files to find all Express route handlers that use authentication middleware, reply with one file path.',
    expectAny: [/server\/src\/routes|\.ts|auth|middleware/i],
    expectToolAudit: ['search_files'],
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'typecheck-execution',
    prompt: 'Run typecheck on the server and report pass or fail in one line.',
    expectAny: [/pass|fail|error|success|clean|no issues/i],
    expectToolAudit: ['typecheck'],
    heavyTool: true,
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'run-tests-execution',
    prompt: 'Use run_tests right now and report the result summary in one line.',
    expectAny: [/\d+\s*(pass|tests?|suites?|fail)|all.*pass|test.*completed|test.*ran|result.*test/i],
    expectToolAudit: ['run_tests'],
    heavyTool: true,
    timeoutMs: 240_000,
  },
  {
    id: 'developer',
    category: 'specialist',
    capability: 'design-deliverable',
    prompt: 'Create a minimal health-check HTML snippet (just a div with id=\'status\' showing \'OK\') and return it. This is a design spec task.',
    expectAny: [/<div|id=.status.|OK|html/i],
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'db-schema-inspect',
    prompt: 'Use db_schema to inspect the database and name three tables.',
    expectAny: [/table|schema|users|jobs|fuel/i],
    expectToolAudit: ['db_schema'],
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'git-branch-awareness',
    prompt: "Use run_command to run 'git log --oneline -3' and summarize the last 3 commits.",
    expectAny: [/commit|merge|feat|fix|chore|refactor/i],
    expectToolAudit: ['run_command'],
  },

  // Security auditor: code review
  {
    id: 'security-auditor',
    category: 'tool-proof',
    capability: 'code-review',
    prompt: 'Use read_file to read server/src/routes/auth.ts and identify one security concern in one sentence.',
    expectAny: [/auth|security|vulnerab|inject|token|password|concern/i],
    expectToolAudit: ['read_file'],
  },

  // API reviewer: route review
  {
    id: 'api-reviewer',
    category: 'tool-proof',
    capability: 'route-review',
    prompt: 'Use search_files to find REST endpoint definitions in server/src/routes/ and name one that could benefit from pagination.',
    expectAny: [/pagina|limit|offset|cursor|page|endpoint|route/i],
    expectToolAudit: ['search_files'],
  },

  // DBA: schema inspect
  {
    id: 'dba',
    category: 'tool-proof',
    capability: 'schema-inspect',
    prompt: 'Use db_schema to list the tables in the database and name the one most likely to grow fastest.',
    expectAny: [/table|schema|grow|jobs|users|logs/i],
    expectToolAudit: ['db_schema'],
  },

  // Performance: code analysis
  {
    id: 'performance',
    category: 'tool-proof',
    capability: 'code-analysis',
    prompt: 'Use read_file on server/src/services/fuel.ts and identify one potential performance bottleneck in one sentence.',
    expectAny: [/performance|bottleneck|slow|optimi|cache|query|loop|n\+1/i],
    expectToolAudit: ['read_file'],
  },

  // DevOps: deployment inspect + gcp describe
  {
    id: 'devops',
    category: 'tool-proof',
    capability: 'deployment-inspect',
    prompt: 'Use gcp_list_revisions and report the latest revision name in one line. Prefix with TOOL_USED:gcp_list_revisions.',
    expectAll: [/TOOL_USED:gcp_list_revisions/i],
    expectAny: [/revision|rev-|deploy/i],
  },
  {
    id: 'devops',
    category: 'tool-proof',
    capability: 'gcp-describe',
    prompt: 'Use gcp_run_describe to check the current Cloud Run service and report its status in one line.',
    expectAny: [/cloud run|revision|ready|active|service|running/i],
  },

  // iOS: code read
  {
    id: 'ios-engineer',
    category: 'tool-proof',
    capability: 'code-read',
    prompt: 'Use search_files to find any Swift or SwiftUI references in the repository and report what you found in one line.',
    expectAny: [/swift|swiftui|found|no.*references|search|result/i],
    expectToolAudit: ['search_files'],
  },

  // Android: code read
  {
    id: 'android-engineer',
    category: 'tool-proof',
    capability: 'code-read',
    prompt: 'Use search_files to find any Kotlin or Jetpack Compose references in the repository and report what you found in one line.',
    expectAny: [/kotlin|compose|found|no.*references|search|result/i],
    expectToolAudit: ['search_files'],
  },

  // QA: run tests readonly
  {
    id: 'qa',
    category: 'tool-proof',
    capability: 'run-tests-readonly',
    prompt: 'Use run_tests to execute the test suite and report total pass count in one line.',
    expectAny: [/\d+\s*(pass|tests?|suites?)|all.*pass/i],
    expectToolAudit: ['run_tests'],
    heavyTool: true,
  },

  // Orchestration: delegate single specialist
  {
    id: 'executive-assistant',
    category: 'orchestration',
    capability: 'delegate-single-specialist',
    prompt: 'Ask Ace to review the auth route for security concerns.',
    expectAny: [/ace|developer|security|auth|review/i],
    minBotRepliesAfterPrompt: 2,
    requireTokenEcho: false,
  },
  // Orchestration: goal tracking
  {
    id: 'executive-assistant',
    category: 'orchestration',
    capability: 'goal-tracking',
    prompt: 'Give me the current status and any active goals right now.',
    expectAny: [/goal|status|active|none|no.*goal|tracking|idle/i],
    timeoutMs: 150_000,
  },
  // Memory: memory write
  {
    id: 'executive-assistant',
    category: 'memory',
    capability: 'memory-write',
    prompt: "Personally execute the memory_write tool right now (do NOT delegate this). Call it with file='smoke-test-note' and content='smoke test validated all agents'. You must actually invoke the function — do not just describe or claim to have done it. Reply 'done' only after seeing the tool result.",
    expectAny: [/memory|written|saved|confirmed|noted|stored|done/i],
    expectToolAudit: ['memory_write'],
    timeoutMs: 150_000,
  },
  // Orchestration: specialist chain via Ace
  {
    id: 'developer',
    category: 'orchestration',
    capability: 'specialist-chain',
    prompt: 'Without using any tools, write a short paragraph explaining why auth route reviews should involve QA and security specialists. Keep it to 3-4 sentences.',
    expectAny: [/qa|security|review|specialist|audit/i],
    timeoutMs: 120_000,
  },
  // Tool-proof: Riley job search profile + scan
  {
    id: 'executive-assistant',
    category: 'tool-proof',
    capability: 'job-search-profile',
    prompt: 'Use the job_profile_update tool right now to view my current job search profile (call it with no parameters). Then summarize what you see. Do NOT delegate this.',
    expectAny: [/profile|target.?role|salary|location|no.*profile|not.*set/i],
    expectToolAudit: ['job_profile_update'],
    timeoutMs: 150_000,
  },
  {
    id: 'executive-assistant',
    category: 'tool-proof',
    capability: 'job-tracker-summary',
    prompt: 'Use the job_tracker tool right now with action "summary" to check the current job pipeline status. Summarize the result. Do NOT delegate this.',
    expectAny: [/tracker|summary|scan|listing|no.*listing|total|pipeline|status|count/i],
    expectToolAudit: ['job_tracker'],
    timeoutMs: 150_000,
  },
];

const READINESS_TEST_KEYS = new Set([
  'executive-assistant:routing-and-next-step',
  'executive-assistant:repo-memory-tool-awareness',
  'executive-assistant:ace-only-delegation',
  'developer:evidence-format-contract',
  'developer:upgrades-post',
  'qa:regression-test-design',
  'qa:upgrades-post',
  'security-auditor:auth-risk-and-mitigation',
  'security-auditor:upgrades-post',
  'ux-reviewer:a11y-priority',
  'api-reviewer:http-semantics',
  'dba:postgres-safety',
  'performance:measurement',
  'devops:tool-audit-proof',
  'copywriter:microcopy-tone',
  'lawyer:au-contractor-distinction',
  'ios-engineer:ios-stack',
  'android-engineer:android-stack',
]);

function testKey(test: AgentCapabilityTest): string {
  return `${test.id}:${test.capability}`;
}

function getSmokeProfile(): SmokeProfile {
  const raw = String(process.env.DISCORD_SMOKE_PROFILE || 'full').trim().toLowerCase();
  if (raw === 'readiness') return 'readiness';
  if (raw === 'matrix') return 'matrix';
  return 'full';
}

function getTestTimeoutMs(profile: SmokeProfile): number {
  const explicit = process.env.DISCORD_TEST_TIMEOUT_MS;
  const fallback = profile === 'matrix' ? 180_000 : 300_000;
  const value = Number(explicit ?? String(fallback));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(8_000, Math.floor(value)), 300_000);
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
  const requireTokenEcho = test.requireTokenEcho === true;
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

  if (test.expectNone && test.expectNone.length > 0) {
    for (const pattern of test.expectNone) {
      if (pattern.test(replyText)) return { ok: false, reason: `matched forbidden pattern ${pattern}` };
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
  pollIntervalMs: number,
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

  // ── Adaptive timeout: track bot activity to extend/shorten deadline ──
  // Instead of a flat timeout, we track last activity (new message or typing).
  // If the bot is actively producing messages, the deadline auto-extends.
  // If idle for too long (no new messages), we fail early.
  const IDLE_TIMEOUT_MS = Math.min(timeoutMs, test.heavyTool ? 90_000 : 60_000);
  const HARD_CEILING_MS = Math.max(timeoutMs, test.heavyTool ? 300_000 : 240_000);
  let lastActivityTs = Date.now();
  let seenMessageIds = new Set<string>();

  while (true) {
    const now = Date.now();
    const elapsed = now - started;
    const idleMs = now - lastActivityTs;

    // Hard ceiling: never exceed maximum regardless of activity
    if (elapsed >= HARD_CEILING_MS) break;

    // Idle timeout: if no new messages for IDLE_TIMEOUT_MS, give up
    if (idleMs >= IDLE_TIMEOUT_MS && seenMessageIds.size > 0) break;

    // Original timeout as baseline when no activity has been seen at all
    if (elapsed >= timeoutMs && seenMessageIds.size === 0) break;

    const channelBatches = await Promise.all(
      responseChannels.map(async (channel) => {
        try {
          const msgs = await channel.messages.fetch({ limit: 60 });
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

    // Track new messages to detect activity
    for (const msg of replies) {
      if (!seenMessageIds.has(msg.id)) {
        seenMessageIds.add(msg.id);
        lastActivityTs = Date.now();
      }
    }

    let shapeOk = false;
    for (const msg of replies) {
      const text = extractReplyText(msg);
      if (/daily token limit reached|rate limit|quota exhausted|budget exceeded|request interrupted by user/i.test(text)) {
        return {
          passed: false,
          elapsed: Date.now() - started,
          snippet: text.slice(0, 300),
          reason: 'agent capacity or limit error',
        };
      }
      const verdict = validateReplyShape(test, text, token);
      if (verdict.ok) {
        shapeOk = true;
        matchedSnippet = text.slice(0, 300);
        break;
      }
      lastReason = verdict.reason || lastReason;
    }

    const minRepliesOk = (test.minBotRepliesAfterPrompt || 1) <= replies.length;
    if (!minRepliesOk) lastReason = `expected at least ${test.minBotRepliesAfterPrompt ?? 1} bot/webhook replies`;

    const toolChannels = terminal
      ? [terminal, ...responseChannels.filter((ch) => ch.id !== terminal.id)]
      : responseChannels;
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

    await sleep(pollIntervalMs);
  }

  const idleMs = Date.now() - lastActivityTs;
  const timeoutType = idleMs >= IDLE_TIMEOUT_MS && seenMessageIds.size > 0
    ? `idle timeout (no new messages for ${Math.ceil(idleMs / 1000)}s)`
    : (Date.now() - started >= HARD_CEILING_MS ? 'hard ceiling reached' : 'timeout');

  return {
    passed: false,
    elapsed: Date.now() - started,
    snippet: matchedSnippet || `Timeout while waiting for full capability evidence (${timeoutType})`,
    reason: lastReason,
  };
}

async function verifyLiveRouter(
  groupchat: TextChannel,
  mention: string,
  selfId: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const sent = await groupchat.send(`${mention} status`);
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

function buildReadinessSummary(results: TestResult[], extras: ExtraCheckResult[], profile: SmokeProfile = 'full'): { score: number; criticalPassed: boolean; detail: string } {
  const byCategory = new Map<Category, { total: number; passed: number }>();
  for (const r of results) {
    const cur = byCategory.get(r.category) || { total: 0, passed: 0 };
    cur.total += 1;
    if (r.passed) cur.passed += 1;
    byCategory.set(r.category, cur);
  }

  const weights: Record<Category, number> = profile === 'matrix'
    ? { core: 0.20, specialist: 0.15, 'tool-proof': 0.25, orchestration: 0.15, upgrades: 0.10, memory: 0.15 }
    : { core: 0.25, specialist: 0.20, 'tool-proof': 0.20, orchestration: 0.15, upgrades: 0.10, memory: 0.10 };

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
): Promise<FreeformResult> {
  const started = Date.now();
  const observations: string[] = [];

  // Post the freeform prompt
  const fullPrompt = prompt.includes('@') ? prompt : `${rileyMention} ${prompt}`;
  console.log('\n=== Freeform Observation Mode ===');
  console.log(`Prompt: ${fullPrompt}`);
  console.log(`Timeout: ${timeoutMs / 1000}s`);
  console.log(`Polling: ${pollIntervalMs}ms\n`);

  let sent: Message;
  try {
    sent = await groupchat.send(fullPrompt);
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
  const silenceThresholdMs = 300_000; // 5 min of silence = likely done (design tasks need longer)

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
  process.stdout.write(`Testing ${getAgentName(test.id)} :: ${test.category}/${test.capability} ... `);

  const effectiveTimeoutMs = test.timeoutMs ?? timeoutMs;
  let result: { passed: boolean; elapsed: number; snippet: string; reason?: string } = {
    passed: false,
    elapsed: 0,
    snippet: 'not run',
  };
  for (let attempt = 1; attempt <= capabilityAttempts; attempt += 1) {
    if (attempt > 1) {
      process.stdout.write(`retry ${attempt}/${capabilityAttempts} ... `);
      await sleep(600);
    }
    const attemptTimeoutMs = attempt === 1
      ? effectiveTimeoutMs
      : Math.min(Math.max(Math.floor(effectiveTimeoutMs * 1.5), effectiveTimeoutMs + 10_000), 300_000);
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

  console.log(`${result.passed ? 'PASS' : 'FAIL'} (${(result.elapsed / 1000).toFixed(1)}s)`);
  console.log(`  -> ${result.snippet}`);

  await sleep(interTestDelayMs);

  return {
    agent: getAgentName(test.id),
    capability: test.capability,
    category: test.category,
    passed: result.passed,
    elapsed: result.elapsed,
    snippet: result.snippet,
    reason: result.reason,
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
  const runPostSuccessAction = shouldRunPostSuccessResetAndAnnounce();
  const requireLiveRouter = shouldRequireLiveRouter(profile);
  const routerHealthTimeoutMs = getRouterHealthTimeoutMs(profile);
  const capabilityAttempts = getCapabilityAttempts(profile);
  const budgetBoostAmount = getBudgetBoostAmount(profile);
  const interTestDelayMs = getInterTestDelayMs(profile);
  const pollIntervalMs = getPollIntervalMs(profile);
  const agentFilter = process.argv.find((a) => a.startsWith('--agent='))?.slice('--agent='.length);
  const testsFilter = process.argv.find((a) => a.startsWith('--tests='))?.slice('--tests='.length);
  const freeformPrompt = process.argv.find((a) => a.startsWith('--prompt='))?.slice('--prompt='.length);

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
  console.log(`Capability attempts   : ${capabilityAttempts}`);
  console.log(`Poll interval        : ${pollIntervalMs}ms`);
  console.log(`Budget boost          : ${budgetBoostAmount > 0 ? `$${budgetBoostAmount}` : 'disabled'}`);
  console.log(`Require live router   : ${requireLiveRouter ? 'enabled' : 'disabled'}`);
  console.log(`Router health timeout : ${Math.round(routerHealthTimeoutMs / 1000)}s`);
  console.log(`Post-success reset+announce: ${runPostSuccessAction ? 'enabled' : 'disabled'}`);
  if (agentFilter) console.log(`Filter                : --agent=${agentFilter}`);
  if (testsFilter) console.log(`Filter                : --tests=${testsFilter}`);
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
    const freeformResult = await runFreeformObservation(
      groupchat,
      candidateChannels,
      freeformPrompt,
      roleMentions.get('executive-assistant') || '@riley',
      client.user!.id,
      600_000,
      pollIntervalMs,
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

  const testsToRun = agentFilter
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
    console.log(`\n--- Matrix Phase 1: ${groupchatTests.length} groupchat tests (serial) ---`);
    for (const test of groupchatTests) {
      results.push(
        await executeSingleTest(
          test, groupchat, candidateChannels, terminal, upgrades, roleMentions,
          client.user!.id, timeoutMs, pollIntervalMs, capabilityAttempts, interTestDelayMs,
        ),
      );
    }

    // Phase 2: Agent channel tests (parallel by agent)
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

    // Phase 3: Heavy tool tests (serial — CPU-intensive commands need dedicated VM resources)
    if (heavyToolTests.length > 0) {
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

  const capabilityPassed = results.filter((r) => r.passed).length;
  const capabilityFailed = results.length - capabilityPassed;
  const extraFailed = extras.filter((e) => !e.passed).length;
  const readiness = buildReadinessSummary(results, extras, profile);

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
      profile,
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

  if (readiness.criticalPassed && capabilityFailed === 0 && extraFailed === 0 && (runPostSuccessAction || profile === 'matrix')) {
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
