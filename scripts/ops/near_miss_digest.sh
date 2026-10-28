#!/usr/bin/env bash
# ============================================================
# scripts/ops/near_miss_digest.sh — the day's REJECTED fires, for the 15:45 admin summary.
#
# READ-ONLY: one SELECT against quant_postgres; prints the digest on stdout. Sends nothing itself;
# the host monitor (~/evidence/monitor/check.sh, MODE=summary) appends it to its message.
# These are NOT alerts: every row failed the filter (REGIME / EV / SCORE) or errored in it. The
# paper outcome is the ungated paper trade the pipeline records for score rejects (EV and REGIME
# rejects create no paper row). Paper R/₹ are as stored, before costs; nothing here is a measured
# edge (AGENTS.md non-negotiable 7).
#
#   DAY=2026-10-26 scripts/ops/near_miss_digest.sh          # default DAY = today (IST)
#   MAX_ROWS=10 (default, owner cap 28 Oct)  the top N rejected fires BY SCORE are listed;
#                          the rest are counted by gate on one line
# ============================================================
set -u
DAY=${DAY:-$(TZ=Asia/Kolkata date +%F)}
MAX_ROWS=${MAX_ROWS:-10}
case "$DAY" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) echo "bad DAY: $DAY" >&2; exit 2 ;; esac
case "$MAX_ROWS" in ''|*[!0-9]*) echo "bad MAX_ROWS: $MAX_ROWS" >&2; exit 2 ;; esac

PG() { docker exec -i quant_postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -v ON_ERROR_STOP=1' 2>&1; }

ROWS=$(PG <<SQL
with r as (
  select s.fired_at, s.symbol, s.detector, s.direction, s.score, s.score_threshold, s.filter_result, s.rejected_at,
         s.ev_reason, s.regime_reason, p.status, p.r_multiple, p.exit_reason, p.actual_size
  from signals s left join paper_trades p on p.id = s.trade_id
  where s.trade_date = '$DAY' and s.filter_result <> 'PASSED'
)
select to_char(fired_at at time zone 'Asia/Kolkata', 'HH24:MI') || ' '
    || regexp_replace(regexp_replace(symbol, '^NSE:', ''), '-(EQ|INDEX)$', '') || ' '
    || case direction when 'LONG' then 'L' else 'S' end || ' · '
    || case detector
         when 'Volatility_Contraction_V2' then 'VCP'
         when 'Stock Momentum Breakout' then 'Momentum'
         when 'Nifty VWAP Reclaim' then 'Nifty VWAP'
         when 'Nifty Opening Range Explosion' then 'Nifty ORE'
         when 'Nifty Trend Pulse' then 'Nifty Pulse'
         else detector end || ' · '
    || 'score ' || coalesce(round(score)::text, '?') || '/' || coalesce(round(score_threshold)::text, '?') || ' · '
    || case
         when filter_result = 'ERROR' then 'FILTER ERROR'
         when rejected_at = 'EV' then 'EV: ' || coalesce(substring(ev_reason from '(NEGATIVE EV [^ ]+)'), left(coalesce(ev_reason, '?'), 50))
         when rejected_at = 'REGIME' then 'REGIME: ' || left(coalesce(regime_reason, '?'), 50)
         else coalesce(rejected_at, '?') end || ' · '
    || case
         when status is null then 'no paper row'
         when status = 'SKIPPED' then 'paper SKIPPED (capital)'
         when status = 'OPEN' then 'paper OPEN (so far)'
         when status = 'CLOSED' then 'paper ' || coalesce(to_char(r_multiple, 'SG0.00') || 'R', '?R') || coalesce(' ' || exit_reason, '')
         else 'paper ' || status end
from r order by score desc nulls last, fired_at;
SQL
)
[ $? -ne 0 ] && { echo "🔎 Near-miss digest $DAY: query failed (${ROWS:0:120})"; exit 0; }

SUM=$(PG <<SQL
select count(*) || '|'
    || count(*) filter (where status = 'CLOSED') || '|'
    || coalesce(to_char(sum(r_multiple) filter (where status = 'CLOSED'), 'SG0.00'), '+0.00')
from (select p.status, p.r_multiple
      from signals s left join paper_trades p on p.id = s.trade_id
      where s.trade_date = '$DAY' and s.filter_result <> 'PASSED') x;
SQL
)
BYGATE=$(PG <<SQL
select coalesce(string_agg(g || ' ' || n, ', ' order by n desc), 'none') from (
  select coalesce(case when filter_result = 'ERROR' then 'ERROR' else rejected_at end, '?') g, count(*) n
  from signals where trade_date = '$DAY' and filter_result <> 'PASSED' group by 1) x;
SQL
)
IFS='|' read -r N NCLOSED RSUM <<< "$SUM"
N=${N:-0}

if [ "$N" = 0 ]; then
  echo "🔎 Near-miss digest $DAY: no rejected fires. (NOT alerts.)"
  exit 0
fi
echo "🔎 Near-miss digest $DAY — NOT ALERTS, review only"
echo "${N} rejected fires (${BYGATE}). Paper outcomes are ungated paper trades, before costs; ${NCLOSED} closed, sum ${RSUM}R."
printf '%s\n' "$ROWS" | head -n "$MAX_ROWS" | sed 's/^/• /'
TOTAL=$(printf '%s\n' "$ROWS" | grep -c .)
if [ "$TOTAL" -gt "$MAX_ROWS" ]; then
  REST=$(PG <<SQL
select coalesce(string_agg(g || ' ' || n, ', ' order by n desc), 'none') from (
  select coalesce(case when filter_result = 'ERROR' then 'ERROR' else rejected_at end, '?') g, count(*) n
  from (select filter_result, rejected_at from signals where trade_date = '$DAY' and filter_result <> 'PASSED'
        order by score desc nulls last, fired_at offset $MAX_ROWS) t group by 1) x;
SQL
)
  echo "• +$((TOTAL - MAX_ROWS)) more, not listed (${REST}); full list: signals table, trade_date $DAY"
fi
exit 0
