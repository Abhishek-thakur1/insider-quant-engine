// ============================================================
// regimeDetector.ts — Shannon Entropy Market Regime Engine
//
// THE PHYSICS ANALOGY:
// Markets oscillate between two thermodynamic states:
//   - Low entropy  = ordered crystal (directional trend)
//   - High entropy = disordered gas   (random ranging)
//
// Shannon's formula: H(X) = -Σ p(x) × log₂(p(x))
// where p(x) = probability of each return magnitude bucket
//
// WHY THIS MATTERS FOR YOUR REVERSAL PROBLEM:
// Running a momentum detector (CandleBreakout, MTF, etc.) in a
// high-entropy ranging market is guaranteed to lose money.
// The setup fires, the move starts, then immediately reverses
// because there's no directional force — pure entropy.
//
// The fix: automatically route each detector to its correct regime.
//
// REGIME BOUNDARIES (calibrated on NSE data):
//   H < 1.6  = Trending  → use momentum detectors
//   H 1.6-2.0 = Transition → reduce size 50%, any detector
//   H > 2.0  = Ranging  → use mean reversion detectors only
//
// DATA SOURCE:
// 1-minute return of Nifty50 index, rolling 20-candle window.
// Updated every time a Nifty 1-min candle closes in websocket.ts.
// ============================================================

import { redisClient } from '../config/redis.js'

const REGIME_RETURNS_KEY = 'regime:nifty:returns_1min'
const REGIME_CACHE_KEY = 'regime:nifty:current'
const RETURNS_WINDOW = 20 // 20 one-minute returns = 20 mins of context
const TRENDING_H_THRESHOLD = 1.6 // Below this = trending
const RANGING_H_THRESHOLD = 2.0 // Above this = ranging
const CACHE_TTL_SECONDS = 60 // Re-compute at most once per minute

export type MarketRegime = 'trending' | 'transition' | 'ranging'

export interface RegimeState {
	regime: MarketRegime
	entropy: number
	dataPoints: number
	trendingPct: number // % of time price was directional (|return| > 0.1%)
	volatility: number // stddev of returns (annualised proxy)
}

// Called from websocket.ts every time a 1-min Nifty candle closes
// returnPct = (close - open) / open * 100
export const pushNiftyReturn = async (returnPct: number): Promise<void> => {
	await redisClient
		.multi()
		.lPush(REGIME_RETURNS_KEY, String(returnPct.toFixed(4)))
		.lTrim(REGIME_RETURNS_KEY, 0, RETURNS_WINDOW - 1)
		.del(REGIME_CACHE_KEY) // Invalidate cache on new data
		.exec()
}

// Shannon entropy over discretized return bins
// More bins = finer resolution, but needs more data points
// 5 bins is optimal for 20 data points (N/bins ≈ 4 per bin)
const computeShannonEntropy = (values: number[]): number => {
	if (values.length === 0) return 2.32 // max entropy (5 bins) = uncertain

	// Discretize into 5 regime-relevant buckets:
	// 0: Strong down (< -0.3%)
	// 1: Mild down   (-0.3% to -0.05%)
	// 2: Flat        (-0.05% to +0.05%)
	// 3: Mild up     (+0.05% to +0.3%)
	// 4: Strong up   (> +0.3%)
	const bins = [0, 0, 0, 0, 0]

	for (const v of values) {
		if (v < -0.3) bins[0]!++
		else if (v < -0.05) bins[1]!++
		else if (v <= 0.05) bins[2]!++
		else if (v <= 0.3) bins[3]!++
		else bins[4]!++
	}

	const n = values.length
	let entropy = 0

	for (const count of bins) {
		if (count === 0) continue // log(0) is undefined; skip empty bins
		const p = count / n
		entropy -= p * Math.log2(p)
	}

	return entropy
}

// Compute percentage of candles with directional moves (|return| > threshold)
const computeTrendingPct = (values: number[], threshold = 0.1): number => {
	if (values.length === 0) return 0
	const directional = values.filter((v) => Math.abs(v) > threshold).length
	return (directional / values.length) * 100
}

// Standard deviation of returns
const computeVolatility = (values: number[]): number => {
	if (values.length < 2) return 0
	const mean = values.reduce((a, b) => a + b, 0) / values.length
	const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length
	return Math.sqrt(variance)
}

export const getMarketRegime = async (): Promise<RegimeState> => {
	// Check cache first — regime changes slowly, no need to recompute every tick
	const cached = await redisClient.get(REGIME_CACHE_KEY)
	if (cached) {
		return JSON.parse(cached) as RegimeState
	}

	// Read rolling returns from Redis
	const rawReturns = await redisClient.lRange(REGIME_RETURNS_KEY, 0, -1)

	// Not enough data yet — return cautious default
	if (rawReturns.length < 8) {
		return {
			regime: 'transition',
			entropy: 2.0,
			dataPoints: rawReturns.length,
			trendingPct: 0,
			volatility: 0,
		}
	}

	const returns = rawReturns.map(Number)
	const entropy = computeShannonEntropy(returns)
	const trendingPct = computeTrendingPct(returns)
	const volatility = computeVolatility(returns)

	let regime: MarketRegime
	if (entropy < TRENDING_H_THRESHOLD) {
		regime = 'trending'
	} else if (entropy > RANGING_H_THRESHOLD) {
		regime = 'ranging'
	} else {
		regime = 'transition'
	}

	const state: RegimeState = {
		regime,
		entropy,
		dataPoints: returns.length,
		trendingPct,
		volatility,
	}

	// Cache for 60 seconds — recomputed when new candle pushes
	await redisClient.setEx(REGIME_CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(state))

	return state
}

// ── Detector Classification ────────────────────────────────────────────────
// Each detector is classified by its edge source:
//   MOMENTUM:   profits from trend continuation (needs H < 1.6)
//   REVERSION:  profits from mean reversion    (needs H > 1.6)
//   UNIVERSAL:  game theory / structural (works in all regimes)

const MOMENTUM_DETECTOR_PATTERNS = [
	'Multi-TF',
	'MTF Breakout',
	'Morning Momentum',
	'Candle Accumulation',
	'VCP',
	'Parabolic',
	'ORB Breakout',
	'Institutional Volume Absorption',
	'Volume Absorption',
]

const REVERSION_DETECTOR_PATTERNS = [
	'Order Flow Exhaustion',
	'OFE',
	'Value Zone',
	'VWAP Defense',
	'VWAP Crossover',
	'Statistical VWAP',
	'SD Reversion',
	'Liquidity Sweep (Trap)',
	'Wyckoff',
	'Smart Money Price-Volume',
]

const UNIVERSAL_DETECTOR_PATTERNS = [
	'Institutional Liquidity Sniper',
	'OI Liquidity Sweep',
	'Delta Hedging',
	'Gamma Squeeze',
	'Equity Structural',
	'Equity Structural Liquidity',
]

type DetectorType = 'MOMENTUM' | 'REVERSION' | 'UNIVERSAL'

const classifyDetector = (detectorName: string): DetectorType => {
	if (UNIVERSAL_DETECTOR_PATTERNS.some((p) => detectorName.includes(p))) return 'UNIVERSAL'
	if (REVERSION_DETECTOR_PATTERNS.some((p) => detectorName.includes(p))) return 'REVERSION'
	if (MOMENTUM_DETECTOR_PATTERNS.some((p) => detectorName.includes(p))) return 'MOMENTUM'
	return 'UNIVERSAL' // Default: allow through (conservative)
}

// Trigger-text based classification for detectors that don't pass name
const classifyFromTrigger = (trigger: string): DetectorType => {
	const t = trigger.toLowerCase()
	if (
		t.includes('exhaustion') ||
		t.includes('defense') ||
		t.includes('reversion') ||
		t.includes('trap') ||
		t.includes('wyckoff') ||
		t.includes('ofe') ||
		t.includes('value zone')
	) {
		return 'REVERSION'
	}
	if (
		t.includes('breakout') ||
		t.includes('momentum') ||
		t.includes('vcp') ||
		t.includes('parabolic') ||
		t.includes('orb') ||
		(t.includes('sweep') && !t.includes('liquidity sniper'))
	) {
		return 'MOMENTUM'
	}
	return 'UNIVERSAL'
}

export interface RegimeCheckResult {
	allowed: boolean
	reason: string
	sizeMult: number // 1.0 = full size, 0.5 = half size, 0.0 = no trade
	detectorType: DetectorType
}

export const checkRegimeCompatibility = (
	regime: MarketRegime,
	entropy: number,
	detectorName?: string,
	trigger?: string,
): RegimeCheckResult => {
	const detectorType = detectorName
		? classifyDetector(detectorName)
		: trigger
			? classifyFromTrigger(trigger)
			: 'UNIVERSAL'

	// Universal detectors always allowed
	if (detectorType === 'UNIVERSAL') {
		return {
			allowed: true,
			reason: `Universal detector — regime-agnostic (H=${entropy.toFixed(2)})`,
			sizeMult: 1.0,
			detectorType,
		}
	}

	// In transition: allow everything but reduce size
	if (regime === 'transition') {
		return {
			allowed: true,
			reason: `Transition regime (H=${entropy.toFixed(2)}) — trade at 50% size`,
			sizeMult: 0.5,
			detectorType,
		}
	}

	// Trending: momentum allowed, reversion suppressed
	if (regime === 'trending') {
		if (detectorType === 'MOMENTUM') {
			return {
				allowed: true,
				reason: `Trending regime (H=${entropy.toFixed(2)}) + MOMENTUM detector = ideal`,
				sizeMult: 1.0,
				detectorType,
			}
		} else {
			return {
				allowed: false,
				reason: `Trending regime (H=${entropy.toFixed(2)}) — REVERSION detector suppressed (wrong regime)`,
				sizeMult: 0.0,
				detectorType,
			}
		}
	}

	// Ranging: reversion allowed, momentum suppressed
	if (regime === 'ranging') {
		if (detectorType === 'REVERSION') {
			return {
				allowed: true,
				reason: `Ranging regime (H=${entropy.toFixed(2)}) + REVERSION detector = ideal`,
				sizeMult: 1.0,
				detectorType,
			}
		} else {
			return {
				allowed: false,
				reason: `Ranging regime (H=${entropy.toFixed(2)}) — MOMENTUM detector suppressed (will reverse immediately)`,
				sizeMult: 0.0,
				detectorType,
			}
		}
	}

	return { allowed: true, reason: 'Unknown regime — passing through', sizeMult: 1.0, detectorType }
}
