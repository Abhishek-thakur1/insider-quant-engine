#!/usr/bin/env bash
# Post-deploy check for the /api/events heartbeat (src/api/sseHeartbeat.ts), through the real
# Vercel /api rewrite. Read-only: one GET of the event stream, nothing else.
# PASS = the stream is still open when curl's --max-time ends it (exit 28) and pings arrived.
# Before the heartbeat the rewrite closed the idle stream at 151 s (2026-10-23).
#   scripts/sse_soak.sh [base-url] [seconds]
BASE=${1:-https://ninefifteen.vercel.app}
SECS=${2:-300}
OUT=$(mktemp)
T0=$(date +%s)
curl -sN --max-time "$SECS" "$BASE/api/events?includeUngated=true" > "$OUT"
RC=$?
DUR=$(( $(date +%s) - T0 ))
PINGS=$(grep -c '^: ping' "$OUT")
rm -f "$OUT"
echo "base=$BASE duration=${DUR}s curl_exit=$RC pings=$PINGS"
if [ "$RC" = 28 ] && [ "$DUR" -ge "$SECS" ] && [ "$PINGS" -ge $(( SECS / 30 )) ]; then
  echo "PASS: stream held ${DUR}s (> 151 s) through the /api route"
else
  echo "FAIL: stream ended after ${DUR}s (exit $RC). If ~151 s with pings arriving, the cut is a hard cap, not idle."
  exit 1
fi
