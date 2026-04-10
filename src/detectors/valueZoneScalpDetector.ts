import { sendTelegramAlert } from '../workers/telegramWorker.js'
import type { IDetector, TickData } from '../core/types.js'
import { redisClient } from '../config/redis.js'
import { getVwap } from '../utils/vwapUtils.js'
import { getBestStrike } from '../utils/optionUtils.js'
import { logShadowTrade } from '../utils/tradeLogger.js'

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
const CANDLE_DURATION_MS = 3 * 60 * 1000
const EMA_PERIOD = 21
const COOLDOWN_SECONDS = 3600
const MAX_RISK_POINTS = 25
// ─────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

const isActiveWindow = (): boolean => {
	const m = getISTMinutes()
	return m >= 9 * 60 + 30 && m <= 15 * 60
}

interface Candle {
	open: number
	high: number
	low: number
	close: number
	volume: number
	startTs: number
}

export class ValueZoneScalpDetector implements IDetector {
	public name = 'Value Zone Trend Ride'
	public symbol = 'NSE:NIFTY50-INDEX'

	private currentCandle: Candle | null = null

	// [FIX: PERFORMANCE] The original detector stored all history as a growing
	// array and recalculated the full EMA loop from scratch on every completed candle.
	// Over a full trading day (130 × 3-min candles), the EMA loop processes the
	// entire history array each time — O(n²) total work.
	//
	// [WHAT TO CHANGE]: We now use the standard incremental EMA formula:
	//   ema_new = close × k + ema_prev × (1 - k)
	// This runs in O(1) per candle after the initial seeding period.
	//
	// The seeding period still requires EMA_PERIOD (21) candles, after which
	// we switch to the incremental update. Behavior is mathematically identical.
	//
	// We still keep the last 2 EMA values (current + previous) to support the
	// trend direction check (currentEma vs prevEma).
	private currentEma: number | null = null
	private prevEma: number | null = null
	private candleCount: number = 0 // counts candles seen during seeding
	private seedBuffer: number[] = [] // closes during seeding phase

	// [FIX] EMA smoothing factor
	private readonly K = 2 / (EMA_PERIOD + 1)

	public async analyze(liveTick: TickData): Promise<void> {
		if (!isActiveWindow() || this.symbol !== 'NSE:NIFTY50-INDEX') return

		const now = liveTick.timestamp

		// ── Build 3-Minute Candle ────────────────────────────────────────────
		if (!this.currentCandle) {
			this.currentCandle = {
				open: liveTick.price,
				high: liveTick.price,
				low: liveTick.price,
				close: liveTick.price,
				volume: liveTick.volume,
				startTs: now,
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

		// ── Candle closed ────────────────────────────────────────────────────
		const c = { ...this.currentCandle }
		this.currentCandle = {
			open: liveTick.price,
			high: liveTick.price,
			low: liveTick.price,
			close: liveTick.price,
			volume: liveTick.volume,
			startTs: now,
		}

		// ── Update EMA incrementally ─────────────────────────────────────────
		// [FIX] Incremental EMA: seed for EMA_PERIOD candles, then O(1) updates
		this.candleCount++

		if (this.candleCount <= EMA_PERIOD) {
			// Seeding phase: collect closes
			this.seedBuffer.push(c.close)
			if (this.candleCount === EMA_PERIOD) {
				// Seed EMA with SMA of first EMA_PERIOD closes
				const seedEma = this.seedBuffer.reduce((a, b) => a + b, 0) / this.seedBuffer.length
				this.currentEma = seedEma
				this.seedBuffer = [] // free the seed buffer
			}
			return // not enough data yet to fire signals
		}

		// Incremental update — O(1)
		this.prevEma = this.currentEma
		this.currentEma = c.close * this.K + (this.currentEma ?? c.close) * (1 - this.K)

		// Need both current and previous EMA for trend direction
		if (this.prevEma === null || this.currentEma === null) return

		const currentEma = this.currentEma
		const prevEma = this.prevEma

		// ── Fetch supporting data ─────────────────────────────────────────────
		const cooldownKey = `cooldown:valuezone`
		if (await redisClient.get(cooldownKey)) return

		const vwap = await getVwap(this.symbol)
		if (!vwap) return

		// ── LONG SETUP (CE) ───────────────────────────────────────────────────
		const isUptrend = currentEma > prevEma && currentEma > vwap
		const touchedValueZoneLong = c.low <= currentEma && c.low >= vwap - 5
		const closedStrongLong = c.close > c.open && c.close > currentEma

		if (isUptrend && touchedValueZoneLong && closedStrongLong) {
			const indexSl = Number(c.low.toFixed(2))
			const risk = c.close - indexSl

			if (risk > MAX_RISK_POINTS || risk < 5) return

			const t1 = Number((c.close + risk * 1.5).toFixed(2))
			const best = getBestStrike('CE', c.close)

			console.log(
				`\n🎯 [VALUE ZONE LONG] Nifty pulled back to 21 EMA. Entry confirmed at ₹${c.close}`,
			)

			sendTelegramAlert({
				symbol: `NIFTY ${best.strike} CE`,
				price: c.close,
				side: 'LONG',
				percentageChange: 0,
				volumeSpikeRatio: 1,
				trigger: `🎯 Value Zone CE | Strike ${best.strike} | Prem ~₹${best.ltp} | Index ₹${c.close} | SL ₹${indexSl} | T1 ₹${t1} | ${best.reason}`,
				vwap,
				avgPrice: currentEma,
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
			return
		}

		// ── SHORT SETUP (PE) ──────────────────────────────────────────────────
		const isDowntrend = currentEma < prevEma && currentEma < vwap
		const touchedValueZoneShort = c.high >= currentEma && c.high <= vwap + 5
		const closedWeakShort = c.close < c.open && c.close < currentEma

		if (isDowntrend && touchedValueZoneShort && closedWeakShort) {
			const indexSl = Number(c.high.toFixed(2))
			const risk = indexSl - c.close

			if (risk > MAX_RISK_POINTS || risk < 5) return

			const t1 = Number((c.close - risk * 1.5).toFixed(2))
			const best = getBestStrike('PE', c.close)

			console.log(
				`\n🎯 [VALUE ZONE SHORT] Nifty pulled back to 21 EMA. Entry confirmed at ₹${c.close}`,
			)

			sendTelegramAlert({
				symbol: `NIFTY ${best.strike} PE`,
				price: c.close,
				side: 'SHORT',
				percentageChange: 0,
				volumeSpikeRatio: 1,
				trigger: `🎯 Value Zone PE | Strike ${best.strike} | Prem ~₹${best.ltp} | Index ₹${c.close} | SL ₹${indexSl} | T1 ₹${t1} | ${best.reason}`,
				vwap,
				avgPrice: currentEma,
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
			return
		}
	}
}
