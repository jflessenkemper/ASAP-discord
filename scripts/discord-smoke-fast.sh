#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT_DIR"
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-asap-489910}"
DEV_LOG="${DEV_LOG:-/tmp/asap-discord-dev.log}"
PORT="${PORT:-3101}"
APP_HEALTH_URL="${APP_HEALTH_URL:-http://127.0.0.1:${PORT}/api/health}"
REUSE_RUNTIME="${DISCORD_SMOKE_REUSE_RUNTIME:-false}"
KILL_PORT_3001="${DISCORD_SMOKE_KILL_PORT_3001:-true}"

cleanup() {
  if [[ -n "${DEV_PID:-}" ]] && [[ "${STARTED_DEV:-0}" == "1" ]] && kill -0 "$DEV_PID" >/dev/null 2>&1; then
    kill "$DEV_PID" >/dev/null 2>&1 || true
    wait "$DEV_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd gcloud
need_cmd curl
need_cmd npm

fetch_secret() {
  local name="$1"
  gcloud secrets versions access latest --secret="$name" --project="$PROJECT_ID"
}

echo "[1/5] Loading secrets and runtime limits..."
export GOOGLE_CLOUD_PROJECT="$PROJECT_ID"
export DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-$(fetch_secret DISCORD_BOT_TOKEN)}"
export DISCORD_TEST_BOT_TOKEN="${DISCORD_TEST_BOT_TOKEN:-$(fetch_secret DISCORD_TEST_BOT_TOKEN)}"
export DISCORD_GUILD_ID="${DISCORD_GUILD_ID:-$(fetch_secret DISCORD_GUILD_ID)}"
export ELEVENLABS_API_KEY="${ELEVENLABS_API_KEY:-$(fetch_secret ELEVENLABS_API_KEY)}"

# Runtime limits (can be overridden by caller env)
export DAILY_LIMIT_GEMINI_LLM_TOKENS="${DAILY_LIMIT_GEMINI_LLM_TOKENS:-8000000}"
export DAILY_LIMIT_GEMINI_CALLS="${DAILY_LIMIT_GEMINI_CALLS:-2000}"
export DAILY_BUDGET_USD="${DAILY_BUDGET_USD:-250}"

echo "[2/5] Building server..."
pushd "$SERVER_DIR" >/dev/null
npm run -s build

echo "[3/5] Ensuring runtime (dev) with Discord bot is available..."
if [[ "$REUSE_RUNTIME" == "true" ]] && curl -sf "$APP_HEALTH_URL" >/dev/null; then
  echo "Existing healthy runtime detected; reusing it."
  STARTED_DEV=0
else
  if [[ "$KILL_PORT_3001" == "true" ]]; then
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${PORT}"/tcp >/dev/null 2>&1 || true
      sleep 1
    elif command -v ss >/dev/null 2>&1; then
      pid="$(ss -ltnp "( sport = :${PORT} )" 2>/dev/null | awk 'NR>1 {gsub(/.*pid=/, "", $NF); gsub(/,.*/, "", $NF); print $NF; exit}')"
      if [[ -n "$pid" ]]; then
        kill "$pid" >/dev/null 2>&1 || true
        sleep 1
      fi
    fi
  fi
  export PORT
  export DISCORD_BOT_ENABLED="true"
  export DISCORD_BOT_SKIP_LOCK="true"
  export DISCORD_BOT_ALLOW_SKIP_LOCK="true"
  export GEMINI_USE_VERTEX_AI="${GEMINI_USE_VERTEX_AI:-false}"
  export ANTHROPIC_USE_VERTEX_AI="${ANTHROPIC_USE_VERTEX_AI:-false}"
  export OPUS_USE_VERTEX_AI="${OPUS_USE_VERTEX_AI:-false}"
  export CODING_AGENT_MODEL="${CODING_AGENT_MODEL:-gemini-2.5-flash}"
  npm run -s dev >"$DEV_LOG" 2>&1 &
  DEV_PID=$!
  STARTED_DEV=1
fi

echo "[4/5] Waiting for health endpoint..."
READY=0
for _ in $(seq 1 45); do
  if curl -sf "$APP_HEALTH_URL" >/dev/null; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "$READY" -ne 1 ]]; then
  echo "Runtime did not become healthy. See $DEV_LOG" >&2
  if command -v ss >/dev/null 2>&1; then
    echo "Port 3001 listeners:" >&2
    ss -ltnp '( sport = :3001 )' 2>/dev/null >&2 || true
  fi
  exit 1
fi

# The HTTP health endpoint comes up well before the Discord bot finishes its
# full init (ACL hardening, contact load, channel configuration). Wait for the
# specific "channels configured" log line before firing the smoke, otherwise
# the tester's router probe fires into a not-yet-ready bot and times out.
# Cap at 90s so a genuinely broken bot still fails fast.
if [[ "${DISCORD_SMOKE_SKIP_READY_WAIT:-false}" != "true" ]]; then
  echo "[4.5/5] Waiting for Discord bot full init (channels configured)..."
  BOT_READY=0
  for _ in $(seq 1 90); do
    if grep -q "Discord channels configured" "$DEV_LOG" 2>/dev/null; then
      BOT_READY=1
      break
    fi
    sleep 1
  done
  if [[ "$BOT_READY" -ne 1 ]]; then
    echo "Discord bot did not reach 'channels configured' within 90s. See $DEV_LOG" >&2
    tail -30 "$DEV_LOG" >&2 || true
    exit 1
  fi
  echo "  ✓ Bot fully initialized"
fi

echo "[5/5] Running fast readiness smoke..."
export DISCORD_SMOKE_PROFILE="readiness"
# Bumped from 20s → 45s: the tester waits per-probe for router replies, and
# cold-start dev instances need more headroom than warm VM deploys.
export DISCORD_TEST_TIMEOUT_MS="${DISCORD_TEST_TIMEOUT_MS:-45000}"
export DISCORD_SMOKE_CAPABILITY_ATTEMPTS="${DISCORD_SMOKE_CAPABILITY_ATTEMPTS:-2}"
export DISCORD_SMOKE_PRE_CLEAR="false"
export DISCORD_SMOKE_POLL_INTERVAL_MS="${DISCORD_SMOKE_POLL_INTERVAL_MS:-900}"
export DISCORD_SMOKE_ELEVENLABS_CHECK="true"
export DISCORD_SMOKE_ELEVENLABS_TTS="true"
export DISCORD_SMOKE_ELEVENLABS_VOICE_BRIDGE="false"
export DISCORD_SMOKE_VOICE_ACTIVE_CALL="false"
export DISCORD_SMOKE_POST_SUCCESS_RESET_AND_ANNOUNCE="false"
export DISCORD_SMOKE_REQUIRE_LIVE_ROUTER="true"
# Bumped from 25s → 60s (the upper bound the tester allows). Cold-start dev
# instances are fully initialized by now but the first user message still has
# to propagate through Cortana → memory → reply, which eats several seconds.
export DISCORD_SMOKE_ROUTER_HEALTH_TIMEOUT_MS="${DISCORD_SMOKE_ROUTER_HEALTH_TIMEOUT_MS:-60000}"
npm run -s discord:test:fast

popd >/dev/null
echo "Smoke completed. Dev runtime log: $DEV_LOG"