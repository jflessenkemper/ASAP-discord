# ASAP Test Coverage Map

Quick-reference for test coverage across the bot codebase. One `read_file` to find every gap.

**Goal: 100% test coverage.** Every file needs a unit test. Every change needs a test update.

## Coverage Summary

| Metric | Current | Target |
|--------|---------|--------|
| Statements | 20% | 100% |
| Branches | 16% | 100% |
| Functions | 20% | 100% |
| Lines | 21% | 100% |
| Files with tests | 54/64 | 64/64 |
| Suites | 51 | — |
| Tests | 963 | — |

## How to Read This Map

- ✅ = test file exists and coverage ≥ 80%
- 🟡 = test file exists but coverage is below 80%
- ❌ = no test file exists (0% coverage)
- **Stmts** = statement coverage percentage
- **Test file** = expected test location (create it here if missing)

## Test Engine

Cortana has two test layers:
1. **Jest unit tests** (`npx jest`) — fast, offline, mock-based. Covers logic and structure. This map tracks these.
2. **Smoke tests** (`npm run discord:test:dist`) — live Discord integration tests. Defined in `test-definitions.ts`. Not tracked here.

---

## src/db/ — Database Layer

| Status | Source File | Lines | Stmts | Test File |
|--------|------------|-------|-------|-----------|
| ❌ | `db/checkAndGrantAgentMemoryPerms.ts` | 246 | 0% | `__tests__/db/checkAndGrantAgentMemoryPerms.test.ts` |
| ❌ | `db/migrate.ts` | 107 | 0% | `__tests__/db/migrate.test.ts` |
| ❌ | `db/pool.ts` | 164 | 0% | `__tests__/db/pool.test.ts` |
| ❌ | `db/seed.ts` | 28 | 0% | `__tests__/db/seed.test.ts` |

> **Note:** DB layer files are infrastructure/bootstrap code. Unit testing these requires heavy mocking of `pg` internals with diminishing returns. Consider integration tests instead. `seed.ts` depends on `bcryptjs`.

## src/discord/ — Bot Core

| Status | Source File | Lines | Stmts | Test File |
|--------|------------|-------|-------|-----------|
| 🟡 | `discord/activityLog.ts` | 105 | 66% | `__tests__/discord/activityLog.test.ts` |
| ✅ | `discord/agents.ts` | 213 | 94% | `__tests__/discord/agents.test.ts` |
| ✅ | `discord/bot.single.ts` | 23 | 100% | `__tests__/discord/bot.single.test.ts` |
| ❌ | `discord/bot.ts` | 962 | 0% | `__tests__/discord/bot.test.ts` |
| ❌ | `discord/channelCompletionCheck.ts` | 318 | 0% | `__tests__/discord/channelCompletionCheck.test.ts` |
| ✅ | `discord/circuitBreaker.ts` | 245 | 83% | `__tests__/discord/circuitBreaker.test.ts` |
| 🟡 | `discord/claude.ts` | 3616 | 13% | `__tests__/discord/claude.test.ts` |
| ✅ | `discord/commands.ts` | 49 | 100% | `__tests__/discord/commands.test.ts` |
| 🟡 | `discord/contextCache.ts` | 226 | 67% | `__tests__/discord/contextCache.test.ts` |
| ✅ | `discord/envSandbox.ts` | 46 | 91% | `__tests__/discord/envSandbox.test.ts` |
| 🟡 | `discord/guardrails.ts` | 242 | 39% | `__tests__/discord/guardrails.test.ts` |
| ✅ | `discord/handoff.ts` | 174 | 91% | `__tests__/discord/handoff.test.ts` |
| 🟡 | `discord/memory.ts` | 437 | 39% | `__tests__/discord/memory.test.ts` |
| ✅ | `discord/metrics.ts` | 221 | 100% | `__tests__/discord/metrics.test.ts` |
| ✅ | `discord/modelHealth.ts` | 216 | 93% | `__tests__/discord/modelHealth.test.ts` |
| ❌ | `discord/setup.ts` | 677 | 0% | `__tests__/discord/setup.test.ts` |
| ✅ | `discord/test-definitions.ts` | 1770 | 100% | `__tests__/discord/test-definitions.test.ts` |
| ❌ | `discord/tester.ts` | 2181 | 0% | `__tests__/discord/tester.test.ts` |
| 🟡 | `discord/tools.ts` | 4290 | 13% | `__tests__/discord/tools.test.ts` |
| 🟡 | `discord/toolsDb.ts` | 136 | 74% | `__tests__/discord/toolsDb.test.ts` |
| ✅ | `discord/toolsGcp.ts` | 386 | 83% | `__tests__/discord/toolsGcp.test.ts` |
| ✅ | `discord/tracing.ts` | 241 | 84% | `__tests__/discord/tracing.test.ts` |
| 🟡 | `discord/usage.ts` | 820 | 61% | `__tests__/discord/usage.test.ts` |
| 🟡 | `discord/vectorMemory.ts` | 279 | 31% | `__tests__/discord/vectorMemory.test.ts` |

## src/discord/handlers/ — Message Handlers

| Status | Source File | Lines | Stmts | Test File |
|--------|------------|-------|-------|-----------|
| 🟡 | `discord/handlers/callSession.ts` | 1156 | 9% | `__tests__/discord/handlers/callSession.test.ts` |
| ✅ | `discord/handlers/designDeliverable.ts` | 50 | 100% | `__tests__/discord/handlers/designDeliverable.test.ts` |
| ✅ | `discord/handlers/documentation.ts` | 43 | 100% | `__tests__/discord/handlers/documentation.test.ts` |
| ✅ | `discord/handlers/github.ts` | 233 | 98% | `__tests__/discord/handlers/github.test.ts` |
| ✅ | `discord/handlers/goalState.ts` | 87 | 100% | `__tests__/discord/handlers/goalState.test.ts` |
| ❌ | `discord/handlers/groupchat.ts` | 3467 | 0% | `__tests__/discord/handlers/groupchat.test.ts` |
| ✅ | `discord/handlers/responseNormalization.ts` | 13 | 80% | `__tests__/discord/handlers/responseNormalization.test.ts` |
| 🟡 | `discord/handlers/review.ts` | 132 | 44% | `__tests__/discord/handlers/review.test.ts` |
| 🟡 | `discord/handlers/textChannel.ts` | 806 | 12% | `__tests__/discord/handlers/textChannel.test.ts` |

## src/discord/services/ — Bot Services

| Status | Source File | Lines | Stmts | Test File |
|--------|------------|-------|-------|-----------|
| ✅ | `discord/services/agentErrors.ts` | 54 | 100% | `__tests__/discord/services/agentErrors.test.ts` |
| ✅ | `discord/services/browserRuntime.ts` | 43 | 100% | `__tests__/discord/services/browserRuntime.test.ts` |
| ✅ | `discord/services/diagnosticsWebhook.ts` | 102 | 82% | `__tests__/discord/services/diagnosticsWebhook.test.ts` |
| 🟡 | `discord/services/mobileHarness.ts` | 190 | 17% | `__tests__/discord/services/mobileHarness.test.ts` |
| 🟡 | `discord/services/modelHealth.ts` | 349 | 33% | `__tests__/discord/services/modelHealth.test.ts` |
| 🟡 | `discord/services/opsFeed.ts` | 250 | 34% | `__tests__/discord/services/opsFeed.test.ts` |
| 🟡 | `discord/services/screenshots.ts` | 254 | 47% | `__tests__/discord/services/screenshots.test.ts` |
| 🟡 | `discord/services/telephony.ts` | 720 | 18% | `__tests__/discord/services/telephony.test.ts` |
| ✅ | `discord/services/webhooks.ts` | 97 | 96% | `__tests__/discord/services/webhooks.test.ts` |

## src/discord/ui/ — UI Components

| Status | Source File | Lines | Stmts | Test File |
|--------|------------|-------|-------|-----------|
| ✅ | `discord/ui/constants.ts` | 56 | 100% | `__tests__/discord/ui/constants.test.ts` |

## src/discord/voice/ — Voice Subsystem

| Status | Source File | Lines | Stmts | Test File |
|--------|------------|-------|-------|-----------|
| ❌ | `discord/voice/connection.ts` | 1008 | 0% | `__tests__/discord/voice/connection.test.ts` |
| 🟡 | `discord/voice/elevenlabs.ts` | 189 | 63% | `__tests__/discord/voice/elevenlabs.test.ts` |
| 🟡 | `discord/voice/elevenlabsConvai.ts` | 186 | 12% | `__tests__/discord/voice/elevenlabsConvai.test.ts` |
| 🟡 | `discord/voice/elevenlabsRealtime.ts` | 188 | 6% | `__tests__/discord/voice/elevenlabsRealtime.test.ts` |
| 🟡 | `discord/voice/testerClient.ts` | 345 | 11% | `__tests__/discord/voice/testerClient.test.ts` |
| 🟡 | `discord/voice/tts.ts` | 352 | 24% | `__tests__/discord/voice/tts.test.ts` |

> **Note:** `voice/connection.ts` (1008 lines) is tightly coupled to Discord.js voice internals and Opus streams. Coverage requires integration-level mocking. Low ROI for unit tests.

## src/services/ — Shared Services

| Status | Source File | Lines | Stmts | Test File |
|--------|------------|-------|-------|-----------|
| 🟡 | `services/billing.ts` | 158 | 17% | `__tests__/services/billing.test.ts` |
| 🟡 | `services/cloudrun.ts` | 135 | 77% | `__tests__/services/cloudrun.test.ts` |
| 🟡 | `services/email.ts` | 279 | 43% | `__tests__/services/email.test.ts` |
| ✅ | `services/github.ts` | 151 | 94% | `__tests__/services/github.test.ts` |
| 🟡 | `services/googleCredentials.ts` | 191 | 16% | `__tests__/services/googleCredentials.test.ts` |
| 🟡 | `services/jobSearch.ts` | 586 | 23% | `__tests__/services/jobSearch.test.ts` |
| 🟡 | `services/runtimeSecrets.ts` | 123 | 32% | `__tests__/services/runtimeSecrets.test.ts` |
| 🟡 | `services/visualRegression.ts` | 226 | 56% | `__tests__/services/visualRegression.test.ts` |

## src/utils/ — Utilities

| Status | Source File | Lines | Stmts | Test File |
|--------|------------|-------|-------|-----------|
| ✅ | `utils/errors.ts` | 6 | 100% | `__tests__/utils/errors.test.ts` |
| ✅ | `utils/time.ts` | 11 | 100% | `__tests__/utils/time.test.ts` |

## src/ — Entrypoint

| Status | Source File | Lines | Stmts | Test File |
|--------|------------|-------|-------|-----------|
| ❌ | `index.ts` | 417 | — | `__tests__/index.test.ts` |

## scripts/ — Operational Scripts

| Status | Source File | Lines | Test File |
|--------|------------|-------|-----------|
| ❌ | `scripts/clean-channels.mjs` | — | `__tests__/scripts/clean-channels.test.ts` |
| ❌ | `scripts/generate-avatars.ts` | — | `__tests__/scripts/generate-avatars.test.ts` |
| ❌ | `scripts/cortana-chat.mjs` | — | `__tests__/scripts/cortana-chat.test.ts` |
| ❌ | `scripts/send-to-thread.mjs` | — | `__tests__/scripts/send-to-thread.test.ts` |

## Config Files

| Status | Source File | Test File |
|--------|------------|-----------|
| ❌ | `jest.config.ts` | `__tests__/config/jest.test.ts` |
| ❌ | `eslint.config.js` | `__tests__/config/eslint.test.ts` |
| ❌ | `tsconfig.json` | `__tests__/config/tsconfig.test.ts` |
| ❌ | `Dockerfile` | `__tests__/config/dockerfile.test.ts` |
| ❌ | `package.json` | `__tests__/config/package.test.ts` |

---

## Priority Order for Closing Gaps

Focus on **bot code** first — this is what Cortana uses to self-improve via the testing engine.

### Tier 1 — Core Bot Logic (highest impact for Cortana's self-improvement)
1. `discord/claude.ts` (3616 lines, 13%) — LLM core, tool loop, model routing
2. `discord/tools.ts` (4290 lines, 13%) — all tool definitions
3. `discord/memory.ts` (437 lines, 39%) — persistent memory CRUD
4. `discord/guardrails.ts` (242 lines, 39%) — safety checks
5. `discord/usage.ts` (820 lines, 61%) — token counting, cost tracking
6. `discord/activityLog.ts` (105 lines, 66%) — agent activity logging
7. `discord/contextCache.ts` (226 lines, 67%) — conversation context
8. `discord/toolsDb.ts` (136 lines, 74%) — database tool helpers

### Tier 2 — Handlers & Orchestration
9. `discord/handlers/callSession.ts` (1156 lines, 9%) — call handling
10. `discord/handlers/textChannel.ts` (806 lines, 12%) — main message handler
11. `discord/handlers/review.ts` (132 lines, 44%) — code review handler
12. `discord/handlers/groupchat.ts` (3467 lines, 0%) — multi-agent orchestration
13. `discord/channelCompletionCheck.ts` (318 lines, 0%) — completion detection

### Tier 3 — Bot Services
14. `discord/services/mobileHarness.ts` (190 lines, 17%) — Expo test harness
15. `discord/services/telephony.ts` (720 lines, 18%) — Twilio voice
16. `discord/services/modelHealth.ts` (349 lines, 33%) — LLM health monitoring
17. `discord/services/opsFeed.ts` (250 lines, 34%) — ops channel feed
18. `discord/services/screenshots.ts` (254 lines, 47%) — visual regression

### Tier 4 — Voice
19. `discord/voice/tts.ts` (352 lines, 24%) — text-to-speech
20. `discord/voice/testerClient.ts` (345 lines, 11%) — voice test client
21. `discord/voice/elevenlabsConvai.ts` (186 lines, 12%) — conversational AI voice
22. `discord/voice/elevenlabsRealtime.ts` (188 lines, 6%) — realtime voice
23. `discord/voice/connection.ts` (1008 lines, 0%) — Discord voice (integration-heavy, low ROI)

### Tier 5 — Shared Services
24. `services/jobSearch.ts` (586 lines, 23%) — job search
25. `services/billing.ts` (158 lines, 17%) — billing
26. `services/googleCredentials.ts` (191 lines, 16%) — GCP auth
27. `services/runtimeSecrets.ts` (123 lines, 32%) — secret management
28. `services/email.ts` (279 lines, 43%) — email sending
29. `services/visualRegression.ts` (226 lines, 56%) — visual regression
30. `services/cloudrun.ts` (135 lines, 77%) — Cloud Run deploy

### Not Worth Unit Testing
- `db/pool.ts`, `db/migrate.ts`, `db/seed.ts` — infrastructure/bootstrap
- `discord/bot.ts`, `discord/setup.ts` — Discord.js startup (integration-only)
- `discord/voice/connection.ts` — tightly coupled to Discord voice internals

---

## How To Update This Map

After adding tests, regenerate coverage numbers:
```bash
npx jest --coverage --coverageReporters=json-summary
```

Then update this file with the new percentages, or ask Cortana to run:
```
Cortana, update the test map with current coverage numbers.
```

## Rules

1. **Every new file** gets a test file in `__tests__/` at the matching path.
2. **Every PR** must maintain or increase coverage — never decrease.
3. **Test file naming**: `<source>.test.ts` in `src/__tests__/<path>/`.
4. **Scripts**: test exported functions; for CLI scripts, test argument parsing and core logic.
5. **Configs**: validate structure, required fields, and consistency.
6. **Mocking**: mock external services (Discord, GCP, Anthropic, ElevenLabs, DB) — never call real APIs in unit tests.
