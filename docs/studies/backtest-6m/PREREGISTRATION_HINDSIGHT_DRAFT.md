# DRAFT pre-registration: long-window run on the cached stocks (label: **hindsight-universe**)

- **Status: DRAFT, not approved, not run** (owner extra (b), 10 Nov 2026).
- **Kept apart from the 6-month result** (`PREREGISTRATION.md`):
  - a separate label, run folder and report;
  - its numbers are **never pooled** with the 6-month numbers;
  - it **can't change** the 6-month verdict.
- **No Fyers call:** everything it needs is already in the local cache.

## Why it's labelled hindsight-universe

- **The universe is the 90-stock `watchlist.json` plus Nifty, as it stood when the cache was fetched**
  (7 Sep 2026; `ANTIGRAVITY.md`: "91 symbols").
- **Hand-picked in 2026:** that list was picked by hand during 2026, from names that were liquid, active or
  interesting by then.
- **Run back over 2021–2026,** it carries both:
  - **survivorship:** names that were delisted or faded since 2021 are absent;
  - **look-ahead in selection:** names chosen partly *because* of how they behaved.
- **Consequence:** any result here describes "the live rules on names we now know about". It isn't evidence of
  an edge on a universe chosen without hindsight. That is what the 6-month point-in-time run is for.

## Data (cached; no new requests)

- **Source:** `backtest/data/cache/res-1`, 1-minute bars of the 91 symbols.
- **Window:** **2021-07-05 → 2026-09-07**, 1,278 full Nifty sessions (7 short sessions skipped).
- **Ends there:** the cache stops on 7 Sep. Nothing after it is fetched for this run.

## Rules (identical to the 6-month run; no tuning)

- **The same harness path:** `backtest/bt6m/liveSession.ts`, i.e. the live detectors, filter, `runAlertPipeline`
  (stops, sizing, duplicate rules, cap) and the live position tracker, with the same-bar rule and level ticks
  from Amendment 1.
- **Settings:** `SHADOW_MODE=true`, `CONFIRMATION_THRESHOLD=78`, capital ₹100,000 `REDUCE`.
- **Costs:** 8, 12 and 20.4 bps; 20.4 is primary.
- **List:** the same 90 stocks every session, registered as core, since the list is static. The "list group"
  split doesn't apply.
- **One small offline step is needed before a run:** generating one static list file per session in a separate
  folder (`C:\trade-data\backtest-hindsight\lists\`). This draft builds nothing.

## Statistics

The same as the 6-month pre-registration:
- day-block bootstrap (B = 10,000, seed 20261110);
- BH and Holm corrections, excluding exit-type cells;
- n < 30 is "too small to read";
- the same groups (alerts, ungated, EV-shadow, capital-skipped counted only).

Added splits:
- **by year** (2021 H2 … 2026), to show non-stationarity;
- **by Nifty level band**, because several gates are fixed in *points*. The opening-range limit of 120 points
  and the risk caps of 60 and 80 points mean different things at Nifty 15,800 (2021) and 25,000 (2026). In the
  cache, opening ranges of 70 points or more went from 16% of sessions in 2021 to 62% in 2026.

## Limits specific to this run

- **Hindsight and survivorship** (above). **This is the headline limit,** and the report states it first.
- **The point thresholds aren't scaled to the index level** (above). Early years aren't comparable with recent
  ones for the Nifty detectors.
- **Corporate actions over 5 years:** Fyers doesn't say whether candles are adjusted. Intraday rules reset daily,
  but capital sizing uses price, so splits change quantity.
  - The 6-month run's 5-request check doesn't cover 2021–2025, and this draft adds no Fyers request to check.
  - Results are reported with and without symbol-days within ±1 day of a price discontinuity of 30% or more.
- **No parity data:** the live `signals` table starts on 21 Oct 2026, after this window. The run inherits the
  6-month run's parity result and can't be checked against live itself.
- **Plus everything in the 6-month limits section:** candles vs ticks, paper fills, the cost assumption, no
  option premiums.

## Verdict rule

- **This run produces no yes/no verdict on the live system.** It reports estimates with CIs, labelled
  hindsight-universe.
- **It's only read after the 6-month result,** and only if the owner approves running it.
