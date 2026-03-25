#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Quant Engine Daily Lifecycle Controller
#
# Called by cron at specific times. Receives one argument:
#   start_auth    → 8:45 AM  — boot quant_auth so it can send the Telegram ping
#   start_engine  → 9:15 AM  — boot quant_engine (token must exist by now)
#   stop_engine   → 3:30 PM  — graceful shutdown of quant_engine
#
# Docker socket is mounted from the host, so `docker` commands here control
# real sibling containers — not children of this container.
# ─────────────────────────────────────────────────────────────────────────────

ACTION=$1
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')

log() {
    echo "[$TIMESTAMP][Scheduler] $1"
}

case "$ACTION" in

  # ── 8:45 AM ───────────────────────────────────────────────────────────────
  # Start auth bridge. It will:
  #   1. Send the Telegram login link
  #   2. Catch the /callback from Fyers
  #   3. Write access_token.txt to the shared volume
  #   4. Call process.exit(0) on its own — Docker restart:no means it stays dead
  start_auth)
    log "🔐 Starting quant_auth..."
    docker start quant_auth
    log "✅ quant_auth started. Awaiting manual Fyers login via Telegram."
    ;;

  # ── 9:15 AM ───────────────────────────────────────────────────────────────
  # By 9:15 the trader has had 30 minutes to click the Telegram link.
  # quant_engine polls for the token file internally — if it's not there yet
  # it will wait (the `until` loop in docker-compose command).
  start_engine)
    log "🚀 Starting quant_engine..."
    docker start quant_engine
    log "✅ quant_engine started. Internal boot sequence running."
    ;;

  # ── 3:30 PM ───────────────────────────────────────────────────────────────
  # Market closed at 3:30 PM IST. Stop the engine cleanly.
  # `docker stop` sends SIGTERM first (graceful), then SIGKILL after 10s.
  stop_engine)
    log "🛑 Market closed. Stopping quant_engine..."
    docker stop quant_engine
    log "✅ quant_engine stopped."

    # Also stop auth bridge in case it never received a callback today
    # (e.g. trader forgot to log in). Silent fail if already stopped.
    docker stop quant_auth 2>/dev/null || true
    log "🧹 quant_auth cleaned up."

    # Remove stale token so tomorrow's auth starts clean
    # The token lives in a named Docker volume — use a one-shot container to delete it
    docker run --rm \
      -v quant_token_store:/token \
      alpine:3.19 \
      sh -c "rm -f /token/access_token.txt && echo '[Scheduler] 🗑️  Stale token purged.'"
    ;;

  *)
    log "❌ Unknown action: $ACTION. Valid: start_auth | start_engine | stop_engine"
    exit 1
    ;;

esac