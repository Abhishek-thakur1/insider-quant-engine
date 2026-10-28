# Watchlist extension to 85: the list (applies RULE-85.md)
Produced by `build_list_85.mjs` from the cache, plus the committed engine exports. **Proposal only. Not deployed, no Fyers call.**
- **Pool:** 90 res-D equities, with the common last bar on 2026-09-07. 52 eligible names are not already fixed.
- **Composition:** 51 fixed (25 live + 4 owner picks + 22 from RULE.md), plus 33 filled by T20, for **84 equities + Nifty = 85/100 symbols, 15 headroom**.
- **F&O:** pending for every name (RULE.md 2(c); needs the owner's OK to download the public `NSE_FO.csv`).
- **Next five in line, not included:** COLPAL 70.5, AFFLE 63.2, TATAELXSI 60.7, IRFC 58.7, DALBHARAT 54.4.
- **Not eligible, because the last bar is not 2026-09-07:** NETWEB, KAYNES, JIOFIN, ICICIAMC, JSWINFRA, CYIENTDLM, SBFC, ITCHOTELS, WAAREERTL.
**Liquidity** (edge-map deviations 11 and 12):
- **Engine-ADTV class:** 81 liquid (≥ ₹15 cr), 3 thin, 0 unknown. The thin ones: GENESYS, JINDWORLD, RISHABH, all among the 20-Oct screener picks.
- **10 bps check:** 62 ok and 22 unknown (no cached 1-minute bars); none above 10 bps.
| # | Symbol | Group | T20, ₹ cr (rank) | Engine ADTV, ₹ cr (days) | AR 1-min spread, bps | 10 bps | Dev-12 class | F&O |
| 1 | RELIANCE | core | 1383.8 (3) | 1709.5 (20) | 1.1 | ok | liquid | pending |
| 2 | TCS | core | 596.8 (10) | 1328.2 (20) | 0.9 | ok | liquid | pending |
| 3 | HDFCBANK | core | 1877.6 (1) | 2138.2 (20) | 1.1 | ok | liquid | pending |
| 4 | INFY | core | not cached | 1706.2 (19) | — | unknown | liquid | pending |
| 5 | ICICIBANK | core | 1217.2 (4) | 1585.9 (20) | 1.9 | ok | liquid | pending |
| 6 | AARTIPHARM | screener (20 Oct) | not cached | 43.7 (17) | — | unknown | liquid | pending |
| 7 | AEQUS | screener (20 Oct) | not cached | 103.2 (15) | — | unknown | liquid | pending |
| 8 | CAPILLARY | screener (20 Oct) | not cached | 19.9 (16) | — | unknown | liquid | pending |
| 9 | GALLANTT | screener (20 Oct) | not cached | 471.7 (8) | — | unknown | liquid | pending |
| 10 | GENESYS | screener (20 Oct) | not cached | 13.6 (17) | — | unknown | thin | pending |
| 11 | JAMNAAUTO | screener (20 Oct) | not cached | 42.1 (13) | — | unknown | liquid | pending |
| 12 | JAYKAY | screener (20 Oct) | not cached | 34.2 (18) | — | unknown | liquid | pending |
| 13 | JGCHEM | screener (20 Oct) | not cached | 25.8 (18) | — | unknown | liquid | pending |
| 14 | JINDWORLD | screener (20 Oct) | not cached | 6.7 (18) | — | unknown | thin | pending |
| 15 | JSLL | screener (20 Oct) | not cached | 53.9 (13) | — | unknown | liquid | pending |
| 16 | JTLIND | screener (20 Oct) | not cached | 27.7 (18) | — | unknown | liquid | pending |
| 17 | MOTISONS | screener (20 Oct) | not cached | 38.0 (17) | — | unknown | liquid | pending |
| 18 | MRPL | screener (20 Oct) | not cached | 340.0 (15) | — | unknown | liquid | pending |
| 19 | RISHABH | screener (20 Oct) | not cached | 14.3 (18) | — | unknown | thin | pending |
| 20 | ROLEXRINGS | screener (20 Oct) | not cached | 37.1 (10) | — | unknown | liquid | pending |
| 21 | RPEL | screener (20 Oct) | not cached | 16.3 (18) | — | unknown | liquid | pending |
| 22 | RPTECH | screener (20 Oct) | not cached | 31.3 (18) | — | unknown | liquid | pending |
| 23 | RSYSTEMS | screener (20 Oct) | not cached | 239.8 (15) | — | unknown | liquid | pending |
| 24 | SUNTV | screener (20 Oct) | not cached | 88.3 (14) | — | unknown | liquid | pending |
| 25 | SYNCOMF | screener (20 Oct) | not cached | 44.3 (16) | — | unknown | liquid | pending |
| 26 | BSE | owner pick | 1648.8 (2) | 2152.5 (12) | 1.8 | ok | liquid | pending |
| 27 | MCX | owner pick | 855.2 (6) | 633.5 (9) | 0.0 | ok | liquid | pending |
| 28 | PAYTM | owner pick | 649.6 (9) | 787.6 (9) | 3.7 | ok | liquid | pending |
| 29 | ATHERENERG | owner pick | not cached | 516.8 (1) | — | unknown | liquid | pending |
| 30 | SBIN | #34 rule | 841.2 (7) | 721.7 (9) | 2.0 | ok | liquid | pending |
| 31 | ADANIENSOL | #34 rule | 689.0 (8) | 277.9 (10) | 2.4 | ok | liquid | pending |
| 32 | AXISBANK | #34 rule | 584.3 (11) | 612.9 (9) | 1.6 | ok | liquid | pending |
| 33 | KALYANKJIL | #34 rule | 547.8 (12) | 381.5 (10) | 4.7 | ok | liquid | pending |
| 34 | DIXON | #34 rule | 520.7 (13) | 448.4 (9) | 3.4 | ok | liquid | pending |
| 35 | TATASTEEL | #34 rule | 507.7 (14) | 463.6 (9) | 1.4 | ok | liquid | pending |
| 36 | BAJFINANCE | #34 rule | 499.9 (16) | 644.0 (9) | 1.9 | ok | liquid | pending |
| 37 | KOTAKBANK | #34 rule | 477.6 (17) | 428.2 (9) | 3.4 | ok | liquid | pending |
| 38 | HAL | #34 rule | 449.4 (18) | 326.9 (10) | 2.9 | ok | liquid | pending |
| 39 | HINDZINC | #34 rule | 406.2 (19) | 231.2 (9) | 3.1 | ok | liquid | pending |
| 40 | DIVISLAB | #34 rule | 388.7 (20) | 475.7 (9) | 1.7 | ok | liquid | pending |
| 41 | SOLARINDS | #34 rule | 387.2 (21) | 728.4 (9) | 4.9 | ok | liquid | pending |
| 42 | BEL | #34 rule | 379.0 (22) | 374.5 (9) | 2.8 | ok | liquid | pending |
| 43 | TVSMOTOR | #34 rule | 378.7 (23) | 293.8 (12) | 2.5 | ok | liquid | pending |
| 44 | COFORGE | #34 rule | 378.0 (24) | 421.3 (12) | 2.1 | ok | liquid | pending |
| 45 | HINDALCO | #34 rule | 360.0 (25) | 364.9 (10) | 2.7 | ok | liquid | pending |
| 46 | TECHM | #34 rule | 347.3 (26) | 359.0 (13) | 2.1 | ok | liquid | pending |
| 47 | POLYCAB | #34 rule | 339.1 (27) | 219.9 (9) | 2.4 | ok | liquid | pending |
| 48 | VEDL | #34 rule | 321.3 (28) | 207.9 (10) | 3.0 | ok | liquid | pending |
| 49 | TEJASNET | #34 rule | 297.2 (30) | 91.9 (10) | 4.2 | ok | liquid | pending |
| 50 | NTPC | #34 rule | 281.6 (31) | 241.4 (9) | 2.0 | ok | liquid | pending |
| 51 | ULTRACEMCO | #34 rule | 279.0 (32) | 300.8 (9) | 2.9 | ok | liquid | pending |
| 52 | BAJAJ-AUTO | extension fill | 278.0 (33) | 203.4 (9) | 3.1 | ok | liquid | pending |
| 53 | KEI | extension fill | 270.7 (34) | 199.3 (9) | 3.4 | ok | liquid | pending |
| 54 | INDIGO | extension fill | 265.9 (35) | 319.3 (9) | 3.6 | ok | liquid | pending |
| 55 | HCLTECH | extension fill | 251.3 (36) | 526.4 (12) | 0.9 | ok | liquid | pending |
| 56 | HDFCAMC | extension fill | 228.2 (37) | 155.0 (10) | 2.9 | ok | liquid | pending |
| 57 | JSWSTEEL | extension fill | 214.2 (38) | 163.1 (9) | 3.1 | ok | liquid | pending |
| 58 | TRENT | extension fill | 200.2 (40) | 177.3 (9) | 3.0 | ok | liquid | pending |
| 59 | ANGELONE | extension fill | 196.9 (41) | 147.6 (12) | 2.8 | ok | liquid | pending |
| 60 | CDSL | extension fill | 190.7 (42) | 145.3 (9) | 3.2 | ok | liquid | pending |
| 61 | MAZDOCK | extension fill | 183.4 (43) | 151.9 (9) | 3.8 | ok | liquid | pending |
| 62 | BALKRISIND | extension fill | 171.5 (44) | 47.2 (9) | 5.1 | ok | liquid | pending |
| 63 | LUPIN | extension fill | 171.2 (45) | 136.8 (9) | 3.0 | ok | liquid | pending |
| 64 | DRREDDY | extension fill | 169.4 (46) | 231.7 (9) | 1.5 | ok | liquid | pending |
| 65 | BPCL | extension fill | 161.4 (47) | 150.7 (10) | 3.9 | ok | liquid | pending |
| 66 | CANBK | extension fill | 157.7 (48) | 189.8 (10) | 2.5 | ok | liquid | pending |
| 67 | LODHA | extension fill | 157.6 (49) | 179.1 (9) | 4.0 | ok | liquid | pending |
| 68 | NYKAA | extension fill | 149.8 (50) | 117.6 (9) | 3.4 | ok | liquid | pending |
| 69 | WIPRO | extension fill | 148.0 (51) | 195.2 (9) | 2.0 | ok | liquid | pending |
| 70 | BAJAJFINSV | extension fill | 131.8 (52) | 119.7 (9) | 2.9 | ok | liquid | pending |
| 71 | GAIL | extension fill | 127.1 (53) | 90.5 (9) | 3.9 | ok | liquid | pending |
| 72 | INDUSINDBK | extension fill | 122.0 (54) | 257.9 (9) | 2.6 | ok | liquid | pending |
| 73 | IDFCFIRSTB | extension fill | 118.9 (55) | 220.1 (9) | 3.0 | ok | liquid | pending |
| 74 | GODREJPROP | extension fill | 113.2 (56) | 102.6 (9) | 4.1 | ok | liquid | pending |
| 75 | INDHOTEL | extension fill | 111.5 (57) | 130.0 (9) | 3.3 | ok | liquid | pending |
| 76 | JSWENERGY | extension fill | 110.2 (58) | 81.6 (9) | 4.4 | ok | liquid | pending |
| 77 | BIOCON | extension fill | 106.0 (59) | 129.5 (9) | 2.7 | ok | liquid | pending |
| 78 | ZENTEC | extension fill | 99.9 (60) | 46.0 (10) | 4.3 | ok | liquid | pending |
| 79 | RVNL | extension fill | 98.5 (61) | 97.4 (9) | 3.3 | ok | liquid | pending |
| 80 | JINDALSAW | extension fill | 91.2 (62) | 51.3 (10) | 6.5 | ok | liquid | pending |
| 81 | INDIANB | extension fill | 87.1 (63) | 66.5 (9) | 3.5 | ok | liquid | pending |
| 82 | KPITTECH | extension fill | 83.0 (64) | 99.1 (12) | 4.0 | ok | liquid | pending |
| 83 | M&MFIN | extension fill | 72.5 (66) | 59.0 (9) | 4.5 | ok | liquid | pending |
| 84 | NEWGEN | extension fill | 71.3 (67) | 44.6 (13) | 5.6 | ok | liquid | pending |

**Measured today, from the engine's Firehose heartbeats, 25 stocks + Nifty, 77 five-minute beats a day:**
- **26 Oct:** mean 5,394 ticks per 5 minutes (18.0/s), peak 6,618.
- **27 Oct:** mean 5,913 (19.7/s), peak 7,452.
- **Stock ticks routed to the detectors** (with volume): mean 2,496 and peak 3,704 per 5 minutes on 27 Oct.
- **Index:** about 1,000 per 5 minutes.
- **Per stock:** about 0.65 ticks/s mean and 0.86/s peak, all ticks; about 0.33/s with volume.
- **Engine** (21 Oct, after the 100-symbol fix): 3.6% CPU and 120 MiB at about 19.5 messages/s.
- **Host:** t3.small, 2 vCPU, 1.9 GB RAM, no swap. 1.16 GB was available with the engine stopped; quant_api uses 108 MiB, Postgres 57 MiB, Redis 8 MiB.
| At 84 stocks + Nifty | Low (today's per-stock rate) | Peak (today's peak rate) | High (liquid F&O names tick 3× today's small caps) |
| Messages/s | ≈ 58 | ≈ 75 | ≈ 220 |
| Engine CPU, % of one vCPU (scaled from 3.6% at 19.5/s) | ≈ 11% | ≈ 14% | ≈ 41% |
| Engine memory | ≈ 150-250 MiB (linear worst case 400 MiB) | | |
| Redis operations/s (about 6 per routed tick) | ≈ 170 | ≈ 250 | ≈ 1,300 |
**Reading:**
- **CPU:** the low and peak cases are comfortable. The high case puts the engine near the t3.small's CPU-credit baseline (20% per vCPU, 0.4 vCPU in all) during market hours only. Credits earned in the other ~18 hours cover it, but measure it.
- **Memory:** fits with margin. There is no swap, so measure with `docker stats` in the first session.
- **Redis:** trivial at any of these rates.
- **Detector load:** 2 equity detectors per stock, so 168 instances (from 50). Each routed tick runs `updateVwap` and both detectors, all in-process; per-tick work does not grow with the symbol count.
- **Fires:** these scale with the number of stocks. With 25 stocks, 27 Oct logged 15 signals. At 84, expect several times that, but it is untracked.
  - **Telegram:** `TELEGRAM_MAX_ALERTS_PER_DAY` and the duplicate policy bound the alerts.
  - **Paper capital:** ₹1 lakh base with a ₹10k single-name cap allows about 10 open positions, so expect more `capital_skipped` rows.
- **Fyers:** a mid-session restart would seed 85 VWAP histories, within the seeder's 300-a-day allocation. A 09:00 boot makes no call.
