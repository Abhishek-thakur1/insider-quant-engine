# Pre-registration: alert performance report card

Written and committed **before** any analysis was run (owner request, 2026-11-10). This is a read-only
study: it uses SELECTs on the production database, with no changes to the server, gates, thresholds or
stops and no Fyers calls. Everything here is paper trading. Nothing in it is a measured live result.

## Data

- **Tables:** `paper_trades` (from 2026-09-10), `signals` (from 2026-10-21) and `ev_shadow_outcomes`
  (from 2026-10-30). The snapshot is all rows up to the 2026-11-09 close.
- **Export:** read with `\copy (SELECT …) TO STDOUT CSV` and analysed offline. The script and its SHA-256
  are recorded in the report and the evidence folder.
- **Day:** a trading day is the IST date of `entry_time`, or `trade_date` for `signals` and EV shadow.

## Definitions

- **Gross R:** `paper_trades.r_multiple`, which is `(exit − entry) / |entry − stop|` signed by side.
  Rows before 2026-10 were stored to 2 decimals.
- **Net R:** gross R − cost_R, where `cost_R = 0.00204 × entry / |entry − stop|`.
  - This is the owner's assumed round-trip cost of **20.4 bps** of the entry price.
  - It is charged on every trade.
  - Paper fills get no other slippage.
- **Win / loss / break-even:** decided separately for net R and for gross R.
  - Break-even means |R| ≤ 0.05.
  - A win is above +0.05; a loss is below −0.05.
- **Exit type:** TARGET, STOP_LOSS or TIME (the 15:15 timer from 2 Nov; the end-of-day exit before then).
  - Rows with no recorded `exit_reason` are inferred: STOP_LOSS if gross R ≤ −0.95, TARGET if the exit is
    within 0.1% of the target, otherwise OTHER.
  - Inferred types are labelled "(inferred)".

## Populations

| Group | Definition |
|---|---|
| **Alerts** | From 21 Oct: a `signals` row with `filter_result = PASSED` and `alert_sent = true`, joined to its paper trade with status CLOSED. **Before 21 Oct (proxy):** `paper_trades.gated = true` and status CLOSED. There is no `signals` row then, so it isn't known whether a Telegram was actually sent. The alert policy before 6 Oct differed (fail-open). This proxy is reported as its own period. |
| Passed, not alerted | From 21 Oct: PASSED but `CAPITAL_SKIP`, `ZERO_SIZE` or `DUPLICATE`. Reported as counts, with R shown for information only. |
| **Ungated (recorded only)** | `paper_trades.gated = false`, status CLOSED. These are score-rejected fires: shadow mode records them and doesn't alert them. |
| **EV-shadow** | `ev_shadow_outcomes`, status CLOSED. These are EV-rejected fires with a simulated outcome. |
| Capital-skipped | Status SKIPPED (or the `capital_skipped` flag), in any group. Kept out of every win/loss rate; reported as counts. Their tracked R is shown separately, for information only. |

**Default exclusions** (rows whose R isn't a real outcome, per `docs/DATA_PROVENANCE.md` / AGENTS §11.8):
- status ORPHANED, or the flag `orphaned`;
- `synthetic_close` (EOD_EXPIRED, 0R invented);
- `duplicate_signal`;
- `index_option_proxy` (Nifty option rows priced at index level);
- a null R, or a stop that is missing or equal to the entry.

The flags `pre_sizing_approx` and `duration_unverified` don't invalidate R (provenance: "R, not rupee PnL"
and "anything except duration splits"), so those rows are kept. Two sensitivity runs:
- **(S1) include flagged:** add back every row that has an R value, whatever its flags (synthetic closes
  enter at their stored 0R).
- **(S2) exclude all flagged:** drop every row with any flag except `capital_skipped`.

## Statistics per table row

- **Counts and rates:** n, win rate, loss rate, break-even rate (net and gross).
- **Sizes:** average win R and average loss R (net).
- **Results:** expectancy per trade, net and gross; profit factor (net: sum of wins / |sum of losses|); total R
  (net and gross).
- **95% confidence intervals:**
  - for the win rate, the loss rate, the break-even rate and the net expectancy;
  - method: day-block bootstrap, resampling trading days with replacement;
  - B = 10,000 resamples, seed 20261110, percentile intervals.
- **Small rows:** any row with **n < 30** is marked "too small to read" and is left out of every highlight.
- **Costs:** gross minus net expectancy, which is the average cost_R. The break-even win rate at the observed
  average win W and average loss L is |L| / (W + |L|), with break-even trades counted as zero.

## Splits (for each of alerts, ungated and EV-shadow where the data exists)

- **Detector; side; exit type;** hour of entry (IST); symbol.
- **Score band:** from 21 Oct only, from `signals.score`. Bands: <60, 60–69, 70–77, 78–84, ≥85.
- **List group:** core, score picks, turnover picks, from `signals.promotion_source`. From 5 Nov only.
- **Watchlist period**, from the boot lines in the evidence logs:

| Period | Dates | Universe | Breaks inside / at the start |
|---|---|---|---|
| P0a | 10 Sep – 5 Oct | full EQ universe + anomaly promotions | alert proxy, old alert policy |
| P0b | 6 Oct – 15 Oct | same | gated-only alert policy from 6 Oct |
| P0x | 16 Oct – 20 Oct | equity tick blackout (100-symbol cap) | equities effectively absent |
| P1 | 21 Oct – 27 Oct | 25 stocks | `signals` table from 21 Oct |
| P2a | 28 Oct – 30 Oct | 51–52 stocks | — |
| P2b | 2 Nov – 3 Nov | 52 stocks | VWAP session gate (#40) and 15:15 timer exit (#45) from 2 Nov |
| P3 | 4 Nov – 9 Nov | 79 stocks (daily list) | #68 auction-volume VWAP from 4 Nov; group labels from 5 Nov |

- **Note on the dates:** the owner's brief puts the 79-stock period from 5 Nov. The boot log shows 79 stocks
  from 4 Nov, so 4 Nov goes in P3, and the list-group split starts 5 Nov.
- **Comparability:** stop levels for equities derive from VWAP (VWAP ± 0.2%), so a VWAP change moves R.
  - P2b is not comparable with earlier periods.
  - P3 is not comparable with P2b.
  - No two periods share both the universe and the VWAP definition.

## Gated vs ungated

- **Comparison:** net expectancy of alerts minus ungated, with a day-block bootstrap CI (both groups resampled
  on the same days).
- **Scope:** reported for all days, and for 21 Oct onward only.
- **Not causal:** the filter selects on score, so the two groups differ in detector mix, time of day and
  regime. A difference is an association.

## Multiple comparisons

- **Family:** every split cell with n ≥ 30, across all three populations.
- **Test:** H0: net expectancy = 0, with a two-sided p-value from the day-block bootstrap.
  - p = 2 × min(share of resamples ≤ 0, share ≥ 0), floored at 1/B.
- **Corrections:** Benjamini-Hochberg (q = 0.05) and Holm (α = 0.05) are both applied and reported.
- **Reading rule:** only cells that survive a correction are called results. Uncorrected best cells are not
  highlighted.

## Verdict rule

- **Yes, positive expectancy after costs:** the alerts' net expectancy CI (all periods, default exclusions)
  lies above 0, and the P3-only estimate doesn't contradict it.
- **No:** the CI lies below 0.
- **Can't tell yet:** anything else.
- **Sample size that would settle it:** for the observed mean and SD of net R, report the n needed for a 95%
  CI half-width smaller than |mean|.
  - Day-clustering is taken into account with a design effect from the bootstrap variance versus the iid
    variance.
  - The result is also given in trading days at the current alert rate.

## Outputs

- **Repo:** `REPORT.md` in this folder. The PR is docs only, not merged.
- **Evidence:** the CSVs of every table, the script and its hash, and the raw exports, in
  `~/evidence/2026-11-10/alert-report-card/` on the host. Local copies are in the PC scratchpad.
