import { sendTelegramAlert } from '../workers/telegramWorker.js'
import type { IDetector, TickData } from '../core/types.js'
import { redisClient } from '../config/redis.js'
import { getVwap } from '../utils/vwapUtils.js'
import { getBestStrike } from '../utils/optionUtils.js'

//   if (price > this.morningHigh + 2)          ← triggers on 0.009% noise for Nifty at 23,000
//   if (price < this.morningHigh - 3)          ← same problem
//
// For a 23,000-point index, a 2-point move is pure tick noise — not a sweep.
// A real liquidity sweep on Nifty is typically 0.10%–0.25% beyond the level.
//
// [WHAT TO CHANGE]: Both thresholds are now expressed as percentages of the level,
// calculated at the moment the levels are fetched. No constant changes required.
//
// [FIX: CRITICAL — BUG] The original detector read orb:15min:high/low from Redis
// but OrbDetector never WROTE those keys. The detector was permanently stuck with
// morningHigh === 0 and never fired a single signal.
//
// [WHAT TO CHANGE]: The OrbDetector now writes these keys (see orbDetector.ts fix).
// This detector's Redis read is now correct — no change needed here.

export class LiquiditySweepDetector implements IDetector {
	public name = 'Institutional Liquidity Sniper'
	public symbol = 'NSE:NIFTY50-INDEX'

	private morningHigh: number = 0
	private morningLow: number = 0
	private state: 'WAITING' | 'SWEPT_HIGH' | 'SWEPT_LOW' = 'WAITING'

	// [FIX] Derived percentage-based thresholds — set once when levels are fetched
	private sweepThreshold: number = 0 // e.g. 0.12% of morningHigh → ~27 pts at 23,000
	private reverseThreshold: number = 0 // e.g. 0.15% of morningHigh → confirms reversal

	public async analyze(liveTick: TickData): Promise<void> {
		const price = liveTick.price
		const now = new Date(liveTick.timestamp + 5.5 * 60 * 60 * 1000)
		const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()

		// 1. Fetch Morning Range levels from Redis after 9:31 AM
		//    OrbDetector writes these keys when the 15-min range locks at 9:30.
		if (minutes >= 9 * 60 + 31 && this.morningHigh === 0) {
			const high = await redisClient.get(`orb:15min:high:${this.symbol}`)
			const low = await redisClient.get(`orb:15min:low:${this.symbol}`)

			if (high && low) {
				this.morningHigh = parseFloat(high)
				this.morningLow = parseFloat(low)

				// [FIX] Compute sweep/reversal thresholds as % of the level — not fixed points.
				// sweepThreshold:   price must exceed the level by 0.12% to count as a "sweep"
				// reverseThreshold: price must retrace 0.15% back past the level to confirm reversal
				// At Nifty 23,000: sweep = ~28 pts, reverse = ~35 pts — realistic and non-noisy.
				this.sweepThreshold = this.morningHigh * 0.0012
				this.reverseThreshold = this.morningHigh * 0.0015

				console.log(
					`[Liquidity Sniper] 🎯 Levels Locked: H:${this.morningHigh} L:${this.morningLow} | ` +
						`Sweep ±${this.sweepThreshold.toFixed(1)}pts | Reverse ±${this.reverseThreshold.toFixed(1)}pts`,
				)
			}
			return
		}

		if (this.morningHigh === 0 || minutes > 15 * 60 + 15) return

		const cooldownKey = `cooldown:liquidity_sweep:${this.symbol}`
		if (await redisClient.get(cooldownKey)) return

		// 2. State Machine: Detection Logic
		if (this.state === 'WAITING') {
			// [FIX] Use percentage-based threshold instead of hardcoded +2 / -2 points
			if (price > this.morningHigh + this.sweepThreshold) this.state = 'SWEPT_HIGH'
			if (price < this.morningLow - this.sweepThreshold) this.state = 'SWEPT_LOW'
		}

		// 3. The Trap Spring (Market Structure Shift)
		// [FIX] Use percentage-based reversal threshold instead of hardcoded -3 points
		if (this.state === 'SWEPT_HIGH' && price < this.morningHigh - this.reverseThreshold) {
			await this.executeSignal('SHORT', price, '🐻 Bull Trap (Liquidity Sweep High)')
		}

		if (this.state === 'SWEPT_LOW' && price > this.morningLow + this.reverseThreshold) {
			await this.executeSignal('LONG', price, '🚀 Bear Trap (Liquidity Sweep Low)')
		}
	}

	private async executeSignal(side: 'LONG' | 'SHORT', price: number, trigger: string) {
		const vwap = (await getVwap(this.symbol)) || price
		const best = getBestStrike(side === 'LONG' ? 'CE' : 'PE', price)

		await sendTelegramAlert({
			symbol: isOption(this.symbol)
				? this.symbol
				: `NIFTY ${best.strike} ${side === 'LONG' ? 'CE' : 'PE'}`,
			price,
			side,
			percentageChange: 0,
			volumeSpikeRatio: 1.5,
			trigger: `${trigger} | Entry ₹${price} | Target 1:2 RR | SL: Sweep High/Low`,
			vwap,
			avgPrice: price,
		})

		const cooldownKey = `cooldown:liquidity_sweep:${this.symbol}`
		await redisClient.setEx(cooldownKey, 3600, 'true')
		this.state = 'WAITING'
	}
}

function isOption(sym: string) {
	return sym.includes('CE') || sym.includes('PE')
}
