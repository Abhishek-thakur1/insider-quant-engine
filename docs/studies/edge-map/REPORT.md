# Edge-map study: report

**Verdict: no edge found.** No detector × side × time × regime × score cell shows a positive expectancy after costs, in the replay or in live paper trading. Higher scores do lose less, for SMB-LONG and VCP-LONG, but every score tier still loses. A wider ATR stop also loses less, mostly because costs are a smaller share of a wider stop. It doesn't create an edge.

- **Pre-registration:** `PREREGISTRATION.md`, committed in `54cf86f` at 19:20 IST on 2026-10-23, before any analysis.
- **Deviations:** 8, all in its deviation log. Entries 1-6 came before results, and entries 7-8 after (both descriptive).
- **Generated numbers:** `tables.md` and `results.json`, produced by `backtest/studies/edge-map/analyze.ts`. Day-block bootstrap, seed 20261023, 10,000 reps. Every CI is a 95% percentile interval.
- **Labels:** *Tested on paper* means replayed or paper-traded. *Unverified* means an assumption.

---

## 1. Data and integrity
| | |
|---|---|
| Replay | The 2 live equity detectors plus the real filter, over the 90-stock + Nifty cache, at 5-minute bars. **1,284 sessions, 2021-07-05 → 2026-09-04, 63,436 signals, 0 detector errors.** Run in a sealed sandbox: `--network none`, empty env file, cache read-only, `sandboxGuard.ts` passed. |
| Split | Train: 2021-07-05 → 2024-12-31. Test: 2025-01-01 → 2026-09-04. |
| Live | Frozen read-only export at 19:31:52 IST on 23 Oct. `paper_trades.csv` sha256 `8e9db9c1…6666` (1,606 rows); `signals.csv` `b2ae3faa…bfe` (36 rows). |
| Replay files | `sig_A`-`sig_F.jsonl` sha256 prefixes: `873df6bc`, `3304334d`, `5b1187a0`, `bd01119c`, `5211b909`, `14eb8963`. Cache manifest (res-5 + res-D names and sizes) `f791a92f803a618a`. |
| Excluded signals | 99 had no forward bars. S1 lacked ATR history for 889, S2 lacked ADR history for 1,210 (the first weeks of the cache, and symbols that start later). |
| Look-ahead | Passed for filter state (deviation 1). Universe selection is a stated bias (§8). |
| No Fyers calls | None. No change to live detectors, gates or stops. |

**Reproduction check (partial).** The committed `backtest/output/results_5m.json` was generated on **2026-09-07** with older code; the filter and harness have changed since. In the same window (2025-03-17 → 2026-09-04):
- **Ungated counts are close:** SMB 10,862 vs 10,324, and VCP 10,892 vs 10,245, within about 6%.
- **Gated counts differ:** SMB 3,181 vs 1,804, because the filter changed.
- **Means are close:** SMB gated is about −0.101R here (n-weighted across both sides) against −0.110R committed.

So this isn't an exact reproduction, and the old file shouldn't be read as this code's result.

## 2. Old replay vs the live-stop replay, on the same signals (Tested on paper)
- **Old** means the harness exactly: the detector's trigger stop and T1 target.
- **S0** means the live rule: stop = VWAP × 0.998 / × 1.002, target 1.5R (`alertPipeline.ts`).
- **Same convention for both:** 5 bps slippage per leg, no charges.

| Detector-side | Set | Old: n | Old: mean R [95% CI] | S0 live stop: n | S0: mean R [95% CI] |
|---|---|---|---|---|---|
| SMB-LONG | all, full period | 18,226 | −0.162 [−0.183, −0.141] | 18,226 | −0.138 [−0.160, −0.117] |
| SMB-LONG | gated, 2025-03-17 → 2026-09-04 | 1,728 | −0.144 [−0.201, −0.089] | 1,728 | −0.095 [−0.148, −0.044] |
| SMB-SHORT | all, full period | 13,202 | −0.076 [−0.106, −0.047] | 13,202 | −0.045 [−0.072, −0.017] |
| SMB-SHORT | gated, 2025-03-17 → 2026-09-04 | 1,453 | −0.051 [−0.128, +0.026] | 1,453 | −0.013 [−0.080, +0.055] |
| VCP-LONG | all, full period | 31,909 | −0.232 [−0.250, −0.214] | 31,909 | −0.204 [−0.222, −0.187] |
| VCP-LONG | gated, 2025-03-17 → 2026-09-04 | 1,292 | −0.184 [−0.246, −0.123] | 1,292 | −0.149 [−0.206, −0.091] |

The live stop is **0.02-0.05R less negative** than the old replay's trigger stop on every row. So past replay numbers understated live-rule results slightly, but the sign is the same. Only SMB-SHORT gated has a CI that includes 0, under both methods.

## 3. H1: is the score calibrated? (Tested on paper)
Slope of net R (1× cost) per score point. Holm across the detector-sides that pass on train, then once on test.

| Detector-side | Train slope [95% CI] | Test slope [95% CI] | Result |
|---|---|---|---|
| SMB-LONG | +0.0051 [+0.0032, +0.0071], n=11,456 | +0.0040 [+0.0010, +0.0069], n=6,770 | **calibrated** |
| SMB-SHORT | −0.0003 [−0.0027, +0.0021], n=8,219 | not tested (failed on train) | not calibrated |
| VCP-LONG | +0.0029 [+0.0015, +0.0044], n=20,099 | +0.0024 [+0.0007, +0.0043], n=11,810 | **calibrated** |

**What "calibrated" means here:** higher scores lose less. It doesn't mean high scores win. At the live threshold (≥ 78), mean net R on test is still −0.188 (SMB-LONG), −0.097 (SMB-SHORT) and −0.247 (VCP-LONG); see the tier table in `tables.md` §B.
- **Gated vs rejected:** filter-passed trades average **−0.176R** on test against −0.292R for rejected ones.
- **Conclusion:** the filter ranks trades in the right order but doesn't pick out winners.
- **Live:** only 18 scored trades exist (scores were logged from 21 Oct), below the floor. Not tested.

## 4. H2: the edge map (Tested on paper)
- **Cells:** 78 cells had any trade. 56 had train n ≥ 30 and were tested (Benjamini-Hochberg, q = 0.10). 22 were below the floor and are shown untested.
- **BH discoveries: 46, every one negative.** Of those, 26 were confirmed on test (Holm), all as **confirmed losses**.
- **Cells meeting the pre-registered "edge found" rule: 0.**
- **Marginals on test (net R, 1×):**
  - **Detector-side:** SMB-LONG −0.240, SMB-SHORT −0.163, VCP-LONG −0.328.
  - **Time of day:** T1 −0.299, T2 −0.271, T3 −0.237.
  - **Regime:** trending −0.269 (n=21,219), transition −0.268, ranging −0.118 (n=92; CI includes 0).
- **The regime label rarely varies:** about 90% of replay trades are `trending` (35,513 of 39,774 train, 21,219 of 23,563 test).
- The full cell table is in `tables.md` §C.

## 5. H3: stop geometry (Tested on paper)
Paired comparison on the same entries, net R at 1×.

| Detector-side | Test: S0 live | S1 ATR(14) × 0.5 | S2 ADR(20) × 0.25 | S3 trigger | Chosen on train | Test S1 − S0 [95% CI] |
|---|---|---|---|---|---|---|
| SMB-LONG (n=6,742) | −0.242 | −0.104 | −0.238 | −0.294 | S1 | +0.138 [+0.120, +0.155] |
| SMB-SHORT (n=4,969) | −0.164 | −0.074 | −0.175 | −0.226 | S1 | +0.090 [+0.071, +0.109] |
| VCP-LONG (n=11,746) | −0.329 | −0.126 | −0.269 | −0.378 | S1 | +0.202 [+0.187, +0.218] |

By the pre-registered rule, S1 is a **"stop candidate"** for all three. **The decomposition (table D2, deviation 8) shows where the gain comes from:**
- **Gross R is no better.** At zero cost, S1's gross R is about the same as S0's: SMB-LONG +0.023 vs +0.024, VCP-LONG −0.005 vs −0.020. For SMB-SHORT it's worse: +0.052 vs +0.083.
- **The stop is twice as wide.** S1's median stop is about 140-150 bps from entry, against 65-85 bps for S0, so the same ₹ cost is about half as many R.

So the gain is **cost dilution, not better exits**. Under fixed-risk sizing that saving is real (fewer shares per ₹ risked), but **every rule's net expectancy is still negative**. No stop rule turns any detector positive.

## 6. Costs (assumptions, Unverified)
The base is 17 bps round trip: 5 bps slippage per leg (the harness default) plus 7 bps of charges, which is assumed and not checked against a fee schedule. S0, mean net R on test:

| Detector-side | 0× | 0.5× | 1× | 2× | 3× | Break-even cost |
|---|---|---|---|---|---|---|
| SMB-LONG | +0.026 | −0.107 | −0.240 | −0.506 | −0.772 | 1.6 bps |
| SMB-SHORT | +0.084 | −0.040 | −0.163 | −0.410 | −0.657 | 5.8 bps |
| VCP-LONG | −0.019 | −0.174 | −0.328 | −0.637 | −0.946 | below 0 |

**Gross expectancy is close to zero.** SMB-SHORT is the only clearly positive one, at +0.08 to +0.11R, and it breaks even at about 6-7 bps round trip. That's below the 10 bps of slippage alone. **This is the main finding:** with stops 65-85 bps wide, any realistic cost decides the result.

### 6b. Your broker's costs: FYERS equity intraday on NSE (assumptions, Unverified)
Added at the owner's request (deviation 9, descriptive). The rates are from [fyers.in/charges-list](https://fyers.in/charges-list) and the [FYERS statutory-charges article](https://support.fyers.in/portal/en/kb/articles/what-are-the-statutory-charges-on-trades-at-fyers-stt-gst-sebi-turnover-fee-ipft-etc), fetched 2026-10-23. **Every line is an assumption.** None has been checked against a FYERS contract note. Live paper trades are sized at about **₹10,000 notional**: median ₹9,440 over 710 sized closed trades, and ₹9,748 since 15 Oct.

| Component | Rate (assumed) | bps of notional at ₹10,000 | at ₹1,00,000 |
|---|---|---|---|
| Brokerage, both legs | ₹20 or 0.03% per executed order, whichever is lower. At ₹10k that's ₹3 per leg; the cap doesn't bind | 6.00 | 4.00 |
| STT, sell leg | 0.025% of sell value | 2.50 | 2.50 |
| NSE transaction charge, both legs | 0.0018299% (FYERS list; other sources quote 0.00297%, which would add about 0.2 bps) | 0.37 | 0.37 |
| Clearing charge, both legs | 0.0005% | 0.10 | 0.10 |
| SEBI turnover fee, both legs | ₹10 per crore | 0.02 | 0.02 |
| NSE IPFT, both legs | ₹10 per crore (support article; the charges list says ₹0.01, so I used the higher) | 0.02 | 0.02 |
| Stamp duty, buy leg | 0.002% of buy value (some sources say 0.003%, which would add 0.1 bps) | 0.20 | 0.20 |
| GST | 18% of brokerage + exchange + clearing + SEBI + IPFT | 1.17 | 0.81 |
| Slippage, both legs | 5 bps per leg (the harness assumption, not measured) | 10.00 | 10.00 |
| **Total, round trip** | | **20.4** | **18.0** |

- **Charges alone are 10.4 bps** at ₹10,000. Brokerage dominates them, because 0.03% is below the ₹20 cap at this size. Slippage adds another 10 bps.
- **The pre-registered base of 17 bps was optimistic** for your trade size.

**Break-even cost against the FYERS total (S0, the live stop):**

| Detector-side | Break-even, train / test | FYERS total | Mean net R at the FYERS total, test |
|---|---|---|---|
| SMB-LONG | 0.6 / 1.6 bps | 20.4 bps | −0.293 |
| SMB-SHORT | 7.5 / 5.8 bps | 20.4 bps | −0.212 |
| VCP-LONG | below 0 / below 0 | 20.4 bps | −0.389 |

The best break-even (SMB-SHORT, about 6-7.5 bps) is **less than the charges alone**, before any slippage.

**Cost per trade as a percent of R (cost-to-risk ratio),** at 20.4 bps: cost = 20.4 bps × entry ÷ (10,000 × stop distance).

| Detector-side | Live trades: median (mean) | Live: share ≤ 10% of R | Replay test, S0 live stop: median | S0 share ≤ 10% | Replay test, S1 ATR stop: median | S1 share ≤ 10% |
|---|---|---|---|---|---|---|
| SMB-LONG | 26.1% (30.6%), n=300 | 6.7% | 27.2% | 1.6% | 14.8% | 10.4% |
| SMB-SHORT | 24.5% (28.8%), n=251 | 10.0% | 25.2% | 3.2% | 14.7% | 11.7% |
| VCP-LONG | 26.4% (32.8%), n=787 | 7.4% | 31.8% | 2.5% | 13.9% | 15.9% |

**About a quarter to a third of every R goes on costs** with the live VWAP stop. To win, a trade has to clear roughly 0.25-0.3R before it earns anything, and gross expectancy is about 0. Even the ATR stop, twice as wide, leaves a median cost of about 14-15% of R. This is the measured basis for the cost-to-risk filter on the shadow candidates (`docs/studies/shadow-candidates/PREREGISTRATION.md`).

## 7. Wrong-side stops, in their own table (Tested on paper)
These are trades whose live stop (VWAP × 0.998 / × 1.002) sits on the wrong side of entry, with stop ≥ entry for a LONG. The pre-registration keeps them out of H1-H3 (deviation 2).

| Data | Detector-side | Train n | Test n | Mean P&L |
|---|---|---|---|---|
| Replay | SMB-LONG | 0 | 0 | — |
| Replay | SMB-SHORT | 0 | 0 | — |
| Replay | VCP-LONG | 0 | 0 | — |
| Live (kept rows) | all | 0 | | — |

There are **none**, in the replay (63,337 simulated entries) or in the kept live rows. Why the two equity detectors never fire on the wrong side of VWAP × 0.998 hasn't been established. Only one SMB setup checks VWAP explicitly. The `alertPolicy.ts` geometry guard therefore covers a case that didn't occur in this data.

## 8. Live paper trades (descriptive, gross R as recorded)
- **All recorded:** all 1,573 CLOSED rows average **+0.0045R**. That matches your earlier figure (n=1,556, 0.004).
- **Excluded (deviation 7):** 235 rows flagged `synthetic_close` (₹0 / 0R closes invented by the removed boot sweep), which include all 18 `index_option_proxy` Nifty rows.
- **Kept:** n=1,338 over 26 sessions, mean +0.0053R gross.

| Detector-side | n | Mean gross R [95% CI] | Mean net R at 1× [95% CI] |
|---|---|---|---|
| SMB-LONG | 300 | +0.030 [−0.188, +0.193] | −0.225 [−0.452, −0.060] |
| SMB-SHORT | 251 | +0.035 [−0.311, +0.353] | −0.205 [−0.571, +0.103] |
| VCP-LONG | 787 | −0.014 [−0.159, +0.106] | −0.287 [−0.447, −0.161] |

**Live agrees with the replay:** gross is about 0, and net of assumed costs is about −0.2 to −0.3R.
- Live R is gross in the database. The engine deducts no costs.
- Nifty live outcomes can't be measured: every Nifty row is a synthetic close at its entry price.

## 9. Biases and limits
- **Survivorship:** the 90 stocks were chosen in 2025-2026, so names delisted or demoted since 2021 are missing. That biases the train period upward. The universe also changes over time: some symbols start as late as 2025-12-19.
- **Look-ahead in selection:** if the list was chosen on later liquidity, the train period sees the future through the choice of universe. This can't be corrected with this cache.
- **Fidelity:**
  - 5-minute bars, with the stop taken first in an ambiguous bar.
  - Synthetic ticks distort VCP's tick-count logic (harness README, gap 3).
  - No circuit-band data.
  - The harness signal path isn't the live tick path.
- **Correlation:** several signals per symbol per day are all kept. The day-block bootstrap handles the correlation within a day, but n overstates the number of independent bets.
- **Live:** 26 sessions, one regime label, no costs deducted, and 749 rows sized at 0 (`capital_skipped`). Their R is still valid.

## 10. What this means
- **No change is justified by this study.** It wasn't designed to change anything and found no edge.
- **Live R as recorded is gross,** which makes it look breakeven. Net of any realistic cost, the live rule loses about 0.2-0.3R per trade. The dashboard and the 15:45 summary report gross figures.
- **Where any future work should aim,** with the owner's OK and shadow mode first:
  - **Costs vs stop width:** costs dominate because the stops are tight. A wider stop only dilutes costs; it doesn't make an edge.
  - **SMB-SHORT** is the only detector-side with clearly positive gross R in both splits (S0: +0.106 train, +0.084 test). It's below cost, and it's the only one where the score has no slope.
- **Not supported by this evidence:**
  - "Raising the threshold makes it profitable": ≥ 78 is still negative.
  - "A better stop rule makes it profitable."
