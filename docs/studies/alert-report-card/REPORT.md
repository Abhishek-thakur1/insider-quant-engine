# Alert performance report card (paper trades, 10 Sep – 9 Nov 2026)

**Read-only study.** The method was pre-registered in `PREREGISTRATION.md` (commit `a6d9e40`, pushed before
any data was read). Nothing on the server, in the gates, thresholds or stops was changed, and no Fyers calls
were made.

**All results are paper trades.** Fills are at the logged price, and no slippage is modelled beyond the
owner's assumed 20.4 bps round-trip cost. These are untracked paper results, not live performance.

- **Data:** snapshot of `paper_trades` (1,988 rows), `signals` (464) and `ev_shadow_outcomes` (34), up to the
  9 Nov close.
- **Script:** `report_card.py`, SHA-256 `e7674e71…f52a0b`.
- **Input hashes:** in `SHA256SUMS` in the evidence folder.
- **CSVs:** every table below, and every per-row assignment (`rows.csv`), are in the host evidence folder
  `~/evidence/2026-11-10/alert-report-card/`.

## Definitions (as registered)

- **Alert:** from 21 Oct, a `signals` row that passed the filter with `alert_sent = true`, joined to its CLOSED
  paper trade.
  - **Before 21 Oct there is no signals table.** "Alert" is a proxy there: a gated, closed paper trade. It's
    not known whether a Telegram went out, and before 6 Oct the alert policy was fail-open.
- **Other groups, kept separate:**
  - **ungated:** score-rejected, recorded only;
  - **EV-shadow:** EV-rejected, with a simulated outcome;
  - **passed but not alerted:** capital skip, zero size or duplicate;
  - **capital-skipped:** kept out of every win/loss rate.
- **R values:**
  - **Gross R** = `r_multiple`.
  - **Net R** = gross R − 0.00204 × entry / |entry − stop|.
  - **Win / loss / break-even:** above +0.05R, below −0.05R, or within ±0.05R. Decided for net and gross
    separately.
- **95% CIs:** day-block bootstrap (resampling trading days, B = 10,000, seed 20261110, percentile).
  - **Rows with n < 30 are marked "too small to read"** and are never highlighted.
- **Default exclusions:** status ORPHANED and the flags `orphaned`, `synthetic_close`, `duplicate_signal` and
  `index_option_proxy`. Rows with `pre_sizing_approx` or `duration_unverified` are kept, since their R is valid
  per DATA_PROVENANCE.

### Rows in and out (CSV: `exclusions.csv`)

| Group | Kept (CLOSED, valid R) | Capital-skipped (out of rates) | Synthetic close | Orphaned | Duplicate | Index option proxy |
|---|---|---|---|---|---|---|
| Alerts | **186** | 171 | 82 | 6 | – | – |
| Passed, not alerted | – | 22 | – | – | 5 | – |
| Ungated | **786** | 556 | 153 | 21 | – | – |
| EV-shadow | **31** | – | – | – | – | 3 |

- **Paper Nifty rows:** all 29 are flagged `index_option_proxy` (18 closed, 11 orphaned) and excluded, since
  they're priced at index level. So **Nifty contributes nothing to any R figure here.**
- **Passed but not alerted** (from 21 Oct): CAPITAL_SKIP 21, ZERO_SIZE 4, DUPLICATE 2.

## 1. Alerts: totals

| Scope | n | days | Win % (95% CI) | Loss % (95% CI) | BE % | Avg win | Avg loss | Exp. net R (95% CI) | Exp. gross R | PF (net) | Total net R | Total gross R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **All periods** | 186 | 33 | 34.4 (24.9–44.6) | 61.8 (51.5–71.7) | 3.8 | +1.19 | −1.03 | **−0.23 (−0.46 to +0.01)** | +0.01 | 0.64 | −42.8 | +2.3 |
| From 21 Oct (true alerts, signals era) | 57 | 11 | 17.5 (8.2–27.1) | 77.2 (65.4–87.2) | 5.3 | +1.01 | −0.72 | **−0.38 (−0.56 to −0.14)** | −0.17 | 0.32 | −21.5 | −9.6 |
| P3 only (4–9 Nov) | 19 | 4 | 15.8 (0–31.8) | 68.4 | 15.8 | +0.71 | −0.67 | −0.35 (−0.66 to +0.03) | −0.15 | 0.24 | −6.6 | −2.8 |

- The P3-only row is too small to read.
- **Win rate by gross R:** 39.8% (all periods), 26.3% (from 21 Oct) and 31.6% (P3).

**Sensitivity to the exclusions** (CSV: `sensitivity.csv`):

| Scope | n | Exp. net R (95% CI) |
|---|---|---|
| Default | 186 | −0.23 (−0.46 to +0.01) |
| S1, include flagged rows that have an R | 221 | −0.22 (−0.41 to −0.02) |
| S2, exclude every flagged row | 120 | −0.20 (−0.45 to +0.08) |

The exclusions don't change the sign or the size: all three runs land between −0.20 and −0.23R.

## 2. Costs

| Group | Exp. gross R | Exp. net R | Avg cost (R) | Cost that would break even (bps) | Observed net win rate | Break-even win rate at observed W/L |
|---|---|---|---|---|---|---|
| Alerts, all periods | +0.01 | −0.23 | 0.24 | **≈ 1 bp** | 34.4% | **46.5%** |
| Alerts, from 21 Oct | −0.17 | −0.38 | 0.21 | none (gross already < 0) | 17.5% | 41.6% |
| Ungated, all periods | −0.00 | −0.32 | 0.32 | none | 39.8% | 54.0% |
| EV-shadow (n = 31) | +0.32 | +0.01 | 0.31 | ≈ 21 bps | 51.6% | 51.1% |

- **The whole gross-to-net gap is the cost, by construction:** net = gross − cost.
- **What matters is gross R.** For alerts it is about zero (+0.01R), so any cost at all makes them negative.
  - The gross edge covers about **1 bp** of round-trip cost, against an assumed 20.4.
- **Why the cost is so large in R:** the median stop distance is about 0.9–1.9% of price, because equity stops
  are VWAP ± 0.2% plus the move to entry. So 20.4 bps costs about 0.2–0.3R on every trade.

## 3. Alerts: splits (CSV: `splits_alerts.csv`)

Net R by default. Cells with n < 30 are marked TS ("too small to read"). "Survives" refers to the corrections
in section 6.

| Split | Cell | n | days | Win % (CI) | Exp. net R (CI) | Exp. gross R | PF | |
|---|---|---|---|---|---|---|---|---|
| Detector | Stock Momentum Breakout | 110 | 30 | 40.0 (26.5–53.2) | −0.12 (−0.45 to +0.21) | +0.12 | 0.79 | |
| Detector | Volatility_Contraction_V2 | 76 | 23 | 26.3 (15.7–37.7) | −0.38 (−0.61 to −0.13) | −0.15 | 0.45 | survives BH |
| Side | LONG | 125 | 25 | 28.8 (18.8–39.0) | −0.32 (−0.54 to −0.11) | −0.08 | 0.51 | survives BH |
| Side | SHORT | 61 | 19 | 45.9 (22.2–66.7) | −0.04 (−0.64 to +0.49) | +0.20 | 0.94 | |
| Exit | TARGET | 30 | 15 | 100 | +1.38 | +1.63 | – | by construction |
| Exit | STOP | 49 | 20 | 0 | −1.40 | −1.10 | 0 | by construction |
| Exit | TIME | 62 | 18 | 21.0 (11.7–30.5) | −0.17 (−0.27 to −0.08) | −0.01 | 0.39 | by construction |
| Exit | TARGET / STOP / OTHER (inferred) | 16 / 24 / 5 | | | +1.23 / −1.36 / +1.61 | | | TS |
| Hour | 11 / 12 / 13 / 14 | 49 / 43 / 32 / 32 | | | −0.17 / −0.32 / −0.12 / −0.06 | +0.10 / −0.14 / +0.14 / +0.17 | | none survive |
| Hour | 09 / 10 / 15 | 1 / 24 / 5 | | | | | | TS |
| Score band (from 21 Oct) | 78–84 | 39 | 10 | 15.4 (6.1–23.8) | −0.43 (−0.54 to −0.31) | −0.21 | 0.22 | survives BH and Holm |
| Score band | ≥85 | 18 | 9 | 22.2 | −0.27 | −0.08 | 0.53 | TS |
| List group (from 5 Nov) | core / score / turnover | 10 / 1 / 1 | | | −0.14 / −0.04 / −0.30 | | | TS |
| Symbol | 125 symbols | max n = 6 | | | | | | all TS |
| Period | P0a (10 Sep – 5 Oct), proxy | 66 | 15 | 40.9 (24.6–58.0) | −0.28 (−0.71 to +0.18) | +0.01 | 0.66 | |
| Period | P0b (6–15 Oct), proxy | 63 | 7 | 42.9 (26.8–61.4) | −0.05 (−0.47 to +0.43) | +0.18 | 0.91 | |
| Period | P1 (21–27 Oct, 25 stocks) | 5 | 2 | 0 | −0.87 | −0.74 | 0 | TS |
| Period | P2a (28–30 Oct, 51–52) | 19 | 3 | 15.8 | −0.39 | −0.17 | 0.30 | TS |
| Period | P2b (2–3 Nov, 52, VWAP gate + timer) | 14 | 2 | 28.6 | −0.22 | +0.01 | 0.60 | TS |
| Period | P3 (4–9 Nov, 79, #68) | 19 | 4 | 15.8 | −0.35 | −0.15 | 0.24 | TS |

**Which periods are comparable:**
- **P0a and P0b:** same universe and same VWAP; only the alert label changed on 6 Oct.
- **P1 and P2a:** same VWAP, different universe (25 → 51 stocks). Partly comparable.
- **P2b is not comparable with anything earlier.** The VWAP session gate (#40) moves VWAP-based stops, and the
  15:15 timer (#45) changes TIME-exit prices.
- **P3 is not comparable with P2b.** #68 changed the equity VWAP again, and the list grew to 79 stocks.
- **No two periods share both the universe and the VWAP definition after 15 Oct.** Every period from P1 on
  has fewer than 30 alerts.

## 4. Ungated fires (score-rejected, recorded only): CSV `splits_ungated.csv`

| Scope | n | days | Win % (CI) | Exp. net R (CI) | Exp. gross R | PF |
|---|---|---|---|---|---|---|
| All periods | 786 | 37 | 39.8 (35.1–44.8) | −0.32 (−0.44 to −0.19) | −0.00 | 0.58 |
| From 21 Oct | 223 | 14 | 43.0 (33.7–52.8) | −0.22 (−0.47 to +0.02) | +0.07 | 0.65 |
| P3 only | 109 | 4 | 46.8 (31.6–63.5) | −0.18 (−0.57 to +0.26) | +0.11 | 0.71 |

Splits with n ≥ 30, net expectancy:
- **Detector:** Stock Momentum Breakout −0.23 (n = 273); VCP −0.37 (n = 513).
- **Side:** LONG −0.32 (663); SHORT −0.31 (123).
- **Hour:** 09 −0.31; 10 −0.36; 11 −0.46; 12 −0.18; 13 −0.06; 14 −0.40.
- **Score band:** 60–69 −0.20 (141); 70–77 −0.25 (72).
- **Period:** P0a −0.35; P0b −0.37; P1 −0.53; P2a −0.19; P2b −0.11; P3 −0.18.
- **Core group (from 5 Nov):** −0.19 (54, over 3 days).
- **The pattern:** every cell is negative after costs, and gross R is near zero throughout.

## 5. EV-shadow (EV-rejected, simulated): CSV `splits_ev_shadow.csv`

- **The data:** n = 31 over 5 days, 30 Oct – 9 Nov, 26 of them in P3.
- **The result:** net +0.01R (CI −0.96 to +0.39); gross +0.32R; win rate 51.6%.
- **The splits:** 26 of the 31 are VCP LONG, and 27 have a score below 60.
- **Too small to read** overall and in every split.
- **Caution:** the EV-shadow tracker is a separate simulation (`core/evShadow.ts`), not the paper tracker. Its
  fills and its target/stop handling may differ from the paper rows'.

### Gated vs ungated: does the filter help? (CSV: `gated_vs_ungated.csv`)

| Scope | Alerts n | Ungated n | Days | Alerts − ungated, net R (95% CI) |
|---|---|---|---|---|
| All periods | 186 | 786 | 37 | +0.09 (−0.14 to +0.33) |
| From 21 Oct | 57 | 223 | 14 | −0.15 (−0.39 to +0.13) |
| P3 only | 19 | 109 | 4 | −0.17 (−0.59 to +0.35) |

- **No evidence either way.** All three CIs include zero, and the sign flips between the full history and the
  signals era.
- **This isn't a causal estimate.** The filter selects on score, so the two groups differ in detector mix,
  time of day and regime.
- **The full-history row is the weakest.** Its alert definition before 21 Oct is a proxy, and the 171
  capital-skipped gated rows are excluded non-randomly: whether there was capital depends on earlier open
  trades.

## 6. Multiple comparisons (CSV: `multiple_comparisons.csv`)

**The family, as registered:** every split cell with n ≥ 30 across the three groups. That is 38 cells, each
testing H0: net expectancy = 0 with a day-block bootstrap p-value.
- **As registered:** 20 cells survive Benjamini-Hochberg (q = 0.05) and 17 survive Holm.
- **The exit-type problem:** 8 of those survivors are exit-type cells. A TARGET exit is a win and a STOP is a
  loss by definition, so those cells are significant by construction and carry no information.
- **Supplementary run, not pre-registered:** without the exit cells, 13 survive BH and 11 survive Holm.

The cells that survive, without the exit cells:

| Group | Cell | n | Exp. net R | BH | Holm |
|---|---|---|---|---|---|
| Alerts | score band 78–84 | 39 | −0.43 | ✓ | ✓ |
| Alerts | LONG | 125 | −0.32 | ✓ | ✓ |
| Alerts | Volatility_Contraction_V2 | 76 | −0.38 | ✓ | – |
| Ungated | Volatility_Contraction_V2 | 513 | −0.37 | ✓ | ✓ |
| Ungated | LONG | 663 | −0.32 | ✓ | ✓ |
| Ungated | hours 09, 10, 11, 14 | 161–194 | −0.31 to −0.46 | ✓ | ✓ |
| Ungated | periods P0a, P0b, P2a | 41–296 | −0.19 to −0.37 | ✓ | ✓ |
| Ungated | Stock Momentum Breakout | 273 | −0.23 | ✓ | – |

- **Every surviving cell is negative.** No cell with a positive net expectancy survives either correction, so
  there is no "best cell" to report.
- **A note on P2a (ungated):** it rests on 3 trading days. Bootstrap CIs from so few days are unreliable, so
  that survival is weak.

## 7. Limits

- **Survivorship and look-ahead in the symbol universe:**
  - P0 drew on `fyersUniverse.json` (April 2026): later listings are missing and delisted names are still in.
    Anomaly promotions were chosen intraday, in real time.
  - P1's 25 names came from the 19 Oct screener, which selects on past trend strength. That's known at the
    time, so it isn't look-ahead, but it is a momentum selection.
  - **The 52 core names (from 28 Oct) were picked by the owner.** Hindsight about which stocks had been moving
    can't be ruled out, and I can't verify it either way.
  - The daily list (from 4 Nov) uses the previous session's bhavcopy, so there's no look-ahead there.
- **Series breaks:**
  - the alert policy (6 Oct);
  - the equity-tick blackout (16–20 Oct);
  - the signals table (21 Oct);
  - the universe (21 Oct, 28 Oct, 4 Nov);
  - the VWAP session gate and the 15:15 timer exit (2 Nov);
  - #68 (4 Nov);
  - the list-group labels (5 Nov).
  - **The "all periods" totals pool regimes that aren't comparable.**
- **Paper fills:**
  - entries at the logged tick price, and exits at the stop or target level or the timer price;
  - no gaps, partial fills or queue position;
  - the only cost is the assumed 20.4 bps. That number is the owner's assumption; it isn't measured anywhere
    in this repo.
  - Equity stops are VWAP ± 0.2%, not each detector's own candle stop (AGENTS §11.7), so R depends on that
    choice.
- **Small samples:**
  - 186 alerts over 33 days;
  - 57 true alerts (from 21 Oct) over 11 days;
  - every period from P1 on has n < 30;
  - EV-shadow has n = 31 over 5 days.
  - Bootstrap CIs over fewer than about 10 days are too narrow to trust.
- **Things I couldn't verify:**
  - whether a Telegram was actually sent for any trade before 21 Oct (the proxy);
  - the exit type for 455 rows with no `exit_reason` (inferred from R and the target price);
  - `r_multiple` precision before October (2 decimals);
  - the EV-shadow tracker's fill logic against the paper tracker's;
  - delivery for the trades marked `alert_sent` (I didn't check whether delivery itself succeeded).
- **Selection inside the data:**
  - **Capital-skipped rows** (749 legacy CLOSED rows flagged `capital_skipped`, plus 124 SKIPPED) are
    excluded as instructed. Whether a trade was skipped depends on capital that earlier trades had tied up,
    so it isn't random.
  - **Synthetic closes** are invented 0R outcomes, so excluding them is right. Including them (S1) barely
    moves the result.
- **Nifty:** the paper Nifty rows are index-option proxies with no usable R, so this card covers equity
  detectors only.

## Verdict

**Can't tell yet by the pre-registered rule, but every estimate is negative.**

- **All periods:** the alerts' net expectancy is **−0.23R**, with a 95% CI of **−0.46 to +0.01**. The interval
  only just touches zero, so the rule's "yes" (CI above 0) and "no" (CI below 0) both fail.
- **True alerts only (21 Oct onward):** the CI is entirely below zero, at **−0.38R (−0.56 to −0.14)**, over
  57 trades and 11 days.
- **Before costs, alerts are about break-even:** +0.01R gross.
- **After costs:**
  - the assumed 20.4 bps costs about 0.24R per trade;
  - the observed 34% win rate would need to be about **46.5%** to break even at the observed average win and
    loss.
- **No split shows a positive expectancy that survives correction.**
- **The filter:** there's no evidence that it helps or hurts compared with the recorded-only fires. The CIs
  span zero, and the comparison is confounded.

**The sample that would settle it:**
- **To confirm a negative result:**
  - At the observed SD (1.16R) and day-clustering (design effect 2.0), about **190 alerts** are needed to
    confirm that −0.23R is below zero.
  - They have to come from **one stable regime**. At the current 4.75 alerts a day, that's about **40 trading
    days with no rule or universe changes**.
- **To detect a modest real edge:** to show +0.10R net is above zero, about **1,000 alerts** are needed. At
  the current rate that's roughly **215 trading days**, about ten months.
- **The current history can't settle either question.** Its regimes aren't comparable, and the true-alert era
  is only 11 days long.

*Paper results only. No live performance has been measured.*
