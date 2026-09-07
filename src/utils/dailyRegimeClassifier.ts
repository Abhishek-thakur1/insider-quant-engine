// ============================================================
// dailyRegimeClassifier.ts — Session-Level Market Regime Classifier
//
// Classifies each trading session as TRENDING, CHOPPY, or TRANSITION
// using the Choppiness Index (Dreiss, 14-period) computed from daily
// Nifty OHLCV bars strictly prior to the session date (zero look-ahead).
//
// CHOPPINESS INDEX:
//   CI = 100 × log₁₀(Σ TR_i / (H₁₄ − L₁₄)) / log₁₀(14)
//   Where TR_i = True Range for day i,
//         H₁₄  = highest high over 14 days,
//         L₁₄  = lowest low over 14 days.
//
// THRESHOLDS (standard Dreiss):
//   CI > 61.8  → CHOPPY   (consolidation, mean-reversion favored)
//   CI < 38.2  → TRENDING (directional, momentum favored)
//   38.2–61.8  → TRANSITION (ambiguous — all detectors active)
//
// USAGE:
//   - Backtest: classifyDailyRegime(priorDailyBars) before each session
//   - Live: same function fed from boot-time historical fetch
//
// This module has NO Redis, no async, no side effects — a pure function
// over an array of daily bars. Shared identically between live and backtest.
// ============================================================

/** One daily OHLCV bar. `t` is epoch milliseconds. */
export interface DailyBar {
	t: number
	o: number
	h: number
	l: number
	c: number
	v: number
}

export type DailyRegime = 'TRENDING' | 'CHOPPY' | 'TRANSITION'

export interface DailyRegimeResult {
	regime: DailyRegime
	choppinessIndex: number | null
	/** Number of daily bars used for computation */
	dataPoints: number
}

const CI_PERIOD = 14
const CI_CHOPPY_THRESHOLD = 61.8
const CI_TRENDING_THRESHOLD = 38.2

/**
 * Compute the 14-period Choppiness Index from daily bars.
 * Requires at least CI_PERIOD + 1 bars (14 bars + 1 prior close for TR).
 * Returns null if insufficient data.
 */
export const computeChoppinessIndex = (bars: DailyBar[], period: number = CI_PERIOD): number | null => {
	if (bars.length < period + 1) return null

	const window = bars.slice(-(period + 1))
	let sumTR = 0
	let highestHigh = -Infinity
	let lowestLow = Infinity

	// Start from index 1 — index 0 is only used as the previous close for TR[1]
	for (let i = 1; i <= period; i++) {
		const bar = window[i]!
		const prevClose = window[i - 1]!.c
		const tr = Math.max(bar.h - bar.l, Math.abs(bar.h - prevClose), Math.abs(bar.l - prevClose))
		sumTR += tr
		highestHigh = Math.max(highestHigh, bar.h)
		lowestLow = Math.min(lowestLow, bar.l)
	}

	const range = highestHigh - lowestLow
	if (range <= 0) return 100 // zero range = maximum choppiness

	return (100 * Math.log10(sumTR / range)) / Math.log10(period)
}

/**
 * Classify a trading session's regime based on prior daily bars.
 *
 * @param priorDailyBars - Daily Nifty bars strictly BEFORE the session date,
 *                         sorted ascending by timestamp. Must not include the
 *                         current session's bar (zero look-ahead guarantee).
 */
export const classifyDailyRegime = (priorDailyBars: DailyBar[]): DailyRegimeResult => {
	const ci = computeChoppinessIndex(priorDailyBars, CI_PERIOD)

	if (ci === null) {
		return { regime: 'TRANSITION', choppinessIndex: null, dataPoints: priorDailyBars.length }
	}

	let regime: DailyRegime
	if (ci > CI_CHOPPY_THRESHOLD) {
		regime = 'CHOPPY'
	} else if (ci < CI_TRENDING_THRESHOLD) {
		regime = 'TRENDING'
	} else {
		regime = 'TRANSITION'
	}

	return { regime, choppinessIndex: ci, dataPoints: priorDailyBars.length }
}
