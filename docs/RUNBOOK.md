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
| 0 | Written | nothing |
| 2 | Run **not trusted** (> 3% failed, > 10% no data, or no benchmark). **Previous watchlist kept.** Admin already got a Telegram message. | Read `failed_<date>.json` (below). Usually rate limits or a token problem; tomorrow's run retries. |
| 4 | **Stopped by the Fyers quota guard**: the screener allocation (2,200) was used, Fyers said the daily limit was reached, or a 2nd throttle came. **Previous watchlist kept**; candles fetched so far are kept; the next run resumes. Admin told. | Read `incomplete_<date>.json`. The usual cause is a first fill, which can take 2 evenings. Check the ledger: `docker exec quant_redis redis-cli HGETALL fyers:quota:$(TZ=Asia/Kolkata date +%F)`. |
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
- **As-of date** = the last *completed* session: today after 15:30 on a trading day, otherwise the previous trading day. A manual run on a holiday or before the open therefore screens the last real session (e.g. Tue 2026-10-20, a holiday → as of Mon 19th). Override with `docker compose --profile jobs run --rm -e SCREENER_AS_OF=YYYY-MM-DD quant_screener`. The 16:30 cron run only fires on trading days.
- **Fyers quota** (AGENTS.md §11.12). The Data-API limit is 5/s, 50/min and 5,000/day, shared by every job. The run first spends ~48 quote requests on the pre-filter, then fetches history for the plausible names only, at ≤ 40/min.
  - A first fill is about 2 requests per name, roughly 1,200–1,600 requests or 30–40 min. It may need 2 evenings (exit 4 the first night).
  - A normal day is about 1 request per name, roughly 600–800 requests or 15–20 min.
  - The admin message and `incomplete_<date>.json` say how far it got.
- **Today's quota use:** `docker exec quant_redis redis-cli HGETALL fyers:quota:$(TZ=Asia/Kolkata date +%F)` (`used:screener`, `used:seeder`, `used:anomaly`, `breaches`, `exhausted`).
- **Engine side:** the boot log shows `[Engine] 📋 Watchlist: /app/data/watchlist.json (N symbols)`. It warns, and pings admin, if the list is more than 3 trading days old.
- **Layer B:** the boot log shows `[AnomalyScanner] Scan set: /app/data/anomaly_universe.json` and `across N symbols` with N ≤ 323 (`layerB.maxSymbols`). It no longer reads the full `universe_stats.json`.

## Planned deploy: screener v2 (`feature/screener-v2`) — NOT DEPLOYED, NOT LIVE

**Preconditions:** this is **step 3** of "Merge and deploy order" below.
- `fix/session-robustness` is deployed.
- `signals` (0004) is applied. 0006 raises and rolls back if it isn't.
- The evidence report (`backtest/output/universe-comparison.md`) says PASS, and the owner approves going live.

Outside market hours.

1. Save the engine logs, then back up (`pg_dump`, see Backup). Migration 0006 runs in this window (0004 must already be applied).
2. `git pull origin v2 && git log --oneline -3`.
3. Build: `docker compose --profile jobs build quant_engine quant_screener quant_scheduler quant_api`. The API is included because its schema check reads migration files from its own image.
4. Migrate: `docker compose run --rm --no-deps quant_api npm run migrate -- --dry-run`. It should list only `0006_screener_sources` — if it also lists `0004_signals`, the signals deploy has not happened: stop and do that first. Then run it without `--dry-run`.
5. API: `docker compose up -d --no-deps --force-recreate quant_api`.
6. Scheduler: `docker compose up -d --no-deps --force-recreate quant_scheduler`, then `docker exec quant_scheduler grep -E "run_screener|purge_token" /etc/crontabs/root`.
7. Create the job container (it isn't started): `docker compose --profile jobs create quant_screener`.
8. Engine: `docker compose stop quant_engine && docker compose create --force-recreate quant_engine`. **Never `up -d` the engine off-hours.**
9. **That evening**, after 16:30: check the scheduler log and `screener_last.log` (above). The funnel prints `scanned → … → final watchlist`.
10. **After 17:15:** `docker exec quant_scheduler ls -la /app/token` should be empty, which shows the purge reaches the real volume.
11. **Next morning:** `docker logs quant_engine 2>&1 | grep -E "Watchlist:|screener|AnomalyScanner"`. Layer B should report ≤ 323 symbols from `anomaly_universe.json`.

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

## Merge and deploy order (fixed)

**Where the branches stand on 2026-10-20.** EC2 runs `bb7fb46`.

| Branch | Contains | Migration | State |
|---|---|---|---|
| `v2` @ `046ba43` | signals table (PR #8) + session robustness (PR #7) | 0004 | merged, **not deployed** |
| Part D (not built) | Nifty index-level tracking | **0005** (reserved) | — |
| `feature/screener-v2` | session-robustness + screener v2 | **0006** | pushed, unmerged, **not live** |

**The order:**

1. **Session robustness, which also deploys the signals table.**
   - Merged into `v2` (PR #7, `046ba43`). Next: deploy `v2`.
   - Migration: **0004**. The dry run must list only `0004_signals`.
   - Procedure: the "Planned deploy: `signals` table" and "Planned deploy: session robustness" sections, in one window.
2. **Part D.**
   - Branch from `v2` *after* step 1, then merge and deploy.
   - Migration: **0005**. The dry run must list only `0005_…`.
3. **Screener v2.** Only after the evidence report says PASS and the owner approves.
   - First merge `v2` into `feature/screener-v2` (it picks up Part D), and re-run the tests.
   - Then merge → `v2` and deploy ("Planned deploy: screener v2").
   - Migration: **0006**. The dry run must list only `0006_screener_sources`.

**Rules:**
- **Hard: 0004 before 0006.** 0006 alters the `signals` table. It checks for the table first and raises, so the runner rolls back. Verified on postgres:15, 2026-10-20.
- **Soft: 0005 before 0006**, by number. If Part D isn't ready when the screener passes its evidence step, the screener may go first **only with the owner's explicit OK**. 0005 then applies after 0006. The runner allows it, the two are independent, and it was verified with the real runner on 2026-10-20: `0001,0002,0003,0004,0006` → then `0005` → `0001…0006`.
- **One step per window, never two at once.** Every window:
  - outside 09:00–15:30 IST, ideally the evening before a trading day;
  - `pg_dump` first, and save the engine logs first;
  - the migrate dry run lists exactly the expected migration.
- **Gate between steps:** one clean trading day. That means:
  - no `Postgres insert error`;
  - watchdog trips ≤ 1;
  - `[JSFilter]` lines present;
  - the step's own checks in its section pass.
- **Never deploy `v2` (`3d34de7` or later) without running 0004.** The signals code would log a failed insert for every signal (no trade or alert is lost, but nothing is recorded).

## Screener v2 evidence run (backtest) — owner's PC, Windows / PowerShell

Run it locally: it needs a Fyers token and about 2 GB of disk, and EC2 has about 4 GB free. Nothing touches production state, since the backtest's Redis is in memory and its cache is local files. Thresholds are frozen in `config/screener.json`. The report prints the config hash; if a threshold changes after seeing results, rerun everything under a new label and report both runs.

**When to run.** Fyers' Data-API limits (5/s, **50/min**, **5,000/day**) are per app, so the PC and production share them. The fetch commands refuse to start on trading days during:
- **08:45–15:45 IST:** engine boot and the live session;
- **16:25–18:00 IST:** the 16:30 screener job.

Good windows are after 18:00 on a trading day, or a weekend or holiday while the token is valid.

**It takes several evenings.** Every fetch request goes through the quota gate: ≤ 40/min, and at most **1,500 requests per IST day** (the `backtest` allocation in `config/fyers_quota.json`), counted in `backtest\data\quota-ledger.json`.
- `fetch-daily-all` is about 2,350 symbols × 3 chunks ≈ 7,000 requests, about **5 evenings**.
- `fetch-intraday` is about 400–800 symbols × 5 chunks ≈ 2,000–4,000 requests, about **2–3 evenings**.

At 40/min one evening's 1,500 takes about 38 minutes. Each evening, rerun the same command. It stops with `⏸️ … used its 1500 Data-API requests … Rerun the SAME command on the next allowed evening`, and resumes exactly where it stopped (tested: three nights = one clean run). A daily-limit answer stops it after one request. `--allow-market-hours` overrides the guard; don't use it. The `run` and `compare` steps make no API calls and can run at any time.

```powershell
# ── 0. One-time setup ──────────────────────────────────────────────────────
cd N:\trade\insider-quant-engine
git fetch origin
git switch feature/screener-v2
git pull
npm ci
# .env must contain FYERS_APP_ID and FYERS_SECRET_ID (the same app as production).
# Keep the PC awake for the run:
powercfg /change standby-timeout-ac 0

# ── 1. Today's token, copied from EC2 (after that day's login) ─────────────
# The token is a secret: don't paste it into chat, don't commit it
# (backtest/access_token.txt is gitignored).
ssh ubuntu@3.6.238.160 "docker volume ls --format '{{.Name}}' | grep token_store"
# use the name printed above in place of <VOL>:
ssh ubuntu@3.6.238.160 "docker run --rm -v <VOL>:/t alpine cat /t/access_token.txt > ~/tok.txt && chmod 600 ~/tok.txt"
scp ubuntu@3.6.238.160:~/tok.txt .\backtest\access_token.txt
ssh ubuntu@3.6.238.160 "rm -f ~/tok.txt"
$env:FYERS_TOKEN_PATH = (Resolve-Path .\backtest\access_token.txt).Path

# ── 2. Fetch (API calls; mind the window above) ─────────────────────────────
Start-Transcript -Path .\backtest\output\evidence-fetch.log -Append
npx tsx backtest/run.ts fetch-daily-all --days 365   # ~2,350 symbols + NIFTY50 + NIFTY500, ~30–40 min
npx tsx backtest/run.ts universes --days 365         # no API calls; builds output\universes.json, prints list sizes
npx tsx backtest/run.ts fetch-intraday               # 5-minute bars for every listed symbol, ~15–30 min
Stop-Transcript

# ── 3. Replay each universe (no API calls) ─────────────────────────────────
$env:BACKTEST_MODE = 'true'
foreach ($L in 'old', 'new', 'random1', 'random2', 'random3') {
    npx tsx backtest/run.ts run --universe-list $L --label $L
    if ($LASTEXITCODE -ne 0) { Write-Error "run $L failed"; break }
}
Remove-Item Env:BACKTEST_MODE

# ── 4. Compare → backtest\output\universe-comparison.md ─────────────────
npx tsx backtest/run.ts compare
```

**Token:** you need that day's token for each evening (step 1).

**If the token expires mid-fetch** (it is single-day):
- The fetch stops at the first rejected call and prints `⛔ Fyers rejected the token … Everything fetched so far is saved in the cache … rerun the SAME command`.
- Get the next day's token (step 1) and rerun the same command. Only missing chunks are requested; this is tested in `tests/backtestFetchResume.test.ts`, where the final cache is identical to an uninterrupted run.
- On a later day, each symbol's newest chunk is requested once more to pick up new bars (one call per symbol).
- Do **not** rerun `universes` between a partial and a completed `fetch-daily-all`. It needs the complete daily cache.

**Exit codes.** On Windows, `npx` reports every failure as 1, so check the last lines of the output. The guard's message starts with `[backtest] ⛔`.

**Clean up afterwards:**
- Delete `backtest\access_token.txt`.
- `powercfg /change standby-timeout-ac 30` (or your previous value).
- Commit only `backtest/output/universe-comparison.md`. The other outputs are gitignored.

## Planned deploy: Fyers quota discipline (`fix/fyers-quota`) — NOT DEPLOYED

No migration. Outside market hours. **Re-enabling the screener makes live Fyers calls, so the owner decides when** (the first run is ~48 quote requests, then ≤ 40/min history up to 2,200).

1. Save the engine logs. Then `git pull origin v2 && git log --oneline -1` (after the PR is merged).
2. Build: `docker compose --profile jobs build quant_engine quant_screener quant_scheduler`.
   - Engine: the gated seeder and anomaly code.
   - Screener: pre-filter and gate.
   - Scheduler: the exit-code legend.
3. `docker compose up -d --no-deps --force-recreate quant_scheduler`.
4. Engine: `docker compose stop quant_engine && docker compose create --force-recreate quant_engine`.
5. **Screener, only on the owner's go:**
   - `docker compose --profile jobs create quant_screener`. This re-enables the 16:30 cron.
   - For a deliberate first run, use an evening after 18:00 with that day's token (before 17:15 the token still exists; after the 17:15 purge it doesn't, so log in first).
   - Run `docker start -a quant_screener; echo "exit $?"`.
   - Expect exit **0** (list written) or **4** (allocation used, so the first fill continues the next evening).
6. Ledger check after any run: `docker exec quant_redis redis-cli HGETALL fyers:quota:$(TZ=Asia/Kolkata date +%F)`.
   - `used:screener` should be ≤ 2200.
   - `breaches` should be 0.
   - `exhausted` should be absent.

**Rollback:** check out the previous SHA, rebuild the same three images, and repeat steps 3–4. Remove `quant_screener` again (`docker rm quant_screener`) if the screener misbehaves.
