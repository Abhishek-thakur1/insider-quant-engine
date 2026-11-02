# Daily watchlist: ranking rules (pre-registration)

**Committed before any scan was run** (owner, 2 Nov 2026, rule 1). Rules version **`dw-1`**. A rule change means a new version and a new commit, made before the scan that uses it. Nothing here claims an edge: the list decides which stocks the engine watches, and whether that helps is **untracked**.

## Inputs (one scan per evening, at most 60 Fyers requests)

1. **Symbol master:** the public `NSE_CM.csv` (1 download, counted as 1 of the 60). The universe is every `NSE:<SYM>-EQ` with an `INE` ISIN (`parseCashUniverse`, `src/screener/masters.ts`; ETFs, MFs and BE/BZ series are left out). If the master can't be read, the scan fails (no fallback file).
2. **Quotes:** batched Fyers quotes, at most 50 symbols per request, through the Data-API quota gate (4/s, 40/min, ledger `fyers:quota:{day}`, job `screener`). **Hard cap: 59 quote requests** (60 minus the master); retries count. At the cap the scan stops and fails.
3. **No other Fyers call:** no history, no depth, no websocket.

## As-of rule: only data from before the next session

- **As-of day** = the last completed NSE session (`lastCompletedSession`, the holiday file). **Target session** = the next trading day after it.
- A quote is used only if its last-trade time (`tt`) falls on the as-of day, between 09:15 and 15:30 IST. That excludes stocks that didn't trade that day, and anything from the target session.
- The scan refuses to run between 09:00 and 15:30 IST on a trading day.

## Core set (always in, not ranked)

The 25 symbols of the 20 Oct live list (`watchlist.json.bak-20261027-25`), kept in the repo as `config/daily_watchlist_core.json`. They are always included, quote or not.

## Rotating names (ranked)

**Eligible:** a quoted, as-of-day symbol not in the core set, with:
- last price `lp` ≥ ₹50;
- turnover `lp × volume` ≥ **₹50 crore**;
- `prev_close_price` > 0 and `high_price` > `low_price` (a stock stuck at one price is out).

**Measures,** from the as-of day's quote:
- `move` = |lp − prev_close| / prev_close
- `range` = (high − low) / prev_close
- `turnover` = lp × volume

**Score** = 0.4 × pct(`move`) + 0.3 × pct(`range`) + 0.3 × pct(`turnover`). pct is the percentile rank within the eligible set, from 0 to 1, with ties averaged.

**Order:** score, highest first. Ties go to the higher turnover, then to the symbol in alphabetical order.

**Take:** the top **69**, so the list holds 25 core + 69 rotating = **94 stocks + Nifty = 95 symbols** (the subscription cap is 100). If fewer than 69 are eligible, the list is shorter, and validation decides whether it's usable.

## Validation (else the previous list is kept and the owner is alerted on Telegram)

- 60 to 94 stocks (95 with Nifty), unique, each matching `^NSE:[A-Z0-9&_.-]+-EQ$`.
- Every rotating name is in the as-of day's master.
- At most 10% of quote batches failed.
- The scan stayed within its 60 requests.

## Output and log

- `/app/data/watchlist_daily.json`: `{ rulesVersion, asOf, forSession, generatedAt, requests, symbols, entries[] }`. Each entry carries its group (`core` / `rotating`), and for rotating names the rank, score and the three measures (the reasons).
- `/app/data/watchlist_daily_history/<forSession>.json`: a copy of each day's list. The file is written atomically (temp file, then rename).

## Use by the engine

- `SCREENER_ENABLED` (default `true`). The engine (and the VWAP seeder) use `watchlist_daily.json` only if the flag isn't `false`, the file is valid by the rules above, and its `forSession` is today (IST).
- Otherwise they use the static `watchlist.json`, unchanged, and say why in the boot log. When the flag is on, they also send a Telegram warning.
- The static file is never written by the daily scan.
