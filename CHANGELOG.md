# Changelog

Newest first. Paper trading only. "Not deployed" means it isn't running on EC2.

## Unreleased — `feature/screener-v2` (not merged, not deployed, not live)

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
- **Fyers token purge** moved from 15:30 to 17:15, and is now a local `rm` on the scheduler's own volume mount. The old `docker run -v quant_token_store` most likely never reached the real volume.
- **Migration 0005:** `signals.promotion_source` accepts `SCREENER_LEADER` / `SCREENER_SETUP`.
- **Backtest:**
  - point-in-time universe comparison (old / new / 3 random controls) with day-block bootstrap CIs and the go-live rule agreed in advance;
  - 5-minute bars by default;
  - the multi-day Stock Momentum Breakout ledger is opt-in. It produced `results.json`'s 0-minute holds.
- **Config:** every threshold lives in `config/screener.json`, hashed into every output. Market cap and ASM/GSM filters are "not applied".

## `fix/session-robustness` (pushed, not merged, not deployed)
- **Watchdog:** restart backoff of 30 s to 5 min, at most 6 restarts a day, none after 15:15, an admin Telegram message on every trip, a heartbeat log line every 5 minutes, and socket close/error logging.
- **Holidays:** one trading-day check (`scheduler/trading_day.sh`) used by every scheduler script and by the engine. The 2026 holiday list is corrected; Oct 20 was missing and caused 415 restarts.
- **VWAP seeder:** sliding-window limiter, `-360` retries, skips already-seeded symbols, no API calls before 09:15.
- **Filter evidence:** one log line per rejection; `jsfilter:decisions` survives restarts; stats are kept per day.

## 2026-10-18 — `v2`
- `signals` table (migration 0004): one row per detector fire, observation only, with executed old-vs-new parity tests. Merged in PR #8, not yet deployed.
- Versioned migrations replace the `quant_api` boot rewrite. Ghost rows became `ORPHANED` / `SKIPPED` with `data_quality` flags. Deployed 2026-10-18 (`bb7fb46`).
