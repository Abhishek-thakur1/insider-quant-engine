# Daily watchlist: rules dw-3 (pre-registration)

**Committed before the code and before the first list** (owner, 3 Nov 2026, evening). Version **`dw-3`** replaces dw-2 (`PREREGISTRATION_dw2.md`, kept unchanged as the record). **Only two things change: the data source, and the list size the owner set (80 symbols including Nifty).** The filters, measures, score, order and core 25 are dw-2's. Nothing here claims an edge; whether the list helps is **untracked**.

## Data source: the NSE official daily bhavcopy (no Fyers calls, no website scraping)

- **File:** the NSE capital-market UDiFF common bhavcopy from NSE's published archive, `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_<YYYYMMDD>_F_0000.csv.zip`. One zip containing one CSV.
- **Checked on 3 Nov:** one test download from the server at 20:48 IST returned HTTP 200, 207,818 bytes, published at 16:33 IST (`Last-Modified`). It had 3,717 rows, all `FinInstrmTp = STK`, with 2,744 `SctySrs = EQ` rows, 2,387 of them with an `INE` ISIN.
- **Units:**
  - prices are in rupees;
  - `TtlTradgVol` is in shares;
  - `TtlTrfVal` is in rupees. RELIANCE on 3 Nov: 42,319,913 shares and ₹5,485 crore.

## Universe

Main Board equities only: rows with `Sgmt = CM`, `SctySrs = EQ` and an `INE` ISIN. SME (`SM`, `ST`), `BE`/`BZ` trade-for-trade and other series are out, and so are ETFs (INF ISINs). Each row maps to the Fyers symbol `NSE:<TckrSymb>-EQ`, and it must match `^NSE:[A-Z0-9&_.-]+-EQ$` (the "Fyers-mappable" check; no Fyers call is made to confirm it).

## Field mapping to the dw-2 measures (unchanged formulas)

| dw-2 (Fyers quote) | dw-3 (bhavcopy) |
|---|---|
| `lp` | `LastPric` |
| `prev_close_price` | `PrvsClsgPric` |
| `high_price` / `low_price` | `HghPric` / `LwPric` |
| `volume` | `TtlTradgVol` |
| as-of day (`tt` date) | `TradDt` |

- **As-of rule:** `TradDt` equals the as-of day and `TtlTradgVol` > 0.
- **Floors (dw-2):** price ≥ ₹50, turnover `LastPric × TtlTradgVol` ≥ ₹50 crore, previous close > 0, high > low.
- **Score (dw-2):** 0.4 × pct(move) + 0.3 × pct(range) + 0.3 × pct(turnover), where:
  - move = |lp − prev close| / prev close;
  - range = (high − low) / prev close.
- **Order:** score, highest first; ties go to the higher turnover, then the symbol alphabetically.

## List size (owner, 3 Nov): 80 symbols including Nifty

- **Core 25** (`config/daily_watchlist_core.json`, unchanged), always in.
- **Rotating:** the top **54**. That makes 79 stocks + Nifty = **80**.
- **Validation:** 60 to 79 unique, well-formed stocks (61–80 with Nifty), and every rotating name in that day's Main Board EQ rows. If the file isn't the as-of day's, or anything fails, nothing is written.

## Schedule and failure

- **When:** a scheduler job on the server at 19:00, 19:30, … 22:00 IST, Mon–Fri. It runs only when the day is a trading day per `scheduler/nse_holidays.txt`.
  - **As-of day:** today. **For:** the next trading day.
  - **Once written,** the later runs that evening do nothing.
- **Retries:** a missing file (not published yet) or a network error is retried at the next half hour. The owner is alerted on Telegram if there is still no list after the 22:00 run. A bad file (parse or validation failure) is alerted at once, and that evening's later runs are skipped.
- **On any failure** nothing is written. The engine then boots from the static `watchlist.json` (52 stocks + Nifty) and alerts that the daily list wasn't used. A daily list is only ever used for the session it was made for.
- **The engine reads the list once, at boot** (09:00). It never reads it mid-session.
- **Kill switch:** `SCREENER_ENABLED` is off by default (#65). Only `true` uses the daily list.
- **Kept for audit:** each downloaded zip is saved as `bhavcopy/<asOf>.csv.zip` next to the list, along with the list history `watchlist_daily_history/<forSession>.json`.

## First list (3 Nov, operational)

Built from the file of the one test download (no second download), as of 3 Nov for Wed 4 Nov. The output goes to the evidence folder first. The owner sees the dry-run list before the screener is deployed or enabled.

## Amendment 1 (owner, 3 Nov ~21:15 IST, before any deploy): for continuity, not for results

It was made after the owner saw the first dry-run list. It is not based on any outcome: no session has used a dw-3 list. The version stays **`dw-3`**, and the filters, measures, score and order are unchanged.

1. **Core = the owner's current 52-stock watchlist,** the static `watchlist.json` on the server as of 3 Nov (including JPL, ATHERENERG, BEL, SBIN and HAL). It replaces the 20 Oct core 25 in `config/daily_watchlist_core.json`. The core is always in, unranked.
2. **Rotating** names fill the remaining slots up to 79 stocks: 79 − 52 = **27**. Core names are never ranked, so there are no duplicates. The total stays 79 stocks + Nifty = **80**.
3. **Fyers validation:** every symbol in the list must be in `fyersUniverse.json`, the image's Fyers NSE EQ symbol list, and match `^NSE:[A-Z0-9&_.-]+-EQ$`.
   - The file has no date of its own. It was last changed on 2026-04-28 (git `ac7e962`, 2,158 symbols), and that date is recorded in each list.
   - Names not found are dropped, not replaced. The dropped names and the final count go into the list file and the Telegram message.
   - If the list falls below the 60-stock minimum, it is rejected and the engine uses the static list.
   - Note: a list older than the stock (JPL is not in the 28 Apr file) drops it even when Fyers streams it.

## Amendment 1a (owner, 3 Nov ~21:30 IST, before any deploy): the core is exempt from the Fyers check

The 52 core names come from the live watchlist the engine subscribed to on 3 Nov. JPL streamed and alerted that day, but it is missing from `fyersUniverse.json`, which dates from 28 Apr. **Only the rotating names are checked against `fyersUniverse.json`.** Core names still must match the Fyers format. Nothing else changes.

## Amendment 1b (owner, 3 Nov ~21:45 IST): for coverage, not for results; committed before the code

No session has used a dw-3 list yet. The version stays **`dw-3`**. The filters, measures and score are unchanged, and so is the core 52 (exempt from the Fyers check).

1. **Refill:** after the `fyersUniverse.json` check, the rotating picks continue down the order until **27** rotating names are filled. The total is 79 stocks + Nifty = **80**. It is shorter only if too few eligible names pass the check.
2. **Two rotating groups,** tagged `pick` in the list file:
   - **`score` (22):** the top 22 eligible, Fyers-checked names by the dw-2 score and order.
   - **`turnover` (5):** the 5 highest-turnover (`LastPric × TtlTradgVol`) eligible, Fyers-checked names not already in the core or the score group. Ties go to the symbol, alphabetically.
   - The engine reads only `symbols`, so the tag is for evidence and analysis. The groups are a population label for any later per-group table.
3. **Symbol mapping:** NSE `TckrSymb` maps to Fyers `NSE:<TckrSymb>-EQ` unchanged, `&` included. M&M → `NSE:M&M-EQ`, which is in `fyersUniverse.json` (it is checked in the tests and the dry run).
