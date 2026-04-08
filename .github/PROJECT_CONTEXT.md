# ASAP Project Context

> This file is loaded into every agent's context. Riley can update it via the `memory_write` tool.
> Last updated: 2026-03-27

## What is ASAP?

ASAP is an Australian service marketplace platform connecting clients who need jobs done (cleaning, handyman, gardening, etc.) with local employees/contractors. It has a React Native mobile app (Expo), a web app, and a Node.js Express backend, all deployed on Google Cloud.

## Tech Stack

- **Frontend**: React Native (Expo) with TypeScript, web + mobile
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL (Cloud SQL, `australia-southeast1`)
- **Hosting**: Google Cloud Run (service: `asap`, region: `australia-southeast1`)
- **CI/CD**: Cloud Build (manual trigger via `gcloud builds submit`)
- **AI**: Anthropic Claude (Opus for Ace, Sonnet for all others), Gemini (TTS/STT fallback), ElevenLabs (TTS), Deepgram (real-time STT)
- **Discord**: 13-agent bot system coordinated by Riley

## Database Tables

| Table | Purpose |
|-------|---------|
| `clients` | Client accounts (email, name, phone, password hash, avatar, address) |
| `employees` | Employee/contractor accounts (email, name, phone, skills, ABN, location) |
| `jobs` | Job listings (client_id, problem_type, description, address, status, price) |
| `job_timeline` | Job status history (job_id, status, timestamp, note) |
| `job_photos` | Photos attached to jobs (job_id, url, type) |
| `problem_types` | Service categories (name, description, icon) |
| `sessions` | Auth sessions (user_id, token, expires_at) |
| `two_factor_codes` | 2FA verification codes (user_id, code, expires_at) |
| `reviews` | Job reviews (job_id, reviewer_id, rating, comment) |
| `notifications` | Push notifications (user_id, title, body, read) |
| `fuel_searches` | Fuel price search history |
| `price_searches` | Service price comparison searches |
| `saved_businesses` | User-saved business bookmarks |
| `saved_items` | Generic saved/favorited items |
| `employee_availability` | Employee schedule/availability slots |
| `auth_events` | Login/signup audit trail |
| `businesses` | Business portal accounts |
| `quote_requests` | Client quote requests for jobs |
| `quotes` | Employee quotes/bids on jobs |
| `agent_memory` | Discord bot agent conversation memory |
| `agent_activity_log` | Agent event/action audit log |

## API Routes

All routes are prefixed with `/api/`:

| Route | File | Purpose |
|-------|------|---------|
| `/api/auth` | `routes/auth.ts` | Login, signup, 2FA, sessions, Google/Facebook/Apple OAuth |
| `/api/jobs` | `routes/jobs.ts` | CRUD for jobs, status updates, assignment, photos |
| `/api/employees` | `routes/employees.ts` | Employee profiles, skills, availability |
| `/api/location` | `routes/location.ts` | Geocoding, nearby search |
| `/api/fuel` | `routes/fuel.ts` | Fuel price comparisons (via external API) |
| `/api/shop` | `routes/shop.ts` | Marketplace/shop listings |
| `/api/favorites` | `routes/favorites.ts` | Save/unsave items |
| `/api/public` | `routes/public.ts` | Public-facing pages (no auth) |
| `/api/search` | `routes/search.ts` | Search across jobs, employees, businesses |
| `/api/business` | `routes/business.ts` | Business portal (for service providers) |
| `/api/mapkit` | `routes/mapkit.ts` | Apple MapKit token generation |
| `/api/health` | `index.ts` | Health check endpoint |
| `/api/agent-log` | `index.ts` | Agent activity log (debug, requires key) |

## Project Structure

```
app/                    # Expo app screens (React Native)
components/             # Shared UI components
  employee/             # Employee-specific tabs (Earnings, Jobs, Map, Profile)
constants/theme.ts      # Design tokens, colors
contexts/AuthContext.tsx # Auth state management
services/api.ts         # API client for frontend
server/
  src/
    index.ts            # Express server entry point
    routes/             # API route handlers
    db/
      pool.ts           # PostgreSQL connection pool
      migrate.ts        # Auto-migration runner
      seed.ts           # Dev seed data
      migrations/       # SQL migration files (001-015)
    middleware/auth.ts   # JWT auth middleware
    services/           # External service integrations (email, fuel, gemini, storage)
    discord/
      bot.ts            # Discord bot entry + channel setup
      agents.ts         # Agent definitions (13 agents)
      claude.ts         # Anthropic API integration + tool loop
      tools.ts          # 40+ tools available to agents
      usage.ts          # Token/cost tracking + daily budget
      memory.ts         # Agent conversation memory
      activityLog.ts    # Agent event logger
      handlers/         # Message handlers (groupchat, goals, github)
      voice/            # Voice chat (connection, TTS, STT, ElevenLabs, Deepgram)
      services/         # Discord services (webhooks, screenshots, telephony)
```

## Discord Agent Team

| Agent | ID | Model | Role |
|-------|----|-------|------|
| Riley | `executive-assistant` | Sonnet | Coordinator — orchestrates all other agents |
| Ace | `developer` | **Opus** | Full-stack developer — the only agent that writes code |
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
| `GEMINI_API_KEY` | Google Gemini (TTS/STT fallback) |
| `ELEVENLABS_API_KEY` | ElevenLabs (primary TTS) |
| `DEEPGRAM_API_KEY` | Deepgram (real-time STT) |
| `DAILY_BUDGET_USD` | Daily dollar spending limit (default: $250.00) |
| `FRONTEND_URL` | Production app URL |

## Cost Controls

- **Daily budget**: $250.00 USD default (`DAILY_BUDGET_USD`). ALL agents stop when exceeded.
- **Token limit**: 8M tokens/day default (`DAILY_LIMIT_GEMINI_LLM_TOKENS`, legacy: `DAILY_LIMIT_CLAUDE_TOKENS`).
- **Budget awareness**: Every agent sees remaining budget in their system prompt.
- **Low-budget mode**: When <$0.50 remaining, agents get an explicit efficiency warning.
- **Tool subsets**: Review agents get a restricted read/diagnostic toolset. Mutating repo and mutating GCP tools are limited to full-tool agents (Ace/Riley/Jude).
- **Concurrency**: Gemini scheduler defaults to max 5 concurrent requests with pacing/lanes to reduce 429 bursts.
