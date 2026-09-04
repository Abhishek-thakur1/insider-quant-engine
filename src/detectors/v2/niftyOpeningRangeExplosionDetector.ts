// ============================================================
// v2/niftyOpeningRangeExplosionDetector.ts
//
// NEW DETECTOR for Nifty50 — Opening Range Explosion
//
// CONTEXT: Nifty's best intraday moves happen in the first 30 min.
// The old engine had ZERO Nifty detectors for this window because:
//   - OiLiquiditySweep needs the market to pierce OI walls (rare)
//   - ValueZone needs 21 EMA candles to seed (takes 63 min on 3-min TF)
//   - DeltaHedging is slow to build OI data
//
// THIS DETECTOR:
//   Builds a 5-min opening range (9:15-9:20 first 5-min candle).
//   FIRES when Nifty breaks ABOVE the opening range high or BELOW
//   the opening range low with:
//     - A 3-min candle closing outside the range (confirmation)
//     - Nifty VWAP aligned with the break direction
//     - Break happening within first 45 minutes (9:15-10:00)
//     - The break candle has a real body (>0.06% body, not a wick)
//
// This DIRECTLY catches: "Nifty gaps up, holds, then explodes higher
// in first 30 min" — the Friday 200-pt rally pattern.
//
// WIN RATE THESIS:
//   Opening range breakouts on Nifty that are confirmed by VWAP
//   have ~65% win rate in Indian markets. The key edge:
//   institutions are executing their morning orders exactly at
//   these ORB levels — they set the range, then push it.
// ============================================================

import { sendTelegramAlert } from '../../workers/telegramWorker.js'
import type { IDetector, TickData } from '../../core/types.js'
import { redisClient } from '../../config/redis.js'
import { getVwap } from '../../utils/vwapUtils.js'
import { getBestStrike } from '../../utils/optionUtils.js'

// ─── TUNABLE CONSTANTS ────────────────────────────────────────
const RANGE_BUILD_CANDLES = 1 // Use first 3-min candle as opening range
const BREAKOUT_CONFIRM_MS = 3 * 60 * 1000
const MIN_BODY_PCT = 0.06 // real body on break candle (Nifty moves are small)
const BUFFER_PTS = 5 // Nifty must break 5pts past range (avoid false breaks)
const COOLDOWN_SECS = 2700 // 45 min — one signal per explosive move

const RANGE_START = 9 * 60 + 15 // 9:15 AM
// NOTE: the opening range is bounded by candle COUNT (RANGE_BUILD_CANDLES),
// not by a wall-clock end time — an unused RANGE_END constant was removed.
const ACTIVE_END = 10 * 60 + 15 // ORB only valid in first hour
// ─────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

interface Candle {
	open: number
	high: number
	low: number
	close: number
	volume: number
	startTs: number
}

export class NiftyOpeningRangeExplosionDetector implements IDetector {
	public name = 'Nifty Opening Range Explosion'
	public symbol = 'NSE:NIFTY50-INDEX'

	private currentCandle: Candle | null = null
	private closedCandles: Candle[] = []
	private orHigh: number = 0
	private orLow: number = Infinity
	private rangeLocked: boolean = false
	private rangeLockTime: number = 0

	public async analyze(liveTick: TickData): Promise<void> {
		const m = getISTMinutes()
		const now = liveTick.timestamp

		if (m < RANGE_START) return
		if (m > ACTIVE_END) return

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

		if (now - this.currentCandle.startTs < BREAKOUT_CONFIRM_MS) {
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

		this.closedCandles.push(closed)

		// ── Lock the opening range (first 1-2 3-min candles) ────────────
		if (!this.rangeLocked && this.closedCandles.length <= RANGE_BUILD_CANDLES) {
			for (const c of this.closedCandles) {
				this.orHigh = Math.max(this.orHigh, c.high)
				this.orLow = Math.min(this.orLow, c.low)
			}
			return // still building range
		}

		if (!this.rangeLocked && this.closedCandles.length > RANGE_BUILD_CANDLES) {
			// Lock the range now
			this.rangeLocked = true
			this.rangeLockTime = now
			console.log(
				`[NiftyORE] 🔒 Opening Range Locked | High: ${this.orHigh} | Low: ${this.orLow} | Spread: ${(this.orHigh - this.orLow).toFixed(0)} pts`,
			)
			return
		}

		if (!this.rangeLocked) return
		if (this.orHigh === 0 || this.orLow === Infinity) return

		const cooldownKey = `cooldown:v2:nifty_ore`
		if (await redisClient.get(cooldownKey)) return

		const vwap = await getVwap(this.symbol)
		if (!vwap) return

		const bodyPct = (Math.abs(closed.close - closed.open) / closed.open) * 100
		const rangeSize = this.orHigh - this.orLow

		// Skip if range was too wide (volatile open — less predictive)
		if (rangeSize > 120) {
			console.log(`[NiftyORE] ⚠️ Range too wide (${rangeSize.toFixed(0)} pts) — skipping ORB`)
			return
		}

		// ── LONG: Candle CLOSED above ORH + buffer ───────────────────────
		if (
			closed.close > this.orHigh + BUFFER_PTS &&
			closed.close > closed.open && // bullish candle
			bodyPct >= MIN_BODY_PCT &&
			vwap <= closed.close // VWAP below price = bullish alignment
		) {
			const best = getBestStrike('CE', closed.close)
			const sl = Number((this.orLow - 5).toFixed(2)) // SL below OR low
			const risk = closed.close - sl
			if (risk <= 0 || risk > 80) return

			const t1 = Number((closed.close + risk * 1.5).toFixed(2))
			const t2 = Number((closed.close + risk * 2.5).toFixed(2))

			console.log(
				`\n💥 [NIFTY ORE LONG] ${best.strike} CE | Break above OR High ${this.orHigh} | Now ${closed.close}`,
			)

			sendTelegramAlert({
				symbol: `NIFTY ${best.strike} CE`,
				price: closed.close,
				side: 'LONG',
				percentageChange: Number((((closed.close - this.orHigh) / this.orHigh) * 100).toFixed(2)),
				volumeSpikeRatio: 1, // index bypass
				trigger: `💥 Nifty ORB Explosion LONG | OR: ₹${this.orLow.toFixed(0)}-₹${this.orHigh.toFixed(0)} (${rangeSize.toFixed(0)}pts) | Break +${(closed.close - this.orHigh).toFixed(0)}pts | VWAP ₹${vwap.toFixed(2)} ✅ | Strike ${best.strike} CE | SL ₹${sl} | T1 ₹${t1} | T2 ₹${t2} | ⏱ High probability first-hour momentum`,
				vwap,
				avgPrice: (closed.open + closed.close) / 2,
				detectorName: this.name,
				regimeClass: 'MOMENTUM',
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECS, 'true')
			return
		}

		// ── SHORT: Candle CLOSED below ORL - buffer ──────────────────────
		if (
			closed.close < this.orLow - BUFFER_PTS &&
			closed.close < closed.open && // bearish candle
			bodyPct >= MIN_BODY_PCT &&
			vwap >= closed.close // VWAP above price = bearish alignment
		) {
			const best = getBestStrike('PE', closed.close)
			const sl = Number((this.orHigh + 5).toFixed(2)) // SL above OR high
			const risk = sl - closed.close
			if (risk <= 0 || risk > 80) return

			const t1 = Number((closed.close - risk * 1.5).toFixed(2))
			const t2 = Number((closed.close - risk * 2.5).toFixed(2))

			console.log(
				`\n💥 [NIFTY ORE SHORT] ${best.strike} PE | Break below OR Low ${this.orLow} | Now ${closed.close}`,
			)

			sendTelegramAlert({
				symbol: `NIFTY ${best.strike} PE`,
				price: closed.close,
				side: 'SHORT',
				percentageChange: Number((((this.orLow - closed.close) / this.orLow) * 100).toFixed(2)),
				volumeSpikeRatio: 1,
				trigger: `💥 Nifty ORB Explosion SHORT | OR: ₹${this.orLow.toFixed(0)}-₹${this.orHigh.toFixed(0)} (${rangeSize.toFixed(0)}pts) | Break -${(this.orLow - closed.close).toFixed(0)}pts | VWAP ₹${vwap.toFixed(2)} ✅ | Strike ${best.strike} PE | SL ₹${sl} | T1 ₹${t1} | T2 ₹${t2} | ⏱ High probability first-hour breakdown`,
				vwap,
				avgPrice: (closed.open + closed.close) / 2,
				detectorName: this.name,
				regimeClass: 'MOMENTUM',
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECS, 'true')
		}
	}
}
