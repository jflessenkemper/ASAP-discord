# Riley — Persistent Memory

This file is Riley's starting knowledge base. Riley can update it via memory tools as she learns more. It captures the state of the Discord server, Jordan's preferences, and operational conventions.

## Discord Server — Channel Map

### Main Channels
| Channel | Purpose |
|---------|---------|
| #💬-groupchat | Main human↔agent conversation — all coordination happens here |
| #📢-announcements | Important updates, releases, milestones |
| #📊-dashboard | Live app metrics, health checks, status board |
| #🗳️-polls | Team polls and decisions |

### Agent Workspaces (one per agent)
| Channel | Agent |
|---------|-------|
| #📋-executive-assistant | Riley — planning, coordination, scratchpad |
| #💻-developer | Ace — coding tasks, PRs, build output |
| #🧪-qa | Max — test runs, bug reports |
| #🎨-ux-reviewer | Sophie — UX reviews, accessibility |
| #🔒-security-auditor | Kane — security audits |
| #📡-api-reviewer | Raj — endpoint review, schema validation |
| #🗄️-dba | Elena — schema, migrations, queries |
| #⚡-performance | Kai — profiling, bundle size, latency |
| #🚀-devops | Jude — CI/CD, deploys, infra |
| #✍️-copywriter | Liv — copy drafts, tone review |
| #⚖️-lawyer | Harper — legal review, compliance |
| #🍎-ios-engineer | Mia — iOS builds, Xcode |
| #🤖-android-engineer | Leo — Android builds, Gradle |

### Operations
| Channel | Purpose |
|---------|---------|
| #💻-terminal | Live terminal output from bot commands |
| #🔁-loops | Independent loop runs, start/finish status, and Riley-facing loop reports |
| #🚨-agent-errors | Runtime errors, unhandled exceptions |
| #📋-agent-audit | Structured audit log (tool calls, model swaps) |
| #🧪-smoke-tests | Smoke test results and reports |
| #📊-model-health | Model availability, latency, fallback events |
| #🔔-notifications | System notifications, alerts |
| #📜-logs | General logs |
| #📨-agent-inbox | Inbound tasks/requests queue |
| #🔧-maintenance | Scheduled maintenance notices |
| #📈-analytics | Usage analytics, engagement metrics |
| #🗂️-archive | Archived threads and resolved items |

### Personal
| Channel | Purpose |
|---------|---------|
| #🏠-jordans-space | Jordan's private workspace |
| #🏡-rileys-space | Riley's private workspace and scratchpad |

### Career Ops
| Channel | Purpose |
|---------|---------|
| #💼-career-ops | Job search pipeline, profiles, drafts |
| #📋-job-applications | Approval cards — Jordan reacts ✅/❌ |

## Jordan's Preferences

- **Speed over ceremony** — ship fast, iterate, don't over-plan
- **Fewer files, not more** — centralise logic, avoid splitting into dozens of modules
- **Autonomous execution** — don't ask permission for routine work; just do it
- **Evidence-based** — always verify with screenshots/harness before claiming done
- **Australian focus** — NSW timezone, Australian market, AU compliance
- **Taste matters** — the Discord server aesthetic, channel structure, and agent identities are intentional and should be preserved

## Deployment Conventions

- **VM**: `asap-bot-vm` in `australia-southeast1-c`, GCP project `asap-489910`
- **Process manager**: PM2 (user-owned, not root)
- **Build**: `node_modules/.bin/tsc --project ./tsconfig.json` (never bare `tsc`)
- **Deploy flow**: build locally → scp dist tarball → extract on VM → pm2 restart
- **Deploy script**: `scripts/vm-deploy-bot.sh`
- **Auto-deploy**: pushing to main triggers Cloud Build → Cloud Run for the web app

## Agent Team — Working Styles

| Agent | Style | Key Trait |
|-------|-------|-----------|
| Ace | Thorough, methodical | Pre-commit checklist, reads back every change |
| Max | Aggressive, detail-obsessed | Breaks things systematically, then writes tests |
| Sophie | User-advocate | Pushes for accessibility and design quality |
| Kane | Paranoid (in a good way) | Finds security holes others miss |
| Elena | Precise, schema-first | Insists on proper migrations and constraints |
| Raj | Standards-driven | HTTP semantics, consistent error formats |
| Kai | Data-driven | Always measures before optimising |
| Jude | Infrastructure-first | CI/CD pipelines, deploy reliability |
| Liv | Tone-conscious | Microcopy quality, user-facing text polish |
| Harper | Compliance-focused | Australian law, contractor classification |
| Mia | Platform-specific | iOS conventions, Apple HIG |
| Leo | Platform-specific | Android conventions, Material Design |

## Lessons Learned

- **PM2 root service conflict**: If `pm2-root.service` is enabled on the bot VM, it resurrects a root-owned node process and causes EADDRINUSE. Disable it.
- **Gemini quota fuse**: The quota fuse can block ALL models (including Anthropic) if not correctly scoped. Set DISABLE_GEMINI_QUOTA_FUSE=true when using Anthropic exclusively.
- **Startup scripts + secrets**: Never use `set -x` in startup scripts that fetch secrets — it leaks them into logs.
- **Install gating**: Verify a sentinel module (e.g., `dotenv/config`) in addition to `node_modules` dir + commit SHA.
- **Model defaults**: Ace defaults to Sonnet ($3/$15) not Opus ($15/$75). Only escalate to Opus for high-stakes work (production security, migrations).

## Current State

- **Default model**: Claude Sonnet (fast), Claude Opus (developer high-stakes only)
- **Anthropic API**: Check credits before operations
- **Smoke tests**: 155+ test definitions, 18 readiness keys, 3 profiles (readiness/matrix/full)
- **Bot status**: PM2 managed on asap-bot-vm
