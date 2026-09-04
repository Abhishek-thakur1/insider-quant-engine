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
| Tests | `npm test` → 53 cases (node:test via tsx): the REGIME hard gate, plus the backtest harness and an end-to-end replay. Was previously a deliberate failure stub. |
| Lint / format | `npm run check` = prettier + eslint + tests. `npm run typecheck` = `tsc --noEmit --types node` (0 errors). Tabs, no semicolons, single quotes, 100 cols (`.prettierrc`). |
| Big caveat #1 | Of 26 detector classes, **8 are live**. 15 are archived under `src/detectors/deprecated/`, and 3 more are dormant but still in `src/detectors/`. See §4. |
| Big caveat #2 | Most files carry a large **commented-out previous version** at the bottom. Always confirm you are editing live code, not the archive block. |
| Backtest | `backtest/` replays historical bars through the real detectors. Read `backtest/README.md` before touching it — it depends on a virtual clock and an in-memory Redis, and it deliberately reproduces a live routing bug. |
| 🔴 Known live bug | Five watchlist equities (RELIANCE, ULTRACEMCO, CEATLTD, BAJFINANCE, KAJARIACER) never reach any detector — see §6.11. Unfixed by instruction, not by oversight. |

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
```

`quant_engine`'s compose `command` is a shell `until [ -f /app/token/access_token.txt ]` poll loop
(10 s) before it execs `npx tsx src/ingestion/websocket.ts`. So the engine can be started before
the token exists and it will wait.

### 1.2 Daily lifecycle (`scheduler/crontab`, IST, Mon–Fri)

| Time | Action | Script |
|---|---|---|
| 07:45 | `docker start quant_auth` → sends the Telegram login link | `lifecycle.sh start_auth` |
| 09:07 | Random "market open" message to the channel | `market_message.sh open` |
| 09:15 | `docker start quant_engine` | `lifecycle.sh start_engine` |
| 15:17 | Random "market close" message | `market_message.sh close` |
| 15:30 | `docker stop quant_engine`, stop `quant_auth`, **purge the token** via a one-shot alpine container | `lifecycle.sh stop_engine` |

The token is deliberately destroyed daily — Fyers access tokens are single-day.

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

1. Assert `/app/token/access_token.txt` and `./watchlist.json` exist, else `process.exit(1)`.
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
anything other than `explicit` is visible in `jsfilter:decisions`. Guessing from trigger text was
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

### 4.3 ACTIVE — the per-equity stack (3 instances × 90 symbols = 270 detector objects)

⚠️ 270 objects are constructed, but only **85 symbols ever reach them**: five are swallowed by the
option-routing bug in §6.11 before `strategyRouter` is consulted.

| Class | File | Setups |
|---|---|---|
| `StockMomentumBreakoutDetector` | `v2/stockMomentumBreakoutDetector.ts` | 3 setups in one detector, 5-min candles |
| `VolatilityContraction` | `v2/high_alpha/VolatilityContraction.ts` | 5-min VCP, Redis-backed history |
| `GapAndGoMomentum` | `v2/high_alpha/GapAndGoMomentum.ts` | 09:15–09:30 opening range, break 09:30–10:15 |

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

### 4.4 ARCHIVED — moved to `src/detectors/deprecated/` (15)

See `src/detectors/deprecated/README.md` for the per-file rationale and revival steps. All 15 are
`UNTRACKED` — none was removed on measured performance, because no performance data has ever
existed in this repo.

**Tier A (14).** The 7 mean-reversion detectors: `Orderflowexhaustiondetector`,
`smartmoneydivergencedetector`, `vwapStdevReversionDetector`, `vwapPullbackDetector`,
`vwapCrossoverDetector`, `valueZoneScalpDetector`, `liquidityTrapDetector`. Plus 7 superseded:
`niftyOptionsDetector`, `morningMomentumDetector`, `candleBreakoutDetector`, `vcpDetector`,
`parabolicRvolSweepDetector`, `volumeSpikeDetector`, `equityLiquiditySweepDetector`.

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
`jsfilter:decisions`. Covered by `tests/regimeGate.test.ts`, including a regression test for each.

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
| `regime:nifty:returns_1min` | list of return % | none | `pushNiftyReturn` (mirror) | (mirror only) |
| `regime:nifty:current` | JSON `RegimeState` | 60 s | `pushNiftyReturn`, `getMarketRegime` | `getMarketRegime` |
| `jsfilter:decisions` | list, capped at 1000 | none | `persistDecision` | `getRecentDecisions` |
| `jsfilter:stats` | hash `fired`/`blocked` | none | `persistDecision` | `getFilterStats` |
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
| `session_open:{sym}` | price | 8 h | Multitimeframebreakout (dormant) | itself |
| `armed:vcp:{sym}`, `memory:vcp:*`, `baseline:vcp:*` | flag / lists | 8 h / none | vcpDetector (dormant) | itself |

Boot cleanup in `websocket.ts` deletes, per symbol: `cooldown:v2:momentum:*`, `v2:session_open:*`,
`v2:cooldown:vcp:*`, `v2:cooldown:gapgo:*`, `v2:vcp_history:*`; and globally:
`cooldown:v2:nifty_pulse`, `cooldown:v2:vwap_reclaim`, `cooldown:v2:nifty_ore`, `cooldown:oi_sweep`,
`cooldown:delta_squeeze`, `market:nifty:bias`, `regime:nifty:returns_1min`, `regime:nifty:current`,
`jsfilter:decisions`.

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

**Verified:** `npm run typecheck` → 0 errors. `npm test` → 53/53. `npm run lint` runs (9 errors
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
3. **The 15 archived detectors** are archived, not deleted, specifically so the backtest can
   still import them. Deleting them needs explicit approval and would end that option.

### 11.5 Documentation map

| File | Purpose |
|---|---|
| `AGENTS.md` | **This file. Single source of truth.** Architecture, every formula, the gating maths, defects, conventions. |
| `CLAUDE.md`, `GEMINI.md` | Thin pointers here, plus the non-negotiables. Deliberately short — do not duplicate content into them. |
| `README.md` | Human-facing project overview and how to run it. |
| `backtest/README.md` | The harness: isolation guarantees, virtual clock, assumptions, fidelity gaps. |
| `src/detectors/deprecated/README.md` | Why each of the 15 archived detectors was archived, and how to revive one. |
| `docs/qullamaggie-spec-v2.md` | The source-verified spec for a momentum suite that is **not built**. Carries the repo's status, what the revision corrects versus the earlier version, and the data blockers a builder hits immediately. |

If you change behaviour, update `AGENTS.md` in the same commit. A stale brief is worse than no
brief, because the next agent will trust it.
