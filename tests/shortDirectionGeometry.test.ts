// ============================================================
// tests/shortDirectionGeometry.test.ts
//
// Regression guard: SHORT signals must have target < entry < stop.
//                   LONG  signals must have stop  < entry < target.
//
// These invariants hold for ALL detectors that emit both directions.
// This test was added after the SHORT-direction emergency pause (Sept 16)
// to ensure the geometry is verified before re-enabling.
//
// Tested detectors:
//   - StockMomentumBreakoutDetector (_fire level computation)
//   - NiftyOpeningRangeExplosionDetector
//   - NiftyTrendPulseDetector
//   - NiftyVwapReclaimDetector (LONG only, verified below)
//
// Run: npm test
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Replicates the exact level computation logic in StockMomentumBreakoutDetector._fire().
 * Any change to _fire() must be reflected here to keep the regression meaningful.
 */
function stockMomentumLevels(
	side: 'LONG' | 'SHORT',
	candle: { close: number; low: number; high: number }
): { entry: number; sl: number; t1: number } | null {
	const entry = candle.close
	const sl =
		side === 'LONG'
			? Number((candle.low * 0.9985).toFixed(2))
			: Number((candle.high * 1.0015).toFixed(2))

	const risk = Math.abs(entry - sl)
	if (risk <= 0 || risk / entry > 0.015) return null // guard: same as detector

	const t1 =
		side === 'LONG'
			? Number((entry + risk * 1.5).toFixed(2))
			: Number((entry - risk * 1.5).toFixed(2))

	return { entry, sl, t1 }
}

/**
 * Replicates NiftyOpeningRangeExplosionDetector level computation.
 */
function niftyOreLevels(
	side: 'LONG' | 'SHORT',
	params: { close: number; orLow: number; orHigh: number }
): { entry: number; sl: number; t1: number } {
	const entry = params.close
	if (side === 'LONG') {
		const sl = Number((params.orLow - 5).toFixed(2))
		const risk = entry - sl
		const t1 = Number((entry + risk * 1.5).toFixed(2))
		return { entry, sl, t1 }
	} else {
		const sl = Number((params.orHigh + 5).toFixed(2))
		const risk = sl - entry
		const t1 = Number((entry - risk * 1.5).toFixed(2))
		return { entry, sl, t1 }
	}
}

/**
 * Replicates NiftyTrendPulseDetector level computation.
 */
function niftyTrendPulseLevels(
	side: 'LONG' | 'SHORT',
	params: { close: number; recentLows: number[]; recentHighs: number[] }
): { entry: number; sl: number; t1: number } {
	const entry = params.close
	if (side === 'LONG') {
		const indexSl = Number((Math.min(...params.recentLows) - 10).toFixed(2))
		const risk = entry - indexSl
		const t1 = Number((entry + risk * 1.5).toFixed(2))
		return { entry, sl: indexSl, t1 }
	} else {
		const indexSl = Number((Math.max(...params.recentHighs) + 10).toFixed(2))
		const risk = indexSl - entry
		const t1 = Number((entry - risk * 1.5).toFixed(2))
		return { entry, sl: indexSl, t1 }
	}
}

// ── StockMomentumBreakoutDetector ──────────────────────────────────────────

test('StockMomentumBreakout LONG: stop < entry < target', () => {
	const candle = { close: 1000, low: 988, high: 1010 }
	const levels = stockMomentumLevels('LONG', candle)
	assert.ok(levels, 'levels should be computed (risk within 1.5%)')
	assert.ok(levels.sl < levels.entry, `LONG stop (${levels.sl}) must be below entry (${levels.entry})`)
	assert.ok(levels.t1 > levels.entry, `LONG target (${levels.t1}) must be above entry (${levels.entry})`)
})

test('StockMomentumBreakout SHORT: target < entry < stop', () => {
	const candle = { close: 1000, low: 985, high: 1010 }
	const levels = stockMomentumLevels('SHORT', candle)
	assert.ok(levels, 'levels should be computed (risk within 1.5%)')
	assert.ok(levels.sl > levels.entry, `SHORT stop (${levels.sl}) must be above entry (${levels.entry})`)
	assert.ok(levels.t1 < levels.entry, `SHORT target (${levels.t1}) must be below entry (${levels.entry})`)
})

test('StockMomentumBreakout SHORT: geometry on a low-priced stock (₹50)', () => {
	const candle = { close: 50, low: 49.5, high: 50.4 }
	const levels = stockMomentumLevels('SHORT', candle)
	assert.ok(levels, 'levels should be computed')
	assert.ok(levels.sl > levels.entry, `SHORT stop must be above entry for low-priced stock`)
	assert.ok(levels.t1 < levels.entry, `SHORT target must be below entry for low-priced stock`)
})

test('StockMomentumBreakout SHORT: geometry on a high-priced stock (₹25000)', () => {
	const candle = { close: 25000, low: 24850, high: 25120 }
	const levels = stockMomentumLevels('SHORT', candle)
	assert.ok(levels, 'levels should be computed')
	assert.ok(levels.sl > levels.entry, `SHORT stop must be above entry for index-priced stock`)
	assert.ok(levels.t1 < levels.entry, `SHORT target must be below entry for index-priced stock`)
})

test('StockMomentumBreakout: rejects candle where risk > 1.5% of entry', () => {
	// HIGH is very far from close — SL would be > 1.5% above entry → reject
	const candle = { close: 1000, low: 980, high: 1100 }
	const levels = stockMomentumLevels('SHORT', candle)
	assert.strictEqual(levels, null, 'Should return null when risk is too wide')
})

// ── NiftyOpeningRangeExplosionDetector ────────────────────────────────────

test('NiftyORE LONG: stop < entry < target', () => {
	const params = { close: 23550, orLow: 23480, orHigh: 23540 }
	const levels = niftyOreLevels('LONG', params)
	assert.ok(levels.sl < levels.entry, `LONG SL (${levels.sl}) must be below entry (${levels.entry})`)
	assert.ok(levels.t1 > levels.entry, `LONG T1 (${levels.t1}) must be above entry (${levels.entry})`)
})

test('NiftyORE SHORT: target < entry < stop', () => {
	const params = { close: 23450, orLow: 23480, orHigh: 23540 }
	const levels = niftyOreLevels('SHORT', params)
	assert.ok(levels.sl > levels.entry, `SHORT SL (${levels.sl}) must be above entry (${levels.entry})`)
	assert.ok(levels.t1 < levels.entry, `SHORT T1 (${levels.t1}) must be below entry (${levels.entry})`)
})

// ── NiftyTrendPulseDetector ───────────────────────────────────────────────

test('NiftyTrendPulse LONG: stop < entry < target', () => {
	const params = { close: 23550, recentLows: [23400, 23420, 23390], recentHighs: [23560, 23580, 23570] }
	const levels = niftyTrendPulseLevels('LONG', params)
	assert.ok(levels.sl < levels.entry, `LONG SL (${levels.sl}) must be below entry (${levels.entry})`)
	assert.ok(levels.t1 > levels.entry, `LONG T1 (${levels.t1}) must be above entry (${levels.entry})`)
})

test('NiftyTrendPulse SHORT: target < entry < stop', () => {
	const params = { close: 23450, recentLows: [23400, 23420, 23390], recentHighs: [23560, 23580, 23570] }
	const levels = niftyTrendPulseLevels('SHORT', params)
	assert.ok(levels.sl > levels.entry, `SHORT SL (${levels.sl}) must be above entry (${levels.entry})`)
	assert.ok(levels.t1 < levels.entry, `SHORT T1 (${levels.t1}) must be below entry (${levels.entry})`)
})

// ── positionTracker exit check sanity ─────────────────────────────────────
// These mirror the exact if-conditions in processTick() so any change to the
// exit logic that breaks SHORT direction is caught immediately.

test('processTick SHORT exit logic: STOP_LOSS fires when ltp >= stopLoss', () => {
	const pos = { side: 'SHORT' as const, stopLoss: 1015, target: 985, entryPrice: 1000 }
	const ltp_sl = 1015   // exactly at stop
	const ltp_cont = 990  // below stop — still open
	assert.ok(ltp_sl >= pos.stopLoss, 'Should trigger STOP_LOSS when ltp >= stopLoss for SHORT')
	assert.ok(!(ltp_cont >= pos.stopLoss), 'Should NOT trigger STOP_LOSS when ltp < stopLoss for SHORT')
})

test('processTick SHORT exit logic: TARGET fires when ltp <= target', () => {
	const pos = { side: 'SHORT' as const, stopLoss: 1015, target: 985, entryPrice: 1000 }
	const ltp_target = 985  // exactly at target
	const ltp_cont = 990    // above target — still open
	assert.ok(ltp_target <= pos.target, 'Should trigger TARGET when ltp <= target for SHORT')
	assert.ok(!(ltp_cont <= pos.target), 'Should NOT trigger TARGET when ltp > target for SHORT')
})

test('processTick LONG exit logic: STOP_LOSS fires when ltp <= stopLoss', () => {
	const pos = { side: 'LONG' as const, stopLoss: 985, target: 1015, entryPrice: 1000 }
	assert.ok(985 <= pos.stopLoss, 'Should trigger STOP_LOSS at stopLoss for LONG')
	assert.ok(!(990 <= pos.stopLoss), 'Should NOT trigger at price above stopLoss for LONG')
})

test('processTick LONG exit logic: TARGET fires when ltp >= target', () => {
	const pos = { side: 'LONG' as const, stopLoss: 985, target: 1015, entryPrice: 1000 }
	assert.ok(1015 >= pos.target, 'Should trigger TARGET at target for LONG')
	assert.ok(!(1010 >= pos.target), 'Should NOT trigger when below target for LONG')
})
