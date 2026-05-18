import { sendTelegramAlert } from '../workers/telegramWorker.js'
import type { IDetector, TickData } from '../core/types.js'
import { redisClient } from '../config/redis.js'
import { getVwap, getMarketBias } from '../utils/vwapUtils.js'
import { getBestStrike } from '../utils/optionUtils.js'

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
const CANDLE_DURATION_MS = 60 * 1000 // 1-minute aggregation
const ROLLING_WINDOW = 60 // 60-minute baseline for Standard Deviation
const SD_MULTIPLIER = 2.5 // Institutional statistical extreme
const VOL_MULTIPLIER = 2.0 // Climax volume required on rejection
const MIN_BLOCK_VALUE = 10_000_000 // ₹1Cr block for stocks
const COOLDOWN_SECONDS = 1800 // 30 mins
// ─────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

// Active all day: The 2.5 SD math naturally filters out low-volatility lunch chop.
const isActiveWindow = (): boolean => {
	const m = getISTMinutes()
	return m >= 9 * 60 + 30 && m <= 15 * 60 + 15
}

interface Candle {
	open: number
	high: number
	low: number
	close: number
	volume: number
	startTs: number
}

export class VwapStdevReversionDetector implements IDetector {
	public name = 'Statistical VWAP SD Reversion'
	public symbol: string

	private currentCandle: Candle | null = null
	private history: Candle[] = []
	private rollingSum: number = 0
	private rollingSumSq: number = 0
	constructor(symbol: string) {
		this.symbol = symbol
	}

	public async analyze(liveTick: TickData): Promise<void> {
		if (!isActiveWindow()) return

		const now = liveTick.timestamp

		// ── Build 1-min candle ───────────────────────────────────────────────
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
		const closedCandle = { ...this.currentCandle }
		this.currentCandle = {
			open: liveTick.price,
			high: liveTick.price,
			low: liveTick.price,
			close: liveTick.price,
			volume: liveTick.volume,
			startTs: now,
		}

		this.history.push(closedCandle)
		this.rollingSum += closedCandle.close
		this.rollingSumSq += closedCandle.close * closedCandle.close
		if (this.history.length > ROLLING_WINDOW) {
			const oldCandle = this.history.shift()!
			this.rollingSum -= oldCandle.close
			this.rollingSumSq -= oldCandle.close * oldCandle.close
		}

		// Require at least 15 minutes of data to calculate a valid standard deviation
		if (this.history.length < 15) return

		const cooldownKey = `cooldown:stdev_rev:${this.symbol}`
		if (await redisClient.get(cooldownKey)) return

		const vwap = await getVwap(this.symbol)
		if (!vwap) return

		// ── Calculate Standard Deviation (Math Engine) ────────────────────────
		// const closes = this.history.map((c) => c.close)
		// const mean = closes.reduce((a, b) => a + b, 0) / closes.length
		// const variance = closes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / closes.length
		// const standardDeviation = Math.sqrt(variance)
		const n = this.history.length
		const mean = this.rollingSum / n
		const variance = Math.max(0, this.rollingSumSq / n - mean * mean) // Max 0 prevents floating point negatives
		const standardDeviation = Math.sqrt(variance)

		const isVolatileEnough = standardDeviation > vwap * 0.001
		if (!isVolatileEnough) return

		// ── Evaluate Institutional Filters ────────────────────────────────────
		const isIndex = this.symbol === 'NSE:NIFTY50-INDEX'
		const marketBias = await getMarketBias()

		const baselineCandles = this.history.slice(0, -1)
		const avgVol =
			baselineCandles.length > 0
				? baselineCandles.reduce((a, c) => a + c.volume, 0) / baselineCandles.length
				: 0

		// Index bypasses volume/block checks (fixing the volume bug natively)
		const isVolumeConfirmed =
			isIndex || (avgVol > 0 && closedCandle.volume > avgVol * VOL_MULTIPLIER)
		const blockValue = closedCandle.close * closedCandle.volume
		const isBlockSized = isIndex || blockValue >= MIN_BLOCK_VALUE

		const upperBand = vwap + standardDeviation * SD_MULTIPLIER
		const lowerBand = vwap - standardDeviation * SD_MULTIPLIER

		// ── SHORT: Overbought Reversal (Price > Upper Band) ───────────────────
		const isOverbought = closedCandle.close >= upperBand
		const isBearishRejection = closedCandle.close < closedCandle.open // Red closing candle

		if (
			isOverbought &&
			isBearishRejection &&
			isVolumeConfirmed &&
			isBlockSized &&
			marketBias !== 'bullish'
		) {
			const sl = Number(closedCandle.high.toFixed(2))
			const target = Number(vwap.toFixed(2)) // Mean reversion target is always VWAP

			// [FIX] Extract best strike early for cleaner logging
			const bestStrike = isIndex ? getBestStrike('PE', closedCandle.close) : null

			console.log(`\n🔴 [SD REVERSION SHORT] ${this.symbol} | 2.5 SD Extreme Rejection`)
			if (isIndex)
				console.log(`   Routing to Strike: ${bestStrike?.strike} PE | Premium: ₹${bestStrike?.ltp}`)

			sendTelegramAlert({
				symbol: isIndex && bestStrike ? `NIFTY ${bestStrike.strike} PE` : this.symbol,
				price: closedCandle.close,
				side: 'SHORT',
				percentageChange: Number((((closedCandle.close - vwap) / vwap) * 100).toFixed(2)),
				volumeSpikeRatio: isIndex ? 1 : Number((closedCandle.volume / avgVol).toFixed(1)),
				trigger: `📉 +${SD_MULTIPLIER} SD Statistical Exhaustion | ${isIndex ? 'Index' : 'Stock'} ₹${closedCandle.close} | VWAP ₹${vwap.toFixed(2)} | SL ₹${sl} | Target VWAP ₹${target}`,
				vwap: vwap,
				avgPrice: mean,
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
			return
		}

		// ── LONG: Oversold Reversal (Price < Lower Band) ──────────────────────
		const isOversold = closedCandle.close <= lowerBand
		const isBullishRejection = closedCandle.close > closedCandle.open // Green closing candle

		if (
			isOversold &&
			isBullishRejection &&
			isVolumeConfirmed &&
			isBlockSized &&
			marketBias !== 'bearish'
		) {
			const sl = Number(closedCandle.low.toFixed(2))
			const target = Number(vwap.toFixed(2))

			// [FIX] Extract best strike early for cleaner logging
			const bestStrike = isIndex ? getBestStrike('CE', closedCandle.close) : null

			console.log(`\n🟢 [SD REVERSION LONG] ${this.symbol} | -2.5 SD Extreme Rejection`)
			if (isIndex)
				console.log(`   Routing to Strike: ${bestStrike?.strike} CE | Premium: ₹${bestStrike?.ltp}`)

			sendTelegramAlert({
				symbol: isIndex && bestStrike ? `NIFTY ${bestStrike.strike} CE` : this.symbol,
				price: closedCandle.close,
				side: 'LONG',
				percentageChange: Number((((closedCandle.close - vwap) / vwap) * 100).toFixed(2)),
				volumeSpikeRatio: isIndex ? 1 : Number((closedCandle.volume / avgVol).toFixed(1)),
				trigger: `📈 -${SD_MULTIPLIER} SD Statistical Exhaustion | ${isIndex ? 'Index' : 'Stock'} ₹${closedCandle.close} | VWAP ₹${vwap.toFixed(2)} | SL ₹${sl} | Target VWAP ₹${target}`,
				vwap: vwap,
				avgPrice: mean,
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
			return
		}
	}
}
