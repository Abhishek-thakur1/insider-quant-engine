# Nifty EMA trend study — plain-language summary (2026-10-21)

Run once, as pre-registered (`8e4d5b6` parameters, `bad2952` code, committed before the run).
Full tables: `backtest/output/ema/results.md` and `report.html`. **Index points only: no option
premium, theta or OI.** "VWAP" is a TWAP proxy because the cached index volume is 0.

**Data:** 1,285 sessions, 2021-07-05 → 2026-09-07. By the committed labels: 198 trend-down,
199 trend-up, 888 chop (69%). Seven sessions are short. Oct 19 and Oct 21, 2026 are not in the cache.

## Did any variant capture trend days without losing on chop days?

**No.** All of them make money on trend days and lose it on chop days. Overall, every variant is
at or below zero, and every one is negative at 2× cost.

| Variant (EMA20) | All sessions E[R], 95% CI | Trend-down | Trend-up | Chop | Trades / session |
|---|---|---|---|---|---|
| V0 crossover 9/21 | −0.053 [−0.095, −0.008] | +0.152 | −0.088 | −0.084 | 1.9 |
| V1 alignment | −0.010 [−0.042, +0.024] | +0.293 [0.18, 0.42] | +0.213 [0.10, 0.34] | −0.108 [−0.14, −0.08] | 4.6 |
| V2 pullback | −0.013 [−0.046, +0.023] | +0.282 [0.18, 0.40] | +0.280 [0.15, 0.44] | −0.123 [−0.15, −0.09] | 5.1 |

10,000-resample day-block bootstrap. Every row has n ≥ 30 except where the full report marks it.

- **What it does catch on trend days:** V1 and V2 take about **13–17% of the day's open-to-close move**. The current Nifty detectors take 1–2% (Trend Pulse and ORB, ungated). The Trend Pulse comparison isn't like-for-like: the baselines use the harness's own exits.
- **What it gives back on chop days:** about −0.11 to −0.12R per trade on 69% of sessions, at 4.8–5.4 trades each. That cancels the trend-day gain.
- **You can't pick the day in advance.** The trend/chop labels use the day's own close (end-of-day information). The variants don't know the label, and that's exactly why they lose on chop.
- **It's less stable recently.** In 2025–2026, trend-up sessions turn negative for V1 (−0.033) and V2 (−0.028). Trend-down stays positive (V1 +0.290, V2 +0.245).
- **Too many alerts for a live channel:** about 4.6–5.1 trades per session, and more signals than that, since V2 skips 10,007 of 17,390 signals because a position is already open.
- **The robustness check (not used to pick anything) agrees:** EMA30 is at about 0 (V1 −0.006, V2 −0.000, CIs spanning 0). EMA10 is negative (V1 −0.042, V2 −0.032).

## The current Nifty detectors, same sessions (harness exits)

| Detector | Ungated E[R] (n) | Gated E[R] (n) |
|---|---|---|
| Trend Pulse | −0.280 (678) | −0.181 (97) |
| Opening Range Explosion | −0.313 (461) | none passed the gate (0) |
| VWAP Reclaim | −1.003 (1,011) | −0.267 (23, insufficient) |

All three are positive on trend days and strongly negative on chop days. VWAP Reclaim loses about 1R per trade on every day type.

## Confidence and limits

- The claim "positive on trend days, negative on chop" is well supported: CIs exclude 0 for V1 and V2, with n of 750–4,800.
- The claim "net edge" is **not** supported: CIs span 0 at 1× cost and the results are negative at 2×.
- Limits:
  - Index only, with no option premium or theta. A PE/CE buyer pays theta that these R values ignore.
  - One fixed cost assumption.
  - One market history (2021–2026).
  - The VWAP is a TWAP proxy.
  - The labels use end-of-day information.
  - Baseline exits differ from the study's.

## What this does not decide

The study is report only. It doesn't change any detector, gate, threshold or alert. A follow-up
that tries to tell trend days from chop days *in real time* (for example, the first hour's range
or regime) would be a new, separately pre-registered study.
