// ============================================================
// v2/niftyVwapReclaimDetector.ts
//
// NEW DETECTOR — specifically designed to catch Friday's 200-pt rally.
//
// THE PATTERN (why Friday's rally generated ZERO alerts):
//   - Nifty was below VWAP in the morning (bearish bias)
//   - Then reclaimed VWAP with a strong surge
//   - JSFilter saw "neutral bias" and blocked everything
//   - Old detectors needed 15 min of HH candles to arm
//
// VWAP RECLAIM = highest win-rate intraday Nifty setup.
// Logic: When price breaks back above VWAP after being below it
// for ≥ 2 candles, institutions are confirming the reversal.
// The market shifts from bearish to bullish — RIGHT at the moment
// of reclaim is the best R:R entry.
//
// SIGNAL CONDITIONS:
//   1. Price was BELOW VWAP for at least 2 consecutive 3-min closes
//   2. Current 3-min candle CLOSES ABOVE VWAP (the reclaim tick)
//   3. Reclaim candle body >= 0.12% (decisive move, not a wick)
//   4. Price is NOT overextended (within 0.6% above VWAP on reclaim)
//   5. Works inverse too: reclaim below VWAP after 2 closes above = SHORT
//
// WHY THIS HAS HIGH WIN RATE:
//   - Institutions use VWAP as their benchmark — they BUY when price
//     crosses back above their execution benchmark
//   - The "below for 2 candles then reclaim" pattern filters out
//     choppy VWAP crosses (which generate noise)
//   - Entry at reclaim = tight SL just below VWAP = excellent R:R
//
// COOLDOWN: 25 min — one trade per significant structure shift
// ============================================================

import { sendTelegramAlert } from '../../workers/telegramWorker.js'
import type { IDetector, TickData } from '../../core/types.js'
import { redisClient } from '../../config/redis.js'
import { getVwap } from '../../utils/vwapUtils.js'
import { getBestStrike } from '../../utils/optionUtils.js'

// ─── TUNABLE CONSTANTS ────────────────────────────────────────
const CANDLE_MS = 3 * 60 * 1000
const MIN_CANDLES_BELOW_BEFORE_RECLAIM = 2 // must be below VWAP for 2+ candles
const MIN_RECLAIM_BODY_PCT = 0.12 // reclaim candle must have real body
const MAX_EXTENSION_PCT = 0.6 // not overextended at reclaim
const COOLDOWN_SECONDS = 1500 // 25 min between signals
const ACTIVE_START_MINS = 9 * 60 + 20 // 9:20 — let opening print settle
const ACTIVE_END_MINS = 14 * 60 + 45 // 2:45 PM — avoid expiry whipsaw
// ─────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

const isActiveWindow = (): boolean => {
	const m = getISTMinutes()
	return m >= ACTIVE_START_MINS && m <= ACTIVE_END_MINS
}

interface Candle {
	open: number
	high: number
	low: number
	close: number
	volume: number
	startTs: number
}

export class NiftyVwapReclaimDetector implements IDetector {
	public name = 'Nifty VWAP Reclaim'
	public symbol = 'NSE:NIFTY50-INDEX'

	private currentCandle: Candle | null = null
	private closedCandles: Candle[] = []

	// Track VWAP relationship for each completed candle
	private vwapRelationHistory: Array<'above' | 'below'> = []

	public async analyze(liveTick: TickData): Promise<void> {
		if (!isActiveWindow()) return

		const now = liveTick.timestamp

		// ── Build 3-min candle ──────────────────────────────────────────
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

		if (now - this.currentCandle.startTs < CANDLE_MS) {
			this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price)
			this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price)
			this.currentCandle.close = liveTick.price
			this.currentCandle.volume += liveTick.volume
			return
		}

		// ── Candle closed ───────────────────────────────────────────────
		const closed = { ...this.currentCandle }
		this.currentCandle = {
			open: liveTick.price,
			high: liveTick.price,
			low: liveTick.price,
			close: liveTick.price,
			volume: liveTick.volume,
			startTs: now,
		}

		const vwap = await getVwap(this.symbol)
		if (!vwap) return

		// ── Track VWAP relationship for this closed candle ──────────────
		const relation: 'above' | 'below' = closed.close >= vwap ? 'above' : 'below'
		this.vwapRelationHistory.push(relation)
		if (this.vwapRelationHistory.length > 10) this.vwapRelationHistory.shift()

		this.closedCandles.push(closed)
		if (this.closedCandles.length > 10) this.closedCandles.shift()

		if (this.vwapRelationHistory.length < MIN_CANDLES_BELOW_BEFORE_RECLAIM + 1) return

		const cooldownKey = `cooldown:v2:vwap_reclaim`
		if (await redisClient.get(cooldownKey)) return

		const histLen = this.vwapRelationHistory.length
		const current = this.vwapRelationHistory[histLen - 1]!
		const previous = this.vwapRelationHistory.slice(-(MIN_CANDLES_BELOW_BEFORE_RECLAIM + 1), -1)

		// ── LONG: Was BELOW VWAP for 2+ candles, just CLOSED ABOVE ──────
		const wasBelowForMinCandles = previous.every((r) => r === 'below')
		const justReclaimedAbove = current === 'above'

		if (wasBelowForMinCandles && justReclaimedAbove) {
			const bodyPct = ((closed.close - closed.open) / closed.open) * 100
			const vwapDist = ((closed.close - vwap) / vwap) * 100 // how far above VWAP

			if (bodyPct < MIN_RECLAIM_BODY_PCT) return // weak reclaim, skip
			if (vwapDist > MAX_EXTENSION_PCT) return // already too extended at reclaim

			const best = getBestStrike('CE', closed.close)
			const sl = Number((vwap - 8).toFixed(2)) // SL just below VWAP (tight)
			const risk = closed.close - sl
			if (risk <= 0 || risk > 50) return

			const t1 = Number((closed.close + risk * 1.5).toFixed(2))
			const t2 = Number((closed.close + risk * 2.5).toFixed(2))

			console.log(
				`\n🔼 [NIFTY VWAP RECLAIM LONG] ${best.strike} CE | Reclaim at ${closed.close} | VWAP ${vwap.toFixed(0)} | Was below for ${MIN_CANDLES_BELOW_BEFORE_RECLAIM} candles`,
			)

			sendTelegramAlert({
				symbol: `NIFTY ${best.strike} CE`,
				price: closed.close,
				side: 'LONG',
				percentageChange: Number(vwapDist.toFixed(2)),
				volumeSpikeRatio: 1, // index bypass
				trigger: `🔼 VWAP Reclaim LONG | ${MIN_CANDLES_BELOW_BEFORE_RECLAIM}+ candles below → now ABOVE | Spot ₹${closed.close} | VWAP ₹${vwap.toFixed(2)} | Strike ${best.strike} CE | SL ₹${sl} (below VWAP) | T1 ₹${t1} | T2 ₹${t2} | High R:R institutional re-entry`,
				vwap,
				avgPrice: (closed.open + closed.close) / 2,
				detectorName: this.name,
				regimeClass: 'UNIVERSAL',
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
			return
		}

		// ── SHORT: Was ABOVE VWAP for 2+ candles, just CLOSED BELOW ─────
		const wasAboveForMinCandles = previous.every((r) => r === 'above')
		const justBrokeBelow = current === 'below'

		if (wasAboveForMinCandles && justBrokeBelow) {
			const bodyPct = ((closed.open - closed.close) / closed.open) * 100 // bearish body
			const vwapDist = ((vwap - closed.close) / vwap) * 100 // how far below VWAP

			if (bodyPct < MIN_RECLAIM_BODY_PCT) return
			if (vwapDist > MAX_EXTENSION_PCT) return

			const best = getBestStrike('PE', closed.close)
			const sl = Number((vwap + 8).toFixed(2)) // SL just above VWAP
			const risk = sl - closed.close
			if (risk <= 0 || risk > 50) return

			const t1 = Number((closed.close - risk * 1.5).toFixed(2))
			const t2 = Number((closed.close - risk * 2.5).toFixed(2))

			console.log(
				`\n🔽 [NIFTY VWAP BREAK SHORT] ${best.strike} PE | Break at ${closed.close} | VWAP ${vwap.toFixed(0)} | Was above for ${MIN_CANDLES_BELOW_BEFORE_RECLAIM} candles`,
			)

			sendTelegramAlert({
				symbol: `NIFTY ${best.strike} PE`,
				price: closed.close,
				side: 'SHORT',
				percentageChange: Number(vwapDist.toFixed(2)),
				volumeSpikeRatio: 1,
				trigger: `🔽 VWAP Break SHORT | ${MIN_CANDLES_BELOW_BEFORE_RECLAIM}+ candles above → now BELOW | Spot ₹${closed.close} | VWAP ₹${vwap.toFixed(2)} | Strike ${best.strike} PE | SL ₹${sl} (above VWAP) | T1 ₹${t1} | T2 ₹${t2} | Institutional distribution confirmed`,
				vwap,
				avgPrice: (closed.open + closed.close) / 2,
				detectorName: this.name,
				regimeClass: 'UNIVERSAL',
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
		}
	}
}
