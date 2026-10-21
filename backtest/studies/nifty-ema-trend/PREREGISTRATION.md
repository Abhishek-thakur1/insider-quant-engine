# Pre-registration — Nifty EMA / trend-continuation study

**Committed 2026-10-21, before any run of this study.** Parameters live in
`config/nifty_ema_study.json`; this file explains them. Nothing here is tuned after results are
seen. A change is a second, labelled run reported next to the first.

Goal file: `nifty-ema-trend-study-goal.md` (owner, 2026-10-21). Offline, report only: no live code,
no deploy, no Fyers calls. Index level only: **no option premium, theta or OI is modelled.**

## Hypothesis (not a result)

A trend-continuation approach built on EMA and VWAP alignment, with pullback-rejection entries,
captures Nifty trend days better than the current Nifty detectors without giving it all back on
chop days.

## Data

- Nifty 50 index, 5-minute bars, backtest cache (`res-5`), 2021-07-05 → 2026-09-07. Oct 19 and
  Oct 21, 2026 are **not** in the cache.
- Session labels: `config/trend_day.json` (unchanged): body ≥ 60% of the day's range and close in
  the outer 25% → trend-down / trend-up, else chop. Uses end-of-day information, so it is for
  evaluation only.

## Decisions the goal left open (fixed here)

1. **VWAP.** Index volume is 0 in the cache. "VWAP" = the session's running equal-weight mean of
   5-minute typical price (H+L+C)/3 from 09:15 through bar t. It is a TWAP, not a VWAP.
2. **EMA.** Continuous across sessions on 5-minute closes, SMA-seeded, α = 2/(n+1).
3. **Timing.** A bar starting at s closes at s+5; signals and entries use that bar's close.
   Entries on bars closing 09:30–14:45. Forced exit at the close of the bar ending 15:15.
4. **V2 touch.** "Within 0.05%" means the bar's high reaches level × (1 − 0.0005) or above
   (SHORT); the close must end back below the level, and V1 alignment must still hold at that bar.
5. **One position.** A signal while a position is open is skipped and counted, not queued.
6. **Gaps.** Sessions without a 15:15 bar exit at their last bar and are listed as data gaps.

## Variants

| | Rule |
|---|---|
| V0 control | EMA9 crosses EMA21 at bar close. No filters. |
| V1 alignment | SHORT: close < EMA20, EMA20 below its value 3 bars ago, close < VWAP (LONG mirror). Enter on the first bar of each alignment episode. |
| V2 pullback | Within a V1 episode: a bar touches EMA20 or VWAP (within 0.05%) and closes back on the trend side. Several entries per episode, ≥ 3 bars apart. |
| Robustness (labelled, not for selection) | V1 and V2 with EMA 10 and EMA 30 replacing EMA 20 everywhere. |

## Exits and costs (all variants)

- Stop: beyond the extreme of the last 4 bars (t−3..t) + 5 points. Skip if > 80 points (count).
- Trail: first close through the trailing EMA against the position (EMA20; EMA n in robustness runs).
- Stop checked first in every bar; a gap through the stop fills at the open.
- Time exit 15:15. Cost 2.3 points round trip; 2× cost sensitivity reported.
- R = (signed points − cost) / initial risk.

## Statistics and reporting

Per variant × session type (trend-down, trend-up, chop) × year, and 2021–2024 vs 2025–2026:
signals, skips, trades, trades/session, win rate, expectancy R with a 95% day-block bootstrap CI
(10,000 resamples, seed 20261021), profit factor, max drawdown in R, best/worst trade, average
hold, share of the day's move captured on trend days (Σ signed trade points / |close − open|).
`n` on every row; `n < 30` is marked insufficient and no conclusion is drawn from it.

## Baselines

Current Nifty VWAP Reclaim, Opening Range Explosion and Trend Pulse through the existing harness on
the same sessions (5-minute), ungated and gated with the filter score as it would have been. Their
exits are the harness's own, so the comparison is per detector as built, not like-for-like exits.

## Addendum — implementation notes, committed with the code BEFORE the first study run

These fix details the text above left open. None was chosen after seeing study results; the
baseline harness run (current detectors only) had run, the EMA variants had not.

1. **Episode that begins before 09:30.** V1 enters on the first *in-window* bar of the episode
   (so a trend in force from the open is tradable from 09:30). V2 only counts touches in-window.
2. **Same-bar re-entry.** A signal on the bar where the previous position exits is skipped
   (the position was open at that bar's start) and counted as "skipped: position open".
3. **V2 spacing** is counted from the previous V2 *signal* bar in the episode, taken or not.
4. **Capture** uses gross signed points (before cost); a trend session with no trade counts as 0.
5. **Baselines** come from `backtest/run.ts run --detectors nifty_vwap_reclaim,nifty_opening_range_explosion,nifty_trend_pulse --label nifty_baselines_5m` (5-minute, BACKTEST_MODE). "Gated" = the harness's `gatePassed` (score ≥ 78 and hard gates).
6. **Per-year rows** are computed for every year in the window; 2021 starts on 2021-07-05 (cache start).
