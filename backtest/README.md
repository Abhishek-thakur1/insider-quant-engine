# Detector backtest harness

Replays historical NSE bars through the **real, unmodified detector classes** — including the
15 archived under `src/detectors/deprecated/` — and reports per-detector performance in
R-multiples, gated and ungated, as a self-contained HTML report.

Lives entirely under `backtest/`. Nothing here runs in production.

---

## Status

**The harness is complete and self-verified. It has not been run on market data.**

This machine has no `.env`, no Fyers access token, no Redis and no Docker, so no historical
data could be fetched. Everything is verified against generated bars instead:

| | |
|---|---|
| `npm test` | 53 cases pass — 45 unit + 8 end-to-end replay |
| `BACKTEST_MODE=true npx tsx backtest/demo.ts` | 40 synthetic sessions, 75,000 bars, 300,000 ticks, 953 raw signals, 14s |
| Real detectors firing | confirmed — Gap & Go, VWAP Defense, VWAP Crossover, Value Zone, Nifty Options Scalper, Smart Money Divergence, Morning Momentum, ORB, Equity Trap all produced signals |
| Real gating chain | confirmed — every signal carries a score, posterior, EV and regime from `runJaneStreetFilter` |
| `tsc --noEmit` | 0 errors |

### One thing the synthetic run already suggests

On generated data **0 of 953 signals passed the filter** (REGIME 557, below-threshold 273,
EV 123). Most of that is an artefact — a smooth generated series reads as one regime, which
suppresses every REVERSION detector by design. But two parts are worth watching on real data
because they do not depend on the series being realistic:

- **`Nifty VWAP Reclaim` (ACTIVE) lost 100% of its signals to the EV gate.** It places its stop
  deliberately tight — VWAP ∓ 8 index points — and the live EV gate subtracts a flat 2.0 points
  of slippage. The tighter the stop, the more that flat constant dominates expectancy. This is
  the §5.3 interaction in `AGENTS.md`, and it appears to disqualify one active detector outright.
- **`Gap_And_Go_V2` (ACTIVE) lost 100% to `below-threshold`** — score under 78. Consistent with
  the cold-start ceiling documented in `AGENTS.md` §6.8.

Confirm both against market data before acting on either.

**There are no performance numbers yet, and none are invented.** `backtest/output/sample-report.html`
is generated from a sine wave with a scripted breakout; it is banner-marked as such and exists
only to review the report format.

To produce real numbers:

```bash
# 1. get a token (the auth bridge writes it; point the harness at it)
export FYERS_TOKEN_PATH=/path/to/access_token.txt

# 2. create .env with real FYERS_APP_ID / FYERS_SECRET_ID

# 3. fetch — hours, resumable, safe to interrupt
npx tsx backtest/run.ts fetch

# 4. replay — expect a few hours for the full universe
BACKTEST_MODE=true npx tsx backtest/run.ts run

# smoke test first
BACKTEST_MODE=true npx tsx backtest/run.ts run --days 5
```

No credentials at all? The synthetic path needs none and exercises the whole pipeline:

```bash
BACKTEST_MODE=true npx tsx backtest/demo.ts
```

`BACKTEST_MODE=true` is asserted on every entry point. Without it the telegramWorker seam is
inert and detector signals would be **dispatched to Telegram** rather than collected.

Output: `backtest/output/results.json` and `backtest/output/backtest-report.html`.

---

## Gated vs ungated — why every detector has two performance blocks

`gated` counts only signals the filter passed: what would actually have traded.
`ungated` counts every signal the detector raised.

Computing only the gated block was the first design and it was wrong. When the filter suppresses
most of a detector's signals the gated block is empty, and the report can then say nothing at
all — not even whether the detector had an edge the filter discarded. The synthetic run above is
exactly that case: 0% gate pass rate, so a gated-only report would have been 24 blank cards.

Side by side, the gap between the two blocks is itself the finding, and the report has a
**"Possibly over-suppressed by the filter"** section that flags any detector with a positive
ungated edge on a real sample where under 20% of signals reached the gate. That is a
filter-calibration result, not a detector result, and it is invisible in the gated column alone.

## Isolation

The goal doc's hard constraint is that the backtest cannot touch live state or reimplement
detector logic. How each part is guaranteed:

| Concern | Guarantee |
|---|---|
| Live Redis | **Physically impossible to reach.** `core/memoryRedis.ts` replaces every Redis method on the shared client with an in-memory store. No socket is opened, so no DB index or env var can be misconfigured into hitting production. |
| Telegram | Two independent conditions must both hold to divert a signal (`BACKTEST_MODE=true` **and** an installed collector), and `run.ts` refuses to start without the flag. Nothing can be dispatched. |
| Detector logic | Never reimplemented. `registry.ts` imports the 26 real classes and constructs them; `sim/exit.ts` recovers SL/T1 with the live filter's own exported parser rather than a copy of its regexes. |
| Data | Plain files under `backtest/data/cache/`. Separate store, not a Redis namespace. |
| `main` | Untouched. Work is on `v2`. |

### The four seams into `src/`

Additive only, and the goal doc explicitly permits a minimal seam. Nothing changes behaviour
with the backtest switched off.

1. **`telegramWorker.ts`** — `backtestSink` plus an early return gated on `BACKTEST_MODE`.
   Required because detectors import `sendTelegramAlert` directly and an ESM const binding
   cannot be reassigned by an importer. Cost when off: one boolean read per alert.
2. **`janeStreetFilter.ts`** — `parseRiskRewardFromTrigger` gained `export`. No logic or
   configuration change. Sharing it is what stops the exit simulator drifting from the EV gate.
3. **`regimeDetector.ts`** — added `resetRegimeState()`. `inMemoryReturns` is module state with
   no reset; the live engine never needs one because the process restarts daily, but a backtest
   replays many sessions in one process and would otherwise carry 20 returns across day
   boundaries. Unused by live.
4. **The virtual clock** (`core/clock.ts`) patches `Date.now` and `Date` **globally at
   runtime**, not in any file. See below.

---

## The two mechanisms that make this work at all

### Virtual clock

Detectors read the wall clock directly, and it decides whether they can fire:

```ts
const getISTMinutes = () => { const d = new Date(Date.now() + 5.5*60*60*1000); … }
const isActiveWindow = () => m >= 9*60+15 && m <= 14*60+45
```

Replay a historical session at 03:00 IST and every window check returns false — the backtest
would report zero signals for every detector and look like it had finished. `core/clock.ts`
replaces the global time source for the duration of a run so `Date.now()` returns the
simulated instant.

It also fixes VWAP day keys: `vwapUtils` derives `vwap:{symbol}:{YYYY-MM-DD}` from `Date.now()`,
so without virtualization all 180 replayed days would accumulate into one key.

### Virtual-time TTLs

Cooldowns are `setEx(key, 1800, …)`. A session replays in seconds of wall time, so real Redis
TTLs would not have expired by the end of a run and **every detector would fire at most once
per backtest**. `memoryRedis` expires against the virtual clock, so 30 minutes means 30
simulated minutes.

---

## Correctness properties

- **No look-ahead.** All symbols are merged into one globally chronological stream and
  `assertChronological` throws on any inversion. The Nifty VWAP advances *after* a minute's
  ticks are dispatched, never before, so during minute N a detector reads a reference built
  from minutes 1..N−1. Exit simulation only ever sees bars strictly after the entry timestamp.
- **Fresh state per session**, mirroring live (which boots at 09:15 and is stopped at 15:30):
  new detector instances, flushed Redis, and every module singleton reset — candle buffers,
  BOS streaks, option store, regime returns. A test asserts two identical sessions produce
  identical output, which is what catches a state leak.
- **Gating at signal time.** `runJaneStreetFilter` is invoked immediately after the detector
  returns, before the clock advances, so the regime, bias, VWAP and candle buffers it scores
  against are the ones that existed when the signal fired.
- **Attribution by execution context.** Archived detectors do not set `detectorName`, so the
  payload cannot identify them. The engine records which detector it is awaiting and the sink
  reads that; dispatch is sequential rather than `Promise.all` precisely so this cannot be
  scrambled by interleaved continuations.

---

## Assumptions

All in `config.ts`, all printed in the report.

| Assumption | Value | Why |
|---|---|---|
| Slippage | 5 bps, both legs | Non-zero and relative, so it scales across a ₹50 stock and a 25,000 index — unlike the live filter's flat 2.0 points. |
| Ticks per bar | 4 (O, H, L, C) | The minimum that preserves OHLC exactly. The source has no intra-minute detail, so more ticks would add cost, not information. |
| Intra-bar path | bullish O→L→H→C, bearish O→H→L→C | An OHLC bar does not say which extreme came first. Price is assumed to probe against the eventual direction. |
| Stop-vs-target in one bar | **stop wins** | Same ambiguity. Assuming the target would flatter every result. |
| Default exit | 0.5% stop, 1.5R target | Only for detectors that embed no `SL ₹x \| T1 ₹y`. Labelled `harness-default` per detector in the report. |
| Forced square-off | 15:15 IST | MIS intraday positions are closed by the broker. |
| Circuit lock | zero-range bar with volume | Inferred, not data — see below. A stop inside such a bar is **not filled**; the exit defers to the next tradable bar. |
| Sample threshold | **30 gated trades** | Enough to earn a headline number, not enough to estimate a tail mean — see the note below. Anything under is reported but flagged, and can never outrank a sufficient-sample detector. |
| Win concentration | flagged above **50%** | Share of gross winnings from the single best trade. Exposes a tail-driven expectancy that trade count alone hides. |

---

### Why 30 trades is a floor, not a sufficiency test

The 30-trade threshold was originally justified for a 45–55% win rate, where the 95% CI on a
win-rate estimate is roughly ±18pp at n=30. That reasoning does not transfer to the strategy
profile this engine is aimed at: `docs/qullamaggie-spec-v2.md` cites a **25–30% win rate carried
by winners running 10–20x initial risk**.

At a 27% win rate, 30 trades is about **eight winners**. Expectancy is then the mean of a handful
of tail observations, and 30 trades only establishes that a detector fired often enough to look
at. Raising the threshold without data would be guesswork, so instead every detector reports
**win concentration** — the share of gross winnings from its best trade and its best three — and
the report flags any detector where one trade supplied more than half the gains.

A high concentration is **not** a defect for a momentum strategy; it is the expected shape. It
does mean the expectancy is directional rather than a rate, however many trades there were.

## Known fidelity gaps

Stated rather than papered over. Each materially limits what the numbers can say.

1. **No historical option chain.** Fyers `getHistory` returns no per-strike premium or OI.
   Consequences: `getBestStrike()` always falls back to ATM with premium 0; the Bayesian
   OI-wall evidence is permanently neutral; and for option-routed detectors **R is measured on
   the underlying index move, not on option premium** — real P&L would differ through delta and
   theta. Two detectors are excluded entirely for this reason (below).

2. **No circuit-band data.** The band is not in `getHistory`, so a lock is inferred from bar
   shape. NSE bhavcopy carries the real bands and would replace the proxy.

3. **Synthetic ticks distort tick-count detectors.** `vcpDetector` measures its box in *20
   ticks* and its baseline in *100 ticks*. Live, 100 ticks may be seconds; here it is 25
   simulated minutes. Its results are not comparable to live behaviour and are flagged in the
   report.

4. **`HTF_TREND:*` is never written.** `VolatilityContraction`'s daily-trend gate fails open in
   backtest exactly as it does live, so that filter is effectively off in both.

5. **Bars are not clock-aligned in most detectors.** Each starts its candle at the first tick it
   sees, so a restart re-phases every candle. The harness reproduces this rather than
   correcting it.

### Not backtestable (2 of 26)

- **`DeltaHedgingPressureDetector`** — its entire signal is per-strike premium velocity plus OI
  growth, fed from the option tick stream. Neither input exists historically at any granularity.
- **`OiLiquiditySweepDetector`** — arms only when spot pierces the max-OI wall from
  `getWallStrikes()`, which is always null without a historical chain, so its state machine can
  never leave `WAITING`.

Both are currently **ACTIVE** in production. The backtest can say nothing about either.

---

## A live bug this work found

`websocket.ts:223` classifies a tick as an option with a bare substring test:

```ts
if (rawTick.symbol.includes('CE') || rawTick.symbol.includes('PE'))
```

Five watchlist equities contain those letters inside the company name and are therefore routed
into the option branch:

```
NSE:RELIANCE-EQ   NSE:ULTRACEMCO-EQ   NSE:CEATLTD-EQ   NSE:BAJFINANCE-EQ   NSE:KAJARIACER-EQ
```

For those five, in production right now: `updateVwap` is never called, `feedTick` is never
called, `strategyRouter` is never consulted — **all three equity detectors never run** — and
`isIndexOrOption` at line 290 is also true, so their zero-volume ticks are not filtered and
tick volume falls back to 1. The same substring test also appears in `janeStreetFilter`
(structure symbol), `bayesianEngine` (volume bypass, DTE evidence) and `telegramWorker`
(message template).

**Fixing it is out of scope here** — the guardrails forbid modifying `websocket.ts`. The replay
reproduces the misrouting so the report describes the engine that actually runs, lists the
excluded symbols prominently, and notes that fixing the routing would change every equity
detector's numbers. `core/symbolClass.ts` holds both the faithful and the correct test, with a
test pinning the five affected symbols.

---

## Layout

```
backtest/
  config.ts             every assumption, one place
  registry.ts           all 26 detector classes + tier + caveats + constructors
  run.ts                CLI: fetch | run | report | cache
  demo.ts               synthetic report generator
  core/
    bootEnv.ts          placeholder credentials (must be imported first)
    clock.ts            virtual clock
    memoryRedis.ts      in-memory Redis substitute, virtual-time TTLs
    symbolClass.ts      faithful vs correct option classification
  data/
    fyersClient.ts      rate-limited, chunked, resumable fetcher
    store.ts            on-disk candle cache
  replay/
    barToTicks.ts       bar→tick synthesis, chronological merge + assertion
    engine.ts           session replay, routing, gating at signal time
  sim/
    exit.ts             outcome simulation
    metrics.ts          R metrics + sample-size discipline
  report/html.ts        self-contained HTML report
  fixtures/synthetic.ts deterministic generated sessions
  output/               results.json, backtest-report.html, sample-report.html
```

Tests live in `tests/backtestUnits.test.ts` and `tests/backtestReplay.test.ts` (`npm test`).
