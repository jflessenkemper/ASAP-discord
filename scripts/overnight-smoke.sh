#!/usr/bin/env bash
# Overnight smoke test: goal mode → full matrix → rerun-failed
# Runs on the VM, survives SSH disconnection.
# Usage: gcloud compute ssh asap-bot-vm ... --command="bash /opt/asap-bot/scripts/overnight-smoke.sh"
set -euo pipefail

cd /opt/asap-bot
export PATH="$PWD/node_modules/.bin:$PATH"

LOG_DIR="/opt/asap-bot/smoke-reports"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%S)
LOGFILE="$LOG_DIR/overnight-${TIMESTAMP}.log"

echo "=== ASAP Overnight Smoke Test ===" | tee "$LOGFILE"
echo "Started: $(date -u)" | tee -a "$LOGFILE"
echo "Log: $LOGFILE" | tee -a "$LOGFILE"

# ── Phase 1: Goal Mode ─────────────────────────────────────────────
echo "" | tee -a "$LOGFILE"
echo "═══════════════════════════════════════════════════════" | tee -a "$LOGFILE"
echo "  PHASE 1: Goal Mode — Design System Page (60min max)" | tee -a "$LOGFILE"
echo "═══════════════════════════════════════════════════════" | tee -a "$LOGFILE"

GOAL_PROMPT='Build a Design System showcase page at the /design route of the ASAP app (https://asap-ud54h56rna-ts.a.run.app/design). Requirements:
1. Dark glassmorphic design with frosted glass cards, subtle gradients, and glow effects
2. Showcase EVERY UI element: buttons (primary, secondary, ghost, danger), text inputs, selects, checkboxes, toggles, modals, toasts, cards, badges, avatars, loading spinners, progress bars
3. Typography section with all heading levels, body text, code blocks, and the app font stack
4. Color palette section showing all theme colors with hex values
5. Spacing and layout grid examples
6. All text and copy used across the app — onboarding text, error messages, button labels, empty states
7. Mobile-responsive layout

Cortana — coordinate ALL 13 agents:
- Ace: build the /design route, page component, and all UI element demos
- Sophie: review UX, glassmorphism quality, spacing, contrast ratios, accessibility
- Liv: write all showcase copy — section headers, descriptions, placeholder text
- Kane: security review of the new route
- Raj: API/route review
- Kai: performance review — bundle size impact, render performance
- Elena: any data/state considerations
- Jude: deploy via Cloud Build when ready
- Max: QA test the page across viewports
- Harper: legal review of any content/copy
- Mia: iOS Safari rendering review
- Leo: Android Chrome rendering review

Every agent MUST post their contribution or review in their own channel. This is a full-team exercise.'

DISCORD_SMOKE_PROFILE=full \
DISCORD_SMOKE_PRE_CLEAR=false \
DISCORD_SMOKE_ELEVENLABS_CHECK=false \
DISCORD_SMOKE_ELEVENLABS_TTS=false \
DISCORD_SMOKE_ELEVENLABS_VOICE_BRIDGE=false \
DISCORD_SMOKE_VOICE_ACTIVE_CALL=false \
DISCORD_SMOKE_REQUIRE_LIVE_ROUTER=true \
  node -r dotenv/config dist/discord/tester.js --goal="$GOAL_PROMPT" 2>&1 | tee -a "$LOGFILE"

GOAL_EXIT=$?
echo "" | tee -a "$LOGFILE"
echo "Goal mode exit code: $GOAL_EXIT" | tee -a "$LOGFILE"
echo "Goal mode completed: $(date -u)" | tee -a "$LOGFILE"

# ── Cooldown between phases ─────────────────────────────────────────
echo "" | tee -a "$LOGFILE"
echo "Cooling down 60s before matrix..." | tee -a "$LOGFILE"
sleep 60

# ── Phase 2: Full Capability Matrix ────────────────────────────────
echo "" | tee -a "$LOGFILE"
echo "═══════════════════════════════════════════════════════" | tee -a "$LOGFILE"
echo "  PHASE 2: Full Capability Matrix (155 tests)" | tee -a "$LOGFILE"
echo "═══════════════════════════════════════════════════════" | tee -a "$LOGFILE"

DISCORD_SMOKE_PROFILE=matrix \
DISCORD_SMOKE_PRE_CLEAR=false \
DISCORD_SMOKE_ELEVENLABS_CHECK=false \
DISCORD_SMOKE_ELEVENLABS_TTS=false \
DISCORD_SMOKE_ELEVENLABS_VOICE_BRIDGE=false \
DISCORD_SMOKE_VOICE_ACTIVE_CALL=false \
DISCORD_SMOKE_REQUIRE_LIVE_ROUTER=true \
DISCORD_SMOKE_POST_SUCCESS_RESET_AND_ANNOUNCE=false \
  node -r dotenv/config dist/discord/tester.js --pm2-logs 2>&1 | tee -a "$LOGFILE"

MATRIX_EXIT=$?
echo "" | tee -a "$LOGFILE"
echo "Matrix exit code: $MATRIX_EXIT" | tee -a "$LOGFILE"
echo "Matrix completed: $(date -u)" | tee -a "$LOGFILE"

# ── Phase 3: Rerun Failed (if any failed) ──────────────────────────
if [ "$MATRIX_EXIT" -ne 0 ]; then
  echo "" | tee -a "$LOGFILE"
  echo "═══════════════════════════════════════════════════════" | tee -a "$LOGFILE"
  echo "  PHASE 3: Rerun Failed Tests" | tee -a "$LOGFILE"
  echo "═══════════════════════════════════════════════════════" | tee -a "$LOGFILE"
  sleep 30

  DISCORD_SMOKE_PROFILE=matrix \
  DISCORD_SMOKE_PRE_CLEAR=false \
  DISCORD_SMOKE_ELEVENLABS_CHECK=false \
  DISCORD_SMOKE_ELEVENLABS_TTS=false \
  DISCORD_SMOKE_ELEVENLABS_VOICE_BRIDGE=false \
  DISCORD_SMOKE_VOICE_ACTIVE_CALL=false \
  DISCORD_SMOKE_REQUIRE_LIVE_ROUTER=true \
  DISCORD_SMOKE_POST_SUCCESS_RESET_AND_ANNOUNCE=false \
    node -r dotenv/config dist/discord/tester.js --rerun-failed --pm2-logs 2>&1 | tee -a "$LOGFILE"

  RERUN_EXIT=$?
  echo "" | tee -a "$LOGFILE"
  echo "Rerun exit code: $RERUN_EXIT" | tee -a "$LOGFILE"
else
  echo "" | tee -a "$LOGFILE"
  echo "All matrix tests passed — skipping rerun." | tee -a "$LOGFILE"
fi

echo "" | tee -a "$LOGFILE"
echo "=== Overnight Smoke Test Complete ===" | tee -a "$LOGFILE"
echo "Finished: $(date -u)" | tee -a "$LOGFILE"
echo "Reports in: $LOG_DIR" | tee -a "$LOGFILE"
ls -lt "$LOG_DIR"/*.md 2>/dev/null | head -10 | tee -a "$LOGFILE"
