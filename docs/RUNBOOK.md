# RUNBOOK — operating the EC2 deployment

> The owner runs every command here on the host (`ubuntu@<EIP>`, repo at `~/insider-quant-engine`).
> Agents have no SSH access. They hand over commands and record the pasted output as evidence.
> Every "verified" line below cites the output it came from. If there's no evidence, it isn't verified.

## Deployment record

| Date (IST) | Deployed SHA | What | Evidence |
|---|---|---|---|
| 2026-10-18 ~18:20 | `bb7fb46` | Versioned migrations (0001–0003), read-only `quant_api` boot, ghost-row fix. Rebuilt `quant_api` + `quant_engine`. | Migrate output: 3 applied 12:53:26 UTC. `quant_api` log "✅ Database schema is current." `quant_engine` recreated, status `Created`. Host `git log --oneline -1` → `bb7fb46 (HEAD -> v2, origin/v2)`. |

### Container restart counts

Recorded 2026-10-18, after the bb7fb46 deploy (owner-pasted `docker inspect`). All times UTC.

| Container | Restarts | Last started | Status | Note |
|---|---|---|---|---|
| `quant_api` | 0 | 2026-10-18 12:54:33 | running | Recreated for bb7fb46 |
| `quant_engine` | 0 | never (new container) | created | Recreated for bb7fb46. Cron starts it 09:00 IST Mon. |
| `quant_auth` | 0 | 2026-10-16 02:15:01 (07:45 IST Fri) | exited | Normal: exits after writing the token |
| `quant_scheduler` | 0 | 2026-09-25 00:50:49 | running | |
| `quant_postgres` | 0 | 2026-09-09 16:37:44 | running | |
| `quant_redis` | 0 | 2026-09-09 16:37:44 | running | |

To capture them again:

```bash
docker inspect -f '{{.Name}} restarts={{.RestartCount}} started={{.State.StartedAt}} status={{.State.Status}}' \
  quant_api quant_engine quant_auth quant_scheduler quant_postgres quant_redis
```

## Deploying a code change

Do this outside market hours (09:00–15:30 IST).

1. **Back up first** (see below), then `git pull origin v2 && git log --oneline -1`.
2. Rebuild only the images whose code changed:
   - `quant_api`, `quant_engine` and `quant_auth` all build from `Dockerfile` with `COPY . .`.
   - `quant_scheduler` builds from `Dockerfile.scheduler` and copies only `scheduler/`.
   - Never recreate `quant_postgres` or `quant_redis`.
3. If `db/migrations/` changed:
   - Run `docker compose run --rm --no-deps quant_api npm run migrate -- --dry-run`.
   - Then run it without `--dry-run`.
   - Do this **before** the engine's next boot. The engine and API log a warning at boot when migrations are pending.
4. To restart the API: `docker compose up -d --no-deps --force-recreate quant_api`. This is safe at any time, because boot no longer writes data.
5. **Engine:** run `docker compose stop quant_engine && docker compose create --force-recreate quant_engine`.
   - That leaves it in `Created`, and the 09:00 cron `docker start`s it.
   - **Never `up -d` the engine off-hours.** The token volume still holds today's token, so it would run the screener and open the live socket.
   - A plain rebuild isn't enough: `docker start` keeps using the old container.
   - Add `--renew-anon-volumes` when dependencies change (`/app/node_modules` is an anonymous volume).
6. The next morning, check `docker logs quant_engine 2>&1 | grep -E "PositionTracker|schema"`.

## Planned deploy: `signals` table (migration 0004) — NOT DEPLOYED

Status: on branch `feature/signals-table`, awaiting owner review. **Not merged to `v2`, not deployed.** Run this only after the owner approves the merge, and after Monday's check of the `bb7fb46` engine boot. Do it outside market hours (09:00–15:30 IST).

**Preconditions (paste the output of each):**
```bash
docker logs quant_engine 2>&1 | grep -E "PositionTracker|schema|Postgres insert error"   # bb7fb46 boot healthy, no insert errors
docker exec quant_postgres psql -U postgres -d insider_quant -c "SELECT version FROM schema_migrations ORDER BY 1;"   # expect 0001–0003
```

**Steps:**
```bash
cd ~/insider-quant-engine

# 1. Backup + check the archive is readable
SHA=$(git rev-parse --short HEAD)
docker exec quant_postgres pg_dump -U postgres -d insider_quant -F c -f /tmp/pre_signals_$SHA.dump
docker cp quant_postgres:/tmp/pre_signals_$SHA.dump ~/pre_signals_$SHA.dump && ls -lh ~/pre_signals_$SHA.dump
docker run --rm -v ~/pre_signals_$SHA.dump:/d:ro postgres:15-alpine pg_restore -l /d | grep -E "TABLE|SEQUENCE"

# 2. Pull the merged v2, then rebuild BOTH images (quant_api's schema check reads migration files from its own image)
git pull origin v2 && git log --oneline -1
docker compose build quant_api quant_engine

# 3. Migrate: dry run must list ONLY 0004_signals
docker compose run --rm --no-deps quant_api npm run migrate -- --dry-run
docker compose run --rm --no-deps quant_api npm run migrate

# 4. API now, engine at the 09:00 cron
docker compose up -d --no-deps --force-recreate quant_api
docker logs quant_api --tail 20                        # expect "✅ Database schema is current."
docker compose stop quant_engine && docker compose create --force-recreate quant_engine
docker ps -a --filter name=quant_engine --format '{{.Names}} {{.Status}}'   # expect "Created"
```

**Verify after the first full session.** Paste all of this:
```bash
Q='docker exec quant_postgres psql -U postgres -d insider_quant -c'
$Q "SELECT trade_date, count(*) fires, count(*) FILTER (WHERE filter_result='PASSED') passed,
           count(*) FILTER (WHERE rejected_at='REGIME') rej_regime, count(*) FILTER (WHERE rejected_at='EV') rej_ev,
           count(*) FILTER (WHERE rejected_at='SCORE') rej_score, count(*) FILTER (WHERE filter_result='ERROR') filter_err,
           count(trade_id) traded, count(*) FILTER (WHERE alert_sent) alerted
    FROM signals GROUP BY 1 ORDER BY 1;"
$Q "SELECT alert_suppressed_reason, count(*) FROM signals WHERE trade_date = current_date GROUP BY 1 ORDER BY 2 DESC;"
# every paper trade today has a signal → expect 0
$Q "SELECT count(*) AS trades_without_signal FROM paper_trades p
    WHERE (p.entry_time AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
      AND NOT EXISTS (SELECT 1 FROM signals s WHERE s.trade_id = p.id);"
$Q "SELECT pg_size_pretty(pg_total_relation_size('signals')) AS signals_size, count(*) AS rows FROM signals;"
docker logs quant_engine 2>&1 | grep -c "Alert dispatched"          # must equal today's "alerted"
docker logs quant_engine 2>&1 | grep -E "[SignalLog]"            # expect the session-totals line; drops=0, no DROPPED lines
docker exec quant_redis redis-cli HGETALL jsfilter:stats            # fired+blocked should equal passed+rejected (before next boot)
```

**What counts as evidence:**
- `trades_without_signal = 0`;
- `alerted` equals the `Alert dispatched` count;
- `[SignalLog] session totals …` shows `failed_dropped=0 queue_cap_dropped=0`.

`unique_skipped` should be 0. If it isn't, record it: it means a detector fired twice in the same millisecond. Note the measured row count and size, which replace the volume estimate.

**Rollback:** run `$Q "DROP TABLE signals; DELETE FROM schema_migrations WHERE version='0004';"`, then redeploy the previous commit with the same rebuild/recreate steps. Old code ignores a missing table. The full fallback is restoring `~/pre_signals_$SHA.dump` (see Restore).

## Database migrations

- The migration files live in `db/migrations/NNNN_name.sql`. The runner is `src/db/migrate.ts` (see AGENTS.md §11.8 and §14).
- **Never edit an applied migration.** The runner refuses to run on a checksum mismatch. Add a new file instead.
- To check state, run `docker exec quant_postgres psql -U postgres -d insider_quant -c "SELECT * FROM schema_migrations;"`.

## Backup

- **Automated:** `scheduler/db_backup.sh` runs at 16:00 Mon–Fri. It writes a `pg_dump -F c` and uploads it to S3 (`S3_BACKUP_BUCKET`).
- **Manual, before any deploy or migration:**

```bash
docker exec quant_postgres pg_dump -U postgres -d insider_quant -F c -f /tmp/pre_<sha>.dump
docker cp quant_postgres:/tmp/pre_<sha>.dump ~/pre_<sha>.dump && ls -lh ~/pre_<sha>.dump
```

## Restore

**Test restore** into a scratch database. This never touches `insider_quant`:

```bash
docker run --rm -v ~/<file>.dump:/d:ro postgres:15-alpine pg_restore -l /d | grep -E "TABLE|SEQUENCE"   # archive readable?
docker cp ~/<file>.dump quant_postgres:/tmp/r.dump
docker exec quant_postgres createdb -U postgres restore_test
docker exec quant_postgres pg_restore -U postgres -d restore_test --no-owner /tmp/r.dump
docker exec quant_postgres psql -U postgres -d restore_test -c "SELECT status, count(*) FROM paper_trades GROUP BY 1;"
docker exec quant_postgres dropdb -U postgres restore_test
docker exec quant_postgres rm /tmp/r.dump
```

**Real restore** (rollback). Stop the writers first, keep the current DB as a fallback, then restore into a fresh `insider_quant`:

```bash
docker compose stop quant_engine quant_api
docker exec quant_postgres psql -U postgres -c "ALTER DATABASE insider_quant RENAME TO insider_quant_old_$(date +%Y%m%d);"
docker exec quant_postgres createdb -U postgres insider_quant
docker cp ~/<file>.dump quant_postgres:/tmp/r.dump
docker exec quant_postgres pg_restore -U postgres -d insider_quant --no-owner /tmp/r.dump
# then redeploy the commit that matches the dump's schema (a pre-bb7fb46 dump has no schema_migrations)
```

The real restore has **not** been exercised. Only the test restore has.

### Restore test log

| Date | Dump | Result | Evidence |
|---|---|---|---|
| 2026-10-18 | `~/pre_bb7fb46.dump` (87 KB, written 12:50 UTC, 3 min before migration 0003) | ✅ **Passed.** Archive lists `paper_trades` + data + sequence. Restored without errors: 1,555 `CLOSED` + 27 `OPEN` = 1,582 rows, matching the live pre-migration count. `schema_migrations` absent, as expected. Scratch DB dropped. | Owner-pasted `pg_restore -l` and `psql` output, 2026-10-18 |

## Planned deploy: session robustness (`fix/session-robustness`) — NOT DEPLOYED

Merge to `v2` only on the owner's say-so. Outside market hours, ideally the evening before a trading day.

> **This branch now contains the `signals` table** (v2 merged in at 5b10d1e). If migration 0004 is not yet applied on EC2, do the **"Planned deploy: `signals` table"** section above in the same window: rebuild `quant_api` too, and run `npm run migrate` (dry run first) **before** the engine's next boot. Check with `SELECT version FROM schema_migrations;`.

1. **Save the engine logs first.** A recreate deletes them:
   `docker logs -t quant_engine > ~/engine_$(date +%F_%H%M).log 2>&1 && ls -lh ~/engine_*.log`
2. Back up (see Backup; manual `pg_dump`). Required if 0004 is applied in this window.
3. `git pull origin v2 && git log --oneline -3`. Note the SHA.
4. Rebuild the changed images: `docker compose build quant_engine quant_scheduler`, plus `quant_api` if 0004 is being deployed now (see the note above).
5. Scheduler: `docker compose up -d --no-deps --force-recreate quant_scheduler`, then verify with the real script:
   ```bash
   docker exec quant_scheduler /usr/local/bin/trading_day.sh 2026-11-10; echo "exit $?"   # HOLIDAY, exit 2
   docker exec quant_scheduler /usr/local/bin/trading_day.sh 2026-11-04; echo "exit $?"   # TRADING, exit 0
   docker exec quant_scheduler /usr/local/bin/trading_day.sh;            echo "exit $?"   # today
   ```
6. Engine: `docker compose stop quant_engine && docker compose create --force-recreate quant_engine`.
   - That leaves it in `Created`. **Never `up -d` the engine off-hours.**
7. **Next trading day:**
   - **09:00:** `docker logs quant_engine 2>&1 | grep -E "Before 09:15|PositionTracker|Booting"`.
   - **After 09:20:** `grep -c "♥"` should increase every 5 min.
   - **After 15:30:** save the logs as in step 1, then `grep -E "Watchdog|JSFilter|Socket (closed|error)"`.
   - `docker exec quant_redis redis-cli HGETALL jsfilter:stats:$(TZ=Asia/Kolkata date +%F)`.
8. **On a holiday** (next one is 2026-11-10): `docker exec quant_scheduler tail -20 /var/log/scheduler.log` should show "Not a trading day" for auth, market messages, liveness and the engine. `docker inspect -f '{{.RestartCount}}' quant_engine` should not increase.

**Rollback:** `git checkout <previous SHA>`, then repeat steps 4–6. The new Redis keys (`engine:restarts:*`, `jsfilter:stats:*`) expire on their own and are harmless to the old code.

## EOD screener (`quant_screener`) — runbook

Builds tomorrow's watchlist at **16:30 IST on trading days** (`lifecycle.sh run_screener` → `docker start -a quant_screener`). The engine only reads the result at its next boot. Details: AGENTS.md §11.11.

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Written (or not a trading day) | nothing |
| 2 | Run **not trusted** (> 3% failed, > 10% no data, or no benchmark). **Previous watchlist kept.** Admin already got a Telegram message. | Read `failed_<date>.json` (below). Usually rate limits or a token problem; tomorrow's run retries. |
| 3 | No Fyers token | Today's login was missed; the old list stays. |
| 1 | Crash | `docker exec quant_scheduler cat /var/log/screener_last.log` |

Read-only checks:
```bash
docker exec quant_scheduler grep -E "quant_screener|screener" /var/log/scheduler.log | tail -5
docker exec quant_scheduler tail -40 /var/log/screener_last.log            # funnel + top 20
docker volume ls | grep screener_data                                      # real volume name
docker run --rm -v <that volume>:/d alpine sh -c 'ls -la /d; head -c 1500 /d/watchlist_meta.json'
```

- **Manual run** (outside 09:00–15:30, and only while today's token exists, i.e. before 17:15): `docker start -a quant_screener; echo "exit $?"`.
- **First run** has to fetch about 460 days of daily bars for about 2,350 symbols, roughly 25 minutes. Later runs take about 10 minutes.
- **Engine side:** the boot log shows `[Engine] 📋 Watchlist: /app/data/watchlist.json (N symbols)`. It warns, and pings admin, if the list is more than 3 trading days old.

## Planned deploy: screener v2 (`feature/screener-v2`) — NOT DEPLOYED, NOT LIVE

**Preconditions:**
- `fix/session-robustness` is deployed.
- `signals` (0004) is applied.
- The evidence report (`backtest/output/universe-comparison.md`) says PASS, and the owner approves going live.

Outside market hours.

1. Save the engine logs, then back up (`pg_dump`, see Backup). Migration 0005 runs in this window.
2. `git pull origin v2 && git log --oneline -3`.
3. Build: `docker compose --profile jobs build quant_engine quant_screener quant_scheduler quant_api`. The API is included because its schema check reads migration files from its own image.
4. Migrate: `docker compose run --rm --no-deps quant_api npm run migrate -- --dry-run`. It should list only `0005_screener_sources`. Then run it without `--dry-run`.
5. API: `docker compose up -d --no-deps --force-recreate quant_api`.
6. Scheduler: `docker compose up -d --no-deps --force-recreate quant_scheduler`, then `docker exec quant_scheduler grep -E "run_screener|purge_token" /etc/crontabs/root`.
7. Create the job container (it isn't started): `docker compose --profile jobs create quant_screener`.
8. Engine: `docker compose stop quant_engine && docker compose create --force-recreate quant_engine`. **Never `up -d` the engine off-hours.**
9. **That evening**, after 16:30: check the scheduler log and `screener_last.log` (above). The funnel prints `scanned → … → final watchlist`.
10. **After 17:15:** `docker exec quant_scheduler ls -la /app/token` should be empty, which shows the purge reaches the real volume.
11. **Next morning:** `docker logs quant_engine 2>&1 | grep -E "Watchlist:|screener"`.

Verify the old purge bug without changing anything:
```bash
docker volume ls | grep token
docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' quant_scheduler
```
If the token volume isn't literally `quant_token_store`, the old 15:30 purge never touched it.

**Rollback:**
- Check out the previous SHA and rebuild.
- `docker compose up -d --no-deps --force-recreate quant_scheduler`, then recreate the engine as in step 8.
- With the old compose command the engine runs `dailyScreener.ts` at boot again.
- 0005 can stay applied. It only widens a CHECK.

## Screener v2 evidence run (backtest) — owner's machine

This needs a Fyers token and about 2 GB of disk. EC2 has about 4 GB free, so run it locally. Nothing here touches live state; the backtest Redis is in-memory.

```bash
export FYERS_TOKEN_PATH=/path/to/access_token.txt     # today's token; .env must hold FYERS_APP_ID / FYERS_SECRET_ID
npx tsx backtest/run.ts fetch-daily-all --days 365     # daily bars, ~2,350 symbols + NIFTY50 + NIFTY500 (≈ 30–40 min)
npx tsx backtest/run.ts universes --days 365           # point-in-time lists → backtest/output/universes.json
npx tsx backtest/run.ts fetch-intraday                 # 5-minute bars for every listed symbol (resumable)
for L in old new random1 random2 random3; do
  BACKTEST_MODE=true npx tsx backtest/run.ts run --universe-list $L --label $L
done
npx tsx backtest/run.ts compare                        # → backtest/output/universe-comparison.md
```

Thresholds are frozen in `config/screener.json`, and the config hash is printed in the report. If one is changed after seeing results, rerun everything under a new label and report both runs.
