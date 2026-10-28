# Late 15:15 time exits, 28 Oct (and a check of 23 Oct): read-only analysis

## What happened

The 15:15 TIME exit only ran on a **traded tick**: `processTick` is reached only by ticks with volume, and zero-volume quotes are dropped first.

After 15:15 on 28 Oct the feed thinned sharply. The engine's 5-minute heartbeats show:

| Window (IST) | Messages | Index ticks | Traded stock ticks |
|---|---|---|---|
| 15:10–15:15 | 12,674 | 977 | 6,972 |
| 15:15–15:20 | 3,377 | **38** | 1,353 |
| 15:20–15:25 | 5,640 | 298 | 940 |

The socket stayed connected and the engine never restarted. The monitor's 15:22 check failed ("4 INTRADAY positions still open"), and its 15:33 check passed (0 open, 17 time exits).

**28 Oct: 6 of 17 TIME exits were late**, all at 15:28:22–26. **23 Oct: 0 of 3 were late.**

| Row | Stock | Entry | Stop | Exit (price, IST) | R as recorded | ₹ P&L | Qty | Kind | R per ₹1 of exit price | R per 0.1% of price |
|---|---|---|---|---|---|---|---|---|---|---|
| 1635 | SBIN | 953.75 | 949.66 | 956.80 at 15:28:22 | +0.75 | 30.50 | 10 | ungated | 0.244 | 0.23 |
| 1657 | VEDL | 232.45 | 229.90 | 233.05 at 15:28:22 | +0.24 | 17.40 | 29 | ungated | 0.392 | 0.09 |
| 1646 | KALYANKJIL | 510.45 | 501.62 | 510.00 at 15:28:23 | −0.05 | −8.55 | 19 | **alerted** | 0.113 | 0.06 |
| 1639 | SOLARINDS | 19,300 | 19,153.17 | 19,240 at 15:28:25 | −0.41 | 0 | 0 | ungated, capital-skipped | 0.0068 | 0.13 |
| 1653 | SOLARINDS | 19,370 | 19,163.95 | 19,240 at 15:28:25 | −0.63 | 0 | 0 | ungated, capital-skipped | 0.0049 | 0.09 |
| 1645 | HAL | 4,813 | 4,780.43 | 4,850 at 15:28:26 | +1.14 | 74.00 | 2 | ungated | 0.0307 | 0.15 |

## The R difference against the price at 15:15: not measurable from recorded data

The engine keeps no ticks:
- `v2:vcp_history` holds only the last 7 five-minute candles per stock, and they end at about 15:01–15:06;
- the backtest cache ends on 7 Sep;
- nothing else records an equity price at 15:15.

Measuring it would need a Fyers history call, which isn't allowed. So the table gives the **sensitivity** instead: how much R each ₹1, or each 0.1% of price, between the 15:15 price and the 15:28 exit would change.

- For SBIN, a 0.1% move in those 13 minutes is 0.23 R. On a thin-feed day the error is material for that kind of position.
- From the PR below onward, the timer logs the last price and its age at 15:15, so future days can be measured.

## The fix (PR, not deployed): `fix/timer-square-off`

- **Last price:** `positionTracker.notePrice(symbol, ltp, ts)` is called for **every** feed message, before the zero-volume filter. It is a synchronous `Map.set`.
- **The timer:** from 15:15 IST, a 5-second timer (`squareOffSweep`) closes every open INTRADAY position at its symbol's last known price, through the unchanged `processTick` close path, so TIME, R, Postgres and Redis behave as before.
  - It logs `⏱️ 15:15 timer square-off: <sym> at last price ₹x (n s old)`.
  - A symbol with no known price waits for its next traded tick, as today.
  - SWING positions are untouched.
- **Serialisation:** `processTick` calls for one symbol now run one at a time. Without that, a timer close and a tick close of the same position could both run: two history rows and `pnl:daily` counted twice. A test shows this happens when the serialisation is removed.
- **Kill switch:** `SQUARE_OFF_TIMER=false`.
- **Series break when deployed:** time-exit prices then come from the last known price at the 15:15 timer, not the first traded tick after 15:15.
