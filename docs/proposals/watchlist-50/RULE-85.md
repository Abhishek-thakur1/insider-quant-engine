# Extension to about 85 symbols: the rule (pre-committed)

**Status:** written and committed **before any ranking for the extension was computed**, at the owner's request (27 Oct). `LIST-85.md` (a later commit) must follow it exactly; any change goes under "Deviations" with a reason. Proposal only. Nothing is deployed and no Fyers call is made.

The pool, the eligibility test and the liquidity score are unchanged from `RULE.md`. Only the target and the composition change.

## The rule

1. **Target:** 84 equities + Nifty = **85 subscribed symbols**, with bench 0 and options 0. That leaves **15 symbols of headroom** under the 100 cap.
2. **Fixed members, in this order, never removed by this rule:**
   - **(a) The 25 live names:** `live_watchlist_2026-10-20.json`, as in `RULE.md`.
   - **(b) The 4 owner picks:** BSE, MCX, PAYTM, ATHERENERG (PR #36).
   - **(c) The 22 names `RULE.md` added:** its registered list, with BSE, MCX and PAYTM counted once under (b) and not refilled (owner decision, 27 Oct).
   - That makes 51 equities.
3. **Fill:**
   - The remaining **33** places go to eligible pool names not already in, in descending `T20` with ties broken alphabetically. `T20` is the mean close × volume over 20 daily bars, in ₹ crore.
   - **Pool and eligibility exactly as in `RULE.md` §2:** every `-EQ` series in `backtest/data/cache/res-D`, with at least 20 bars, a last bar on the common last date, and a last close ≥ ₹20.
   - **F&O (`RULE.md` 2(c)):** still **pending**. It needs the public `NSE_FO.csv` download, which needs the owner's OK. Until then it is shown per name and **not applied**.
   - BAJAJ-AUTO, KEI and INDIGO enter only if this rule's own ranking reaches them. That is the extension's fill, not a backfill of `RULE.md`'s list.
4. **If the eligible pool runs out before 84,** the list stops there and the count is reported. Nothing is added by hand.
5. **Output for every one of the 84 names:**
   - its group;
   - `T20` and rank;
   - F&O status;
   - the deviation-11 liquidity columns: cache ADTV, engine-observed ADTV with n days, the AR 1-minute spread estimate, and the 10 bps flag;
   - the deviation-12 engine-ADTV class (liquid ≥ ₹15 cr / thin / unknown).

## Capacity: estimated from recorded rates, before the list exists

- **Tick rate:** the per-stock rate comes from the engine's 5-minute heartbeats on 26 and 27 Oct, 25 stocks. It is scaled to 84 stocks with a low bound and a high bound. The high bound allows for liquid F&O names ticking several times faster than today's small caps.
- **CPU and memory:** the measured engine figures (21 Oct: 3.6% CPU and 120 MiB at about 19.5 messages a second) are scaled linearly in messages a second. Against the host, a t3.small: 2 vCPU, 1.9 GB RAM, and a CPU-credit baseline of 20% per vCPU.
- **Detector load:** 2 equity detectors per stock, and the Redis operations per tick.
- **Not measured:** the live tick rate of the new names. The first session after a deploy measures it (Firehose heartbeat and `docker stats`).

## Deploy (owner, 27 Oct)

After Wed #32, Thu #36 and Fri #41, on its own evening, not before 16:05, never in market hours. The watchlist-file procedure is the same as for #36: edit after the 16:30 check, back up first, no rebuild. It goes ahead only while `quant_screener` stays absent.

## Deviations

(none yet)
