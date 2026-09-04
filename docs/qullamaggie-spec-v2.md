<!--
  Stored verbatim as supplied on 2026-09-04. Do not paraphrase or "tidy" the
  body below — it is the authority for this strategy suite, and the repo's own
  notes are kept above the line so the two never get confused.
-->

# Status in this repository

> **NOT BUILT.** No detector in this suite exists yet. `BreakoutDetector`,
> `EpisodicPivotDetector` and `ParabolicShortReversalDetector` are unwritten. This file is the
> specification a builder should work from; it is not a description of anything running.

Approval state: the v2 architecture goal doc gated the build ("Section 3") behind the Section 0
root-cause findings. Those findings were reported and the fixes landed (`AGENTS.md` §11.2), but
the go-ahead to start Section 2 (universe scaling) or Section 3 (this suite) has not been given,
and the sequencing question — this suite versus running the backtest first — is still open
(`AGENTS.md` §11.4).

## What this revision corrects

This supersedes Appendix A of the v2 architecture goal doc. The deltas that change
implementation, not just wording:

| Area | Earlier spec | This revision |
|---|---|---|
| Risk per trade | 0.5–1% | **0.25–1%** |
| Position size | treated as a cap | **10–20% of equity is the normal case** |
| Screening cadence | implied continuous | **weekly**, not every day — changes the EOD job's schedule |
| S1 consolidation | "tight, contracting range 10–40 days" | orderly pullback with **higher lows** and a tightening range; flat channels, symmetrical or descending triangles |
| S1 stop | "at ADR or below the breakout candle's low" | **low of the day**, capped at the stock's ADR |
| S1 entry | "breakout above consolidation resistance" | **opening-range high** of the first 1-min, 5-min or 60-min candle (on NSE the first 60-min candle is only 30 minutes, 09:15–09:45) |
| S1 exit | not specified | scale out 1/3–1/2 after 3–5 days, stop to breakeven, trail the rest on the 10-day EMA (default) or 20-day, exiting on the first **daily close** below — not an intraday touch |
| S2 volume | "> 30-day average daily volume" | pre-market, or first 15–30 min, **on the order of the entire average daily volume** — a much higher bar |
| S2 screening | not present | **new filter: the stock must NOT already have rallied over the prior 3–6 months.** A gap into an existing multi-month move is a weaker EP. |
| S3 trigger | VWAP-rejection only | **two valid triggers** — the first red 5-minute candle if it runs straight up from the open, *or* the VWAP-rejection after cracking the morning low |
| S3 stop | "above VWAP or the high of the day" | high of the day, or a VWAP reclaim for the rejection trigger specifically |
| S3 target | not present | **the 10-day or 20-day EMA** — the natural cover zone |
| S3 over-extension | 50%+ / 100%+ | 50–100%+ for larger caps, **300–1000%+ for smaller** — and our ₹1,000–15,000 cr band sits at the smaller end, so expect the higher figures |

Intentional departures from the source, kept for NSE microstructure reasons: the **10% overnight
concentration cap** (source says 30%) because a locked lower-circuit gap-down cannot be exited the
way a US stock can, and the circuit-band / overnight-shorting constraints throughout.

## What the repo already satisfies

The "Performance framing" section below endorses reporting **expectancy in R-multiples** rather
than leading with win rate. The backtest harness already does exactly that: it ranks on gated
expectancy in R, and `rankByExpectancy` will not let a low-sample detector outrank a
high-sample one (`backtest/sim/metrics.ts`).

## What it forced a correction to

The spec's own performance framing — a **25–30% win rate** carried by winners running 10–20x
initial risk — invalidated the stated rationale for the harness's 30-trade sample threshold,
which had been derived assuming a 45–55% win rate. At a 27% win rate, 30 trades is roughly eight
winners, so expectancy becomes a mean of a handful of tail observations and 30 trades is only
enough to say "this fired often enough to look at".

Rather than raise the threshold on no data, every detector now reports **win concentration** —
the share of gross winnings from its single best trade and its best three — and the report flags
any detector where one trade supplied more than half the gains. Trade count alone does not reveal
that. See `backtest/config.ts` (`METRICS`) and `backtest/sim/metrics.ts`.

## Blockers a builder will hit immediately

From the earlier feasibility review; none are resolved:

- **Market cap, free float and promoter holding** — no source in the repo, and Fyers does not
  serve fundamentals. The spec already defers free float for v1; market cap is load-bearing for
  the universe band and has no source either.
- **30-day turnover, 20-day ADR%, 1M/3M relative strength** — need a **daily** candle store. The
  live seeder only ever requests `resolution: '1'` for the current day. The backtest harness's
  `backtest/data/` fetcher does daily and is reusable.
- **Nifty Smallcap 250 / Midcap 150** — the only index symbol anywhere in the repo is
  `NSE:NIFTY50-INDEX`.
- **Order-book depth** for the circuit-lock gate (which this spec calls critical) — the engine
  has no bid/ask data at all; `orderFlowProxy.ts` says so in its header. Needs a new depth-socket
  ingestion path, and Fyers caps that at 3 connections × 5 symbols = **15 symbols at once**.
- **Circuit bands** — not in `getHistory`. The backtest currently infers a lock from bar shape.
- **Account equity and open positions** for the risk caps — no broker account integration exists.
- **Multi-day state** — the engine is a stateless intraday process that wipes Redis on boot, so
  the scale-out, breakeven-stop and EMA-trailing rules in S1/S2 have nowhere to live. The spec's
  v1 intraday-only scope acknowledges this; note that it removes most of S1's exit logic.

---

# Spec (as supplied, verbatim)

# Qullamaggie Momentum Strategies — NSE-Adapted Spec (v2, source-verified)

## Note on this revision

This supersedes the earlier Qullamaggie spec (Appendix A of the v2 architecture goal doc). It's been checked directly against Kristjan Qullamaggie's own primary-source writeup ("3 Timeless Setups That Have Made Me Tens of Millions") and corrected in a few places where the earlier version simplified or missed a detail. NSE-specific adaptations (circuit bands, overnight shorting restrictions, the 10% overnight concentration cap vs. the source's 30%) are intentional departures from the source, made for Indian-market microstructure reasons documented inline — not errors.

---

## Position Sizing & Risk Baseline

- **Risk per trade:** 0.25% to 1% of account equity (source range — widen from any earlier 0.5-1% framing).
- **Typical position size:** 10-20% of account equity per position (this is the normal case, not just a ceiling).
- **Overnight concentration cap:** max 10% of equity in a single cash-market equity held overnight — **this is an intentional NSE-specific tightening** of the source's 30% ceiling, made because a locked lower-circuit gap-down on NSE cannot be exited the way a US stock can; see the Universe & Risk section below.
- **Portfolio heat cap:** total open risk across concurrent positions ≤ 6% of equity.

## Universe Screening (NSE Microstructure Adapted)

**Concept:** target volatile, high-growth names (₹1,000 cr – ₹15,000 cr market cap) with enough daily range to justify the risk, while avoiding untradable illiquidity.

- **Market Cap:** ₹1,000 cr – ₹15,000 cr.
- **Average Daily Turnover (30-day):** > ₹15 crore.
- **Average Daily Range (ADR%):** > 4.5% over 20 days.
- **Free Float:** promoter/insider holding < 65%. *(Deferred for v1 — no data source in repo yet.)*
- **Relative Strength:** outperforming the market-cap-appropriate benchmark over 1-month and 3-month rolling windows — Nifty Smallcap 250 for the ₹1,000–5,000 cr bucket, Nifty Midcap 150 for the ₹5,000–15,000 cr bucket (use only the matching benchmark per name).
- **Scan cadence:** source runs this scan **weekly**, not continuously — worth matching that cadence for the EOD screening job rather than re-screening every single day.

**Event Blackout Rule:** no fresh breakout, EP, or short-reversal entries within:
- 3 trading days prior to scheduled earnings or major corporate actions.
- RBI monetary policy days and Union Budget day.
- F&O expiry day, for any name in the derivatives segment (CAS-window 3:15–3:40 PM pricing distortion).

---

## Strategy 1: The Breakout (High-Tight Flag)

**Setup (EOD/Redis historical data):**
- Trend: price "surfing" the rising 10-day and 20-day EMA (and sometimes the 50-day) during consolidation.
- Momentum: a big move of 30-100%+ sometime in the past 1-3 months, typically lasting a few days to a few weeks.
- Consolidation: an orderly pullback with **higher lows and a tightening range**, lasting 2 weeks to 2 months (≈10-40 trading days). Recognizable as flat channels, symmetrical triangles, or descending triangles.

**Execution (Fyers intraday WebSockets):**
- Pre-trade gate: confirm no circuit lock, two-sided liquidity present.
- Entry: opening range high breakout — the high of the first 1-min, 5-min, or 60-min candle (60-min's first candle is only 30 minutes, 9:15-9:45 in NSE hours). Can also be read directly off the daily chart without an intraday chart at all.
- **Stop: low of the day** — not specifically "the breakout candle's low." Must not be wider than the stock's ADR (e.g. ADR 5% → stop no wider than 5%).
- Scale out: sell 1/3 to 1/2 of the position after 3-5 days, move stop to breakeven on the remainder.
- Trail the remainder on the 10-day EMA (recommended default/beginner setting) or the 20-day EMA (for slower-moving names or once experienced) — exit on the first **daily close** below it, not an intraday touch.

---

## Strategy 2: Episodic Pivots (News-Driven Gap Ups)

**Setup:**
- Gap threshold: > 10% up from prior close.
- Volume: pre-market volume, or — if not there pre-market — volume in the first 15-30 minutes after open that's on the order of the stock's **entire average daily volume**. This is a high bar, not just "elevated volume."
- Context (earnings-driven EPs specifically): big, ideally mid/high-to-triple-digit EPS and revenue growth with a significant beat to expectations.
- **Screening qualifier we previously missed:** it's best if the stock has **not** already rallied over the prior 3-6 months. A gap on a name that already made a big multi-month move into the gap is less of a genuine surprise to the market and a weaker EP candidate — this should be an explicit universe/setup filter, not just a note.

**Execution:**
- Pre-trade gate (critical, NSE-specific): check live order book depth via Fyers API before attempting entry. A >10% gap frequently means the stock has opened locked at upper circuit with no sell-side liquidity — if locked with zero/negligible offer-side depth, do not attempt entry; log as "gapped, untradable"; keep monitoring for unlock.
- Entry: Opening Range High breakout (1-min, 5-min, or 60-min candle), contingent on the liquidity gate above. Stop is the low of the day.
- Trail with the 10- or 20-day EMA once the position surpasses the initial stop.
- BTST transition (multi-day hold): **deferred for v1** per the current intraday-only scope — this requires durable multi-day state not yet built.

---

## Strategy 3: Parabolic Short Reversals

**Setup:**
- Over-extension: up 50-100%+ in a few days/weeks for larger caps, or 300-1000%+ for smaller caps (source's own upper-end framing — our NSE market-cap band of ₹1,000-15,000cr sits toward the smaller end of this, so expect the larger over-extension percentages to be more representative in practice).
- The stock should be up 3-5+ consecutive days. Some trend for weeks/months before accelerating; others "explode from nowhere."
- On NSE, this move will typically consist of multiple circuit-banded up days rather than continuous price discovery — factor banded gains into the surge calculation.

**Execution (VWAP, intraday):**
- Segment requirement: F&O underlying only. Cash-market equity cannot be shorted overnight on NSE.
- **Two valid triggers** (previously we only specified the second):
  1. If the stock runs straight up from the open with no pullback, you can short the **first red 5-minute candle**.
  2. Otherwise, wait for the stock to crack the morning low, bounce back toward intraday VWAP, and fail to reclaim it (rejection) — enter on that failure.
- Stop: high of the day, or — for the VWAP-rejection trigger specifically — a reclaim of VWAP.
- **Target zone (previously missing from our spec): the 10-day or 20-day EMA** — this is where these stocks typically find support and bounce, i.e. the natural cover zone for the short.
- Mandatory square-off: intraday cash-market shorts auto-square-off by 3:15 PM IST. Only F&O positions may be carried past this, as STBT via derivatives — deferred for v1.
- Reward profile is smaller than the other two setups — source cites roughly 5-10x risk/reward here vs. 10-20x+ (sometimes 30-50x+) on Breakout/EP — but with a correspondingly higher win rate if you wait for the correct setup rather than shorting early.

---

## Performance framing (for the backtest report)

Qullamaggie's own framing: it's possible to be highly profitable with a **25-30% win rate**, because losses are kept small (tight, ADR-bound stops) while winners can run 10-20x+ initial risk. This directly supports the backtest harness's design choice to report **expectancy in R-multiples** as the primary metric rather than leading with win rate alone — a detector with a lower win rate but larger average winner can still be the better strategy, and the report should make that visible rather than ranking purely on win-rate percentage.

The 10-20x (and occasional 30-50x) reward multiples cited in the source come from an elite trader operating on unrestricted US price action with no circuit bands — treat these as an optimistic ceiling worth being aware of, not a baseline expectation, when reviewing NSE backtest results.

---

## V1 scope reminder

Per the current approved scope: build these as **intraday-only** strategies for v1 (same-day entry/exit, no BTST hold, no multi-day EMA trailing stop) so they fit the existing stateless intraday runtime. The multi-day swing extension (durable state, second runtime) remains a separate, not-yet-approved decision.
