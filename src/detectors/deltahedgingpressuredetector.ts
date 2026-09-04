// ============================================================
// deltaHedgingPressureDetector.ts
//
// ── THE INSTITUTIONAL CONCEPT ────────────────────────────────
//
// When a large player buys, say, 10,000 lots of NIFTY 22500 CE,
// the market maker (MM) who SOLD them those calls now has a problem.
// They are short gamma — if Nifty rises, their position loses money
// exponentially. To stay "delta neutral", they must BUY Nifty
// futures proportional to their delta exposure.
//
// Here's the feedback loop:
//   Nifty rises → MM delta increases → MM buys more futures
//   → futures buying pushes Nifty higher
//   → MM delta increases further → MM buys even more futures
//   → repeat
//
// This is a GAMMA SQUEEZE. It is mechanical and predictable.
// Market makers CANNOT choose not to hedge — their risk systems
// force them. Once identified, the move is almost guaranteed to
// continue until the strike is reached or exceeded.
//
// ── HOW WE DETECT IT ─────────────────────────────────────────
//
// We don't have direct delta/gamma data — Fyers doesn't provide
// Greeks via WebSocket. But we can PROXY them:
//
//   PROXY FOR GAMMA:
//   Premium velocity = (ΔPremium / ΔIndex) per tick
//   If premium rises FASTER than the raw index move, gamma is
//   accelerating → market makers are getting squeezed harder.
//
//   PROXY FOR NEW POSITION BUILDUP:
//   OI increasing + premium rising = new longs being added
//   (not just existing positions being closed)
//   This means the squeeze has fresh fuel.
//
//   CONFIRMATION:
//   3 consecutive ticks where premium velocity is accelerating
//   (each tick faster than the previous) = squeeze is live.
//
// ── SIGNAL CONDITIONS ────────────────────────────────────────
//
// LONG (CE Gamma Squeeze):
//   1. Target CE strike (ATM or 1 OTM) premium rising
//   2. Premium velocity > INDEX_MOVE_RATIO threshold
//      (premium moving faster than it "should" for a linear delta)
//   3. OI on that strike is INCREASING (new buyers, not closures)
//   4. 3 consecutive accelerating ticks
//   5. Nifty above VWAP (confirms bullish regime)
//
// SHORT (PE Gamma Squeeze):
//   Mirror conditions — PE premium rising + OI increasing
//   + Nifty below VWAP
//
// ── ENTRY / EXIT ─────────────────────────────────────────────
//
// Entry: Buy the CE/PE that is being squeezed (ride the MM hedge)
// SL:    When premium velocity drops to zero (squeeze exhausted)
//        In index terms: 0.3% below entry index level
// T1:    Next 50-point Nifty strike (where new MM wall will form)
// T2:    T1 + 50 points (full extension)
// Exit:  Hard exit in 10 minutes — gamma squeezes are violent
//        but short-lived
//
// ── WHY THIS WORKS ───────────────────────────────────────────
//
// This is not pattern recognition — it's detecting a MECHANICAL
// process that market makers MUST execute by law and risk policy.
// The signal is not predictive — it's CAUSAL. The buying will
// happen. We are just early to it.
// ============================================================

import { sendTelegramAlert } from '../workers/telegramWorker.js'
import type { IDetector, TickData } from '../core/types.js'
import { redisClient } from '../config/redis.js'
import { getVwap } from '../utils/vwapUtils.js'
import { getBestStrike } from '../utils/optionUtils.js'

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
// How much faster should the premium move vs the index?
// A delta-0.5 (ATM) option should move ₹0.5 for every ₹1 Nifty move.
// If it's moving ₹0.8 for every ₹1 Nifty move, gamma is kicking in.
const PREMIUM_VELOCITY_THRESHOLD = 0.65 // premium move / index move ratio

// How many consecutive accelerating ticks before we confirm the squeeze?
const ACCELERATION_TICKS = 3

// Minimum OI to confirm real institutional positioning (not noise)
const MIN_STRIKE_OI = 50_000 // 50,000 OI minimum on the squeezed strike

// OI must be growing — not shrinking (shrinking = position being closed)
const OI_GROWTH_THRESHOLD = 0.02 // OI must grow by at least 2% tick over tick
const MIN_INDEX_MOVE_EPOCH = 2.0 // Index must move 2 points to calculate a clean velocity
const COOLDOWN_SECONDS = 900 // 15 min between signals
const NIFTY_SYMBOL = 'NSE:NIFTY50-INDEX'
// Active window: avoid first 15 min chaos and post 2:30 PM
const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}
const isActiveWindow = (): boolean => {
	const m = getISTMinutes()
	return m >= 9 * 60 + 30 && m <= 14 * 60 + 30
}
// ─────────────────────────────────────────────────────────────

// Per-strike velocity tracking
interface StrikeVelocity {
	strike: number
	optionType: 'CE' | 'PE'
	anchorPremium: number // Premium at the start of the epoch
	anchorIndexPrice: number // Index price at the start of the epoch
	anchorOI: number // OI at the start of the epoch
	velocityHistory: number[]
	oiHistory: number[]
}

export class DeltaHedgingPressureDetector implements IDetector {
	public name = 'Delta Hedging Pressure (Gamma Squeeze)'
	public symbol = NIFTY_SYMBOL

	// Map of strike symbol → velocity state
	private strikeStates = new Map<string, StrikeVelocity>()
	private currentIndexPrice = 0
	private prevIndexPrice = 0

	public async analyze(liveTick: TickData): Promise<void> {
		if (!isActiveWindow() || this.symbol !== NIFTY_SYMBOL) return

		this.prevIndexPrice = this.currentIndexPrice
		this.currentIndexPrice = liveTick.price

		const cooldownKey = 'cooldown:delta_squeeze'
		if (await redisClient.get(cooldownKey)) return

		const vwap = await getVwap(NIFTY_SYMBOL)
		if (!vwap) return

		const isAboveVwap = this.currentIndexPrice > vwap
		const isBelowVwap = this.currentIndexPrice < vwap

		// Scan all tracked strikes for squeeze conditions
		for (const [symbol, state] of this.strikeStates) {
			if (state.optionType === 'CE' && !isAboveVwap) continue
			if (state.optionType === 'PE' && !isBelowVwap) continue

			if (state.velocityHistory.length < ACCELERATION_TICKS) continue

			const latestOI = state.oiHistory[state.oiHistory.length - 1] ?? 0
			const earliestOI = state.oiHistory[0] ?? 0
			if (latestOI < MIN_STRIKE_OI || earliestOI === 0) continue

			const oiGrowthRate = (latestOI - earliestOI) / earliestOI
			if (oiGrowthRate < OI_GROWTH_THRESHOLD) continue

			const velocities = state.velocityHistory.slice(-ACCELERATION_TICKS)

			// Check if accelerating AND above threshold
			const isAccelerating = velocities.every((v, i) => i === 0 || v > velocities[i - 1]!)
			const latestVelocity = velocities[velocities.length - 1] ?? 0

			if (isAccelerating && latestVelocity >= PREMIUM_VELOCITY_THRESHOLD) {
				// SQUEEZE CONFIRMED
				await this.executeSignal(state, vwap, latestVelocity, oiGrowthRate, cooldownKey)
				return
			}
		}
	}

	// ── Called from websocket.ts when an option tick arrives ─────────────
	// This is the data feed for the squeeze detector.
	// websocket.ts should call this alongside updateOptionTick().
	public updateStrikeTick(
		symbol: string,
		strike: number,
		optionType: 'CE' | 'PE',
		premium: number,
		oi: number,
	): void {
		if (this.currentIndexPrice === 0) return

		let state = this.strikeStates.get(symbol)

		if (!state) {
			state = {
				strike,
				optionType,
				anchorPremium: premium,
				anchorIndexPrice: this.currentIndexPrice,
				anchorOI: oi,
				velocityHistory: [],
				oiHistory: [oi],
			}
			this.strikeStates.set(symbol, state)
			return
		}

		const indexMoveSinceAnchor = Math.abs(this.currentIndexPrice - state.anchorIndexPrice)

		// Only calculate a new velocity block if the underlying index has moved enough to filter out noise
		if (indexMoveSinceAnchor >= MIN_INDEX_MOVE_EPOCH) {
			const premiumMove = Math.abs(premium - state.anchorPremium)

			// Velocity = How much premium moved relative to the strict 2+ point index move
			const velocity = premiumMove / indexMoveSinceAnchor

			state.velocityHistory.push(velocity)
			if (state.velocityHistory.length > 5) state.velocityHistory.shift()

			state.oiHistory.push(oi)
			if (state.oiHistory.length > 5) state.oiHistory.shift()

			// Reset the anchors for the next epoch
			state.anchorPremium = premium
			state.anchorIndexPrice = this.currentIndexPrice
			state.anchorOI = oi
		}
	}

	private async executeSignal(
		state: StrikeVelocity,
		vwap: number,
		latestVelocity: number,
		oiGrowthRate: number,
		cooldownKey: string,
	) {
		// 1. Calculate direction and dynamic levels locally
		const direction = state.optionType === 'CE' ? 'LONG' : 'SHORT'

		const indexSl =
			state.optionType === 'CE'
				? Number((this.currentIndexPrice * 0.997).toFixed(2)) // 0.3% below for CE
				: Number((this.currentIndexPrice * 1.003).toFixed(2)) // 0.3% above for PE

		const t1 =
			state.optionType === 'CE'
				? Math.ceil(this.currentIndexPrice / 50) * 50 // next 50-pt strike
				: Math.floor(this.currentIndexPrice / 50) * 50 - 50

		const t2 = state.optionType === 'CE' ? t1 + 50 : t1 - 50

		const best = getBestStrike(state.optionType, this.currentIndexPrice)

		// 2. Log to console for debugging
		console.log(`\n⚡ [GAMMA SQUEEZE ${direction}] Strike ${state.strike} ${state.optionType}`)
		console.log(`   Index: ${this.currentIndexPrice} | VWAP: ${vwap.toFixed(2)}`)
		console.log(
			`   Velocity: ${latestVelocity.toFixed(2)} (threshold: ${PREMIUM_VELOCITY_THRESHOLD})`,
		)
		console.log(`   OI Growth: +${(oiGrowthRate * 100).toFixed(1)}%`)

		// 3. Fire the Telegram Alert
		sendTelegramAlert({
			symbol: `NIFTY ${best.strike} ${state.optionType}`,
			price: this.currentIndexPrice,
			side: direction,
			percentageChange: Number((((this.currentIndexPrice - vwap) / vwap) * 100).toFixed(2)),
			volumeSpikeRatio: Number(latestVelocity.toFixed(2)),
			trigger: `⚡ Gamma Squeeze ${state.optionType} | MM forced hedge detected | Vel ${latestVelocity.toFixed(2)}× | OI +${(oiGrowthRate * 100).toFixed(1)}% | Index ₹${this.currentIndexPrice} | SL ₹${indexSl} | T1 ₹${t1} | T2 ₹${t2} | ⏱ Exit 10min`,
			vwap: vwap,
			avgPrice: this.currentIndexPrice,
			detectorName: this.name,
			regimeClass: 'UNIVERSAL',
		})

		// 4. Set the cooldown so it doesn't fire on every tick
		await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
	}
}
