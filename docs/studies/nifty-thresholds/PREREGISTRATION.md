# Pre-registration: Nifty threshold study (points vs scaled limits), cached data 2021–2026

- **Status:** pre-registered 2026-11-11, before any run (owner request, 11 Nov). **Not run.** Running it needs
  the owner's approval, and so does the one engineering item in §6.
- **Live is untouched:** no change to live detectors, gates, thresholds or stops follows from this study by
  itself. A proposal to change a live limit would need its own pre-registered forward test.
- **No Fyers call:** the data is already cached.
- **Results here are index moves, labelled "not tradable as options".** Live routes these signals to Nifty
  options. Option premium, delta and theta aren't modelled.

## 1. Question

Opening ranges of 70 points or more went from 16% of sessions (2021) to 62% (2026). The question: do Opening Range
Explosion's fixed point caps (risk cap **80**, range cap **120**) still fit the index level and volatility, and
how would the signal count, the block reasons and the index-move expectancy change under scaled caps?

## 2. Data

- **Source:** `backtest/data/cache/res-1/NSE_NIFTY50-INDEX.json` (Fyers 1-minute, fetched 2026-09-07).
- **Window:** 2021-07-05 → 2026-09-07, **1,278 full sessions** (sessions with fewer than 300 bars skipped,
  7 in total).
- **Index only.** It has no survivorship problem.

## 3. Variants (fixed now)

- **P (live, the baseline):** risk cap 80 points; range cap 120 points; everything else as live.
- **S (percentage-scaled):**
  - **Formula:** `cap_t = pct × close(t−1)`. `close(t−1)` is the close of the previous session's 15:29 IST bar
    in the cache.
  - **Reference:** as approved in amendment 2 of the 6-month study. Reference date **2026-06-12**, close
    **23,631.75**, the last session before the limits were written in `ef3af12` (2026-06-14).
  - **Values:** risk cap **0.33853%**; range cap **0.50779%**.
  - **Primary scope:** only these two caps are scaled.
  - **Secondary (exploratory):** also scale ORE's 5-point break buffer and its 5-point stop offset (0.02116%
    each), i.e. the full amendment-2 set for ORE.
- **Trend Pulse and VWAP Reclaim** are run unchanged in both variants. They're reported for context only; their
  own point limits aren't part of this study.

### V (volatility-scaled): registered 2026-11-11, owner-approved

**Approved by the owner on 11 Nov as written, before any run. Scope:** an offline study only, run on cached
data with no Fyers calls. The post-design sessions (2026-06-15 → 2026-09-07, 60 sessions) are reported
separately as **out-of-sample**. No live detector, gate, threshold or stop changes.

- **Formula:** `cap_t = point_cap × OR20(t) / OR20_ref`, applied to both the risk cap (80) and the range cap (120).
- **OR20(t)** is the median opening range (09:15–09:20 high − low, the ORE's own range) of the **20 sessions
  before** session *t*. It uses past sessions only, so there's no look-ahead.
- **OR20_ref = 69.82 points:** the median over the 20 sessions 2026-05-15 → 2026-06-12, ending on the
  amendment-2 reference date, just before the limits were written. It's computed from the cache and fixed now.
- **Why:** when the recent typical opening range is about 70 points, V equals the live caps. V widens or narrows
  them in proportion to how volatile the open has been lately, which is what the caps act on.
- **Not tuned:** there's no free parameter. The 20-session look-back is fixed now, and no other look-back is tried.

## 4. What is run

- **The path:** the live-path replay (`backtest/bt6m/liveSession.ts`, PR #73) with no equities. The 5 live Nifty
  detectors, `runAlertPipeline`, and the filter with `SHADOW_MODE=true` and `CONFIRMATION_THRESHOLD=78`.
- **Run once per variant,** over the whole window.

**Index-move outcome per fire (the exit simulation):**
- **Entry:** the fire's index price.
- **Levels:** stop = the detector's `SL ₹`, target = its `T1 ₹` (index levels, as in the trigger).
- **Fill rules:** the 6-month study's (amendments 1 and 3). Stop first in an ambiguous bar, including the entry
  bar. Level fills within a bar. A candle opening beyond a level fills at the open. The 15:15 exit at the last
  price.
- **R** = index move / |entry − stop|.
- **Why a separate simulation:** live option-routed positions never close without an option feed, so they can't
  give an outcome.

**Cost proxy (stated, not a model):**
- **Primary:** **10 bps of the index per round trip.** About 2.4 points at 24,000, standing in for option
  spread, slippage and charges translated through about 0.5 delta.
- **Sensitivity:** 5 and 20 bps.

## 5. What is reported (each per variant, P / S / S-full, and V if approved)

1. **Signal counts:** fires before the filter, filter-passed, alert-eligible; per session, by year and for the
   last 30 sessions.
2. **Block reasons:** counts per session for each Nifty detector, by year, plus the share of sessions where ORE
   passes both caps (it fired at least once).
   - **Structural fact to report alongside:** with the live 5-point offsets, ORE's risk is always more than the
     range plus 10. So risk ≤ 80 needs a range under 70.
3. **Index-move expectancy:**
   - per fire, gross and net at 10 bps, with the 5 and 20 bps sensitivity;
   - win, loss and break-even rates (±0.05R); average win and loss; profit factor;
   - for all fires and for filter-passed fires;
   - by year and by Nifty level band (< 17k, 17–20k, 20–23k, ≥ 23k).
4. **S − P and V − P differences** in fires per session and in net expectancy, with a paired day-block bootstrap.

**Statistics:**
- 95% day-block bootstrap (B = 10,000, seed 20261111);
- n < 30 is "too small to read";
- BH (q 0.05) and Holm (α 0.05) over every cell with n ≥ 30. Exit-type cells are excluded, since they condition
  on the outcome;
- no uncorrected best cell is highlighted.

**Headline:**
- **P is the reference.** S and V are comparisons, reported side by side.
- **No go-live conclusion is drawn from this study:** it's in-sample, see §7. Any recommendation must say which
  variant it rests on.

## 6. The one engineering item (needs approval; not built)

**Variant classes.** S and V need a backtest-only copy of `NiftyOpeningRangeExplosionDetector` with injectable
caps (and offsets, for S-full). The live limits are inline numbers and live code stays unchanged.
- **Equivalence test:** with the caps set to 80 and 120 (and the offsets to 5), the copy must reproduce the live
  class's fires and every block reason exactly over all 1,278 cached sessions.
- **No other code is needed:** the index-move exit simulation reuses the 6-month study's fill rules.

## 7. Limits

- **Not tradable as options.** Outcomes are index moves with a cost proxy. Real option P&L differs through
  premium, delta, theta, IV and strike choice.
- **In-sample design.** The live limits were written on 2026-06-14, with this history available. Only about
  60 cached sessions (2026-06-15 → 2026-09-07) come after the design, and **that segment is reported
  separately**.
- **Non-stationarity.** Nifty ran from about 15,800 to 26,000 and volatility changed, so pooled numbers mix
  regimes. Hence the splits by year and level band.
- **Candles vs ticks:**
  - 4 synthetic ticks per 1-minute bar;
  - the pre-open (09:00–09:15) Nifty ticks live receives are absent, so the regime warm-up differs;
  - the filter's inputs come from the same replay.
- **The cost proxy is an assumption,** not a measurement.
- **Corporate actions** don't apply to an index. Index rebalancing is ignored.

## 8. What would invalidate this pre-registration

- Changing a scaled value, the reference date, OR20_ref, the look-back or the cost proxy after any result is seen.
- Adding variants after seeing results.
- Choosing which variant to headline after seeing results.

## Amendment 1: run scope and implementation details (11 Nov 2026, before any P or V result)

- **Approval:** the owner approved V as an offline study on 11 Nov, and chose to build and run **V against the
  live caps (P)** only. **S and S-full aren't run.** No Fyers call; nothing in live changes.
- **Precondition: equivalence.** Before P or V is read, the backtest-only copy (`backtest/bt6m/oreVariant.ts`) at
  caps 120/80 must reproduce the live class **exactly** over every study session: every signals row (except its
  random and paper ids) and every ORE block record. That's `niftyThresholds.ts --mode EQ`. Any difference stops
  the study.
- **Sessions:**
  - the cached sessions with ≥ 300 one-minute bars;
  - **the first 20 are excluded from both P and V**, because OR20 needs 20 prior sessions;
  - **out-of-sample:** 2026-06-15 → 2026-09-07 (60 sessions), reported separately. In-sample is everything
    before.
- **Opening range:** the high − low of the 09:15–09:19 one-minute bars, which is ORE's own first 5-minute candle.
  **OR20(t)** is the median of the previous 20 sessions' ranges. **V's caps:** `range = 120 × OR20/69.82`,
  `risk = 80 × OR20/69.82`, unrounded.
- **Fires:** every fire of the 5 live Nifty detectors is recorded. ORE is the subject; Trend Pulse and VWAP
  Reclaim are context, and any P/V difference in them is reported.
  - **Groups:** **all fires** (before the filter, including hard-gate rejections) and **filter-passed** fires.
  - **Levels:** entry = the fire's price (the detector's candle close); stop = its trigger `SL ₹`; target = its
    `T1 ₹`. A fire without both levels is counted and left out of the outcome tables.
- **Outcome:** `simulateIndexExit` under the 6-month study's fill rules.
  - **The fire's own bar** continues after the fire tick. It's reordered adverse-first if the fire was on the
    bar's open tick.
  - **Later bars:** stop first when both levels are inside a bar. A level crossed between ticks fills at the
    level. A bar opening beyond a level fills at the open.
  - **From 15:15:** the close is at the last price. If the data ends first, the exit is at the last close
    (`SESSION_END`).
  - **R** = signed index move / |entry − stop|.
  - **Net R** = R − c × entry / |entry − stop|, with c = **10 bps** of the index (primary), 5 and 20 bps
    (sensitivity).
- **Level band:** by the previous session's close: < 17k, 17–20k, 20–23k, ≥ 23k.
- **Primary comparison:**
  - ORE fires per session, and ORE net expectancy (10 bps, all fires);
  - **V − P** as a paired day-block bootstrap difference (B = 10,000, seed 20261111);
  - reported for in-sample and out-of-sample separately, and pooled.
- **Multiple comparisons:** BH and Holm over all ORE cells with n ≥ 30, across P and V, split by year, level
  band, segment, side and group. Exit-type cells are excluded.
- **Reading rule:** **P stays the reference.** No live change follows; any recommendation says which variant and
  which segment it rests on.
