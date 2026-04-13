# Riley Pain Points Report — 2026-04-13

## Test Setup
- **Objective**: Act as a user, send natural-language UI change requests through Discord, and observe Riley's ability to autonomously make code changes.
- **Tasks Given**:
  1. Restore Three.js background and Australia model on Hero page
  2. Remove centered "Welcome, guest" text after pressing Dive In
  3. Restore dark mode background with Google Maps ASAP style
- **Attempts**: 5 messages sent with progressively more specific instructions
- **Environment**: Bot on GCE VM (`asap-bot-vm`), Gemini 2.5 Pro (all agents), app repo at `/opt/asap-app`

---

## Results Summary

| Attempt | Task | Outcome |
|---------|------|---------|
| 1 | All 3 tasks at once | Ace quality-rejected, but **secretly committed** mapStatus overlay removal |
| 2 | Single task (remove overlay) | `search_files` failed — ripgrep not installed on VM |
| 3 | Asked Riley to edit directly | Vertex 401 auth token expired |
| 4 | Fresh start, read-only first | Quality gate rejected Ace's valid read response |
| 5 | Exact 2-line CSP fix | Ace generated **0 tokens** of output; Riley self-blocked in 18s |

**Net result**: 1 commit landed out of 5 attempts. The commit removed a `{mapStatus}` overlay — a partial fix, but the wrong text (removed "Loading map..." instead of "Welcome, guest"). The actual root cause of all 3 issues was a **CSP misconfiguration** that none of the agents diagnosed.

---

## Pain Points

### P0 — Critical (blocks all useful work)

#### 1. Ace Quality Gate Is Counterproductive
- **What**: `AGENT_CHAIN aceQualityFailed=true` rejected EVERY Ace response, including ones where Ace had **already made the correct file edit and committed it**.
- **Root Cause**: The quality gate judges response text length (`aceLen=458`, `aceLen=396`, `aceLen=417`), not whether the actual tool operations (edit_file, run_command) succeeded.
- **Impact**: Riley never knows Ace succeeded. Triggers pointless specialist fallback (Sophie → Max) which wastes time and produces hallucinated output.
- **Evidence**: `aceQualityFailed=true` on every single Ace response across 5 attempts. Ace DID write correct code in attempt 1 (commit `5df604e`).

#### 2. Ace Generates 0-Token Responses
- **What**: On the final attempt (exact 2-line edit instructions), Ace generated exactly 0 tokens in two consecutive LLM calls (24s and 14.5s spent).
- **Root Cause**: Unknown — possibly Gemini safety filter, prompt too long, or model refusing to respond.
- **Impact**: Complete agent failure with no error message, no fallback, no retry.
- **Evidence**: `{"agent":"developer","tokensOut":0,"durationMs":24097}`, `{"agent":"developer","tokensOut":0,"durationMs":14518}`

#### 3. Guardrails Model Missing (Gemini 2.0 Flash)
- **What**: Every guardrails check returns HTTP 404 — the model `gemini-2.0-flash` doesn't exist in project `asap-489910`.
- **Root Cause**: Model never provisioned on Vertex AI, or deprecated/renamed.
- **Impact**: Guardrails failures are non-blocking (they fall through to PASS_RESULT), but they flood error logs (100+ 404 errors per session), making real issues invisible.
- **Evidence**: `"Publisher Model projects/asap-489910/locations/us-central1/publishers/google/models/gemini-2.0-flash was not found"`

#### 4. Claude Opus 4.1 Fallback Chain Down
- **What**: `"All models in fallback chain for claude-opus-4-1 are down — using preferred anyway"` appears repeatedly.
- **Root Cause**: Opus endpoint unreachable. System falls through to Gemini 2.5 Pro for everything.
- **Impact**: Reduced model diversity. No backup when Gemini 2.5 Pro has issues (like the 0-token responses).

---

### P1 — High (severely degrades quality)

#### 5. Agent Hallucination — Claiming Work Not Done
- **What**: Sophie (UX reviewer) claimed she "restored the missing files" and reported success. No files were actually written or modified.
- **Root Cause**: Agents confabulate completion narratives without verifying tool calls actually executed.
- **Impact**: User gets false confidence that work was done. Riley's status reports become unreliable.
- **Evidence**: Sophie's response in Goal-0059 workspace thread; `git log` showed no matching commit.

#### 6. Wrong Agent Routing
- **What**: When Ace's quality gate failed, the system routed to Sophie (UX Reviewer) and Max (QA) for a **code editing task**.
- **Root Cause**: The specialist fallback chain is static — after Ace fails, it always tries Sophie → Max regardless of task type.
- **Impact**: Non-developer agents attempt developer tasks, generating irrelevant output and consuming LLM tokens.
- **Evidence**: Sophie and Max responded to a request to edit `server/src/index.ts` CSP config.

#### 7. No Root-Cause Diagnosis Capability
- **What**: The actual problem was a 2-line CSP misconfiguration in `server/src/index.ts`. None of the 13 agents across 5 attempts identified this.
- **Root Cause**: Agents focus on the file mentioned in the request rather than diagnosing WHY features are broken. No agent checked browser console errors, server config, or deployment config.
- **Impact**: Even when given working source code (Three.js components exist, dark mode theme exists), agents couldn't figure out why the deployed app didn't show them.

---

### P2 — Medium (degrades experience)

#### 8. Missing VM Dependencies (ripgrep)
- **What**: `search_files` tool calls all failed because `rg` (ripgrep) was not installed on the VM.
- **Root Cause**: The Dockerfile installs ripgrep for the Cloud Run container, but the bot also runs on a bare VM where it wasn't installed.
- **Impact**: Blocked ALL code search operations for attempts 1-3. Had to manually SSH in and install it.
- **Fix Applied**: `sudo apt-get install ripgrep` on VM.

#### 9. AGENT_REPO_ROOT Not Configured
- **What**: Before this session, `AGENT_REPO_ROOT` was not set in the bot's `.env`. All file tools pointed at `/opt/asap-bot` (the bot repo) instead of `/opt/asap-app` (the app repo).
- **Root Cause**: Environment variable never set after separating bot and app repos.
- **Impact**: Every read_file, edit_file, search_files call operated on the wrong repo. Silently.
- **Fix Applied**: Added `AGENT_REPO_ROOT=/opt/asap-app` to `/opt/asap-bot/.env`.

#### 10. 180s Stall Timeout Too Aggressive
- **What**: `AUTOPILOT_AUDIT event=watchdog_recovery` triggered at 180 seconds, during normal processing where multiple agents were still actively working.
- **Root Cause**: Ace's quality gate rejection → Sophie fallback → Max fallback chain takes longer than 180s total.
- **Impact**: Interrupts work-in-progress, generates confusing warning messages in Discord, may cause duplicate work.

#### 11. Vertex OAuth Token Expiry
- **What**: Mid-session, all Vertex AI calls returned 401 Unauthorized.
- **Root Cause**: OAuth2 access token expired during a long processing chain; bot doesn't refresh automatically.
- **Impact**: Silent failure — agents couldn't generate responses but no user-visible error message. Had to restart the bot.

---

### P3 — Low (nuisances)

#### 12. Riley Self-Blocks Without Attempting Work
- **What**: On the final attempt, Riley created a goal thread but self-reported "Blocked: Verification pending" after only 18 seconds, without making any file changes.
- **Root Cause**: The `riley-contract` verification check requires "runtime evidence" even for tasks that haven't started. Combined with Ace's 0-token responses, Riley gives up instantly.

#### 13. Regression Detective Git Failure
- **What**: Riley's first response ran "Regression Detective" which failed with `fatal: not a git repository`.
- **Root Cause**: The regression analysis ran in the wrong working directory (not using AGENT_REPO_ROOT).

#### 14. Log Noise
- **What**: Error logs are 95%+ guardrails 404 spam, making it nearly impossible to find real errors.
- **Root Cause**: Every agent call triggers multiple guardrails checks, each generating a multi-line 404 error.
- **Recommendation**: Suppress repeated guardrails failures after the first occurrence, or fix the model reference.

---

## Recommendations (Prioritized)

1. **Fix the Ace quality gate** — Score based on tool operations (files written, commands run, test results), not response text length.
2. **Fix or remove guardrails model** — Either provision `gemini-2.0-flash` or update the config to use an available model. The 404 spam hides real errors.
3. **Add retry with error context for 0-token responses** — Detect when LLM returns empty and retry with a simplified prompt.
4. **Route specialist fallback by task type** — Don't send code editing tasks to Sophie/Max.
5. **Add CSP/deployment awareness** — When debugging UI issues, agents should check server config, CSP headers, and deployment state, not just component source code.
6. **Refresh OAuth tokens proactively** — Refresh Vertex AI tokens before expiry rather than failing mid-request.
7. **Increase stall timeout to 300s** — The current 180s is insufficient for the Ace → specialist fallback chain.

---

## What Actually Fixed the Issues

| Issue | Root Cause | Fix | Status |
|-------|-----------|-----|--------|
| Three.js not rendering | CSP blocks `blob:` workers | Added `workerSrc: ["'self'", "blob:"]` to `server/src/index.ts` | Committed (`2e20c6f`) |
| Map dark style not loading | CSP blocks `mapsresources-pa.googleapis.com` | Added to `connectSrc` array | Committed (`2e20c6f`) |
| "Welcome, guest" centered text | Old deployed code (not in current source) | Text already removed in current source; needs redeploy | Pending deploy |
| Dockerfile broken | Missing `&& rm -rf` after apt-get, trailing `\` merges two `RUN` commands | Fixed syntax | Committed (`2e20c6f`) |

All 3 UI issues were **CSP + stale deployment** problems. None of the 13 AI agents diagnosed this. A human developer checked the browser console in 30 seconds and identified the exact fix.

## Deployment Blocker

The Cloud Build pipeline itself is broken due to a **Node.js version mismatch**:
- `FROM node:20-slim` provides Node 20.x but Expo SDK now requires `>=20.19.4`
- The Expo SDK was updated after the last successful deploy (April 5)
- Metro config uses `Array.toReversed()` which requires Node >= 20.19.4
- Error: `configs.toReversed is not a function`

**Fix needed**: Update `FROM node:20-slim` to `FROM node:22-slim` in Stage 1, or pin to `node:20.19-slim`. This is a pre-existing issue unrelated to Riley.

## Timeline

| Time | Event |
|------|-------|
| 13:55 | First message to Riley (3 tasks) |
| 14:00 | Ace quality-rejected; secretly committed mapStatus removal |
| 14:04 | Second message (simplified single task) |
| 14:07 | Failed — ripgrep missing |
| 14:11 | Third message (do it yourself) — Vertex 401 |
| 14:17 | Installed ripgrep, restarted bot |
| 14:21 | Fourth message (fresh start) — quality gate rejected again |
| 14:34 | Quality gate rejected again on retry |
| 14:36 | Fifth message (exact CSP fix) — Ace 0 tokens, Riley self-blocked |
| 14:37 | Gave up on Riley, made CSP fix directly |
| 14:46 | Committed and pushed CSP + Dockerfile fix |
| 14:47 | First Cloud Build — Dockerfile syntax error |
| 14:55 | Build failed |
| 15:01 | Second Cloud Build with fixed Dockerfile |
| 15:03 | Build failed — Node.js version mismatch (pre-existing) |

**Total time through Riley**: ~42 minutes, 1 partial fix landed (wrong text removed)
**Total time as direct developer**: ~11 minutes, root cause identified + all fixes committed
