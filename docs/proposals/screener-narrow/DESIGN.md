# Screener v2, narrowed to the liquid F&O universe: design

**Status:** design only. Nothing is deployed, **no Fyers call is made**, and the `quant_screener` container is not recreated until the owner gives an explicit OK that evening.

**The rank rule in §3 is written and committed before the dry run (§7).** Results go in `DRYRUN.md` in a later commit; any change to the rule goes under "Deviations".

## 1. Why

The 20 screener picks in the live watchlist date from 20 Oct and nothing refreshes them, because the container is gone. Three of them are thin (GENESYS, JINDWORLD, RISHABH; engine ADTV < ₹15 cr, edge-map §K).

The existing screener (`src/screener/screen.ts`, `config/screener.json`) ranks the **whole NSE cash market**, about 2,350 names. That needs about 4,700 history requests for a first fill, and the first run on 20 Oct failed 2,352 of 2,352. Narrowing to about 200 liquid F&O names makes it cheap enough for one evening, and keeps the picks liquid.

## 2. Universe

`U` = NSE stock-futures underlyings with an `-EQ` series and an INE ISIN:
- **F&O list:** from that day's public `NSE_FO.csv` master. The job already downloads it with `parseFnoCashSymbols`; the master is a static file, not a Data-API call, and uses no quota.
- **Liquidity:** 30-bar average turnover ≥ **₹25 crore**.
- **Price:** last close ≥ ₹50.

Expected size: about 180-200. The exact number is reported at the pilot.

## 3. Rank rule (fixed now)

Built on the existing screener's measures, so there is no new indicator code. Ranks are percentiles **within `U`**, not the whole market.

| Step | Rule | Change from today's `config/screener.json` |
|---|---|---|
| History | ≥ 120 daily bars (EMA window 300 where available) | same |
| Trend gate | the existing `trend` flag: close > EMA10 > EMA20 > EMA50 **and** SMA50 rising over 10 bars | same |
| Tradability | ADR(20) ≥ **1.5%** and volume ratio (20/100) ≥ 0.5 | ADR **4.5% → 1.5%**. Liquid large caps rarely reach 4.5%; at 4.5% almost nothing in `U` would pass |
| Score | **0.4 × RS rank + 0.2 × residual-momentum rank + 0.2 × proximity-to-52-week-high rank + 0.2 × volume-expansion rank** | was 0.5 / 0.3 / 0.2 with no volume term. The volume-expansion rank (20-bar ÷ 100-bar average turnover) is **new**, at the owner's request ("trend strength and volume") |
| Benchmark for RS and residual | `NSE:NIFTY500-INDEX` | same |
| Select | trend-gated and tradable names, by score descending (ties alphabetical). **Top 20 not already in the fixed list** (core, owner picks, the RULE-85 liquidity list) | was tiers 1 and 2, cap 60 |
| Hysteresis | yesterday's pick stays while RS rank ≥ 70 and close > EMA50 | same rule (`holdMinRsRank`) |
| Side | **long trend leaders only** (default). A mirror "short laggards" list is an option, not the default (§6) | same (long only) |

**Composition with the 85-symbol plan:**
- the 20 screener picks **replace the 20-Oct screener group**, so the watchlist stays at 84 + Nifty = 85;
- the bench (Layer B) stays at 0.

## 4. Requests, against the quota ledger and the 1,000-per-evening cap

Counted from the code:
- `fetchDaily.ts`: a cold start fetches 460 calendar days in ≤ 365-day chunks, so **2 requests per name**; an incremental top-up is **1 per name**;
- quotes: 50 symbols per request;
- the masters: 0 requests.

| Run | Quotes | History | Benchmark | **Total** | At 40/min |
|---|---|---|---|---|---|
| First fill (≈ 200 names) | 4 | 400 | 2 | **≈ 406** | ≈ 10.2 min |
| Nightly top-up | 4 | ≈ 200 (fewer if the pre-filter skips) | 1 | **≈ 205** | ≈ 5.1 min |
| Pilot (§5) | 1 | 48 | 1 | **50** | ≈ 1.3 min |

Every row is within the screener's ledger allocation (2,200 a day), the 1,000-per-evening cap and Fyers' 5,000 a day. The engine's seeder (300) and anomaly (200) allocations are untouched.

**Needed in code (one small PR, later):**
- `SCREENER_MAX_REQUESTS`, a per-run hard cap. It stops cleanly with exit 4 and keeps fetched candles. It is required for the pilot.
- A universe switch, `screener.universe: "fno-liquid"`.
- The config changes in §3.

## 5. Pilot: 50 requests, one evening, on the owner's explicit OK

1. That evening, the owner OKs the pilot and the one-off container recreate (`quant_screener`, the `jobs` profile) **in that message**.
2. Run with `SCREENER_MAX_REQUESTS=50` and `SCREENER_DRY_RUN=1`. It writes candles and a report only; it **doesn't touch `watchlist.json`**. Scope: 1 quote batch (50 names), 24 names × 2 history chunks, and the benchmark.
3. Measure:
   - success, `no_data` and failure counts;
   - every rate-limit or `-360` response, and any Cloudflare 1015;
   - latency;
   - the ledger before and after (exactly 50 must be recorded);
   - bars versus the backtest cache on the overlapping dates (prices must match).
4. **Stop rules:** any 1015, more than 2 rate-limit responses, or ledger ≠ 50. Then stop and report; don't retry that evening.
5. Afterwards, `docker rm quant_screener` again, so the 16:30 cron can't run it until the schedule change below is deployed.

**Then:** the first fill on its own evening, after the owner's OK. Then the nightly schedule.

## 6. Schedule inside 15:45–16:15

- **15:50: start.** The daily bar is final after the 15:30 close. The pilot verifies that Fyers serves it by 15:50, by comparing against the 15:30 close.
- **≈ 15:56: nightly done** (≈ 205 requests). The first fill would finish ≈ 16:01.
- **16:00:** the DB backup runs independently; it touches no Fyers quota.
- **Deploy evenings:** the existing 16:05 earliest start gains a **fourth check**: the 15:50 screener finished (exit 0, 2 or 4), and the watchlist it wrote is what the deploy expects.
- **Needed:** the scheduler cron moves from `30 16` to `50 15`. That is a scheduler-only change on its own evening.

## 7. Dry run on cached data (no Fyers)

- **Input:** the backtest cache (`res-D`, 90 equities), as of its last common date.
- **Substitutions, stated:**
  - F&O membership is unknown offline, so the liquidity and price filters stand in for `U`;
  - the cache has no Nifty 500 series, so **Nifty 50** is the RS and residual benchmark for the dry run only.
- **The dry run shows:**
  - the funnel;
  - the top 20 under the §3 rule;
  - the same under today's rule, for contrast;
  - how many of the top 20 are already in the RULE-85 list.
- **It is not a test of edge.** It only shows that the rule produces a list, and what kind.

## 8. What "trending" means

| | Definition | Source | Default |
|---|---|---|---|
| **(a) Trend leaders** | Daily bars: trend-gated, ranked by relative strength, residual momentum, closeness to the 52-week high and volume expansion (§3). Refreshed nightly | the narrowed screener | **On**, once the pilot and first fill pass. 20 slots |
| **(b) Intraday movers** | Within the session: a stock not on the watchlist that trades ≥ 5% of its average daily volume in 5 minutes with a > 1.5% price move. That is the existing `AnomalyScanner` rule (Layer B); it promotes the stock and its detectors for the rest of the day | engine, live ticks | **Off.** It needs bench symbols subscribed, and the 85 plan keeps 15 symbols of headroom instead. Revisit after the 85 is measured: up to 15 bench slots would fill the headroom |
| **(c) News-driven** | A stock moving on news or corporate action | none: Fyers has no news feed, and no external source is approved | **Parked** |

## Deviations

(none yet)
