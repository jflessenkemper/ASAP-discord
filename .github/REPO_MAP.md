# ASAP Repository Map

Quick-reference for navigating the codebase. One `read_file` to find anything.

## Directory Structure

```
.github/
  agents/               13 agent system prompts (*.agent.md)
  riley-personality.md  Riley's voice, taste, and operating style
  riley-memory.md       Riley's persistent knowledge (channels, preferences, conventions)
  PROJECT_CONTEXT.md    Product context injected into all agent prompts
  REPO_MAP.md           This file

src/
  index.ts              Express server entrypoint
  db/                   Database layer (pool, migrations, seeds)
  discord/              Discord bot core (see below)
  middleware/            Express middleware (auth)
  routes/               REST API routes (auth, jobs, fuel, shop, etc.)
  services/             Shared services (billing, email, GitHub, GCP, etc.)
  __tests__/            Jest unit tests

scripts/                One-off scripts (deploy, avatar generation, smoke runner)
assets/avatars/         Agent avatar source images
smoke-reports/          Generated smoke test reports (gitignored)
```

## Discord Bot — Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `agents.ts` | ~200 | **Agent registry** — single `AGENT_REGISTRY` array with all 13 agents (name, handle, emoji, color, voice, avatar, aliases). Loads system prompts + Riley personality/memory. |
| `claude.ts` | ~3600 | **LLM core** — system prompt construction, model routing (Sonnet/Opus), Anthropic+Vertex API calls, tool loop, response caching, budget gates. |
| `tools.ts` | ~4700 | **Tool definitions** — 56 tool schemas + `executeTool()` dispatch + permission sets. |
| `tester.ts` | ~2200 | **Smoke test runner** — test execution engine, report generation, channel cleanup. |
| `test-definitions.ts` | ~1500 | **Smoke test definitions** — 155+ test cases in `AGENT_CAPABILITY_TESTS` array + `READINESS_TEST_KEYS`. Edit this file to add/modify tests. |
| `bot.ts` | — | Bot startup, Discord client setup, event handlers. |
| `setup.ts` | — | Channel/role/webhook provisioning on startup. |
| `usage.ts` | — | Token counting, cost estimation, daily budget gates. |
| `guardrails.ts` | — | Input/output safety classification (regex-based). |
| `memory.ts` | — | Persistent memory read/write/search via database. |
| `modelHealth.ts` | — | Model availability tracking, fallback logic. |
| `contextCache.ts` | — | Conversation context caching. |
| `handoff.ts` | — | Agent handoff/continuation logic. |
| `activityLog.ts` | — | Agent activity audit logging. |
| `metrics.ts` | — | Runtime metrics collection. |
| `tracing.ts` | — | Request tracing. |
| `commands.ts` | — | Slash command definitions. |

### Handlers (`src/discord/handlers/`)
| File | Purpose |
|------|---------|
| `groupchat.ts` | Main orchestration — continuation loop, agent chain, quality gate |
| `textChannel.ts` | Per-channel message handling |
| `goalState.ts` | Goal tracking and state management |
| `callSession.ts` | Voice call session management |
| `github.ts` | GitHub webhook/event handling |
| `review.ts` | PR review coordination |
| `documentation.ts` | Documentation generation |
| `designDeliverable.ts` | Design deliverable tracking |
| `responseNormalization.ts` | Response format normalization |

### Services (`src/discord/services/`)
| File | Purpose |
|------|---------|
| `webhooks.ts` | Discord webhook management for agent identities |
| `screenshots.ts` | Screenshot capture service |
| `mobileHarness.ts` | Interactive mobile testing harness |
| `browserRuntime.ts` | Headless browser for web verification |
| `telephony.ts` | Phone call integration |
| `agentErrors.ts` | Error reporting to #agent-errors |
| `diagnosticsWebhook.ts` | Diagnostic webhook posting |
| `modelHealth.ts` | Model health monitoring service |
| `opsFeed.ts` | Operations feed posting |

### Voice (`src/discord/voice/`)
| File | Purpose |
|------|---------|
| `connection.ts` | Discord voice channel connection |
| `tts.ts` | Text-to-speech orchestration |
| `elevenlabs.ts` | ElevenLabs TTS API |
| `elevenlabsConvai.ts` | ElevenLabs Conversational AI |
| `elevenlabsRealtime.ts` | ElevenLabs realtime streaming |
| `deepgram.ts` | Deepgram STT (speech-to-text) |
| `testerClient.ts` | Voice test harness client |

## How To...

### Add a new smoke test
Edit `src/discord/test-definitions.ts`. Add an entry to `AGENT_CAPABILITY_TESTS`:
```ts
{
  id: 'agent-id',
  category: 'core',
  capability: 'descriptive-name',
  prompt: 'What to ask the agent',
  expectAny: [/keyword|pattern/i],
}
```
If it should run in the readiness profile, also add to `READINESS_TEST_KEYS`.

### Add a new agent
1. Add an entry to `AGENT_REGISTRY` in `src/discord/agents.ts`
2. Create `.github/agents/<id>.agent.md` with the system prompt
3. Generate an avatar: `npx tsx scripts/generate-avatars.ts`
4. Add smoke tests to `src/discord/test-definitions.ts`

### Add a new tool
Edit `src/discord/tools.ts`:
1. Add the schema to the tool definitions section (~line 175)
2. Add the handler in `executeTool()` (~line 1611)
3. Add to appropriate permission sets if restricted

### Modify Riley's personality
Edit `.github/riley-personality.md`. Changes take effect on next bot restart.

### Modify Riley's persistent memory
Edit `.github/riley-memory.md`. Riley can also update this at runtime via memory tools.

### Deploy to VM
```bash
./scripts/vm-deploy-bot.sh
```

### Run smoke tests
```bash
npm run discord:test:dist                           # full profile
npm run discord:test:dist -- --agent=developer      # single agent
npm run discord:test:dist -- --rerun-failed         # retry failures
```
