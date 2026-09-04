import { sendTelegramAlert } from '../../workers/telegramWorker.js'
import type { IDetector, TickData } from '../../core/types.js'
import { redisClient } from '../../config/redis.js'
import { getVwap, getMarketBias } from '../../utils/vwapUtils.js'

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
const CANDLE_DURATION_MS = 60 * 1000
const MACRO_BASELINE_CANDLES = 60         // Need 60 mins of boring data to confirm compression
const EXTREME_RVOL_MULTIPLIER = 15.0      // Needs 15x normal volume to confirm institutional sweep
const MIN_BLOCK_VALUE = 20_000_000        // ₹2Cr minimum tick value to avoid low-float penny stock noise
const COOLDOWN_SECONDS = 7200             // 2 hour cooldown (these are rare, one-and-done moves)
const MAX_DAY_SPREAD_PCT = 3.5            // The stock shouldn't already be up 10% before this fires
// ─────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
    return d.getUTCHours() * 60 + d.getUTCMinutes()
}

// Avoid the morning chaos. These setups form mid-to-late day.
const isActiveWindow = (): boolean => {
    const m = getISTMinutes()
    return m >= 11 * 60 + 0 && m <= 15 * 60 + 15
}

interface Candle {
    open: number
    high: number
    low: number
    close: number
    volume: number
    startTs: number
}

export class ParabolicRvolSweepDetector implements IDetector {
    public name = 'Late-Day Parabolic RVOL Sweep'
    public symbol: string

    private currentCandle: Candle | null = null

    // In-memory HOD/LOD tracking for the session
    private sessionHigh: number = 0
    private sessionLow: number = Infinity

    constructor(symbol: string) {
        this.symbol = symbol
    }

    public async analyze(liveTick: TickData): Promise<void> {
        // Always track HOD/LOD from the very first tick, even outside active window
        this.sessionHigh = Math.max(this.sessionHigh, liveTick.price)
        this.sessionLow = Math.min(this.sessionLow, liveTick.price)

        if (!isActiveWindow()) return

        const now = liveTick.timestamp

        // ── Accumulate 1-min candles ─────────────────────────────────────────
        if (!this.currentCandle) {
            this.currentCandle = {
                open: liveTick.price, high: liveTick.price,
                low: liveTick.price, close: liveTick.price,
                volume: liveTick.volume, startTs: now,
            }
            return
        }

        if (now - this.currentCandle.startTs < CANDLE_DURATION_MS) {
            this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price)
            this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price)
            this.currentCandle.close = liveTick.price
            this.currentCandle.volume += liveTick.volume
            return
        }

        // ── Candle complete ──────────────────────────────────────────────────
        const closedCandle = { ...this.currentCandle }
        this.currentCandle = {
            open: liveTick.price, high: liveTick.price,
            low: liveTick.price, close: liveTick.price,
            volume: liveTick.volume, startTs: now,
        }

        const baselineKey = `macro_baseline:${this.symbol}`
        const cooldownKey = `cooldown:parabolic:${this.symbol}`

        if (await redisClient.get(cooldownKey)) {
            await this.updateBaseline(baselineKey, closedCandle)
            return
        }

        const rawBaseline = await redisClient.lRange(baselineKey, 0, -1)
        const history: Candle[] = rawBaseline.map((c) => JSON.parse(c) as Candle)

        if (history.length >= MACRO_BASELINE_CANDLES) {
            const macroAvgVol = history.reduce((a, c) => a + c.volume, 0) / history.length

            // Measure the compression of the day so far
            const daySpreadPct = ((this.sessionHigh - this.sessionLow) / this.sessionLow) * 100

            // ── The Ignition Sequence ─────────────────────────────────────────
            const blockValue = liveTick.price * liveTick.volume
            const isInstitutionalSweep = blockValue >= MIN_BLOCK_VALUE
            const isExtremeRvol = closedCandle.volume > macroAvgVol * EXTREME_RVOL_MULTIPLIER

            // Breaking HOD (or extremely close to it)
            const isBreakingHod = liveTick.price >= this.sessionHigh * 0.999

            // Ensuring it was actually compressing before exploding
            const wasCompressing = daySpreadPct < MAX_DAY_SPREAD_PCT

            if (isInstitutionalSweep && isExtremeRvol && isBreakingHod && wasCompressing) {
                const vwap = await getVwap(this.symbol)
                const marketBias = await getMarketBias()

                // Final check: Must be above VWAP and market shouldn't be crashing
                if ((vwap !== null ? liveTick.price > vwap : true) && marketBias !== 'bearish') {

                    console.log(`\n🚀 [PARABOLIC SQUEEZE DETECTED] ${this.symbol}`)
                    console.log(`   HOD Broken: ₹${this.sessionHigh.toFixed(2)} | Day Spread was: ${daySpreadPct.toFixed(2)}%`)
                    console.log(`   RVOL: ${(closedCandle.volume / macroAvgVol).toFixed(1)}x Macro Baseline!`)

                    sendTelegramAlert({
                        symbol: this.symbol,
                        price: liveTick.price,
                        side: 'LONG',
                        percentageChange: Number((((liveTick.price - this.sessionLow) / this.sessionLow) * 100).toFixed(2)),
                        volumeSpikeRatio: Number((closedCandle.volume / macroAvgVol).toFixed(1)),
                        trigger: `🚀 Parabolic HOD Sweep | Flat for 60m+ | RVOL ${(closedCandle.volume / macroAvgVol).toFixed(1)}x | Block ₹${(blockValue / 100_000).toFixed(1)}L | VWAP ₹${vwap?.toFixed(2)}`,
                        vwap: vwap ?? liveTick.price,
                        avgPrice: this.sessionHigh,
                    })

                    await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
                }
            }
        }

        await this.updateBaseline(baselineKey, closedCandle)
    }

    private async updateBaseline(key: string, candle: Candle) {
        await redisClient
            .multi()
            .lPush(key, JSON.stringify(candle))
            .lTrim(key, 0, MACRO_BASELINE_CANDLES - 1)
            .exec()
    }
}