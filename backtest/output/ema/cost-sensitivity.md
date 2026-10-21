# Nifty EMA study — cost sensitivity (labelled correction)

## Correction (2026-10-21): every variant and detector re-costed on the same assumption

**Why:** the first report charged V0–V2 a fixed 2.3 points round trip, while the current detectors carried the harness cost: 5 bps slippage per leg, about 15–25 index points. That made the current detectors look much worse than V1/V2. This section re-costs every trade with ONE model at a time. **Trades, entries, exits and stops are unchanged.** Only the cost subtracted from gross index points differs. EMA10/30 robustness runs are omitted.

**Cost models (config/nifty_cost_models.json). NONE IS VALIDATED.** Points per round trip at an index of 20,000 / 25,000: fixed 2.3 · futures 14.0 · option 5.9 / fixed 2.3 · futures 16.8 · option 6.0. The futures model assumes STT of 0.05% on the sell side. The option model is an ATM weekly bought at delta 0.5 with premium = 0.5% of the index, and **does not model theta** (optimistic). The harness default is unchanged.

R = (gross index points − model cost) / initial risk. CI: day-block bootstrap, 10,000 resamples. ⚠ = n < 30.

### study fixed 2.3 pts

| strategy | all sessions | trend-down | trend-up | chop | 2021–2024 | 2025–2026 | trades/session |
|---|---|---|---|---|---|---|---|
| V0 crossover 9/21 | -0.053 [-0.09, -0.01] (n 2480) | +0.152 [+0.01, +0.32] (n 329) | -0.088 [-0.19, +0.03] (n 294) | -0.084 [-0.13, -0.04] (n 1857) | -0.043 [-0.09, +0.01] (n 1732) | -0.076 [-0.15, +0.01] (n 748) | 1.93 |
| V1 alignment (EMA20) | -0.010 [-0.04, +0.02] (n 5865) | +0.293 [+0.18, +0.42] (n 832) | +0.213 [+0.10, +0.34] (n 751) | -0.108 [-0.14, -0.08] (n 4282) | -0.008 [-0.05, +0.03] (n 4002) | -0.016 [-0.07, +0.04] (n 1863) | 4.56 |
| V2 pullback (EMA20) | -0.013 [-0.05, +0.02] (n 6554) | +0.282 [+0.18, +0.40] (n 933) | +0.280 [+0.15, +0.44] (n 861) | -0.123 [-0.15, -0.09] (n 4760) | +0.008 [-0.03, +0.06] (n 4424) | -0.055 [-0.10, -0.00] (n 2130) | 5.10 |
| nifty_vwap_reclaim (ungated) | -0.097 [-0.17, -0.02] (n 1011) | +0.050 [-0.16, +0.26] (n 133) | -0.113 [-0.32, +0.09] (n 133) | -0.120 [-0.21, -0.03] (n 745) | -0.091 [-0.18, -0.00] (n 712) | -0.110 [-0.25, +0.03] (n 299) | 0.79 |
| nifty_trend_pulse (ungated) | +0.078 [-0.01, +0.17] (n 678) | +0.506 [+0.31, +0.69] (n 155) | +0.622 [+0.42, +0.81] (n 106) | -0.219 [-0.32, -0.12] (n 417) | +0.090 [-0.01, +0.19] (n 542) | +0.032 [-0.16, +0.23] (n 136) | 0.53 |
| nifty_opening_range_explosion (ungated) | -0.024 [-0.12, +0.08] (n 461) | +0.469 [+0.19, +0.74] (n 70) | +0.594 [+0.36, +0.82] (n 77) | -0.285 [-0.40, -0.17] (n 314) | -0.049 [-0.16, +0.07] (n 372) | +0.079 [-0.16, +0.32] (n 89) | 0.36 |

### Nifty index futures (near month)

| strategy | all sessions | trend-down | trend-up | chop | 2021–2024 | 2025–2026 | trades/session |
|---|---|---|---|---|---|---|---|
| V0 crossover 9/21 | -0.439 [-0.48, -0.39] (n 2480) | -0.220 [-0.37, -0.04] (n 329) | -0.471 [-0.58, -0.35] (n 294) | -0.473 [-0.52, -0.42] (n 1857) | -0.414 [-0.47, -0.36] (n 1732) | -0.499 [-0.58, -0.41] (n 748) | 1.93 |
| V1 alignment (EMA20) | -0.426 [-0.46, -0.39] (n 5865) | -0.110 [-0.23, +0.02] (n 832) | -0.209 [-0.32, -0.07] (n 751) | -0.526 [-0.56, -0.49] (n 4282) | -0.410 [-0.45, -0.37] (n 4002) | -0.462 [-0.52, -0.40] (n 1863) | 4.56 |
| V2 pullback (EMA20) | -0.458 [-0.49, -0.42] (n 6554) | -0.144 [-0.25, -0.02] (n 933) | -0.175 [-0.31, -0.02] (n 861) | -0.571 [-0.61, -0.53] (n 4760) | -0.417 [-0.46, -0.37] (n 4424) | -0.543 [-0.60, -0.48] (n 2130) | 5.10 |
| nifty_vwap_reclaim (ungated) | -0.694 [-0.77, -0.61] (n 1011) | -0.547 [-0.78, -0.32] (n 133) | -0.682 [-0.89, -0.48] (n 133) | -0.722 [-0.81, -0.63] (n 745) | -0.658 [-0.75, -0.56] (n 712) | -0.779 [-0.93, -0.63] (n 299) | 0.79 |
| nifty_trend_pulse (ungated) | -0.160 [-0.25, -0.07] (n 678) | +0.274 [+0.08, +0.46] (n 155) | +0.378 [+0.18, +0.57] (n 106) | -0.458 [-0.56, -0.35] (n 417) | -0.140 [-0.24, -0.04] (n 542) | -0.240 [-0.43, -0.05] (n 136) | 0.53 |
| nifty_opening_range_explosion (ungated) | -0.214 [-0.31, -0.11] (n 461) | +0.277 [-0.00, +0.55] (n 70) | +0.403 [+0.17, +0.63] (n 77) | -0.475 [-0.59, -0.36] (n 314) | -0.233 [-0.34, -0.12] (n 372) | -0.134 [-0.37, +0.10] (n 89) | 0.36 |

### At-the-money weekly Nifty option, bought (delta 0.5) — theta NOT modelled

| strategy | all sessions | trend-down | trend-up | chop | 2021–2024 | 2025–2026 | trades/session |
|---|---|---|---|---|---|---|---|
| V0 crossover 9/21 | -0.169 [-0.21, -0.12] (n 2480) | +0.041 [-0.10, +0.21] (n 329) | -0.201 [-0.31, -0.08] (n 294) | -0.201 [-0.24, -0.15] (n 1857) | -0.161 [-0.21, -0.11] (n 1732) | -0.186 [-0.26, -0.10] (n 748) | 1.93 |
| V1 alignment (EMA20) | -0.134 [-0.17, -0.10] (n 5865) | +0.173 [+0.06, +0.30] (n 832) | +0.089 [-0.02, +0.22] (n 751) | -0.233 [-0.26, -0.20] (n 4282) | -0.135 [-0.17, -0.09] (n 4002) | -0.132 [-0.19, -0.08] (n 1863) | 4.56 |
| V2 pullback (EMA20) | -0.145 [-0.18, -0.11] (n 6554) | +0.155 [+0.05, +0.27] (n 933) | +0.146 [+0.01, +0.30] (n 861) | -0.256 [-0.29, -0.22] (n 4760) | -0.127 [-0.17, -0.08] (n 4424) | -0.182 [-0.23, -0.13] (n 2130) | 5.10 |
| nifty_vwap_reclaim (ungated) | -0.280 [-0.36, -0.20] (n 1011) | -0.131 [-0.35, +0.08] (n 133) | -0.286 [-0.49, -0.09] (n 133) | -0.305 [-0.39, -0.22] (n 745) | -0.276 [-0.37, -0.19] (n 712) | -0.288 [-0.42, -0.14] (n 299) | 0.79 |
| nifty_trend_pulse (ungated) | +0.003 [-0.09, +0.09] (n 678) | +0.432 [+0.24, +0.61] (n 155) | +0.545 [+0.34, +0.73] (n 106) | -0.295 [-0.40, -0.19] (n 417) | +0.013 [-0.09, +0.12] (n 542) | -0.040 [-0.23, +0.15] (n 136) | 0.53 |
| nifty_opening_range_explosion (ungated) | -0.082 [-0.18, +0.02] (n 461) | +0.411 [+0.13, +0.68] (n 70) | +0.535 [+0.30, +0.76] (n 77) | -0.344 [-0.46, -0.23] (n 314) | -0.107 [-0.22, +0.01] (n 372) | +0.023 [-0.21, +0.26] (n 89) | 0.36 |

Baseline gross points are recovered from the harness fills by removing its 5 bps per leg. Their entry is the signal price and their exit is the stop or target level (or the bar close at square-off) — the harness exit rules, not the study's.
