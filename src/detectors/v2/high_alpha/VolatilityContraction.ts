import { redisClient } from '../../../config/redis.js'
import type { TickData } from '../../../core/types.js'
import { getVwap } from '../../../utils/vwapUtils.js'
import { BaseDetector } from './baseDetector.js'

const CANDLE_5M_MS = 5 * 60 * 1000
const LOOKBACK_CANDLES = 6 // 30 mins of context

interface Candle5M {
	high: number
	low: number
	close: number
	volume: number
	startTs: number
}

export class VolatilityContraction extends BaseDetector {
	private currentCandle: Candle5M | null = null

	constructor(symbol: string) {
		super(symbol, 'Volatility_Contraction_V2')
	}

	async analyze(liveTick: TickData): Promise<void> {
		// Drop ticks if daily trend isn't bullish (Filters out laggards)
		if (!(await this.isDailyTrendAligned('BULLISH'))) return

		const now = liveTick.timestamp

		// Build 5-Min Candles
		if (!this.currentCandle) {
			this.currentCandle = {
				high: liveTick.price,
				low: liveTick.price,
				close: liveTick.price,
				volume: liveTick.volume,
				startTs: now,
			}
			return
		}

		if (now - this.currentCandle.startTs < CANDLE_5M_MS) {
			this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price)
			this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price)
			this.currentCandle.close = liveTick.price
			this.currentCandle.volume += liveTick.volume
			return
		}

		const closedCandle = { ...this.currentCandle }
		this.currentCandle = {
			high: liveTick.price,
			low: liveTick.price,
			close: liveTick.price,
			volume: liveTick.volume,
			startTs: now,
		}

		const historyKey = `v2:vcp_history:${this.symbol}`
		const cooldownKey = `v2:cooldown:vcp:${this.symbol}`

		if (await redisClient.get(cooldownKey)) return

		// Maintain rolling history
		await redisClient.lPush(historyKey, JSON.stringify(closedCandle))
		await redisClient.lTrim(historyKey, 0, LOOKBACK_CANDLES - 1)

		const rawHistory = await redisClient.lRange(historyKey, 0, -1)
		if (rawHistory.length < LOOKBACK_CANDLES) return

		const history: Candle5M[] = rawHistory.map((r) => JSON.parse(r))

		// MATHEMATICAL VCP CHECK
		// Split history: Oldest 3 candles vs Newest 3 candles
		const olderHalf = history.slice(3, 6)
		const newerHalf = history.slice(0, 3)

		const getAvgRange = (candles: Candle5M[]) =>
			candles.reduce((sum, c) => sum + (c.high - c.low), 0) / candles.length
		const getAvgVol = (candles: Candle5M[]) =>
			candles.reduce((sum, c) => sum + c.volume, 0) / candles.length

		const oldRange = getAvgRange(olderHalf)
		const newRange = getAvgRange(newerHalf)
		const oldVol = getAvgVol(olderHalf)
		const newVol = getAvgVol(newerHalf)

		// 1. Volatility MUST be contracting (Range tightening by at least 40%)
		if (newRange > oldRange * 0.6) return

		// 2. Volume MUST be drying up during contraction
		if (newVol > oldVol * 0.7) return

		const pivotResistance = Math.max(...newerHalf.map((c) => c.high))
		const vwap = await getVwap(this.symbol)

		// 3. The Breakout Trigger (Tick level check against established pivot)
		if (liveTick.price > pivotResistance && (vwap ? liveTick.price > vwap : true)) {
			// Is there a surge in volume on the exact minute of the breakout?
			const isVolumeSpike = liveTick.volume > newVol * 1.5

			if (isVolumeSpike) {
				console.log(`\n🚀 [V2 VCP] ${this.symbol} breaking contracted pivot at ₹${pivotResistance}`)

				await this.triggerAlert({
					symbol: this.symbol,
					price: liveTick.price,
					side: 'LONG',
					percentageChange: vwap ? Number((((liveTick.price - vwap) / vwap) * 100).toFixed(2)) : 0,
					volumeSpikeRatio: Number((liveTick.volume / newVol).toFixed(1)),
					trigger: `📦 VCP Breakout | Contraction Confirmed | Pivot ₹${pivotResistance.toFixed(2)}`,
					vwap: vwap || liveTick.price,
					avgPrice: pivotResistance,
				})

				await redisClient.setEx(cooldownKey, 3600, '1') // 1 hour cooldown
			}
		}
	}
}
