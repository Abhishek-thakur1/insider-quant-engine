# Shadow candidates (Part B): pre-registration

**Registered:** Fri 2026-10-23, 20:45 IST, before any backtest code for these candidates was written or run. The commit that adds this file is the registration timestamp.
**Owner's rules (23 Oct):**
- **Shadow only:** at most 3 candidates, each passing a cost-to-risk filter (costs about 10% of R or less).
- **Nothing reaches users:** no Telegram, no change to the live watchlist, detectors, gates or stops.
- **Screener:** it logs a list and doesn't change the live watchlist.
- **Fyers:** no live call without the owner's explicit OK.
- **Deploy:** only if every gate in §6 passes, not before Sunday evening (25 Oct), and only after reporting to the owner.

**Frozen.** This file isn't edited after results are seen. Deviations go in the log at the bottom.

## 0. What I already know before running anything
- **Edge-map study** (`docs/studies/edge-map/REPORT.md`, branch `study/edge-map`): no edge.
  - Gross R is about 0, and net R is about −0.2 to −0.4R at the FYERS cost of 20.4 bps.
  - With the live VWAP stop, cost is about 25-32% of R per trade.
  - The S1 stop (0.5 × daily ATR) was net −0.074 to −0.126R on test at 17 bps; its gain over the live stop was cost dilution.
- **Candidate 1 reuses those 63,436 replay signals.** So its backtest isn't independent of what I've already seen: same signals, same period, and a stop family whose results I know. Only the forward shadow is new evidence.
- **Chosen from geometry, not outcomes.** I computed cost-to-risk on these signals before registering (stop distances only, no P&L): at 20.4 bps a 1.0 × ATR14 stop gives a median cost of 7.0% of R (87% of trades ≤ 10%), 0.75 × ATR gives 9.3% (58%), and 0.5 × ATR gives 14.0% (16%). The 1.0 × ATR stop was picked from that.
- **Daily ATR on the 90-stock cache:** median 297 bps of the close (p10 194, p90 470).
- **Nifty EMA trend study** (AGENTS §11.14): net R about −0.01 at 2.3 points. Its median stop is about 33 index points.

## 1. Which screener / daily-trend ideas meet the cost-to-risk filter
These are computed from stop distances only, with no outcomes. Costs are FYERS rates, assumed, from fyers.in/charges-list as fetched on 2026-10-23, plus 5 bps of slippage per leg.

| Idea | Instrument / cost at stated size | Median cost, % of R | Share of trades ≤ 10% | Meets? |
|---|---|---|---|---|
| Current detectors, live VWAP stop | intraday, 20.4 bps at ₹10k | 25-32% | 2-10% | **No** |
| Daily-trend-gated intraday, 1.0 × ATR14 stop (candidate 1) | intraday, 20.4 bps at ₹10k | 7.0% | 87% | **Yes** |
| Same, 0.75 × ATR14 | intraday, 20.4 bps | 9.3% | 58% | Borderline, not chosen |
| Screener trend-leader swing, 2 × ATR14 stop (candidate 2) | delivery, **94.2 bps at ₹10k** | 15.9% | 10% | **No at ₹10k** |
| Same | delivery, **44.7 bps at ₹50k** | 7.5% | 79% | **Yes at ≥ ₹50k a position** |
| Same | delivery, 38.5 bps at ₹1L | 6.5% | 90% | Yes |
| Nifty EMA trend V1/V2 (index, about 33-point median stop) | ATM option, about 6 points (unvalidated) | 17-19% | 9-13% | **No** |
| Same | futures, about 15.6 points at FYERS rates | 44-50% | 0% | **No** |
| Same | the study's fixed 2.3 points (no real instrument) | about 7% | 72-82% | Only on a cost no instrument offers |

Delivery costs at ₹10k are dominated by the ₹20 minimum brokerage per order (20 bps a leg), STT of 0.1% on each side, and a ₹14.75 DP charge (about 15 bps). So the swing idea depends on position size. **Sizing is the owner's decision.** I register candidate 2 at ₹50,000 notional and report ₹10k and ₹1L as sensitivities.

**Registered: 2 candidates.** A third isn't registered, because no other screener or daily-trend idea meets the filter.

## 2. Candidate 1: daily-trend-gated intraday (the `HTF_TREND` idea done properly)
`VolatilityContraction`'s daily-trend gate fails open today, because `HTF_TREND:*` is never written (backtest README, gap 4). This candidate implements a daily-trend gate and replaces the stop. The detectors themselves don't change.
- **Signals:** the existing live equity detectors' signals: SMB LONG and SHORT, and VCP LONG.
  - **Backtest:** the edge-map collector's 63,436 signals, sha256 prefixes in `edge-map/REPORT.md` §1.
  - **Forward:** the live engine's detector fires, observed in shadow.
- **Daily-trend gate,** using daily bars through the **previous** session only:
  - **LONG** needs close > EMA20 > EMA50, and EMA50 above its value 5 sessions earlier.
  - **SHORT** needs close < EMA20 < EMA50, and EMA50 below its value 5 sessions earlier.
  - A signal without 50 prior daily bars is skipped, and the skips are counted.
- **Levels:**
  - **Stop:** entry ∓ 1.0 × ATR14. ATR14 uses Wilder's method on daily bars through the previous session.
  - **Target:** entry ± 1.5 × risk.
  - **Exits:** square-off at 15:15. A stop and target in the same bar count as the stop. A circuit-locked stop is deferred. Same mechanics as edge-map §2.3.
- **Cost filter, per trade:** cost = 20.4 bps × entry ÷ (10,000 × risk). A signal is **not taken** if its cost is more than 10% of R. Skips are counted.
- **One position per symbol at a time,** taking the first qualifying signal. A later signal on the same symbol is ignored while a position is open.

## 3. Candidate 2: screener trend-leader daily swing
- **Universe:**
  - **Forward:** the screener v2 list (Tier 1 + held), computed by the EOD job in **shadow mode**. It writes `watchlist_shadow_<date>.json` and **never** overwrites `watchlist.json`.
  - **Backtest:** proxy rules on the 90-stock cache, point in time:
    - trend template: close > EMA10 > EMA20 > EMA50, and SMA50 rising over 5 sessions;
    - close within 25% of its 52-week high;
    - RS rank in the top 30% of the 90 names by 0.2 × excess₂₁ + 0.4 × excess₆₃ + 0.4 × excess₁₂₆ against NIFTY50 (the cache has no NIFTY500).
- **Entry:** on the **next session's open** after a daily close above the prior 20-session high, while the name qualifies.
- **Stop:** entry − 2 × ATR14, using daily bars through the signal day.
- **Exit:** the stop, or the first daily close below EMA20 (exit at the next open), or 20 sessions held (exit at the close). A gap through the stop fills at the open.
- **Size and cost:** ₹50,000 notional; delivery cost 44.7 bps round trip (§1). **Cost filter, per trade:** not taken if cost is more than 10% of R. Sensitivity at ₹10k (94.2 bps) and ₹1L (38.5 bps).
- **Longs only.** At most 10 open positions, chosen by RS rank when there are more signals.

## 4. Data, split and statistics
- **Backtest data:** the 90-stock cache, 2021-07-05 → 2026-09-04, at 5 minutes for candidate 1 and daily for candidate 2. The live data freeze is from 23 Oct (`edge-map`).
- **Split:**
  - **Train:** 2021-07-05 → 2024-12-31.
  - **Test:** 2025-01-01 → 2026-09-04.
  - Rules are fixed here, so there's no tuning. Train and test are both reported.
- **Metric:** mean net R per trade at the FYERS cost (1×), plus 0×, 0.5× and 2×.
- **CI:** block bootstrap, 10,000 reps, seed 20261023, 95% percentile. Candidate 1 uses day blocks. Candidate 2 uses ISO-week blocks of the entry date, because holds overlap.
- **Floor:** n ≥ 30 per split, or the result is "insufficient".
- **Multiple comparisons:** 2 candidates. One-sided tests of mean net R > 0 on test, with Holm at α = 0.05. Candidate 1's detector-sides are reported descriptively.

## 5. Decision rules, fixed now
- **Eligible for a shadow deploy** means:
  - n ≥ 30 in both splits;
  - the **median cost among trades taken is ≤ 10% of R**;
  - the **point estimate of mean net R at 1× FYERS cost is > 0 in both train and test**.

  Otherwise the result is "not eligible", reported, and not shadowed.
- **Evidence of edge** needs Holm-significant test R > 0. Even then it's backtest-only. Because of the biases (§7), **the backtest can only screen a candidate out**; it can't establish an edge.
- **After the forward shadow:** once there are at least 100 shadow trades or 40 sessions, an edge needs net mean R with a 95% CI lower bound > 0. Then and only then is it an owner decision whether to go further. Otherwise the candidate stops.
- **No live alerting or sizing change** comes from this pre-registration.

## 6. Gates before any shadow deploy (all must pass)
1. The candidate is eligible under §5.
2. `npm run typecheck` 0, all tests green, lint no worse than 20 errors.
3. **Isolation tests prove** there's no Telegram send, no `paper_trades` row, no `signals` row change, no write to `watchlist.json`, and no REST/Fyers call in the engine path. There's a kill switch env flag, and output goes to `/app/data/<candidate>_shadow/<date>.jsonl`.
4. Any new Redis keys are in the boot cleanup and AGENTS §7. AGENTS and CHANGELOG are updated in the same commit.
5. **The daily-bar source is approved by the owner.** Both candidates need daily bars for watchlist names.
   - **Candidate 1** needs about 60 names a day.
   - **Candidate 2** needs the screener universe: the first fill is about 1,200-1,600 requests over possibly 2 evenings, then incremental.

   These are **Fyers history calls**: they run only after 15:45 under the quota ledger, and only with the owner's explicit OK each evening. If they aren't approved, the candidate isn't deployed.
6. **Timing:** not before Sunday 25 Oct evening, never 09:00-15:30, with the log copied first, a pg_dump, a rollback tag, only the affected container rebuilt, and **a report to the owner, waiting for an explicit go**.

## 7. Biases and limits
- **Survivorship and look-ahead in the universe:** the 90 names were picked in 2025-2026. That affects candidate 2's proxy most, since a real screener universe would include names that later failed.
- **Not independent for candidate 1:** same signals and period as the edge-map, and the stop was chosen from geometry on these signals (§0).
- **Candidate 2's RS proxy** ranks against NIFTY50 within 90 names, not NIFTY500 across about 2,350.
- **5-minute bars** for candidate 1; daily bars for candidate 2, with no intraday path, so stop and close-exit ordering inside a day follows the open → stop → close order.
- **Costs are assumptions:** FYERS rates as listed and slippage of 5 bps per leg. Neither is checked against a contract note.

## Deviation log
Append only, with the date, what changed and why. It is empty at registration.
