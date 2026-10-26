# Changelog

Newest first. Paper trading only. "Not deployed" means it isn't running on EC2.

## Unreleased: `fix/staleness-message` (not merged, not deployed)

- **Boot staleness message names the file actually in use.** With `/app/data/watchlist.json` present but no `watchlist_meta.json` (EC2 since 20 Oct), the engine said `screener output not found … using the baked-in watchlist.json` and sent it to the admin chat on every boot, although it reads the volume's file (`resolveScreenerFile`). It now says `watchlist_meta.json not found in /app/data — using /app/data/watchlist.json; its age can't be checked`. The baked-in wording remains for when the volume file is missing too.
- Log text only: which file is read, and when the warning fires, are unchanged. Test: `tests/screenerWiring.test.ts`.

## Unreleased: `fix/orphan-skips-skipped` (PR #29; not merged, not deployed)

- **Boot orphaning now changes only OPEN rows** (AGENTS.md §11.22). Capital-skipped (SKIPPED) rows left in `trades:open` keep their status instead of becoming ORPHANED.
- **Cause:** `status IN ('OPEN', 'SKIPPED')` in the orphan UPDATE, from `bb7fb46` on 18 Oct.
- **Affected rows:** 6 (1583, 1585, 1590, 1596, 1599 and 1603).
- **Tests:** 2 in `tests/positionStatus.test.ts`, plus a real-Postgres check of both statements.
- The engine needs a rebuild to pick it up; this branch is review only.

## `docs/study-guide` (PR #25): docs only, merged 26 Oct; no code, config or deploy change

- **Interview-ready study guide** in `docs/study-guide/`:
  - `guide.md`: the Markdown source, Parts 0–10 plus security and cost;
  - `index.html`: one self-contained page with a sticky contents list, search, light and dark themes, Level 3 sections collapsed, print CSS, and 4 inline SVG diagrams. It makes no external requests.
  - `VERIFICATION.md`: 51 paths resolved, 20 numbers checked, 7 open items;
  - `OUTLINE.md`.
- **Worked example:** AEQUS 11:06 LONG on 22 Oct, with JSLL as the post-restart counter-example.
- **Dashboard redesign planning:** `docs/dashboard-redesign/AUDIT.md` and `wireframes.html`.
- **Rebuild the HTML:** `npm install --no-save marked@14.1.4 && node docs/study-guide/build.mjs`.

## `feat/api-signals-health` (PR #24): API container only, deployed outside market hours

- **New read-only endpoints for the dashboard redesign** (AGENTS.md §11.20):
  - `GET /api/signals?date=` lists the day's fires from the `signals` table.
  - `GET /api/health` gives coarse public health: status, stocks seen, and ticks per 5 minutes. That last one is `null` until the engine publishes it.
- **No writes:** no engine change, no migration.
- **Additive read-only fields:**
  - `/api/trades/history` adds `target`, `stopLoss` and `dataQuality`;
  - `/api/today` open trades add `gated`, `regimeClass` and `dataQuality`.
- **Stream keep-alive** (AGENTS.md §11.20): `/api/events` sends an SSE comment every 25 s, so the Vercel `/api` rewrite stops cutting the idle stream at 151 s. This is unverified until the deploy; `scripts/sse_soak.sh` is the post-deploy check. `tests/sseHeartbeat.test.ts` has 5 tests, including one through an emulated idle-timeout proxy.
- **`quant_api` uses the image's own `node_modules`** (AGENTS.md §11.20). The anonymous `/app/node_modules` volume is removed from compose; compose had been carrying a 9 Sep volume into every recreate. The old volume is removed by id after the deploy, with the three checks. Engine, auth and screener follow on separate evenings.
- **Tests:** `tests/publicData.test.ts`, 6 tests. They check:
  - the SQL is SELECT-only, parameterised and capped;
  - which columns are exposed;
  - the status in each state;
  - that health has only the coarse fields;
  - that the API never writes.

## `fix/position-id` (PR #23): merged and deployed 23 Oct after the close (engine image built, container left Created; first live session Mon 26 Oct)

- **Unique position ids** (AGENTS.md §11.19): `trade_<ms>_<symbol>_<detector slug>_<6 hex>`. Same-millisecond fires on one symbol no longer overwrite each other in `trades:open`. That happened to AEQUS on Oct 22, and `pnl:daily` counted it once.
- **Closes and orphan marking target the row's own primary key** (`dbId`, persisted with the position). Before, they matched by symbol + entry_time, which hits every same-millisecond row. Legacy positions keep the old match.
- **Unchanged:** the API, the dashboard and the DB schema. No migration.
- **Tests:** `tests/positionId.test.ts`, 4 tests. The same-millisecond pipeline test fails on the old id. Parity checks that the new id extends the old one.

## `feat/fetch-replay` — merged (PR #20); offline tooling, nothing fetched yet

- **Liquid-replay fetch, offline tooling only** (`backtest/fetchReplay.ts`, `scripts/fetch_replay.ts`). It doesn't touch the engine, and adds no Redis key or migration.
- **Dry run by default**, with 0 Fyers calls. A live run needs `--live` plus `--owner-ok <today>`. The preflight refuses before 15:45 IST, on any breach in today's ledger, on an exhausted day, during a cooldown, or once the `backtest` allocation is used up.
- **Limits:** at most 1,000 requests per evening, most liquid symbols first, stopping on the first quota stop. Runs are resumable: a symbol whose cache holds every replay session is skipped.
- **Steps:**
  - `nifty`: one Nifty 1-minute request for Oct 15–22.
  - `liquid`: no API calls; builds the list of stocks with 30-session average traded value above ₹15 cr as of Oct 14, using daily bars dated on or before Oct 14 only.
  - `minute`
- **Cache:** daily candles share the screener's cache (`<data>/candles/D`). 1-minute candles go to `<data>/candles/1`.
- **Sandbox:** `scripts/replay_sandbox.sh` runs the replay with `--network none` and no env file. `backtest/sandboxGuard.ts` aborts on any credential, a token file, or network access.
- **Tests:** `tests/fetchReplay.test.ts`, 10 tests.
- **Second commit:** the missing steps, the replay wiring and the report.
  - `--step quotes`: the NSE_CM master in batches of 50 (about 45 calls), using the screener's own pre-filter thresholds. The quotes are from the fetch day, which is look-ahead; the output records it.
  - `--step daily`: fills the screener's own cache with its cold-start ranges, up to 2 requests per symbol. That's about 2,000–2,600 requests, not 1,000–1,300 as planned, because the screener's 300-bar EMA needs about 460 days of history.
  - **Request guard:** a fetch that tries more requests than it declared is stopped, so the cap can't be overrun.
  - `backtest/run.ts`: new flags `--universe-file`, which reads `liquid15cr.json` or a JSON array, and `--sessions`.
  - **Gate detail:** each simulated trade now carries `gateRejectedAt`.
  - `backtest/replayReport.ts`: per setup and per day, with `n` on every row and every fire listed (time, stock, outcome, reason). It states the caveats: far too few sessions, options not replayable, and the pre-filter look-ahead. It gives no aggregate win rates.
  - **Sandbox:** the replay runs only the 5 replayable live detectors.
- **Tests:** 13.
- **Third commit: fixes from the independent quota review of `cd789c1`.**
  - **First throttle stops the run.** The job's gate uses `maxBreachesPerDay` 1 and `maxRetries` 0 (`replayGateConfig`). The review had found that one throttle led to a retry and the run carrying on, with production config.
  - **The 1,000 cap is per evening, not per run.** It's computed as 1,000 minus the `backtest` requests already in today's ledger, so retries count too.
  - **Every request re-checks the live ledger** (`midRunStop`). It stops on:
    - any breach, including one by another job;
    - an exhausted day;
    - the cap reached by ledger count;
    - a change of IST day;
    - 16:25 IST.
  - **Fetch window:** a run starts only between 15:45 and 16:15 IST, clear of the 16:30 screener's own pacer and the 17:15 token purge.
  - **Failure stop:** an auth or token error ends the run at once, and so do 3 consecutive other failures. The review had found an expired token could burn the whole budget.
  - **Quotes** now go through the same guarded runner.
  - **Tests:** 16, including the first-stop test against the real `config/fyers_quota.json`.

## `fix/day-aware-boot-cleanup` — merged (PR #21); deployed 2026-10-22 evening (image b210b5c7, built from ab5b573)

- **Boot cleanup is now day-aware** (AGENTS.md §11.17).
  - **Same-day restart:** keeps `market:nifty:bias`, `regime:nifty:returns_1min`, `regime:nifty:current`, `pnl:daily` and every `v2:vcp_history:*`, and re-loads the regime returns into memory. The regime engine computes from memory, so keeping the key alone wouldn't help.
  - **New-day boot:** clears those keys from previous sessions. That includes stale `v2:vcp_history:*` of symbols no longer subscribed.
  - **Marker:** the new key `engine:boot_day` (7-day TTL).
- **Anomaly promotion** no longer deletes the symbol's VCP history.
- **Unchanged:** cooldowns, alert keys, `trades:open`, `jsfilter:decisions`, `vwap:*`, `ema_shadow`, and the ledger are still never cleared. No migration. No threshold or gate change.
- **Why:** the Oct 22 11:46 watchdog restart wiped the regime, the bias, `pnl:daily` and the VCP histories mid-session.
- **Tests:** `tests/bootCleanup.test.ts` covers a same-day restart, a new-day boot, the first boot without a marker, the regime restore order, the boot line, and the wiring.
- **RUNBOOK:** deploy step 0 now saves the engine log before any recreate.

## Unreleased — `feat/geometry-guard` (not merged, not deployed; owner: not before 2026-10-22 close)

- **Geometry guard, scaled-down** (AGENTS.md §11.15): a wrong-side stop or target is recorded, flagged `invalid_geometry` on the paper and signals rows, and logged, but not alerted. No migration, no API or dashboard change. Daily count query in the RUNBOOK. The REAL-PATH tests now expect the trade to be recorded and flagged, with no alert.

## `feat/ema-shadow` — merged (PR #18); deploy pending

- **The Nifty EMA study now runs live in shadow** (AGENTS.md §11.16). V0/V1/V2 run on 5-minute candles built from ticks. It writes JSONL trades and a 15:15 daily summary, with no alerts, no filter, no paper trades, no migration and no Fyers calls. Kill switch: `EMA_SHADOW_ENABLED=false`.
- One engine for study and live: `src/core/emaTrend.ts`, re-exported by `backtest/emaTrend.ts`. Parameters come from `config/nifty_ema_study.json`.
- Parity test: the live detector, fed tick by tick from real cached minutes, matches the study trade for trade (177 trades, 15 sessions).

## `fix/engine-graceful-stop` — merged (PR #18); deploy pending

- **The engine now shuts down cleanly on `docker stop`** (AGENTS.md §1.1). The compose command ends with `exec node --import tsx src/ingestion/websocket.ts`, plus `stop_grace_period: 20s`. Before, `sh` was PID 1 and every 15:30 stop was a SIGKILL (exit 137), so the signals flush never ran.
- Proven on a throwaway stub: without exec, SIGKILL at 20 s (137). With `exec npx`, npm exits in 0.6 s and kills its child mid-handler. With `exec node`, the handler runs and the stub exits 0 in 5.1 s.

## `test/short-real-path` — merged (PR #16); deployed with `8caf9a3` (no behaviour change)

- **Real-path direction tests** (AGENTS.md §11.15) in `tests/alertPipeline.test.ts`: SHORT and LONG with entry below, at and above VWAP through the real `runAlertPipeline`. They pin a known defect: a wrong-side entry gets a wrong-side stop and is still alerted.
- **Proposed, not wired:** `levelGeometryProblem()` in `alertPolicy.ts`.

## `study/nifty-cost-sensitivity` — merged (PR #17); offline, nothing deployed

- **Labelled correction to the Nifty EMA study:** every variant and current detector re-costed on the same assumption, with fixed 2.3 pts and two unvalidated Nifty cost models (futures; an ATM option without theta). Trend Pulse at 2.3 pts: +0.078R. Under the futures model everything is negative. Harness default unchanged.

## `fix/signal-log-stall` — merged (PR #15); deployed 2026-10-21 evening with `8caf9a3` (engine left Created)

- **`signals` writer stall fixed** (AGENTS.md §11.9). After the first flush of an empty queue, `SignalLog` never wrote again and logged nothing. Live on Oct 21 only 1 of 4 fires reached the table. The guard is now released in `.finally()`. Three regression tests reproduce the live sequence and failed before the fix.

## `backtest/full-report` — Nifty EMA trend study — merged (PR #14); offline, report only, nothing deployed

- Pre-registered study (AGENTS.md §11.14): V0 EMA 9/21 cross, V1 EMA20 + slope + VWAP-proxy alignment, V2 pullback rejection, with EMA10/30 robustness. Run once on 1,285 sessions.
- Result: positive on trend days, negative on chop days. Net ≈ 0 or below (V1 −0.010R, V2 −0.013R; CIs span 0) and negative at 2× cost. About 5 trades per session. No detector or alert changed.

## `feat/subscription-cap` — merged (PR #13), deployed 2026-10-21 13:46 IST (`bd20eec`)

- **Subscribe only what the engine evaluates** (AGENTS.md §11.13): watchlist + bench + Nifty, instead of the 2,158-name universe. Fyers Standard allows 100 data-socket symbols per user; since Oct 16 only Nifty index ticks have arrived. Above `SUBSCRIPTION_CAP` (default 100) a boot check refuses to start (exit 0, admin Telegram), before any Fyers call.
- **Screener:** watchlist cap 100 → 60 (core included, hysteresis unchanged); Layer B is now a 30-name bench ranked by score. Budget: 60 + 30 + 1 = 91.
- **Nifty option strikes off** (`NIFTY_OPTIONS_ENABLED`, default false) until the expiry fix.
- **Quota gate:** throttle warnings carry Fyers' raw error text.
- **Backtest:** `--static-list live25=<file>` adds a fixed comparison list.
- AGENTS.md line endings restored to CRLF (`1b502dc` had converted them).

## `fix/fyers-quota` — merged (PR #11), deployed 2026-10-20 (`05f4bf3`)

- **Fyers quota discipline** (AGENTS.md §11.12). Every Data-API call (screener, VWAP seeder, anomaly promotions, backtest fetch) goes through one gate:
  - pacing of 4/s and 40/min (Fyers Standard: 5/s, 50/min);
  - a daily ledger with per-job allocations (Redis on EC2, a file on the PC);
  - a hard stop on "5,000 requests/day";
  - a cooldown on Cloudflare 1015, stopping after the 2nd throttle in a day.
- **Screener:** a lenient quote pre-filter (50 symbols per request) fetches history only for plausible names. A quota stop is INCOMPLETE (exit 4): the old list is kept and the next run resumes.
- **Backtest fetch:** a nightly allocation of 1,500 with exact multi-night resume. It is blocked 08:45–15:45 and 16:25–18:00 IST on trading days.

## `feature/screener-v2` — merged (PR #9) and deployed 2026-10-20 (`508ab01`); screener job disabled after the quota incident

**Screener v2: trend leaders and a high-alpha universe** (AGENTS.md §11.11)
- **Replaces Layer A.** The old screener (turnover plus ADR, run at engine boot) silently dropped about 85% of symbols on 2026-10-19 and never retried `-360`.
- **Ranked and explainable.** Stocks are ranked on:
  - relative-strength rank vs Nifty 500;
  - residual (beta-adjusted) momentum;
  - proximity to the 52-week high;
  - trend structure (close > EMA10 > EMA20 > EMA50, rising SMA50).

  Tier 1 is leaders, Tier 2 is leaders in tight consolidations. Hysteresis keeps names from churning, and the list is capped at 100. Every symbol carries a recorded reason.
- **End-of-day job** (`quant_screener`, 16:30 IST on trading days):
  - shared rate limiter;
  - incremental candle cache;
  - a failure budget: a partial scan keeps the previous watchlist.
- **The engine only reads the watchlist.** No screening at boot.
- **Layer B scan set capped** at its old size: `anomaly_universe.json`, the top 323 by turnover (`layerB.maxSymbols`). Widening waits for evidence.
- **Fyers token purge** moved from 15:30 to 17:15, and is now a local `rm` on the scheduler's own volume mount. The old `docker run -v quant_token_store` most likely never reached the real volume.
- **Migration 0006** (0005 is reserved for Part D): `signals.promotion_source` accepts `SCREENER_LEADER` / `SCREENER_SETUP`. It requires 0004 and refuses to run without it.
- **Backtest:**
  - point-in-time universe comparison (old / new / 3 random controls) with day-block bootstrap CIs and the go-live rule agreed in advance;
  - 5-minute bars by default;
  - the multi-day Stock Momentum Breakout ledger is opt-in. It produced `results.json`'s 0-minute holds.
- **Config:** every threshold lives in `config/screener.json`, hashed into every output. Market cap and ASM/GSM filters are "not applied".

## `fix/session-robustness` (merged into v2 via PR #7, not deployed)
- **Watchdog:** restart backoff of 30 s to 5 min, at most 6 restarts a day, none after 15:15, an admin Telegram message on every trip, a heartbeat log line every 5 minutes, and socket close/error logging.
- **Holidays:** one trading-day check (`scheduler/trading_day.sh`) used by every scheduler script and by the engine. The 2026 holiday list is corrected; Oct 20 was missing and caused 415 restarts.
- **VWAP seeder:** sliding-window limiter, `-360` retries, skips already-seeded symbols, no API calls before 09:15.
- **Filter evidence:** one log line per rejection; `jsfilter:decisions` survives restarts; stats are kept per day.

## 2026-10-18 — `v2`
- `signals` table (migration 0004): one row per detector fire, observation only, with executed old-vs-new parity tests. Merged in PR #8, not yet deployed.
- Versioned migrations replace the `quant_api` boot rewrite. Ghost rows became `ORPHANED` / `SKIPPED` with `data_quality` flags. Deployed 2026-10-18 (`bb7fb46`).
