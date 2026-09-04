import { redisClient } from '../../../config/redis.js'
import type { TickData } from '../../../core/types.js'
import { getVwap } from '../../../utils/vwapUtils.js'
import { BaseDetector } from './baseDetector.js'

export class GapAndGoMomentum extends BaseDetector {
	private orHigh: number = 0
	private orLow: number = Infinity
	private rangeLocked: boolean = false
	private openingVolume: number = 0
	private candleVolume: number = 0
	private candleStartTs: number = 0

	constructor(symbol: string) {
		super(symbol, 'Gap_And_Go_V2')
	}

	async analyze(liveTick: TickData): Promise<void> {
		const now = new Date(liveTick.timestamp + 5.5 * 60 * 60 * 1000)
		const m = now.getUTCHours() * 60 + now.getUTCMinutes()

		// Build opening range during 9:15–9:30 (first 15 min)
		if (m >= 9 * 60 + 15 && m < 9 * 60 + 30) {
			this.orHigh = Math.max(this.orHigh, liveTick.price)
			this.orLow = Math.min(this.orLow, liveTick.price)

			// Track cumulative volume during range build
			this.openingVolume += liveTick.volume
			this.rangeLocked = false
			return
		}

		// Lock range once at 9:30
		if (!this.rangeLocked) {
			if (this.orHigh === 0 || this.orLow === Infinity) return
			this.rangeLocked = true
			console.log(
				`[GapAndGo] 🔒 ${this.symbol} OR locked | H:${this.orHigh.toFixed(2)} L:${this.orLow.toFixed(2)}`,
			)
		}

		// Only active 9:30–10:15
		if (m < 9 * 60 + 30 || m > 10 * 60 + 15) return

		const cooldownKey = `v2:cooldown:gapgo:${this.symbol}`
		if (await redisClient.get(cooldownKey)) return

		const rangeSpread = ((this.orHigh - this.orLow) / this.orLow) * 100

		// Avoid choppy or massive ranges
		if (rangeSpread < 0.5 || rangeSpread > 2.5) return

		const vwap = await getVwap(this.symbol)
		if (!vwap) return

		if (liveTick.price < vwap) return

		const blockValue = liveTick.price * liveTick.volume
		const isBlockSized = blockValue >= 5_000_000

		if (liveTick.price > this.orHigh * 1.002 && isBlockSized) {
			console.log(`\n🏎️ [V2 GAP AND GO] ${this.symbol} blasting past ORH at ₹${this.orHigh}`)

			await this.triggerAlert({
				symbol: this.symbol,
				price: liveTick.price,
				side: 'LONG',
				percentageChange: Number((((liveTick.price - this.orHigh) / this.orHigh) * 100).toFixed(2)),
				volumeSpikeRatio: 2.0,
				trigger: `🏎️💨 Gap & Go | ORH ₹${this.orHigh.toFixed(2)} Broken | Range ${rangeSpread.toFixed(2)}% | VWAP Defense Firm | Block ₹${(blockValue / 100_000).toFixed(1)}L`,
				vwap: vwap,
				avgPrice: this.orHigh,
			})

			await redisClient.setEx(cooldownKey, 28800, '1')
		}
	}
}
