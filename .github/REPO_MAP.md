# ASAP Repository Map

Quick reference for the current bot-first codebase.

## Directory Structure

```
.github/
  agents/               Specialist agent system prompts (*.agent.md)
  cortana-personality.md  Cortana's voice, owner identity, and operating style
  cortana-memory.md       Cortana's persistent guidance and preferences
  PROJECT_CONTEXT.md    Repo/product context injected into prompts
  REPO_MAP.md           This file
  HELPER_PATTERNS.md    Registry of shared helpers and dedup rules

src/
  index.ts              Express entrypoint for health, metrics, logs, and webhooks
  utils/errors.ts       errMsg(err) shared error formatter
  db/                   Pool, migration runner, grant helper, SQL migrations
  discord/              Bot runtime, agents, tools, smoke tests, voice, handlers
  middleware/           Shared middleware used by the remaining HTTP surface
  services/             Shared integrations: billing, email, GitHub, GCP, job search
  __tests__/            Jest unit and lint-style tests

scripts/                One-off deploy, smoke, audit, and Discord helper scripts
assets/avatars/         Agent avatar source images
smoke-reports/          Generated smoke reports (gitignored)
```

## Current Product Shape

ASAP-discord is now primarily a Discord-operated automation system with:

- Discord orchestration and specialist agents
- a small Express surface for health, metrics, debug logs, GitHub/build webhooks, and Twilio webhooks
- bot memory, activity logging, tracing, and diagnostics
- career-ops and job-search tooling for Cortana

The old marketplace route tree and legacy marketplace tables are no longer part of the active runtime.

## Core Files

| File | Purpose |
|------|---------|
| `src/discord/agents.ts` | Static agent registry, dynamic agent lifecycle, Cortana personality/owner metadata |
| `src/discord/claude.ts` | LLM orchestration, prompt construction, tool loop, budget handling |
| `src/discord/tools.ts` | Main tool registry and execution dispatch |
| `src/discord/tester.ts` | Smoke-test runner, readiness scoring, category mapping |
| `src/discord/test-definitions.ts` | Smoke capability catalog and expectations |
| `src/discord/bot.ts` | Bot startup, callbacks, monitors, smoke hooks |
| `src/discord/usage.ts` | Usage accounting, daily budget gates, tracing primitives |
| `src/discord/memory.ts` | Agent conversation persistence helpers |
| `src/discord/vectorMemory.ts` | Semantic recall and insight consolidation |
| `src/discord/activityLog.ts` | Agent activity logging and ops-feed bridge |
| `src/discord/modelHealth.ts` | Runtime model routing and fallback logic |
| `src/discord/services/modelHealthCheck.ts` | Startup/provider health checks |
| `src/index.ts` | HTTP entrypoint for `/api/health`, `/api/metrics`, `/api/agent-log`, GitHub/build/Twilio webhooks |
| `src/services/jobSearch.ts` | Career-ops profile, scanning, evaluation, draft/submission workflow |

## Database Focus

Important live tables and migrations:

- `agent_memory`: persistent bot memory and dynamic-agent registry state
- `agent_activity_log`: structured runtime/event log
- `trace_spans`: trace persistence when enabled
- `job_profile`, `job_portals`, `job_listings`, `job_scan_history`: career-ops/job-search state
- `018_job_search.sql`: career-ops base schema
- `019_job_applications.sql`: draft/submission fields
- `020_drop_legacy_app_schema.sql`: removes the old marketplace schema from existing DBs

## Discord Runtime Areas

### Handlers (`src/discord/handlers/`)

| File | Purpose |
|------|---------|
| `groupchat.ts` | Main orchestration loop and cross-agent coordination |
| `textChannel.ts` | Per-agent text channel handling |
| `goalState.ts` | Goal tracking and lifecycle |
| `callSession.ts` | Voice sessions and voice-command shortcuts |
| `github.ts` | GitHub webhook routing and reporting |
| `review.ts` | PR review routing by sensitivity/risk |
| `documentation.ts` | Documentation posting helpers |
| `responseNormalization.ts` | Response normalization and safety shaping |

### Services (`src/discord/services/`)

| File | Purpose |
|------|---------|
| `webhooks.ts` | Discord webhook identity management |
| `screenshots.ts` | Screenshot capture and posting |
| `mobileHarness.ts` | Interactive mobile verification sessions |
| `telephony.ts` | Telephony integration and contacts |
| `agentErrors.ts` | Runtime error posting and recurring-error aggregation |
| `diagnosticsWebhook.ts` | Diagnostic event posting |
| `opsFeed.ts` | Raw ops-feed posting implementation |

## How To...

### Add a smoke test

Edit `src/discord/test-definitions.ts` and add an entry to `AGENT_CAPABILITY_TESTS`. Add it to readiness keys only if it should affect readiness scoring.

### Add or update a tool

Edit `src/discord/tools.ts`:

1. Add or update the tool schema.
2. Wire the handler in the execution switch.
3. Update permission/tool subsets if needed.
4. Add or adjust smoke coverage in `src/discord/test-definitions.ts`.

### Add a migration

Create a new sequential SQL file in `src/db/migrations/`. Do not modify historical migration files.

### Update Cortana behavior

- Personality and owner metadata: `.github/cortana-personality.md`
- Shared repo/product guidance: `.github/PROJECT_CONTEXT.md`
- Specialist prompts: `.github/agents/*.agent.md`

### Run smoke tests

```bash
npm run discord:test:dist
npm run discord:test:dist -- --agent=developer
npm run discord:test:dist -- --rerun-failed
```
