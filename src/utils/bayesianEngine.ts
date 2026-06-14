// ============================================================
// bayesianEngine.ts — Jane Street Probability Machine
//
// THE CORE IDEA:
// Instead of binary pass/fail per signal, we maintain a real-time
// posterior probability P(trade succeeds | ALL evidence seen so far).
//
// Each piece of market data is a likelihood ratio that UPDATES the
// prior — exactly how a rational detective updates their hypothesis
// as new clues arrive.
//
// Evidence sources (in order of weight):
//   1. Nifty VWAP alignment (35%) — most predictive for Indian markets
//   2. OI wall structure    (25%) — game theory: where are MMs positioned?
//   3. Volume quality       (20%) — is institutional money confirming?
//   4. VWAP deviation zone  (15%) — is price in sweet spot or overextended?
//   5. Time-of-day factor   ( 5%) — market liquidity multiplier
//
// FORMULA:
//   posterior = (L × prior) / (L × prior + (1 - prior))
//   where L = product of all likelihood ratios
//
// THRESHOLD:
//   P > 0.62 → HIGH confidence, fire signal
//   P 0.55-0.62 → MODERATE, add position size warning
//   P < 0.55 → REJECT (fold the hand)
// ============================================================

import { getMarketBias } from './vwapUtils.js'
import { getWallStrikes } from './optionUtils.js'
import type { TradeSide } from '../core/types.js'
import type { AlertPayload } from '../workers/telegramWorker.js'

export interface BayesianResult {
	posterior: number // 0-1 probability of success
	confidence: 'HIGH' | 'MODERATE' | 'LOW'
	likelihoods: LikelihoodBreakdown
	reasons: string[]
	pass: boolean
}

export interface LikelihoodBreakdown {
	biasRatio: number
	oiWallRatio: number
	volumeRatio: number
	vwapZoneRatio: number
	timeRatio: number
	dteRatio?: number
	combined: number
}

// ─── TUNABLE LIKELIHOOD RATIOS ─────────────────────────────────────────────
// These represent how much each piece of evidence should update our beliefs.
// A ratio of 2.0 means "this doubles the probability of success".
// A ratio of 0.5 means "this halves it".
// Calibrated from NSE intraday data patterns.

const BIAS_ALIGNED_LR = 2.2       // Signal + Nifty direction fully aligned
const BIAS_NEUTRAL_LR = 1.0       // Nifty neutral — no update
const BIAS_OPPOSING_LR = 0.40     // Signal opposes Nifty bias (very bad)

const OI_WALL_SUPPORTING_LR = 1.7  // Put wall (LONG) or Call wall (SHORT) dominant
const OI_WALL_NEUTRAL_LR = 1.0
const OI_WALL_OPPOSING_LR = 0.65  // Wall on the wrong side

const VOL_EXTREME_LR = 2.1        // >= 10x average (institutional conviction)
const VOL_STRONG_LR = 1.6         // >= 5x average (significant)
const VOL_MODERATE_LR = 1.2       // >= 2x average (elevated)
const VOL_PRESENT_LR = 1.0        // 1.1x–2x: present but not exceptional — NEUTRAL, no penalty
const VOL_WEAK_LR = 0.80          // < 1.1x non-index: abnormally low — mild penalty
// [FIX] VSR = 1.0 is the hardcoded value Nifty/options detectors use when
// the underlying (index) has no meaningful tick volume to measure.
// We MUST NOT penalise this — it is a data absence, not negative evidence.
// Rule: if symbol is Nifty index or options (CE/PE), bypass volume check entirely.
const VOL_INDEX_BYPASS_LR = 1.0   // Index/options with VSR=1: treat as neutral

const VWAP_SWEET_SPOT_LR = 1.4    // 0.1% to 0.5% from VWAP (momentum zone)
const VWAP_NEUTRAL_LR = 1.0       // < 0.1% from VWAP (no edge)
const VWAP_OVEREXTENDED_LR = 0.72 // > 0.7% from VWAP (reversal risk)

const TIME_PRIME_LR = 1.20        // 9:30-11:30 or 1:30-3:00 (liquidity windows)
const TIME_NORMAL_LR = 1.0
const TIME_DEAD_LR = 0.85         // 11:30-1:30 lunch chop (softened — some good setups exist)

// [FIX] Lowered from 0.62 → 0.55
// Reasoning: on neutral days (no strong bias, balanced OI), the maximum
// achievable posterior with all NEUTRAL evidence is 0.50.
// Requiring 0.62 means you need 2+ pieces of POSITIVE evidence simultaneously.
// 0.55 = meaningful edge above random (50%) while allowing neutral-evidence setups.
// Negative evidence (opposing bias, OI wall fight, dead zone) still blocks well below 0.55.
const POSTERIOR_FIRE_THRESHOLD = 0.55
const POSTERIOR_MODERATE_THRESHOLD = 0.50
// ─────────────────────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

// Sequential Bayesian update: given current posterior and a new likelihood ratio,
// compute the updated posterior.
const bayesUpdate = (prior: number, likelihoodRatio: number): number => {
	// P(H|E) = L × P(H) / (L × P(H) + P(¬H))
	const posterior = (likelihoodRatio * prior) / (likelihoodRatio * prior + (1 - prior))
	return Math.max(0.01, Math.min(0.99, posterior))
}

export const computeBayesianPosterior = async (
	payload: AlertPayload,
	side: TradeSide,
): Promise<BayesianResult> => {
	const reasons: string[] = []
	const likelihoods: LikelihoodBreakdown = {
		biasRatio: 1.0,
		oiWallRatio: 1.0,
		volumeRatio: 1.0,
		vwapZoneRatio: 1.0,
		timeRatio: 1.0,
		combined: 1.0,
	}

	// Start at true neutral — no prior information
	let posterior = 0.50

	// ── EVIDENCE 1: Nifty VWAP Bias Alignment ────────────────────────────────
	// The single most important evidence in Indian markets.
	// Trading against Nifty bias is the #1 cause of false signals.
	const marketBias = await getMarketBias()

	const biasAligned =
		(side === 'LONG' && marketBias === 'bullish') ||
		(side === 'SHORT' && marketBias === 'bearish')
	const biasOpposing =
		(side === 'LONG' && marketBias === 'bearish') ||
		(side === 'SHORT' && marketBias === 'bullish')

	if (biasAligned) {
		likelihoods.biasRatio = BIAS_ALIGNED_LR
		reasons.push(`✅ Nifty ${marketBias} + signal aligned (L=${BIAS_ALIGNED_LR})`)
	} else if (biasOpposing) {
		likelihoods.biasRatio = BIAS_OPPOSING_LR
		reasons.push(`🚨 Nifty ${marketBias} OPPOSES ${side} (L=${BIAS_OPPOSING_LR}) — major red flag`)
	} else {
		likelihoods.biasRatio = BIAS_NEUTRAL_LR
		reasons.push(`○ Nifty neutral — no bias update`)
	}

	posterior = bayesUpdate(posterior, likelihoods.biasRatio)

	// ── EVIDENCE 2: OI Wall Game Theory ──────────────────────────────────────
	// Max Call Strike = resistance wall (MMs are short calls → they sell rallies)
	// Max Put Strike  = support floor  (MMs are short puts → they buy dips)
	// This is the Nash equilibrium of the options market.
	const { maxCallStrike, maxPutStrike, callWallOI, putWallOI } = getWallStrikes()

	if (maxCallStrike && maxPutStrike && callWallOI > 0 && putWallOI > 0) {
		const putDominance = putWallOI / Math.max(callWallOI, 1)
		const callDominance = callWallOI / Math.max(putWallOI, 1)

		if (side === 'LONG' && putDominance >= 1.4) {
			// Put wall dominant = strong floor below = institutions will buy dips
			likelihoods.oiWallRatio = OI_WALL_SUPPORTING_LR
			reasons.push(
				`✅ Put wall ${(putWallOI / 1000).toFixed(0)}K dominates → floor confirmed (L=${OI_WALL_SUPPORTING_LR})`,
			)
		} else if (side === 'SHORT' && callDominance >= 1.4) {
			// Call wall dominant = strong ceiling = institutions will sell rallies
			likelihoods.oiWallRatio = OI_WALL_SUPPORTING_LR
			reasons.push(
				`✅ Call wall ${(callWallOI / 1000).toFixed(0)}K dominates → ceiling confirmed (L=${OI_WALL_SUPPORTING_LR})`,
			)
		} else if (side === 'LONG' && callDominance >= 1.5) {
			// Heavy overhead resistance — LONG into a wall
			likelihoods.oiWallRatio = OI_WALL_OPPOSING_LR
			reasons.push(
				`⚠️ Heavy call wall overhead ${(callWallOI / 1000).toFixed(0)}K → resistance (L=${OI_WALL_OPPOSING_LR})`,
			)
		} else if (side === 'SHORT' && putDominance >= 1.5) {
			// Heavy floor support — SHORT into a wall
			likelihoods.oiWallRatio = OI_WALL_OPPOSING_LR
			reasons.push(
				`⚠️ Heavy put wall floor ${(putWallOI / 1000).toFixed(0)}K → support (L=${OI_WALL_OPPOSING_LR})`,
			)
		} else {
			likelihoods.oiWallRatio = OI_WALL_NEUTRAL_LR
			reasons.push(
				`○ OI balanced (Call: ${(callWallOI / 1000).toFixed(0)}K / Put: ${(putWallOI / 1000).toFixed(0)}K)`,
			)
		}
	} else {
		likelihoods.oiWallRatio = OI_WALL_NEUTRAL_LR
		reasons.push(`○ OI wall data unavailable — skipping`)
	}

	posterior = bayesUpdate(posterior, likelihoods.oiWallRatio)

	// ── EVIDENCE 3: Volume Quality ────────────────────────────────────────────
	// Volume is the lie detector of price action.
	// High volume on a breakout = real institutional participation.
	// Low volume = retail noise that institutions will fade.
	//
	// [FIX] Special case: Nifty index and options symbols use VSR=1 as a
	// hardcoded placeholder — these detectors don't track tick-level index volume.
	// VSR=1 on these is a DATA ABSENCE, not negative evidence. We bypass
	// the volume check entirely for index/options symbols.
	const vsr = payload.volumeSpikeRatio
	const isIndexOrOptions =
		payload.symbol.includes('NIFTY') ||
		payload.symbol.includes('CE') ||
		payload.symbol.includes('PE') ||
		payload.symbol === 'NSE:NIFTY50-INDEX'

	if (isIndexOrOptions && vsr <= 1.1) {
		// Index/options with placeholder VSR — bypass: no update
		likelihoods.volumeRatio = VOL_INDEX_BYPASS_LR
		reasons.push(`○ Volume: index/options placeholder VSR=${vsr.toFixed(1)} — skipped (data limitation)`)
	} else if (vsr >= 10) {
		likelihoods.volumeRatio = VOL_EXTREME_LR
		reasons.push(`✅ Extreme ${vsr.toFixed(1)}× volume → institutional conviction (L=${VOL_EXTREME_LR})`)
	} else if (vsr >= 5) {
		likelihoods.volumeRatio = VOL_STRONG_LR
		reasons.push(`✅ Strong ${vsr.toFixed(1)}× volume → confirmed (L=${VOL_STRONG_LR})`)
	} else if (vsr >= 2) {
		likelihoods.volumeRatio = VOL_MODERATE_LR
		reasons.push(`○ Moderate ${vsr.toFixed(1)}× volume (L=${VOL_MODERATE_LR})`)
	} else if (vsr >= 1.1) {
		likelihoods.volumeRatio = VOL_PRESENT_LR
		reasons.push(`○ Low volume ${vsr.toFixed(1)}× — neutral (L=${VOL_PRESENT_LR})`)
	} else {
		// Non-index with genuinely low volume — mild negative
		likelihoods.volumeRatio = VOL_WEAK_LR
		reasons.push(`⚠️ Very weak ${vsr.toFixed(1)}× volume — possible noise (L=${VOL_WEAK_LR})`)
	}

	posterior = bayesUpdate(posterior, likelihoods.volumeRatio)

	// ── EVIDENCE 4: VWAP Deviation Zone ──────────────────────────────────────
	// The "sweet spot" for momentum trades is 0.1%-0.5% from VWAP.
	// Too close = no momentum yet. Too far = overextended, reversal risk.
	// For mean reversion trades, the logic inverts — we WANT overextension.
	const pct = Math.abs(payload.percentageChange)

	// Detect if this is a mean reversion or momentum detector from trigger text
	const isMeanReversion =
		payload.trigger.includes('OFE') ||
		payload.trigger.includes('Defense') ||
		payload.trigger.includes('Reversion') ||
		payload.trigger.includes('Exhaustion') ||
		payload.trigger.includes('Wyckoff') ||
		payload.trigger.includes('Trap')

	if (isMeanReversion) {
		// For mean reversion: WANT overextension (it's the trigger condition)
		if (pct >= 0.4) {
			likelihoods.vwapZoneRatio = VOL_STRONG_LR
			reasons.push(`✅ Reversion: ${pct.toFixed(2)}% VWAP deviation → strong setup (L=${VOL_STRONG_LR})`)
		} else if (pct >= 0.2) {
			likelihoods.vwapZoneRatio = VWAP_NEUTRAL_LR
			reasons.push(`○ Reversion: ${pct.toFixed(2)}% VWAP deviation (moderate)`)
		} else {
			likelihoods.vwapZoneRatio = VWAP_OVEREXTENDED_LR
			reasons.push(
				`⚠️ Reversion: ${pct.toFixed(2)}% VWAP deviation too small for reversion (L=${VWAP_OVEREXTENDED_LR})`,
			)
		}
	} else {
		// For momentum: WANT moderate extension (0.1-0.5% is the sweet spot)
		if (pct >= 0.1 && pct <= 0.5) {
			likelihoods.vwapZoneRatio = VWAP_SWEET_SPOT_LR
			reasons.push(
				`✅ Momentum: ±${pct.toFixed(2)}% from VWAP — sweet spot (L=${VWAP_SWEET_SPOT_LR})`,
			)
		} else if (pct > 0.5) {
			likelihoods.vwapZoneRatio = VWAP_OVEREXTENDED_LR
			reasons.push(
				`⚠️ Momentum: ±${pct.toFixed(2)}% from VWAP — overextended, reversal risk (L=${VWAP_OVEREXTENDED_LR})`,
			)
		} else {
			likelihoods.vwapZoneRatio = VWAP_NEUTRAL_LR
			reasons.push(`○ Momentum: ±${pct.toFixed(2)}% from VWAP — early`)
		}
	}

	posterior = bayesUpdate(posterior, likelihoods.vwapZoneRatio)

	// ── EVIDENCE 5: Time-of-Day Factor ───────────────────────────────────────
	// Indian markets have two high-probability windows per day.
	// Signals outside these windows have historically lower win rates.
	const m = getISTMinutes()
	const inPrimeWindow1 = m >= 9 * 60 + 30 && m <= 11 * 60 + 30
	const inPrimeWindow2 = m >= 13 * 60 + 30 && m <= 15 * 60 + 0
	const inDeadZone = m > 11 * 60 + 30 && m < 13 * 60 + 30

	if (inPrimeWindow1 || inPrimeWindow2) {
		likelihoods.timeRatio = TIME_PRIME_LR
		reasons.push(`✅ Prime liquidity window (L=${TIME_PRIME_LR})`)
	} else if (inDeadZone) {
		likelihoods.timeRatio = TIME_DEAD_LR
		reasons.push(`⚠️ Lunch hour — low liquidity (L=${TIME_DEAD_LR})`)
	} else {
		likelihoods.timeRatio = TIME_NORMAL_LR
		reasons.push(`○ Normal session time`)
	}

	posterior = bayesUpdate(posterior, likelihoods.timeRatio)




	// ── EVIDENCE 6: Days to Expiry (Theta / Gamma Factor) ───────────────────
	const dayOfWeek = new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCDay() // 0=Sun, 4=Thu
	const isOptionsAsset = payload.symbol.includes('CE') || payload.symbol.includes('PE')

	if (isOptionsAsset) {
		if (dayOfWeek === 4) {
			// Thursday Expiry
			if (isMeanReversion) {
				likelihoods.dteRatio = 0.50 // Severe penalty for ranging on expiry
				reasons.push(`⚠️ Expiry Day + Reversion = Severe Theta Risk (L=0.50)`)
			} else {
				likelihoods.dteRatio = 1.20 // Bonus for momentum on expiry (Gamma explosions)
				reasons.push(`✅ Expiry Day + Momentum = Gamma Advantage (L=1.20)`)
			}
		} else if (dayOfWeek === 3) {
			// Wednesday (1 DTE)
			likelihoods.dteRatio = isMeanReversion ? 0.85 : 1.0
			reasons.push(isMeanReversion ? `⚠️ 1 DTE + Reversion = High Theta Risk (L=0.85)` : `○ 1 DTE + Momentum = Neutral`)
		} else {
			// Mon/Tue/Fri
			likelihoods.dteRatio = 1.0
			reasons.push(`○ High DTE (Day ${dayOfWeek}) — Theta decay manageable (L=1.0)`)
		}
	} else {
		likelihoods.dteRatio = 1.0 // Non-options assets unaffected
	}

	posterior = bayesUpdate(posterior, likelihoods.dteRatio)

	// 3. UPDATE the combined multiplier at the bottom
	likelihoods.combined =
		likelihoods.biasRatio *
		likelihoods.oiWallRatio *
		likelihoods.volumeRatio *
		likelihoods.vwapZoneRatio *
		likelihoods.timeRatio *
		likelihoods.dteRatio

	const pass = posterior >= POSTERIOR_FIRE_THRESHOLD
	const confidence =
		posterior >= POSTERIOR_FIRE_THRESHOLD
			? 'HIGH'
			: posterior >= POSTERIOR_MODERATE_THRESHOLD
				? 'MODERATE'
				: 'LOW'

	return {
		posterior,
		confidence,
		likelihoods,
		reasons,
		pass,
	}
}


// // ============================================================
// // bayesianEngine.ts — Jane Street Probability Machine
// //
// // THE CORE IDEA:
// // Instead of binary pass/fail per signal, we maintain a real-time
// // posterior probability P(trade succeeds | ALL evidence seen so far).
// //
// // Each piece of market data is a likelihood ratio that UPDATES the
// // prior — exactly how a rational detective updates their hypothesis
// // as new clues arrive.
// //
// // Evidence sources (in order of weight):
// //   1. Nifty VWAP alignment (35%) — most predictive for Indian markets
// //   2. OI wall structure    (25%) — game theory: where are MMs positioned?
// //   3. Volume quality       (20%) — is institutional money confirming?
// //   4. VWAP deviation zone  (15%) — is price in sweet spot or overextended?
// //   5. Time-of-day factor   ( 5%) — market liquidity multiplier
// //
// // FORMULA:
// //   posterior = (L × prior) / (L × prior + (1 - prior))
// //   where L = product of all likelihood ratios
// //
// // THRESHOLD:
// //   P > 0.62 → HIGH confidence, fire signal
// //   P 0.55-0.62 → MODERATE, add position size warning
// //   P < 0.55 → REJECT (fold the hand)
// // ============================================================

// import { getMarketBias } from './vwapUtils.js'
// import { getWallStrikes } from './optionUtils.js'
// import type { TradeSide } from '../core/types.js'
// import type { AlertPayload } from '../workers/telegramWorker.js'

// export interface BayesianResult {
// 	posterior: number // 0-1 probability of success
// 	confidence: 'HIGH' | 'MODERATE' | 'LOW'
// 	likelihoods: LikelihoodBreakdown
// 	reasons: string[]
// 	pass: boolean
// }

// export interface LikelihoodBreakdown {
// 	biasRatio: number
// 	oiWallRatio: number
// 	volumeRatio: number
// 	vwapZoneRatio: number
// 	timeRatio: number
// 	combined: number
// }

// // ─── TUNABLE LIKELIHOOD RATIOS ─────────────────────────────────────────────
// // These represent how much each piece of evidence should update our beliefs.
// // A ratio of 2.0 means "this doubles the probability of success".
// // A ratio of 0.5 means "this halves it".
// // Calibrated from NSE intraday data patterns.

// const BIAS_ALIGNED_LR = 2.2 // Signal + Nifty direction fully aligned
// const BIAS_NEUTRAL_LR = 1.0 // Nifty neutral — no update
// const BIAS_OPPOSING_LR = 0.4 // Signal opposes Nifty bias (very bad)

// const OI_WALL_SUPPORTING_LR = 1.7 // Put wall (LONG) or Call wall (SHORT) dominant
// const OI_WALL_NEUTRAL_LR = 1.0
// const OI_WALL_OPPOSING_LR = 0.65 // Wall on the wrong side

// const VOL_EXTREME_LR = 2.1 // >= 10x average (institutional conviction)
// const VOL_STRONG_LR = 1.6 // >= 5x average (significant)
// const VOL_MODERATE_LR = 1.2 // >= 2x average (elevated)
// const VOL_WEAK_LR = 0.75 // < 1.5x (noise level)

// const VWAP_SWEET_SPOT_LR = 1.4 // 0.1% to 0.5% from VWAP (momentum zone)
// const VWAP_NEUTRAL_LR = 1.0 // < 0.1% from VWAP (no edge)
// const VWAP_OVEREXTENDED_LR = 0.7 // > 0.7% from VWAP (reversal risk)

// const TIME_PRIME_LR = 1.25 // 9:30-11:30 or 1:30-3:00 (liquidity windows)
// const TIME_NORMAL_LR = 1.0
// const TIME_DEAD_LR = 0.8 // 11:30-1:30 lunch chop

// const POSTERIOR_FIRE_THRESHOLD = 0.62
// const POSTERIOR_MODERATE_THRESHOLD = 0.55
// // ─────────────────────────────────────────────────────────────────────────────

// const getISTMinutes = (): number => {
// 	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
// 	return d.getUTCHours() * 60 + d.getUTCMinutes()
// }

// // Sequential Bayesian update: given current posterior and a new likelihood ratio,
// // compute the updated posterior.
// const bayesUpdate = (prior: number, likelihoodRatio: number): number => {
// 	// P(H|E) = L × P(H) / (L × P(H) + P(¬H))
// 	const posterior = (likelihoodRatio * prior) / (likelihoodRatio * prior + (1 - prior))
// 	return Math.max(0.01, Math.min(0.99, posterior))
// }

// export const computeBayesianPosterior = async (
// 	payload: AlertPayload,
// 	side: TradeSide,
// ): Promise<BayesianResult> => {
// 	const reasons: string[] = []
// 	const likelihoods: LikelihoodBreakdown = {
// 		biasRatio: 1.0,
// 		oiWallRatio: 1.0,
// 		volumeRatio: 1.0,
// 		vwapZoneRatio: 1.0,
// 		timeRatio: 1.0,
// 		combined: 1.0,
// 	}

// 	// Start at true neutral — no prior information
// 	let posterior = 0.5

// 	// ── EVIDENCE 1: Nifty VWAP Bias Alignment ────────────────────────────────
// 	// The single most important evidence in Indian markets.
// 	// Trading against Nifty bias is the #1 cause of false signals.
// 	const marketBias = await getMarketBias()

// 	const biasAligned =
// 		(side === 'LONG' && marketBias === 'bullish') || (side === 'SHORT' && marketBias === 'bearish')
// 	const biasOpposing =
// 		(side === 'LONG' && marketBias === 'bearish') || (side === 'SHORT' && marketBias === 'bullish')

// 	if (biasAligned) {
// 		likelihoods.biasRatio = BIAS_ALIGNED_LR
// 		reasons.push(`✅ Nifty ${marketBias} + signal aligned (L=${BIAS_ALIGNED_LR})`)
// 	} else if (biasOpposing) {
// 		likelihoods.biasRatio = BIAS_OPPOSING_LR
// 		reasons.push(`🚨 Nifty ${marketBias} OPPOSES ${side} (L=${BIAS_OPPOSING_LR}) — major red flag`)
// 	} else {
// 		likelihoods.biasRatio = BIAS_NEUTRAL_LR
// 		reasons.push(`○ Nifty neutral — no bias update`)
// 	}

// 	posterior = bayesUpdate(posterior, likelihoods.biasRatio)

// 	// ── EVIDENCE 2: OI Wall Game Theory ──────────────────────────────────────
// 	// Max Call Strike = resistance wall (MMs are short calls → they sell rallies)
// 	// Max Put Strike  = support floor  (MMs are short puts → they buy dips)
// 	// This is the Nash equilibrium of the options market.
// 	const { maxCallStrike, maxPutStrike, callWallOI, putWallOI } = getWallStrikes()

// 	if (maxCallStrike && maxPutStrike && callWallOI > 0 && putWallOI > 0) {
// 		const putDominance = putWallOI / Math.max(callWallOI, 1)
// 		const callDominance = callWallOI / Math.max(putWallOI, 1)

// 		if (side === 'LONG' && putDominance >= 1.4) {
// 			// Put wall dominant = strong floor below = institutions will buy dips
// 			likelihoods.oiWallRatio = OI_WALL_SUPPORTING_LR
// 			reasons.push(
// 				`✅ Put wall ${(putWallOI / 1000).toFixed(0)}K dominates → floor confirmed (L=${OI_WALL_SUPPORTING_LR})`,
// 			)
// 		} else if (side === 'SHORT' && callDominance >= 1.4) {
// 			// Call wall dominant = strong ceiling = institutions will sell rallies
// 			likelihoods.oiWallRatio = OI_WALL_SUPPORTING_LR
// 			reasons.push(
// 				`✅ Call wall ${(callWallOI / 1000).toFixed(0)}K dominates → ceiling confirmed (L=${OI_WALL_SUPPORTING_LR})`,
// 			)
// 		} else if (side === 'LONG' && callDominance >= 1.5) {
// 			// Heavy overhead resistance — LONG into a wall
// 			likelihoods.oiWallRatio = OI_WALL_OPPOSING_LR
// 			reasons.push(
// 				`⚠️ Heavy call wall overhead ${(callWallOI / 1000).toFixed(0)}K → resistance (L=${OI_WALL_OPPOSING_LR})`,
// 			)
// 		} else if (side === 'SHORT' && putDominance >= 1.5) {
// 			// Heavy floor support — SHORT into a wall
// 			likelihoods.oiWallRatio = OI_WALL_OPPOSING_LR
// 			reasons.push(
// 				`⚠️ Heavy put wall floor ${(putWallOI / 1000).toFixed(0)}K → support (L=${OI_WALL_OPPOSING_LR})`,
// 			)
// 		} else {
// 			likelihoods.oiWallRatio = OI_WALL_NEUTRAL_LR
// 			reasons.push(
// 				`○ OI balanced (Call: ${(callWallOI / 1000).toFixed(0)}K / Put: ${(putWallOI / 1000).toFixed(0)}K)`,
// 			)
// 		}
// 	} else {
// 		likelihoods.oiWallRatio = OI_WALL_NEUTRAL_LR
// 		reasons.push(`○ OI wall data unavailable — skipping`)
// 	}

// 	posterior = bayesUpdate(posterior, likelihoods.oiWallRatio)

// 	// ── EVIDENCE 3: Volume Quality ────────────────────────────────────────────
// 	// Volume is the lie detector of price action.
// 	// High volume on a breakout = real institutional participation.
// 	// Low volume = retail noise that institutions will fade.
// 	const vsr = payload.volumeSpikeRatio

// 	if (vsr >= 10) {
// 		likelihoods.volumeRatio = VOL_EXTREME_LR
// 		reasons.push(
// 			`✅ Extreme ${vsr.toFixed(1)}× volume → institutional conviction (L=${VOL_EXTREME_LR})`,
// 		)
// 	} else if (vsr >= 5) {
// 		likelihoods.volumeRatio = VOL_STRONG_LR
// 		reasons.push(`✅ Strong ${vsr.toFixed(1)}× volume → confirmed (L=${VOL_STRONG_LR})`)
// 	} else if (vsr >= 2) {
// 		likelihoods.volumeRatio = VOL_MODERATE_LR
// 		reasons.push(`○ Moderate ${vsr.toFixed(1)}× volume (L=${VOL_MODERATE_LR})`)
// 	} else {
// 		likelihoods.volumeRatio = VOL_WEAK_LR
// 		reasons.push(`⚠️ Weak ${vsr.toFixed(1)}× volume → possible noise (L=${VOL_WEAK_LR})`)
// 	}

// 	posterior = bayesUpdate(posterior, likelihoods.volumeRatio)

// 	// ── EVIDENCE 4: VWAP Deviation Zone ──────────────────────────────────────
// 	// The "sweet spot" for momentum trades is 0.1%-0.5% from VWAP.
// 	// Too close = no momentum yet. Too far = overextended, reversal risk.
// 	// For mean reversion trades, the logic inverts — we WANT overextension.
// 	const pct = Math.abs(payload.percentageChange)

// 	// Detect if this is a mean reversion or momentum detector from trigger text
// 	const isMeanReversion =
// 		payload.trigger.includes('OFE') ||
// 		payload.trigger.includes('Defense') ||
// 		payload.trigger.includes('Reversion') ||
// 		payload.trigger.includes('Exhaustion') ||
// 		payload.trigger.includes('Wyckoff') ||
// 		payload.trigger.includes('Trap')

// 	if (isMeanReversion) {
// 		// For mean reversion: WANT overextension (it's the trigger condition)
// 		if (pct >= 0.4) {
// 			likelihoods.vwapZoneRatio = VOL_STRONG_LR
// 			reasons.push(
// 				`✅ Reversion: ${pct.toFixed(2)}% VWAP deviation → strong setup (L=${VOL_STRONG_LR})`,
// 			)
// 		} else if (pct >= 0.2) {
// 			likelihoods.vwapZoneRatio = VWAP_NEUTRAL_LR
// 			reasons.push(`○ Reversion: ${pct.toFixed(2)}% VWAP deviation (moderate)`)
// 		} else {
// 			likelihoods.vwapZoneRatio = VWAP_OVEREXTENDED_LR
// 			reasons.push(
// 				`⚠️ Reversion: ${pct.toFixed(2)}% VWAP deviation too small for reversion (L=${VWAP_OVEREXTENDED_LR})`,
// 			)
// 		}
// 	} else {
// 		// For momentum: WANT moderate extension (0.1-0.5% is the sweet spot)
// 		if (pct >= 0.1 && pct <= 0.5) {
// 			likelihoods.vwapZoneRatio = VWAP_SWEET_SPOT_LR
// 			reasons.push(
// 				`✅ Momentum: ±${pct.toFixed(2)}% from VWAP — sweet spot (L=${VWAP_SWEET_SPOT_LR})`,
// 			)
// 		} else if (pct > 0.5) {
// 			likelihoods.vwapZoneRatio = VWAP_OVEREXTENDED_LR
// 			reasons.push(
// 				`⚠️ Momentum: ±${pct.toFixed(2)}% from VWAP — overextended, reversal risk (L=${VWAP_OVEREXTENDED_LR})`,
// 			)
// 		} else {
// 			likelihoods.vwapZoneRatio = VWAP_NEUTRAL_LR
// 			reasons.push(`○ Momentum: ±${pct.toFixed(2)}% from VWAP — early`)
// 		}
// 	}

// 	posterior = bayesUpdate(posterior, likelihoods.vwapZoneRatio)

// 	// ── EVIDENCE 5: Time-of-Day Factor ───────────────────────────────────────
// 	// Indian markets have two high-probability windows per day.
// 	// Signals outside these windows have historically lower win rates.
// 	const m = getISTMinutes()
// 	const inPrimeWindow1 = m >= 9 * 60 + 30 && m <= 11 * 60 + 30
// 	const inPrimeWindow2 = m >= 13 * 60 + 30 && m <= 15 * 60 + 0
// 	const inDeadZone = m > 11 * 60 + 30 && m < 13 * 60 + 30

// 	if (inPrimeWindow1 || inPrimeWindow2) {
// 		likelihoods.timeRatio = TIME_PRIME_LR
// 		reasons.push(`✅ Prime liquidity window (L=${TIME_PRIME_LR})`)
// 	} else if (inDeadZone) {
// 		likelihoods.timeRatio = TIME_DEAD_LR
// 		reasons.push(`⚠️ Lunch hour — low liquidity (L=${TIME_DEAD_LR})`)
// 	} else {
// 		likelihoods.timeRatio = TIME_NORMAL_LR
// 		reasons.push(`○ Normal session time`)
// 	}

// 	posterior = bayesUpdate(posterior, likelihoods.timeRatio)

// 	// Compute final combined likelihood for logging
// 	likelihoods.combined =
// 		likelihoods.biasRatio *
// 		likelihoods.oiWallRatio *
// 		likelihoods.volumeRatio *
// 		likelihoods.vwapZoneRatio *
// 		likelihoods.timeRatio

// 	const pass = posterior >= POSTERIOR_FIRE_THRESHOLD
// 	const confidence =
// 		posterior >= POSTERIOR_FIRE_THRESHOLD
// 			? 'HIGH'
// 			: posterior >= POSTERIOR_MODERATE_THRESHOLD
// 				? 'MODERATE'
// 				: 'LOW'

// 	return {
// 		posterior,
// 		confidence,
// 		likelihoods,
// 		reasons,
// 		pass,
// 	}
// }
