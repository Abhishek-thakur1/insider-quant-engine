# Pre-registration and call plan: 6-month backtest of the live rules (design only)

- **Owner request:** 2026-11-10.
- **Status:** **DESIGN ONLY.** Nothing has been fetched or run.
  - No Fyers call is made until the owner approves the call plan in section 5.
  - No NSE file is downloaded until the owner approves step 0.
- **Committed before any run.** After a run starts, this file changes only by dated amendments that say why,
  and never on the basis of any result.

## 1. What the Fyers history API allows (official docs, "Last updated on October 14, 2026")

Sources:
- `fyers.in/api-docs/v3/api/market-data/historical-data/`
- `fyers.in/api-docs/v3/getting-started/plans-and-limits/`

| Item | Docs say | Consequence here |
|---|---|---|
| Resolutions | 5S–45S; 1, 2, 3, 5, 10, 15, 20, 30, 60, 120, 240 min; 1D, 1W, 1M | Use **1-minute**: the live Nifty VWAP Reclaim uses 3-min candles and the others use 5-min. |
| Span per request | "Up to 100 days" for minute resolutions; 366 days for 1D | 6 months (183 calendar days) is **2 requests per symbol** at most. |
| How far back (**Standard plan**, ours) | Intraday "last 1 year (from 2025)"; daily "last 5 years"; seconds not available | 11 May – 9 Nov 2026 is inside the window. Our cache already holds 1-min bars from 2021, fetched earlier. |
| Corporate-action adjustment | **Not stated** | Verified empirically in step 2 (5 requests); see the limits. |
| Candle | `[epoch, open, high, low, close, volume]`; use a `range_to` of the previous minute for complete candles | As in `backtest/data/fyersClient.ts`. |
| `cont_flag`, `oi_flag` | Continuous data for futures/options; OI in the candle | Not used: equities and the index only. |
| Rate limits (Data APIs, Standard) | 5/s, 50/min, 5,000/day; HTTP 429 / -429 on a breach; "more than 3 times in a day" over the per-minute limit blocks the user for the rest of the day | We use the owner's limits of **4/s and 40/min** (`config/fyers_quota.json`). The quota gate stops after 2 breaches. |
| Volume per day | "Unlimited number of stocks history data can be downloaded in a day" (within the request limits) | The request count is the constraint, not the symbol count. |

## 2. The window

- **Sessions:** 126 NSE sessions, **11 May – 9 Nov 2026** (weekdays minus the 5 holidays in
  `scheduler/nse_holidays.txt`: 28 May, 26 Jun, 14 Sep, 2 Oct, 20 Oct).
- **Rule set:** the deployed one, as of image `deployed-18e4852`, applied unchanged to every day. This is a
  "what if today's rules had run" test, so the live series breaks don't apply inside it.

## 3. Rules replayed, exactly as live (no parameter tuning)

All values are as deployed. Nothing is fitted, searched or tuned.

**Detectors** (the live stack in `src/ingestion/websocket.ts`):
- Equities (`buildEquityStack`): `StockMomentumBreakoutDetector`, `VolatilityContraction` (V2).
- Nifty (`NIFTY_STACK`): Opening Range Explosion, Trend Pulse, VWAP Reclaim, OI Liquidity Sweep, Delta Hedging
  Pressure. The last two can't fire on candles; see section 6.
- The EMA shadow is excluded: it is shadow-only and never alerts.

**Filter:** `runJaneStreetFilter` unchanged.
- `CONFIRMATION_THRESHOLD=78`, `SHADOW_MODE=true` (score-rejected fires are recorded, not alerted).
- The EV gate's own 5 bps slippage, the regime from the Nifty 1-min returns, and the Nifty bias.

**Alert pipeline:** `runAlertPipeline` unchanged, with in-memory stores.
- **Levels:** `computeTradeLevels`. Equity stop = VWAP × 0.998 (LONG) / × 1.002 (SHORT); T1 = entry ± 1.5 × risk.
- **Geometry guard.**
- **Capital sizing:** `PAPER_CAPITAL_BASE` 100,000, behaviour `REDUCE` (the defaults; `.env` sets neither).
  Capital is shared across all open positions in the session, as live.
- **Duplicate and one-per-symbol-side rules;** the daily alert cap of 20.
- **EV shadow:** on (`EV_SHADOW_ENABLED=true`).

**Exits** (`positionTracker` logic):
- Stop and target are evaluated on the synthesised ticks.
- **15:15 timer square-off** at the last price (#45, `SQUARE_OFF_TIMER` on).
- **Same-bar rule:** if a stop and a target both fall inside one 1-min candle, **the stop is taken first**.
- Circuit-lock bars (zero range with volume) don't fill a stop; it moves to the next tradable bar.

**VWAP:** the live `updateVwap`, with the 09:15 session gate (#40) and the last-trade-time gate (#68), fed from
the synthesised ticks.

**Cost model:**
- Gross R as live (no slippage inside R).
- Net R = gross − c × entry / |entry − stop|, for **c = 8, 12 and 20.4 bps** round trip.
- **20.4 bps is primary;** 8 and 12 are the sensitivity runs.

## 4. Point-in-time universe

**Step 0 (needs approval; NSE, not Fyers):** download the NSE UDiFF bhavcopy for each as-of day.
- **Source:** the URL in `PREREGISTRATION_dw3.md`, `nsearchives.nseindia.com`.
- **Count:** 126 as-of days (8 May – 6 Nov). 4 are already held (3–6 Nov), so **122 downloads**, about
  200 KB each (≈ 25 MB in total), at 1 per 2 s.

**Rebuild each session's list as dw-3 would have, from the previous session's file:**
- dw-3 rules and amendments 1, 1a and 1b, unchanged: floors ₹50 and ₹50 crore turnover; score
  0.4 / 0.3 / 0.3; 22 score picks plus 5 turnover picks.
- **Fyers check:** against the **28 Apr `fyersUniverse.json`** (`ac7e962`). That's the file the live check
  used, and it predates the window. The refreshed file must not be used, because it would be look-ahead.
- **Engine:** `scripts/daily_watchlist_bhav.ts` with `BHAVCOPY_FILE`, run offline on the PC, one as-of day at
  a time, written to the data folder (section 5), never to the server.

**Populations:**
- **R (rotating 27, point-in-time):** hindsight-free. **This is the primary population.**
- **C (core 52):** the owner's list as of 3 Nov, applied to all 126 days. **Reported separately and flagged
  for hindsight**: it was picked in late October, after most of the window.
- **R+C together** is replayed in one engine (as live), so capital sharing and duplicate rules interact as they
  would live. Results are reported per population.

**How many symbols that needs:**

| | Symbols | Basis |
|---|---|---|
| Core 52 | 52 | fixed list; 29 are already in the local 1-min cache (to 7 Sep) |
| Nifty 50 index | 1 | in the cache to 7 Sep |
| Rotating, union over 126 days | **≈ 500–900 (estimate)** | Measured on the 5 lists we have (4–11 Nov): 27 names on day 1, then 21, 22, 17 and 19 *new* names a day; 106 unique in 5 days. Rotation will slow as names repeat, but the exact union is only known once step 0's files exist. The pool is bounded by names with turnover of ₹50 crore or more on some day (328–421 per day). |

**The exact count is the first output of step 0.** It replaces this estimate before any Fyers request is sent.

## 5. Call plan (needs the owner's approval before any request)

**Where it runs:**
- On the owner's PC, not the server.
- **Data folder:** `C:\trade-data\backtest-6m\`. N: has only 4.7 GB free (91%); C: has 33 GB.

**What it holds:**

| File | Contents |
|---|---|
| `bhav\<asOf>.csv.zip` | the NSE files |
| `lists\<session>.json` | the rebuilt lists |
| `cache\res-1\NSE_<SYM>.json` | the candles, in the harness store format |
| `manifest.json` | the exact request list, made before any call |
| `quota-ledger.json` | the PC ledger for the shared Fyers quota |
| `fetch.log` | the fetch log |

- **The existing `backtest\data\cache` stays untouched.** It is read only, to skip already-covered ranges.

**Requests** (1-minute resolution, windows of 100 days or less, only the dates a symbol needs):

| Item | Requests |
|---|---|
| Nifty index: 8 Sep – 9 Nov top-up (11 May – 7 Sep is cached) | 1 |
| Core, the 29 already cached: 8 Sep – 9 Nov top-up | 29 |
| Core, the 23 not cached: the full window, 2 windows each | 46 |
| Rotating: for each symbol, the span from its first to its last listed day, cut into windows of 100 days or less. Cached ranges are skipped. | ≈ 1.0–1.6 per symbol, so **≈ 600–1,300** |
| Corporate-action check: 1D bars for the 5 largest split or bonus ex-dates in the window (found from bhavcopy previous-close breaks) | 5 |
| **Total (estimate)** | **≈ 680–1,380** |

**The fetch is staged:**
- **Stage A, parity first:** 1 request per symbol on the 5 live lists for 4–9 Nov.
  - That's 52 core + 106 rotating + Nifty = **159 requests**, about 4 minutes.
  - The parity gate (section 6, item 5) runs on that data only.
- **Stage B:** the rest of the manifest, **only if parity passes.**
  - Stage A's symbols then need windows ending 3 Nov, so the split adds little (≈ +0–60 requests).
- **Overall estimate:** ≈ 840–1,440.

**Hard caps:**
- **Per evening: 1,400 requests.** This stays under the `backtest` allocation of 1,500 a day and leaves the
  server's seeder (300) well clear of 5,000.
- **For the whole fetch: 2,800 requests, over 2 evenings at most.**
- **The manifest is fixed before the first call.** The fetcher refuses any request not in it, and stops at the
  cap even if items remain.

**Rate:**
- 4/s and 40/min, enforced by the existing quota gate (`src/fyers/quota.ts`, `config/fyers_quota.json`).
- At 40/min, 1,400 requests take about **35 minutes**.

**Stop conditions:**
- Stop at once on HTTP 429 / -429, Cloudflare 1015 or an auth error, after the gate's 65 s cool-down allows
  at most 2 breaches (Fyers blocks at more than 3).
- Stop on a second failure of the same request.
- Everything already fetched is kept, and the next evening resumes from the manifest.

**Timing:**
- A weekday evening **16:15–17:00 IST**, after the 15:45 summary and the 16:00 backup, while the engine is
  stopped and nothing on the server uses Fyers. The 19:00 list job uses NSE only.
- Not 11–13 Nov, which are already booked for the refresh, dw-4 and #57.
- **Proposed: Mon 16 Nov, plus Tue 17 Nov if needed.**

**Token (decision needed):** the PC has no Fyers token.
- **Proposal:** the owner logs in as usual that morning. At 16:10 the token file is copied from the server
  to `C:\trade-data\backtest-6m\token\` over SSH; it is never printed or logged, and is deleted when the
  fetch ends.
- The server's 17:15 purge deletes the server copy only.

**Pre-flight (no Fyers):**
- step 0, then the list rebuild and the manifest;
- the request count and the disk estimate (about 3.3 MB of 1-min JSON per symbol per 6 months, so ≈ 2–3 GB);
- **the owner approves the exact number.**

## 6. Engineering gaps

### Must be built before a faithful run

All backtest-side. Each needs its own approval and a PR; none touches anything live.

1. **Live alert pipeline in the harness.** `backtest/replay/engine.ts` calls `runJaneStreetFilter` and then
   its own `sim/exit.ts`, which uses the trigger's `SL/T1`, a 5 bps slippage and its own 15:15 exit. It doesn't
   run:
   - `computeTradeLevels` (live stop = VWAP ± 0.2%, not the trigger SL);
   - the geometry guard;
   - capital sizing;
   - the duplicate and one-per-symbol-side claims;
   - the alert cap;
   - EV shadow.

   The plan is to call `runAlertPipeline` with in-memory stores.
2. **Live exit logic.** Replace the harness exit with the `positionTracker` rules: tick-driven stop and target,
   the 15:15 timer at the last price, stop-first within a bar, and no slippage inside R. Costs are applied
   afterwards at 8, 12 and 20.4 bps.
3. **A point-in-time universe driver.** The harness takes one fixed symbol list; it needs one per session from
   `lists\<session>.json`.
4. **The fetch pieces:** a `DATA_DIR` override (to write under `C:\trade-data\…`), date-window requests per
   symbol, and the manifest cap.
5. **A parity gate before any result is read:** replay the live sessions 4–9 Nov (79-stock lists) and compare
   with the `signals` table.
   - What's compared: fire count, symbol, side, detector, minute (±1), score (±3) and alert decision.
   - **Pass bar:** at least 80% of live fires matched, and no systematic score offset. If parity fails, the
     backtest is reported as not faithful and no performance number is published.

### Detectors that can't be run faithfully on candles

| Detector | Status on 1-min candles | Why |
|---|---|---|
| **OI Liquidity Sweep** | **Cannot run** | Needs the max-OI wall from a live option chain. There's no history, so it never leaves `WAITING`. Live it also has no option feed (`options 0` in the subscription plan), so it doesn't fire live either. |
| **Delta Hedging Pressure** | **Cannot run** | Needs per-strike premium velocity and OI growth from option ticks. Same as above, live included. |
| Nifty ORE, Trend Pulse, VWAP Reclaim | **Signals: faithful-ish; outcomes: not** | Their candles (5-min, 3-min) rebuild exactly from 1-min bars. But live routes them to an option symbol priced at index level (`index_option_proxy`), and expired-option premiums aren't available. R is reported on the index move only, labelled "index proxy, not tradable". |
| Stock Momentum Breakout | **Approximate** | It builds 5-min candles (exact from 1-min), but the comment says it can fire early on tick-level volume. With 4 synthetic ticks per bar, the intra-bar path and volume split are assumed, so entry timing and price can differ. |
| VolatilityContraction V2 | **Mostly faithful** | 5-min candles and a 7-candle history, rebuilt exactly. The intra-bar path is assumed. The daily-trend gate fails open live and here (`HTF_TREND` is never written), so it matches. |
| Equity VWAP (drives every equity stop) | **Approximate** | Live VWAP is from real ticks with the #68 auction gate. Here it's from 4 ticks per bar. Whether Fyers' 09:15 1-min bar includes the pre-open auction volume isn't documented. The parity gate measures the stop difference against the live 4–9 Nov VWAP snapshots in evidence. |
| Filter regime, bias, Bayesian | **Faithful** | The Nifty 1-min returns rebuild exactly. Option-wall evidence is neutral live too, since no option feed is subscribed. |

## 7. Statistics (same method as the alert report card)

- **Unit:** one paper trade.
- **Groups:**
  - **alerts:** passed, sent, not capital-skipped;
  - **ungated:** score-rejected;
  - **EV-shadow;**
  - **passed, not alerted:** counted.
- **Capital-skipped rows** are kept out of the rates and counted.
- **Per row:**
  - n, and the win, loss and break-even rates (±0.05R);
  - the average win and loss;
  - net and gross expectancy;
  - profit factor and total R.
- **Confidence intervals:** 95% day-block bootstrap (B = 10,000, seed 20261110).
- **Rows with n < 30 are "too small to read".**
- **Splits:** detector, side, exit type, hour, score band, population (R, C), month, and the cost level
  (8 / 12 / 20.4).
- **Multiple comparisons:** Benjamini-Hochberg (q = 0.05) and Holm (α = 0.05) over all split cells with
  n ≥ 30.
  - **Exit-type cells are left out of the family,** because they condition on the outcome. This is fixed now,
    unlike in the report card.
  - Uncorrected best cells are not highlighted.
- **Primary endpoint:** net expectancy of **alerts in population R at 20.4 bps**, over all 126 sessions.
  - **Yes:** its CI lies above 0.
  - **No:** its CI lies below 0.
  - **Can't tell:** anything else.
  - The 8 and 12 bps runs are sensitivity only. They can't change the verdict.
- **Gated vs ungated:** difference with a joint day-block CI; stated as associational.

## 8. Limits (stated before any run)

- **Candles vs ticks:**
  - 4 synthetic ticks per 1-min bar (bullish O→L→H→C, bearish O→H→L→C);
  - stop-first in ambiguous bars;
  - tick-volume triggers approximated;
  - entry at the synthetic tick, so there's no queue, spread or partial fill.
  - These bias results downward on exits, but not necessarily on entries.
- **Survivorship:**
  - Lists come from each day's bhavcopy, so names delisted since are included.
  - Fyers history may be missing for delisted or renamed tickers. They're counted and reported as "no data",
    never silently dropped.
- **Look-ahead:**
  - Lists use only the previous session's file and the 28 Apr Fyers file.
  - **The core 52 were chosen with hindsight, so they're reported separately.**
  - Regime, VWAP and candles use only past bars (the harness asserts chronological order).
- **Corporate actions:**
  - Fyers doesn't say whether candles are adjusted.
  - Detectors reset daily, so an adjustment only matters across an ex-date: a previous-close reference, or a
    multi-day window.
  - The 5-request check compares Fyers daily closes with bhavcopy closes around ex-dates. If they differ,
    affected symbol-days are flagged and reported with and without those days.
- **Real-world differences not modelled:**
  - live restarts, missed logins, late boots and watchdog trips (every day is assumed to be a clean
    09:00–15:30 session);
  - Telegram delivery;
  - circuit bands (inferred from bar shape);
  - option premiums.
- **Paper fills:** no slippage beyond the cost level, and the cost model is the owner's assumption.
- **Sample size:** 126 sessions is about the length the alert report card said was needed to confirm a
  −0.23R mean, but **not** enough to detect a +0.10R edge (about 1,000 alerts).

## Approvals needed, in order

1. Step 0: 122 NSE bhavcopy downloads (no Fyers).
2. The engineering items in section 6, as one backtest-only PR, reviewed.
3. The Fyers call plan, Stage A only (159 requests, one evening, token handling as in section 5). Then the
   parity gate.
4. Stage B: the exact remaining manifest count and the evening(s). Only after parity passes.

## Amendment 1 (10–11 Nov 2026, before any Fyers request or run; not based on any result)

**What step 0 produced (owner OK, 10 Nov).**
- **NSE files:** 122 bhavcopies downloaded from the NSE archive, one per 2 s. 123 requests reached NSE: the 122,
  plus one diagnostic re-request of 6 Nov that was discarded. The 4 held files (3–6 Nov) were copied from the
  server. All 126 as-of files are in `C:\trade-data\backtest-6m\bhav\` (25 MB).
- **Lists:** rebuilt offline by `backtest/bt6m/rebuildLists.ts` (the live `runBhavScan`, the 28 Apr
  `fyersUniverse.json`, asserted by git blob). **All 126 were written.**
- **Check against live:** the rebuilt lists for 4, 5, 6 and 9 Nov are **identical** to the lists live used
  (`watchlist_daily_history`): symbols, groups, picks, funnel and dropped names.
- **The exact symbol count replaces the estimate in §4:** **909 symbols** = 52 core + **856 rotating** + Nifty.
  - Rotating names by days listed: 286 on 1 day, 430 on 2–5, 121 on 6–20, and 19 on more than 20.
  - The most-listed are BHARTIARTL (108 days) and ETERNAL (50).
- **The exact request counts replace §5's estimate:**
  - **Stage A = 140 requests** (140 symbols on the 4–9 Nov lists; `manifest_A.json`, fixed 11 Nov). That's
    within the owner's cap of 159.
  - **Stage B = 1,103 requests**, computed and not written. Its manifest is only written after the owner
    approves Stage B.

**Two fill rules, made exact (they implement §3's same-bar rule; not tuned):**
1. **Same-bar rule:** if an open position's stop and target both lie inside a 1-min bar, that bar's 4 synthetic
   ticks take the adverse extreme first (LONG O→L→H→C, SHORT O→H→L→C). So the stop is reached first.
2. **Level ticks (the tracker only):** between two consecutive prices of a symbol, the live tracker first gets a
   tick **at** each open stop or target lying strictly between them.
   - **Why:** live, real ticks cross a level close to it. With 4 synthetic ticks per bar, the tracker would
     otherwise fill a stop at the bar's low and a target at the bar's high. The first biases losses down; the
     second inflates wins.
   - **Gaps:** a jump through a level with no price in between (e.g. a bar opening beyond the stop) still fills
     at the first price beyond it, as live.
   - **Detectors are unaffected:** they get the plain 4 ticks.

**Parity sessions:** 4, 5, 6 and 9 Nov (4 sessions). The "5 lists" in §5 counted the 11 Nov list, which is
outside the window.
