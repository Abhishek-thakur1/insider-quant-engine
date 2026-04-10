// ============================================================
// Opening Range Breakout Detector
//
// Logic:
//   Builds TWO opening ranges simultaneously per symbol:
//     - 15-min range: 9:15 → 9:30
//     - 30-min range: 9:15 → 9:45
//   Fires on whichever breaks first with volume + VWAP confirmation.
//   Once one fires, the other is discarded (cooldown kicks in).
// ============================================================

import { sendTelegramAlert } from '../workers/telegramWorker.js'
import type { IDetector, TickData } from '../core/types.js'
import { redisClient } from '../config/redis.js'
import { getVwap, getMarketBias } from '../utils/vwapUtils.js'

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
const RANGE_15_END_MIN = 9 * 60 + 30
const RANGE_30_END_MIN = 9 * 60 + 45
const TRADE_START_MIN = 9 * 60 + 30
const TRADE_END_MIN = 14 * 60 + 30
const BREAKOUT_BUFFER = 1.002
const BREAKDOWN_BUFFER = 0.998
const MIN_RANGE_PCT = 0.2
const MAX_RANGE_PCT = 3.0
const VOL_MULTIPLIER = 3
const MIN_BLOCK_VALUE = 5_000_000
const COOLDOWN_SECONDS = 1800
// ─────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

interface OrbRange {
	high: number
	low: number
	volumes: number[]
	fired: boolean
}

export class OrbDetector implements IDetector {
	public name = 'ORB Breakout'
	public symbol: string

	private range15: OrbRange | null = null
	private range30: OrbRange | null = null

	private range15Locked = false
	private range30Locked = false

	//  Track whether we have already persisted the locked ranges to Redis.
	// Without this flag, we'd re-write to Redis on every tick after locking — wasteful
	// and also unnecessary since the range doesn't change once locked.
	private range15Persisted = false
	private range30Persisted = false

	constructor(symbol: string) {
		this.symbol = symbol
	}

	public async analyze(liveTick: TickData): Promise<void> {
		const m = getISTMinutes()

		// ── Build opening ranges (9:15 → 9:45) ─────────────────────────────
		if (m >= 9 * 60 + 15 && m < RANGE_30_END_MIN) {
			if (m < RANGE_15_END_MIN) {
				if (!this.range15) {
					this.range15 = { high: liveTick.price, low: liveTick.price, volumes: [], fired: false }
				} else {
					this.range15.high = Math.max(this.range15.high, liveTick.price)
					this.range15.low = Math.min(this.range15.low, liveTick.price)
				}
				// [FIX] Cap the volumes array to avoid unbounded memory growth.
				// We only need enough samples to compute a reliable average —
				// keeping the last 500 ticks is more than sufficient even for
				// the most active stocks during the opening 15 minutes.
				if (this.range15.volumes.length < 500) {
					this.range15.volumes.push(liveTick.volume)
				}
			}

			if (!this.range30) {
				this.range30 = { high: liveTick.price, low: liveTick.price, volumes: [], fired: false }
			} else {
				this.range30.high = Math.max(this.range30.high, liveTick.price)
				this.range30.low = Math.min(this.range30.low, liveTick.price)
			}
			// [FIX] Same cap for 30-min range volumes
			if (this.range30.volumes.length < 1000) {
				this.range30.volumes.push(liveTick.volume)
			}

			return
		}

		// ── Lock ranges and PERSIST to Redis once their windows close ────────
		if (m >= RANGE_15_END_MIN && !this.range15Locked) {
			this.range15Locked = true

			// [FIX: CRITICAL — BUG] The original OrbDetector stored range15 and range30
			// purely as in-memory class properties and never wrote them to Redis.
			//
			// LiquiditySweepDetector reads:
			//   redisClient.get(`orb:15min:high:${this.symbol}`)
			//   redisClient.get(`orb:15min:low:${this.symbol}`)
			//
			// Because these keys were never written, LiquiditySweepDetector ALWAYS got
			// null back and stayed permanently in its early-return branch
			// (this.morningHigh === 0). The detector was fully non-functional.
			//
			// [WHAT TO CHANGE]: Write the locked range to Redis here, once, when the
			// range window closes. TTL is set to 8 hours — enough for the trading day.
			if (this.range15) {
				await redisClient
					.multi()
					.set(`orb:15min:high:${this.symbol}`, String(this.range15.high))
					.set(`orb:15min:low:${this.symbol}`, String(this.range15.low))
					.expire(`orb:15min:high:${this.symbol}`, 8 * 3600)
					.expire(`orb:15min:low:${this.symbol}`, 8 * 3600)
					.exec()
				this.range15Persisted = true
				console.log(
					`[ORB] 📌 15min range locked & persisted for ${this.symbol}: ` +
						`H:${this.range15.high} L:${this.range15.low}`,
				)
			}
		}

		if (m >= RANGE_30_END_MIN && !this.range30Locked) {
			this.range30Locked = true

			// [FIX] Persist 30-min range to Redis as well
			if (this.range30) {
				await redisClient
					.multi()
					.set(`orb:30min:high:${this.symbol}`, String(this.range30.high))
					.set(`orb:30min:low:${this.symbol}`, String(this.range30.low))
					.expire(`orb:30min:high:${this.symbol}`, 8 * 3600)
					.expire(`orb:30min:low:${this.symbol}`, 8 * 3600)
					.exec()
				this.range30Persisted = true
				console.log(
					`[ORB] 📌 30min range locked & persisted for ${this.symbol}: ` +
						`H:${this.range30.high} L:${this.range30.low}`,
				)
			}
		}

		// ── Watch for breakouts ──────────────────────────────────────────────
		if (m < TRADE_START_MIN || m > TRADE_END_MIN) return
		if (!this.range15Locked && !this.range30Locked) return

		const cooldownKey = `cooldown:orb:${this.symbol}`
		const isCoolingDown = await redisClient.get(cooldownKey)
		if (isCoolingDown) return

		const vwap = await getVwap(this.symbol)
		const marketBias = await getMarketBias()
		const blockValue = liveTick.price * liveTick.volume
		const isBlockSized = blockValue >= MIN_BLOCK_VALUE

		const ranges: Array<{ range: OrbRange; label: string }> = []
		if (this.range15 && this.range15Locked && !this.range15.fired) {
			ranges.push({ range: this.range15, label: '15min ORB' })
		}
		if (this.range30 && this.range30Locked && !this.range30.fired) {
			ranges.push({ range: this.range30, label: '30min ORB' })
		}

		for (const { range, label } of ranges) {
			const rangePct = ((range.high - range.low) / range.low) * 100

			if (rangePct < MIN_RANGE_PCT || rangePct > MAX_RANGE_PCT) continue

			const avgVol =
				range.volumes.length > 0
					? range.volumes.reduce((a, b) => a + b, 0) / range.volumes.length
					: 0
			const isVolumeConfirmed = avgVol > 0 && liveTick.volume > avgVol * VOL_MULTIPLIER

			const rangeSize = range.high - range.low
			const risk = rangeSize

			// ── LONG: Break above range high ─────────────────────────────────
			if (
				liveTick.price > range.high * BREAKOUT_BUFFER &&
				isVolumeConfirmed &&
				isBlockSized &&
				(vwap !== null ? liveTick.price > vwap : true) &&
				marketBias !== 'bearish'
			) {
				const entry = liveTick.price
				const sl = Number(range.low.toFixed(2))
				const target1 = Number((entry + risk * 1.5).toFixed(2))
				const target2 = Number((entry + risk * 2.5).toFixed(2))

				console.log(`\n📈 [ORB LONG] ${this.symbol} — ${label} Breakout`)
				console.log(
					`   Range: ₹${range.low.toFixed(2)}–₹${range.high.toFixed(2)} (${rangePct.toFixed(2)}%)`,
				)
				console.log(`   Entry: ₹${entry} | SL: ₹${sl} | T1: ₹${target1} | T2: ₹${target2}`)

				sendTelegramAlert({
					symbol: this.symbol,
					price: entry,
					side: 'LONG',
					percentageChange: Number((((entry - range.low) / range.low) * 100).toFixed(2)),
					volumeSpikeRatio: Number((liveTick.volume / avgVol).toFixed(1)),
					trigger: `📊 ${label} | Range ₹${range.low.toFixed(2)}–₹${range.high.toFixed(2)} (${rangePct.toFixed(2)}%) | ${(liveTick.volume / avgVol).toFixed(1)}× vol | VWAP ₹${vwap?.toFixed(2)}`,
					vwap: vwap ?? entry,
					avgPrice: (range.high + range.low) / 2,
				})

				range.fired = true
				await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
				return
			}

			// ── SHORT: Break below range low ──────────────────────────────────
			if (
				liveTick.price < range.low * BREAKDOWN_BUFFER &&
				isVolumeConfirmed &&
				isBlockSized &&
				(vwap !== null ? liveTick.price < vwap : true) &&
				marketBias !== 'bullish'
			) {
				const entry = liveTick.price
				const sl = Number(range.high.toFixed(2))
				const target1 = Number((entry - risk * 1.5).toFixed(2))
				const target2 = Number((entry - risk * 2.5).toFixed(2))

				console.log(`\n📉 [ORB SHORT] ${this.symbol} — ${label} Breakdown`)
				console.log(
					`   Range: ₹${range.low.toFixed(2)}–₹${range.high.toFixed(2)} (${rangePct.toFixed(2)}%)`,
				)
				console.log(`   Entry: ₹${entry} | SL: ₹${sl} | T1: ₹${target1} | T2: ₹${target2}`)

				sendTelegramAlert({
					symbol: this.symbol,
					price: entry,
					side: 'SHORT',
					percentageChange: Number((((entry - range.high) / range.high) * 100).toFixed(2)),
					volumeSpikeRatio: Number((liveTick.volume / avgVol).toFixed(1)),
					trigger: `📊 ${label} | Range ₹${range.low.toFixed(2)}–₹${range.high.toFixed(2)} (${rangePct.toFixed(2)}%) | ${(liveTick.volume / avgVol).toFixed(1)}× vol | VWAP ₹${vwap?.toFixed(2)}`,
					vwap: vwap ?? entry,
					avgPrice: (range.high + range.low) / 2,
				})

				range.fired = true
				await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
				return
			}
		}
	}
}
