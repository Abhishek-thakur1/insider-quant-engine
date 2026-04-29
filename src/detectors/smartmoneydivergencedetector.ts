// ============================================================
// smartMoneyDivergenceDetector.ts
//
// ── THE INSTITUTIONAL CONCEPT ────────────────────────────────
//
// Richard Wyckoff (1910s) discovered that price and volume must
// AGREE for a move to be real. When they DISAGREE, institutions
// are doing the opposite of what retail sees.
//
// There are exactly two high-probability divergences:
//
// ── BEARISH DIVERGENCE (Distribution) ────────────────────────
//   Price makes new highs → but volume is DECLINING
//
//   What this means:
//   Retail sees price going up and chases it (FOMO buying).
//   But institutions are quietly SELLING into that retail demand.
//   They are distributing their positions at the highs.
//   Volume declining means fewer and fewer real buyers are left.
//   When retail buying exhausts → price collapses.
//
//   Real example: stock hits ₹500 on 50L volume, then ₹510 on
//   35L volume, then ₹515 on 20L volume. Price up, volume down.
//   Institutions have been unloading. The move is fake.
//
// ── BULLISH DIVERGENCE (Accumulation) ────────────────────────
//   Price makes new lows → but volume is DECLINING
//
//   What this means:
//   Retail sees price going down and panics (stops being hit).
//   But institutions are quietly BUYING into that retail selling.
//   Volume declining on new lows means sellers are exhausted.
//   When panic selling stops → institutions have loaded up →
//   price reverses sharply upward.
//
//   Real example: stock drops to ₹480 on 45L volume, then ₹475
//   on 28L volume, then ₹470 on 12L volume. Price down, volume
//   down. Smart money absorbed all the selling. Reversal coming.
//
// ── THE MATH ─────────────────────────────────────────────────
//
// We use 3 consecutive 1-min candles for confirmation:
//   - Each candle must make a new high (bearish) or new low (bullish)
//   - Each candle's volume must be LOWER than the previous
//   - Volume decline must be meaningful: > 15% drop each candle
//     (not just random tick variance)
//
// Additional filters:
//   - VWAP position confirms which side institutions are on
//   - Market bias (Nifty) must not oppose the signal
//   - Minimum block value: this divergence must be happening
//     at institutional scale (₹1Cr+ candles), not penny stocks
//   - Cooldown: 30 min — divergences are not high-frequency
//
// ── WHY THIS IS HIGH PROBABILITY ─────────────────────────────
//
// Institutions cannot hide their volume. They can hide their
// direction (buy/sell) via dark pools, but total volume on
// exchange is always visible. When a stock makes new highs with
// shrinking volume, it is mathematically impossible for the move
// to continue at the same rate — there are simply not enough
// buyers left to sustain it.
//
// This is not pattern matching. This is supply/demand physics.
//
// ── ENTRY / EXIT ─────────────────────────────────────────────
//
// Bearish divergence (SHORT):
//   Entry:  On close of 3rd candle (divergence confirmed)
//   SL:     Above the highest high of the 3 candles + 0.1%
//   T1:     VWAP (mean reversion target — institutions defend it)
//   T2:     VWAP - (distance from entry to VWAP) × 0.5 (extension)
//
// Bullish divergence (LONG):
//   Entry:  On close of 3rd candle
//   SL:     Below the lowest low of the 3 candles - 0.1%
//   T1:     VWAP
//   T2:     VWAP + (distance from entry to VWAP) × 0.5
// ============================================================

import { sendTelegramAlert } from '../workers/telegramWorker.js'
import type { IDetector, TickData } from '../core/types.js'
import { redisClient } from '../config/redis.js'
import { getVwap, getMarketBias } from '../utils/vwapUtils.js'

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
const CANDLE_DURATION_MS = 60 * 1000 // 1-minute candles
const LOOKBACK_CANDLES = 4 // 4 consecutive candles for divergence
const MIN_VOL_DECLINE_PCT = 0.3 // each candle volume must drop > 30%
const MIN_BLOCK_VALUE = 50_000_000 // ₹5Cr — institutional scale only
const COOLDOWN_SECONDS = 14400 // 4 Hours (One alert per session per stock)
const MAX_CANDLES_HISTORY = 10 // rolling candle buffer

// Opening 15 min excluded — volume is structurally high at open
// Post 2:30 PM excluded — low liquidity, divergences are unreliable
const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}
const isActiveWindow = (): boolean => {
	const m = getISTMinutes()
	return m >= 9 * 60 + 30 && m <= 14 * 60 + 30
}
// ─────────────────────────────────────────────────────────────

interface Candle {
	open: number
	high: number
	low: number
	close: number
	volume: number
	startTs: number
}

export class SmartMoneyDivergenceDetector implements IDetector {
	public name = 'Smart Money Price-Volume Divergence (Wyckoff)'
	public symbol: string

	private currentCandle: Candle | null = null
	private history: Candle[] = []

	constructor(symbol: string) {
		this.symbol = symbol
	}

	public async analyze(liveTick: TickData): Promise<void> {
		if (!isActiveWindow()) return

		const now = liveTick.timestamp

		// ── Build 1-min candle ───────────────────────────────────────────
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

		// ── Candle closed ────────────────────────────────────────────────
		const c = { ...this.currentCandle }
		this.currentCandle = {
			open: liveTick.price,
			high: liveTick.price,
			low: liveTick.price,
			close: liveTick.price,
			volume: liveTick.volume,
			startTs: now,
		}

		this.history.push(c)
		if (this.history.length > MAX_CANDLES_HISTORY) this.history.shift()

		// Need at least LOOKBACK_CANDLES complete candles
		if (this.history.length < LOOKBACK_CANDLES) return

		const cooldownKey = `cooldown:smd:${this.symbol}`
		if (await redisClient.get(cooldownKey)) return

		const vwap = await getVwap(this.symbol)
		if (!vwap) return

		const marketBias = await getMarketBias()

		// Get the last N candles for divergence analysis
		const candles = this.history.slice(-LOOKBACK_CANDLES)

		// ── BEARISH DIVERGENCE: Higher highs + Lower volume ───────────────
		//
		// Each candle must:
		//   1. Make a new high (price climbing — retail is FOMO buying)
		//   2. Have LOWER volume than previous (institutions not participating)
		//   3. Volume decline must be > MIN_VOL_DECLINE_PCT (meaningful, not noise)
		//
		// const isBearishDivergence = candles.every((candle, i) => {
		// 	if (i === 0) return true // first candle is the anchor
		// 	const prev = candles[i - 1]!
		// 	const isNewHigh = candle.high > prev.high
		// 	const isVolumeDeclining =
		// 		prev.volume > 0 && (prev.volume - candle.volume) / prev.volume >= MIN_VOL_DECLINE_PCT
		// 	return isNewHigh && isVolumeDeclining
		// })
		// ── BEARISH DIVERGENCE: Higher highs + Lower volume (Block Evaluation) ───────────────
		const firstCandle = candles[0]!
		const latestCandle = candles[candles.length - 1]!
		const avgVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length

		// 1. Did the sequence push to new highs overall?
		const pushedHigher = latestCandle.high > firstCandle.high

		// 2. Is overall volume drying up from start to finish?
		const volumeDriedUp =
			firstCandle.volume > 0 &&
			(firstCandle.volume - latestCandle.volume) / firstCandle.volume >= MIN_VOL_DECLINE_PCT

		// 3. Ensure the final candle isn't a massive hidden accumulation spike
		const noHiddenSpikes = latestCandle.volume < avgVolume

		const isBearishDivergence = pushedHigher && volumeDriedUp && noHiddenSpikes

		const blockValue = latestCandle.close * latestCandle.volume
		const isNiftyAlignedShort = marketBias === 'bearish' || marketBias === 'neutral'
		const isCatalystDrivenShort =
			marketBias === 'bullish' &&
			latestCandle.close < vwap * 0.99 &&
			blockValue > MIN_BLOCK_VALUE * 1.5

		if (isBearishDivergence && (isNiftyAlignedShort || isCatalystDrivenShort)) {
			// Additional confirmation: latest candle should be at/above VWAP
			// (distribution happens at highs, which should be above VWAP)
			// const latestCandle = candles[candles.length - 1]!
			if (latestCandle.close < vwap) return // not at a high enough level

			// Block value check on the latest candle
			// const blockValue = latestCandle.close * latestCandle.volume
			if (blockValue < MIN_BLOCK_VALUE) return

			const highestHigh = Math.max(...candles.map((c) => c.high))
			const sl = Number((highestHigh * 1.001).toFixed(2)) // 0.1% above highest high
			const distToVwap = latestCandle.close - vwap
			const t1 = Number(vwap.toFixed(2)) // mean reversion to VWAP
			const t2 = Number((vwap - distToVwap * 0.5).toFixed(2)) // extension below

			// Volume decline rate across the 3 candles
			const firstVol = firstCandle.volume
			const lastVol = latestCandle.volume
			const volDeclinePct = (((firstVol - lastVol) / firstVol) * 100).toFixed(0)

			console.log(`\n🧠 [SMART MONEY SHORT] ${this.symbol} — Distribution Detected`)
			console.log(`   Price: ₹${candles.map((c) => c.high.toFixed(2)).join(' → ')} (Higher Highs)`)
			console.log(
				`   Volume: ${candles.map((c) => (c.volume / 1000).toFixed(0) + 'K').join(' → ')} (−${volDeclinePct}% decline)`,
			)

			sendTelegramAlert({
				symbol: this.symbol,
				price: latestCandle.close,
				side: 'SHORT',
				percentageChange: Number((((latestCandle.close - vwap) / vwap) * 100).toFixed(2)),
				volumeSpikeRatio: Number((lastVol / firstVol).toFixed(2)),
				trigger: `🧠 Wyckoff Distribution | ${LOOKBACK_CANDLES} HH + Vol −${volDeclinePct}% | Institutions selling into retail FOMO | SL ₹${sl} | T1 VWAP ₹${t1} | T2 ₹${t2}`,
				vwap,
				avgPrice: candles.reduce((a, c) => a + c.close, 0) / candles.length,
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
			return
		}

		// ── BULLISH DIVERGENCE: Lower lows + Lower volume ─────────────────
		//
		// Each candle must:
		//   1. Make a new low (price dropping — retail is panic selling)
		//   2. Have LOWER volume than previous (selling pressure exhausting)
		//   3. Volume decline > MIN_VOL_DECLINE_PCT (real exhaustion, not noise)
		//
		// const isBullishDivergence = candles.every((candle, i) => {
		// 	if (i === 0) return true
		// 	const prev = candles[i - 1]!
		// 	const isNewLow = candle.low < prev.low
		// 	const isVolumeDeclining =
		// 		prev.volume > 0 && (prev.volume - candle.volume) / prev.volume >= MIN_VOL_DECLINE_PCT
		// 	return isNewLow && isVolumeDeclining
		// })

		// ── BULLISH DIVERGENCE: Lower lows + Lower volume (Block Evaluation) ─────────────────
		// 1. Did the sequence push to lower lows overall?
		const pushedLower = latestCandle.low < firstCandle.low

		// 2. Is selling pressure exhausting from start to finish?
		const sellingDriedUp =
			firstCandle.volume > 0 &&
			(firstCandle.volume - latestCandle.volume) / firstCandle.volume >= MIN_VOL_DECLINE_PCT

		const isBullishDivergence = pushedLower && sellingDriedUp && noHiddenSpikes
		// const blockValue = latestCandle.close * latestCandle.volume
		const isNiftyAlignedLong = marketBias === 'bullish' || marketBias === 'neutral'
		const isCatalystDrivenLong =
			marketBias === 'bearish' &&
			latestCandle.close > vwap * 1.01 &&
			blockValue > MIN_BLOCK_VALUE * 1.5

		if (isBullishDivergence && (isNiftyAlignedLong || isCatalystDrivenLong)) {
			// const latestCandle = candles[candles.length - 1]!
			if (latestCandle.close > vwap) return // not at a low enough level

			// const blockValue = latestCandle.close * latestCandle.volume
			if (blockValue < MIN_BLOCK_VALUE) return

			const lowestLow = Math.min(...candles.map((c) => c.low))
			const sl = Number((lowestLow * 0.999).toFixed(2)) // 0.1% below lowest low
			const distToVwap = vwap - latestCandle.close
			const t1 = Number(vwap.toFixed(2)) // mean reversion to VWAP
			const t2 = Number((vwap + distToVwap * 0.5).toFixed(2)) // extension above

			const firstVol = firstCandle.volume
			const lastVol = latestCandle.volume
			const volDeclinePct = (((firstVol - lastVol) / firstVol) * 100).toFixed(0)

			console.log(`\n🧠 [SMART MONEY LONG] ${this.symbol} — Accumulation Detected`)
			console.log(`   Price: ₹${candles.map((c) => c.low.toFixed(2)).join(' → ')} (Lower Lows)`)
			console.log(
				`   Volume: ${candles.map((c) => (c.volume / 1000).toFixed(0) + 'K').join(' → ')} (−${volDeclinePct}% decline)`,
			)

			sendTelegramAlert({
				symbol: this.symbol,
				price: latestCandle.close,
				side: 'LONG',
				percentageChange: Number((((vwap - latestCandle.close) / vwap) * 100).toFixed(2)),
				volumeSpikeRatio: Number((lastVol / firstVol).toFixed(2)),
				trigger: `🧠 Wyckoff Accumulation | ${LOOKBACK_CANDLES} LL + Vol −${volDeclinePct}% | Institutions absorbing retail panic | SL ₹${sl} | T1 VWAP ₹${t1} | T2 ₹${t2}`,
				vwap,
				avgPrice: candles.reduce((a, c) => a + c.close, 0) / candles.length,
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
			return
		}
	}
}
