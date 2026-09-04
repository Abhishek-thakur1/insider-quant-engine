// ============================================================
// Detects accumulation/distribution boxes on 1-min candle data
// then fires when price breaks out with explosive volume.
// ============================================================

import { sendTelegramAlert } from '../../workers/telegramWorker.js'
import type { IDetector, TickData } from '../../core/types.js'
import { redisClient } from '../../config/redis.js'
import { getVwap, getMarketBias } from '../../utils/vwapUtils.js'

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
const CANDLE_DURATION_MS = 60 * 1000
const CONSOLIDATION_CANDLES = 5
const MAX_BOX_SPREAD_PCT = 0.8
const BREAKOUT_VOL_MULTIPLIER = 7 // used for LONG breakouts
//  BREAKDOWN_VOL_MULTIPLIER was defined but never used — the SHORT
// breakdown path was using BREAKOUT_VOL_MULTIPLIER instead. This meant both
// directions used the same threshold even though the constants implied they
// could be tuned independently.
//
// [WHAT TO CHANGE]: The SHORT breakdown now correctly references
// BREAKDOWN_VOL_MULTIPLIER. Both are set to 7 so behavior is currently
// identical — but they can now be tuned independently without risk of one
// silently being ignored.
const BREAKDOWN_VOL_MULTIPLIER = 7 // [FIX] now actually used for SHORT breakdowns
const MIN_BREAKOUT_BODY_PCT = 0.3
const COOLDOWN_SECONDS = 1800
const MIN_BLOCK_VALUE = 10_000_000
// ─────────────────────────────────────────────────────────────

interface Candle {
	open: number
	high: number
	low: number
	close: number
	volume: number
	startTs: number
}

const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}
const isMarketHours = (): boolean => {
	const m = getISTMinutes()
	return m >= 9 * 60 + 45 && m <= 15 * 60
}

export class CandleBreakoutDetector implements IDetector {
	public name = 'Candle Accumulation Breakout'
	public symbol: string

	private currentCandle: Candle | null = null

	constructor(symbol: string) {
		this.symbol = symbol
	}

	public async analyze(liveTick: TickData): Promise<void> {
		if (!isMarketHours()) return

		const now = liveTick.timestamp

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

		const candleAge = now - this.currentCandle.startTs

		if (candleAge < CANDLE_DURATION_MS) {
			this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price)
			this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price)
			this.currentCandle.close = liveTick.price
			this.currentCandle.volume += liveTick.volume
			return
		}

		const completedCandle = { ...this.currentCandle }

		this.currentCandle = {
			open: liveTick.price,
			high: liveTick.price,
			low: liveTick.price,
			close: liveTick.price,
			volume: liveTick.volume,
			startTs: now,
		}

		const candleKey = `candles:${this.symbol}`
		const cooldownKey = `cooldown:candle:${this.symbol}`

		const isCoolingDown = await redisClient.get(cooldownKey)
		if (isCoolingDown) {
			await redisClient
				.multi()
				.lPush(candleKey, JSON.stringify(completedCandle))
				.lTrim(candleKey, 0, CONSOLIDATION_CANDLES + 2)
				.exec()
			return
		}

		const rawCandles = await redisClient.lRange(candleKey, 0, -1)
		const history: Candle[] = rawCandles.map((c) => JSON.parse(c) as Candle)

		if (history.length >= CONSOLIDATION_CANDLES) {
			const boxCandles = history.slice(0, CONSOLIDATION_CANDLES)
			const boxHigh = Math.max(...boxCandles.map((c) => c.high))
			const boxLow = Math.min(...boxCandles.map((c) => c.low))
			const boxSpread = ((boxHigh - boxLow) / boxLow) * 100
			const boxAvgVol = boxCandles.reduce((a, c) => a + c.volume, 0) / boxCandles.length

			const isConsolidating = boxSpread < MAX_BOX_SPREAD_PCT

			if (isConsolidating) {
				const vwap = await getVwap(this.symbol)
				const marketBias = await getMarketBias()

				const candleValue = completedCandle.close * completedCandle.volume
				const isBlockSized = candleValue >= MIN_BLOCK_VALUE
				const bodyPct =
					(Math.abs(completedCandle.close - completedCandle.open) / completedCandle.open) * 100
				const isRealBody = bodyPct >= MIN_BREAKOUT_BODY_PCT

				// ── LONG: Bullish breakout candle ──────────────────────────────
				const isVolumeExplosionLong = completedCandle.volume > boxAvgVol * BREAKOUT_VOL_MULTIPLIER // BREAKOUT_VOL_MULTIPLIER for LONG

				const isBullishBreakout =
					completedCandle.close > boxHigh &&
					completedCandle.close > completedCandle.open &&
					(vwap !== null ? completedCandle.close > vwap : true) &&
					marketBias !== 'bearish'

				if (isBlockSized && isVolumeExplosionLong && isRealBody && isBullishBreakout) {
					console.log(`\n🚀 [CANDLE BREAKOUT LONG] ${this.symbol}`)
					console.log(
						`   Box: ₹${boxLow.toFixed(2)}–₹${boxHigh.toFixed(2)} | Spread: ${boxSpread.toFixed(2)}%`,
					)
					console.log(
						`   Breakout candle: O:${completedCandle.open} H:${completedCandle.high} L:${completedCandle.low} C:${completedCandle.close}`,
					)
					console.log(
						`   Volume: ${completedCandle.volume.toLocaleString()} = ${(completedCandle.volume / boxAvgVol).toFixed(1)}× box avg`,
					)

					sendTelegramAlert({
						symbol: this.symbol,
						price: completedCandle.close,
						side: 'LONG',
						percentageChange: Number(
							(((completedCandle.close - boxLow) / boxLow) * 100).toFixed(2),
						),
						volumeSpikeRatio: Number((completedCandle.volume / boxAvgVol).toFixed(1)),
						trigger: `🕯️ ${CONSOLIDATION_CANDLES}min Accumulation Breakout | Box ₹${boxLow.toFixed(2)}–₹${boxHigh.toFixed(2)} | ${(completedCandle.volume / boxAvgVol).toFixed(1)}× vol | ₹${(candleValue / 100_000).toFixed(1)}L candle`,
						vwap: vwap ?? completedCandle.close,
						avgPrice: (boxHigh + boxLow) / 2,
					})

					await redisClient
						.multi()
						.del(candleKey)
						.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
						.exec()
					return
				}

				// ── SHORT: Bearish breakdown candle ────────────────────────────
				// [FIX] Use BREAKDOWN_VOL_MULTIPLIER here, not BREAKOUT_VOL_MULTIPLIER
				const isVolumeExplosionShort = completedCandle.volume > boxAvgVol * BREAKDOWN_VOL_MULTIPLIER // [FIX] was BREAKOUT_VOL_MULTIPLIER

				const isBearishBreakdown =
					completedCandle.close < boxLow &&
					completedCandle.close < completedCandle.open &&
					(vwap !== null ? completedCandle.close < vwap : true) &&
					marketBias !== 'bullish'

				if (isBlockSized && isVolumeExplosionShort && isRealBody && isBearishBreakdown) {
					console.log(`\n💥 [CANDLE BREAKDOWN SHORT] ${this.symbol}`)

					sendTelegramAlert({
						symbol: this.symbol,
						price: completedCandle.close,
						side: 'SHORT',
						percentageChange: Number(
							(((completedCandle.close - boxHigh) / boxHigh) * 100).toFixed(2),
						),
						volumeSpikeRatio: Number((completedCandle.volume / boxAvgVol).toFixed(1)),
						trigger: `🕯️ ${CONSOLIDATION_CANDLES}min Distribution Breakdown | Box ₹${boxLow.toFixed(2)}–₹${boxHigh.toFixed(2)} | ${(completedCandle.volume / boxAvgVol).toFixed(1)}× vol | ₹${(candleValue / 100_000).toFixed(1)}L candle`,
						vwap: vwap ?? completedCandle.close,
						avgPrice: (boxHigh + boxLow) / 2,
					})

					await redisClient
						.multi()
						.del(candleKey)
						.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
						.exec()
					return
				}
			}
		}

		await redisClient
			.multi()
			.lPush(candleKey, JSON.stringify(completedCandle))
			.lTrim(candleKey, 0, CONSOLIDATION_CANDLES + 2)
			.exec()
	}
}
