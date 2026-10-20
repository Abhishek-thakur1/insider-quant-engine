#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Is a date an NSE trading day?   trading_day.sh [YYYY-MM-DD]   (default: today)
#
# Exit 0 = trading day, 1 = weekend, 2 = NSE holiday. Prints the verdict.
# Single source of truth for the scheduler: lifecycle.sh, market_message.sh and
# liveness.sh all call this. The engine reads the same holiday file
# (src/core/sessionGuard.ts), so the two can't disagree about a date.
# Container TZ is Asia/Kolkata (Dockerfile.scheduler), so `date` is IST.
# ─────────────────────────────────────────────────────────────────────────────

HOLIDAY_FILE=${NSE_HOLIDAY_FILE:-/etc/periodic/nse_holidays.txt}
D=${1:-$(date '+%Y-%m-%d')}

WD=$(date -d "$D" '+%u' 2>/dev/null)   # 1=Mon … 7=Sun
if [ -z "$WD" ]; then
    echo "trading_day: cannot parse date '$D'" >&2
    exit 3
fi

if [ "$WD" -ge 6 ]; then
    echo "$D WEEKEND"
    exit 1
fi

if grep -q "^$D" "$HOLIDAY_FILE" 2>/dev/null; then
    echo "$D HOLIDAY"
    exit 2
fi

if [ ! -r "$HOLIDAY_FILE" ]; then
    echo "$D TRADING (holiday file $HOLIDAY_FILE not readable)"
    exit 0
fi

echo "$D TRADING"
exit 0
