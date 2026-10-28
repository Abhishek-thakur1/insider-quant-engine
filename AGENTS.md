# AGENTS.md — Insider Quant Engine

> **Read this file completely before touching any code.**
> It is the onboarding brief for any AI agent (Claude, Gemini, Codex, Cursor, …) picking up this
> repository. It documents the architecture, **every calculation and its exact formula**, the
> signal-gating mathematics, the operational lifecycle, and a list of known defects / landmines
> that are *not* obvious from reading a single file.
>
> Branch: `v2` (created off `main` @ `7e5eec2`). `main` is the deployed state.

---

## 0. TL;DR for a new agent

| Question | Answer |
|---|---|
| What is it? | A real-time NSE (India) intraday **signal detection + alerting** engine. It does **NOT place orders**. Output = Telegram messages. |
| Language / runtime | TypeScript, ESM (`"type": "module"`), run directly via `tsx` (no build step, no `dist/`). Node 22 in Docker. |
| Entry point (live) | `src/ingestion/websocket.ts` → `startLiveEngine()` |
| Entry point (auth) | `src/config/auth.ts` (Fastify + Telegram bot, exits after writing the token) |
| `src/index.ts` | **Dead stub.** Not the entry point. Ignore it. |
| Broker / data | Fyers API v3 (`fyers-api-v3`) — REST for historical candles, WebSocket for ticks |
| State store | Redis (`redis` npm client, **not** ioredis, despite ioredis being in `package.json`) |
| Output channel | Telegram — two IDs: `TELEGRAM_ADMIN_ID` (private control) and `TELEGRAM_CHANNEL_ID` (public alerts) |
| Tests | `npm test` → 69 cases (node:test via tsx): REGIME hard gate, backtest harness, end-to-end replay, and SHORT-direction geometry regression tests (`tests/shortDirectionGeometry.test.ts`). |
| Lint / format | `npm run check` = prettier + eslint + tests. `npm run typecheck` = `tsc --noEmit --types node` (0 errors). Tabs, no semicolons, single quotes, 100 cols (`.prettierrc`). |
| Big caveat #1 | Of 26 detector classes, **8 are live**. 15 are archived under `src/detectors/deprecated/`, and 3 more are dormant but still in `src/detectors/`. See §4. |
| Big caveat #2 | Most files carry a large **commented-out previous version** at the bottom. Always confirm you are editing live code, not the archive block. |
| Backtest | `backtest/` replays historical bars through the real detectors. Read `backtest/README.md` before touching it — it depends on a virtual clock and an in-memory Redis, and it deliberately reproduces a live routing bug. |
| 🟢 Known live bug | None currently. The CE/PE equity routing bug was fixed in v2. |
| ⚠️ **Current Status** | **Alerting-only**. No execution/risk layer exists or should be built yet. No tested strategy has cleared statistical significance. JaneStreetFilter has no working swing gate (the hardcoded bypass was removed). AWS deployment is strictly for gathering out-of-sample data. |

---

## 1. Architecture

### 1.1 Process topology (`docker-compose.yml`)

```
┌───────────────────┐
│  quant_scheduler  │  alpine + crond, TZ=Asia/Kolkata, restart:always
│  (always on)      │  mounts /var/run/docker.sock → controls SIBLING containers
└─────────┬─────────┘
          │ docker start/stop
   ┌──────┴───────┬─────────────────────┐
   ▼              ▼                     ▼
┌────────────┐ ┌──────────────┐   ┌────────────────┐
│ quant_auth │ │ quant_engine │   │  redis_cache   │
│ restart:no │ │ restart:no   │   │ restart:always │
│ port 3000  │ │ (the engine) │   │ AOF everysec   │
└─────┬──────┘ └──────┬───────┘   └────────────────┘
      │               │
      └──── shared named volume `token_store` @ /app/token/access_token.txt

quant_screener  (job, compose profile "jobs", restart:no) — started by the scheduler at
16:30 on trading days; writes volume `screener_data` @ /app/data, which quant_engine
mounts and only READS (watchlist.json, watchlist_meta.json, universe_stats.json).
```

`quant_engine`'s compose `command` is a shell `until [ -f /app/token/access_token.txt ]` poll loop
(10 s) before it runs `exec node --import tsx src/ingestion/websocket.ts`. So the engine can be started before
the token exists and it will wait. **`exec node` matters (2026-10-21):** node must be PID 1 for `docker stop`'s
SIGTERM to reach `shutdown()`. Before, `sh` was PID 1, ignored SIGTERM, and every stop was a SIGKILL after
10 s (exit 137): the signals flush and Redis quit never ran. `exec npx tsx` is not enough — `npm exec`
exits on SIGTERM without waiting for its child (stub-proven). `stop_grace_period: 20s` (handler ≈ 5 s).
While the token wait loop is still running, `sh` is PID 1 and a stop still takes the full 20 s (harmless).

### 1.2 Daily lifecycle (`scheduler/crontab`, IST, Mon–Fri)

| Time | Action | Script |
|---|---|---|
Every entry checks `scheduler/trading_day.sh` first and does nothing on weekends / NSE holidays.

| Time | Action | Script |
|---|---|---|
| 07:45 | `docker start quant_auth` → sends the Telegram login link | `lifecycle.sh start_auth` |
| 09:00 | `docker start quant_engine` (waits for the token; reads the watchlist; no screening) | `lifecycle.sh start_engine` |
| 09:07 | Random "market open" message to the channel | `market_message.sh open` |
| 09:10 | Token freshness check → admin alert if missing/stale | `liveness.sh` |
| 15:17 | Random "market close" message | `market_message.sh close` |
| 15:30 | `docker stop quant_engine`, stop `quant_auth` | `lifecycle.sh stop_engine` |
| 16:00 | `pg_dump` (S3 upload currently broken — see RUNBOOK) | `db_backup.sh` |
| 16:30 | **EOD screener** → tomorrow's watchlist (§11.11) | `lifecycle.sh run_screener` |
| 17:15 | **Purge the token** (`rm` on the scheduler's own `token_store` mount) | `lifecycle.sh purge_token` |

The token is deliberately destroyed daily — Fyers access tokens are single-day. Until 2026-10-20
the purge ran at 15:30 as `docker run -v quant_token_store …`, which only reaches the compose
volume if the project is named "quant"; Oct 14's liveness found a *stale* token (not a missing
one), so it most likely never worked. It moved to 17:15 because the 16:30 screener needs the token;
nothing reads the token between 15:30 and 17:15.

### 1.3 Auth flow (`src/config/auth.ts`)

1. `fyersApi.generateAuthCode()` → login URL.
2. Telegram DM to `TELEGRAM_ADMIN_ID` with an inline-keyboard button. (The README's "biometric
   bridge" is simply: you tap the link on your phone, and the phone's biometrics unlock the Fyers
   login.)
3. `/arm` is a manual re-trigger. **Chat-ID equality is the only authorization** — non-admin
   messages are silently dropped.
4. Fyers redirects to `FYERS_REDIRECT_URI` → Fastify `GET /callback` on `0.0.0.0:3000`.
5. `generate_access_token({client_id, secret_key, auth_code})` → writes the plaintext token to
   `/app/token/access_token.txt`, confirms on Telegram, then `process.exit(0)` after 1 s.

⚠️ `sendIgnitionPing()` is called **unconditionally at module load** (~line 48); the
`cron.schedule('45 7 * * 1-5', …)` above it is commented out. Timing is owned by the host crontab
instead. So *starting the container = sending the ping.*

### 1.4 Engine boot sequence (`startLiveEngine()`)

1. Assert `/app/token/access_token.txt` and the watchlist exist, else `process.exit(1)`. The
   watchlist is `/app/data/watchlist.json` (screener v2, §11.11), falling back to the baked-in
   `./watchlist.json`; a list > 3 trading days old (or a job that never ran) is warned about.
2. `bootRedis()`.
3. `seedHistoricalVwap()` — see §3.2.
4. `activeUniverse = watchlist.slice(0, 100)` (`watchlist.json` currently holds 90 symbols, so all
   of them are taken).
5. `warnIfVwapMissing(activeUniverse)` — sequential Redis `GET` per symbol; logs a missing list.
6. Per symbol: register 3 equity detectors in `strategyRouter: Map<string, IDetector[]>`, and
   `DEL` 5 per-symbol keys (cooldowns, session open, VCP history).
7. `DEL` 9 global keys (Nifty cooldowns, bias, regime returns + cache, jsfilter log).
8. Register **one** `tickEmitter.on('processTick', …)` async handler.
9. ``fyersDataSocket.getInstance("${appId}:${token}", './logs', false)``, `autoreconnect(5)`, `connect()`.
10. Prime `lastNiftyVwap` from the seeded index value (warns loudly if the seed is missing).
11. On `connect`: `skt.subscribe([...activeUniverse, NIFTY_SYMBOL, ...subscribedOptionSymbols])`.

Graceful shutdown on SIGTERM/SIGINT: set `isShuttingDown`, `skt.close()`, wait 3 s, `redis.quit()`,
`process.exit(0)`.

### 1.5 The tick pipeline (the hot path)

**Synchronous ingestion** (`skt.on('message')`) — must never block:

```
rawMessage → JSON.parse if string
           → normalize into ticks[]  (array | {symbol,…} | {data:[…]})
           → for each tick:
               skip if !tick.symbol || !tick.ltp
               cumulativeVol  = tick.vol_traded_today || 0
               previousVol    = previousVolumeTracker.get(sym) ?? cumulativeVol   // ?? not ||
               actualTickVol  = max(0, cumulativeVol - previousVol)
               previousVolumeTracker.set(sym, cumulativeVol)                       // ALWAYS
               isIndexOrOption = sym === NIFTY || sym.includes('CE') || sym.includes('PE')
               if (!isIndexOrOption && actualTickVol <= 0) continue                // drop equity quote-only ticks
               liveTick = { price: ltp, volume: actualTickVol || 1, timestamp: Date.now() }
               tickEmitter.emit('processTick', { rawTick: tick, liveTick })
```

Things that matter here:

- The **first** equity tick of a session always yields `actualTickVol === 0` and is dropped
  (baseline priming). Intentional.
- `volume: actualTickVol || 1` — index and option ticks get **volume = 1**. This single fallback
  propagates into a lot of downstream maths (see §6.1).
- `?? cumulativeVol` (not `||`) is deliberate so a legitimately-recorded `0` isn't treated as absent.
- `tickEmitter.setMaxListeners(200)` but only **one** listener is registered; the bump is vestigial.

**Asynchronous processing** (the `EventEmitter` handler, wrapped in try/catch). Three routes:

**Route A — Nifty spot (`NSE:NIFTY50-INDEX`)**

```
updateNiftyMinuteState(ltp)                     // fire-and-forget, .catch logged
                                                //   builds a 1-min O/H/L/C candle; on close it
                                                //   pushes the return to the regime engine AND
                                                //   advances the session reference price
if (lastNiftyVwap > 0) await updateNiftyBias(ltp, lastNiftyVwap)   // cached, no Redis read
feedTick(NIFTY, ltp, liveTick.volume)           // shared 1-min candle buffer
await niftyOpeningRangeExpl.analyze(liveTick)
await niftyTrendPulse.analyze(liveTick)
await niftyVwapReclaim.analyze(liveTick)
await oiSweepDetector.analyze(liveTick)
await deltaHedgingDetector.analyze(liveTick)
await v2NiftySweepDetector.analyze(liveTick)
if (lastSubscribedNiftySpot === 0 || hasATMShifted(ltp, lastSubscribedNiftySpot)):
    newOpts = buildOptionUniverse(ltp)
    skt.unsubscribe(subscribedOptionSymbols); skt.subscribe(newOpts)
    subscribedOptionSymbols = newOpts; lastSubscribedNiftySpot = ltp
```

**Route B — options (`symbol.includes('CE') || symbol.includes('PE')`)**

```
updateOptionTick(sym, { ltp, oi, volume: vol_traded_today })
match = sym.match(/NIFTY\d{4,6}(\d{4,6})(CE|PE)$/)
if (match) deltaHedgingDetector.updateStrikeTick(sym, strike, type, ltp, oi)
```

**Route C — equities (everything else)**

```
await updateVwap(sym, price, volume)
feedTick(sym, price, volume)
await Promise.all(strategyRouter.get(sym)?.map(s => s.analyze(liveTick)) ?? [])
```

### 1.6 Signal → alert path

Every detector calls `sendTelegramAlert(payload: AlertPayload)`. `telegramWorker.ts` is the **only**
gate before Telegram:

```
sendTelegramAlert(data)
  ├─ runJaneStreetFilter(data, data.detectorName)   ← §5, the confirmation engine
  ├─ if (!passed && (hardGateRejection || !SHADOW_MODE)) → log + RETURN (dropped)
  ├─ if the filter THROWS → log error and FAIL OPEN (the alert is still sent, unfiltered)
  ├─ format message: options template vs equity-cash template
  └─ bot.telegram.sendMessage(TELEGRAM_CHANNEL_ID, msg, { parse_mode: 'Markdown' })
```

`AlertPayload` — the universal contract, memorize it:

```ts
{
  symbol: string
  price: number
  side: 'LONG' | 'SHORT'
  percentageChange: number
  volumeSpikeRatio: number
  trigger: string        // human-readable AND machine-parsed for SL/T1
  vwap: number
  avgPrice: number
  detectorName?: string  // optional; enables exact regime classification
  regimeClass?: DetectorType  // 'MOMENTUM' | 'REVERSION' | 'UNIVERSAL' — set by every
                              // ACTIVE detector; outranks name and trigger matching
}
```

**`trigger` is load-bearing, not cosmetic.** The filter regex-parses `SL ₹…` and `T1 ₹…` out of it
(§5.3) and keyword-matches it for regime classification (§5.2). Changing trigger wording can
silently change gating behaviour.

---

## 2. Repository map

```
src/
  config/
    env.ts          ENV object from dotenv; process.exit(1) if Telegram or Fyers keys are missing
    redis.ts        single shared redisClient (node-redis v5) + bootRedis()
    auth.ts         Fastify /callback + Telegram bot + token writer (its own process)
  core/types.ts     TickData, IDetector, MarketBias, VwapState, TradeSide, UniverseSymbol
  ingestion/
    websocket.ts    ★ THE LIVE ENGINE (517 lines, ~220 of them a commented archive)
    vwapSeeder.ts   pre-market historical VWAP bootstrap + token-bucket rate limiter
    universeBuilder.ts  downloads public.fyers.in NSE_CM.csv → fyersUniverse.json (ISIN INE* + -EQ)
    mockInjector.ts     100% commented out
  utils/
    vwapUtils.ts        VWAP accumulate/read + Nifty bias with hysteresis
    optionUtils.ts      Fyers option symbol builder, tick store, best-strike scorer, OI walls
    candleAggregator.ts shared 1-min OHLCV ring buffer (60 candles/symbol)
    marketStructure.ts  swing fractals → HH-HL/LH-LL, BOS/CHOCH, trend-maturity penalty
    liquidityMap.ts     equal-high/low pools, sweep-and-reclaim, untested-pool-ahead
    orderFlowProxy.ts   aggression vs absorption from body/wick/volume shape
    bayesianEngine.ts   sequential Bayesian posterior from 6 evidence sources
    regimeDetector.ts   Shannon-entropy regime + detector-type routing
    tradeLogger.ts      appends logs/shadow_trades.csv (only used by valueZoneScalpDetector)
  detectors/
    janeStreetFilter.ts ★ THE CONFIRMATION ENGINE (unified 0–100 score)
    v2/                 4 active v2 detectors
    v2/high_alpha/      BaseDetector + 3 detectors
    …19 legacy detectors (17 of them dormant — see §4.4)
  workers/telegramWorker.ts  ★ the only alert egress + the gate call
  scripts/validateWatchlist.ts  watchlist ⊆ fyersUniverse check
  types/fyers-api-v3.d.ts       one-line untyped module shim
scheduler/            crontab, lifecycle.sh, market_message.sh
watchlist.json        89 NSE:*-EQ symbols (hand-curated, mid/small-cap heavy)
fyersUniverse.json    ~2k valid -EQ symbols (generated by universeBuilder)
```

---

## 3. Every calculation, precisely

### 3.1 VWAP — live accumulation (`utils/vwapUtils.ts`)

Redis key `vwap:{symbol}:{YYYY-MM-DD-IST}` → JSON `VwapState { cumulativePV, cumulativeVol, vwap }`.
The date is `new Date(Date.now() + 5.5h).toISOString().split('T')[0]` — the IST calendar day.

```
typicalPrice = (high !== undefined && low !== undefined) ? (high + low + price) / 3 : price
cumulativePV  += typicalPrice * volume
cumulativeVol += volume
vwap = cumulativeVol > 0 ? cumulativePV / cumulativeVol : price
```

Live ticks pass no H/L → `typicalPrice = ltp` (each tick treated as its own zero-range candle).

**Session gate (branch `feat/vwap-session-gate`, not deployed; §11.25).** On that branch only data from 09:15 IST enters the VWAP: equity ticks go through `updateSessionVwap`, and Nifty minutes through `onNiftyTick` in `core/niftyMinuteState.ts`. `VWAP_SESSION_GATE=false` turns it off.
**This is a read-modify-write on Redis per tick with no atomicity.** In practice the single-listener
handler serialises around `await` boundaries, but it is not guaranteed.

### 3.2 VWAP — historical seed (`ingestion/vwapSeeder.ts`)

Per symbol: `fyersApi.getHistory({ symbol, resolution: '1', date_format: '1', range_from: today,
range_to: today, cont_flag: '1' })`. Fyers candle tuple = `[epoch, open, high, low, close, volume]`.

```
for each candle:
    typicalPrice = (high + low + close) / 3          // ← real H/L here, unlike live ticks
    cumulativePV  += typicalPrice * volume
    cumulativeVol += volume
if (cumulativeVol > 0)
    SET vwap:{sym}:{today} = { cumulativePV, cumulativeVol, cumulativePV / cumulativeVol }
```

**Rate limiter** — hand-rolled token bucket, `MAX_REQ_PER_SEC = 5`:

- `tokens` reset to `maxPerSecond` every 1000 ms by a **refed** `setInterval` (deliberately refed so
  Node cannot exit mid-drain in a standalone/cron run).
- Callers with no token available are FIFO-queued and drained on refill.
- `close()` (→ `clearInterval`) is called in a `finally` — required, or the handle leaks across runs.
- Retry: `MAX_RETRIES = 2`. Rate limiting is detected via HTTP 429 **or** `/rate.?limit/i` matching
  the error message or the serialised `response.data`. Backoff `1000 * 2^(attempt+1)` → 2 s, 4 s.

`watchlist.slice(0,100)` is seeded with real traded volume. **`NSE:NIFTY50-INDEX` is also seeded**,
via the `equalWeight` mode: NSE indices report no volume (Fyers returns 0), so a volume-weighted
VWAP is not computable for them. The index instead accumulates one unit of weight per minute at the
candle typical price — a session TWAP, not a VWAP. The live path uses the identical weighting so the
seed and the session are consistent. See §6.1 for the higher-fidelity alternative.

### 3.3 Nifty market bias (`updateNiftyBias`) — hysteresis band

```
biasPct = (niftyPrice - niftyVwap) / niftyVwap * 100
current = GET market:nifty:bias  (default 'neutral')

biasPct >  0.15                          → 'bullish'
biasPct < -0.15                          → 'bearish'
current === 'bullish' && biasPct > -0.05 → stay 'bullish'   ← hysteresis
current === 'bearish' && biasPct <  0.05 → stay 'bearish'   ← hysteresis
otherwise                                → 'neutral'
SET market:nifty:bias
```

Entry band ±0.15%, exit band ±0.05% → a 0.10% dead zone that prevents per-tick flip-flop.
Consumed by `getMarketBias()` in the Bayesian engine and by several detectors as a directional veto
(`marketBias !== 'bearish'` for LONG, etc.).

### 3.4 Shared candle aggregator (`utils/candleAggregator.ts`)

- 1-minute candles, `MAX_CANDLES = 60` closed candles per symbol (1 h of context).
- Two maps: `closedCandles: Map<symbol, Candle[]>` (oldest first) and `formingCandle: Map<symbol, Candle>`.
- Roll rule: `timestamp - current.startTs < 60_000` → update H/L/close/volume; else push and start new.
- `startTs` is the timestamp of the **first tick** of the candle → candles are **NOT clock-aligned**.
  A symbol whose first tick lands at 09:15:37 has its minute boundaries at :37.
- `getClosedCandles(sym, n)` deliberately excludes the forming candle (no repainting).
- `resetCandles()` exists but is **never called** by the engine boot cleanup.

Fed from exactly two places in `websocket.ts`: the Nifty branch and the equity branch. Consumed by
`marketStructure`, `liquidityMap`, `orderFlowProxy` — i.e. by the confirmation engine, not by detectors.

### 3.5 Market structure — BOS / CHOCH (`utils/marketStructure.ts`), max 20 pts

Swing detection — 3-candle fractal over the last 40 closed candles, keeping the last 10 swings:

```
swing high at i  ⇔  c[i].high > c[i-1].high && c[i].high > c[i+1].high
swing low  at i  ⇔  c[i].low  < c[i-1].low  && c[i].low  < c[i+1].low
```

(Note the `else if` in the loop — a candle is classified as a high or a low, never both.)

Sequence classification from the last 2 swing highs and last 2 swing lows:

```
HH && HL  → 'HH-HL' (uptrend)
LH && LL  → 'LH-LL' (downtrend)
else      → 'unclear'
```

BOS/CHOCH against the most recent relevant swing (`high` for LONG, `low` for SHORT):

```
BOS   ⇔ (LONG  && lastClose > swingHigh && sequenceAligned)
      ∨ (SHORT && lastClose < swingLow  && sequenceAligned)
CHOCH ⇔ (LONG  && lastClose < swingHigh && sequenceOpposed)
      ∨ (SHORT && lastClose > swingLow  && sequenceOpposed)
```

`bosStreak: Map<symbol, {direction, count}>` counts consecutive same-direction BOS.

Scoring (`MAX_SCORE = 20`):

| Condition | Score |
|---|---|
| `< 12` closed candles | 10 (neutral — no data, no reward, no punishment) |
| CHOCH against side | **2** |
| BOS, streak ≤ 2 | **20** |
| BOS, streak ≥ 3 | `20 × (1 − min(0.7, (streak−2) × 0.2))` → 16, 12, 8, 6 (floor) |
| No BOS/CHOCH, sequence aligned | 13 |
| No BOS/CHOCH, sequence opposed | 4 |
| Neither | 10 |

Rationale in-file: the 1st/2nd BOS is real continuation; the 5th is chasing exhaustion.

### 3.6 Liquidity map (`utils/liquidityMap.ts`), max 18 pts

Pools = clustered swing highs/lows within `POOL_TOLERANCE_BPS = 8` (0.08%, relative so it scales
from a ₹50 stock to a 25 000-point index), keeping only clusters with **≥ 2 touches**. A cluster's
price is a running midpoint `(existing + new) / 2`.

Decision order (first match wins), requires ≥ 15 closed candles:

1. `< 15` candles → **9** (neutral)
2. **Sweep-and-reclaim** — LONG: `prev.low < pool.price && last.close > pool.price`; SHORT mirrored
   → **18** (the highest-quality trigger in the module)
3. **Untested pool ahead** within 0.15% in the trade direction → **2.7** (`18 × 0.15`) — magnet/stall risk
4. **Fresh break through an untested pool** (`prev.close < pool < last.close`) → **6.3** (`18 × 0.35`)
   — unconfirmed breakout / trap risk
5. Default clear runway → **10.8** (`18 × 0.6`)

### 3.7 Order-flow proxy (`utils/orderFlowProxy.ts`), max 15 pts

No real tape (no bid/ask prints), so shape-based approximation over the last 12 closed candles:

```
bodyRatio      = |close - open| / (high - low)
upperWickRatio = (high - max(open, close)) / (high - low)
lowerWickRatio = (min(open, close) - low)  / (high - low)
avgVolume      = mean(volume of all candles except the last)
volRatio       = last.volume / avgVolume
highVolume     = volRatio >= 1.8
```

| Condition | Score |
|---|---|
| `< 6` candles | 7.5 (neutral) |
| **Aggression aligned**: `body ≥ 0.55 && highVolume && direction matches` | **15** |
| **Absorption against**: `highVolume && body < 0.4 && (LONG: upperWick ≥ 0.5 \| SHORT: lowerWick ≥ 0.5)` | **1.5** |
| highVolume but inconclusive | 9 |
| Normal volume | 6.75 |

### 3.8 Shannon-entropy regime detector (`utils/regimeDetector.ts`)

Data source: Nifty 1-min **returns**, produced in `websocket.ts` by `updateRegimeCandle`:

```
returnPct = (candle.close - candle.open) / candle.open * 100     // per 1-min Nifty candle
pushNiftyReturn(returnPct)
```

`pushNiftyReturn`:

- pushes into module-level `inMemoryReturns` (window 20, `shift()` when full) — O(1), authoritative
- fire-and-forget `LPUSH` + `LTRIM 0 19` to `regime:nifty:returns_1min` (mirror only)
- if `inMemoryReturns.length >= 8`: recompute and **`SETEX regime:nifty:current 60`**
  (an earlier version `DEL`ed the cache and thrashed Redis — do not reintroduce that)

**Entropy** — 5 fixed bins over return %:

```
bin0: v < -0.3            (strong down)
bin1: -0.3 ≤ v < -0.05    (mild down)
bin2: -0.05 ≤ v ≤ 0.05    (flat)
bin3: 0.05 < v ≤ 0.3      (mild up)
bin4: v > 0.3             (strong up)

H = -Σ p·log₂(p) over non-empty bins,  p = count / n
empty input → 2.32 (= log₂5, maximum entropy)
```

**Regime thresholds:** `H < 1.60 → trending`, `H > 2.00 → ranging`, else `transition`.
Cold start (`< 8` points) → `{ regime: 'transition', entropy: 1.8, … }`.

Also computed and carried on the state (informational, not used for gating):

```
trendingPct = count(|returns| > 0.1) / n × 100
volatility  = population stddev = sqrt( Σ(v − μ)² / n )
```

**Detector routing — precedence, strongest first:**

1. **`explicitType`** — the `regimeClass` tag on `AlertPayload`. Every active detector sets it. This
   is the only non-guessing path; prefer it always.
2. **`classifyDetector(name)`** — UNIVERSAL patterns → REVERSION patterns → MOMENTUM patterns →
   default UNIVERSAL. A safety net; the live detector names are now listed in the pattern arrays.
3. **`classifyFromTrigger(trigger)`** — lowercased keyword match
   (`exhaustion|defense|reversion|trap|wyckoff|ofe|value zone` → REVERSION;
   `breakout|momentum|vcp|parabolic|orb|sweep` → MOMENTUM; else UNIVERSAL). Legacy fallback only.
4. Default **UNIVERSAL**.

`RegimeCheckResult.classificationSource` reports which path was taken
(`'explicit' | 'name' | 'trigger' | 'default'`) and is appended to the REGIME breakdown reason, so
anything other than `explicit` is visible in `jsfilter:decisions`, `jsfilter:stats`, `trades:open`, `pnl:daily`. Guessing from trigger text was
the cause of two real misclassifications — see §6.9.

`checkRegimeCompatibility(regime, entropy, name?, trigger?)`:

| detectorType | regime | allowed | sizeMult |
|---|---|---|---|
| UNIVERSAL | any | ✅ | 1.0 |
| MOMENTUM / REVERSION | transition | ✅ | **0.5** |
| MOMENTUM | trending | ✅ | 1.0 |
| REVERSION | trending | ❌ | 0.0 |
| REVERSION | ranging | ✅ | 1.0 |
| MOMENTUM | ranging | ❌ | 0.0 |

This is a **hard gate** — a rejection here drops the alert even in shadow mode.

### 3.9 Bayesian posterior (`utils/bayesianEngine.ts`)

Sequential Bayesian update; the prior starts at **exactly 0.50** (true neutral):

```
bayesUpdate(prior, L) = clamp( L·prior / (L·prior + (1 - prior)), 0.01, 0.99 )
```

This is the odds form: `posterior_odds = L × prior_odds`, with `prior_odds = p / (1 − p)`.
Six pieces of evidence are applied **in order**, each updating the running posterior.

**E1 — Nifty VWAP bias alignment** (`getMarketBias()`)

| Case | L |
|---|---|
| aligned (LONG+bullish / SHORT+bearish) | **2.2** |
| neutral | 1.0 |
| opposing | **0.40** |

**E2 — OI wall game theory** (`getWallStrikes()`)

```
putDominance  = putWallOI  / max(callWallOI, 1)
callDominance = callWallOI / max(putWallOI, 1)
```

| Case | L |
|---|---|
| LONG && putDominance ≥ 1.4 (floor below) | **1.7** |
| SHORT && callDominance ≥ 1.4 (ceiling above) | **1.7** |
| LONG && callDominance ≥ 1.5 (long into resistance) | **0.65** |
| SHORT && putDominance ≥ 1.5 (short into support) | **0.65** |
| balanced, or no OI data | 1.0 |

Reasoning in-file: max-call-OI strike = the wall market makers are short → they sell rallies into
it; max-put-OI strike = the floor they are short → they buy dips at it.

**E3 — volume quality** (`payload.volumeSpikeRatio`, "VSR")

```
isIndexOrOptions = symbol includes 'NIFTY' | 'CE' | 'PE'
if (isIndexOrOptions && vsr <= 1.1) → L = 1.0     ← DATA-ABSENCE BYPASS, DO NOT REMOVE
vsr ≥ 10  → 2.1
vsr ≥ 5   → 1.6
vsr ≥ 2   → 1.2
vsr ≥ 1.1 → 1.0
else      → 0.80
```

The bypass exists because index/option detectors hardcode `volumeSpikeRatio: 1`. Penalising that
would punish a data limitation rather than weigh evidence. Git history shows this was a real bug fix.

**E4 — VWAP deviation zone**, using `pct = |payload.percentageChange|`, with the momentum vs
mean-reversion split inferred from **trigger text** keywords
(`OFE|Defense|Reversion|Exhaustion|Wyckoff|Trap`):

```
mean-reversion:  pct ≥ 0.4 → 1.6 ;  pct ≥ 0.2 → 1.0 ;  else 0.72
momentum:        0.1 ≤ pct ≤ 0.5 → 1.4 ;  pct > 0.5 → 0.72 ;  else 1.0
```

(The reversion "strong" branch reuses the `VOL_STRONG_LR = 1.6` constant — intentional per the
comments, but a confusing alias. Do not assume it is a bug.)

**E5 — time of day** (IST minutes)

```
prime  09:30–11:30 or 13:30–15:00 → 1.20
dead   11:30–13:30 (exclusive)    → 0.85
else                              → 1.00
```

**E6 — days-to-expiry / theta-gamma** (options symbols only; `dayOfWeek` from IST, 4 = Thursday)

```
Thu (expiry) + reversion → 0.50   |  Thu + momentum → 1.20   (gamma advantage)
Wed (1 DTE)  + reversion → 0.85   |  Wed + momentum → 1.00
other days               → 1.00
non-options              → 1.00
```

Finally `likelihoods.combined = ΠL` (logging only) and:

```
pass       = posterior ≥ 0.55        (POSTERIOR_FIRE_THRESHOLD; was 0.62, deliberately lowered)
confidence = ≥0.55 HIGH | ≥0.50 MODERATE | else LOW
```

The 0.62 → 0.55 change is documented in-file: on a fully neutral day the maximum achievable
posterior with all-neutral evidence is 0.50, so 0.62 required two simultaneous pieces of positive
evidence.

⚠️ `BayesianResult.pass` is **computed but ignored** by `janeStreetFilter`, which uses the continuous
`posterior` as a point contribution instead. The 0.55 threshold is currently dead code in the live path.

### 3.10 Option symbol math (`utils/optionUtils.ts`)

```
STRIKE_INTERVAL   = 50
STRIKES_EACH_SIDE = 7        → 7 above + 7 below + ATM = 15 strikes × 2 types = 30 symbols
ATM = round(spot / 50) * 50
```

**Symbol format**: `NSE:NIFTY{YY}{M}{DD}{STRIKE}{CE|PE}`, where the month is `1..9` for Jan–Sep and
`O`, `N`, `D` for Oct/Nov/Dec. Example: `NSE:NIFTY2541722500CE` = 17 Apr 2025, 22500 CE.

**Expiry** (`getNextThursday`): IST-shifted; `daysUntilThursday = (4 - day + 7) % 7 || 7`; if today is
Thursday and IST minutes `< 15*60+30`, today is the expiry, else roll +7 days.

`hasATMShifted(cur, last)` → `|ATM(cur) − ATM(last)| > 2 × 50` (strictly greater than 100 pts, to stop
flapping on a boundary). Triggers unsubscribe/resubscribe of the whole option universe.

`updateOptionTick` parses `NIFTY\d{4,6}(\d{4,6})(CE|PE)$` → strike + type, and maintains
`optionTickStore: Map<symbol, OptionTick>` with `prevLtp` and a 5-deep `ltpHistory` ring.

**`getBestStrike(direction, spot)`** — additive score per candidate (`same type && ltp > 0`):

```
+3  oi >= medianOI (median of the sorted OI array of same-type candidates) && medianOI > 0
+3  premium trend > 0, where trend = ltpHistory[last] - ltpHistory[0]  (needs ≥3 samples)
+2  30 ≤ ltp ≤ 500          (scalpable premium band)
+1  |strike - ATM| / 50 ≤ 2 (within 2 strikes of ATM)
```

Sort descending, take `[0]`. With no live data, fall back to ATM with `ltp: 0` and a "fallback"
reason string.

**`getWallStrikes()`** — a single O(N) pass over `optionTickStore` returning the max-OI CE strike
(`maxCallStrike`, resistance) and the max-OI PE strike (`maxPutStrike`, support) plus their OI.

⚠️ `pruneStaleStrikes(activeSymbols)` is exported but **never called** — see §6.4.

---

## 4. Detector inventory — ACTIVE vs DORMANT

This is the single most important thing to get right before editing. Only what `websocket.ts`
imports **and instantiates** actually runs.

### 4.1 ACTIVE — 5 Nifty singletons (one instance each, fed on every Nifty spot tick)

| Class | File | Candle | Core logic |
|---|---|---|---|
| `NiftyOpeningRangeExplosionDetector` | `v2/niftyOpeningRangeExplosionDetector.ts` | 3-min | OR = first 3-min candle (09:15–~09:18), locked after 1 candle. Fires when a candle **closes** > ORH+5 pts (or < ORL−5) with body ≥ 0.06%, candle direction matching, and VWAP on the correct side. Skips if range > 120 pts. SL = the opposite OR extreme ∓5; rejects risk > 80. T1 = 1.5R, T2 = 2.5R. Cooldown 2700 s. Only valid until 10:15. |
| `NiftyTrendPulseDetector` | `v2/niftyTrendPulseDetector.ts` | 3-min | 5 filters: body ≥ 0.10%; 2 consecutive same-direction closes; 2-bar HH (CE) / LL (PE); `\|VWAP dist\| ≥ 0.20%`; volume ≥ 1.5× rolling-10 average (**advisory only — annotated in the message, not enforced**). SL = min(low of last 2) − 10 for CE; rejects risk ≤ 0 or > 60. Windows 09:15–11:30 and 13:30–15:00. Cooldown 1200 s. |
| `NiftyVwapReclaimDetector` | `v2/niftyVwapReclaimDetector.ts` | 3-min | Tracks a per-candle `above`/`below` VWAP relation history. LONG when the previous 2 closes were `below` and the current closes `above`, body ≥ 0.12%, and `vwapDist ≤ 0.60%` (not already extended). SL = VWAP ∓ 8 pts; rejects risk ≤ 0 or > 50. Window 09:20–14:45. Cooldown 1500 s. |
| `OiLiquiditySweepDetector` | `oiLiquiditySweepDetector.ts` | 3-min | State machine `WAITING → PIERCED_RESISTANCE / PIERCED_SUPPORT`. Arms **intrabar** when spot ≥ maxCallStrike+15 (or ≤ maxPutStrike−15). On candle close: SHORT if close < the pierced call wall; invalidates if close > wall+30. Mirrored for support/LONG. Rejects risk > 40. T1 = 2R. Window 09:45–15:00. Cooldown 3600 s. |
| `DeltaHedgingPressureDetector` | `deltahedgingpressuredetector.ts` | per-tick epochs | Gamma-squeeze proxy — full maths in §4.2. Window 09:30–14:30. Cooldown 900 s. |

### 4.2 `DeltaHedgingPressureDetector` — the maths, in full

Fed from Route B via `updateStrikeTick(symbol, strike, type, premium, oi)`. Per-strike state:
`{ anchorPremium, anchorIndexPrice, anchorOI, velocityHistory[≤5], oiHistory[≤5] }`.

```
indexMoveSinceAnchor = |currentIndexPrice - anchorIndexPrice|
if (indexMoveSinceAnchor >= MIN_INDEX_MOVE_EPOCH = 2.0):          // noise filter
    velocity = |premium - anchorPremium| / indexMoveSinceAnchor    // |Δ| proxy
    push velocity, push oi                                        // both capped at 5
    re-anchor premium / indexPrice / oi                           // start a new epoch
```

Then on every Nifty tick, for each tracked strike:

```
CE requires index > VWAP ; PE requires index < VWAP
velocityHistory.length >= ACCELERATION_TICKS (3)
latestOI >= MIN_STRIKE_OI (50 000) and earliestOI != 0
oiGrowthRate = (latestOI - earliestOI) / earliestOI >= OI_GROWTH_THRESHOLD (0.02)
isAccelerating = the last 3 velocities are strictly increasing
latestVelocity >= PREMIUM_VELOCITY_THRESHOLD (0.65)
```

On fire: `SL = index × 0.997` (CE) / `× 1.003` (PE);
`T1 = ceil(index/50) × 50` (CE) / `floor(index/50) × 50 − 50` (PE); `T2 = T1 ± 50`.
`volumeSpikeRatio` is (ab)used to carry the velocity number into the payload.

Because `velocity` uses **absolute** premium and index moves, it is a magnitude proxy that does not
verify the premium moved in the *same direction* as the index — a collapsing premium on a rising
index still produces a positive velocity. Worth fixing if you touch this file.

### 4.3 ACTIVE — the per-equity stack (2 detectors per watchlist symbol)

**Verified 2026-10-21 against `src/ingestion/websocket.ts`:** every watchlist symbol (and every
anomaly promotion) gets exactly the two detectors built by `buildEquityStack()`. The boot banner
reads `EQUITY_STACK_NAMES` (it used to print a stale "9 detectors"); `tests/liveStack.test.ts` pins
both. Symbols whose names contain "CE"/"PE" never reach them (option-routing bug, §6.11).

| Class | File | Setups |
|---|---|---|
| `StockMomentumBreakoutDetector` | `v2/stockMomentumBreakoutDetector.ts` | 3 setups in one detector, 5-min candles |
| `VolatilityContraction` | `v2/high_alpha/VolatilityContraction.ts` | 5-min VCP, Redis-backed history |

**Unwired: `GapAndGoMomentum`** (now `src/detectors/deprecated/GapAndGoMomentum.ts`). It was the third
live equity detector until commit `e170317` (2026-09-07, "feat(janeStreetFilter): overhaul…"),
which removed its import and instantiation and moved the file, **with no reason recorded** in the
commit message or the deprecated README. Not a performance decision (no performance data existed).
Its mechanics are kept below for reference. Not re-enabled.

**`StockMomentumBreakoutDetector`.** Its header explains the design intent: it *replaces* the
former 9-detector equity stack, because 9 × 100 instances produced 50–100 alerts/day with 4–6
duplicate alerts on the same move.

Global gates: window 09:15–14:45; cooldown key `cooldown:v2:momentum:{sym}` for 1800 s;
`MIN_BLOCK_VALUE = ₹1 Cr` (`close × volume`); `history5` capped at 20 candles. The session open is
stored at `v2:session_open:{sym}` (TTL 8 h) if first seen in 09:15–09:20. The VWAP touch is tracked
**intrabar** (`dist ≤ 0.08%` of VWAP), reset when `ISTminutes % 60 === 0`.

- **Setup A — Morning Surge** (until 09:50): `closed.volume ≥ 3 × openingCandleVolume`, block-sized,
  and `close > openingCandleHigh × 1.001` (LONG, needs `bias ≠ bearish` and `close > vwap`) or
  `close < openingCandleLow × 0.999` (SHORT, mirrored).
- **Setup B — Compression Breakout**: the 3 closed candles before the current one form a box;
  `compPct = (compHigh − compLow) / compLow × 100 < 0.5`; `closed.volume ≥ 4 × compAvgVol`;
  block-sized; `bodyPct ≥ 0.1`; break `> compHigh × 1.001` (LONG) or `< compLow × 0.999` (SHORT),
  plus the VWAP side check and the bias veto.
- **Setup C — VWAP Pull + Continue**: requires `vwapTouchedThisHour` and ≥ 6 candles;
  `high30`/`low30` = extremes of the last 6 candles; `closed.volume ≥ 2.5 × avgVol6`; block-sized;
  a new 30-min extreme; and `distFromVwap ≤ 0.8%` (not overextended).

`_fire()` computes: `SL = candle.low × 0.9985` (LONG) / `candle.high × 1.0015` (SHORT);
**aborts if `risk / entry > 1.5%`**; `T1 = entry ± 1.5R`, `T2 = entry ± 2.5R`;
`percentageChange = |VWAP distance %|`; `volumeSpikeRatio = candle.volume / openingCandleVolume`.
Note `_fire` is `await`ed, but the `sendTelegramAlert` inside it is **not** awaited (fire-and-forget).

**`VolatilityContraction`** — 5-min candles, `LOOKBACK_CANDLES = 6` kept in the Redis list
`v2:vcp_history:{sym}` (LPUSH, so index 0 is the newest):

```
newerHalf = history[0..2]   (the most recent 3)
olderHalf = history[3..5]
avgRange(x) = mean(high - low) ; avgVol(x) = mean(volume)
REQUIRE newRange <= oldRange × 0.6      // ≥40% range contraction
REQUIRE newVol   <= oldVol   × 0.7      // ≥30% volume dry-up
pivotResistance = max(high of newerHalf)
FIRE if tick.price > pivotResistance && (vwap ? price > vwap : true)
        && tick.volume > newVol × 1.5   // single tick vs 5-min candle average — scale mismatch!
```

Gated by `isDailyTrendAligned('BULLISH')` → reads `HTF_TREND:{symbol}` from Redis, **fails open if
absent, and nothing in this repo ever writes that key.** Cooldown `v2:cooldown:vcp:{sym}` 3600 s.

**`GapAndGoMomentum`** — builds the opening range from ticks during 09:15–09:30, locks it at the
first tick after; active 09:30–10:15; requires `0.5% ≤ rangeSpread ≤ 2.5%`, `price ≥ vwap`,
`blockValue = price × volume ≥ ₹50 L`, and `price > orHigh × 1.002`. Hardcodes
`volumeSpikeRatio: 2.0`. Cooldown 28 800 s (8 h → effectively once per day).

`BaseDetector` (`v2/high_alpha/baseDetector.ts`) provides only `isDailyTrendAligned()` and
`triggerAlert()` (a thin `sendTelegramAlert` wrapper) plus the abstract `analyze()`.

### 4.4 ARCHIVED — moved to `src/detectors/deprecated/` (16)

See `src/detectors/deprecated/README.md` for the per-file rationale and revival steps. All 15 are
`UNTRACKED` — none was removed on measured performance, because no performance data has ever
existed in this repo.

**Tier A (14).** The 7 mean-reversion detectors: `Orderflowexhaustiondetector`,
`smartmoneydivergencedetector`, `vwapStdevReversionDetector`, `vwapPullbackDetector`,
`vwapCrossoverDetector`, `valueZoneScalpDetector`, `liquidityTrapDetector`. Plus 7 superseded:
`niftyOptionsDetector`, `morningMomentumDetector`, `candleBreakoutDetector`, `vcpDetector`,
`parabolicRvolSweepDetector`, `volumeSpikeDetector`, `equityLiquiditySweepDetector`.

**Unrecorded (1).** `GapAndGoMomentum` — unwired in `e170317` (2026-09-07) without a stated reason (§4.3).

**Tier C (1).** `NiftyLiquiditySweep` — mean-reversion *and* dead code (it read `orb:30min:high:*`,
written only by the dormant `orbDetector`). Removed from `v2/high_alpha/index.ts` and from the
engine's imports, instantiation, `analyze()` chain, and boot cleanup.

### 4.5 STILL DORMANT in `src/detectors/` — deliberately not archived (3)

- `orbDetector` — dormant, but the **sole writer** of `orb:15min:*` / `orb:30min:*`. Archiving it
  would cement a dead dependency. Dual 15/30-min ranges; the index bypasses volume/block filters.
- `Multitimeframebreakoutdetector` — momentum-biased, a revival candidate rather than a retirement.
  5-min + 15-min, 4 confluences: 3 higher lows, range < 0.4% held ≥ 10 min, 5× volume **and** ₹75 L
  block, plus a session-return relative-strength proxy.
- `liquiditySweepDetector` — "Institutional Liquidity Sniper"; structural, so outside the approved
  Tier A set (mean-reversion and superseded only). Left in place pending a decision. Also reads
  `orb:15min:*`.

Do not assume a dormant detector works.

#### Mechanics of the archived + dormant detectors (reference)

Kept so a revival decision does not require reading 17 files. Entries marked ⤵ live in
`src/detectors/deprecated/`; the three unmarked ones are still in `src/detectors/`.

- ⤵ `candleBreakoutDetector` — 5 × 1-min box, ≤ 0.8% spread, 7× volume, ₹1 Cr block, body ≥ 0.3%.
- ⤵ `equityLiquiditySweepDetector` — 3-min; 0.2% pierce of the 10:00 range; 2.5× volume; 7200 s cooldown.
- `liquiditySweepDetector` — "Institutional Liquidity Sniper"; reads `orb:15min:*`.
- ⤵ `liquidityTrapDetector` — 1-min; wick ≥ 40% of the candle range; 2.5× volume.
- ⤵ `morningMomentumDetector` — 09:20 range → break by 09:45; 2.5× volume; 0.05% buffer.
- `Multitimeframebreakoutdetector` — 5-min + 15-min; 4 confluences: 3 higher lows, range < 0.4% held
  ≥ 10 min, 5× volume **and** ₹75 L block, plus a session-return relative-strength proxy.
- ⤵ `niftyOptionsDetector` — 5-min, 3 confirms, 0.15% VWAP distance. The v2 Nifty detectors explicitly
  replace it (its header documents why it produced zero alerts).
- `orbDetector` — dual 15/30-min ranges; **the only writer of the `orb:15min:*` / `orb:30min:*` Redis
  keys**; the index bypasses the volume and block filters; volume arrays capped at 500/1000 samples.
- ⤵ `Orderflowexhaustiondetector` — 3-min; new N-candle extreme + body < 75% of the prior body +
  `|VWAP dev| ≥ 0.25%` + 1.8× climax volume; targets 50% and 100% VWAP reversion; risk band 8–30 pts.
- ⤵ `parabolicRvolSweepDetector` — 1-min, 60-candle baseline, **15×** RVOL, ₹2 Cr, day spread < 3.5%,
  7200 s cooldown.
- ⤵ `smartmoneydivergencedetector` — Wyckoff; 4 **clock-aligned** 1-min candles; HH (or LL) with ≥ 30%
  volume decline and `last < avg`; ₹5 Cr block; 4 h cooldown; T1 = VWAP, T2 = VWAP ± 0.5 × distance;
  includes a "catalyst-driven" counter-bias escape hatch.
- ⤵ `valueZoneScalpDetector` — 3-min; incremental 21-EMA with `k = 2/(21+1)`, SMA-seeded over the first
  21 candles (O(1) per candle, replacing an O(n²) full recompute); pullback into the EMA/VWAP zone.
  The only user of `tradeLogger`.
- ⤵ `vcpDetector` — tick-based 20-tick box vs 100-tick baseline; `armed:vcp:{sym}` persisted in Redis so
  the armed state survives a crash; 5× volume; ₹50 L block.
- ⤵ `volumeSpikeDetector` — 15 × 1-min baseline, **12×** spike, ₹2 Cr block.
- ⤵ `vwapCrossoverDetector` — 1-min; requires a decisive ≥ 8-point body VWAP cross.
- ⤵ `vwapPullbackDetector` — 1-min "VWAP Defense"; 0.12% tolerance band; `low ∈ [vwap − 3×tol, vwap + tol]`;
  real body ≥ 5 pts; risk ≤ 30 pts. Note `volConfirmedLong`/`volConfirmedShort` are computed and
  **never used in the firing condition**.
- ⤵ `vwapStdevReversionDetector` — 1-min; 60-candle rolling window; **O(1)** running variance
  `max(0, Σx²/n − μ²)`; ±2.5σ bands around VWAP; 2× climax volume; ₹1 Cr; the index bypasses the
  volume/block checks.

Do not assume a dormant detector works. Several are known-broken (see §6).

---

## 5. The confirmation engine (`detectors/janeStreetFilter.ts`)

This is the heart of the system's risk logic. Read the header comment in the file — it records why
v3 exists: v2 read `payload.sl`/`payload.t1`, which never existed on `AlertPayload`, so `risk`/
`reward` were `NaN` and the EV gate silently rejected (or errored past) essentially everything.

### 5.1 Design: 2 hard gates + one 0–100 additive score

Point budget (sums to exactly 100):

```
STRUCTURE  20   (marketStructure)
LIQUIDITY  18   (liquidityMap)
ORDERFLOW  15   (orderFlowProxy)
BAYESIAN   25   (posterior × 25)
REGIME     12   (12 × sizeMult)
EV_KELLY   10   (kellyPoints bucket)
```

`CONFIRMATION_THRESHOLD` = `process.env.CONFIRMATION_THRESHOLD` or **78**.
`passed = score >= threshold`. `score` is summed, rounded, and clamped to `[0, 100]`.

The redesign rationale in-file: the old design was 4 sequential hard pass/fail gates, so any single
weak gate killed an otherwise strong setup. Now only two things are hard rejects.

### 5.2 Gate 1 (hard) — REGIME

`getMarketRegime()`, then
`checkRegimeCompatibility(regime, entropy, detectorName ?? payload.detectorName, payload.trigger, payload.regimeClass)`.
Not allowed → immediate return with `rejectedAt: 'REGIME'`, `score: 0`.
Allowed → `REGIME points = 12 × sizeMult` (so 12 or 6).

`resolveStructureSymbol(payload)`: if the symbol contains `CE`, `PE`, or `NIFTY`, then structure /
liquidity / order-flow all read `NSE:NIFTY50-INDEX` candles instead of the option contract's own
price series (option premiums are theta/gamma-noisy and have no meaningful swing structure).
Otherwise the symbol itself is used.

### 5.3 Gate 2 (hard) — EXPECTED VALUE

SL and T1 are recovered by regex from the trigger string:

```
/SL[:\s]*₹?([\d,]+(?:\.\d+)?)/i     and     /T1[:\s]*₹?([\d,]+(?:\.\d+)?)/i
risk   = |price - sl|
reward = |price - t1|
accepted only if risk > 0 && reward > 0 && risk < price × 0.1 && reward < price × 0.2   (sanity bounds)
fallback: risk = price × 0.003 (0.3%), reward = risk × 1.5, rr = 1.5
```

Then:

```
EV = pWin·reward − (1 − pWin)·risk − SLIPPAGE_PTS       where SLIPPAGE_PTS = 2.0, pWin = posterior
REJECT if EV < MIN_EV_PTS (= 0)  → rejectedAt: 'EV'
```

⚠️ **`SLIPPAGE_PTS` is a flat 2.0 in absolute price units, applied to every asset class.** For a
₹200 stock with the 0.3% fallback risk (₹0.60) and a 1.5R reward (₹0.90) at `pWin = 0.5`,
`EV = 0.45 − 0.30 − 2.0 = −1.85` → always rejected. For a 25 000-point index it is negligible. This
systematically biases the gate against low-priced equities. Treat it as a known modelling flaw, not
a feature — but changing it changes fire rates a lot, so measure in shadow mode first.

### 5.4 Kelly sizing (points, not a gate)

```
fullKelly = pWin − (1 − pWin) / max(rr, 0.1)
halfKelly = max(0, fullKelly) / 2
kellyHalf = min(halfKelly, 0.05)              // hard 5% cap
effectiveKelly = kellyHalf × regimeSizeMult

kellyPoints: ≥0.03 → 10 | ≥0.015 → 6 | ≥0.005 → 3 | else 0
```

`buildPositionNote()` then labels the alert: ≥ 90 "HIGH conviction", ≥ threshold "CONFIRMED",
otherwise "below threshold", each with the half-Kelly percentage.

### 5.5 Persistence & introspection

Every decision (including rejections) is written with a Redis `MULTI`:

```
LPUSH   jsfilter:decisions {ts, symbol, side, detector, score, passed, shadowMode, rejectedAt, breakdown}
LTRIM   jsfilter:decisions 0 999
HINCRBY jsfilter:stats  fired|blocked  1
```

Helpers: `getFilterStats()`, `getRecentDecisions(n = 20)`.
Manual inspection: `redis-cli lrange jsfilter:decisions 0 49` and `redis-cli hgetall jsfilter:stats`.

### 5.6 SHADOW_MODE

`SHADOW_MODE=true` in `.env` is read **independently** in both `janeStreetFilter.ts` and
`telegramWorker.ts`. It relaxes **only** the aggregate-score threshold. `telegramWorker` keeps
`HARD_GATES = { REGIME, BAYESIAN, EV, KELLY }` and never lets those rejections through, because they
mean the trade is mathematically unsound rather than merely below a tuning cutoff.

⚠️ The filter only ever sets `rejectedAt` to `'REGIME'` or `'EV'`. `'BAYESIAN'` and `'KELLY'` in that
set are dead entries left over from the older 4-sequential-gate design.

Recommended workflow (from the file's own header): run 1–2 weeks in shadow mode, then tune
`CONFIRMATION_THRESHOLD` from the logged score distribution before enabling blocking mode. There is
no outcome data for the 3 newer modules (structure/liquidity/order-flow) or the rescored weights.

### 5.7 Fail-open behaviour

If `runJaneStreetFilter` **throws** (Redis down, etc.), `telegramWorker` logs loudly and sends the
alert **unfiltered**. This is deliberate: a bug in the confirmation layer must never silently kill
the whole alert pipeline. Preserve this property if you refactor.

### 5.8 Telegram message construction (`telegramWorker.ts`)

Two templates, chosen by `symbol.includes('CE') || symbol.includes('PE')`.

- **Options**: index level plus the trigger string with `|` split into bullet lines. SL/targets come
  from the trigger text — the worker computes nothing.
- **Equity cash**: the worker **recomputes** levels itself and ignores the detector's own SL/T1:

  ```
  stopLoss = isLong ? vwap × 0.998 : vwap × 1.002
  risk     = |entry − stopLoss|
  target1  = entry ± risk × 1.5
  target2  = entry ± risk × 2.5
  ```

  So an equity alert can display a **different SL** than the one the detector embedded in `trigger`
  and than the one the EV gate scored. Known inconsistency — do not "fix" one side in isolation.
- Both append `scoreNote`: score/100, regime + entropy, Bayesian P(win) %, EV, half-Kelly, and the
  position note.
- `parse_mode: 'Markdown'` (legacy). Unescaped `_ * [ ]` in a symbol or trigger can break rendering.

---

## 6. Known defects, landmines, and open questions

Verify before "fixing" — several are deliberate trade-offs, and the git log shows some of these were
oscillated on. Roughly ordered by impact.

> **Start with §6.11.** It is the only entry that is actively costing coverage right now: five
> liquid equities are silently dropped by the live engine and never reach a detector. Everything
> else here is a calibration or fidelity concern; that one is lost data.

### 6.1 ⚠️ PARTLY RESOLVED — Nifty VWAP was not volume-weighted and was never seeded

- Route A calls `updateVwap(NIFTY, ltp, 1)` — a literal volume of `1` per tick. With constant
  weights, `cumulativePV / cumulativeVol` degenerates into an **unweighted arithmetic mean of tick
  prices**.
- `seedHistoricalVwap()` seeds only `watchlist.slice(0,100)`, and `NSE:NIFTY50-INDEX` is not in
  `watchlist.json`. So the Nifty VWAP starts from **zero at engine boot** and is a running mean of
  ticks since 09:15, not a true session VWAP.
- Everything Nifty-side depends on it: `updateNiftyBias` → Bayesian E1; `NiftyVwapReclaim`;
  `NiftyTrendPulse` (the 0.20% distance filter); `NiftyORE` alignment; `DeltaHedging` side selection.
**Fixed:** the index is now seeded (`equalWeight` mode, §3.2) and the live value advances once per
closed 1-min candle at the typical price with weight 1 — the same weighting as the seed — instead of
once per tick with weight 1. It is a session TWAP and is documented as such, not mislabelled a VWAP.

**Still open:** a genuinely volume-weighted index reference needs volume borrowed from the Nifty
**futures** contract (a new subscription plus expiry rollover). Until then the reference is
time-weighted, which is materially better than tick-weighted but is not a VWAP.

**Still open (separate):** the equity `feedTick` volume is real, but the Nifty `feedTick` volume is
still always 1, so `orderFlowProxy` for Nifty can essentially never see `volRatio ≥ 1.8` — it
permanently returns the 6.75 "normal volume" branch for every Nifty/option alert.

### 6.2 ✅ RESOLVED — `NiftyLiquiditySweep` could never fire

It required `GET orb:30min:high:NSE:NIFTY50-INDEX`, and the only writer of `orb:30min:*` is
`orbDetector`, which is not instantiated. Archived to `deprecated/` (Tier C) rather than reviving
the dependency. `orb:*` is now written by nothing and read by nothing in the live path.

### 6.3 ⚠️ PARTLY RESOLVED — `VolatilityContraction`'s HTF filter is inert

`isDailyTrendAligned('BULLISH')` reads `HTF_TREND:{symbol}`, and no code in this repo writes that key.
It fails open by design ("so you don't miss trades"), so the daily-trend filter documented in the
class is **still effectively off** — nothing writes `HTF_TREND:*`.

**Fixed:** the volume check used to compare a **single tick's** volume against a **5-min candle
average** (`tick.volume > newVol × 1.5`), a ~300× scale mismatch that made the condition
unsatisfiable. Both sides now read the closed 5-min candle, and the pivot is computed from
`history[1..3]` so the breakout candle is no longer part of the box it has to clear.

### 6.4 Stale option strikes are never pruned

`pruneStaleStrikes()` is exported and never invoked, and nothing clears `optionTickStore` when
`hasATMShifted` rolls the subscription. `getWallStrikes()` (→ Bayesian E2, `OiLiquiditySweep`) and
`getBestStrike()` therefore include contracts that stopped ticking, potentially many strikes away.
Fix: call `pruneStaleStrikes(newOpts)` right after the resubscribe in Route A.

### 6.5 The weekly expiry day is hardcoded to Thursday

`getNextThursday()` and Bayesian E6 (`dayOfWeek === 4`) both assume Thursday weekly expiry. NSE has
changed the Nifty weekly-expiry weekday since these were written. **Verify the current NSE expiry
weekday before trusting option symbol construction** — a wrong expiry produces symbols that simply
never tick, which silently disables every option-routed detector with no error anywhere.

**Confirmed 2026-10-20** against the public Fyers symbol master (`public.fyers.in/sym_details/NSE_FO.csv`):
the listed Nifty expiries were 27 Oct (monthly, symbol form `NSE:NIFTY26OCT<strike>CE`), 3 Nov, 9 Nov
(Monday — 10 Nov is a holiday), 17 Nov and 1 Dec: **Tuesday weeklies**, shifted earlier on holidays.
On Monday 19 Oct `getNextThursday()` built `NSE:NIFTY26O22<strike>CE/PE`, which does not exist, so the
30 "Subscribed strikes" never tick. Consequences: `getWallStrikes()` is always empty (Bayesian E2 is
always "OI wall data unavailable", L=1.0), `OiLiquiditySweepDetector` can never arm, and
`DeltaHedgingPressureDetector` never receives strike ticks. Separately, the strike regex in
`websocket.ts` (`/NIFTY\d{4,6}(\d{4,6})(CE|PE)$/`) matches only all-digit symbols (Jan–Sep weeklies)
and even then mis-parses the strike: `NSE:NIFTY2641423100CE` → strike **3100** (greedy expiry group).
Oct/Nov/Dec weeklies (`O`/`N`/`D` month codes) and monthlies (`NIFTY26OCT…`) never match. Fix = expiry
from the symbol master and a symbol parser that uses it (§10, step 4).

### 6.6 Redis GET/SET on the tick hot path

Per Nifty tick: `updateVwap` (GET+SET) and `updateNiftyBias` (GET+SET). Per equity tick: `updateVwap`
(GET+SET) plus a per-detector cooldown GET. Across 90 symbols this is thousands of round-trips per
second in an active market. `regimeDetector` already moved to an in-memory buffer with Redis as a
mirror — that is the pattern to follow. Also, `warnIfVwapMissing` does 100 sequential GETs at boot
(use `MGET`).

### 6.7 Candles are not clock-aligned

All detectors (except `smartmoneydivergencedetector`, which floors to
`Math.floor(now / 60000) * 60000`) start a candle at the first tick they see and roll on elapsed
duration. Consequences: a mid-session restart re-phases every candle; different detectors on the same
symbol have different bar boundaries; and `candleAggregator` bars do not line up with Fyers 1-min
candles or with any chart you would compare against.

### 6.8 Cold-start scoring makes the first ~15–20 minutes unfireable

With `< 12` candles: structure = 10, liquidity = 9 (needs 15), order flow = 7.5 (needs 6). Regime with
`< 8` returns = `transition` → REGIME = 6. Floor before Bayesian/Kelly = **32.5**. Add `25 × posterior`
(max 25) and up to 10 Kelly points → the theoretical maximum in the first ~15 minutes is about **67**,
i.e. **below the 78 threshold**. Practically, nothing fires early in the session regardless of setup
quality. If that is not intended, either warm the aggregator from `getHistory` at boot, or scale the
threshold by data availability.

### 6.9 ✅ RESOLVED — the REGIME hard gate was driven by alert copy

No detector passed `detectorName`, so `checkRegimeCompatibility` always fell through to
`classifyFromTrigger` — fuzzy keyword matching on emoji-laden Telegram copy. Two confirmed
consequences:

- **The entire live momentum stack classified UNIVERSAL.** None of `Stock Momentum Breakout`,
  `Nifty Opening Range Explosion`, `Nifty Trend Pulse`, `Gap_And_Go_V2` or
  `Volatility_Contraction_V2` matched any MOMENTUM pattern, and `classifyDetector`'s default is
  UNIVERSAL — so regime suppression never applied to any of them. Momentum signals fired at full
  size in high-entropy ranging markets, which is precisely the "fires then immediately reverses"
  failure mode `regimeDetector.ts`'s own header describes.
- **`OiLiquiditySweepDetector` classified REVERSION.** Its trigger contains "Trap", so an
  intentionally UNIVERSAL detector was suppressed in trending regimes.

Fixed by the explicit `regimeClass` tag (§3.8), with the live names added to the pattern arrays as a
safety net and `classificationSource` exposed so any future silent fallback shows up in
`jsfilter:decisions`, `jsfilter:stats`, `trades:open`, `pnl:daily`. Covered by `tests/regimeGate.test.ts`, including a regression test for each.

**Behaviour change to watch:** four detectors moved UNIVERSAL → MOMENTUM, so they are now suppressed
in `ranging` and half-sized in `transition`; `OiLiquiditySweep` moved REVERSION → UNIVERSAL, so it
stops being suppressed in `trending`. Expect fewer equity/Nifty momentum alerts in chop and more OI
sweep alerts in trends.

### 6.10 Smaller items

- `SLIPPAGE_PTS = 2.0` flat across all asset classes — §5.3.
- `BayesianResult.pass` / `POSTERIOR_FIRE_THRESHOLD = 0.55` are dead in the live path — §3.9.
- `rejectedAt` never becomes `'BAYESIAN'` or `'KELLY'` — §5.6.
- Equity SL is computed twice, differently (detector `trigger` vs worker template) — §5.8.
- `vwapPullbackDetector`: `volConfirmedLong`/`volConfirmedShort` computed, never used in the `if`.
  (Now archived; eslint reports both.)
- `NiftyTrendPulse`: `isVolConfirmed` only annotates the message; it is not a filter.
- `GapAndGoMomentum`: ✅ `openingVolume` is now the per-minute volume baseline (it used to be
  accumulated and never read, with a hardcoded `volumeSpikeRatio: 2.0` sent instead). **Still open:**
  if the engine boots after 09:30, `orHigh === 0` → a permanent early return for that symbol all day.
- `VolatilityContraction`: the cooldown `GET` happens **after** the `LPUSH`/`LTRIM` of history, so the
  history keeps mutating during cooldown (probably harmless, but not what the comment implies).
- `candleAggregator.resetCandles()` and `marketStructure.resetStructure()` are never called at boot.
- `redisClient.set(NIFTY_BIAS_KEY, bias)` has no TTL; boot cleanup `DEL`s it instead.
- `resetVwap(symbol)` deletes `vwap:{symbol}` — it is missing the `:{date}` suffix, so it deletes nothing.
- `ioredis`, `bullmq`, `nodemailer`, `pdfkit`, `node-cron` are in `package.json` but unused in the live
  path. There is no BullMQ queue and no RabbitMQ, despite the README's "Message Queue: RabbitMQ".
- ✅ `tsconfig.json` still sets `"types": []`, but `npm run typecheck`
  (`tsc --noEmit --types node`) now exists and reports **0 errors** across the repo.
- ✅ `eslint.config.js` had a stray `s` token (`sourceType: "module", s`) that threw
  `ReferenceError: s is not defined` on load, so `npm run lint` and `npm run check` had **never
  run**. Fixed; its `semi` rule (which contradicted `.prettierrc`) was replaced with
  `eslint-config-prettier`. 9 errors remain, all pre-existing: 2 in the dead `src/index.ts` stub and
  7 in `deprecated/`.
- The `Dockerfile` installs `pm2` globally, but the active compose command uses `npx tsx`. PM2 appears
  only in commented-out compose blocks.
- `lifecycle.sh stop_engine` purges the volume `quant_token_store` while compose declares `token_store`
  — those only match if the compose project name is `quant`. Verify on the host.
- The README's `.env` sample has two `PORT=3000` lines and calls the secret `FYERS_APP_SECRET`, while
  `env.ts` actually reads `FYERS_SECRET_ID`.
- `.gitignore` covers `.env`, `logs/`, `access_token.txt`. The token is written in **plaintext** to a
  Docker volume, and `env.ts` holds secrets in a plain exported object.

### 6.11 🔴 LIVE BUG — five equities are silently dropped by option routing

`websocket.ts:223` classifies a tick as an option with a bare substring test:

```ts
if (rawTick.symbol.includes('CE') || rawTick.symbol.includes('PE'))
```

Five watchlist symbols contain those letters inside the **company name**, so they are routed into
the option branch:

```
NSE:RELIANCE-EQ   NSE:ULTRACEMCO-EQ   NSE:CEATLTD-EQ   NSE:BAJFINANCE-EQ   NSE:KAJARIACER-EQ
```

For those five, in production: `updateVwap` is never called, `feedTick` is never called,
`strategyRouter` is never consulted — **all three equity detectors never run** — and
`isIndexOrOption` at line 290 is also true, so their zero-volume ticks are not filtered and tick
volume falls back to 1. Three of the five are among the most liquid names in the watchlist.

The same substring test appears in `janeStreetFilter` (structure symbol resolution),
`bayesianEngine` (volume bypass and the DTE evidence) and `telegramWorker` (message template),
so even if routing were fixed those would still misclassify.

The correct test needs a strike: `/\d{3,}\s*(CE|PE)$/`. Both the faithful and the correct
version live in `backtest/core/symbolClass.ts`, with a test pinning the five affected symbols.
**Not yet fixed** — found during backtest work, whose guardrails forbid modifying `websocket.ts`.
---

## 7. Redis key reference

| Key | Type | TTL | Writer | Reader |
|---|---|---|---|---|
| `vwap:{symbol}:{YYYY-MM-DD}` | JSON `VwapState` | none | `updateVwap`, `vwapSeeder` | `getVwap`, `warnIfVwapMissing` |
| `market:nifty:bias` | `bullish\|bearish\|neutral` | none | `updateNiftyBias` | `getMarketBias` |
| `regime:nifty:returns_1min` | list of return % | none | `pushNiftyReturn` (mirror) | engine boot on a **same-day restart** only: `restoreRegimeReturns` re-loads it into memory (§11.17) |
| `engine:boot_day` | IST date of the last engine boot | 7 d | boot cleanup (`core/bootCleanup.ts`) | boot cleanup: same day → keep session state; older/missing → clear it (§11.17). **Never cleared at boot.** |
| `regime:nifty:current` | JSON `RegimeState` | 60 s | `pushNiftyReturn`, `getMarketRegime` | `getMarketRegime` |
| `jsfilter:decisions` | list, capped at 5000 | none | `persistDecision` | `getRecentDecisions`. Each record has its own `ts`. **Never cleared at boot** (since 2026-10-20). |
| `jsfilter:stats:{IST-date}` | hash `fired`/`blocked` | 30 d | `persistDecision` | `getFilterStats`. Per-day bucket, so a restart can't reset it. Replaces the un-dated `jsfilter:stats`. |
| `fyers:quota:{IST-date}` | hash `used:<job>`, `breaches`, `exhausted`, `cooldownUntil` | 3 d | `RedisLedger` (src/fyers/quota.ts) — screener container, engine seeder + anomaly promotions | the quota gate before every Fyers Data-API call. **Never cleared at boot.** (The owner-PC backtest keeps its own `backtest/data/quota-ledger.json`.) |
| `engine:restarts:{IST-date}` | counter | 2 d | watchdog trip in `websocket.ts` (INCR before exiting) | engine boot (restart backoff), `sessionGuard.decideTrip` (limit 6/day). **Never cleared at boot.** |
| `cooldown:v2:nifty_pulse` | flag | 1200 s | NiftyTrendPulse | itself |
| `cooldown:v2:vwap_reclaim` | flag | 1500 s | NiftyVwapReclaim | itself |
| `cooldown:v2:nifty_ore` | flag | 2700 s | NiftyORE | itself |
| `cooldown:oi_sweep` | flag | 3600 s | OiLiquiditySweep | itself |
| `cooldown:delta_squeeze` | flag | 900 s | DeltaHedging | itself |
| `cooldown:v2:momentum:{sym}` | flag | 1800 s | StockMomentumBreakout | itself |
| `v2:session_open:{sym}` | price | 8 h | StockMomentumBreakout | itself |
| `v2:cooldown:vcp:{sym}` | flag | 3600 s | VolatilityContraction | itself |
| `v2:vcp_history:{sym}` | list, 6 candles | none | VolatilityContraction | itself |
| `v2:cooldown:gapgo:{sym}` | flag | 28 800 s | GapAndGoMomentum | itself |
| `orb:{15\|30}min:{high\|low}:{sym}` | price | 8 h | **`orbDetector` (dormant)** | nothing in the live path (was NiftyLiquiditySweep, now archived) |
| `HTF_TREND:{sym}` | `BULLISH\|BEARISH` | — | **nothing** | `BaseDetector.isDailyTrendAligned` |
| `alert:sent:{IST-date}:{detector}:{symbol}` | timestamp (SET NX) | 36 h | `alertPolicy.reserveAlertSlot` | itself — one Telegram alert per detector+symbol per day. Nifty option symbols dedup on `NIFTY`. **Never cleared at boot.** |
| `diag:nifty:{IST-date}` | list of JSON "why no alert" records | 36 h | `detectorDiagnostics.noteBlocked` (Nifty ORE, Trend Pulse, VWAP Reclaim) | observation only; LTRIM to 900 (3 detectors × 300), ≤ 300 records per detector per day. Kill switch `NIFTY_DIAG_ENABLED=false`. **Never cleared at boot.** |
| `alert:count:{IST-date}` | counter | 36 h | `alertPolicy.reserveAlertSlot` | itself — daily cap. **Never cleared at boot.** |
| `alert:sym:{IST-date}:{LONG\|SHORT}:{symbol}` | JSON `{ts, positionId}` (SET NX; stale holder replaced by Lua compare-and-set) | 36 h | `alertPolicy.claimSymbolSide` (alert side, just after the per-detector slot is claimed; the slot is handed back if this claim loses) | itself — one alert per symbol + side while the first alerted position is open, else 60 min (§11.18). Given back (compare-and-delete) when no alert went out. Options dedup on `NIFTY`. **Never cleared at boot.** |
| `paper:sym:{IST-date}:{LONG\|SHORT}:{symbol}` | JSON `{ts, positionId}` | 36 h | `alertPolicy.claimSymbolSide` (before `registerTrade`) | itself — the losing fire's paper and signals rows are flagged `duplicate_signal` (§11.18). **Never cleared at boot.** |
| `trades:open` | hash `<position id>` → JSON `OpenPosition` | none | `positionTracker.registerTrade` (and again with `dbId` after the INSERT) | `positionTracker.init` at boot. Id = `trade_<ms>_<symbol>_<detector slug>_<6 hex>` since 2026-10-22 (§11.19); legacy `trade_<ms>_<symbol>` entries still load. The id is opaque: nothing parses it. **Never cleared at boot.** |
| `ema_shadow:nifty:bars5` | list of closed 5-min Nifty candles (JSON `{t,o,h,l,c}`), capped at 1,500 | none | `NiftyEmaShadow` (`redisBarStore`) | itself at boot — EMA warm-up history. **Never cleared at boot** (listed in the boot-cleanup comment). |

> **2026-10-06:** cooldown keys (`cooldown:*`, `v2:cooldown:*`, `v2:session_open:*`) are **no
> longer deleted at boot or on anomaly promotion**. They are TTL'd (≤ 8 h), so yesterday's have
> expired by morning; deleting them let every watchdog restart re-arm the same setups.
| `session_open:{sym}` | price | 8 h | Multitimeframebreakout (dormant) | itself |
| `armed:vcp:{sym}`, `memory:vcp:*`, `baseline:vcp:*` | flag / lists | 8 h / none | vcpDetector (dormant) | itself |

Boot cleanup (`core/bootCleanup.ts`, day-aware since 2026-10-22, §11.17):
- **Every boot:** deletes `jsfilter:stats` (the legacy un-dated hash only).
- **New-day boot** (`engine:boot_day` missing or older than today, IST): also deletes `market:nifty:bias`, `regime:nifty:returns_1min`, `regime:nifty:current`, `pnl:daily` and **every** `v2:vcp_history:*`, including symbols no longer on the watchlist.
- **Same-day restart:** keeps all of them, and re-loads the regime returns into memory.
- **Never deleted:** cooldown and session-open keys. They are TTL'd, and anomaly promotion no longer deletes anything either.

> **2026-10-20:** `jsfilter:decisions` is **no longer deleted at boot**, and stats moved to per-day
> `jsfilter:stats:{IST-date}`. A mid-session watchdog restart used to wipe the day's filter evidence
> (the Oct 16 anomaly). `engine:restarts:{IST-date}` is deliberately not cleaned either: it is the
> restart budget. (Until 2026-10-22, `pnl:daily` and `market:nifty:bias` were still reset by every
> restart; the day-aware cleanup, §11.17, fixed that.)

> **2026-10-18:** `trades:open` is **no longer deleted at boot**. The delete ran *after*
> `positionTracker.init()` had loaded it, so every position still open at the next boot was lost
> from Redis and left `OPEN` in Postgres forever (the ghost rows). Now `init()` keeps same-day and
> SWING positions, and marks prior-day INTRADAY ones `ORPHANED` (§14) instead of closing them at the
> next session's price. No live detector emits SWING today, so in practice everything is INTRADAY.

It does **not** clear `vwap:*` (correct — the seeder owns those), `orb:*`, `HTF_TREND:*`, or the
in-memory `optionTickStore` / `candleAggregator` / `bosStreak` (irrelevant on a fresh process, but
relevant if you ever add hot reload).

---

## 8. Environment variables

```env
PORT=3000
FYERS_APP_ID=...            # required, else process.exit(1)
FYERS_SECRET_ID=...         # required   ⚠️ the README calls this FYERS_APP_SECRET — env.ts reads FYERS_SECRET_ID
FYERS_REDIRECT_URI=http://<elastic-ip>:3000/callback   # required, must match the Fyers app config exactly
FYERS_PIN=                  # read into ENV, never used
TELEGRAM_BOT_TOKEN=...      # required
TELEGRAM_CHANNEL_ID=-100... # required — public alert channel
TELEGRAM_ADMIN_ID=...       # private control DM (NOT in the fail-fast check)
REDIS_HOST=redis_cache
REDIS_PORT=6379
SHADOW_MODE=false           # read directly via process.env in janeStreetFilter + telegramWorker
CONFIRMATION_THRESHOLD=78   # read directly via process.env in janeStreetFilter
SUBSCRIPTION_CAP=100        # data-socket symbol cap checked at engine boot (Fyers Standard = 100); invalid → 100
NIFTY_OPTIONS_ENABLED=false # subscribe Nifty option strikes (30); off until the Thursday→Tuesday expiry fix
EMA_SHADOW_ENABLED=true     # Nifty EMA study in shadow (no alerts/filter/trades); 'false' turns it off
EMA_SHADOW_DIR=/app/data/ema_shadow  # JSONL output, one file per IST day (screener_data volume)
```

`env.ts` hard-fails (`process.exit(1)`) if `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`,
`FYERS_APP_ID`, `FYERS_SECRET_ID`, or `FYERS_REDIRECT_URI` is missing. `SHADOW_MODE` and
`CONFIRMATION_THRESHOLD` bypass `ENV` and read `process.env` directly.

---

## 9. Working conventions for agents on this repo

1. **Check whether the file you are editing is live.** Grep `src/ingestion/websocket.ts` for the class
   name first. Editing a dormant detector produces zero behavioural change.
2. **Ignore the commented archive blocks** at the bottom of most files. They are previous versions kept
   as history. Do not update them in parallel, and do not resurrect them without reading §6.
3. **`trigger` strings are an interface.** The filter parses `SL ₹…` / `T1 ₹…` and keyword-matches for
   regime/reversion classification. A new detector must emit `SL ₹X` and `T1 ₹Y` in the trigger, or it
   gets the 0.3%/1.5R fallback and probably an EV rejection.
4. **Always set `regimeClass` AND `detectorName`** on `AlertPayload`. `regimeClass` is the only
   non-guessing path through the REGIME hard gate; name matching is a safety net and trigger-text
   matching is a legacy fallback that has already caused two real misclassifications (§6.9). If you
   add a detector without a tag, its `classificationSource` will read `name`/`trigger`/`default` in
   `jsfilter:decisions` — treat that as a bug.
5. **Never block the synchronous socket handler.** All I/O belongs behind `tickEmitter`.
6. **Preserve the fail-open property** of the filter call in `telegramWorker`.
7. **Never remove the index/options VSR bypass** in Bayesian E3 or the `volume: actualTickVol || 1`
   fallback in ingestion without tracing every consumer — both were bug fixes and both are currently
   load-bearing.
8. **Changing any threshold changes fire rate non-linearly.** Set `SHADOW_MODE=true`, collect
   `jsfilter:decisions` for a few sessions, and reason from the logged score distribution.
9. **New Redis keys** must be added to the boot cleanup in `websocket.ts` and to §7 here.
10. **Formatting**: run `npm run check` (prettier + eslint) before finishing. Note that the `v2/` and
    `v2/high_alpha/` directories use 4-space indent and semicolons while the rest of the repo uses tabs
    and no semicolons — match the file you are in.
11. **Tests: `npm test`** runs `tests/**/*.test.ts` with `node:test` via `tsx` — currently 14 cases
    over the REGIME gate. Note that importing anything under `src/` pulls in `config/env.ts`, which
    calls `process.exit(1)` on missing credentials, so a test must set dummy env vars **before** a
    dynamic `import()` — see the header of `tests/regimeGate.test.ts`. If you change maths, add
    cases: `getStructureScore`, `getLiquidityScore`, `getOrderFlowScore`, `getBestStrike` and
    `buildOptionSymbol` are already pure and exported. `computeShannonEntropy`, `bayesUpdate`,
    `computeEV` and `computeKelly` are pure but **not exported** — export them to test them.
12. **This engine sends alerts; it does not trade.** There is no order placement, position tracking,
    P&L, or outcome labelling anywhere. Every "win rate" and every `L=` constant in the comments is an
    **assumption**, not a measured or back-tested value. Do not present them as validated. Building an
    outcome logger (fire → SL/T1 → label) is the highest-value missing piece; without it, none of the
    Bayesian likelihood ratios or the score weights can be calibrated.

---

## 10. Suggested next steps (v2 roadmap candidates)

Priority order, based on the analysis above:

**Landed on `v2` already:** the approved pruning (15 detectors archived, §4.4), the Nifty VWAP
seed + minute weighting (§6.1), the explicit regime class (§6.9), candle confirmation for
`VolatilityContraction` and `GapAndGoMomentum` (§6.3), and working lint/typecheck/test scripts.

0. **Fix the CE/PE substring routing** (§6.11) — five liquid equities are currently dead in the
   live engine. Smallest change, largest effect, and it invalidates any equity backtest run
   before it lands.
1. **Run the backtest on real data.** The harness exists (`backtest/`) and is verified; it needs
   a Fyers token and an overnight fetch. That produces the outcome data every constant in §3.9
   and §5.1 currently lacks. On synthetic data the filter passed 0 of 953 signals, so the gate's
   real pass rate is the first thing to measure.
2. **Volume-weight the Nifty reference properly** (§6.1) — borrow volume from the Nifty futures
   contract, or keep the TWAP and rename the accessor so nothing reads it as a VWAP.
3. **Verify the NSE weekly expiry weekday** (§6.5) and make it configurable rather than hardcoded.
4. **Write `HTF_TREND:*` or delete the filter that reads it** (§6.3) — it fails open, so the
   daily-trend gate on `VolatilityContraction` is documented but off.
5. **Call `pruneStaleStrikes`** after every option resubscribe (§6.4).
6. **Make slippage relative** (basis points of price) instead of a flat 2.0 (§5.3).
7. **Reconcile the two equity SL computations** (§5.8) so the level scored by the EV gate is the level
   sent to the user.
8. **Clock-align candles** and/or warm `candleAggregator` from historical candles at boot, which also
   fixes the cold-start scoring floor (§6.7, §6.8).
9. **Cut Redis hot-path traffic** — in-memory VWAP/bias with periodic Redis mirroring, `MGET` at boot
   (§6.6).
10. **Delete or archive the 17 dormant detectors** and the commented archive blocks, so the live
    surface area is unambiguous.

---

## 11. State of the `v2` branch — read this to catch up

`main` is the deployed engine and has **not** been touched. Everything below is on `v2`.

### 11.1 What changed, in order

| Commit | What landed |
|---|---|
| `0f1f8b3` | This file — the initial full codebase brief. |
| `7843312` | **Pruning.** 15 detectors moved (`git mv`, history intact) to `src/detectors/deprecated/`. Live count 9 → 8. |
| `0e9fec5` | Style-only: normalized the `v2/` detector tree to `.prettierrc`. Kept separate so the next commit was reviewable. |
| `315cda9` | **Three root-cause fixes** (below), plus working lint/typecheck/test scripts. |
| `cc391a1` | **Backtest harness** under `backtest/`. |
| `54c4886` | Recorded the live CE/PE routing bug (§6.11). |

### 11.2 The three root-cause fixes in `315cda9`

Each was a real defect, confirmed by reading the code rather than inferred:

1. **Nifty VWAP** — was updated per tick with a hardcoded weight of `1`, which collapses
   algebraically to an unweighted mean of tick *prices*; and the index was never seeded, so the
   reference started at zero every boot. Now seeded and advanced once per closed minute at the
   candle typical price. Still a TWAP, not a VWAP — indices report no volume (§6.1).
2. **Regime classification** — no detector passed `detectorName`, so the REGIME **hard gate** was
   decided by keyword-matching emoji-laden alert copy. Two consequences: the entire momentum
   stack silently classified `UNIVERSAL` (so regime suppression never applied to it), and
   `OiLiquiditySweep` classified `REVERSION` because its trigger contains "Trap". Fixed with an
   explicit `regimeClass` tag that outranks both fallbacks (§3.8, §6.9).
3. **Tick vs candle confirmation** — audited all 8 active detectors. Five already confirmed on
   candle close. `DeltaHedgingPressure` is tick-level by design. Two were genuinely broken and
   are fixed: `VolatilityContraction` compared one tick's volume to a 5-minute average (~300×
   scale mismatch) and computed its pivot from a window that included the breakout candle;
   `GapAndGo` tested a ₹50L block against a single print.

**Behaviour change to expect from #2:** four detectors moved `UNIVERSAL → MOMENTUM`, so they are
now suppressed in `ranging` and half-sized in `transition`. `OiLiquiditySweep` moved
`REVERSION → UNIVERSAL`, so it stops being suppressed in `trending`. Fewer momentum alerts in
chop, more OI-sweep alerts in trends.

### 11.3 What is verified, and what is not

**Verified:** `npm run typecheck` → 0 errors. `npm test` → 69/69. `npm run lint` runs (9 errors
remain, all pre-existing: 2 in the dead `src/index.ts` stub, 7 in `deprecated/`). The backtest
replays 40 synthetic sessions / 75,000 bars / 300,000 ticks / 953 signals in ~14s with real
detectors firing through the real gating chain.

**Not verified:** nothing has been run against live market data or a real Redis. This development
machine has no `.env`, no Fyers token, no Redis and no Docker. In particular the Nifty VWAP fix
and the regime re-classification are **correct by reading, not by observation** — confirm both on
a live session.

**No performance data exists for any detector.** Not one number in this repo is measured. Every
`L=` likelihood ratio in §3.9, every point weight in §5.1 and every "win rate" in a code comment
is an assumption. `backtest/output/sample-report.html` is generated from a sine wave and is
banner-marked as such. Do not present any of it as a result.

### 11.4 Open questions awaiting the user

Do not decide these unilaterally:

1. **`src/detectors/liquiditySweepDetector.ts`** — dormant and structural, so it fell outside the
   approved Tier A set (mean-reversion and superseded only). Left in place pending a call.
2. **Sequencing** — the Qullamaggie momentum suite (`docs/qullamaggie-spec-v2.md`) versus running
   the backtest first. The backtest is what makes any threshold in that suite calibratable rather
   than guessed, which argues for doing it first, but the user has not confirmed the order. The
   suite is specified and unbuilt; several of its inputs (market cap, daily candles, benchmark
   indices, order-book depth, circuit bands, account equity) have no source in the repo at all.
3. **The 16 archived detectors** are archived, not deleted, specifically so the backtest can
   still import them. Deleting them needs explicit approval and would end that option.

### 11.5 Documentation map

| File | Purpose |
|---|---|
| `AGENTS.md` | **This file. Single source of truth.** Architecture, every formula, the gating maths, defects, conventions. |
| `CLAUDE.md`, `GEMINI.md` | Thin pointers here, plus the non-negotiables. Deliberately short — do not duplicate content into them. |
| `README.md` | Human-facing project overview and how to run it. |
| `backtest/README.md` | The harness: isolation guarantees, virtual clock, assumptions, fidelity gaps. |
| `src/detectors/deprecated/README.md` | Why each of the 16 archived detectors was archived, and how to revive one. |
| `docs/qullamaggie-spec-v2.md` | The source-verified spec for a momentum suite that is **not built**. Carries the repo's status, what the revision corrects versus the earlier version, and the data blockers a builder hits immediately. |

If you change behaviour, update `AGENTS.md` in the same commit. A stale brief is worse than no
brief, because the next agent will trust it.

## 11.7 Telegram alert policy (2026-10-06)

Code: `src/workers/alertPolicy.ts` (pure, tested in `tests/alertPolicy.test.ts`), called from
`telegramWorker.ts`. **Alert policy affects Telegram only — recording to Postgres is unchanged and
happens before any alert decision.**

| Rule | Behaviour |
|---|---|
| Gated only | Only `decision.passed === true` is sent. A filter **error** records the trade as ungated and sends nothing (this replaces the old "fail open = send unfiltered"). |
| Capital | Full skip (`actualSize = 0`) → never sent. REDUCE → normal alert with the reduced qty; no capital wording anywhere in the channel. |
| Dedup | One alert per detector + symbol per IST day (`alert:sent:*`, survives restarts). |
| One per symbol + side (2026-10-22, §11.18) | A second fire on the same symbol + side, from any detector, is a duplicate if the first alerted position is still open, or if it was alerted less than 60 min ago (`alert:sym:*`). Nothing is sent for it and it uses no cap slot. Its signals row is `DUPLICATE`. |
| Daily cap | `TELEGRAM_MAX_ALERTS_PER_DAY` (default **20** — a noise-control choice, not validated). First overflow sends one notice to `TELEGRAM_ADMIN_ID`; then silence. |
| Levels | SL/T1/T2/qty in the message are the same values written to Postgres (equity SL is still VWAP ± 0.2 %, not the detector's candle SL — open item). |
| Watchdog | Exits on a silent socket only during 09:15–15:30 IST (`utils/marketHours.ts`). |

`StockMomentumBreakoutDetector` now emits `durationClass: 'INTRADAY'` (was `SWING`) until a durable
multi-day position store exists. Rows before this change are labelled SWING — see the data
provenance work in progress.

Not yet done (planned): Nifty expiry from the symbol master, a real-path SHORT
test, docs rewrite. (Versioned migrations: done 2026-10-18, see §11.8 and §14. `signals` table: §11.9 and §14b.)

## 11.8 Versioned migrations and ghost rows (2026-10-18)

| Change | Where |
|---|---|
| The `quant_api` boot block that rewrote `qty` / `r_multiple` / `actual_size` / `duration_class` / `realized_pnl` and closed prior-day OPEN rows at a fake ₹0 / 0R `EOD_EXPIRED` on **every start** is gone. Boot now only *reads* `schema_migrations` and warns. Restarting `quant_api` no longer touches data. | `src/api/server.ts` |
| Versioned, one-time migrations: `db/migrations/NNNN_name.sql`, run explicitly with `npm run migrate` (`-- --dry-run` to list). Advisory lock, one transaction per file, checksum check on applied files (CRLF-insensitive). **Never edit an applied migration — add a new one.** | `src/db/migrate.ts`, `tests/migrate.test.ts` |
| `0001_baseline` — schema half of the old block only (idempotent). No data backfills. | `db/migrations/` |
| `0002_data_quality` — `data_quality TEXT[]` flags column (§14). | `db/migrations/` |
| `0003_flag_and_resolve_ghosts` — sets flags and moves ghost rows to `ORPHANED` / `SKIPPED`. Never writes exit/PnL/R. **Must run on deploy day, before the engine boots again** (after that, prior-day SWING rows are legitimately tracked). | `db/migrations/` |
| Engine boot no longer deletes `trades:open` (§7). Prior-day INTRADAY positions are marked `ORPHANED` at boot; the old "stale → close at next day's price" branch in `processTick` is removed. | `src/ingestion/websocket.ts`, `src/core/positionTracker.ts` |
| Capital-skipped signals (actual size 0) are inserted as `SKIPPED` with flag `capital_skipped`, not `OPEN`. Still tracked, so exit and R are recorded, but they never become `CLOSED`. | `src/core/positionStatus.ts`, `tests/positionStatus.test.ts` |
| Engine and API boot log a warning when migrations are pending. `registerTrade` writes `data_quality`, so **run `npm run migrate` before the engine's next boot** or inserts fail (logged, not fatal). | |

**Deploy order (owner, outside market hours):** `pg_dump` → pull + rebuild → `docker compose run --rm quant_api npm run migrate -- --dry-run` → `docker compose run --rm quant_api npm run migrate` → restart services.

**Rollback:** restore the `pg_dump`. Partial manual reversal: `UPDATE paper_trades SET status='OPEN' WHERE status IN ('ORPHANED','SKIPPED') AND exit_price IS NULL; ALTER TABLE paper_trades DROP COLUMN data_quality; DROP TABLE schema_migrations;` then redeploy the previous commit. This brings back the boot rewrite.

Verified locally against a throwaway `postgres:15-alpine` (prod-like fixture rows and a fresh `init.sql` DB): all three apply, a rerun is a no-op, outcome columns are byte-identical before/after, and the tracker's new INSERT / close / orphan SQL behaves as specified. **Not yet run on EC2.**

## 11.9 `signals` table (2026-10-18, branch `feature/signals-table`)

One row per detector fire, i.e. per `sendTelegramAlert()` call. A fire a detector suppresses with its own cooldown never reaches the worker and isn't logged. Rejected signals were only kept in Redis `jsfilter:decisions` (capped, cleared at boot); now every fire is in Postgres. Column reference: §14b.

| Change | Where |
|---|---|
| The body of `sendTelegramAlert` moved **unchanged in behaviour** into an env-free `runAlertPipeline(data, deps, obs)` with injected I/O. `telegramWorker.ts` keeps `AlertPayload`, the backtest seam, and the `sendTelegramAlert` signature, and wires the live deps. | `src/workers/alertPipeline.ts`, `src/workers/telegramWorker.ts` |
| **The hook is observation only.** The pipeline writes facts into an optional draft through `note()`, which swallows every error, and never reads it back. `tests/alertPipeline.test.ts` runs 15 outcome scenarios with no draft, a draft, and a draft that throws on every access, and asserts identical side effects (filter calls, trades, Redis ops, sends, admin notices, console output) plus a golden outcome. A planted "skip send when observed" bug fails 5 of them. | `tests/alertPipeline.test.ts` |
| **Executed old-vs-new parity.** `tests/legacyWorkerParity.test.ts` runs the actual pre-hook `sendTelegramAlert` (commit `437665b`, vendored byte-identical at `tests/fixtures/telegramWorker.pre-signals.txt`, checked against git) side by side with the current `telegramWorker.ts`, with only I/O imports redirected to fakes (`tests/helpers/legacyHarness.ts`). All 15 scenarios must produce identical side effects, and the new worker must log exactly one signals row per fire. It caught one real difference, now fixed: the first version snapshotted `ENV.PAPER_CAPITAL_BASE` / `CAPITAL_CONSTRAINT_BEHAVIOR` / `TELEGRAM_ADMIN_ID` at import, whereas the old worker read them per call (no live impact, since `ENV` is constant, but no longer equivalent). `liveDeps.config` now uses getters. | `tests/legacyWorkerParity.test.ts` |
| Writer: in-memory queue → one multi-row `INSERT … ON CONFLICT DO NOTHING` every 1 s or at 100 rows. A failed batch is retried row by row; a row that still fails is logged as `[SignalLog] DROPPED {json}`. The queue is capped at 5,000 (oldest dropped). `enqueue()` never awaits and never throws. Flushed from the engine's SIGTERM handler. | `src/db/signalLog.ts` |
| Counters, logged per event and as session totals at shutdown: `unique_skipped` (UNIQUE conflict), `queue_cap_dropped`, `failed_dropped`, `batch_retries`. | `src/db/signalLog.ts` |
| Pure column mapping (gate columns, capital outcome, suppression reason, data_quality flags). | `src/db/signalRecord.ts` |
| Promotion source registry, filled at boot (`core_watchlist.json` → CORE, rest of `watchlist.json` → SCREENER) and on anomaly promotion (ANOMALY); Nifty symbols → INDEX. | `src/core/symbolSource.ts`, `src/ingestion/websocket.ts` |
| `registerTrade` returns the inserted `paper_trades.id` (`RETURNING id`), or null on failure. | `src/core/positionTracker.ts` |
| `parseRiskRewardFromTrigger` moved verbatim to `src/utils/triggerLevels.ts` (re-exported from the filter) and additionally returns the raw `sl`/`t1`. `CONFIRMATION_THRESHOLD` is now exported. **No gate, threshold, detector or sizing logic changed.** | `src/utils/triggerLevels.ts`, `src/detectors/janeStreetFilter.ts` |
| Migration `0004_signals`: additive, creates `signals` + 4 indexes + FK to `paper_trades(id) ON DELETE SET NULL`. Reverse: `DROP TABLE signals; DELETE FROM schema_migrations WHERE version='0004';` | `db/migrations/0004_signals.sql` |

**Owner decisions (2026-10-18):** one row per fire (re-fires after cooldown are separate rows; their alert shows `DUPLICATE`); trigger-parsed levels only for rejected signals; real FK; **no retention job yet**. Keep everything and revisit once volume is measured. Estimated ceiling about 2,000–2,500 rows per trading day, about 1.5 KB each. This is an estimate, not a measurement.

**Deploy:** rebuild `quant_api` and `quant_engine`. The API must be rebuilt too, because its read-only schema check reads migration files from its own image. Run `migrate` before the engine's next boot. RUNBOOK has the steps.

Verified locally only (throwaway `postgres:15-alpine` + `redis:7-alpine`): 0004 applies on top of 0001–0003 alone, rerun is a no-op, `paper_trades` byte-identical, real `registerTrade` returns the id and the signal joins to it, UNIQUE conflict counted, FK-violating row dropped alone and logged, `alert_sent`/reason CHECK enforced, `ON DELETE SET NULL` works, reversal SQL works. **Not yet deployed.**

**Writer stall, fixed 2026-10-21 (`fix/signal-log-stall`).** `SignalLog.flush()` cleared its
in-flight guard inside the async body; on an empty queue that body ran synchronously, *before* the
assignment, so a resolved promise stayed in `flushing` forever and every later flush returned
early. Live on Oct 21 only the first of four fires (GALLANTT 14:22) reached `signals`; MRPL,
JINDWORLD and AEQUS were enqueued and never written, with no log line. The guard is now released
in `.finally()` (always asynchronous). Tests: `tests/signalLog.test.ts` STALL cases (failed before
the fix: 1 of 3 rows written).

## 11.10 Session robustness (2026-10-20, branch `fix/session-robustness`)

| Change | Where |
|---|---|
| **Holiday calendar corrected** (data only, its own commit): 15 weekday NSE holidays for 2026. 2026-10-20 was missing, so the engine ran on Dussehra and crash-looped (415 restarts). | `scheduler/nse_holidays.txt` |
| **One trading-day check for everything.** `scheduler/trading_day.sh` (exit 0 trading / 1 weekend / 2 holiday) is used by `lifecycle.sh` (auth + engine), `market_message.sh` (no public open/close message on holidays) and `liveness.sh`. The engine and screener read the same file and exit 0 on a non-trading day (defence in depth for manual starts). | `scheduler/*.sh`, `src/core/tradingDayGate.ts`, `src/core/sessionGuard.ts` |
| **Watchdog policy** (pure, tested): trips only 09:15–15:30 IST; trips 1–6 in a day exit 1 (Docker restarts) and the next boot backs off 30 s → 60 → 120 → 240 → 300 s cap; the 7th trip, or any trip at/after 15:15 IST, exits 0 (stands down — `restart: on-failure` leaves it down). Admin Telegram on every trip. Counter: `engine:restarts:{IST-date}` (§7). | `src/core/sessionGuard.ts`, `src/ingestion/websocket.ts`, `src/utils/adminNotify.ts` |
| **Socket diagnostics:** `[Firehose] ♥` heartbeat every 5 min (message count, last message time); socket `close` / `error` events are now logged. The Oct 19 15:15:50 trip had nothing in the log before it. | `src/ingestion/websocket.ts` |
| **Tick accounting (2026-10-21, diagnostics only):** each heartbeat also prints ticks split by fate — index, option, equity→router, equity→anomaly scanner, equity dropped by the zero-volume filter (and how many lacked `vol_traded_today`), non-tick frames, distinct active symbols seen — plus one raw equity tick and one non-tick frame (300 chars). Added because Oct 21 had ~1,000 msgs/5 min but zero watchlist equities reaching `updateVwap`, and no equity fire since Oct 15. Counters are incremented after the routing decision and never change it. | `src/core/tickStats.ts`, `src/ingestion/websocket.ts` |
| **Seeder:** sliding-window limiter, ≤ 4 starts in any 1000 ms (the old 1 s token refill let 10 simultaneous retries start within 600 ms → `-360`, reproduced by executing the old limiter in `tests/seederRateLimit.test.ts`); `-360` is now recognised and retried (1 s, 2 s, 4 s + jitter, max 3); `no_data` is a soft skip; symbols already seeded today make no call; before 09:15 IST the seeder makes no call at all. | `src/ingestion/vwapSeeder.ts`, `src/utils/rateLimit.ts` |
| **Filter evidence:** one `[JSFilter] ✗ … rejected at <gate> — <reason>` console line per rejection (score rejections in shadow mode previously printed nothing); decisions survive restarts; stats per IST day. Logging only — no gate changed. | `src/detectors/janeStreetFilter.ts` |

Tests: `tests/sessionGuard.test.ts`, `tests/seederRateLimit.test.ts`, `tests/filterEvidence.test.ts`. **Not deployed.** Deploy steps: `docs/RUNBOOK.md` → "Planned deploy: session robustness".

## 11.11 Screener v2 — trend leaders, end-of-day job (2026-10-20, branch `feature/screener-v2`)

Replaces Layer A (`dailyScreener.ts`, turnover + ADR only, run at engine boot). The old screener
silently dropped every non-ok response — **323 of 2,158 symbols** got stats on 2026-10-19 — and
never retried `-360`. "High alpha" here = persistent outperformance vs the benchmark, not volatility.

| Piece | Where |
|---|---|
| All thresholds, validated, hashed into every output: Nifty 500 benchmark, cap 100, liquidity ₹15 cr / ₹20, ≥ 120 bars, Tier 1 RS ≥ 85 and ≤ 25% below the 52w high, Tier 2 / hold RS ≥ 70, failure budget 3% failed / 10% no-data. Market cap and ASM/GSM: **not applied** (stated in every output). | `config/screener.json`, `src/screener/config.ts` |
| Point-in-time screen: every series is cut at the as-of date first. RS rank = percentile of 0.2·excess₂₁ + 0.4·excess₆₃ + 0.4·excess₁₂₆ vs the benchmark (date-aligned). Residual momentum = t-stat of alpha from OLS of daily log returns on the benchmark over 126 bars (high beta alone scores ~0). Score = 0.5·RS + 0.3·residual + 0.2·proximity rank. Trend = close > EMA10 > EMA20 > EMA50 (fixed 300-bar EMA window, so live == backtest) and SMA50 rising. Tags: tight, volume surge. Excluded with a reason: illiquid, cheap, short history, circuit-locked, no bar on the as-of date. | `src/screener/indicators.ts`, `screen.ts` |
| Tiers + hysteresis + cap: CORE → held (yesterday's names with RS ≥ 70 and close > EMA50) → new Tier 1 → new Tier 2, to 100. | `screen.ts` |
| Job: Fyers masters (universe = `-EQ` + INE ISIN; F&O flag from futures), incremental daily candle cache, shared limiter (≤ 4 starts per rolling second), `-360` retried 1/2/4 s. **Budget breach or missing benchmark → previous watchlist kept untouched**, `failed_<date>.json`, admin Telegram. Writes `universe_stats.json` (keeps the legacy fields `anomalyScanner` reads), `watchlist_meta.json`, `history/<date>.json.gz`, then `watchlist.json`. | `scripts/screener_eod.ts`, `src/screener/{job,fetchDaily,candleStore,masters}.ts` |
| Engine reads only: `/app/data/*` via `resolveScreenerFile` (baked-in fallback), promotion source per symbol from meta. **No screening and no history calls at boot.** | `src/screener/paths.ts`, `websocket.ts`, `vwapSeeder.ts`, `anomalyScanner.ts` |
| `signals.promotion_source` gains `SCREENER_LEADER` / `SCREENER_SETUP` (migration **0006**; 0005 is reserved for Part D). Requires 0004 and raises if the signals table is missing. | `db/migrations/0006_screener_sources.sql`, `src/core/symbolSource.ts` |
| Backtest: point-in-time universes (old / new / random×3), per-session universe replay, 5-minute default, multi-day ledger opt-in, day-block bootstrap comparison with the approved go-live rule. | `backtest/universes.ts`, `backtest/compare.ts`, `backtest/run.ts` |

**Superseded 2026-10-21 — see §11.13:** watchlist cap 100 → **60**; Layer B is now a 30-name **bench** ranked by score.

**Layer B is held at its old size.** `anomalyScanner` only scans the symbols in its stats file.
Under the old screener that was ~323 (whatever survived its API losses on 2026-10-19). v2's
`universe_stats.json` covers every scanned symbol, so Layer B now reads a separate, **capped**
`anomaly_universe.json`: the top `layerB.maxSymbols` = 323 by 30-bar turnover, among names that
traded on the as-of date with turnover ≥ ₹1 cr (its own floor). Fallback: a legacy
`universe_stats.json` in the working dir (rollback), else Layer B off. Membership changes (now
the most liquid, not whatever survived), size doesn't. Widening needs evidence: a shadow count of
would-be promotions outside the cap (proposed, not built). Thresholds unchanged.

**Not live until the evidence step passes** (owner's rule; `backtest/output/universe-comparison.md`).
Runbook: `docs/RUNBOOK.md` → "EOD screener". Two stale boot banners remain in `websocket.ts`
("9 detectors" — it is 2; "OI Sweep + Value Zone + Delta Hedging" — Value Zone is not wired).

## 11.12 Fyers quota discipline (2026-10-21, branch `fix/fyers-quota`)

**Why.** The first screener run (2026-10-20, EC2) paced at 4/s = 240/min. Fyers' Standard-plan Data APIs
(history **and** quotes, both `api-t1.fyers.in/data`) allow **5/s, 50/min, 5,000/day**, and more than 3
per-minute breaches in a day block the user for the rest of the day. Cloudflare throttled the run (1015,
`retry_after` 30), then Fyers answered "You've reached the Standard plan limit of 5,000 requests/day":
2,352/2,352 failed. The daily reset time is not documented; the ledger uses IST calendar days.

| Piece | Where |
|---|---|
| Limits and per-job daily allocations (screener 2,200 · seeder 300 · anomaly 200 · backtest 1,500 = 4,200 of 5,000), 4/s and **40/min** pacing, max 2 breaches, 65 s cooldown — validated against the documented limits. | `config/fyers_quota.json` |
| `createQuotaGate(job)`: paces (per-second AND per-minute windows), then reads the ledger right before sending. **Hard stop** on the daily-limit message (day marked exhausted for every job). **Cooldown** on throttling (1015 / 429 / -429 / -360) for every caller sharing the ledger, each a breach; the 2nd breach stops the job for the day. Stops at the job's allocation. Ledgers: Redis on EC2 (`fyers:quota:{day}`, §7), a file on the owner's PC. | `src/fyers/quota.ts` |
| Engine: one limiter for the process; VWAP seeder (`seeder`) and anomaly promotion seeds (`anomaly`) go through it. | `src/fyers/engineGates.ts`, `vwapSeeder.ts`, `websocket.ts` |
| Screener: **lenient quote pre-filter** before any history call — ≤ 50 symbols per quote request (2,352 symbols = 48 requests). Always fetched: CORE, yesterday's watchlist and Layer B set, symbols without a usable quote. Skipped: today's quote has price < ₹20 or traded value < ₹2 cr (the screen needs a ₹15 cr 30-day average). Names the full screen rejected as illiquid are re-checked weekly. A quota stop ends the run as **INCOMPLETE** (exit 4): previous watchlist kept, fetched candles kept, the next run resumes. | `src/screener/prefilter.ts`, `quotes.ts`, `job.ts`, `scripts/screener_eod.ts` |
| Backtest fetch: the same gate with the PC ledger (job `backtest`, 1,500 per IST day); stops at the allocation with "rerun the SAME command on the next allowed evening"; exact coverage-based resume across nights. Blocked 08:45–15:45 and 16:25–18:00 IST on trading days. | `backtest/data/fyersClient.ts`, `backtest/marketWindow.ts` |

The quote pre-filter changes nothing about who can qualify: a skipped name fails a far looser bar than the
screen's own liquidity rule (`tests/screenerPrefilter.test.ts`, property test).

Throttle warnings and the stop error now include Fyers' own error text (`— Fyers said: …`, ≤ 300 chars).
On 2026-10-21 the seeder was throttled 3× in 8 requests and the log kept only the classification.

## 11.13 Subscription cap: watchlist 60 + bench 30 + Nifty (2026-10-21, branch `feat/subscription-cap`)

**Why.** From 2026-10-16 the engine received **only Nifty index ticks**: no equity or option tick, no
error frame, no fire on any stock detector. The heartbeat's tick accounting (§11.10) showed 972/972
index ticks on 2026-10-21. The subscription code, symbol universe and SDK (1.7.0) are identical
between Oct 15 (stock fires) and Oct 16 (none) — EC2 ran `c83cd23` throughout. Fyers' websocket page
(updated 2026-10-14): "Data Socket symbol limits are per user, across all connections. Standard allows
100 symbols and Prime allows 5,000." The engine subscribed 2,159 (`fyersUniverse.json` + Nifty).
Index names are mapped inside the SDK (`HSM/mapper.js`); equities and options are not.
**Status: strong lead, not proven** — the 26-symbol boot test settles it.

| Piece | Where |
|---|---|
| Subscribe = watchlist + bench + Nifty (+ 30 option strikes only if `NIFTY_OPTIONS_ENABLED=true`). `fyersUniverse.json` is no longer read by the engine. | `src/core/subscriptionPlan.ts`, `websocket.ts` |
| **Boot check, before any Fyers call:** total > `SUBSCRIPTION_CAP` (default 100) → log, admin Telegram, **exit 0** (no restart loop). Boot log: `[Engine] 🧾 Subscription plan: N/cap symbols — watchlist … + bench … + index … + options …`. | `websocket.ts` |
| Screener: `watchlistCap` 100 → **60** (core counts toward it; hysteresis unchanged). Layer B scan set (`anomaly_universe.json`) = the **bench**: the next `layerB.maxSymbols` = **30** names by score that missed the watchlist (eligible, bar on the as-of date, turnover ≥ ₹1 cr). Promotions move a bench name into the active universe and add no subscription. | `config/screener.json`, `src/screener/screen.ts` |
| Budget: 60 + 30 + 1 + 0 options = **91 of 100**. Options back on = 121 → refused. | `tests/subscriptionPlan.test.ts` |
| Backtest: `new` uses the config cap (60); random controls already match its size; `--static-list live25=<file>` adds a fixed list (same symbols every day — look-ahead, labelled). | `backtest/universes.ts`, `backtest/run.ts` |

**What this gives up (owner's choice (b), 2026-10-21):** movers outside watchlist + bench are never seen
(e.g. KSCL, HGINFRA unless ranked in the top 90). Oct 1–15: 85–90% of stock fires were on anomaly
promotions outside the watchlist; how many of those a 30-name bench would have contained is untested.
Until the screener runs again, `anomaly_universe.json` does not exist: bench 0, Layer B off, 26 symbols.

**Not built (planned):** pre-open re-rank at ~09:05–09:08 of the top ~150 by evening score, from quotes
(3 requests). Risks: the token can arrive late (manual login), pre-open quotes before 09:08 are
indicative, the swap must be an in-place unsubscribe/subscribe, and a throttle spends breach budget
before the open.

## 11.14 Nifty EMA trend study (2026-10-21, offline, report only — branch `backtest/full-report`)

Pre-registered (`config/nifty_ema_study.json`, `backtest/studies/nifty-ema-trend/PREREGISTRATION.md`,
committed before the run) and run once on 1,285 cached 5-minute sessions (2021-07-05 → 2026-09-07).
Index points only, no option premium. "VWAP" is a TWAP proxy (the cached index volume is 0).

| Piece | Where |
|---|---|
| Pure engine: EMA, session TWAP, V0 cross / V1 alignment / V2 pullback signals, stop-first exits, one position | `backtest/emaTrend.ts` |
| Runner + report (reuses `compare.summarize`, day-block bootstrap, 10,000 resamples) | `backtest/emaStudy.ts` → `backtest/output/ema/` |
| Tests: no look-ahead, hand-checked EMA/TWAP, stop-first, gap fill, 15:15 exit, skips | `tests/emaTrend.test.ts` |
| Plain-language summary | `backtest/studies/nifty-ema-trend/SUMMARY.md` |

**Result (no decision attached):** every variant is positive on trend days and negative on chop days
(69% of sessions). Net E[R]: V1 −0.010 [−0.042, +0.024], V2 −0.013 [−0.046, +0.023], V0 −0.053;
all negative at 2× cost. V1/V2 capture 13–17% of trend-day moves (the current detectors: 1–2%) at
about 5 trades per session. Current Nifty detectors, ungated: Trend Pulse −0.280, ORB −0.313,
VWAP Reclaim −1.003 R/trade. Nothing live changed.

**Correction (same day):** the baselines carried the harness cost (5 bps/leg ≈ 15–25 index points) while
V0–V2 paid 2.3 points. `backtest/emaCostSensitivity.ts` re-costs everything on one model at a time
(`config/nifty_cost_models.json`: fixed 2.3 pts, futures ~14–17 pts, ATM option ~6 pts without theta;
**none validated**). At 2.3 pts Trend Pulse is +0.078R [−0.01, +0.17] vs V1 −0.010R; under the futures
model every strategy is negative. Output: `backtest/output/ema/cost-sensitivity.md`. Harness default unchanged.

## 11.15 SHORT direction: history and the real-path test (2026-10-21, branch `test/short-real-path`)

- SHORT was paused in `9b109cb` (2026-09-16) and re-enabled in `f0d51fc` (2026-09-24) on the strength of
  `tests/shortDirectionGeometry.test.ts`, which imports **no** `src/` code (it re-implements the formulas).
  The Oct 6 plan item "keep SHORT paused until a real-path test exists" was never put in code.
- For equities the pipeline **ignores the trigger's SL/T1** (which the EV gate scores) and derives
  stop = VWAP × 0.998 / × 1.002, target = entry ± 1.5 × risk. The detectors' own levels never reach the trade.
- `tests/alertPipeline.test.ts` REAL-PATH cases run the real `runAlertPipeline`: entry below / at / above
  VWAP on both sides. **Known defect, pinned, not fixed:** an entry on the wrong side of VWAP (SHORT above,
  LONG below) registers and alerts a trade whose stop is on the wrong side of entry; an option trigger
  with SL on the wrong side passes through unchecked.
- **Geometry guard (scaled-down, branch `feat/geometry-guard`):** `runAlertPipeline` calls
  `levelGeometryProblem()` after computing levels. If the stop or target is on the wrong side of entry, the
  trade is still recorded, but both the paper row and the signals row get `invalid_geometry` in `data_quality`.
  An `⛔ … invalid geometry` line is logged and **no Telegram alert is sent**. No migration: the signals row
  keeps the existing catch-all `alert_suppressed_reason = WORKER_ERROR`, and the flag carries the cause.
  The API and dashboard are unchanged. Daily read-only count: RUNBOOK "Daily check: invalid geometry".
  Historical count: 0 of 1,584. The heavier version is built only if it ever fires.

## 11.16 Nifty EMA study in SHADOW (2026-10-21, branch `feat/ema-shadow`)

Owner spec: the pre-registered study (§11.14) runs live in shadow. **No Telegram, no JaneStreetFilter, no
`paper_trades` rows, no migration, no Fyers calls.** Not an alerting detector and not in `NIFTY_STACK`.

| Piece | Where |
|---|---|
| One engine for study and live: `backtest/emaTrend.ts` moved to `src/core/emaTrend.ts` (backtest re-exports it); parameters from `config/nifty_ema_study.json` via `studyParams` / `studyVariants` (the study runner uses the same helpers) | `src/core/emaTrend.ts` |
| 5-min candles from Nifty ticks, aligned to 09:15 IST like `aggregateBars`; ticks outside 09:15–15:30 ignored. On each candle close: `runVariant` over stored history + today for V0/V1/V2; a trade is written once its exit is final (STOP / STOP_GAP / TRAIL / TIME) | `src/detectors/shadow/niftyEmaShadow.ts` |
| Output: `/app/data/ema_shadow/<IST-date>.jsonl` — `trade` rows (variant, side, entry/exit time and price, stop, risk, points, R at 2.3 pts, exit reason, skips so far) and a `summary` row at the 15:15 candle; a `[EmaShadow] 📊` log line | same |
| Warm-up as the study: continuous SMA-seeded EMAs over stored candles, per-session VWAP proxy. History = the engine's own closed candles in Redis (`ema_shadow:nifty:bars5`, §7), no REST. `warmup_partial` while < 200 candles precede the session; `bars_incomplete` after a gap or a mid-candle boot. Restart-safe (dedupe by key from the day's file) | same |
| Wiring: built at boot after the Redis cleanup (boot line `[EmaShadow] 🧪 ACTIVE …`), fed from the Nifty route inside a try/catch; kill switch `EMA_SHADOW_ENABLED=false` | `src/ingestion/websocket.ts` |
| Tests: parity (live, tick by tick from real cached minutes, == study: 177 trades, 15 sessions), no look-ahead, 15:15, warm-up flag, restart, candle alignment, isolation; engine fixtures (EMA/VWAP hand-checked, stop-first, gap fill, >80 skip) in `tests/emaTrend.test.ts` | `tests/niftyEmaShadow.test.ts`, `tests/fixtures/nifty_1m_2026-06-01_to_06-24.json.gz` |

**Full-cache parity (local, 2026-10-21, not a committed test):** the live detector fed all 479,801 cached minutes
tick by tick → 14,807 of 14,876 trades identical; all 69 differences trace to two cache artifacts the live path
cannot see: Diwali Muhurat evening bars (2021-11-04, 2022-10-24, 2023-11-12, 2024-11-01; the study's continuous
EMAs include them, the live detector ignores ticks outside 09:15–15:30) and 174 malformed 1-minute bars (high
below open/close). With those removed/repaired identically on both sides: **14,839 / 14,839 identical, 0 differing.**
The published study (§11.14) includes those artifacts; the effect on its tables is small but unmeasured.

First live session (2026-10-22) has **no stored candles** (the code did not run on Oct 21), so every row
that day is `warmup_partial`; EMAs seed from that day's first 20–21 candles (≈ 10:55).

## 11.17 Day-aware boot cleanup (2026-10-22, branch `fix/day-aware-boot-cleanup`)

**Why:** on Oct 22 at 11:46 a watchdog restart (34 s of feed silence) deleted, mid-session:
- the regime returns;
- the Nifty bias;
- `pnl:daily`;
- every VCP history.

The regime then restarted from zero. Worse, the regime engine reads only its **in-memory** window: the Redis list is a mirror that nothing ever read back. So even keeping the key would not have kept the regime.

**Now** (`src/core/bootCleanup.ts`, wired in `websocket.ts`): `engine:boot_day` stores the IST date of the last boot.
- **New day:** clears the previous session's keys (§7).
- **Same day:** keeps them, and `restoreRegimeReturns()` re-loads the mirror into memory (newest-first list → oldest-first window, capped at 20).
- **Boot line** says which case ran:
  - `🧹 Boot cleanup: same-day restart (…) — kept regime (N returns restored), …`
  - `🧹 Boot cleanup: new day … — cleared N keys …`
- **First boot after deploy:** there is no marker yet, so it behaves as a new day, exactly as before.

**Still lost on a restart:**
- in-memory candle buffers and detector instance state, including the Opening Range Explosion range;
- the per-symbol volume tracker: the first tick after the restart is dropped, and gap volume never reaches VWAP;
- the EMA shadow's half-built candle.

Tests: `tests/bootCleanup.test.ts`.

## 11.18 Duplicate policy: one alert per symbol + side (2026-10-22, branch `feat/duplicate-alert-policy`)

**Why:** on Oct 22 at 11:06 Stock Momentum Breakout (score 85) and VCP (88) fired on AEQUS LONG in the same minute. They ran concurrently, because `websocket.ts` dispatches detectors with `Promise.all`. Both were alerted and both paper rows were counted: double exposure for one trade.

**Rule (owner decisions):** a fire is a **duplicate** if an earlier fire on the same symbol + side holds the claim, and either:
- the earlier fire's position is still open, or
- the earlier fire was less than 60 minutes ago (`SYMBOL_SIDE_COOLDOWN_MS`). This covers a position that has closed or never opened.

Opposite sides never collide. Nifty options dedup on `NIFTY` per side, and for options **only the 60-minute window applies**. Option paper positions never close in-session: they're registered as `NIFTY 22650 CE`, but ticks arrive as `NSE:NIFTY…CE`, a separate defect from before this change. "Still open" would therefore hold all day.

There are two independent atomic claims (`alertPolicy.claimSymbolSide`; Redis SET NX, and a stale holder is replaced with Lua compare-and-set, so concurrent fires can't both win):

| Claim | Taken | The loser |
|---|---|---|
| `paper:sym:*` | before `registerTrade`, by gated fires only; never by an invalid-geometry row. **Kept only by a fire that is actually alerted** (owner, 2026-10-22); otherwise released (compare-and-delete). Ungated rows are never flagged. | Still recorded (recording fails open). Paper row and signals row flagged `duplicate_signal`. Excluded from `pnl:daily` (`positionTracker`) and from the API's `/api/today` and `/api/trades/history` unless `?includeDuplicates=true`; `/api/trades/heatmap` always excludes them. |
| `alert:sym:*` | after the gated / capital checks and after the per-detector slot is claimed (the slot is handed back if the symbol claim loses) | Nothing sent. No message editing. Uses no cap slot. Signals row `alert_suppressed_reason = 'DUPLICATE'`, an existing reason, so no migration. |

- **Order:** the per-detector dedup (`alert:sent:*`) is checked **before** the symbol claim. A fire its own detector already alerted today never takes the claim, so it can't make a concurrent legitimate fire lose and then hand the claim back.
- **Claim given back:** the alert claim is returned (compare-and-delete) whenever no alert went out:
  - the per-detector slot said duplicate or cap reached;
  - the send failed;
  - **any** error after the claim.

  The position id and both claims come from one clock read, so the give-back always matches. Only a process crash between claim and send leaves a claim held (until its position closes, or 60 min).
- **Errors:** a paper-claim error records the row unflagged (fail open). An alert-claim error propagates to `WORKER_ERROR` (fail closed).
- **Alerted only** (owner decisions, 2026-10-22): only a gated fire takes the paper claim, and it keeps it only if its alert is delivered. It's released in a `finally` on every other path: capital skip or zero size, per-detector or symbol duplicate, cap reached, send failed, any error. A later alerted trade is therefore never flagged because of a fire that wasn't alerted.
- **Concurrent inversion, fixed:** two concurrent fires where the paper-claim holder ends up not alerted, while the other fire, already flagged at insert, is alerted. After delivery, the alerted fire re-takes the paper claim and drops its own flag (`positionTracker.removeFlag`: memory, `trades:open`, and `array_remove` on the paper row). The signals row also loses the flag. If a live holder still has the claim (an earlier alerted position), the flag stays. One timing still leaves the flag: the holder hasn't released yet when the alerted fire re-checks after sending. That's rare, because the holder has no network wait.
- **Cost:** two ungated fires on the same symbol + side both count in the ungated stats.
- **Resurrect race, fixed (2026-10-26, from the independent review):** `processTick` deletes a closing position from `trades:open`, awaits the Postgres close, and only then drops it from memory. A `removeFlag` in that gap wrote it back to `trades:open` (a ghost the next boot marks ORPHANED). `processTick` now marks the id in `closingIds` before its first await, and `removeFlag` skips the `trades:open` write for it. Memory and the paper row still lose the flag. Known gap (re-review, LOW): if the position closed while still flagged, its P&L stayed out of `pnl:daily` and is not added back when the flag is later removed, so `pnl:daily` can be lower than the paper rows for that trade. If the Redis close pipeline throws, the id is dropped from `closingIds` so the next tick retries normally. `tests/removeFlagRace.test.ts` reproduces the race: it fails without the fix.

Tests: `tests/duplicatePolicy.test.ts`. `legacyWorkerParity` stays green, because the claim keys go to a non-recording store in `tests/helpers/legacyHarness.ts`.

## 11.19 Unique position ids, row-addressed closes (2026-10-22, branch `fix/position-id`)

**Why:** on Oct 22 at 11:06 two detectors fired AEQUS LONG in the same millisecond. Both positions got the id `trade_<ms>_NSE:AEQUS-EQ`.
- The second overwrote the first in `trades:open`.
- After the 11:46 restart only one was reloaded, so `pnl:daily` counted one close.
- Postgres rows were closed with `WHERE symbol AND entry_time`, which matches **both** same-millisecond rows.

**Now:**
- `positionStatus.newPositionId` builds `trade_<ms>_<symbol>_<detector slug>_<6 hex>`.
- **Order:** registration is INSERT, then `dbId`, then **one** `trades:open` write, then the in-memory entry. A position is invisible to `processTick` until its row id is known. That way a close can't race the INSERT, and no second write can resurrect a closed position as a ghost (the independent review found this). `dbId` survives a restart.
- The close UPDATE and the orphan UPDATE target `id = dbId` (`positionStatus.rowMatch`). Positions registered before this change still use the legacy symbol + entry_time match.
- The API and dashboard never parse the id. The API returns `paper_trades.id`; SSE events carry the position object and are only compared for equality.

**Parity:** `legacyWorkerParity` checks that the new id extends the old one, then compares everything else exactly.

Tests: `tests/positionId.test.ts`.

## 11.20 Dashboard API additions, read-only (2026-10-23, branch `feat/api-signals-health`)

Pure logic lives in `src/api/publicData.ts`, wired in `src/api/server.ts`. There is no engine change, no migration and no write. Deploy **the API container alone**, outside market hours, with a fresh `pg_dump`. The owner approved deploying it on Fri 23 Oct after the close; `quant_engine` is not rebuilt or recreated.

- **`GET /api/signals?date=YYYY-MM-DD`**: the day's fires from `signals`, newest first, capped at 500. The SQL is parameterised, and a bad date returns 400.
  - **Exposed columns:** detector, score, threshold, filter result, rejecting gate, regime, alerted, suppression reason, `data_quality`, `trade_id`.
  - **Not exposed:** trigger text, quantities, capital fields, the breakdown.
- **`/api/trades/history` and `/api/today`** get additive, read-only fields:
  - history rows add `target`, `stopLoss` and `dataQuality`, so the trade view never has to invent levels;
  - open trades add `gated`, `regimeClass` and `dataQuality`.

  Existing fields are unchanged.
- **`GET /api/health`**: **coarse** public health, per the owner, because the dashboard has no login.
  - `status`: `live`, `stale`, `closed` or `holiday`.
    - `live` means the newest closed 5-minute Nifty candle in `ema_shadow:nifty:bars5` ended within 10 minutes, during 09:15–15:30 IST on a trading day.
    - `stale` means it's inside the session with no recent candle.
  - `stocksSeenToday`: the count of `vwap:*:{today}` keys, excluding the index.
  - `ticksPer5m`: currently `null`. The engine logs it but doesn't publish it, so a later engine change is needed.
  - **No** quota, monitor, restart or host details.
- **`/api/events` keep-alive** (`src/api/sseHeartbeat.ts`): an SSE comment `: ping <ms>` every 25 s (`SSE_HEARTBEAT_MS`), stopped on client close. EventSource ignores comments, so no client change is needed.
  - **Why:** the Vercel `/api` rewrite closed the idle stream after 151 s on both production domains (measured 2026-10-23 10:16 IST with no position open; re-measured 19:10 IST, 150 s, 0 pings).
  - **Unverified:** whether the cut is an idle timeout (the heartbeat fixes it) or a hard cap (it doesn't). After the API deploy, run `scripts/sse_soak.sh` (one read-only GET through ninefifteen's `/api`, 300 s). PASS means the stream held past 151 s with pings arriving.

- **`quant_api` loses its anonymous `/app/node_modules` volume** (`docker-compose.yml`). This is the first of four services, approved per service by the owner on 2026-10-23.
  - **Why:** nothing bind-mounts source over `/app`, so the mount had no purpose. Compose carries the old anonymous volume into every recreate: on 2026-10-23 `quant_api`, `quant_engine` and `quant_auth` all still mounted volumes from 2026-09-09. A future dependency change would be built into the image and silently masked. Their lockfiles matched the images on 23 Oct, so nothing is wrong yet.
  - **Leftovers:** orphaned volumes came from `compose down` and `docker rm` without `-v`. 4 were removed on 23 Oct.
  - **Deploy:** with PR #24, the API container alone, outside market hours.
    - After it's recreated, check that it's healthy and that `docker inspect quant_api` shows no `/app/node_modules` mount (it now uses the image's own).
    - Then remove its old volume by full id (`f20993a259ec…`) with `docker volume rm`, after the same three checks: 0 containers in any state, no `PG_VERSION`/`pg_wal`/`global/pg_control`, and only npm package folders. **Never** `prune`.
  - **The other services:** `quant_engine`, `quant_auth` and `quant_screener` follow on separate later evenings, never with the PR #22 deploy, so any problem traces to one change.

Tests: `tests/publicData.test.ts`, and `tests/sseHeartbeat.test.ts`. The latter puts a local proxy that cuts idle connections at 300 ms in front of the stream: it reproduces the cut without the heartbeat, and the stream survives 4× that window with it. That's an emulation; the real check is the soak script.

## 11.21 Study guide (docs only, 2026-10-23, branch `docs/study-guide`)

`docs/study-guide/` holds the owner's interview study guide: `guide.md` is the source and `index.html` is built from it by `build.mjs`. `VERIFICATION.md` lists every checked path and number.

**When behaviour changes, update the guide too:** the filter, the alert policy, the cron times, the deploy steps or the quota rules. A stale guide teaches wrong answers. Paper trading only, with no proven edge: keep the evidence badges honest.

## 11.22 Boot orphaning never relabels SKIPPED rows (2026-10-26, branch `fix/orphan-skips-skipped`; PR, not deployed)

**Finding (26 Oct boot):** rows 1599 and 1603 were capital-skipped Nifty options, SKIPPED with size 0. The boot changed them to ORPHANED.
- **Why options:** they never close in-session, so they stay in `trades:open` overnight, and `positionTracker.init()` then orphans them.
- **Cause:** the orphan UPDATE matched `status IN ('OPEN', 'SKIPPED')`. That clause dates from `bb7fb46` (18 Oct), not PR #23; #23 only swapped the row selector for the row id.
- **Affected rows:** 6, all inserted as SKIPPED after migration 0003 and relabelled at a later boot: 1583, 1585, 1590, 1596, 1599 and 1603. The 15 earlier capital-skipped ORPHANED rows were orphaned by migration 0003's `status = 'OPEN'` rule before SKIPPED existed, and are left alone.
- **Counts:** ORPHANED and SKIPPED are excluded from every count (the API counts CLOSED for history and OPEN for open positions; the edge-map study used CLOSED only), so no P&L figure was affected.

**Fix:**
- `positionStatus.orphanUpdate()` builds the boot UPDATE with `status = 'OPEN'` only. A SKIPPED leftover is dropped from `trades:open` and its row keeps SKIPPED; the log line says so.
- **Tests:** `tests/positionStatus.test.ts` checks the SQL and that `positionTracker` uses the builder.
- **Real Postgres 15:** the old statement turns a SKIPPED row into `ORPHANED {capital_skipped,orphaned}` (`UPDATE 1`); the new one leaves it SKIPPED (`UPDATE 0`) and still orphans an OPEN row.
- **Repairing the 6 rows** is a separate, owner-approved `UPDATE` by id, not part of this code change.

## 11.23 Nifty "why no alert" diagnostics, logging only (2026-10-26, branch `feat/nifty-block-diagnostics`, not deployed)

On 26 Oct Nifty moved 22,386 → 22,700 with no Nifty alert, and the reasons had to be rebuilt from bars.
`src/core/detectorDiagnostics.ts` now records them as they happen.

- **What:** when ORE, Trend Pulse or VWAP Reclaim evaluates a closed candle and doesn't fire, it calls
  `noteBlocked(detector, candleStartMs, side, reason, nums)`. Reasons: `window_*`, `range_building`,
  `lock_candle_not_evaluated` (ORE, §6.12), `warmup`, `cooldown`, `vwap_missing`, `range_too_wide`,
  `body_too_small`, `overextended`, `risk_cap` (with risk, cap, close, stop), and a final miss reason
  (`no_break`, `candle_not_bullish`/`bearish`, `vwap_misaligned`, `no_higher_highs`, `no_lower_lows`,
  `vwap_distance`, `mixed_direction`, `no_cross`).
- **Bounds:** one record per detector per candle (the first reason wins); each `window_*` reason once per
  detector per day; 300 records per detector per day; Redis list `diag:nifty:{IST-date}` trimmed to 900 (3 × 300, so nothing is dropped),
  36 h TTL (§7); one `[Diag]` log line per record.
- **Safety:** `noteBlocked` is synchronous, never awaited by a detector and never throws; the Redis write
  is fire-and-forget with errors swallowed. It changes no alert, gate, threshold, cooldown or position.
  `tests/niftyDiagnostics.test.ts` replays 26 Oct's bars with diagnostics on and off and asserts
  identical signals, and checks the bounds and the kill switch (`NIFTY_DIAG_ENABLED=false`).
- **Replay:** `backtest/replay/engine.ts` calls `resetDiagnostics()` per session.
- **ORE note:** the call sites follow the current lock behaviour; if PR #31 (lock candle) merges, the
  `lock_candle_not_evaluated` record goes away with the early return.

## 11.27 Watchlist population change, effective 2026-10-28 (config only; no code, no image)

**This is a series break in the stock universe.** Every per-day count from 28 Oct onward covers a different set of stocks: fires, alerts, paper trades and stocks seen. Don't compare it with earlier days without splitting by group.

**What changed:** `/app/data/watchlist.json` (volume `screener_data`) went from **25 to 51 stocks** on 27 Oct at about 20:42 IST. The engine reads it once at boot (`websocket.ts`, `resolveScreenerFile`), so it takes effect at the 28 Oct 09:00 boot. Expected boot line: `52/100 symbols — watchlist 51 + bench 0 + index 1 + options 0`.

**The 51:**
- the 25 names live since 20 Oct;
- the 4 owner picks (PR #36): BSE, MCX, PAYTM, ATHERENERG;
- the 22 names from #34's `RULE.md`, the rule committed before ranking, with BSE, MCX and PAYTM counted once.

No hand-picked names, and none of RULE-85's extra 33.

**Checks before the write:**
- every code is in `fyersUniverse.json` and the screener's 19-Oct universe, and the engine had received ticks for each;
- no per-stock config is needed;
- seeder pacing: a restart during the session makes at most 53 Data-API calls through the engine limiter (4/s, 40/min; simulated on the real limiter: at most 40 in any 60 s). A 09:00 boot makes none.
- The monitor's stocks-seen total is now read from the heartbeat (it was hard-coded at 25).

**Rollback:** the backup is `watchlist.json.bak-20261027-25` (sha `da466dc769c0…`; the new file is `7bb595743f1b…`).
- Before 09:00: copy it back.
- After 09:00: no restart in market hours; report only.

## 11.25 VWAP session gate (2026-10-27, branch `feat/vwap-session-gate`; PR, not deployed)

**Finding:**
- On the usual 09:00 boot, the live VWAP included pre-open data:
  - each equity's pre-open auction print (about 09:08);
  - about 13 pre-open Nifty minutes (388 candles on 26 Oct instead of 375).
- The seeder and the backtest replay start at 09:15, so live and backtest differed.
- Measured size, in `docs/proposals/vwap-session-gate/EFFECT.md`:
  - **Nifty:** +32 to +44 pts at 09:20–09:25, under 7 pts from 10:15.
  - **Equity stops** (cache estimate, upper bound): median 2.4 bps at 09:20, 99th percentile 32 bps, under 1 bp median after 09:50.

**Change:**
- `vwapUtils.inVwapSession(ms)` is true from 09:15 IST.
- `updateSessionVwap` is the equity tick path.
- The Nifty one-minute tracker moved, otherwise unchanged, from `websocket.ts` to `core/niftyMinuteState.ts` (`onNiftyTick`, `get/setLastNiftyVwap`). It updates the reference only for minutes that start at or after 09:15.
- **Regime returns are not gated.**
- **Kill switch:** `VWAP_SESSION_GATE=false`.

**Test:** `tests/vwapSessionGate.test.ts` drives the real live paths and `replaySession` on real cached bars for 2026-09-07. That day has 5 real Nifty pre-open bars, and the SBIN auction residual is used.
- With the gate, the VWAP state equals the replay's exactly.
- Without it, it differs by exactly the pre-open data.

**Side effect:** on a 09:00 boot the Nifty bias is unset until about 09:16.

**Deploy (owner, 27 Oct): approved in principle; its own evening, Friday 30 Oct at the earliest.** The deploy date is a **series break**: before it, live VWAP, VWAP stops, the Nifty reference and the bias included pre-open data; after it they don't. Values from the first hour (about 09:15–10:15) are not comparable across the break. At deploy, record the date here, in the CHANGELOG, and as a deviation-log entry in `docs/studies/edge-map/PREREGISTRATION.md`. Deploy date: _not yet deployed_.

## 12. AWS Deployment (EC2 + Docker Compose)

The engine is deployed on AWS **strictly for alerting and out-of-sample data accumulation**. It is NOT an automated execution environment. 

### Architecture
- **Target**: A persistent EC2 instance running Amazon Linux.
- **Topology**: Retains the exact `docker-compose.yml` topology. `quant_scheduler` mounts the Docker socket (`/var/run/docker.sock`) to orchestrate the siblings `quant_auth` and `quant_engine` according to the daily market hours.
- **Liveness**: A `liveness.sh` script runs in the scheduler at 09:10 IST to verify that the Fyers `access_token.txt` was freshly generated. If missing/stale, it fires a Telegram alert immediately, preventing the engine from hanging silently.
- **Secrets**: Managed via AWS Systems Manager (SSM) Parameter Store. A boot script fetches secrets dynamically and populates the `.env` file. Secrets are never hardcoded.

### Constraints & Facts
1. **Fyers OAuth Constraint**: The morning login via the Telegram link is a hard constraint by design (it utilizes phone biometrics to securely authenticate with Fyers). It cannot be bypassed with TOTP scraping.
2. **Elastic IP**: The EC2 instance requires an Elastic IP because the Fyers OAuth callback `FYERS_REDIRECT_URI` must be static and point to `http://<EC2_ELASTIC_IP>:3000/callback`.
3. **No Strategy Edge**: No tested strategy has currently cleared statistical significance. Any future agent attempting to add execution layers MUST read this and refuse until an edge is mathematically proven.
4. **No SWING bypass**: The `SWING` gate bypass in `janeStreetFilter.ts` has been fully removed. Swing signals are currently evaluated using intraday gating logic because no swing-appropriate replacement gate exists yet.

## 13. Capital-Constrained Sizing & Historical Backfill Caveat

The engine implements a configurable paper capital base (default ₹1,00,000). The live `positionTracker` computes trade size targeting 1% risk per trade (`qty = floor(riskAmount / stopDistance)`) and **actively enforces a concurrent capital cap**. If a new trade's notional value pushes total open exposure above the capital base, the engine reduces its size (or skips it) based on `CAPITAL_CONSTRAINT_BEHAVIOR`.

**⚠️ HISTORICAL BACKFILL CAVEAT:**
When the sizing logic was introduced (Sep 14, 2026), a boot-time auto-migration backfilled `qty` (unconstrained size) and `actual_size` (capital-constrained executed size), and recalculated `realized_pnl` for all pre-existing historical trades in Postgres. **This backfill sized each historical trade in isolation.** There was no chronological replay of concurrent capital. As a result, for all trades prior to Sep 14, 2026, `actual_size` is just a direct copy of `qty`.

Because it completely ignored concurrent capital contention, historical rupee PnL prior to Sep 14, 2026 is a **reasonable approximation, not a true replication**. Dashboard PnL only becomes strictly realistic to the REDUCE/SKIP constraint for trades occurring *after* this feature went live. Future significance testing should rely on the `r_multiple` column (which is independent of size and strictly accurate), rather than aggregate rupee PnL.

---

## 14. Paper-trade Postgres schema (paper_trades) — full column reference

Maintained by `db/init.sql` (initial table) plus the versioned migrations in `db/migrations/`, applied with `npm run migrate` (§11.8). Nothing alters the schema at service boot any more.

| Column | Type | Written by | Notes |
|---|---|---|---|
| id | SERIAL PK | Postgres | Auto-increment |
| symbol | TEXT | positionTracker.registerTrade | |
| detector | TEXT | positionTracker.registerTrade | e.g. "Stock Momentum Breakout" |
| direction | TEXT | positionTracker.registerTrade | LONG or SHORT |
| entry_price | NUMERIC | positionTracker.registerTrade | |
| entry_time | TIMESTAMPTZ | positionTracker.registerTrade | Used by positionTracker UPDATE WHERE clause |
| stop_price | NUMERIC | positionTracker.registerTrade | |
| target_price | NUMERIC | positionTracker.registerTrade | |
| exit_price | NUMERIC NULL | positionTracker.processTick | NULL while OPEN |
| exit_time | TIMESTAMPTZ NULL | positionTracker.processTick | NULL while OPEN; **primary filter for history/heatmap queries** |
| exit_reason | TEXT NULL | positionTracker.processTick | STOP_LOSS, TARGET, TIME. Historical `EOD_EXPIRED` rows are fake closes from the removed boot sweep (flag `synthetic_close`). |
| status | TEXT | positionTracker / migration 0003 | `OPEN`, `CLOSED`, `SKIPPED` (capital-skipped signal, actual size 0; tracked for R, never a position), `ORPHANED` (no process tracks it; exit/PnL/R left NULL — the real outcome is unknown). The API reads only `OPEN` / `CLOSED`. |
| realized_pnl | NUMERIC NULL | positionTracker.processTick | NULL while OPEN |
| regime_class | TEXT NULL | positionTracker.registerTrade | Regime at entry time |
| gated | BOOLEAN | positionTracker.registerTrade | Whether JaneStreetFilter passed |
| qty | NUMERIC(10,2) | migration / registerTrade | Unconstrained theoretical size |
| capital_gated | BOOLEAN | positionTracker.registerTrade | True if size was zeroed by capital constraint |
| actual_size | NUMERIC(10,2) | migration / registerTrade | Real executed size (may be 0 if cap-gated) |
| r_multiple | NUMERIC(10,2) NULL | positionTracker.processTick | (exit-entry)/|entry-sl|; NULL if sl==entry; clamped away from Infinity/NaN |
| duration_class | TEXT NULL | positionTracker.registerTrade | INTRADAY or SWING; derived from detector at signal time |
| data_quality | TEXT[] NOT NULL DEFAULT '{}' | migration 0003 / registerTrade / positionTracker.init | Provenance flags. Empty = no known problem (not "verified"). Flags are only added, never cleared to make a row look clean. See the flag table below. |
| created_at | TIMESTAMPTZ | Postgres | DEFAULT now() |

**Indexes on paper_trades:**

| Index | Column(s) | Notes |
|---|---|---|
| idx_trades_entry_time | entry_time | Used by positionTracker UPDATE WHERE |
| idx_trades_exit_time | exit_time DESC | Primary filter for history/heatmap (exit-date bucketing) |
| idx_trades_status | status | WHERE status = 'OPEN' / 'CLOSED' scans |
| idx_trades_symbol | symbol | positionTracker UPDATE WHERE |
| idx_trades_detector | detector | Per-detector history filter |
| idx_trades_open | entry_time DESC WHERE status='OPEN' | Fast scan of live positions; partial index |

**data_quality flags** (set by migration 0003 unless noted; evidence in `docs/DATA_PROVENANCE.md`):

| Flag | Meaning | Use the row for |
|---|---|---|
| `synthetic_close` | `exit_reason = 'EOD_EXPIRED'`: ₹0 / 0R close invented by the removed boot sweep, dated on an API restart | Signal occurrence only |
| `orphaned` | Was left `OPEN` with no process tracking it (migration 0003, or `positionTracker.init()` at boot) | Signal occurrence only |
| `capital_skipped` | `actual_size = 0` (migration 0003, or `registerTrade`). PnL is ₹0 by construction | R only, and only if it closed |
| `index_option_proxy` | Nifty `… CE/PE` row priced at index level | Nothing price-based |
| `pre_sizing_approx` | Entry before 2026-09-14: size/PnL are per-trade backfill approximations (§13) | R, not rupee PnL |
| `duration_unverified` | Entry before 469a568 (2026-10-05 21:32 IST): `duration_class` is a default or an in-place script relabel | Anything except duration splits |

**No boot-time cleanup.** The old "dangling-OPEN cleanup" (close prior-day OPEN rows at `exit_price = entry_price`, ₹0, 0R, `EOD_EXPIRED`) was removed on 2026-10-18. It invented outcomes, and it hit SWING rows too.

**duration_class classification** — sourced from the detector at signal time, hardcoded in registerTrade:
- StockMomentumBreakoutDetector → SWING (set at line ~358 of the detector; also hardcodes durationClass: 'SWING' on AlertPayload which permanently bypasses bayesianEngine time-of-day restriction — see §3.9)
- All Nifty detectors, GapAndGoMomentum, VolatilityContraction → INTRADAY (default)
- Backfill (historical, removed 2026-10-18): the old boot block classified existing rows using ILIKE '%Momentum%' / ILIKE '%VCP%'. Such rows carry `duration_unverified`.

---

## 14b. `signals` — one row per detector fire

Written by `src/db/signalLog.ts` from the draft `alertPipeline.ts` fills (§11.9). **NULL in a gate column means the stage never ran**, never that it passed. Only REGIME and EV can reject; Bayesian and Kelly are score components; the score threshold is the third rejection point.

| Column(s) | Meaning |
|---|---|
| `signal_id` (UUID PK), `fired_at` (UTC), `trade_date` (IST day) | Identity. `UNIQUE (detector, symbol, direction, fired_at)` guards against logging the same fire twice. |
| `symbol`, `detector`, `direction`, `price`, `trigger`, `duration_class`, `regime_class` | The fire as the detector sent it. `regime_class` is the detector's declaration. |
| `trigger_sl`, `trigger_t1`, `levels_parsed` | Levels parsed from the trigger, i.e. what the EV gate saw. `levels_parsed = false` → the gate used the default R:R (flag `levels_default_rr`). |
| `entry_price`, `stop_price`, `target_price` | Levels the paper trade tracks (equity SL = VWAP ± 0.2 %). NULL if the signal never reached sizing. |
| `regime_result`, `regime_reason`, `market_regime`, `entropy` | Regime hard gate. |
| `bayesian_posterior`, `bayesian_points`, `bayesian_reason` | Score component. |
| `ev_result`, `ev_value`, `ev_reason` | EV hard gate. |
| `kelly_half`, `kelly_points`, `kelly_reason` | Score component (only computed when EV passes). |
| `score`, `score_threshold`, `score_result` | `score_threshold` = `CONFIRMATION_THRESHOLD` in force when the signal fired. |
| `filter_result` (PASSED/REJECTED/ERROR), `rejected_at` (REGIME/EV/SCORE), `shadow_mode`, `breakdown` (JSONB, every component) | Filter summary. |
| `capital_outcome` (TRADED/REDUCED/SKIPPED_CAPITAL), `qty`, `actual_size` | Sizing. NULL = never sized (rejected before sizing). |
| `promotion_source` | CORE / SCREENER / ANOMALY / INDEX / UNKNOWN. |
| `alert_sent`, `alert_suppressed_reason` | FILTER_REJECTED, FILTER_ERROR, NOT_GATED, CAPITAL_SKIP, ZERO_SIZE, DUPLICATE, CAP_REACHED, SEND_FAILED, WORKER_ERROR. A CHECK enforces `alert_sent ⇔ reason IS NULL`. |
| `trade_id` | FK → `paper_trades.id`, `ON DELETE SET NULL`. Set when the signal became a paper-trade row. |
| `data_quality` | `index_option_proxy`, `levels_default_rr`, `regime_guessed` (regime class inferred from name/trigger, not declared). |

Indexes: `(fired_at DESC)`, `(trade_date, detector)`, `(symbol, trade_date)`, partial `(trade_id) WHERE trade_id IS NOT NULL`. No retention job (owner decision 2026-10-18).

---

## 11.6 What changed in the full-audit session (Sept 24, 2026)

Commit f0d51fc on v2. All changes are additive / fixes only — no new detectors, no threshold changes.

### Engine (src/)

| File | Change |
|---|---|
| db/init.sql | Added duration_class TEXT, exit_reason TEXT columns; added idx_trades_exit_time, idx_trades_status, idx_trades_symbol, idx_trades_open indexes |
| src/api/server.ts | Migration block: adds duration_class, exit_reason columns; creates the 4 new indexes; backfills duration_class for existing rows; closes dangling OPEN rows from prior days (EOD_EXPIRED); exposes durationClass and exitReason in all REST responses; null-safe exitTimestamp in history endpoint |
| src/core/positionTracker.ts | Added durationClass to OpenPosition interface; writes duration_class in registerTrade INSERT; fixed r_multiple division-by-zero (guard denominator !== 0, clamp Infinity/NaN to null); writes exit_reason in processTick UPDATE; fixed unrealized PnL to use actualSize (was using raw size) |
| src/ingestion/websocket.ts | Added jsfilter:stats to boot-cleanup Promise.all — was accumulating across sessions |
| src/detectors/v2/stockMomentumBreakoutDetector.ts | Removed emergency SHORT pause guard (lines 310–314). Investigation confirmed _fire() was always geometrically correct for SHORT. Added explanatory comment pointing to test file. |
| src/workers/telegramWorker.ts | Fixed TELEGRAM_CHANNEL_ID → ENV.TELEGRAM_CHANNEL_ID (pre-existing bare reference; caused type error, would error at runtime on skip-alert path) |
| tests/shortDirectionGeometry.test.ts | **New file.** 13 tests asserting SHORT levels satisfy target < entry < stop and LONG levels satisfy stop < entry < target across StockMomentumBreakout, NiftyORE, NiftyTrendPulse, and the processTick exit-check conditionals. |

### What was investigated and confirmed **not** a bug
- _fire() SHORT geometry: sl = candle.high * 1.0015 (above entry ✓), t1 = entry - risk * 1.5 (below entry ✓), risk = Math.abs(entry - sl) (safe ✓). Historical SHORT trades: none found with target_price > entry_price or stop_price < entry_price.
- (Number(r.qty) || 100) fallback in server.ts: intentional stub for pre-sizing-era rows. Documented.
- The four ₹0-PnL trades: confirmed capitalGated: true, actualSize: 0, PnL = (exit - entry) * 0 = 0. Not a bug.

### Dashboard (insider-quant-dashboard, commit eeec74d on main)

Full rewrite of App.tsx:

| Bug | Fix |
|---|---|
| "Trade History" nav view showed only chart, no trades | Dedicated currentView === 'history' section renders full trade list, split by INTRADAY/SWING |
| Detector dropdown emptied after filtering | Added separate allDetectors fetch from unfiltered history; dropdown never collapses |
| format(new Date(t.exitTimestamp), 'HH:mm') crash on null exitTimestamp | safeDate() guard; chart data filters null exitTimestamp before mapping |
| cumulative += t.pnl → NaN when pnl is null | cumulative += t.pnl ?? 0 |
| SHORT modal: target fallback was entryPrice * 1.05 (long-shaped) | Direction-aware: SHORT target = entryPrice * 0.95, stop = entryPrice * 1.05 |
| Search bar was uncontrolled, no filtering | Controlled searchQuery state; filters filteredHistory by symbol and detector name |
| No INTRADAY/SWING split anywhere | PnL card shows combined total + INTRADAY/SWING breakdown sub-cards; Trade History view groups by duration_class; Performance view has INTRADAY/SWING split panel; Stats computed per-class |
| exitTimestamp in server.ts was new Date(null).getTime() = 0 | r.exit_time ? new Date(r.exit_time).getTime() : null |
