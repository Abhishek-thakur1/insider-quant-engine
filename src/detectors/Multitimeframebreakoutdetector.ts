// ============================================================
// MULTI-TIMEFRAME TREND ALIGNMENT BREAKOUT (Stocks — Intraday)
//
// Strategy: "Institutional Accumulation Surge" — used by fund
// managers and prop desks for high-probability intraday entries
// in Nifty50 stocks.
//
// Why this works at hedge fund level:
// Large institutions can't enter a position in one tick — they
// accumulate over 15–30 minutes, leaving a footprint:
//   • Price compresses into a narrow range (they absorb supply)
//   • Volume contracts during accumulation (stealth)
//   • When distribution is complete, a single catalyst tick
//     breaks the range with massive volume — this IS the signal
//
// 4 CONFLUENCES REQUIRED:
//   1. 5-min higher lows (uptrend) + price above VWAP (15-min context)
//   2. Range compressed < 0.4% for at least 10 minutes
//   3. Breakout tick >= 5x range average volume + >= ₹75L block value
//   4. Stock is up on the day (positive session return) — relative strength proxy
//      Full RS vs Nifty requires Nifty's live price piped in; that is a
//      websocket.ts concern. The detector defaults to "allow" when session
//      open data is unavailable so it never silently skips a valid setup.
// ============================================================

import { sendTelegramAlert } from '../workers/telegramWorker.js'
import type { IDetector, TickData } from '../core/types.js'
import { redisClient } from '../config/redis.js'
import { getVwap, getMarketBias } from '../utils/vwapUtils.js'

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
const CANDLE_5MIN_MS = 5 * 60 * 1000
const CANDLE_15MIN_MS = 15 * 60 * 1000

const MAX_RANGE_PCT = 0.4
const MIN_RANGE_DURATION_MS = 10 * 60 * 1000
const MIN_RANGE_CANDLES = 3

const BREAKOUT_VOL_MULTIPLIER = 5.0
const MIN_BLOCK_VALUE = 7_500_000       // ₹75L

const HIGHER_LOWS_COUNT = 3
const COOLDOWN_SECONDS = 1800

const SESSION_OPEN_TTL = 8 * 3600      // expires end of day
// ─────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
    return d.getUTCHours() * 60 + d.getUTCMinutes()
}
// const isActiveWindow = (): boolean => {
//     const m = getISTMinutes()
//     return m >= 9 * 60 + 45 && m <= 14 * 60 + 30
// }

const isActiveWindow = (): boolean => {
    const m = getISTMinutes()
    // Active from market open (9:15 AM) to intraday square-off limit (3:15 PM)
    return m >= 9 * 60 + 15 && m <= 15 * 60 + 15
}

const SESSION_OPEN_KEY = (symbol: string) => `session_open:${symbol}`

interface Candle {
    open: number
    high: number
    low: number
    close: number
    volume: number
    startTs: number
}

export class MultiTimeframeBreakoutDetector implements IDetector {
    public name = 'Multi-TF Institutional Breakout'
    public symbol: string

    private current5: Candle | null = null
    private history5: Candle[] = []

    // 15-min candle is only used for its OHLCV — we derive VWAP from vwapUtils
    // which already runs on all ticks. Keeping 15-min candle in memory for
    // future use (e.g. 15-min structure breakout) but not used in detection yet.
    private current15: Candle | null = null

    constructor(symbol: string) {
        this.symbol = symbol
    }

    public async analyze(liveTick: TickData): Promise<void> {
        if (!isActiveWindow()) return

        const now = liveTick.timestamp
        const istMinutes = getISTMinutes()

        // ── Record session open price once, shortly after 9:15 ──────────────
        if (istMinutes >= 9 * 60 + 15 && istMinutes < 9 * 60 + 20) {
            const existing = await redisClient.get(SESSION_OPEN_KEY(this.symbol))
            if (!existing) {
                await redisClient.setEx(
                    SESSION_OPEN_KEY(this.symbol),
                    SESSION_OPEN_TTL,
                    String(liveTick.price),
                )
            }
        }

        // ── Build 5-min candle ────────────────────────────────────────────────
        if (!this.current5) {
            this.current5 = {
                open: liveTick.price, high: liveTick.price,
                low: liveTick.price, close: liveTick.price,
                volume: liveTick.volume, startTs: now,
            }
            this._build15(liveTick, now)
            return
        }

        if (now - this.current5.startTs < CANDLE_5MIN_MS) {
            this.current5.high = Math.max(this.current5.high, liveTick.price)
            this.current5.low = Math.min(this.current5.low, liveTick.price)
            this.current5.close = liveTick.price
            this.current5.volume += liveTick.volume
            this._build15(liveTick, now)
            return
        }

        // ── 5-min candle closed ───────────────────────────────────────────────
        const closed5: Candle = { ...this.current5 }
        this.current5 = {
            open: liveTick.price, high: liveTick.price,
            low: liveTick.price, close: liveTick.price,
            volume: liveTick.volume, startTs: now,
        }
        this._build15(liveTick, now)

        this.history5.push(closed5)
        if (this.history5.length > 20) this.history5.shift()

        // Need enough closed candles before running detection
        if (this.history5.length < HIGHER_LOWS_COUNT + MIN_RANGE_CANDLES) return

        const cooldownKey = `cooldown:mtf_breakout:${this.symbol}`
        if (await redisClient.get(cooldownKey)) return

        // ── CONFLUENCE 1: 5-min TREND + VWAP ALIGNMENT ───────────────────────
        const recent5 = this.history5.slice(-HIGHER_LOWS_COUNT)
        const isHigherLows5 = recent5.every((c, i) => i === 0 || c.low > recent5[i - 1]!.low)
        const isLowerHighs5 = recent5.every((c, i) => i === 0 || c.high < recent5[i - 1]!.high)

        const vwap = await getVwap(this.symbol)
        const isAboveVwap = vwap !== null ? liveTick.price > vwap : true
        const isBelowVwap = vwap !== null ? liveTick.price < vwap : true

        const marketBias = await getMarketBias()

        // ── CONFLUENCE 2: RANGE COMPRESSION ──────────────────────────────────
        const rangeCandles = this.history5.slice(-MIN_RANGE_CANDLES)
        const rangeHigh = Math.max(...rangeCandles.map((c) => c.high))
        const rangeLow = Math.min(...rangeCandles.map((c) => c.low))
        const rangePct = ((rangeHigh - rangeLow) / rangeLow) * 100

        const isCompressed = rangePct < MAX_RANGE_PCT
        const rangeAge = now - (rangeCandles[0]?.startTs ?? now)
        const isOldEnough = rangeAge >= MIN_RANGE_DURATION_MS

        // ── CONFLUENCE 3: VOLUME + BLOCK SIZE ────────────────────────────────
        const rangeAvgVol = rangeCandles.reduce((a, c) => a + c.volume, 0) / rangeCandles.length
        const blockValue = liveTick.price * liveTick.volume
        const isInstitutionalBlock = blockValue >= MIN_BLOCK_VALUE
        const isVolumeExplosion =
            rangeAvgVol > 0 && liveTick.volume >= rangeAvgVol * BREAKOUT_VOL_MULTIPLIER

        // ── CONFLUENCE 4: RELATIVE STRENGTH (session return proxy) ────────────
        // Full implementation: compare stock % change vs Nifty % change.
        // Current proxy: stock must be positive on the day for LONG,
        // negative for SHORT. Avoids trading laggards/leaders against the move.
        // Defaults to true if session open hasn't been recorded yet.
        const stockOpenRaw = await redisClient.get(SESSION_OPEN_KEY(this.symbol))
        let isPositiveOnDay = true   // default: allow when no data
        let isNegativeOnDay = true

        if (stockOpenRaw) {
            const stockOpen = parseFloat(stockOpenRaw)
            const stockChangePct = ((liveTick.price - stockOpen) / stockOpen) * 100
            isPositiveOnDay = stockChangePct >= -0.1  // small buffer — not deeply negative
            isNegativeOnDay = stockChangePct <= 0.1
        }

        // ── LONG: Bullish range breakout ──────────────────────────────────────
        const isBreakingAbove = liveTick.price > rangeHigh * 1.001

        if (
            isCompressed && isOldEnough &&
            isHigherLows5 &&
            isAboveVwap &&
            isBreakingAbove &&
            isVolumeExplosion && isInstitutionalBlock &&
            isPositiveOnDay &&
            marketBias !== 'bearish'
        ) {
            const entry = liveTick.price
            const sl = Number(rangeLow.toFixed(2))
            const risk = entry - sl
            if (risk <= 0) return
            const t1 = Number((entry + risk * 1.5).toFixed(2))
            const t2 = Number((entry + risk * 2.5).toFixed(2))

            console.log(
                `\n🏛️ [MTF BREAKOUT LONG] ${this.symbol} | ` +
                `Range: ₹${rangeLow.toFixed(2)}–₹${rangeHigh.toFixed(2)} (${rangePct.toFixed(2)}%) | ` +
                `Vol: ${(liveTick.volume / rangeAvgVol).toFixed(1)}x | ` +
                `Block: ₹${(blockValue / 100_000).toFixed(1)}L`,
            )

            sendTelegramAlert({
                symbol: this.symbol,
                price: entry,
                side: 'LONG',
                percentageChange: Number((((entry - rangeLow) / rangeLow) * 100).toFixed(2)),
                volumeSpikeRatio: Number((liveTick.volume / rangeAvgVol).toFixed(1)),
                trigger:
                    `🏛️ MTF Breakout | Range ₹${rangeLow.toFixed(2)}–₹${rangeHigh.toFixed(2)} | ` +
                    `${rangePct.toFixed(2)}% compressed ${(rangeAge / 60000).toFixed(0)}min | ` +
                    `HH 5-min ✅ | Above VWAP ₹${vwap?.toFixed(2)} ✅ | ` +
                    `${(liveTick.volume / rangeAvgVol).toFixed(1)}x vol | ` +
                    `Block ₹${(blockValue / 100_000).toFixed(1)}L | ` +
                    `SL ₹${sl} | T1 ₹${t1} | T2 ₹${t2}`,
                vwap: vwap ?? entry,
                avgPrice: (rangeHigh + rangeLow) / 2,
            })

            await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
            return
        }

        // ── SHORT: Bearish range breakdown ────────────────────────────────────
        const isBreakingBelow = liveTick.price < rangeLow * 0.999

        if (
            isCompressed && isOldEnough &&
            isLowerHighs5 &&
            isBelowVwap &&
            isBreakingBelow &&
            isVolumeExplosion && isInstitutionalBlock &&
            isNegativeOnDay &&
            marketBias !== 'bullish'
        ) {
            const entry = liveTick.price
            const sl = Number(rangeHigh.toFixed(2))
            const risk = sl - entry
            if (risk <= 0) return
            const t1 = Number((entry - risk * 1.5).toFixed(2))
            const t2 = Number((entry - risk * 2.5).toFixed(2))

            console.log(
                `\n💀 [MTF BREAKDOWN SHORT] ${this.symbol} | ` +
                `Range: ₹${rangeLow.toFixed(2)}–₹${rangeHigh.toFixed(2)} (${rangePct.toFixed(2)}%) | ` +
                `Vol: ${(liveTick.volume / rangeAvgVol).toFixed(1)}x | ` +
                `Block: ₹${(blockValue / 100_000).toFixed(1)}L`,
            )

            sendTelegramAlert({
                symbol: this.symbol,
                price: entry,
                side: 'SHORT',
                percentageChange: Number((((entry - rangeHigh) / rangeHigh) * 100).toFixed(2)),
                volumeSpikeRatio: Number((liveTick.volume / rangeAvgVol).toFixed(1)),
                trigger:
                    `💀 MTF Breakdown | Range ₹${rangeLow.toFixed(2)}–₹${rangeHigh.toFixed(2)} | ` +
                    `${rangePct.toFixed(2)}% compressed ${(rangeAge / 60000).toFixed(0)}min | ` +
                    `LL 5-min ✅ | Below VWAP ₹${vwap?.toFixed(2)} ✅ | ` +
                    `${(liveTick.volume / rangeAvgVol).toFixed(1)}x vol | ` +
                    `Block ₹${(blockValue / 100_000).toFixed(1)}L | ` +
                    `SL ₹${sl} | T1 ₹${t1} | T2 ₹${t2}`,
                vwap: vwap ?? entry,
                avgPrice: (rangeHigh + rangeLow) / 2,
            })

            await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
            return
        }
    }

    // ── Internal 15-min candle builder ───────────────────────────────────────
    private _build15(liveTick: TickData, now: number): void {
        if (!this.current15) {
            this.current15 = {
                open: liveTick.price, high: liveTick.price,
                low: liveTick.price, close: liveTick.price,
                volume: liveTick.volume, startTs: now,
            }
            return
        }
        if (now - this.current15.startTs < CANDLE_15MIN_MS) {
            this.current15.high = Math.max(this.current15.high, liveTick.price)
            this.current15.low = Math.min(this.current15.low, liveTick.price)
            this.current15.close = liveTick.price
            this.current15.volume += liveTick.volume
        } else {
            // 15-min candle closed — available for future structure-level checks
            this.current15 = {
                open: liveTick.price, high: liveTick.price,
                low: liveTick.price, close: liveTick.price,
                volume: liveTick.volume, startTs: now,
            }
        }
    }
}