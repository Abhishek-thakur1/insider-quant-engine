# Watchlist 26 → about 50 symbols: the selection rule (pre-committed)

**Status:** this file was committed **before any ranking was computed**. The list produced from it
(`LIST.md`, a later commit) must follow it exactly. Any change after that is appended under
"Deviations" with a reason. Proposal only. Nothing is deployed and no Fyers API call is made.

Owner ask (26 Oct 2026): "the most liquid F&O names by 20-day turnover from the existing cache, no
Fyers calls, no hand-picked 'trending' names".

## What exists (facts checked before writing the rule; no turnover computed)

- **Live today:** `watchlist.json` in the `screener_data` volume, written by the screener on 20 Oct.
  It has 25 names (the 5 CORE plus 20 screener picks). With Nifty that makes the 26 subscribed symbols.
  The boot log shows `26/100 symbols: watchlist 25 + bench 0 + index 1 + options 0`.
- **The only cache of daily bars:** `backtest/data/cache/res-D` on the owner's PC. It holds 90 equities
  plus Nifty, and the last bar for each is **2026-09-07** (fetched 7 Sep). The 90 names are the old
  baked-in `watchlist.json` universe, a list someone chose earlier. EC2 has no candle cache, and the
  `screener_data` volume holds no candles.
- **F&O membership:** no copy is cached anywhere. The screener reads it from the public symbol
  master `NSE_FO.csv` (`src/screener/masters.ts`, `FO_URL`). That is a static public file download,
  not an authenticated API call, and it uses no quota, but it is hosted by Fyers.
- **Per-symbol config:** a watchlist equity needs none. No sector, tier or lot-size table in `src/`
  is read for equities; sizing is by capital, not lots. Tiers exist only in the screener's optional
  `watchlist_meta.json`.

## The rule

1. **Pool:** every `NSE:*-EQ` series in `backtest/data/cache/res-D`. Nothing is added by hand and
   nothing is removed by hand.
2. **Eligible if all of these hold:**
   - (a) it has at least 20 daily bars, and its last bar is the cache's common last date (2026-09-07);
   - (b) the last close is at least ₹20 (`config/screener.json`, `liquidity.minPrice`);
   - (c) it is an F&O stock, meaning it appears as a stock-futures underlying in the public
     `NSE_FO.csv` master. This needs **one file download, with the owner's OK**. Until then, (c) is
     shown as "pending" and is not applied.
3. **Liquidity score:** `T20` is the mean of `close × volume` over the last 20 daily bars, in ₹ crore.
4. **Selection:**
   - keep all 25 current live names unchanged (no removals);
   - add eligible pool names that are not already present, in descending `T20` (ties broken
     alphabetically), until the watchlist has **50** names.
5. **Output:** the list, the count against the cap, and each name's `T20`, rank and F&O status.

## Fixed consequences, known before ranking

- **Subscription:** 50 + bench 0 + index 1 + options 0 = **51/100**.
  - If the screener's bench (30) comes back: 81/100.
  - If `NIFTY_OPTIONS_ENABLED` also comes back (+30): 111/100. The engine refuses to boot at that
    level, so the options fix and this expansion can't both be live with a full bench.
- **Fyers calls the engine makes itself:** the VWAP seeder makes one history call per watchlist name
  plus Nifty at each boot. That goes from 26 to 51 calls per boot, within the seeder's 300-a-day
  allocation, so about 5 boots a day.
- **Labels:** added names will log `promotion_source = SCREENER`, because the engine labels every
  non-CORE watchlist name that way and the `signals` CHECK constraint allows no other value without a
  migration. They can be told apart by this committed list.
- **The screener:** if `quant_screener` runs again, it overwrites `watchlist.json` with its own
  ranking (cap 60), and this list is superseded.

## Known weaknesses (stated before ranking)

- **Stale data:** the turnover is as of 7 Sep, 7 weeks old.
- **Biased pool:** the pool is a list chosen earlier, so "most liquid" means most liquid within that
  list, not across F&O. A fair version would rank every F&O stock by 20-day turnover. That needs about
  200 daily-history API calls on one evening, which is a Fyers OK the owner hasn't given.
- **Not a test:** none of this says whether more symbols add edge. Each added name only adds fires to
  the paper log.

## Deviations

(none yet)

- **2026-10-26, about 22:10 IST: a correction to a fact, not to the rule.**
  - **The seeder.** "Fixed consequences" said the VWAP seeder makes one history call per name at each boot. That is true only for a restart after 09:15. At the normal 09:00 boot the seeder skips and makes no call (`seedHistoricalVwap`, "Before 09:15 IST … Skipping").
  - **The owner picks.** These are proposed in `docs/proposals/owner-picks/`, and BSE, MCX and PAYTM are on both lists. Whether this list refills the three places with BAJAJ-AUTO, KEI and INDIGO, or stops at 47 added, is for the owner to decide. The ranking itself is unchanged.

- **2026-10-27, owner decision: no backfill.**
  - The registered list stays exactly as ranked in `LIST.md`. BSE, MCX and PAYTM are counted once, under the owner picks (PR #36), and their #34 places are **not** refilled. BAJAJ-AUTO, KEI and INDIGO stay out.
  - This PR therefore adds **22** names, not 25.
  - With the owner picks live, the watchlist is 25 live + 4 owner picks + 22 = **51 names**, and the subscription is 51 + bench 0 + index 1 + options 0 = **52/100**.

- **2026-10-27, about 20:45 IST: applied (owner decision).** The 22 names this rule added went live in the engine's watchlist, together with the 4 owner picks, as a config-only file change effective at the 28 Oct boot: 51 stocks, 52/100 (AGENTS.md §11.27).
  - **RULE-85's extra 33 names are NOT live.** They wait for their own evening, after #41.
