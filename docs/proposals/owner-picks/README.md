# Owner picks: BSE, MCX, PAYTM, ATHERENERG

**Status:** proposal for review, drafted 2026-10-26 and amended on 27 Oct after the independent review. Nothing is deployed, and no Fyers REST call was made.

## 1. Symbol codes and their sources

The same code appears in four places that already existed before this proposal.

| Company | Fyers code | Sources where this exact code appears |
|---|---|---|
| BSE Ltd | `NSE:BSE-EQ` | ① ② ③ (15 days) ④ |
| Multi Commodity Exchange of India | `NSE:MCX-EQ` | ① ② ③ (12 days) ④ |
| One 97 Communications (Paytm) | `NSE:PAYTM-EQ` | ① ② ③ (12 days) ④ |
| Ather Energy | `NSE:ATHERENERG-EQ` | ① ② ③ (1 day, 2026-10-12) |

- **① `fyersUniverse.json`:** in the repo, committed on 2026-04-28 (`ac7e962`), 2,158 symbols. It is the screener's fallback universe.
- **② The screener's universe from 19 Oct:** `failed_2026-10-19.json` in the `screener_data` volume, 2,352 symbols. It was built from that day's `NSE_CM` symbol master; its count differs from ①, so it isn't the fallback.
- **③ The engine's own Redis keys:** `vwap:{code}:{date}`. These keys only exist if the live feed sent ticks under that exact code on that day, so they show the code resolves on Fyers' socket.
- **④ The backtest cache:** the `symbol` field of `backtest/data/cache/res-D/NSE_{code}.json`.

**Note:** Ather's NSE ticker is `ATHERENERG`, ten characters. `ATHERENERGY` and `ATHER` appear in none of the sources.

## 2. Tagging

The picks are tagged as their own group in **`owner_picks.json`**, which records the symbol, name and date added. `live_from` gets filled in at deploy. The group is kept separate from:
- the core 5 (`core_watchlist.json`);
- the screener's 20 (`watchlist.json` of 20 Oct);
- the rule-based PR #34 list.

The analysis assigns groups by symbol and `live_from`.

**No engine change.** While there is no `watchlist_meta.json` (there is none in the volume today), the engine labels every non-CORE watchlist name `promotion_source = SCREENER`. The `signals` CHECK constraint (migration 0006) allows seven values, and `OWNER_PICK` isn't one of them. A distinct `OWNER_PICK` value would need two things, and neither is in this PR:
- a migration;
- a `watchlist_meta.json` entry.

Writing `OWNER_PICK` through `watchlist_meta.json` without the migration would make every signal insert for those names fail the CHECK.

**Overlap with PR #34.** BSE, MCX and PAYTM are also in PR #34's rule-based list, ranked 1, 2 and 5 by 20-day turnover. Two consequences:
- They are tagged here as owner picks, from this proposal's `live_from`.
- If #34 is later deployed, its rule ("add until the watchlist has 50") would fill the three freed places with the next names in line: BAJAJ-AUTO, KEI and INDIGO. The alternative is to stop at 47 added. **The owner decides which.**

## 3. Count, config, liquidity and history

**Count.** The watchlist goes from 25 to 29 (`watchlist_proposed.json`: the live list unchanged, plus 4). The subscription is **29 + bench 0 + index 1 + options 0 = 30/100.**
- If PR #34 is also deployed and the overlap is filled: 54 + 1 = 55/100.

**Per-stock config: none.** Watchlist equities are sized by capital, not lots, and no sector or tier table in `src/` is read for them. Tiers exist only in the screener's optional `watchlist_meta.json`, and there is none today.

**Fyers calls the engine makes.** At the usual 09:00 boot the VWAP seeder makes **no** calls: it skips before 09:15 and builds VWAP from live ticks. Only a restart after 09:15 seeds, with one history call per watchlist name plus Nifty, going from 26 to 30.

**Liquidity** (edge-map tables §J, deviation 11, method committed before computing; ₹ crore). The engine-observed ADTV and the day counts come from the read-only EC2 Redis export of 26 Oct, committed with §J. The paper-trade counts come from a read-only `paper_trades` query on EC2 on 26 Oct:

| Code | Cache ADTV, 20 days to 2026-09-07 | Engine-observed ADTV (days) | Spread proxy AR 1-min, bps | 10 bps flag |
|---|---|---|---|---|
| BSE | 1,648.8 | 2,152.5 (12) | 1.8 | ok |
| MCX | 855.2 | 633.5 (9) | 0.0 (floored) | ok |
| PAYTM | 649.6 | 787.6 (9) | 3.7 | ok |
| ATHERENERG | no cache | 516.8 (1) | — | unknown |

**History:**
- **BSE, MCX:** daily, 5-minute and 1-minute bars from 2021-07-05 to 2026-09-07.
- **PAYTM:**
  - daily bars from 2021-11-18 to 2026-09-07;
  - 5-minute and 1-minute bars from 2025-03-17 to 2026-09-04.
- **BSE, MCX, PAYTM in paper trading:**
  - 5, 7 and 11 closed paper trades between 2026-09-11 and 09-24, from when they were on the old 90-name watchlist;
  - no `signals` rows (that log starts on 21 Oct).
- **ATHERENERG:** no cached bars, no paper trades and no signals. There is one engine-observed day (2026-10-12). Replay or calibration work on it would need a fetch, which needs the owner's OK.

## 4. Deploy plan (proposed; not run)

**⚠ The screener can overwrite this file** (independent review of 27 Oct).
- The 16:30 cron (`scheduler/crontab`, `lifecycle.sh run_screener`) runs `docker start -a quant_screener` on every trading day. On exit 0 the job rewrites `watchlist.json`, `watchlist_meta.json` and `anomaly_universe.json` in this volume, which would drop the owner picks.
- **Today that can't happen:** the `quant_screener` container doesn't exist (removed on 20 Oct after the quota incident), so the job fails at `docker start` and writes nothing.
- **Checked on EC2, 27 Oct ~06:24 IST:**
  - there is no `quant_screener` container;
  - `watchlist.json` was last modified on 2026-10-20 at 16:31;
  - the volume has no `watchlist_meta.json` and no `anomaly_universe.json`.
- **This plan, and its 30/100 count, hold only while that is true.** If the screener is ever recreated, which needs the owner's Fyers OK, the picks need a way to survive first. Three options, for the owner to choose:
  - (a) pause `run_screener`;
  - (b) re-apply this edit after each run;
  - (c) teach the screener to keep an owner list.
- A successful screener run would also create the bench (up to 60 + 30 + 1 = 91 symbols).
- **Expected boot warning:** with no `watchlist_meta.json`, every boot warns about the screener output and sends it to the admin chat. The current text wrongly says "baked-in"; PR #37 fixes the wording. This plan adds no meta file, so the warning stays, as it is today.
- **Step 3 runs after 16:30**, after checking that the job's 16:30 run failed as expected (no `quant_screener`) and that `watchlist.json` is unchanged.


**Proposed slot (owner's choice): Thursday 29 Oct after 15:30**, alongside #32. That is after #29 on Tuesday and #22 with the API on Wednesday. Each step below runs only if every earlier evening was clean.

**⚠ This conflicts with the standing rule "one engine change per evening".**
- The watchlist edit changes no code, but it changes what the engine watches.
- If anything looks off on Friday, #32 (logging) and the extra 4 names would be confounded.

There are two options. **The owner decides.**
- Option A: a separate evening, Friday 30 Oct after 15:30 or the next working evening.
- Option B: keep Thursday as asked, applying #32 first and the watchlist edit second, with a separate rollback for each.

**Steps:**
1. Send the pre-deploy message on Telegram, with this list and the count.
2. Run the full procedure for #32:
   - copy the logs;
   - take a fresh `pg_dump` and check it has 3 TABLE DATA entries;
   - record a rollback tag.
3. Back up the live watchlist: `cp watchlist.json watchlist.json.bak-2026-10-29` in the `screener_data` volume. Then write `watchlist_proposed.json` as `watchlist.json` and check it is valid JSON with 29 entries.
4. Rebuild and recreate `quant_engine` only (the #32 rebuild), and leave it Created. Nothing starts before Friday's 09:00 boot.
5. At Friday's boot, check:
   - the line `Subscription plan: 30/100 symbols — watchlist 29 + bench 0 + index 1 + options 0`;
   - `Equity stack: 2 detectors … × 29 stocks`;
   - Firehose `active symbols seen 29/29` after 09:15.
6. Set `live_from` in `owner_picks.json` to the first session date, in a follow-up commit.
7. **Rollback:** first check that `watchlist.json` is still the proposed 29-name file. Copy the `.bak` back only if it is; if the screener has written a newer list since, report instead of copying. Then restart outside market hours. It needs no database change.

**No Fyers REST call** is involved at any step. The only Fyers traffic is the existing WebSocket subscription.
