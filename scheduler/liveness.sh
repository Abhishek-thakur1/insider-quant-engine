#!/bin/sh
# ──
# Quant Engine Liveness Check
#
# Called by cron at 9:10 AM to verify that the trader actually logged in
# and the access token was successfully written, BEFORE the engine tries to boot.
# If it fails, sends a loud Telegram alert.
# ──

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')

log() {
    echo "[$TIMESTAMP][Liveness] $1"
}

send_telegram_alert() {
    MESSAGE=$1
    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_ADMIN_ID" ]; then
        log "⚠️ Missing Telegram environment variables. Cannot send alert."
        return
    fi
    
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${TELEGRAM_ADMIN_ID}" \
        -d text="🚨 *Engine Liveness Failure* 🚨%0A%0A${MESSAGE}" \
        -d parse_mode="Markdown" > /dev/null
}

# The token is stored in the Docker volume mounted at /app/token
TOKEN_FILE="/app/token/access_token.txt"

# 1. Check if token file exists
if [ ! -f "$TOKEN_FILE" ]; then
    log "❌ Token file not found!"
    send_telegram_alert "The access token file is missing. Did you forget to click the login link?%0A%0AEngine boot will hang at 09:15 unless you login immediately."
    exit 1
fi

# 2. Check if token file is fresh (modified in the last 2 hours)
# We use `find` with -mmin to check for recent modifications
FRESH_TOKEN=$(find "$TOKEN_FILE" -mmin -120 2>/dev/null)

if [ -z "$FRESH_TOKEN" ]; then
    log "❌ Token file is stale (not updated today)!"
    send_telegram_alert "The access token file is stale. Today's login was not completed.%0A%0AEngine boot will hang at 09:15 unless you login immediately."
    exit 1
fi

log "✅ Token verified. Engine is clear to boot at 09:15."
exit 0
