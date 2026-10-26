# Edge-map study: pre-registration

**Registered:** Fri 2026-10-23, 19:20 IST, before any analysis code was written or run. The git commit that adds this file is the registration timestamp.
**Owner's brief:** 23 Oct 2026, evening. This is the weekend priority. It is offline only: no Fyers calls, no change to live detectors, gates or stops.
**Frozen.** This file is not edited after results are seen. Anything done differently goes in the [deviation log](#deviation-log) at the bottom, with the date and the reason. "No edge found" is an acceptable result.

## 0. What I already know before running anything

Being honest about prior knowledge matters, because it can steer choices.
- **Live paper results are about breakeven.** The owner's figure is: all closed trades, n=1,556, average R 0.004.
- **An existing replay looks negative.** `backtest/output/results_5m.json` (365 sessions, 2025-03-17 → 2026-09-04, 91 symbols) shows Stock Momentum Breakout gated at −0.110R over 1,804 trades. It uses the detector's own trigger stop, not the live stop (see §2.3).
- **Data shape, inspected for counts and dates only, no outcomes:**
  - Postgres has 1,573 CLOSED paper trades over 26 sessions (2026-09-10 → 2026-10-23), plus 31 ORPHANED and 2 SKIPPED.
  - The regime label on closed trades is MOMENTUM for 1,569 and UNIVERSAL for 4.
  - `signals` (the score log) only starts on 2026-10-21: 36 fires, of which 18 link to a closed trade.
  - The cache holds 91 symbols of 1-minute, 5-minute and daily bars, 2021-07-05 → 2026-09-04. Some symbols start later; the latest first bar is 2025-12-19.
- I have not computed any of the study's metrics on either data source.

## 1. Questions

1. **Calibration.** Does a higher alert score mean higher expectancy?
2. **Edge map.** What is the expectancy in R for each detector × side × time of day × regime label × score tier, with n and a day-block bootstrap CI on every row?
3. **Stop geometry.** How do the live VWAP × 0.998 / × 1.002 stops compare with ATR- and ADR-based stops, using a 2021-2024 train period and a 2025-2026 test period?
4. **Costs.** What cost and slippage assumptions are used, and how do the results change under a sensitivity run?

## 2. Data

### 2.1 Live: Postgres signal log and paper trades
- **Snapshot:** one read-only `SELECT` export of `paper_trades` and `signals` after the 23 Oct close, saved as CSV. The SHA-256 of each file is recorded in the report. Nothing re-queries the live database during the analysis.
- **Included:** `status = 'CLOSED'`, gated and ungated. ORPHANED trades are counted and excluded, because they have no exit. SKIPPED trades are excluded.
- **R:** live `r_multiple` is **gross**. It is computed from fill prices with no costs (`src/core/positionTracker.ts:216-227`). The study applies the §4 cost model to get net R.
- **What the live data can and can't answer:**
  - It has no score before 2026-10-21, so it can't test calibration. Its 18 scored trades are below the n ≥ 30 floor and are reported as "insufficient".
  - Its regime label is degenerate (99.7% MOMENTUM), so the live table uses `market_regime` only where `signals` has it, and otherwise has no regime split.
  - **Live tables are descriptive.** They show n, mean net R and a CI, with no significance claims. 26 sessions give 26 bootstrap blocks.

### 2.2 Replay: the 91-stock backtest cache
- **Harness:** the existing one, with the real, unmodified detector classes and the real `runJaneStreetFilter`, run with `BACKTEST_MODE=true` in a sandbox with `--network none` and no `.env`. The harness commit SHA and a manifest hash of the cache files go in the report.
- **Resolution:** the harness default, 5 minutes (settled by the owner on 2026-10-20).
- **Detectors:** the 2 live equity detectors, `Volatility_Contraction_V2` and `Stock Momentum Breakout`.
  - The 5 Nifty detectors are excluded from the replay. They trade options, and the cache has only the Nifty index. Their live trades (n=18 closed) are shown descriptively.
- **Every signal is kept, whatever the filter decided,** with its score, `filter_result`, `market_regime` (`trending` / `transition` / `ranging` from `src/utils/regimeDetector.ts`), side, entry time and price, and the VWAP at signal time. Calibration needs the below-threshold signals too.
- **Split, fixed now:**
  - **Train:** sessions 2021-07-05 → 2024-12-31.
  - **Test:** sessions 2025-01-01 → 2026-09-04.
  - Every decision is made on train. Test is used once, for confirmation only.

### 2.3 Exit simulation
The harness currently exits on the detector's trigger levels (`SL ₹x | T1 ₹y`, `backtest/sim/exit.ts`). Live paper trades instead use stop = VWAP × 0.998 (LONG) or × 1.002 (SHORT) and target = entry ± 1.5 × risk (`src/workers/alertPipeline.ts:138-147`).
- **Re-simulation:** every replayed entry is re-run under each stop rule in §3.3, using the harness's exit mechanics:
  - a stop and target in the same bar count as the stop (pessimistic);
  - no fill during a circuit lock;
  - the 15:15 square-off;
  - slippage per §4.
- **Baseline:** S0, the live rule, for Questions 1 and 2, so the replay measures the trades the engine actually takes.
- **Wrong-side stops:** a LONG entered below VWAP gets a stop above its entry under S0, and the reverse for SHORTs. The live pipeline records these today (`alertPolicy.ts:189`). The study keeps them, as live does, and reports their count and R separately.

## 3. Hypotheses, cells and tests

Common settings:
- **Metric:** mean net R per trade.
- **CI:** day-block bootstrap. Trading days are resampled with replacement, 10,000 times, with seed 20261023, giving a percentile 95% CI. Two-sided p-values come from the same bootstrap, by inverting the CI.
- **Floor:** any cell with n < 30 is reported with its n and CI, and labelled "below floor, not tested".

### 3.1 H1, calibration (Question 1)
For each detector-side (VCP-LONG, SMB-LONG and SMB-SHORT, plus VCP-SHORT if the replay produces it with n ≥ 30):
- **Train:** fit an OLS slope of net R on score, with a bootstrap CI. H1 is a slope > 0, tested one-sided. That's at most 4 tests, with Holm correction at family α = 0.05.
- **Test:** every detector-side that passes on train is re-tested once on test, again one-sided with Holm. It is "calibrated" only if it is confirmed on test.
- **Tiers, reported without a test:** mean R by tier (< 60, 60-69, 70-77, ≥ 78), and score ≥ 78 (the live threshold) against < 78.

### 3.2 H2, the edge map (Question 2)
- **Cells:** detector-side (3, or 4) × time of day × `market_regime` (3) × score tier (4). That's at most 4 × 3 × 3 × 4 = **144 cells** per split. Each factor's marginal table is also reported.
  - **Time of day (entry, IST):** T1 09:15-10:29, T2 10:30-13:29, T3 13:30-15:15.
- **Train:** each cell with n ≥ 30 gets a two-sided test of mean net R ≠ 0. Multiple comparisons are handled with Benjamini-Hochberg FDR at q = 0.10 across all train cells with n ≥ 30. The report states how many cells that was.
- **Test:** each BH discovery is tested once on test, with Holm at α = 0.05 across the discoveries. It's confirmed only if test n ≥ 30, the sign is the same, and the CI excludes 0.
- Cells that weren't tested are still shown, with their n and CI.

### 3.3 H3, stop geometry (Question 3)
These are the same entries with only the stop rule changed. The target is always entry ± 1.5 × that rule's risk, and the exits follow §2.3. Every trade's R is in units of its own stop, which is equivalent to fixed risk per trade.

| Id | Stop |
|---|---|
| S0 | Live: VWAP × 0.998 (LONG) or × 1.002 (SHORT) |
| S1 | ATR: entry ∓ 0.5 × ATR(14), Wilder, daily bars through the previous session |
| S2 | ADR: entry ∓ 0.25 × ADR(20), the mean daily high − low of the previous 20 sessions |
| S3 | The detector's own trigger stop, `SL ₹x`, which is what the harness uses today |

- **Train:** for each detector-side, pick the rule with the highest mean net R. If that's S0, there's no test.
- **Test:** one paired test per detector-side of (chosen − S0), as a paired day-block bootstrap of the per-trade difference, at most 4 tests with Holm.
- **Not decision inputs:** the multipliers 0.5 and 0.25 are fixed here. Other multipliers may be shown as a sensitivity only.

### 3.4 Costs (Question 4)
See §4. Every headline is reported at 0×, 0.5×, 1×, 2× and 3× the base cost. Decisions use 1×, and the "edge" rule also needs 2× (§5). The break-even cost for each headline cell is reported too: the round-trip cost, in basis points, at which mean R = 0.

## 4. Cost model (assumptions, unverified)
Costs are converted to R per trade as the round-trip cost in ₹ divided by risk per share × quantity. That works out to cost_bps × entry ÷ (10,000 × risk).
- **Slippage:** 5 bps per leg, against the trade. This is the harness default (`backtest/config.ts`, `SIM.slippageBps`).
- **Charges:** 7 bps of notional round-trip, an **assumption** for a discount broker's intraday equity fees (brokerage, STT on the sell, exchange, GST, stamp). It hasn't been checked against a current fee schedule. The report will say "assumed" next to it.
- **Base round-trip total:** 17 bps.
- **Live trades:** the same model is applied to their gross R.
- **Not modelled:** market impact beyond slippage, partial fills, and the live filter's flat 2-point EV slippage (that matters for the EV gate, not the outcome).

## 5. Decision rules, fixed now
- **"Edge found" in a cell needs all of:**
  - train n ≥ 30;
  - BH-significant on train;
  - test n ≥ 30, with the same sign and a test CI that excludes 0 (Holm);
  - test mean net R ≥ +0.05R at 1× cost;
  - test mean net R > 0 at 2× cost.

  Otherwise the result is "no edge found" for that cell.
- **"Calibrated"** means H1 is confirmed on test for that detector-side. If the test slope's CI includes 0 or is negative, the result is "not calibrated".
- **"Stop candidate"** means the H3 test difference CI excludes 0 and is ≥ +0.05R. Even then, it's a recommendation only. Any live change is a separate owner decision, taken through `SHADOW_MODE` first.
- **Results that can't be used:** any result from a cell below the floor, or from live data, is descriptive and never used as evidence of edge.

## 6. Biases to state in the report
- **Survivorship.** The 91 symbols were chosen in 2025-2026, so stocks delisted or demoted since 2021 are missing. That biases 2021-2024 results upward. Some symbols start later (as late as 2025-12-19), so the universe changes over time.
- **Look-ahead in selection.** If the list was chosen using later liquidity or performance, the train period sees the future through the choice of universe. This can't be undone with this cache, so it's stated rather than corrected.
- **Look-ahead in features.** ATR and ADR use only bars through the previous session. Before running, I'll check that the harness's filter state (the Bayesian component and regime returns) carries nothing across from later sessions (`backtest/README.md`, replay determinism notes). Anything found goes in the deviation log.
- **Live data:** 26 sessions with no cost deduction (gross), about breakeven. It's a small, regime-narrow sample.
- **Replay fidelity:** 5-minute bars and pessimistic fills for both stop and target. The harness's signal path isn't the live tick path.

## 7. Outputs
- **Report:** `docs/studies/edge-map/REPORT.md`, with:
  - every table above, with n, mean net R, the 95% CI and both splits;
  - the number of tests in each family;
  - which cells were discoveries and which were confirmed;
  - the cost sensitivity;
  - the deviation log.
- **Code:** in `backtest/studies/edge-map/`.
- No live change. No Fyers calls.

## Deviation log
Append only, with the date, what changed and why. It is empty at registration.

**2026-10-23, about 19:45 IST.** These were written after the code trial and before any full-run result existed. The only output seen was a structural check on a partial sample, and its numbers weren't read as results.

1. **Look-ahead check (§6): passed for filter state.** `runJaneStreetFilter`, `regimeDetector` and the Bayesian, structure, liquidity and order-flow helpers read only Redis and in-memory module state. None reads Postgres or files. `replaySession` calls `flushAll()` and resets the regime, candle and structure state before every session (`backtest/replay/engine.ts`), so nothing crosses between sessions. Universe-selection bias remains and is stated in §6.
2. **Wrong-side S0 trades** (stop on the wrong side of entry) are **excluded from the H1-H3 cells** and reported separately, in bps of notional.
   - **Why:** for these trades live's R formula (`positionTracker.ts:216`) divides by a negative risk, so R isn't an expectancy unit. Live exits them on the first tick; the replay uses the first forward bar's open.
   - §2.3 said "keeps them, as live does". This is the clarification. Their count is in the report.
3. **Costs for S0-S3** are applied analytically in R (bps × entry ÷ (10,000 × risk)), not as adjusted fills, so one simulation serves all five cost multiples.
   - This equals fill-based slippage to first order.
   - The side-by-side with the old replay (§A of the report) uses the harness's own fill convention (5 bps per leg, no charges) for both columns.
4. **Addition, at the owner's request on 23 Oct evening:** report section A shows the **old replay**, exactly the harness method (trigger SL + T1 via `simulateExit`), next to the live-stop replay (S0) on the same signals. It also checks against the committed `results_5m.json` window. This adds to the report and changes no hypothesis or rule.
5. **Excluded signals, with counts in the report:**
   - signals with no forward bars in their session;
   - S1 or S2 trades without 14 / 20 prior daily bars (the first weeks of the cache, and symbols that start later). H3's paired set uses only entries valid under all four rules.
6. **Run mechanics:** the collection ran as 6 parallel sandbox shards (`--network none`, empty env file, cache mounted read-only, `sandboxGuard.ts` first). Three shards ran out of Docker memory (exit 137) and were re-run separately. Sessions are independent, so this doesn't affect results.

**2026-10-23, about 20:20 IST. These were added AFTER seeing the full results.** Both are descriptive and change no decision rule.

7. **Live data: rows the engine itself flags as non-outcomes are excluded from the live tables.** These are `synthetic_close` (235 rows, the ₹0 / 0R closes invented by the removed boot sweep; AGENTS.md describes them as "signal occurrence only") and `index_option_proxy` (18 Nifty rows at index-level prices, all of them also synthetic).
   - §2.1 had said "Included: `status = 'CLOSED'`".
   - Found while checking why all Nifty rows had R = 0.000.
   - The report also shows the mean R over every CLOSED row, so the owner's figure stays comparable.
   - `capital_skipped` rows are kept: P&L is ₹0 because qty is 0, but R is computed from prices.
8. **H3 decomposition** (report table D2): gross R at 0× cost and the median stop distance per rule. Added because the pre-registered H3 rule flagged S1 for every detector-side, and costs in R scale with entry ÷ risk, so a wider stop pays less cost per R. This table separates geometry from that cost dilution. The H3 verdicts themselves are reported as the rule gives them.

**2026-10-23, about 20:50 IST. Added after results, at the owner's request.** This is descriptive and changes no decision rule.

9. **Broker costs and cost-to-risk** (report §6b, tables §H). These add a per-component FYERS equity-intraday cost model, with each rate marked as assumed; the break-even cost against that total; and the cost per trade as a percent of R by detector-side and stop rule, for live and replay, including the share of trades at or below 10% of R. The pre-registered decisions still use the 17 bps base. At the live ₹10,000 notional the FYERS total is 20.4 bps.

**2026-10-26, about 20:00 IST. Added after results, at the owner's request.** This is descriptive and changes no decision rule.

10. **EV calibration** (report §6c, tables §I): realized R by the filter's EV bucket. The buckets (< 0, 0-1, 1-3, 3-10, ≥ 10 points) were fixed from EV value quantiles before looking at outcomes.
   - **Replay:** S0 trades, train and test, gross and net at the 20.4 bps FYERS total.
   - **Live:** a new read-only snapshot (`edge-map-freeze-2026-10-26`, `signals.csv` sha256 `2674cc79…`, `paper_trades.csv` sha256 `58bcff81…`), with signals joined to closed trades through `trade_id` and synthetic_close / index_option_proxy excluded.
   - **Unchanged:** the original live freeze of 23 Oct still drives §G; nothing else in the tables changed (diff: 29 lines added, 0 removed).
