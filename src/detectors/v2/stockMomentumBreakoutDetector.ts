// ============================================================
// v2/stockMomentumBreakoutDetector.ts
//
// REPLACES: The entire 9-detector equity stack
// (MorningMomentum, ORB, MTF, VCP, ParabolicRVOL, VwapStdev,
//  SmartMoney, VolSpike, EquityLiquiditySweep)
//
// ROOT CAUSE OF THE PROBLEMS:
//   1. 50-100 alerts/day: 9 detectors × 100 stocks = 900 instances.
//      Each fires independently. Multiple detectors fire on the same
//      stock for the same move. You get 4-6 alerts on one stock move.
//   2. Stocks rallied 2-4% but no alert: detectors required 10-15min
//      of compression before arming. A +2% gap-up stock never
//      entered a "compression box" — it just went straight up.
//   3. Reversals: detectors fire EARLY (on tick-level volume), before
//      the candle confirmation. Tick volume is noisy — candle volume
//      is signal.
//
// v2 PHILOSOPHY: ONE detector that catches ALL high-probability
// intraday equity setups. Less is more.
//
// THE 3 SETUPS THIS DETECTOR CATCHES:
//
// SETUP A — "Morning Surge Breakout" (9:15-9:50)
//   Stock gaps up or breaks 9:15 high in first 35 minutes
//   with 3× the opening candle's volume.
//   Catches the stocks that rally 2-4% at open.
//
// SETUP B — "Intraday Compression Breakout" (9:50-14:30)
//   Price compresses <0.5% for 3 consecutive 5-min candles
//   then breaks out with 4× average volume.
//   Catches mid-session momentum breakouts.
//
// SETUP C — "VWAP Momentum Continuation" (any time)
//   Price pulls back to VWAP and then makes a new 30-min high/low
//   with volume confirming. The cleanest intraday setup.
//
// ALL SETUPS require:
//   - Market bias alignment (Nifty VWAP check)
//   - ₹1Cr+ block size (institutional participation)
//   - 30-min cooldown per stock
// ============================================================

import { sendTelegramAlert } from '../../workers/telegramWorker.js'
import type { IDetector, TickData } from '../../core/types.js'
import { redisClient } from '../../config/redis.js'
import { getVwap, getMarketBias } from '../../utils/vwapUtils.js'

// ─── TUNABLE CONSTANTS ────────────────────────────────────────
const CANDLE_5MIN_MS = 5 * 60 * 1000
const COOLDOWN_SECONDS = 1800           // 30 min per stock (was 9 detectors each blocking separately)
const MIN_BLOCK_VALUE = 10_000_000     // ₹1Cr (down from ₹2Cr on VolSpike — catches more stocks)
const SESSION_OPEN_TTL = 8 * 3600

// Setup A: Morning Surge
const MORNING_END_MIN = 9 * 60 + 50   // first 35 min
const MORNING_VOL_MULT = 3.0           // 3× opening candle volume

// Setup B: Compression Breakout
const COMPRESS_CANDLES = 3             // need 3 consecutive compressed candles
const MAX_COMPRESS_PCT = 0.5           // tight <0.5% range
const BREAKOUT_VOL_MULT = 4.0           // 4× compression avg volume

// Setup C: VWAP Continuation
const VWAP_PULL_BUFFER = 0.08          // must be within 0.08% of VWAP on pullback
const HIGH30_VOL_MULT = 2.5           // 2.5× average on the continuation move

const MARKET_ACTIVE_START = 9 * 60 + 15
const MARKET_ACTIVE_END = 14 * 60 + 45
// ─────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
    return d.getUTCHours() * 60 + d.getUTCMinutes()
}

const isActiveWindow = (): boolean => {
    const m = getISTMinutes()
    return m >= MARKET_ACTIVE_START && m <= MARKET_ACTIVE_END
}

interface Candle {
    open: number; high: number; low: number; close: number
    volume: number; startTs: number
}

export class StockMomentumBreakoutDetector implements IDetector {
    public name = 'Stock Momentum Breakout'
    public symbol: string

    private currentCandle: Candle | null = null
    private history5: Candle[] = []   // last 20 five-min candles
    private openingCandleVolume: number = 0    // first 5-min candle volume (Setup A baseline)
    private openingCandleHigh: number = 0
    private openingCandleLow: number = Infinity
    private vwapTouchedThisHour: boolean = false
    private lastVwapTouchPrice: number = 0

    constructor(symbol: string) {
        this.symbol = symbol
    }

    public async analyze(liveTick: TickData): Promise<void> {
        if (!isActiveWindow()) return

        const now = liveTick.timestamp
        const m = getISTMinutes()

        // ── Build 5-min candle ───────────────────────────────────────────
        if (!this.currentCandle) {
            this.currentCandle = {
                open: liveTick.price, high: liveTick.price,
                low: liveTick.price, close: liveTick.price,
                volume: liveTick.volume, startTs: now,
            }
            return
        }

        if (now - this.currentCandle.startTs < CANDLE_5MIN_MS) {
            this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price)
            this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price)
            this.currentCandle.close = liveTick.price
            this.currentCandle.volume += liveTick.volume

            // ── INTRABAR: Live VWAP touch check for Setup C ──────────────
            const vwapLive = await getVwap(this.symbol)
            if (vwapLive) {
                const dist = Math.abs((liveTick.price - vwapLive) / vwapLive) * 100
                if (dist <= VWAP_PULL_BUFFER) {
                    this.vwapTouchedThisHour = true
                    this.lastVwapTouchPrice = liveTick.price
                }
            }
            return
        }

        // ── Candle closed ────────────────────────────────────────────────
        const closed = { ...this.currentCandle }
        this.currentCandle = {
            open: liveTick.price, high: liveTick.price,
            low: liveTick.price, close: liveTick.price,
            volume: liveTick.volume, startTs: now,
        }

        this.history5.push(closed)
        if (this.history5.length > 20) this.history5.shift()

        // Record first candle of the day as opening baseline
        if (this.openingCandleVolume === 0 && this.history5.length === 1) {
            this.openingCandleVolume = closed.volume
            this.openingCandleHigh = closed.high
            this.openingCandleLow = closed.low
        }

        // Reset VWAP touch tracker on each new hour
        if (m % 60 === 0) this.vwapTouchedThisHour = false

        const cooldownKey = `cooldown:v2:momentum:${this.symbol}`
        if (await redisClient.get(cooldownKey)) return

        const vwap = await getVwap(this.symbol)
        const marketBias = await getMarketBias()

        // ── Record session open price ────────────────────────────────────
        const openKey = `v2:session_open:${this.symbol}`
        const existing = await redisClient.get(openKey)
        if (!existing && m >= 9 * 60 + 15 && m < 9 * 60 + 20) {
            await redisClient.setEx(openKey, SESSION_OPEN_TTL, String(liveTick.price))
        }
        const stockOpenRaw = await redisClient.get(openKey)
        const stockOpen = stockOpenRaw ? parseFloat(stockOpenRaw) : null

        // ── SETUP A: Morning Surge Breakout ──────────────────────────────
        if (m <= MORNING_END_MIN && this.openingCandleVolume > 0 && this.history5.length >= 2) {
            const isMorningSurgeVolume = closed.volume >= this.openingCandleVolume * MORNING_VOL_MULT
            const breakingAboveOpen = closed.close > this.openingCandleHigh * 1.001
            const breakingBelowOpen = closed.close < this.openingCandleLow * 0.999
            const blockValue = closed.close * closed.volume
            const isBlockSized = blockValue >= MIN_BLOCK_VALUE

            if (isMorningSurgeVolume && isBlockSized) {
                if (breakingAboveOpen && marketBias !== 'bearish' && (vwap ? closed.close > vwap : true)) {
                    return await this._fire(
                        'LONG',
                        closed,
                        vwap,
                        cooldownKey,
                        `🌅 Morning Surge LONG | ${(closed.volume / this.openingCandleVolume).toFixed(1)}× opening vol | Break above ₹${this.openingCandleHigh.toFixed(2)} | Block ₹${(blockValue / 100_000).toFixed(1)}L`,
                        stockOpen,
                    )
                }
                if (breakingBelowOpen && marketBias !== 'bullish' && (vwap ? closed.close < vwap : true)) {
                    return await this._fire(
                        'SHORT',
                        closed,
                        vwap,
                        cooldownKey,
                        `🌅 Morning Surge SHORT | ${(closed.volume / this.openingCandleVolume).toFixed(1)}× opening vol | Break below ₹${this.openingCandleLow.toFixed(2)} | Block ₹${(blockValue / 100_000).toFixed(1)}L`,
                        stockOpen,
                    )
                }
            }
        }

        // ── SETUP B: Intraday Compression Breakout ───────────────────────
        if (this.history5.length >= COMPRESS_CANDLES + 1) {
            const compressionCandles = this.history5.slice(-COMPRESS_CANDLES - 1, -1) // last 3 closed (before current)
            const compHigh = Math.max(...compressionCandles.map(c => c.high))
            const compLow = Math.min(...compressionCandles.map(c => c.low))
            const compPct = ((compHigh - compLow) / compLow) * 100
            const compAvgVol = compressionCandles.reduce((s, c) => s + c.volume, 0) / compressionCandles.length

            const isCompressed = compPct < MAX_COMPRESS_PCT && compAvgVol > 0
            const volExplosion = closed.volume >= compAvgVol * BREAKOUT_VOL_MULT
            const blockValue = closed.close * closed.volume
            const isBlockSized = blockValue >= MIN_BLOCK_VALUE
            const breakAboveBox = closed.close > compHigh * 1.001
            const breakBelowBox = closed.close < compLow * 0.999
            const isAboveVwap = vwap ? closed.close > vwap : true
            const isBelowVwap = vwap ? closed.close < vwap : true
            const bodyPct = (Math.abs(closed.close - closed.open) / closed.open) * 100

            if (isCompressed && volExplosion && isBlockSized && bodyPct >= 0.1) {
                if (breakAboveBox && isAboveVwap && marketBias !== 'bearish') {
                    return await this._fire(
                        'LONG',
                        closed,
                        vwap,
                        cooldownKey,
                        `📦 Compression Breakout LONG | Box ₹${compLow.toFixed(2)}-₹${compHigh.toFixed(2)} | ${compPct.toFixed(2)}% tight | ${(closed.volume / compAvgVol).toFixed(1)}× vol | Block ₹${(blockValue / 100_000).toFixed(1)}L`,
                        stockOpen,
                    )
                }
                if (breakBelowBox && isBelowVwap && marketBias !== 'bullish') {
                    return await this._fire(
                        'SHORT',
                        closed,
                        vwap,
                        cooldownKey,
                        `📦 Compression Breakdown SHORT | Box ₹${compLow.toFixed(2)}-₹${compHigh.toFixed(2)} | ${compPct.toFixed(2)}% tight | ${(closed.volume / compAvgVol).toFixed(1)}× vol | Block ₹${(blockValue / 100_000).toFixed(1)}L`,
                        stockOpen,
                    )
                }
            }
        }

        // ── SETUP C: VWAP Momentum Continuation ─────────────────────────
        if (vwap && this.vwapTouchedThisHour && this.history5.length >= 6) {
            const last6 = this.history5.slice(-6)
            const high30 = Math.max(...last6.map(c => c.high))
            const low30 = Math.min(...last6.map(c => c.low))
            const avgVol6 = last6.reduce((s, c) => s + c.volume, 0) / last6.length
            const volBurst = closed.volume >= avgVol6 * HIGH30_VOL_MULT
            const blockVal = closed.close * closed.volume
            const isBlock = blockVal >= MIN_BLOCK_VALUE

            if (volBurst && isBlock) {
                // Making new 30-min high with volume = continuation LONG
                if (closed.close > high30 * 1.001 && closed.close > vwap && marketBias !== 'bearish') {
                    const distFromVwap = ((closed.close - vwap) / vwap) * 100
                    if (distFromVwap <= 0.8) { // not overextended
                        return await this._fire(
                            'LONG',
                            closed,
                            vwap,
                            cooldownKey,
                            `🏊 VWAP Pull+Continue LONG | Touched VWAP ₹${this.lastVwapTouchPrice.toFixed(2)} → new 30-min high ₹${high30.toFixed(2)} | ${(closed.volume / avgVol6).toFixed(1)}× vol | Block ₹${(blockVal / 100_000).toFixed(1)}L`,
                            stockOpen,
                        )
                    }
                }
                // Making new 30-min low with volume = continuation SHORT
                if (closed.close < low30 * 0.999 && closed.close < vwap && marketBias !== 'bullish') {
                    const distFromVwap = ((vwap - closed.close) / vwap) * 100
                    if (distFromVwap <= 0.8) {
                        return await this._fire(
                            'SHORT',
                            closed,
                            vwap,
                            cooldownKey,
                            `🏊 VWAP Pull+Continue SHORT | Touched VWAP ₹${this.lastVwapTouchPrice.toFixed(2)} → new 30-min low ₹${low30.toFixed(2)} | ${(closed.volume / avgVol6).toFixed(1)}× vol | Block ₹${(blockVal / 100_000).toFixed(1)}L`,
                            stockOpen,
                        )
                    }
                }
            }
        }
    }

    private async _fire(
        side: 'LONG' | 'SHORT',
        candle: Candle,
        vwap: number | null,
        cooldownKey: string,
        setupNote: string,
        stockOpen: number | null,
    ): Promise<void> {
        const entry = candle.close
        const vwapRef = vwap ?? entry

        // Dynamic SL: use candle low/high + buffer
        const sl = side === 'LONG'
            ? Number((candle.low * 0.9985).toFixed(2))   // 0.15% below candle low
            : Number((candle.high * 1.0015).toFixed(2))  // 0.15% above candle high

        const risk = Math.abs(entry - sl)
        if (risk <= 0 || risk / entry > 0.015) return  // skip if SL > 1.5% (too wide)

        const t1 = side === 'LONG'
            ? Number((entry + risk * 1.5).toFixed(2))
            : Number((entry - risk * 1.5).toFixed(2))
        const t2 = side === 'LONG'
            ? Number((entry + risk * 2.5).toFixed(2))
            : Number((entry - risk * 2.5).toFixed(2))

        const dayChangePct = stockOpen
            ? Number((((entry - stockOpen) / stockOpen) * 100).toFixed(2))
            : 0

        const vwapDist = vwap
            ? Number((((entry - vwap) / vwap) * 100).toFixed(2))
            : 0

        console.log(`\n${side === 'LONG' ? '🚀' : '🔻'} [STOCK MOMENTUM ${side}] ${this.symbol} | ${setupNote.slice(0, 60)}`)

        sendTelegramAlert({
            symbol: this.symbol,
            price: entry,
            side,
            percentageChange: Math.abs(vwapDist),
            volumeSpikeRatio: candle.volume / (this.openingCandleVolume || candle.volume),
            trigger: `${setupNote} | Entry ₹${entry.toFixed(2)} | SL ₹${sl} | T1 ₹${t1} | T2 ₹${t2} | VWAP ₹${vwapRef.toFixed(2)} (${vwapDist > 0 ? '+' : ''}${vwapDist.toFixed(2)}%) | Day: ${dayChangePct > 0 ? '+' : ''}${dayChangePct.toFixed(2)}%`,
            vwap: vwapRef,
            avgPrice: (candle.open + candle.close) / 2,
        })

        await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
    }
}