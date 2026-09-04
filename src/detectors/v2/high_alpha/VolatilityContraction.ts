import { redisClient } from '../../../config/redis.js'
import type { TickData } from '../../../core/types.js'
import { getVwap } from '../../../utils/vwapUtils.js'
import { BaseDetector } from './baseDetector.js'

const CANDLE_5M_MS = 5 * 60 * 1000
// [FIX — root cause #3] 7, not 6. history[0] is the breakout candle being
// evaluated; the contraction box is measured from history[1..3] and the prior
// range from history[4..6]. With 6 the box included the breakout candle itself,
// so `close > pivot` was asking the candle to close above its own high.
// 7 x 5min = 35 min of context before this can arm.
const LOOKBACK_CANDLES = 7

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
		// history[0] = the just-closed breakout candidate (excluded from the box)
		// history[1..3] = contraction window   history[4..6] = prior range
		const breakoutCandle = history[0]!
		const newerHalf = history.slice(1, 4)
		const olderHalf = history.slice(4, 7)

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
		if (newVol <= 0) return

		const pivotResistance = Math.max(...newerHalf.map((c) => c.high))
		const vwap = await getVwap(this.symbol)

		// 3. The Breakout Trigger — CANDLE-CONFIRMED.
		//
		// [FIX — root cause #3] This used to read the raw tick: `liveTick.price >
		// pivotResistance` with `liveTick.volume > newVol * 1.5`. Two defects:
		//   (a) liveTick here is the FIRST tick of the next candle, so the
		//       breakout fired on a single unconfirmed print;
		//   (b) it compared ONE TICK's volume against a 5-MINUTE candle average,
		//       a ~300x scale mismatch that made the volume gate practically
		//       unsatisfiable — so the detector either never fired, or fired on
		//       price alone with no volume confirmation at all.
		// Both sides of the comparison are now the closed 5-min candle.
		const brokeOut = breakoutCandle.close > pivotResistance
		const aboveVwap = vwap ? breakoutCandle.close > vwap : true
		const volumeRatio = breakoutCandle.volume / newVol
		const isVolumeSpike = volumeRatio >= 1.5

		if (brokeOut && aboveVwap && isVolumeSpike) {
			console.log(`
🚀 [V2 VCP] ${this.symbol} closed above contracted pivot ₹${pivotResistance.toFixed(2)} on ${volumeRatio.toFixed(1)}x volume`)

			const sl = Number((Math.min(...newerHalf.map((c) => c.low)) * 0.999).toFixed(2))
			const risk = breakoutCandle.close - sl
			if (risk <= 0 || risk / breakoutCandle.close > 0.02) return // SL wider than 2% = skip

			const t1 = Number((breakoutCandle.close + risk * 1.5).toFixed(2))
			const t2 = Number((breakoutCandle.close + risk * 2.5).toFixed(2))

			await this.triggerAlert({
				symbol: this.symbol,
				price: breakoutCandle.close,
				side: 'LONG',
				percentageChange: vwap
					? Number((((breakoutCandle.close - vwap) / vwap) * 100).toFixed(2))
					: 0,
				volumeSpikeRatio: Number(volumeRatio.toFixed(1)),
				// SL/T1 must be in the trigger text — janeStreetFilter regex-parses
				// them for the EV gate. Without them it falls back to 0.3%/1.5R.
				trigger: `📦 VCP Breakout | Contraction Confirmed | Pivot ₹${pivotResistance.toFixed(2)} | Range -${(100 - (newRange / oldRange) * 100).toFixed(0)}% | Vol dry -${(100 - (newVol / oldVol) * 100).toFixed(0)}% | ${volumeRatio.toFixed(1)}x breakout vol | SL ₹${sl} | T1 ₹${t1} | T2 ₹${t2}`,
				vwap: vwap || breakoutCandle.close,
				avgPrice: pivotResistance,
				detectorName: this.name,
				regimeClass: 'MOMENTUM',
			})

			await redisClient.setEx(cooldownKey, 3600, '1') // 1 hour cooldown
		}
	}
}
