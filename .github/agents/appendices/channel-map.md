## Server Topology — Channel Map

Use this reference when posting, reading logs, routing messages, or deciding which channel to monitor.

### ASAP (public-facing)
| Channel | Purpose | Who Posts |
|---------|---------|-----------|
| #💬-groupchat | Main human↔agent conversation — all agent coordination happens here | Everyone |
| #🧵-thread-status | Per-goal workspace thread summaries and status | Cortana |
| #📋-decisions | Non-blocking decision cards (button-driven) | Cortana, Jordan |
| #🎤-voice | Voice channel for live calls with Cortana | Everyone |

### Agent Workspaces (one per agent)
| Channel | Agent | Purpose |
|---------|-------|---------|
| #📋-executive-assistant | Cortana (EA) | Planning, execution, coordination, coding work |
| #🛰️-operations-manager | Cortana (Ops) | Self-improvement maintenance, loops, ops hygiene |
| #🧪-qa | Argus (QA) | Test runs, bug reports |
| #🎨-ux-reviewer | Aphrodite (UX) | UX reviews, accessibility |
| #🔒-security-auditor | Athena (Security) | Security audits, threat review |
| #📡-api-reviewer | Iris (API) | Endpoint review, schema validation |
| #🗄️-dba | Mnemosyne (DBA) | Schema, migrations, queries |
| #⚡-performance | Hermes (Perf) | Profiling, bundle size, latency |
| #🚀-devops | Hephaestus (DevOps) | CI/CD, deploys, infra |
| #✍️-copywriter | Calliope (Copy) | Copy drafts, tone review |
| #⚖️-lawyer | Themis (Legal) | Legal review, compliance |
| #🍎-ios-engineer | Artemis (iOS) | iOS builds, Xcode |
| #🤖-android-engineer | Prometheus (Android) | Android builds, Gradle |

### Operations
| Channel | Purpose |
|---------|---------|
| #📦-github | Commit + PR feed |
| #🔁-loops | Background loop activity (heartbeats, ticks) |
| #🆙-upgrades | Improvement proposals + triage |
| #📋-call-log | Voice call transcript summaries |
| #📊-limits | Usage / quota tracking |
| #💸-cost | Spend tracking |
| #📸-screenshots | Visual regression + harness captures |
| #🔗-url | Deploy URLs and link index |
| #💻-terminal | Live terminal output from bot commands |
| #🧯-voice-errors | Voice pipeline diagnostics |
| #🚨-agent-errors | Runtime errors, unhandled exceptions, model failures |

### Personal
| Channel | Purpose |
|---------|---------|
| #💼-career-ops | Career-ops pipeline + job search |
| #📋-job-applications | Draft + submitted job applications |

