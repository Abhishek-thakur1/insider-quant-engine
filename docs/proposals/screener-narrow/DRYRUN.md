# Dry run of the §3 rule on cached data (no Fyers call)

**Inputs:**
- `dryrun.ts`, run after `DESIGN.md` was committed (`8fa528a`);
- the backtest cache, `res-D`, 90 equities, as of **2026-09-07** (7 weeks old);
- Nifty 50 as the benchmark, a substitute for Nifty 500;
- no F&O filter (unknown offline).

Output: `dryrun_output.json`.

| | Today's rule (`config/screener.json`) | §3 rule |
|---|---|---|
| After liquidity | 77 | 74 (≥ ₹25 cr and ≥ ₹50) |
| Pass the trend gate and tradability | 11 trend, 0 tradable | **10** |
| Picks (excluding core) | **0.** The 4.5% ADR gate removes every liquid name | 10 ranked |
| Already in the RULE-85 liquidity list | — | 9 of 10 |
| New picks for the 20 screener slots | — | **1** (63MOONS) |

**§3 ranking** (score = 0.4 RS + 0.2 residual + 0.2 proximity + 0.2 volume expansion):

PAYTM 97.0 · JINDALSAW 96.8 · DIVISLAB 94.9 · SOLARINDS 94.1 · MCX 84.7 · HAL 82.2 · IDFCFIRSTB 79.4 · **63MOONS 74.0** · CDSL 70.9 · KOTAKBANK 63.4

**What this shows (and doesn't):**
- **Lowering ADR from 4.5% to 1.5% is necessary.** With today's rule, a liquid universe gives an empty list.
- **The trend gate is strict:** EMA10 > EMA20 > EMA50 and SMA50 rising. On 7 Sep only 10 of 74 passed. **On weak days the 20 slots will not fill.**
  - Proposed default: unfilled slots stay **empty**, with no hand-picks and no relaxing of the gate. The watchlist is then smaller that day.
  - The alternative, the owner's call: keep yesterday's names while they hold the hysteresis rule.
- **Overlap:** the dry-run pool is the 90-name cache, and most of its liquid names are already in RULE-85, so only 1 pick is new. The real universe (about 200 F&O names) has about 120 names outside RULE-85, so the slots can fill from those. The pilot and first fill will show the real count.
- **Not a test of edge,** and not current. The cache ends 7 Sep.

## Deviations

(none yet)
