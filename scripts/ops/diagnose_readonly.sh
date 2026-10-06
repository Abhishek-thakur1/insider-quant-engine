#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# READ-ONLY diagnostic for the EC2 box. Changes nothing:
#   - no docker start/stop/restart/build, no compose up
#   - Postgres via PGOPTIONS default_transaction_read_only=on (writes would error)
#   - Redis: read commands only
#   - never prints secrets: .env / container env are filtered to a fixed allow-list
#
# Usage (on EC2 — Ubuntu 24.04, user `ubuntu`, repo at ~/insider-quant-engine,
# compose project name `insider-quant-engine`). Needs only docker + python3:
#   cd ~/insider-quant-engine && DAY=2026-10-06 sh scripts/ops/diagnose_readonly.sh
# Output: ~/diag_<DAY>.txt  — paste that file back.
# ─────────────────────────────────────────────────────────────────────────────

REPO=${REPO:-$HOME/insider-quant-engine}
# JSON <file> <python-expr over d>
JSON() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$@" 2>/dev/null; }
DAY=${DAY:-$(TZ=Asia/Kolkata date +%F)}
OUT="$HOME/diag_${DAY}.txt"
SINCE=$(date -u -d "${DAY} 00:00 +0530" +%Y-%m-%dT%H:%M:%SZ)
UNTIL=$(date -u -d "${DAY} 23:59 +0530" +%Y-%m-%dT%H:%M:%SZ)
ALLOW='^(SHADOW_MODE|CONFIRMATION_THRESHOLD|CAPITAL_CONSTRAINT_BEHAVIOR|PAPER_CAPITAL_BASE|TELEGRAM_MAX_ALERTS_PER_DAY|DB_HOST|DB_NAME|REDIS_HOST|TZ|NODE_ENV)='

PSQL() {
	docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' quant_postgres \
		psql -U "${DB_USER:-postgres}" -d "${DB_NAME:-insider_quant}" -X -P pager=off -v ON_ERROR_STOP=0 -v day="$DAY"
}
R() { docker exec quant_redis redis-cli "$@"; }
sec() { printf '\n\n===== %s =====\n' "$1"; }

{
sec "0. context"
echo "day(IST)=$DAY since=$SINCE until=$UNTIL host=$(hostname) now_utc=$(date -u)"

sec "1. deployed code vs v2"
git -C "$REPO" log -1 --format='host checkout: %H %ci %s'
git -C "$REPO" status -sb | head -3
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
for c in quant_engine quant_api quant_auth quant_scheduler quant_postgres quant_redis; do
	docker inspect -f '{{.Name}} created={{.Created}} started={{.State.StartedAt}} restarts={{.RestartCount}} exit={{.State.ExitCode}} image={{.Image}}' "$c" 2>&1
done
IMG=$(docker inspect -f '{{.Image}}' quant_engine 2>/dev/null)
docker image inspect -f 'engine image built={{.Created}}' "$IMG" 2>&1
echo "--- file fingerprints inside quant_engine (compare with expected below)"
for f in src/workers/telegramWorker.ts src/core/positionTracker.ts src/ingestion/websocket.ts src/api/server.ts src/detectors/v2/stockMomentumBreakoutDetector.ts; do
	h=$(docker cp "quant_engine:/app/$f" - 2>/dev/null | tar -xO 2>/dev/null | md5sum | cut -d' ' -f1)
	echo "$f $h"
done
cat <<'EXPECTED'
--- expected md5 (git blobs)
v2 HEAD 4d7683e : telegramWorker ce39a225…  positionTracker d14cd2fa…  websocket 30caceb7…  server b49cdefd…  SMB 48967f5a…
pre-fix 9b7910e : telegramWorker 58ee28a4…  positionTracker 1a2ab00b…  websocket 30caceb7…
8a42807/bda45cb : telegramWorker 58ee28a4…  positionTracker 1a2ab00b…  websocket b5286584…
EXPECTED
echo "--- node_modules is an anonymous volume: container copy vs image copy"
docker cp quant_engine:/app/node_modules/fyers-api-v3/package.json - 2>/dev/null | tar -xO 2>/dev/null | grep '"version"' | sed 's/^/container fyers-api-v3 /'
docker run --rm --entrypoint cat "$IMG" /app/node_modules/fyers-api-v3/package.json 2>/dev/null | grep '"version"' | sed 's/^/image     fyers-api-v3 /'
docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{println}}{{end}}' quant_engine

echo "--- docker volumes (lifecycle.sh purges 'quant_token_store'; compose project is insider-quant-engine)"
docker volume ls --format '{{.Name}}'

sec "2. config (allow-listed keys only)"
echo "--- .env"; grep -E "$ALLOW" "$REPO/.env" 2>/dev/null
echo "--- quant_engine runtime env"; docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' quant_engine | grep -E "$ALLOW"

sec "3. engine log, today"
docker logs -t --since "$SINCE" --until "$UNTIL" quant_engine > /tmp/engine_${DAY}.log 2>&1
L=/tmp/engine_${DAY}.log
echo "lines: $(wc -l < $L)"
for p in 'Booting Institutional Quant Router' 'Watchdog\] ⚠️' 'Already generated today' 'Saved stats for' 'Final watchlist size' \
	'Anomaly detected! Promoting' 'Registered new' 'Alert dispatched' ' blocked — ' '\[SHADOW\]' 'Skipped alert' \
	'Postgres insert error' 'Failed to send Telegram' 'Confirmation Engine\] ⚠️' 'Closed .* Reason'; do
	printf '%6s  %s\n' "$(grep -c -- "$p" $L)" "$p"
done
echo "--- boots / watchdog (timestamps)"; grep -E 'Booting Institutional|Watchdog\] ⚠️' $L | cut -c1-140
echo "--- screener"; grep -E 'Saved stats|Final watchlist|Already generated' $L | cut -c1-200
echo "--- promotions"; grep 'Promoting' $L | sed -E 's/.*Promoting ([^ ]+) to active universe. Reason: (.*)/\1 | \2/'
echo "--- alerts dispatched, by symbol"; grep -o 'Alert dispatched for [^ ]*' $L | sort | uniq -c | sort -rn
echo "--- alerts dispatched (timestamps)"; grep 'Alert dispatched' $L | cut -c1-140
echo "--- capital lines"; grep -E 'PositionSizing' $L | cut -c1-200 | head -80
echo "--- errors (first 40)"; grep -iE 'error|❌' $L | cut -c1-200 | head -40

sec "4. scheduler + api logs"
docker exec quant_scheduler sh -c 'tail -n 60 /var/log/scheduler.log' 2>&1
docker logs quant_api 2>&1 | grep -E 'Migration|expired|Listening' | tail -20

sec "5. universe_stats / watchlist inside quant_engine"
docker cp quant_engine:/app/universe_stats.json - 2>/dev/null | tar -xO 2>/dev/null > /tmp/us.json
echo "universe_stats symbols: $(JSON /tmp/us.json 'len(d)')  KSCL: $(JSON /tmp/us.json '"NSE:KSCL-EQ" in d')  HGINFRA: $(JSON /tmp/us.json '"NSE:HGINFRA-EQ" in d')"
docker cp quant_engine:/app/watchlist.json - 2>/dev/null | tar -xO 2>/dev/null > /tmp/wl.json
echo "watchlist size: $(JSON /tmp/wl.json 'len(d)')"; JSON /tmp/wl.json '" ".join(d)'

sec "6. redis (read-only)"
echo "trades:open=$(R HLEN trades:open) trades:history=$(R LLEN trades:history) pnl:daily=$(R GET pnl:daily) jsfilter:decisions=$(R LLEN jsfilter:decisions)"
echo "jsfilter:stats: $(R HGETALL jsfilter:stats | tr '\n' ' ')"
echo "cooldown keys: $(R --scan --pattern 'cooldown:*' | wc -l)"
R CONFIG GET bind; R CONFIG GET protected-mode
echo "--- jsfilter decisions since last boot (detector, passed, rejectedAt, score)"
R LRANGE jsfilter:decisions 0 999 | python3 -c '
import sys, json
for l in sys.stdin:
    try: r = json.loads(l)
    except Exception: continue
    print(*[r.get(k) for k in ("ts", "detector", "symbol", "side", "passed", "rejectedAt", "score")], sep="\t")
' | sort | head -300
echo "--- listening ports"; (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ':(6379|8080|5432|3000)\b'

sec "7. postgres (read-only transaction)"
PSQL <<'SQL'
SHOW timezone;
SELECT now(), now() AT TIME ZONE 'Asia/Kolkata' AS now_ist;
\d paper_trades

\echo '--- today funnel (IST entry date)'
WITH t AS (SELECT * FROM paper_trades WHERE (entry_time AT TIME ZONE 'Asia/Kolkata')::date = :'day')
SELECT count(*) total,
       count(*) FILTER (WHERE gated) gated,
       count(*) FILTER (WHERE gated IS NOT TRUE) ungated,
       count(*) FILTER (WHERE gated AND capital_gated AND actual_size = 0) gated_cap_skip,
       count(*) FILTER (WHERE gated AND capital_gated AND actual_size > 0) gated_cap_reduce,
       count(*) FILTER (WHERE gated AND capital_gated IS NOT TRUE) gated_clean
FROM t;

\echo '--- today by detector / direction / duration'
SELECT detector, direction, duration_class, count(*) n, count(*) FILTER (WHERE gated) gated,
       count(*) FILTER (WHERE capital_gated) cap
FROM paper_trades WHERE (entry_time AT TIME ZONE 'Asia/Kolkata')::date = :'day'
GROUP BY 1,2,3 ORDER BY n DESC;

\echo '--- today repeats: same symbol+detector'
SELECT symbol, detector, count(*) n, count(*) FILTER (WHERE gated) gated,
       string_agg(to_char(entry_time AT TIME ZONE 'Asia/Kolkata','HH24:MI'), ' ' ORDER BY entry_time) times
FROM paper_trades WHERE (entry_time AT TIME ZONE 'Asia/Kolkata')::date = :'day'
GROUP BY 1,2 HAVING count(*) > 1 ORDER BY n DESC;

\echo '--- today by 15-min bucket'
SELECT to_char(date_trunc('hour', entry_time AT TIME ZONE 'Asia/Kolkata')
       + floor(extract(minute FROM entry_time AT TIME ZONE 'Asia/Kolkata')/15) * interval '15 min','HH24:MI') bucket,
       count(*) n, count(*) FILTER (WHERE gated) gated
FROM paper_trades WHERE (entry_time AT TIME ZONE 'Asia/Kolkata')::date = :'day'
GROUP BY 1 ORDER BY 1;

\echo '--- today rows (csv)'
\copy (SELECT id, symbol, detector, direction, duration_class, gated, capital_gated, qty, actual_size, entry_price, stop_price, target_price, to_char(entry_time AT TIME ZONE 'Asia/Kolkata','HH24:MI:SS') entry_ist, status, exit_reason, exit_price, realized_pnl, r_multiple, regime_class FROM paper_trades WHERE (entry_time AT TIME ZONE 'Asia/Kolkata')::date = (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date) ORDER BY entry_time) TO STDOUT WITH CSV HEADER

\echo '--- last 15 IST days: rows by entry date'
SELECT (entry_time AT TIME ZONE 'Asia/Kolkata')::date d, count(*) n, count(*) FILTER (WHERE gated) gated,
       count(*) FILTER (WHERE capital_gated) cap, count(DISTINCT symbol) syms
FROM paper_trades WHERE entry_time > now() - interval '15 days' GROUP BY 1 ORDER BY 1;

\echo '--- SHORT/LONG geometry violations (all time)'
SELECT direction, detector, count(*) n, min(entry_time)::date first, max(entry_time)::date last
FROM paper_trades
WHERE (direction='SHORT' AND (target_price >= entry_price OR stop_price <= entry_price))
   OR (direction='LONG'  AND (target_price <= entry_price OR stop_price >= entry_price))
GROUP BY 1,2;

\echo '--- zero-PnL closed rows: why'
SELECT exit_reason, detector, (symbol LIKE 'NIFTY %') nifty_opt, capital_gated, (actual_size = 0) zero_size, count(*)
FROM paper_trades WHERE status='CLOSED' AND realized_pnl = 0 GROUP BY 1,2,3,4,5 ORDER BY 6 DESC;

\echo '--- OPEN rows by entry date'
SELECT (entry_time AT TIME ZONE 'Asia/Kolkata')::date d, detector, duration_class, count(*)
FROM paper_trades WHERE status='OPEN' GROUP BY 1,2,3 ORDER BY 1;

\echo '--- exit_reason x duration_class (all time)'
SELECT exit_reason, duration_class, count(*) FROM paper_trades GROUP BY 1,2 ORDER BY 3 DESC;

\echo '--- UTC vs IST exit-date disagreement (bucketing check)'
SELECT count(*) FROM paper_trades
WHERE exit_time IS NOT NULL AND exit_time::date <> (exit_time AT TIME ZONE 'Asia/Kolkata')::date;
SQL
} > "$OUT" 2>&1

echo "Wrote $OUT ($(wc -l < "$OUT") lines). Skim it for anything sensitive, then paste it back."
