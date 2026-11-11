# Nifty threshold study: report (P = live caps vs V = volatility-scaled), cached data 2021–2026

**Index moves, not tradable as options. Paper / replay results only; nothing here is a live result.**

- **Method:** pre-registered in `PREREGISTRATION.md`, including V (owner-approved 11 Nov) and amendments 1–2, all
  committed before this run.
- **Run:** offline on cached Fyers 1-minute Nifty bars, with no Fyers call and no live change.
- **Equivalence (precondition):** the backtest-only ORE copy at 120/80 reproduced the live class on all 1,258
  study sessions. Every signals row and every ORE block record matched, and ORE fires, risk-cap and
  range-too-wide records were all compared (`--mode EQ`: 0 mismatches, 0 errors).
- **Data:** 1,258 sessions (2021-08-03 → 2026-09-07; the first 20 cached sessions are warm-up). **Out-of-sample**
  = the 60 sessions 2026-06-15 → 2026-09-07, after the limits were written. **In-sample** = 1,198.
- **Code:** commit `4380793` (PR #75).
- **Files:** `P.jsonl` and `V.jsonl` (SHA-256 in `SHA256SUMS`), `analyze.py` and the CSVs, all in
  `C:\trade-data\nifty-thresholds\` on the owner's PC.
- **Statistics:** 95% CIs are day-block bootstrap (B = 10,000, seed 20261111). n < 30 is "too small to read".
- **Costs:** net R charges the cost proxy of 10 bps of the index per round trip; 5 and 20 bps are shown.

## 1. Headline

1. **No ORE fire passed the filter, under either variant, in five years of replay.**
   - P: 453 fires, of which 448 were rejected on score and 5 on EV.
   - V: 213 fires, 212 on score and 1 on EV.
   - With today's filter, the caps decide how often ORE *fires* but **not whether it alerts**: it never alerted.
     Changing the caps alone wouldn't produce a single ORE alert.
2. **Both variants lose after the cost proxy.** These are all fires, before the filter:
   - P: **−0.32R** per fire, 95% CI −0.42 to −0.22, n = 453.
   - V: **−0.37R**, CI −0.52 to −0.22, n = 213.
   - **Before costs both are near zero:** P +0.01R, V −0.03R.
3. **V doesn't improve expectancy.** V − P = −0.05R (CI −0.17 to +0.07), pooled. Out-of-sample, both n are under
   30 (14 and 13), too small to read.
4. **V changes the fire count, in opposite directions by period:**
   - **Pooled:** 0.17 fires per session against P's 0.36 (V − P = −0.19, CI −0.22 to −0.17). OR20 was below the
     69.82 reference in most years, so V's caps were **tighter** than live in 2021–2025.
   - **2026:** OR20 rose, so V was **looser**: about 0.27 against 0.15 fires per session.
   - **Out-of-sample:** about equal, 0.22 against 0.23. V's caps were then about 115 / 77 points.

## 2. Signal counts and block reasons (per session)

| Scope | Variant | Sessions | Avg caps (range / risk) | ORE fires | Sessions ORE fired | risk_cap blocks | range_too_wide blocks |
|---|---|---|---|---|---|---|---|
| All | P | 1,258 | 120 / 80 | 0.36 | 36% | 0.83 | 0.64 |
| All | V | 1,258 | 103 / 69 | 0.17 | 17% | 1.18 | 0.94 |
| In-sample | P / V | 1,198 | 120/80 · 102/68 | 0.37 · 0.17 | | 0.85 · 1.22 | 0.68 · 0.98 |
| **Out-of-sample** | P / V | 60 | 120/80 · 115/77 | 0.23 · 0.22 | | 0.42 · 0.43 | 0.00 · 0.00 |
| 2021 (H2) | P / V | 103 | 120/80 · 90/60 | 0.38 · 0.14 | | 0.83 · 1.29 | 0.48 · 0.77 |
| 2022 | P / V | 247 | 120/80 · 103/69 | 0.40 · 0.22 | | 1.07 · 1.35 | 0.28 · 0.81 |
| 2023 | P / V | 245 | 120/80 · 74/50 | 0.55 · 0.10 | | 0.33 · 1.09 | 0.20 · 1.02 |
| 2024 | P / V | 246 | 120/80 · 98/66 | 0.38 · 0.14 | | 0.89 · 1.32 | 0.61 · 1.06 |
| 2025 | P / V | 248 | 120/80 · 113/75 | 0.25 · 0.17 | | 0.95 · 1.17 | 0.73 · 0.97 |
| **2026 (to 7 Sep)** | P / V | 169 | 120/80 · **144/96** | 0.15 · **0.27** | | 0.92 · 0.81 | 1.83 · 0.89 |

- **Trend Pulse and VWAP Reclaim** (context) are identical under P and V: 672 and 825 fires.
- **Excluded fires:** none had missing or wrong-side levels (`no_levels` 0, `invalid_geometry` 0).
- **ORE exits under P:** 213 stop, 128 target, 112 TIME.

## 3. ORE index-move expectancy (all fires; none passed the filter)

| Variant | Cell | n | Win % | Gross R | Net R at 5 / 10 / 20 bps | 95% CI (10 bps) | PF | Survives BH / Holm |
|---|---|---|---|---|---|---|---|---|
| P | pooled | 453 | 38.4 | +0.01 | −0.16 / **−0.32** / −0.64 | −0.42 to −0.22 | 0.54 | yes / yes (negative) |
| P | in-sample | 439 | 38.5 | +0.01 | −0.15 / −0.31 / −0.64 | −0.41 to −0.21 | 0.55 | yes / yes (negative) |
| P | out-of-sample | 14 | 35.7 | −0.17 | −0.35 / −0.53 / −0.89 | −1.05 to +0.02 | 0.35 | too small to read |
| V | pooled | 213 | 37.6 | −0.03 | −0.20 / **−0.37** / −0.72 | −0.52 to −0.22 | 0.51 | yes / yes (negative) |
| V | in-sample | 200 | 37.5 | −0.02 | −0.20 / −0.37 / −0.71 | −0.52 to −0.21 | 0.51 | yes / yes (negative) |
| V | out-of-sample | 13 | 38.5 | −0.10 | −0.29 / −0.47 / −0.83 | −0.99 to +0.12 | 0.39 | too small to read |
| P | 2026 | 25 | 40.0 | +0.05 | −0.13 / −0.31 / −0.67 | −0.74 to +0.13 | 0.56 | too small to read |
| V | 2026 | 45 | 35.6 | −0.03 | −0.18 / −0.33 / −0.62 | −0.62 to −0.02 | 0.51 | BH yes / Holm no (negative) |

- **The other splits are in `ore_outcomes.csv`:** year, Nifty level band and side.
- **Multiple comparisons:** 23 ORE cells had n ≥ 30. 18 survive BH and 17 survive Holm, and **every surviving
  cell is negative**. No positive cell survives, and none is highlighted.
- **Only the 5 bps sensitivity gets close to zero:** P in 2022 at +0.01, and the < 17k band at +0.02. Both are
  uncorrected, and at the primary cost the CIs are negative or straddle zero.

## 4. V − P (paired by session)

| Scope | Sessions | ORE fires per session, P → V | Δ fires (CI) | n P / V | Net R (10 bps), P → V | Δ net R (CI) |
|---|---|---|---|---|---|---|
| Pooled | 1,258 | 0.36 → 0.17 | −0.19 (−0.22 to −0.17) | 453 / 213 | −0.32 → −0.37 | −0.05 (−0.17 to +0.07) |
| In-sample | 1,198 | 0.37 → 0.17 | −0.20 (−0.23 to −0.17) | 439 / 200 | −0.31 → −0.37 | −0.05 (−0.18 to +0.07) |
| **Out-of-sample** | 60 | 0.23 → 0.22 | −0.02 (−0.05 to 0.00) | 14 / 13 | −0.53 → −0.47 | +0.06 (0.00 to +0.23), too small to read |

## 5. Reading (P is the reference; nothing here changes live)

- **Do the caps suit today's volatility?** In 2026 the fixed caps blocked ORE on most days (range_too_wide 1.83
  per session), and V scaled them up to about 144 / 96 points. That is what V was designed to test.
- **But V's extra 2026 fires didn't earn more.** It had 45 fires at −0.33R (CI −0.62 to −0.02); P had 25 at
  −0.31R, too small to read.
- **Over the whole history,** V's tighter caps in calmer years removed about half the fires without improving
  expectancy.
- **The out-of-sample segment** (60 sessions, about 14 fires each) can't separate the variants.
- **Whatever the caps, ORE's breakouts lose roughly the cost proxy on the index:** gross about 0, net about
  −0.3R at 10 bps. **The filter already rejects every one of them.**
- **On this evidence, neither variant gives a reason to change the live caps.** The binding question for Nifty
  alerts is the filter score, not the ORE caps.

## 6. Limits

- **Not tradable as options.** These are index moves plus a 10 bps proxy (5 and 20 bps sensitivity). Real
  option P&L differs through premium, delta, theta, IV and strike choice.
- **In-sample design.** The live limits were written on 2026-06-14, with this history available. Only 60
  sessions come after, and their samples are under 30.
- **OR20_REF is 69.82, as registered.** The exact window median is 69.825, so V is 1.00007 × P at the reference.
- **Candles vs ticks.** There are 4 synthetic ticks per bar, and none of the 09:00–09:15 pre-open ticks live
  receives.
- **One session (2021-12-20) has no 09:15 bar.** The 20 sessions after it use OR20 from 19 ranges.
- **The filter's score runs on replayed inputs.** All ORE fires being rejected is a replay result; live has had
  too few ORE fires to compare with.
- **Non-stationarity.** Nifty rose from about 15,800 to about 26,000, so the year and level-band splits matter
  more than the pooled numbers.
