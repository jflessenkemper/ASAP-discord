# ASAP Project Context

> This file is loaded into every agent's context. Riley can update it via the `memory_write` tool.
> Last updated: 2026-03-27

## What is ASAP?

ASAP-discord is a Discord-operated automation and career-ops system. Riley is the front door and primary executor, Riley Ops stewards the self-improvement engine and ops surfaces, and the runtime manages Discord workflows, voice sessions, GitHub/build webhooks, diagnostics, and a job-search pipeline for the owner.

## Tech Stack

- **Runtime**: Node.js + Express + TypeScript
- **Database**: PostgreSQL (Cloud SQL, `australia-southeast1`)
- **Hosting**: Google Cloud Run (service: `asap`, region: `australia-southeast1`)
- **CI/CD**: Cloud Build (manual trigger via `gcloud builds submit`)
- **AI**: Anthropic Claude (Sonnet for Riley planning/management, Opus for execution/completion where needed), Gemini (text and supporting runtime features), ElevenLabs (voice TTS, batch STT, and realtime STT)
- **Discord**: 13-agent bot system coordinated by Riley
- **Career Ops**: job scan/evaluation/drafting/submission workflow stored in PostgreSQL

## Database Tables

| Table | Purpose |
|-------|---------|
| `agent_memory` | Discord bot agent conversation memory |
| `agent_activity_log` | Agent event/action audit log |
| `trace_spans` | Trace spans for request/tool tracing when the table exists |
| `job_profile` | Owner career profile, target roles, contact details, preferences |
| `job_portals` | ATS/career portal metadata and submission config |
| `job_listings` | Scanned/evaluated/approved/drafted/applied listings |
| `job_scan_history` | Deduplicated history of previously seen listings |

Legacy marketplace tables were retired and are dropped by `src/db/migrations/020_drop_legacy_app_schema.sql`.

## HTTP Surface

The active HTTP surface is intentionally small and lives in `src/index.ts`:

| Route | File | Purpose |
|-------|------|---------|
| `/api/health` | `index.ts` | Health check endpoint |
| `/api/metrics` | `index.ts` | Protected Prometheus metrics endpoint |
| `/api/agent-log` | `index.ts` | Protected structured activity log endpoint |
| `/api/agent-log/text` | `index.ts` | Protected plain-text activity log view |
| `/api/webhooks/github` | `index.ts` | Signed GitHub webhook receiver |
| `/api/webhooks/build-complete` | `index.ts` | Build-complete webhook for post-deploy automation |
| `/api/twilio/voice` | `index.ts` | Twilio voice webhook |
| `/api/twilio/status` | `index.ts` | Twilio status callback webhook |

## Project Structure

```
src/
  index.ts              # Express entrypoint and webhook/health surface
  db/
    pool.ts             # PostgreSQL connection pool
    migrate.ts          # Migration runner + runtime-table assertions
    migrations/         # SQL migrations, including job-search and legacy-drop migrations
  services/
    jobSearch.ts        # Career-ops scanning, evaluation, drafting, submission
    email.ts            # Outbound email for job applications
    github.ts           # GitHub helpers
    cloudrun.ts         # Cloud Run deploy helpers
  discord/
    bot.ts              # Discord bot entry + startup monitors
    agents.ts           # Static agent registry + dynamic agent persistence
    claude.ts           # LLM orchestration and tool loop
    tools.ts            # Repo/GCP/DB/Discord/job-search tools
    usage.ts            # Token/cost tracking and tracing primitives
    memory.ts           # Conversation memory helpers
    vectorMemory.ts     # Semantic recall and memory consolidation
    activityLog.ts      # Agent activity logging + ops bridge
    handlers/           # Groupchat, review, voice, docs, GitHub handlers
    voice/              # Voice channel, STT, TTS, call pipeline
    services/           # Webhooks, screenshots, telephony, diagnostics, errors
```

## Discord Agent Team

| Agent | ID | Model | Role |
|-------|----|-------|------|
| Riley | `executive-assistant` | Sonnet | Front door, planner, direct executor, and specialist coordinator |
| Riley Ops | `operations-manager` | Sonnet | Self-improvement steward, loop maintainer, and ops-channel worker |
| Max | `qa` | Sonnet | QA tester |
| Sophie | `ux-reviewer` | Sonnet | UX reviewer |
| Kane | `security-auditor` | Sonnet | Security auditor |
| Raj | `api-reviewer` | Sonnet | API design reviewer |
| Elena | `dba` | Sonnet | Database architect |
| Kai | `performance` | Sonnet | Performance reviewer |
| Jude | `devops` | Sonnet | DevOps/deployment |
| Liv | `copywriter` | Sonnet | Copywriter |
| Harper | `lawyer` | Sonnet | Australian compliance/legal |
| Mia | `ios-engineer` | Sonnet | iOS specialist |
| Leo | `android-engineer` | Sonnet | Android specialist |

## Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_GUILD_ID` | Discord server ID |
| `DATABASE_URL` | PostgreSQL connection string |
| `GEMINI_API_KEY` | Google Gemini text features and supporting runtime calls |
| `ELEVENLABS_API_KEY` | ElevenLabs voice TTS and STT |
| `DAILY_BUDGET_USD` | Daily dollar spending limit (default: $250.00) |
| `FRONTEND_URL` | Production app URL |

## Cost Controls

- **Daily budget**: $250.00 USD default (`DAILY_BUDGET_USD`). ALL agents stop when exceeded.
- **Token limit**: 8M tokens/day default (`DAILY_LIMIT_GEMINI_LLM_TOKENS`, legacy: `DAILY_LIMIT_CLAUDE_TOKENS`).
- **Budget awareness**: Every agent sees remaining budget in their system prompt.
- **Low-budget mode**: When <$0.50 remaining, agents get an explicit efficiency warning.
- **Tool subsets**: Review agents get a restricted read/diagnostic toolset. Mutating repo and mutating GCP tools are limited to full-tool agents (Riley, Riley Ops, Jude, Mia, Leo).
- **Concurrency**: Gemini scheduler defaults to max 5 concurrent requests with pacing/lanes to reduce 429 bursts.
