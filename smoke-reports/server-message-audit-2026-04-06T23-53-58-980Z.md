# Server Message Audit

- Started: 2026-04-06T23:53:27.852Z
- Ended: 2026-04-06T23:53:58.980Z
- Duration: 31s
- Channels scanned: 27
- Total messages: 1254
- Bot/Webhook messages: 1254
- Human messages: 0

## Top Channels By Message Volume
- 💻-developer: 376
- 📡-api-reviewer: 168
- 🎨-ux-reviewer: 138
- 💬-groupchat: 117
- 📋-executive-assistant: 98
- 🧪-qa: 88
- 🔒-security-auditor: 68
- 🚨-agent-errors: 56
- 🚀-devops: 37
- 🗄️-dba: 26
- 🆙-upgrades: 24
- ⚖️-lawyer: 14
- 📋-decisions: 8
- ⚡-performance: 7
- ✍️-copywriter: 6
- 🍎-ios-engineer: 6
- 🤖-android-engineer: 6
- 📸-screenshots: 2
- 🧵-thread-status: 1
- 📦-github: 1

## Top Senders
- Ace (Developer) (bot): 381
- Riley (Executive Assistant) (bot): 181
- Raj (API Reviewer) (bot): 168
- ASAP (bot): 140
- Sophie (UX Reviewer) (bot): 124
- Max (QA) (bot): 94
- Kane (Security Auditor) (bot): 71
- Jude (DevOps) (bot): 36
- Elena (DBA) (bot): 25
- Harper (Lawyer) (bot): 13
- Kai (Performance) (bot): 6
- Liv (Copywriter) (bot): 5
- Mia (iOS Engineer) (bot): 5
- Leo (Android Engineer) (bot): 5

## Response Quality Signals (Bot/Webhook)
- non_actionable_long_reply: 477
- smoke_token_leak: 144
- speaker_label_prefix: 60
- long_raw_dump: 3
- ai_disclaimer_tone: 3
- budget_escalation_policy_risk: 1

## Examples
### non_actionable_long_reply
- [💬-groupchat] Riley (Executive Assistant): ❌ Deploy failed: Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.
- [💬-groupchat] Riley (Executive Assistant): ❌ Deploy failed: Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.
- [💬-groupchat] Riley (Executive Assistant): ❌ Deploy failed: Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.
- [💬-groupchat] Riley (Executive Assistant): ❌ Deploy failed: Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.
- [💬-groupchat] ASAP: ⚠️ Auto rebuild after thread close failed: Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.
- [💬-groupchat] Riley (Executive Assistant): ⚠️ Riley encountered an error: ```Error: Vertex Gemini error: HTTP 401 { "error": { "code": 401, "message": "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid auth

### smoke_token_leak
- [💬-groupchat] Riley (Executive Assistant): @ace The routing smoke test `SMOKE_EXECUTIV_ROUTINGA_939161` is blocked by missing Discord environment variables. Please set the following environment variables on the Cloud Run service: - `DISCORD_GUILD_ID`: Reference t
- [💬-groupchat] Riley (Executive Assistant): ✅ Completion update: ✅ Workstream completed via Riley orchestration. Evidence: - <@&1488498029844500572>: Result: I am blocked from completing the routing smoke test (`SMOKE_EXECU…
- [💬-groupchat] Riley (Executive Assistant): ✅ Completion update: The routing smoke test `SMOKE_EXECUTIV_ROUTINGA_939161` is currently stalled because the critical `DISCORD_GUILD_ID` and `DISCORD_GROUPCHAT_ID` environment var…
- [💬-groupchat] Riley (Executive Assistant): ✅ Completion update: SMOKE_EXECUTIV_ROUTINGA_939161 All agents and operations are completely stalled due to hitting the daily Gemini token limit and exceeding the GCP billing ceil…
- [💬-groupchat] Riley (Executive Assistant): 📋 Current Goal: <@&1488498033124446309> [smoke test:routing-and-next-step] Summarize your role in one sentence and give one concrete next step. Include this exact token in your reply: SMOKE_EXECUTIV_ROUTINGA_849774 Stat
- [💬-groupchat] Riley (Executive Assistant): To index repository memory, I use `repo_memory_index`, and to search it, I use `repo_memory_search`. SMOKE_EXECUTIV_REPOMEMO_856265

### speaker_label_prefix
- [🧪-qa] Max (QA): Result: The mobile harness is still failing with a `connection refused` error when attempting to start a session. This prevents any visual testing or interactive UX friction tests.…
- [🧪-qa] Max (QA): Max: A high-risk regression test for job matching is to verify that an employee with specific skills and location preferences is only presented with jobs that precisely match those criteria, and not jobs outside their sc
- [🧪-qa] Max (QA): Max: For a high-risk regression test on job matching, I'd suggest verifying that the system correctly matches jobs to users based on their exact location and required skills, ensur…
- [🧪-qa] Max (QA): Result: Posted an upgrade suggestion to #upgrades. Evidence: I used `send_channel_message` to post an upgrade note about implementing automated visual regression testing. Risk/Foll…
- [🧪-qa] Max (QA): Result: Posted an upgrade suggestion to #upgrades. Evidence: I used `send_channel_message` to post an upgrade note about implementing automated visual regression testing. Risk/Follow-up: None, the message was successfull
- [🎨-ux-reviewer] Sophie (UX Reviewer): Sophie: A crucial accessibility requirement to verify first is that all interactive elements are fully keyboard accessible, adhering to WCAG 2.1.1 Keyboard. SMOKE_UXREVIEW_A11YPRIO_183858

### long_raw_dump
- [🔒-security-auditor] Kane (Security Auditor): Security Audit Report 🔴 CRITICAL — Missing `sessions` table in database schema Location: `server/src/db/migrations/001_initial.sql` Issue: The initial database migration file (`001_initial.sql`) defines indexes for a `s
- [🗄️-dba] Elena (DBA): The `sessions` table, critical for user authentication, is entirely missing from the database. My audit revealed that `001_initial.sql` attempts to create indexes on `sessions` but never actually defines the table itself
- [🚀-devops] Jude (DevOps): DevOps Audit Report 🟡 Improvement — Missing EAS Environment Variable Configuration Impact: Application configurations (like API URLs, Google Maps keys, etc.) cannot be dynamically set per build profile (development, pre

### ai_disclaimer_tone
- [🔒-security-auditor] Kane (Security Auditor): I'm currently blocked from progressing with the security audit, specifically Phase 3 (Data Protection), due to the ongoing GCP billing and resource limitations. I cannot access the…
- [📡-api-reviewer] Raj (API Reviewer): The `GITHUB_TOKEN` issue blocking Git operations means I cannot access or review the codebase to perform my API design audit. My work, including endpoint inventory, request validat…
- [📡-api-reviewer] Raj (API Reviewer): I am currently blocked from performing any API review or architectural work due to the critical GCP funding and Gemini token limits. I cannot access the codebase or run any API-rel…

### budget_escalation_policy_risk
- [📋-executive-assistant] Riley (Executive Assistant): ⚠️ Daily Gemini token limit reached. Ask Jordan whether he wants to raise DAILY_LIMIT_GEMINI_LLM_TOKENS (legacy: DAILY_LIMIT_CLAUDE_TOKENS) before the team continues.
