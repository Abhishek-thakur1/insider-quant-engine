#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Quant Engine Daily Lifecycle Controller
#
# Called by cron at specific times. Receives one argument:
#   start_auth    → 7:45 AM  — boot quant_auth so it can send the Telegram ping
#   start_engine  → 9:00 AM  — boot quant_engine (token must exist by now)
#   stop_engine   → 3:30 PM  — graceful shutdown of quant_engine
#   run_screener  → 4:30 PM  — EOD screener job (writes tomorrow's watchlist)
#   purge_token   → 5:15 PM  — delete today's Fyers token (after the screener used it)
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

  # ── 7:45 AM ───────────────────────────────────────────────────────────────
  # Start auth bridge. It will:
  #   1. Send the Telegram login link
  #   2. Catch the /callback from Fyers
  #   3. Write access_token.txt to the shared volume
  #   4. Call process.exit(0) on its own — Docker restart:no means it stays dead
  start_auth)
    if ! VERDICT=$(/usr/local/bin/trading_day.sh); then
        log "🏖️  Not a trading day ($VERDICT). Skipping auth bridge."
        exit 0
    fi
    log "🔐 Starting quant_auth..."
    docker start quant_auth
    log "✅ quant_auth started. Awaiting manual Fyers login via Telegram."
    ;;

  # ── 9:00 AM ───────────────────────────────────────────────────────────────
  # By 9:00 the trader has had 1h15m to click the Telegram link.
  # quant_engine polls for the token file internally — if it's not there yet
  # it will wait (the `until` loop in docker-compose command).
  start_engine)
    if ! VERDICT=$(/usr/local/bin/trading_day.sh); then
        log "🏖️  Not a trading day ($VERDICT). Skipping engine boot."
        exit 0
    fi
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

    # The token purge moved to purge_token (17:15): the 16:30 screener needs it.
    ;;

  # ── 4:30 PM ───────────────────────────────────────────────────────────────
  # End-of-day screener. Runs after the 16:00 backup. Exit codes from
  # scripts/screener_eod.ts: 0 written, 2 run not trusted (previous watchlist
  # kept, admin already told), 4 stopped by the Fyers quota guard (candles kept,
  # resumes next run), 3 no token, 1 crash.
  run_screener)
    if ! VERDICT=$(/usr/local/bin/trading_day.sh); then
        log "🏖️  Not a trading day ($VERDICT). Skipping screener."
        exit 0
    fi
    log "🔍 Starting quant_screener..."
    docker start -a quant_screener > /var/log/screener_last.log 2>&1
    CODE=$?
    tail -40 /var/log/screener_last.log
    log "quant_screener exited $CODE (0 written · 2 kept previous list · 4 quota guard stopped it, resumes next run · 3 no token · 1 crash)."
    ;;

  # ── 5:15 PM ───────────────────────────────────────────────────────────────
  # Remove today's token so tomorrow's engine can't boot on a stale one.
  # This container mounts the compose volume token_store at /app/token, so the
  # file is deleted directly. (The old one-shot `docker run -v quant_token_store`
  # named a volume that only matches if the compose project is "quant". Evidence
  # it never matched: Oct 14 liveness found a *stale* token, not a missing one.
  # Unverified on the host until `docker volume ls` is checked — this path
  # doesn't depend on the volume's name either way.)
  purge_token)
    if rm -f /app/token/access_token.txt; then
        log "🗑️  Token purged (/app/token/access_token.txt)."
    else
        log "❌ Token purge failed."
    fi
    ;;

  *)
    log "❌ Unknown action: $ACTION. Valid: start_auth | start_engine | stop_engine | run_screener | purge_token"
    exit 1
    ;;

esac