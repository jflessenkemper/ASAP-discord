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
type Category = 'core' | 'specialist' | 'tool-proof' | 'orchestration' | 'upgrades' | 'memory' | 'ux' | 'self-improvement' | 'infrastructure' | 'discord-management';
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
  /** Override per-test retry attempts (default: profile capabilityAttempts) */
  attempts?: number;
  /** If false, failure doesn't count toward critical gate (default: true) */
  critical?: boolean;
  /** If true, failure is tracked separately as flaky — doesn't block critical gate */
  flaky?: boolean;
}

type FailureCategory = 'PATTERN_MISMATCH' | 'TOOL_AUDIT_MISSING' | 'TIMEOUT' | 'TOKEN_ECHO_MISSING' | 'BOT_UNAVAILABLE' | 'QUALITY_CHECK_FAILED' | 'SEND_FAILED';

function categorizeFailure(reason?: string): FailureCategory {
  if (!reason) return 'TIMEOUT';
  if (reason.includes('missing token echo')) return 'TOKEN_ECHO_MISSING';
  if (reason.includes('missing tool-audit evidence')) return 'TOOL_AUDIT_MISSING';
  if (reason.includes('missing expected pattern') || reason.includes('missing any-of expected patterns')) return 'PATTERN_MISMATCH';
  if (reason.includes('send failed')) return 'SEND_FAILED';
  if (reason.includes('expected at least')) return 'BOT_UNAVAILABLE';
  if (reason.includes('capacity or limit error')) return 'QUALITY_CHECK_FAILED';
  if (reason.includes('idle timeout') || reason.includes('hard ceiling') || reason.includes('timeout')) return 'TIMEOUT';
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

const AGENT_CAPABILITY_TESTS: AgentCapabilityTest[] = [
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'routing-and-next-step',
    prompt: 'Summarize your role in one sentence and give one concrete next step.',
    expectAny: [/next step|first step|action|recommend|priorit|suggest|should|plan|approach|focus|start|begin/i],
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
    critical: false,
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
    expectAny: [/\d+\s*(pass|tests?|suites?|fail)|all.*pass|test.*completed|test.*ran|result.*test|passed|failed|success|jest|vitest|mocha|suite|spec|coverage/i],
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
    minBotRepliesAfterPrompt: 1,
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
    critical: false,
  },
  // Orchestration: specialist chain via Ace
  {
    id: 'developer',
    category: 'orchestration',
    capability: 'specialist-chain',
    prompt: 'Without using any tools, write a short paragraph explaining why auth route reviews should involve QA and security specialists. Keep it to 3-4 sentences.',
    expectAny: [/qa|security|review|specialist|audit/i],
    timeoutMs: 120_000,
    critical: false,
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
  // Tool-proof: Riley job scan trigger
  {
    id: 'executive-assistant',
    category: 'tool-proof',
    capability: 'job-scan-trigger',
    prompt: 'Use the job_scan tool right now to scan for new job listings. Summarize what you find. Do NOT delegate this.',
    expectAny: [/scan|listing|found|job|role|no.*new|result|adzuna/i],
    expectToolAudit: ['job_scan'],
    timeoutMs: 180_000,
    heavyTool: true,
    attempts: 1,
  },
  // Tool-proof: Riley draft application
  {
    id: 'executive-assistant',
    category: 'tool-proof',
    capability: 'job-draft-application',
    prompt: 'Use the job_draft_application tool right now to draft an application for the most recently approved listing. If none are approved, say so. Do NOT delegate this.',
    expectAny: [/draft|cover.?letter|resume|application|no.*approved|no.*listing|not.*found/i],
    expectToolAudit: ['job_draft_application'],
    timeoutMs: 180_000,
    heavyTool: true,
    attempts: 1,
  },
  // Tool-proof: Riley submit application
  {
    id: 'executive-assistant',
    category: 'tool-proof',
    capability: 'job-submit-application',
    prompt: 'Use the job_submit_application tool right now to submit the most recently drafted application. If none are drafted, say so. Do NOT delegate this.',
    expectAny: [/submit|email|sent|greenhouse|no.*draft|manual|not.*found|no.*listing/i],
    expectToolAudit: ['job_submit_application'],
    timeoutMs: 180_000,
    heavyTool: true,
    attempts: 1,
  },
  // Tool-proof: Riley evaluate listing
  {
    id: 'executive-assistant',
    category: 'tool-proof',
    capability: 'job-evaluate-listing',
    prompt: 'Use the job_evaluate tool right now to evaluate any scanned but unevaluated listings. If there are none, say so. Do NOT delegate this.',
    expectAny: [/evaluat|score|fit|match|no.*listing|already.*evaluat|none|not.*found/i],
    expectToolAudit: ['job_evaluate'],
    timeoutMs: 180_000,
    heavyTool: true,
    attempts: 1,
  },
  // UX: Decision buttons render
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'decision-buttons-render',
    prompt: 'Post a decision to the decisions channel with two options: "Deploy now" and "Wait until tomorrow". Use numbered options like 1) Deploy now 2) Wait until tomorrow.',
    expectAny: [/decision|deploy|wait|option|posted|button/i],
    timeoutMs: 120_000,
  },
  // UX: Ops embed format
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'ops-embed-format',
    prompt: 'Give me a summary of current operational costs, active threads, and budget status. Respond directly with the information — do NOT delegate this to any specialist.',
    expectAny: [/cost|thread|spend|ops|status|budget/i],
    timeoutMs: 120_000,
  },

  // ── Goal lifecycle tests ──────────────────────────────────────────────
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'goal-create',
    prompt: 'Create a goal to audit the current test coverage and list gaps.',
    expectAny: [/goal|created|audit|coverage|started|tracking|thread|opened|working|task/i],
    timeoutMs: 180_000,
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'goal-status-report',
    prompt: 'What goals are currently active? Report their status.',
    expectAny: [/active|in.progress|running|no.*active|goal|idle|none|status|tracking|thread|current|pending|queued|working/i],
    timeoutMs: 150_000,
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'goal-stall-detection',
    prompt: 'Describe what happens when a goal stalls for more than 7 minutes with no progress. What mechanism detects and responds to this?',
    expectAny: [/stall|nudge|inactive|idle|timeout|watchdog/i],
    timeoutMs: 150_000,
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'goal-completion',
    prompt: 'Start a goal to check TypeScript health, run typecheck, and mark the goal complete.',
    expectAny: [/complete|done|finished|closed|passed|clean/i],
    expectToolAudit: ['typecheck'],
    timeoutMs: 180_000,
  },

  // ── Thread lifecycle tests ────────────────────────────────────────────
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'thread-status-report',
    prompt: 'Use the list_threads tool to list all open threads, then report their age and activity status.',
    expectAny: [/thread|channel|open|active|age|idle|stale|list/i],
    expectToolAudit: ['list_threads'],
    timeoutMs: 150_000,
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'thread-cleanup-awareness',
    prompt: 'Which threads are stale and should be closed? Explain the criteria you use.',
    expectAny: [/idle|stale|inactive|close|archive|old/i],
    timeoutMs: 120_000,
  },

  // ── Discord UX tests ─────────────────────────────────────────────────
  {
    id: 'executive-assistant',
    category: 'ux',
    capability: 'completion-embed',
    prompt: 'Create a goal to verify TypeScript compiles cleanly. Run typecheck, then close the thread when done.',
    expectAny: [/goal complete|complete|closed|clean|passed/i],
    expectToolAudit: ['typecheck'],
    timeoutMs: 240_000,
  },
  {
    id: 'executive-assistant',
    category: 'ux',
    capability: 'thread-name-quality',
    prompt: 'Hey Riley, can you please check if the search codebase tool is working correctly by searching for the main entry point?',
    expectAny: [/search|found|index|entry/i],
    expectNone: [/hey.*riley.*can.*you.*please/i],
    timeoutMs: 180_000,
  },
  {
    id: 'developer',
    category: 'ux',
    capability: 'file-change-preview',
    prompt: 'Edit the file src/discord/handlers/goalState.ts: add a comment "// UX smoke test" at the top of the file, then revert it immediately by removing that comment.',
    expectAny: [/edit|file|goalState|changed|reverted/i],
    expectToolAudit: ['edit_file'],
    timeoutMs: 180_000,
  },
  {
    id: 'developer',
    category: 'ux',
    capability: 'response-compaction',
    prompt: 'List every single file in the src/discord/ directory recursively and describe what each one does in detail. Be very thorough and verbose — include line counts, exports, and dependencies for each file.',
    expectAny: [/discord|handler|bot|claude|tester|agent/i],
    expectNone: [/undefined|error|cannot/i],
    timeoutMs: 180_000,
  },

  // ── System resilience tests ───────────────────────────────────────────
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'budget-exhaustion-awareness',
    prompt: 'What happens when the daily budget is exhausted? Describe your behavior.',
    expectAny: [/stop|pause|limit|budget|refuse|block/i],
    timeoutMs: 120_000,
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'rate-limit-awareness',
    prompt: 'How do you handle API rate limits (429 responses)? Describe your retry strategy.',
    expectAny: [/retry|backoff|exponential|wait|delay/i],
    timeoutMs: 120_000,
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'dedup-awareness',
    prompt: 'How do you handle duplicate messages sent within seconds of each other?',
    expectAny: [/dedup|ignore|skip|fingerprint|duplicate|discard/i],
    timeoutMs: 120_000,
  },

  // ── Upgrades triage tests ─────────────────────────────────────────────
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'upgrades-triage-digest',
    prompt: 'Summarize the current upgrades backlog. What are the top accepted items?',
    expectAny: [/accepted|deferred|backlog|upgrade|triage/i],
    timeoutMs: 150_000,
  },
  {
    id: 'executive-assistant',
    category: 'orchestration',
    capability: 'upgrades-act-on-top',
    prompt: 'Pick the highest-priority accepted upgrade from #upgrades and delegate its implementation to Ace.',
    expectAny: [/ace|delegate|implement|assign|@ace/i],
    timeoutMs: 180_000,
  },

  // ── Button UX validation ──────────────────────────────────────────────
  {
    id: 'executive-assistant',
    category: 'tool-proof',
    capability: 'job-buttons-approval',
    prompt: 'Execute the job_scan tool right now to scan for new job listings. If any results are found, also run job_post_approvals. Report what you found.',
    expectToolAudit: ['job_scan'],
    expectAny: [/scan|listings?|jobs?|found|no new|results?|search|role|position|opening|adzuna|match|pipeline|evaluat/i],
    timeoutMs: 180_000,
    heavyTool: true,
  },

  // ── Riley autonomy tests ──────────────────────────────────────────────
  {
    id: 'executive-assistant',
    category: 'tool-proof',
    capability: 'self-edit-file',
    prompt: 'Use your edit_file tool directly (do NOT delegate to Ace) to add a comment "// Riley was here" at the top of the file src/discord/tester.ts. Then use read_file to verify the change.',
    expectToolAudit: ['edit_file', 'read_file'],
    timeoutMs: 180_000,
    attempts: 1,
    flaky: true,
  },
  {
    id: 'executive-assistant',
    category: 'tool-proof',
    capability: 'create-branch-pr',
    prompt: `Use your git_create_branch tool directly (do NOT delegate to Ace) to create a branch called "riley/smoke-${Date.now()}". Then use edit_file to make a trivial change, run_command to commit and push, and create_pull_request to open a PR. Report the result.`,
    expectToolAudit: ['git_create_branch'],
    expectAny: [/branch|created|pull request|PR|pushed/i],
    timeoutMs: 240_000,
    heavyTool: true,
    attempts: 1,
    flaky: true,
  },
  {
    id: 'executive-assistant',
    category: 'orchestration',
    capability: 'review-ace-pr',
    prompt: 'Use your list_pull_requests tool directly to check for open PRs and report what you find. Do NOT delegate this task.',
    expectToolAudit: ['list_pull_requests'],
    timeoutMs: 180_000,
    attempts: 1,
  },

  // ── Web harness & verification tests ──────────────────────────────────
  {
    id: 'qa',
    category: 'tool-proof',
    capability: 'capture-screenshots-e2e',
    prompt: 'Use the capture_screenshots tool right now to capture the current state of the deployed app. Report how many screenshots were taken and whether the hero screen loaded.',
    expectAny: [/screenshot|capture|hero|screen|image|taken|posted/i],
    expectToolAudit: ['capture_screenshots'],
    timeoutMs: 180_000,
    heavyTool: true,
    attempts: 1,
    critical: false,
  },
  {
    id: 'qa',
    category: 'tool-proof',
    capability: 'mobile-harness-interactive',
    prompt: 'Use mobile_harness_start to open the app, then mobile_harness_snapshot to capture the current screen, then mobile_harness_stop to end the session. Report what you saw on screen.',
    expectAny: [/harness|session|screen|started|snapshot|stopped|mobile|viewport/i],
    expectToolAudit: ['mobile_harness_start', 'mobile_harness_snapshot', 'mobile_harness_stop'],
    timeoutMs: 180_000,
    heavyTool: true,
    attempts: 1,
    critical: false,
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'verification-gate-awareness',
    prompt: 'When Ace claims a UI fix is done, what happens automatically before the thread can close? Describe the verification gate process.',
    expectAny: [/harness|screenshot|capture|evidence|verification|auto/i],
    timeoutMs: 120_000,
  },
  {
    id: 'executive-assistant',
    category: 'core',
    capability: 'thread-auto-close-review',
    prompt: 'Describe the automatic thread close review process. What triggers it, what does it check, and when does it close a thread automatically?',
    expectAny: [/stale|idle|inactive|auto.*close|review|archive|age|minutes|hours/i],
    timeoutMs: 120_000,
  },

  // ── Integration tests (end-to-end validation of critical paths) ────
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'edit-file-roundtrip',
    prompt: 'Do this exactly: 1) Use read_file on src/discord/tester.ts to read line 1. 2) Use edit_file to add "// integration-test-marker" as a new first line. 3) Use read_file again to confirm the edit is there. 4) Use edit_file to remove that "// integration-test-marker" line, reverting the file. 5) Report whether all 4 steps succeeded.',
    expectAny: [/success|completed|reverted|confirmed|all.*steps|done|passed|removed/i],
    expectToolAudit: ['edit_file', 'read_file'],
    timeoutMs: 240_000,
    heavyTool: true,
    attempts: 1,
    flaky: true,
  },
  {
    id: 'devops',
    category: 'tool-proof',
    capability: 'deployment-health-check',
    prompt: 'Use gcp_run_describe to check the Cloud Run service status, then use run_command to curl the health endpoint. Report whether the service is healthy with HTTP status.',
    expectAny: [/200|healthy|running|ready|serving|active|ok|up|alive/i],
    expectToolAudit: ['gcp_run_describe'],
    timeoutMs: 180_000,
  },
  {
    id: 'developer',
    category: 'core',
    capability: 'model-availability',
    prompt: 'Reply with exactly: "MODEL_OK" followed by the current date. This tests basic model response capability.',
    expectAny: [/MODEL_OK|model.ok|\d{4}/i],
    timeoutMs: 60_000,
    attempts: 1,
  },

  // ══════════════════════════════════════════════════════════════════════
  // ── FILE & CODE TOOLS (untested) ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'write-file',
    prompt: 'Use write_file to create a new file at /tmp/smoke-write-test.txt with content "smoke test write OK". Then use read_file to verify it exists and contains that text. Report the result.',
    expectAny: [/write|created|smoke test write OK|verified|exists/i],
    expectToolAudit: ['write_file', 'read_file'],
    timeoutMs: 120_000,
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'batch-edit',
    prompt: 'Use batch_edit to make two simultaneous edits: add a comment "// batch-test-A" at the top of src/discord/tester.ts AND a comment "// batch-test-B" at the top of src/discord/agents.ts. Then immediately revert both edits using batch_edit again. Report whether all steps succeeded.',
    expectAny: [/batch|edit|revert|success|done|completed/i],
    expectToolAudit: ['batch_edit'],
    timeoutMs: 180_000,
    heavyTool: true,
    flaky: true,
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'check-file-exists',
    prompt: 'Use check_file_exists to verify that package.json exists and that nonexistent-file-xyz.ts does NOT exist. Report the results of both checks.',
    expectAny: [/exists|found|true|false|does not exist|not found/i],
    expectToolAudit: ['check_file_exists'],
    timeoutMs: 120_000,
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'list-directory',
    prompt: 'Use list_directory to list the contents of src/discord/ and report how many files are in it.',
    expectAny: [/\d+\s*(file|item|entri)|bot\.ts|tester\.ts|agent|claude/i],
    expectToolAudit: ['list_directory'],
    timeoutMs: 120_000,
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'git-file-history',
    prompt: 'Use git_file_history on src/discord/bot.ts and report the last 3 commit messages that changed this file.',
    expectAny: [/commit|history|change|fix|feat|refactor|add/i],
    expectToolAudit: ['git_file_history'],
    timeoutMs: 120_000,
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'fetch-url',
    prompt: 'Use fetch_url to fetch https://asap-ud54h56rna-ts.a.run.app/ and report whether the page loaded successfully (check for status 200 or HTML content).',
    expectAny: [/200|html|loaded|success|ASAP|page|fetched/i],
    expectToolAudit: ['fetch_url'],
    timeoutMs: 120_000,
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'github-search',
    prompt: 'Use github_search to search for "setupChannels" in the repository and report one file that contains it.',
    expectAny: [/setup|channel|found|file|result|match/i],
    expectToolAudit: ['github_search'],
    timeoutMs: 120_000,
  },

  // ── GIT & PR WORKFLOW ─────────────────────────────────────────────────
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'add-pr-comment',
    prompt: 'Use list_pull_requests to find any open PRs. If one exists, use add_pr_comment to add a comment "smoke test review pass". If none exist, report that.',
    expectAny: [/comment|PR|pull request|no.*open|added|posted|none/i],
    expectToolAudit: ['list_pull_requests'],
    timeoutMs: 120_000,
    critical: false,
  },

  // ── DATABASE TOOLS ────────────────────────────────────────────────────
  {
    id: 'dba',
    category: 'tool-proof',
    capability: 'db-query-readonly',
    prompt: 'Use db_query_readonly to run "SELECT COUNT(*) as total FROM users" and report the result.',
    expectAny: [/\d+|total|count|rows|users|result|empty/i],
    expectToolAudit: ['db_query_readonly'],
    timeoutMs: 120_000,
  },
  {
    id: 'dba',
    category: 'tool-proof',
    capability: 'db-query-write-safety',
    prompt: 'IMPORTANT: Do NOT actually run a destructive query. Instead: 1) Use db_query_readonly to SELECT one row from any table. 2) Explain what safeguards prevent accidental data deletion via db_query. Report the result and safeguards.',
    expectAny: [/safeguard|transaction|rollback|permission|readonly|restrict|protect|prevent/i],
    expectToolAudit: ['db_query_readonly'],
    timeoutMs: 120_000,
  },

  // ── MEMORY & KNOWLEDGE TOOLS ──────────────────────────────────────────
  {
    id: 'executive-assistant',
    category: 'memory',
    capability: 'memory-read',
    prompt: 'Use memory_read to read the file "smoke-test-note" that was written earlier. Report what it contains. Do NOT delegate this.',
    expectAny: [/smoke|test|validated|content|memory|read|not found|empty/i],
    expectToolAudit: ['memory_read'],
    timeoutMs: 120_000,
    critical: false,
  },
  {
    id: 'executive-assistant',
    category: 'memory',
    capability: 'memory-append',
    prompt: 'Use memory_append to add a line "smoke test append check" to the file "smoke-test-note". Then use memory_read to verify it was appended. Do NOT delegate this.',
    expectAny: [/append|added|verified|confirmed|smoke test append/i],
    expectToolAudit: ['memory_append'],
    timeoutMs: 120_000,
    critical: false,
  },
  {
    id: 'executive-assistant',
    category: 'memory',
    capability: 'memory-list',
    prompt: 'Use memory_list to list all memory files. Report how many exist and name at least one. Do NOT delegate this.',
    expectAny: [/\d+\s*(file|item|memor)|smoke|list|found/i],
    expectToolAudit: ['memory_list'],
    timeoutMs: 120_000,
    critical: false,
  },
  {
    id: 'executive-assistant',
    category: 'memory',
    capability: 'repo-memory-add-oss',
    prompt: 'Use repo_memory_add_oss to index knowledge about the discord.js library (just the library name and version). Report what was indexed. Do NOT delegate this.',
    expectAny: [/discord\.js|indexed|added|oss|knowledge|library/i],
    expectToolAudit: ['repo_memory_add_oss'],
    timeoutMs: 120_000,
    critical: false,
  },

  // ══════════════════════════════════════════════════════════════════════
  // ── DISCORD MANAGEMENT TOOLS ──────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'executive-assistant',
    category: 'discord-management',
    capability: 'list-channels',
    prompt: 'Use list_channels to list all channels in this Discord server. Report the count and name at least 3 channels. Do NOT delegate this.',
    expectAny: [/\d+\s*(channel|text)|groupchat|terminal|upgrades|channel/i],
    expectToolAudit: ['list_channels'],
    timeoutMs: 120_000,
  },
  {
    id: 'executive-assistant',
    category: 'discord-management',
    capability: 'send-channel-message',
    prompt: 'Use send_channel_message to post "smoke test channel message OK" in the #terminal channel. Report success. Do NOT delegate this.',
    expectAny: [/sent|posted|message|terminal|success|done/i],
    expectToolAudit: ['send_channel_message'],
    timeoutMs: 120_000,
  },
  {
    id: 'executive-assistant',
    category: 'discord-management',
    capability: 'set-channel-topic',
    prompt: 'Use set_channel_topic to set the topic of #terminal to "Smoke test verified". Then report what the topic was set to. Do NOT delegate this.',
    expectAny: [/topic|set|terminal|smoke test verified|updated/i],
    expectToolAudit: ['set_channel_topic'],
    timeoutMs: 120_000,
    critical: false,
  },
  {
    id: 'executive-assistant',
    category: 'discord-management',
    capability: 'create-rename-delete-channel',
    prompt: 'Do these steps in order: 1) Use create_channel to create a text channel called "smoke-test-temp". 2) Use rename_channel to rename it to "smoke-test-renamed". 3) Use delete_channel to delete the renamed channel. Report whether all 3 steps succeeded. Do NOT delegate this.',
    expectAny: [/created|renamed|deleted|success|all.*steps|completed|done/i],
    expectToolAudit: ['create_channel'],
    timeoutMs: 180_000,
    heavyTool: true,
    critical: false,
  },

  // ══════════════════════════════════════════════════════════════════════
  // ── INFRASTRUCTURE & GCP TOOLS ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-preflight',
    prompt: 'Use gcp_preflight to check GCP project access and permissions. Report the result. Are we ready to deploy?',
    expectAny: [/preflight|project|permission|access|ready|gcp|asap/i],
    expectToolAudit: ['gcp_preflight'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-build-status',
    prompt: 'Use gcp_build_status to check the most recent Cloud Build. Report its status (success/failure/in-progress).',
    expectAny: [/build|status|success|fail|progress|complete|cloud build/i],
    expectToolAudit: ['gcp_build_status'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-get-env',
    prompt: 'Use gcp_get_env to read the current Cloud Run environment configuration. Report how many env vars are set (do NOT reveal secrets).',
    expectAny: [/\d+\s*(env|var|config)|environment|configuration|set|configured/i],
    expectToolAudit: ['gcp_get_env'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-logs-query',
    prompt: 'Use gcp_logs_query to fetch the last 10 Cloud Run log entries. Report whether the service is logging normally (check for errors).',
    expectAny: [/log|entries|normal|error|healthy|running|cloud run/i],
    expectToolAudit: ['gcp_logs_query'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'read-logs',
    prompt: 'Use read_logs to check the most recent Cloud Run application logs. Report whether there are any errors or warnings.',
    expectAny: [/log|error|warning|clean|healthy|normal|no.*error/i],
    expectToolAudit: ['read_logs'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-project-info',
    prompt: 'Use gcp_project_info to get information about the GCP project. Report the project ID and region.',
    expectAny: [/project|asap|region|australia|gcp|id/i],
    expectToolAudit: ['gcp_project_info'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-storage-ls',
    prompt: 'Use gcp_storage_ls to list GCS buckets or contents. Report what storage is available.',
    expectAny: [/bucket|storage|gs:|gcs|list|found|empty/i],
    expectToolAudit: ['gcp_storage_ls'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-artifact-list',
    prompt: 'Use gcp_artifact_list to list container images in Artifact Registry. Report the most recent image tag.',
    expectAny: [/artifact|image|tag|registry|container|docker|latest/i],
    expectToolAudit: ['gcp_artifact_list'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-sql-describe',
    prompt: 'Use gcp_sql_describe to describe the Cloud SQL instance. Report the instance name and status.',
    expectAny: [/sql|instance|database|postgres|running|status|name/i],
    expectToolAudit: ['gcp_sql_describe'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-secret-list',
    prompt: 'Use gcp_secret_list to list the secrets configured in Secret Manager. Report how many secrets exist (do NOT reveal values).',
    expectAny: [/\d+\s*(secret|key|config)|secret.*manager|listed|found/i],
    expectToolAudit: ['gcp_secret_list'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-vm-ssh',
    prompt: 'Use gcp_vm_ssh to connect to the bot VM and run "uptime". Report the VM uptime. Do NOT restart anything.',
    expectAny: [/uptime|day|hour|minute|load|up/i],
    expectToolAudit: ['gcp_vm_ssh'],
    timeoutMs: 180_000,
    heavyTool: true,
  },

  // ══════════════════════════════════════════════════════════════════════
  // ── SELF-IMPROVEMENT & AUTONOMOUS CAPABILITY ──────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'executive-assistant',
    category: 'self-improvement',
    capability: 'identify-blocker',
    prompt: 'Analyze the current codebase and identify one concrete blocker, bug, or limitation that is reducing team efficiency. Use read_file or search_files to gather evidence. Propose a specific fix. Do NOT delegate — do this yourself.',
    expectAny: [/blocker|bug|limitation|issue|problem|fix|improvement|propose|found/i],
    expectToolAudit: ['read_file'],
    timeoutMs: 180_000,
  },
  {
    id: 'executive-assistant',
    category: 'self-improvement',
    capability: 'propose-upgrade',
    prompt: 'Look at the current #upgrades backlog and the codebase. Propose one new upgrade that would improve the Discord bot capabilities — something not already proposed. Write a concrete implementation plan. Post it to #upgrades. Do NOT delegate.',
    expectAny: [/upgrade|improvement|proposal|new.*capability|implement|plan|posted/i],
    expectUpgradesPost: true,
    timeoutMs: 180_000,
  },
  {
    id: 'executive-assistant',
    category: 'self-improvement',
    capability: 'implement-fix-autonomously',
    prompt: 'Find one small, safe improvement to make in the codebase (a comment cleanup, a missing type annotation, or a TODO that can be resolved). Use edit_file to make the fix, then use typecheck to verify you did not break anything. Report what you changed and the typecheck result. Do NOT delegate.',
    expectAny: [/edit|changed|fixed|typecheck|pass|clean|improved/i],
    expectToolAudit: ['edit_file', 'typecheck'],
    timeoutMs: 240_000,
    heavyTool: true,
    flaky: true,
  },
  {
    id: 'developer',
    category: 'self-improvement',
    capability: 'refactor-proposal',
    prompt: 'Use search_files to find the largest file in src/discord/ (by looking for complex files with many functions). Propose one concrete refactoring to improve its maintainability. Show the specific code section and what you would change.',
    expectAny: [/refactor|extract|split|simplif|modular|function|class|file|large|complex/i],
    expectToolAudit: ['search_files'],
    timeoutMs: 180_000,
  },
  {
    id: 'developer',
    category: 'self-improvement',
    capability: 'fix-and-verify',
    prompt: 'Run typecheck to check for any type errors. If any exist, use edit_file to fix one, then run typecheck again to verify the fix. If none exist, report "clean typecheck". Show before/after.',
    expectAny: [/clean|fixed|error|pass|typecheck|no.*error|resolved/i],
    expectToolAudit: ['typecheck'],
    timeoutMs: 240_000,
    heavyTool: true,
  },
  {
    id: 'developer',
    category: 'self-improvement',
    capability: 'add-missing-test',
    prompt: 'Use search_files to find a function in src/discord/ that lacks test coverage. Propose a specific test case for it (describe the test, input, expected output). Do NOT write the test file — just describe what should be tested.',
    expectAny: [/test|coverage|function|assert|expect|should|describe|input|output/i],
    expectToolAudit: ['search_files'],
    timeoutMs: 180_000,
  },
  {
    id: 'executive-assistant',
    category: 'self-improvement',
    capability: 'deploy-self-gated',
    prompt: 'Describe the self-deploy process: what checks run before gcp_deploy is allowed to proceed? What happens if typecheck or run_tests fail? Do NOT actually deploy — just describe the safety gates.',
    expectAny: [/typecheck|run_tests|gate|block|fail|check|safety|test.*pass|verify/i],
    timeoutMs: 120_000,
  },
  {
    id: 'executive-assistant',
    category: 'self-improvement',
    capability: 'set-daily-budget',
    prompt: 'Use set_daily_budget to report the current daily budget setting. Do NOT change it — just read/report the current value. Do NOT delegate.',
    expectAny: [/budget|\$|\d+|daily|limit|current|set/i],
    expectToolAudit: ['set_daily_budget'],
    timeoutMs: 120_000,
    critical: false,
  },

  // ══════════════════════════════════════════════════════════════════════
  // ── SPECIALIST DEEP-DIVE (under-tested agents) ────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'copywriter',
    category: 'specialist',
    capability: 'onboarding-copy',
    prompt: 'Write onboarding welcome text for a new user joining the ASAP app for the first time. Keep it under 50 words, warm and professional.',
    expectAny: [/welcome|get started|ready|excited|glad|here to help|journey/i],
  },
  {
    id: 'copywriter',
    category: 'specialist',
    capability: 'error-message-audit',
    prompt: 'Use read_file to read server/src/routes/auth.ts and identify one user-facing error message that could be improved. Rewrite it in a friendlier tone.',
    expectAny: [/error|message|rewrite|friendly|try|please|sorry/i],
    expectToolAudit: ['read_file'],
    timeoutMs: 120_000,
  },
  {
    id: 'lawyer',
    category: 'specialist',
    capability: 'privacy-compliance',
    prompt: 'Does the ASAP app collect user data? If so, name one Australian Privacy Principle (APP) that applies and what we must do to comply.',
    expectAny: [/APP|privacy|principle|collection|consent|notice|disclosure|data|personal information/i],
  },
  {
    id: 'lawyer',
    category: 'specialist',
    capability: 'terms-review',
    prompt: 'What are three essential clauses that must be in our Terms of Service for an Australian SaaS app?',
    expectAny: [/term|clause|liability|warranty|termination|dispute|governing law|indemnity|license/i],
  },
  {
    id: 'security-auditor',
    category: 'specialist',
    capability: 'owasp-top-10',
    prompt: 'Name the top 3 OWASP Top 10 risks most relevant to this application and explain one mitigation for each.',
    expectAny: [/injection|broken.*auth|access.*control|misconfiguration|XSS|SSRF|OWASP|A0[1-9]/i],
  },
  {
    id: 'security-auditor',
    category: 'tool-proof',
    capability: 'dependency-scan',
    prompt: 'Use run_command to run "npm audit --json | head -50" and summarize the security vulnerabilities found. Report critical and high severity counts.',
    expectAny: [/vulnerabilit|critical|high|moderate|low|audit|clean|found|npm/i],
    expectToolAudit: ['run_command'],
    timeoutMs: 120_000,
  },
  {
    id: 'api-reviewer',
    category: 'specialist',
    capability: 'api-versioning',
    prompt: 'Review the API routes in the codebase. Is there a versioning strategy (e.g., /api/v1/)? If not, propose one.',
    expectAny: [/version|v1|v2|api|prefix|breaking|backward/i],
  },
  {
    id: 'api-reviewer',
    category: 'tool-proof',
    capability: 'endpoint-audit',
    prompt: 'Use search_files to find all Express route definitions (app.get, app.post, router.get, router.post) and count how many endpoints exist. Report the count and list the first 5.',
    expectAny: [/\d+\s*(endpoint|route)|GET|POST|PUT|DELETE|route|endpoint/i],
    expectToolAudit: ['search_files'],
    timeoutMs: 120_000,
  },
  {
    id: 'performance',
    category: 'specialist',
    capability: 'bundle-analysis',
    prompt: 'What techniques should be used to reduce the client bundle size of a React Native app? Name 3 specific strategies.',
    expectAny: [/tree.?shak|lazy|split|dynamic|import|bundle|minif|compress|optimize|reduce/i],
  },
  {
    id: 'performance',
    category: 'tool-proof',
    capability: 'database-query-perf',
    prompt: 'Use db_schema to inspect the database and identify one table that would benefit from an additional index. Recommend the index.',
    expectAny: [/index|query|performance|scan|slow|column|table|optimize/i],
    expectToolAudit: ['db_schema'],
    timeoutMs: 120_000,
  },
  {
    id: 'ux-reviewer',
    category: 'specialist',
    capability: 'color-contrast',
    prompt: 'What is the minimum WCAG AA contrast ratio for normal text and for large text? State both numbers.',
    expectAny: [/4\.5|3\.0|3:1|4\.5:1|contrast|ratio/i],
  },
  {
    id: 'ux-reviewer',
    category: 'tool-proof',
    capability: 'app-ux-audit',
    prompt: 'Use fetch_url to load the ASAP app at https://asap-ud54h56rna-ts.a.run.app/ and identify one UX improvement opportunity from the HTML content.',
    expectAny: [/UX|improvement|accessibility|usability|navigation|layout|button|font|color|user/i],
    expectToolAudit: ['fetch_url'],
    timeoutMs: 120_000,
  },
  {
    id: 'ios-engineer',
    category: 'specialist',
    capability: 'ios-permissions',
    prompt: 'Name 3 iOS permissions commonly needed by a job-finding app and explain one gotcha with the App Store review process.',
    expectAny: [/permission|notification|location|camera|photo|plist|review|rejection|privacy/i],
  },
  {
    id: 'ios-engineer',
    category: 'tool-proof',
    capability: 'ios-code-review',
    prompt: 'Use search_files to find any React Native bridge or native module code and report whether there are iOS-specific native modules in the project.',
    expectAny: [/native|module|bridge|react native|found|no.*native|swift|objective/i],
    expectToolAudit: ['search_files'],
    timeoutMs: 120_000,
  },
  {
    id: 'android-engineer',
    category: 'specialist',
    capability: 'android-permissions',
    prompt: 'Name 3 Android runtime permissions commonly needed by a job-finding app and explain the permission request flow.',
    expectAny: [/permission|location|notification|camera|storage|manifest|runtime|request|grant/i],
  },
  {
    id: 'android-engineer',
    category: 'tool-proof',
    capability: 'android-build-review',
    prompt: 'Use search_files to find any Gradle build files or Android-specific configuration in the project. Report what you found.',
    expectAny: [/gradle|android|build|manifest|found|no.*android|config|eas/i],
    expectToolAudit: ['search_files'],
    timeoutMs: 120_000,
  },

  // ══════════════════════════════════════════════════════════════════════
  // ── DELEGATION & ORCHESTRATION (end-to-end chains) ────────────────────
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'executive-assistant',
    category: 'orchestration',
    capability: 'multi-agent-chain',
    prompt: 'I need a security review of the auth routes. Delegate to Ace to read the auth code, then have him share findings with the security specialist (via you). Report back the chain of actions taken.',
    expectAny: [/ace|delegate|security|auth|review|finding|chain|specialist/i],
    minBotRepliesAfterPrompt: 2,
    timeoutMs: 240_000,
    critical: false,
  },
  {
    id: 'executive-assistant',
    category: 'orchestration',
    capability: 'error-recovery',
    prompt: 'Delegate a task to Ace to read a file that does not exist: "nonexistent-smoke-test-file-xyz.ts". When Ace reports the error, explain how you handle the failure and what your next step would be.',
    expectAny: [/error|not found|fail|recover|retry|alternative|handle|does not exist/i],
    minBotRepliesAfterPrompt: 1,
    timeoutMs: 180_000,
    critical: false,
  },
  {
    id: 'executive-assistant',
    category: 'orchestration',
    capability: 'rapid-dedup',
    prompt: 'This is a duplicate check. If you see this prompt twice in quick succession, you should only respond once. Acknowledge this message.',
    expectAny: [/acknowledge|understood|noted|received|ok|got it/i],
    timeoutMs: 60_000,
    critical: false,
  },

  // ══════════════════════════════════════════════════════════════════════
  // ── UPGRADES CHANNEL (additional agents) ──────────────────────────────
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'ux-reviewer',
    category: 'upgrades',
    capability: 'upgrades-post',
    prompt: 'Post one UX/accessibility improvement recommendation in #upgrades. Include the token exactly.',
    expectUpgradesPost: true,
    timeoutMs: 120_000,
  },
  {
    id: 'performance',
    category: 'upgrades',
    capability: 'upgrades-post',
    prompt: 'Post one performance optimization recommendation in #upgrades. Include the token exactly.',
    expectUpgradesPost: true,
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'upgrades',
    capability: 'upgrades-post',
    prompt: 'Post one infrastructure or deployment improvement in #upgrades. Include the token exactly.',
    expectUpgradesPost: true,
    timeoutMs: 120_000,
  },

  // ══════════════════════════════════════════════════════════════════════
  // ── REMAINING TOOL COVERAGE (destructive tools tested via safety gates)
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'executive-assistant',
    category: 'discord-management',
    capability: 'clear-channel-messages-safety',
    prompt: 'Use clear_channel_messages to clear the #terminal channel of any smoke test messages. Report how many messages were deleted. Do NOT delegate.',
    expectAny: [/clear|delete|removed|\d+\s*message|done|terminal|cleaned/i],
    expectToolAudit: ['clear_channel_messages'],
    timeoutMs: 120_000,
    critical: false,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-build-image',
    prompt: 'Use gcp_build_image to trigger a Cloud Build for the current codebase. Report the build ID and initial status. If the build is already running, report that instead.',
    expectAny: [/build|trigger|id|status|started|running|queued|already/i],
    expectToolAudit: ['gcp_build_image'],
    timeoutMs: 180_000,
    heavyTool: true,
    critical: false,
    flaky: true,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-deploy-safety',
    prompt: 'Describe what happens when you call gcp_deploy. What pre-checks run automatically (typecheck, run_tests)? What blocks the deploy if they fail? Do NOT actually deploy — just describe the safety gates by calling gcp_preflight first.',
    expectAny: [/typecheck|run_tests|gate|block|check|safety|preflight|test.*pass|verify/i],
    expectToolAudit: ['gcp_preflight'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-set-env-safety',
    prompt: 'Use gcp_get_env to read the current env vars, then explain what would happen if you used gcp_set_env to change one. What safeguards exist? Do NOT actually change anything.',
    expectAny: [/env|variable|safeguard|rollback|change|config|review|careful/i],
    expectToolAudit: ['gcp_get_env'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-list-revisions',
    prompt: 'Use gcp_list_revisions to list all Cloud Run revisions. Report how many exist and which is serving traffic.',
    expectAny: [/revision|traffic|serving|\d+|active|list/i],
    expectToolAudit: ['gcp_list_revisions'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-rollback-awareness',
    prompt: 'Describe the gcp_rollback process. Which revision would you roll back to and why? Use gcp_list_revisions to check what revisions exist. Do NOT actually rollback.',
    expectAny: [/rollback|revision|previous|traffic|revert|version/i],
    expectToolAudit: ['gcp_list_revisions'],
    timeoutMs: 120_000,
  },
  {
    id: 'devops',
    category: 'infrastructure',
    capability: 'gcp-secret-management',
    prompt: 'Use gcp_secret_list to list secrets, then explain how gcp_secret_set and gcp_secret_bind work to manage secrets. Do NOT create or modify any secrets.',
    expectAny: [/secret|bind|set|manage|version|service/i],
    expectToolAudit: ['gcp_secret_list'],
    timeoutMs: 120_000,
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'create-pull-request',
    prompt: 'Use list_pull_requests to check for open PRs. Then explain what parameters create_pull_request requires (title, body, base, head). If a smoke branch exists, use create_pull_request to open a PR from it. Otherwise, report that no branch is ready.',
    expectAny: [/pull request|PR|title|body|base|head|branch|created|no.*branch|open/i],
    expectToolAudit: ['list_pull_requests'],
    timeoutMs: 120_000,
    critical: false,
  },
  {
    id: 'executive-assistant',
    category: 'tool-proof',
    capability: 'merge-pr-awareness',
    prompt: 'Use list_pull_requests to check for open PRs. Explain what checks you perform BEFORE using merge_pull_request (typecheck, tests, review). Do NOT actually merge anything. Report what PRs exist.',
    expectAny: [/merge|check|typecheck|test|review|PR|pull request|open|none/i],
    expectToolAudit: ['list_pull_requests'],
    timeoutMs: 120_000,
  },
  {
    id: 'developer',
    category: 'tool-proof',
    capability: 'add-pr-comment-direct',
    prompt: 'Use list_pull_requests to find any open PRs. If one exists, use add_pr_comment to post "Smoke test automated review". If none, report that.',
    expectAny: [/comment|PR|pull request|no.*open|added|posted|none/i],
    expectToolAudit: ['list_pull_requests'],
    timeoutMs: 120_000,
    critical: false,
  },
  {
    id: 'qa',
    category: 'tool-proof',
    capability: 'mobile-harness-step',
    prompt: 'Use mobile_harness_start to open the app, then mobile_harness_step with action "tap" on the first button visible on screen, then mobile_harness_snapshot to capture the result, then mobile_harness_stop. Report the interaction result.',
    expectAny: [/harness|tap|button|step|interaction|screen|started|stopped/i],
    expectToolAudit: ['mobile_harness_start', 'mobile_harness_step', 'mobile_harness_snapshot', 'mobile_harness_stop'],
    timeoutMs: 180_000,
    heavyTool: true,
    attempts: 1,
    critical: false,
  },
  {
    id: 'executive-assistant',
    category: 'tool-proof',
    capability: 'job-post-approvals',
    prompt: 'Use job_post_approvals to post any pending job listings for approval in Discord. If none are pending, report that. Do NOT delegate.',
    expectAny: [/approval|posted|pending|no.*pending|none|listing|button/i],
    expectToolAudit: ['job_post_approvals'],
    timeoutMs: 120_000,
    critical: false,
  },
  {
    id: 'dba',
    category: 'tool-proof',
    capability: 'db-query-insert-safety',
    prompt: 'Use db_query_readonly to count rows in the users table. Then explain what safeguards exist around db_query for write operations (transactions, permissions, validation). Do NOT run any write queries.',
    expectAny: [/safeguard|transaction|rollback|permission|validation|write|protect|\d+/i],
    expectToolAudit: ['db_query_readonly'],
    timeoutMs: 120_000,
  },
  {
    id: 'executive-assistant',
    category: 'tool-proof',
    capability: 'smoke-test-agents-awareness',
    prompt: 'Explain what the smoke_test_agents tool does and which profiles are available (readiness, matrix, full). How would you trigger it if asked to run a test? Do NOT actually run it.',
    expectAny: [/smoke|test|readiness|matrix|full|profile|agent|trigger/i],
    timeoutMs: 120_000,
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

  const IDLE_TIMEOUT_MS = Math.min(timeoutMs, test.heavyTool ? 70_000 : 60_000);
  const HARD_CEILING_MS = Math.max(timeoutMs, test.heavyTool ? 300_000 : 240_000);

  // Build channel ID sets for monitor queries
  const responseChannelIds = new Set(responseChannels.map((ch) => ch.id));
  const toolChannelIds = new Set<string>();
  if (terminal) toolChannelIds.add(terminal.id);
  for (const ch of responseChannels) toolChannelIds.add(ch.id);
  const upgradesChannelId = upgrades?.id;

  // If monitor is available, use event-driven approach (zero polling)
  if (monitor) {
    const sinceTs = sent.createdTimestamp || started;

    const result = await monitor.waitFor(
      (events) => {
        const botEvents = events.filter((e) =>
          (e.isBot || e.isWebhook) && e.ts >= sinceTs && responseChannelIds.has(e.channelId)
        );

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

    // Check for capacity errors
    for (const e of botEvents) {
      if (/daily token limit reached|rate limit|quota exhausted|budget exceeded|request interrupted by user/i.test(e.content)) {
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
      : (Date.now() - started >= HARD_CEILING_MS ? 'hard ceiling reached' : 'timeout');

    const matchedEvent = botEvents.find((e) => validateReplyShape(test, e.content, token).ok);
    return {
      passed: false,
      elapsed: Date.now() - started,
      snippet: matchedEvent?.content.slice(0, 300) || `Timeout while waiting for full capability evidence (${timeoutType})`,
      reason,
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
      if (/daily token limit reached|rate limit|quota exhausted|budget exceeded|request interrupted by user/i.test(text)) {
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
  console.log(`Capability attempts   : ${capabilityAttempts}`);
  console.log(`Poll interval        : ${monitor ? 'event-driven (LiveMonitor)' : `${pollIntervalMs}ms`}`);
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
      capabilityAttempts,
      runPostSuccessAction,
      agentFilter: agentFilter || null,
    },
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
