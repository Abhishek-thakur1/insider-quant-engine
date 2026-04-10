#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# — Sends a random motivational message to Telegram channel
# Called by cron with argument: 'open' or 'close'
# ─────────────────────────────────────────────────────────────────────────────

ACTION=$1
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')

if [ -f /app/.env ]; then
	while IFS='=' read -r key value; do
		# Skip comments and blank lines
		case "$key" in
			'#'*|'') continue ;;
		esac
		# Strip any surrounding quotes from the value
		value=$(printf '%s' "$value" | sed "s/^['\"]//;s/['\"]$//")
		case "$key" in
			TELEGRAM_BOT_TOKEN)     TELEGRAM_BOT_TOKEN="$value" ;;
			TELEGRAM_CHANNEL_ID)    TELEGRAM_CHANNEL_ID="$value" ;;
		esac
	done < /app/.env
fi
 
if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHANNEL_ID" ]; then
	echo "[$TIMESTAMP][MarketMsg] ❌ TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID not set. Aborting."
	exit 1
fi
 
log() {
	echo "[$TIMESTAMP][MarketMsg] $1"
}
 
send_message() {
	curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
		-d chat_id="${TELEGRAM_CHANNEL_ID}" \
		-d parse_mode="Markdown" \
		-d text="$1" > /dev/null
}
 
rand_pick() {
	awk -v n="$1" 'BEGIN { srand(); print int(rand() * n) }'
}
 
case "$ACTION" in
  open)
    set -- \
      "🌅 *Market Open* — The battlefield is live. Stay sharp, trade smart." \
      "⚡ *Engines Running* — 100 stocks under surveillance. Let the institutions move first." \
      "🎯 *Day Ahead* — Patience wins today. Wait for the setup, not the noise." \
      "🏛️ *Institutional Radar Active* — Follow the big money. Ignore the retail noise." \
      "🔍 *Eyes Open* — One clean breakout is worth more than ten mediocre trades." \
      "🚀 *Market Live* — The edge belongs to those who wait for confirmation." \
      "💡 *Trading Day Begins* — Volume tells the truth. Price tells stories." \
      "🧠 *Stay Disciplined* — No FOMO. No revenge trades. Let the system work." \
      "⏳ *Patience is the Edge* — The best setups reveal themselves. Do not force it." \
      "🌊 *Ride the Institutional Wave* — When the big money moves, we move with it."
    IDX=$(rand_pick 10)
    eval "MSG=\${$((IDX + 1))}"
    send_message "$MSG"
    log "📤 [open] $MSG"
    ;;
 
  close)
    set -- \
      "🔔 *Market Closing* — Book profits. Exit open positions. Rest the mind." \
      "🛑 *3:30 Approaching* — No new entries. Protect what you earned today." \
      "📊 *Day Done* — Review your trades tonight. The market opens again tomorrow." \
      "💰 *Closing Bell* — Discipline today compounds into wealth tomorrow." \
      "🧘 *Market Closing* — Detach from the P&L. Evaluate the process, not the outcome." \
      "🌙 *Session Ending* — The engine powers down. See you at the open tomorrow." \
      "✅ *Trading Day Complete* — If you followed the rules, it was a good day regardless of P&L." \
      "📉📈 *Day Wrap* — Markets close. Lessons stay. Come back stronger tomorrow." \
      "🔒 *Positions Closed* — Capital preserved is capital ready to fight another day." \
      "🏁 *Final Bell* — The best traders know when to stop. Today is done."
    IDX=$(rand_pick 10)
    eval "MSG=\${$((IDX + 1))}"
    send_message "$MSG"
    log "📤 [close] $MSG"
    ;;
 
  *)
    log "❌ Unknown action: $ACTION. Valid: open | close"
    exit 1
    ;;
esac