# Agent Tooling Status

> Maintained by Ace (Tool Master). Updated after each smoke test or infra change.
> Last updated: 2025-07-15

## Smoke Test Summary

| Run Date   | Pass Rate | Failed Tests                  |
|------------|-----------|-------------------------------|
| 2025-07-15 | 17/18 (94%) | `orchestration/ace-only-delegation` (behavioral, not infra) |

## Agent Roster Health

| Agent   | Status | Notes |
|---------|--------|-------|
| Ace     | ✅ Ready | Chief Engineer / Tool Master |
| Max     | ✅ Ready | QA & Testing |
| Kane    | ✅ Ready | Security |
| Sophie  | ✅ Ready | Design & UX |
| Raj     | ✅ Ready | Performance |
| Elena   | ✅ Ready | Analytics |
| Kai     | ✅ Ready | Infra & DevOps |
| Jude    | ✅ Ready | Integrations |
| Liv     | ✅ Ready | Content & Copy |
| Harper  | ✅ Ready | Legal & Compliance |
| Mia     | ✅ Ready | Product |
| Leo     | ✅ Ready | Community & Support |
| Riley   | ✅ Ready | Orchestrator (1 behavioral test failure, non-blocking) |

## Core Tooling

| Tool / Service       | Status | Notes |
|----------------------|--------|-------|
| Cloud Run (asap)     | ✅ | australia-southeast1 |
| Cloud SQL (Postgres) | ✅ | Available via db_query |
| Cloud Build          | ✅ | Manual trigger |
| ElevenLabs TTS       | ✅ | Passed smoke test |
| Discord Bot System   | ✅ | All 13 agents operational |
| Mobile Harness       | ✅ | iPhone 17 Pro Max web harness |
| Repo Memory Index    | ⚠️ Needs rebuild | No hits on search — index may be empty or stale |

## Known Issues

- **Repo memory index**: Empty/stale. Needs `repo_memory_index` run to populate.
- **ace-only-delegation test**: Riley behavioral pattern — not a tooling issue.
