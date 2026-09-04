import { redisClient } from '../../../config/redis.js'
import type { TickData } from '../../../core/types.js'
import { getVwap } from '../../../utils/vwapUtils.js'
import { BaseDetector } from './baseDetector.js'

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
const CANDLE_1M_MS = 60 * 1000
const OR_START_MIN = 9 * 60 + 15 // 09:15
const OR_END_MIN = 9 * 60 + 30 // 09:30 — opening range locks
const ACTIVE_END_MIN = 10 * 60 + 15 // 10:15
const OR_MINUTES = 15 // minutes in the opening range, for the volume baseline
const MIN_RANGE_PCT = 0.5 // below this the open was too choppy to mean anything
const MAX_RANGE_PCT = 2.5 // above this the gap has already run
const BREAKOUT_BUFFER = 1.002 // must clear ORH by 0.2%
const MIN_BLOCK_VALUE = 5_000_000 // ₹50L of turnover in the breakout minute
const MIN_VOL_MULT = 1.5 // breakout minute vs average opening-range minute
const MAX_RISK_PCT = 0.015 // skip if the stop is wider than 1.5%
const COOLDOWN_SECONDS = 28800 // 8h → one Gap & Go per name per day

interface Candle1M {
	open: number
	high: number
	low: number
	close: number
	volume: number
	startTs: number
}

export class GapAndGoMomentum extends BaseDetector {
	private orHigh: number = 0
	private orLow: number = Infinity
	private rangeLocked: boolean = false
	private openingVolume: number = 0
	private currentCandle: Candle1M | null = null

	constructor(symbol: string) {
		super(symbol, 'Gap_And_Go_V2')
	}

	async analyze(liveTick: TickData): Promise<void> {
		const now = new Date(liveTick.timestamp + 5.5 * 60 * 60 * 1000)
		const m = now.getUTCHours() * 60 + now.getUTCMinutes()

		// Build opening range during 09:15–09:30 (first 15 min)
		if (m >= OR_START_MIN && m < OR_END_MIN) {
			this.orHigh = Math.max(this.orHigh, liveTick.price)
			this.orLow = Math.min(this.orLow, liveTick.price)

			// Cumulative opening-range volume — the baseline the breakout minute is
			// measured against. (Previously accumulated and never read.)
			this.openingVolume += liveTick.volume
			this.rangeLocked = false
			return
		}

		// Lock range once, on the first tick after 09:30
		if (!this.rangeLocked) {
			if (this.orHigh === 0 || this.orLow === Infinity) return
			this.rangeLocked = true
			console.log(
				`[GapAndGo] 🔒 ${this.symbol} OR locked | H:${this.orHigh.toFixed(2)} L:${this.orLow.toFixed(2)} | OR vol ${this.openingVolume}`,
			)
		}

		// Only active 09:30–10:15
		if (m < OR_END_MIN || m > ACTIVE_END_MIN) return

		// ── Build 1-min candle ───────────────────────────────────────────────
		// [FIX — root cause #3] The breakout used to be evaluated on a single raw
		// tick: `liveTick.price > orHigh * 1.002`, with the block-size test reading
		// ONE tick's volume against a ₹50L threshold. A single print almost never
		// clears ₹50L, so the institutional-participation filter was effectively
		// dead, while the price side fired on the first unconfirmed print through
		// the level — precisely the false-breakout / instant-reversal failure mode.
		// Both are now evaluated on a closed 1-minute candle.
		const ts = liveTick.timestamp

		if (!this.currentCandle) {
			this.currentCandle = {
				open: liveTick.price,
				high: liveTick.price,
				low: liveTick.price,
				close: liveTick.price,
				volume: liveTick.volume,
				startTs: ts,
			}
			return
		}

		if (ts - this.currentCandle.startTs < CANDLE_1M_MS) {
			this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price)
			this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price)
			this.currentCandle.close = liveTick.price
			this.currentCandle.volume += liveTick.volume
			return
		}

		// ── Candle closed — evaluate ─────────────────────────────────────────
		const closed = { ...this.currentCandle }
		this.currentCandle = {
			open: liveTick.price,
			high: liveTick.price,
			low: liveTick.price,
			close: liveTick.price,
			volume: liveTick.volume,
			startTs: ts,
		}

		const cooldownKey = `v2:cooldown:gapgo:${this.symbol}`
		if (await redisClient.get(cooldownKey)) return

		const rangeSpread = ((this.orHigh - this.orLow) / this.orLow) * 100

		// Avoid choppy or already-extended ranges
		if (rangeSpread < MIN_RANGE_PCT || rangeSpread > MAX_RANGE_PCT) return

		const vwap = await getVwap(this.symbol)
		if (!vwap) return
		if (closed.close < vwap) return

		// Candle-level institutional participation
		const blockValue = closed.close * closed.volume
		const isBlockSized = blockValue >= MIN_BLOCK_VALUE

		// Breakout minute vs the average opening-range minute
		const orAvgMinuteVol = this.openingVolume / OR_MINUTES
		const volumeRatio = orAvgMinuteVol > 0 ? closed.volume / orAvgMinuteVol : 0
		const isVolumeConfirmed = volumeRatio >= MIN_VOL_MULT

		const brokeOut = closed.close > this.orHigh * BREAKOUT_BUFFER

		if (brokeOut && isBlockSized && isVolumeConfirmed) {
			// Stop just under the level that was broken — a failed breakout is
			// invalidated by losing the ORH, not by drifting back inside the range.
			const sl = Number((this.orHigh * 0.998).toFixed(2))
			const risk = closed.close - sl
			if (risk <= 0 || risk / closed.close > MAX_RISK_PCT) return

			const t1 = Number((closed.close + risk * 1.5).toFixed(2))
			const t2 = Number((closed.close + risk * 2.5).toFixed(2))

			console.log(
				`\n🏎️ [V2 GAP AND GO] ${this.symbol} closed above ORH ₹${this.orHigh.toFixed(2)} on ${volumeRatio.toFixed(1)}x opening vol`,
			)

			await this.triggerAlert({
				symbol: this.symbol,
				price: closed.close,
				side: 'LONG',
				percentageChange: Number((((closed.close - vwap) / vwap) * 100).toFixed(2)),
				// A real ratio now, instead of the hardcoded 2.0 that used to be
				// sent — the Bayesian volume evidence reads this field directly.
				volumeSpikeRatio: Number(volumeRatio.toFixed(1)),
				// SL/T1 must appear in the trigger text: janeStreetFilter
				// regex-parses them for the EV gate (see AGENTS.md §5.3).
				trigger: `🏎️💨 Gap & Go | ORH ₹${this.orHigh.toFixed(2)} Broken on close | Range ${rangeSpread.toFixed(2)}% | ${volumeRatio.toFixed(1)}x opening-min vol | Above VWAP ₹${vwap.toFixed(2)} | Block ₹${(blockValue / 100_000).toFixed(1)}L | SL ₹${sl} | T1 ₹${t1} | T2 ₹${t2}`,
				vwap: vwap,
				avgPrice: this.orHigh,
				detectorName: this.name,
				regimeClass: 'MOMENTUM',
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, '1')
		}
	}
}
