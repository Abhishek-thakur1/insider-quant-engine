# VWAP session gate: how big the pre-open effect is

**Status:** measurement for the owner's decision. The gate in this PR is **not deployed**. No Fyers call was made, and no gate, threshold or detector changed.

## What the engine does today

The engine boots at 09:00, and from boot onward it counts:
- **Equities:** every tick with volume enters `vwap:{symbol}:{day}`, including the **pre-open auction print** at about 09:08. Today's log shows 25 equity ticks routed between 09:05 and 09:10, one per watched stock.
- **Nifty:** every closed one-minute candle enters the session reference, **including about 13 pre-open minutes**. On 26 Oct the reference held 388 candles; the 09:15–15:30 session has 375, and the engine stopped at 15:30:00.

The seeder (Fyers one-minute candles from 09:15) and the backtest replay (bars from 09:15) include neither. So live and backtest VWAP differ, most of all in the first hour.

## Nifty, 26 Oct (the engine's own recorded data)

**Inputs:**
- the 5-minute bars the engine recorded, `ema_shadow:nifty:bars5`, committed here as `nifty_bars5_2026-10-26.jsonl`;
- the reference the engine printed at 09:47 (`VWAP 22466`, VWAP Reclaim fire);
- the end-of-day Redis state: 388 candles, reference 22,613.41.

**The pre-open level isn't recorded,** so it is estimated two ways:
- From the 09:47 reading it comes out at 22,517–22,520.
- From the end-of-day residual it comes out at 22,480. That estimate divides a 370-minute sum error by 13 minutes, so it isn't used.

The table therefore uses two levels: the 09:15 open (22,508.2) and the 09:47 estimate (22,518.4).

| Time | Engine reference minus session-only reference |
|---|---|
| 09:20 | +32 to +40 pts (14–18 bps) |
| 09:25 | +39 to +44 pts (17–20 bps) |
| 09:35 | +25 to +29 pts (11–13 bps) |
| 09:45 | +20 to +23 pts (9–10 bps) |
| 09:55 | +13 to +15 pts (6–7 bps) |
| 10:15 | −2 to −0.5 pts |
| 11:15 onward | about −3 to −7 pts (≤ 3 bps) |

- **The 09:47 VWAP Reclaim fire** saw 22,466. The session-only reference would have been about 22,444.
- **Bias:** in the first 40 minutes the shift is bigger than the ±0.15% band (about 34 pts) that `updateNiftyBias` uses. The equity detectors and the filter read that bias.
- **Precision:** the session-only reference here is built from 5-minute bars. A one-minute version would differ by a few points.

**Not measured: whether any detector decision would have changed.** That needs a replay on one-minute Nifty bars, and the engine records only 5-minute bars. Both 26 Oct Nifty fires were rejected (EV, SCORE).

## Equities (the backtest cache; no per-stock ticks or bars are recorded live)

The engine keeps no per-stock intraday ticks or bars (`v2:vcp_history` holds 7 candles), so today's equity effect **cannot be measured**. Instead it is estimated from the cache: 90 stocks, the last 20 sessions each to 2026-09-07, 1,800 symbol-days.
- **Auction volume:** daily volume minus the sum of one-minute volumes. This is an **upper bound**, because it also holds the closing session. Median 0.33% of the day's volume, 90th percentile 1.13%.
- **Auction price:** the daily open.
- **Shift:** |VWAP with the auction − VWAP without| in bps. A live VWAP stop (VWAP × 0.998 / × 1.002, 20 bps from VWAP) moves by the same bps.

| Time | Median | 90th percentile | 99th percentile | Max |
|---|---|---|---|---|
| 09:20 | 2.4 | 9.0 | 31.9 | 126.6 |
| 09:30 | 1.4 | 5.7 | 24.8 | 93.0 |
| 09:50 | 0.9 | 3.9 | 18.9 | 54.2 |
| 10:30 | 0.6 | 2.8 | 14.5 | 42.2 |
| 12:00 | 0.4 | 1.9 | 9.7 | 29.5 |
| 14:00 | 0.3 | 1.3 | 7.1 | 28.7 |

**Reading:**
- For a typical fire after 09:50 the stop moves by under 1 bp, against its 20 bps offset.
- For fires at 09:20–09:30, 1 symbol-day in 10 moves the stop by 6–9 bps, and 1 in 100 by 25–32 bps. That is about the whole offset.

**Scripts:** `backtest/studies/vwap-gate/nifty_effect.cjs` and `eq_effect.cjs`. Both read only committed or cached files.

## What the gate changes, and what it doesn't

**Changed:**
- An equity tick before 09:15 IST no longer enters the VWAP.
- A Nifty minute that **starts** before 09:15 no longer enters the session reference.

**Unchanged:**
- Regime returns: pre-open minutes still feed the entropy engine as before, because that feeds the REGIME gate.
- Candle buffers.
- Detectors, thresholds and the filter.

**Side effect:** on a 09:00 boot, the Nifty bias stays unset (the boot-cleaned `neutral`) until the first in-session minute closes, at about 09:16. Before, it was computed against the pre-open level. No equity detector fires before 09:15 anyway.

**Kill switch:** `VWAP_SESSION_GATE=false`, with no rebuild.

**Backtest data quirk, not fixed here:** on 1 of 1,285 cached days (2026-09-07, the fetch day), the Nifty one-minute cache holds 5 constant pre-open bars, 09:10–09:14. The 5-minute aggregation turns them into a 09:10 bar, so that one replay day includes them.
