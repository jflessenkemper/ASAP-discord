# Discord Server — Taste & Recreation Guide

This file is the single source of truth for how the ASAP Discord server should look, feel, and function. If you (Riley) ever need to recreate the server from scratch or verify it matches Jordan's preferences, follow this document exactly.

---

## Categories (in display order)

| Category | Purpose |
|----------|---------|
| **ASAP** | Main channels — groupchat, decisions, call-log, screenshots, url, voice |
| **Agents** | One workspace channel per agent (13 channels) |
| **Operations** | System-managed feeds — github, upgrades, tools, limits, cost, terminal, thread-status, voice-errors, agent-errors |
| **👤-jflessenkemper-personal** | Jordan's personal channels — career-ops, job-applications |

The personal category name is dynamic: `👤-{DISCORD_OWNER_NAME}-personal` (env var, defaults to `jflessenkemper`).

---

## Main Channels (ASAP category)

| Channel | Topic | Welcome Message |
|---------|-------|-----------------|
| `💬-groupchat` | 💬 Talk to Riley naturally. She coordinates everything. | **ASAP Command Center** — Riley is your point of contact, Ace implements. Type naturally. She can join voice, deploy, screenshot, and coordinate the team. You can also @mention any agent role directly. |
| `📋-decisions` | 📋 Riley queues decisions here while you sleep. Reply to any decision to continue the work. | **Decisions Queue** — When the team hits a decision point overnight, Riley posts here. Reply with your answer — Riley picks it up. Click a button to choose from listed options. |
| `📋-call-log` | 📋 Automatic transcripts and summaries of voice calls | Voice call transcripts and summaries post here. |
| `📸-screenshots` | 📸 Automated screenshots of every app screen after each build (iPhone 17 Pro Max) | Build screenshot updates post here as one-line entries. |
| `🔗-url` | 🔗 Live app URL and build links — updated on every deploy | App URL + Cloud Build + Cloud Run links (auto-refreshed). |

### Voice Channel

| Channel | Type | Category |
|---------|------|----------|
| `🎤-voice` | Voice | ASAP |

This is the single voice channel. Legacy voice channels (`command`, `🎤-command`, `voice-command`, `🎤-voice-command`) are auto-deleted.

---

## Operations Channels

All ops channels live under the **Operations** category and have a **channel contract** embedded in their topic: `owner=X; cadence=Y; stale=Z`.

| Channel | Topic | Contract | Welcome Message |
|---------|-------|----------|-----------------|
| `🧵-thread-status` | 🧵 Automated hourly summary of open workspace threads and close-ready items. | owner=system; cadence=hourly; stale=2h | Thread status snapshots post here. |
| `📦-github` | 📦 Live GitHub activity feed — commits, PRs, issues, releases | owner=system; cadence=on-event; stale=24h | GitHub activity feed posts here as one-line updates. |
| `🆙-upgrades` | 🆙 Agent-proposed upgrades: better ways of working, blockers to remove, and worthwhile capability enhancements | owner=system; cadence=daily-triage; stale=48h | Agents can post upgrade ideas, blockers to remove, and automation/tooling enhancements here for Jordan to approve. |
| `🧰-tools` | 🧰 Agent capabilities and runtime tool access summary | owner=ace; cadence=on-change; stale=7d | Auto-generated tools summary (refreshed on startup). |
| `📊-limits` | 📊 Gemini/GCP usage, quotas, and estimated spend — refreshed every 5 minutes | owner=jude; cadence=5m; stale=20m | _(no welcome message)_ |
| `💸-cost` | 💸 Per-action spend feed by agent (model, tokens, estimated USD) | owner=jude; cadence=on-request; stale=24h | One-line agent cost feed posts here. |
| `💻-terminal` | 💻 Live feed of all tool calls made by agents — file ops, git, commands, searches | owner=ace; cadence=on-tool-call; stale=2h | One-line tool activity feed posts here. |
| `🧯-voice-errors` | 🧯 Voice runtime errors and per-stage latency logs (ms) for live debugging | owner=system; cadence=on-error; stale=7d | **Voice Runtime Logs** — Live voice pipeline telemetry and failures. Stages: STT, Riley LLM, TTS/playback, sub-agent fan-out, total turn latency. |
| `🚨-agent-errors` | 🚨 Central runtime and agent error feed for postmortems and rapid fixes | owner=system; cadence=on-error; stale=7d | **Agent Runtime Errors** — Centralized Riley, sub-agent, tooling, and automation failures for later diagnosis and cleanup. |

---

## Personal Channels (👤 category)

| Channel | Topic | Contract | Welcome Message |
|---------|-------|----------|-----------------|
| `💼-career-ops` | 💼 Career operations command center: role targets, pipeline, outreach, applications, and weekly goals | owner=jflessenkemper; cadence=daily; stale=14d | **Career Ops** — Use this channel to run your job search pipeline with Riley: role targeting, shortlist scoring, tailored CV generation, outreach drafts, and application tracking. |
| `📋-job-applications` | 📋 Job approval queue — click Approve or Reject on each card · cards update after you choose | owner=jflessenkemper; cadence=on-demand; stale=14d | **Job Applications** — Riley scans & evaluates jobs in career-ops, posts best matches here as cards. Click Approve for auto-drafted cover letter & resume highlights. Click Reject to skip. Cards update after you choose. |

---

## Agent Workspace Channels (Agents category)

Each agent gets one text channel named `{emoji}-{agent-id}`. The topic is `{emoji} {Name} — work log and notes`. The welcome message is `{emoji} **{Name}** work log. This channel shows what {FirstName} is working on.`

| Channel | Agent | Emoji | Color (hex) | Voice | Role |
|---------|-------|-------|------------|-------|------|
| `🧪-qa` | Max (QA) | 🧪 | #50C878 | Kore | Max |
| `🎨-ux-reviewer` | Sophie (UX Reviewer) | 🎨 | #303F9F | Puck | Sophie |
| `🔒-security-auditor` | Kane (Security Auditor) | 🔒 | #1F2937 | Charon | Kane |
| `📡-api-reviewer` | Raj (API Reviewer) | 📡 | #708090 | Fenrir | Raj |
| `🗄️-dba` | Elena (DBA) | 🗄️ | #7C3AED | Leda | Elena |
| `⚡-performance` | Kai (Performance) | ⚡ | #0EA5E9 | Orus | Kai |
| `🚀-devops` | Jude (DevOps) | 🚀 | #4338CA | Vale | Jude |
| `✍️-copywriter` | Liv (Copywriter) | ✍️ | #0F766E | Zephyr | Liv |
| `💻-developer` | Ace (Developer) | 💻 | #4682B4 | Achernar | Ace |
| `⚖️-lawyer` | Harper (Lawyer) | ⚖️ | #14532D | Sulafat | Harper |
| `📋-executive-assistant` | Riley (Executive Assistant) | 📋 | #1D4ED8 | Achernar | Riley |
| `🍎-ios-engineer` | Mia (iOS Engineer) | 🍎 | #F97316 | Enceladus | Mia |
| `🤖-android-engineer` | Leo (Android Engineer) | 🤖 | #16A34A | Iapetus | Leo |

### Agent Roles

Each agent gets a Discord role with:
- **Name**: the agent's `roleName` (e.g. `Max`, `Sophie`, `Kane`)
- **Color**: the hex color from the table above
- **Mentionable**: `true`
- **Hoist**: `false`
- **Permissions**: none (roles are for identity/mention only)

---

## Webhooks

Every text channel (main + ops + agent + personal) gets a pre-created webhook on startup. Agents post via webhooks so messages appear with the correct agent name and avatar.

Avatar URLs follow the pattern: `https://storage.googleapis.com/asap-bot-assets/avatars/{agent-id}.png`

---

## Permissions & Hardening

### Bot Posting Restrictions

The bot account itself is **restricted from posting** in non-Operations channels (groupchat, agent channels, etc.) — all agent communication goes through webhooks. In Operations channels, the bot has full send/thread/reaction permissions.

### Sensitive Channel ACL

The following channels are hidden from `@everyone` and visible only to the bot and server owner:

- `💻-terminal`
- `🧯-voice-errors`
- `🚨-agent-errors`
- `📊-limits`
- `💸-cost`
- `📋-call-log`
- `🆙-upgrades`
- `💼-career-ops`
- `📋-job-applications`

The owner gets: ViewChannel, ReadMessageHistory, SendMessages, SendMessagesInThreads, ManageMessages, ManageThreads.

This is controlled by `DISCORD_HARDEN_SENSITIVE_CHANNELS` (defaults to `true`).

---

## Naming Conventions

- **Every channel has an emoji prefix.** No exceptions.
- Agent channels: `{emoji}-{agent-id}` (e.g. `🧪-qa`, `💻-developer`)
- Ops channels: `{emoji}-{kebab-name}` (e.g. `📦-github`, `💸-cost`)
- Main channels: `{emoji}-{name}` (e.g. `💬-groupchat`, `📋-decisions`)
- Personal channels: `{emoji}-{kebab-name}` under the `👤-{owner}` category

---

## Channel Contract Format

Some channels embed a machine-readable contract in their topic suffix:

```
owner={who manages it}; cadence={how often it updates}; stale={when silence is suspicious}
```

This helps Riley detect stale feeds and flag them.

---

## Legacy Cleanup

On every startup, the bot automatically deletes:
- Channels with bare agent-id names (e.g. `developer`, `qa`, `security`) — replaced by emoji-prefixed versions
- Channels from the `LEGACY_ACCIDENTAL_CHANNELS` set (old naming mistakes)
- Legacy voice channels (`command`, `🎤-command`, `voice-command`, `🎤-voice-command`)
- The old `ASAP Agents` category (if empty)
- Duplicate text channels with the same name (keeps the oldest)

---

## Reset Mode

Setting `RESET_CHANNELS=true` deletes all managed channels and categories, then recreates everything fresh. Use with caution — this wipes channel history.

---

## Key Aesthetics (from Riley's personality)

1. **Channel structure is sacred.** Never delete channels Jordan and you created together. "Reset" means clear messages, not delete channels.
2. **Emoji prefixes are deliberate.** Every channel has one. Maintain this convention.
3. **Agent identities matter.** Each agent has a carefully chosen name, emoji, color, voice, and avatar. Respect them.
4. **No clutter.** Keep the server tidy. Archive finished threads, don't let channels fill with noise.
