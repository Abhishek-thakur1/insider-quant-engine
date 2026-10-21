// ============================================================
// tests/emaTrend.test.ts — Nifty EMA trend study engine (backtest/emaTrend.ts)
//
// Required by the study's goal file: no look-ahead, EMA / VWAP-proxy values
// against hand-checked fixtures, stop-first handling, the 15:15 forced exit.
// Plus: wide-stop skips, one open position, gap fills at the open.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

import {
	buildIndicators,
	emaSeries,
	findSignals,
	initialStop,
	runVariant,
	sessionTwap,
	simulateExit,
	toSessionBars,
	type Bar,
	type SBar,
	type StudyParams,
	type VariantSpec,
} from '../backtest/emaTrend.js'

const P: StudyParams = {
	barMinutes: 5,
	entryFirstCloseMinute: 570,
	entryLastCloseMinute: 885,
	forcedExitCloseMinute: 915,
	slopeLookbackBars: 3,
	stopLookbackBars: 4,
	stopBufferPts: 5,
	maxStopPts: 80,
	roundTripPts: 2.3,
	costMultiplier: 2,
	touchPct: 0.05,
	minBarsBetweenEntries: 3,
}

// 2026-03-02 09:15 IST = 03:45 UTC
const DAY0 = Date.parse('2026-03-02T03:45:00Z')
const bar = (k: number, o: number, h: number, l: number, c: number, dayOffset = 0): Bar => ({ t: DAY0 + dayOffset * 86_400_000 + k * 300_000, o, h, l, c })
/** A full 09:15–15:25 session (75 bars) from a close path; o = previous close, h/l = ±1 around o/c. */
const session = (closes: number[], dayOffset = 0, start = 100): Bar[] =>
	closes.map((c, k) => {
		const o = k === 0 ? start : closes[k - 1]!
		return bar(k, o, Math.max(o, c) + 1, Math.min(o, c) - 1, c, dayOffset)
	})

test('EMA: SMA seed then alpha = 2/(n+1) — hand-checked', () => {
	// n=3: seed = (1+2+3)/3 = 2 at i=2; alpha = 0.5 → i3: 0.5*4+0.5*2 = 3; i4: 0.5*10+0.5*3 = 6.5
	assert.deepEqual(emaSeries([1, 2, 3, 4, 10], 3), [null, null, 2, 3, 6.5])
	assert.deepEqual(emaSeries([1, 2], 3), [null, null])
})

test('VWAP proxy: running mean of typical price, reset each session — hand-checked', () => {
	const bars = toSessionBars([bar(0, 10, 12, 9, 12), bar(1, 12, 15, 12, 15), bar(0, 20, 21, 18, 18, 1)], 5)
	// day 1: tp0 = (12+9+12)/3 = 11; tp1 = (15+12+15)/3 = 14 → mean 12.5; day 2 resets: (21+18+18)/3 = 19
	assert.deepEqual(sessionTwap(bars), [11, 12.5, 19])
	assert.equal(bars[0]!.startMin, 555)
	assert.equal(bars[0]!.closeMin, 560)
	assert.equal(bars[2]!.day, '2026-03-03')
})

test('NO LOOK-AHEAD: changing bars after t never changes signals at or before t', () => {
	// two sessions of a down-then-up path so every variant fires
	const path1 = Array.from({ length: 75 }, (_, k) => 100 - k * 0.6 + (k % 5 === 4 ? 1.2 : 0))
	const path2 = Array.from({ length: 75 }, (_, k) => 60 + k * 0.6 - (k % 5 === 4 ? 1.2 : 0))
	const base = toSessionBars([...session(path1), ...session(path2, 1, path1.at(-1)!)], 5)
	const variants: VariantSpec[] = [
		{ id: 'V0', label: 'V0', fast: 9, slow: 21, trendEma: 20 },
		{ id: 'V1', label: 'V1', trendEma: 20 },
		{ id: 'V2', label: 'V2', trendEma: 20 },
	]
	for (const v of variants) {
		const all = findSignals(base, buildIndicators(base, v), v, P)
		assert.ok(all.length > 0, `${v.id} fires on the fixture`)
		for (const cut of [40, 90, 120]) {
			const mutated: SBar[] = base.map((b, i) => (i > cut ? { ...b, o: b.o * 3, h: b.h * 3 + 50, l: b.l * 0.2, c: b.c * 2.5 } : b))
			const after = findSignals(mutated, buildIndicators(mutated, v), v, P).filter((s) => s.i <= cut)
			assert.deepEqual(after, all.filter((s) => s.i <= cut), `${v.id}: signals up to bar ${cut} changed when later bars changed`)
		}
	}
})

test('STOP FIRST: a bar that hits the stop and also closes through the trail exits at the stop', () => {
	const bars = toSessionBars(session(Array.from({ length: 20 }, () => 100)), 5)
	bars[6] = { ...bars[6]!, o: 100, h: 130, l: 99, c: 125 } // SHORT stop at 110 is touched; close 125 is also above the trail
	const trail = bars.map(() => 101)
	const x = simulateExit(bars, trail, 5, 'SHORT', 110, P)
	assert.deepEqual(x, { j: 6, price: 110, reason: 'STOP' })
})

test('STOP GAP: a bar opening beyond the stop fills at the open (worse), not the stop', () => {
	const bars = toSessionBars(session(Array.from({ length: 20 }, () => 100)), 5)
	bars[6] = { ...bars[6]!, o: 90, h: 91, l: 85, c: 88 }
	const x = simulateExit(bars, bars.map(() => 50), 5, 'LONG', 95, P)
	assert.deepEqual(x, { j: 6, price: 90, reason: 'STOP_GAP' })
})

test('TIME EXIT: a position still open exits at the close of the bar ending 15:15', () => {
	const closes = Array.from({ length: 75 }, (_, k) => 100 + k * 0.1)
	const bars = toSessionBars(session(closes), 5)
	const k1515 = bars.findIndex((b) => b.closeMin === 915)
	assert.equal(k1515, 71)
	const x = simulateExit(bars, bars.map(() => 0), 20, 'LONG', 0, P) // trail never crossed, stop never hit
	assert.deepEqual(x, { j: 71, price: bars[71]!.c, reason: 'TIME' })
})

test('SESSION GAP: a session without a 15:15 bar exits at its last bar and is reported', () => {
	const bars = toSessionBars([...session(Array.from({ length: 30 }, () => 100)), ...session(Array.from({ length: 75 }, () => 100), 1)], 5)
	const x = simulateExit(bars, bars.map(() => 0), 10, 'LONG', 0, P)
	assert.deepEqual(x, { j: 29, price: 100, reason: 'SESSION_END_GAP' })
})

test('INITIAL STOP: extreme of bars t-3..t ± 5; > 80 points is skipped and counted', () => {
	const bars = toSessionBars(session([100, 104, 103, 101, 99, 98]), 5)
	// SHORT at i=5: highs of bars 2..5 → max(h2..h5) + 5
	const hi = Math.max(bars[2]!.h, bars[3]!.h, bars[4]!.h, bars[5]!.h)
	assert.equal(initialStop(bars, 5, 'SHORT', P), hi + 5)
	const lo = Math.min(bars[2]!.l, bars[3]!.l, bars[4]!.l, bars[5]!.l)
	assert.equal(initialStop(bars, 5, 'LONG', P), lo - 5)

	// a falling session with one 200-point spike just before the V1 entry → stop > 80 points → skipped
	const path = Array.from({ length: 75 }, (_, k) => 1000 - k * 2)
	const raw = session(path, 0, 1000)
	const sb = toSessionBars(raw, 5)
	const v: VariantSpec = { id: 'V1', label: 'V1', trendEma: 20 }
	const sig = findSignals(sb, buildIndicators(sb, v), v, P)
	assert.ok(sig.length > 0)
	const first = sig[0]!.i
	const spiked = sb.map((b, i) => (i === first - 1 ? { ...b, h: b.h + 200 } : b))
	const r = runVariant(spiked, v, P)
	assert.ok(r.skippedWideStop >= 1)
})

test('ONE POSITION: a signal while a position is open is skipped and counted; R uses cost and risk', () => {
	// steady fall: V2 touches recur every 5 bars; a TIME-held position blocks later ones
	const path = Array.from({ length: 75 }, (_, k) => 1000 - k * 1.5 + (k % 5 === 4 ? 3 : 0))
	const sb = toSessionBars(session(path, 0, 1000), 5)
	const v: VariantSpec = { id: 'V2', label: 'V2', trendEma: 20 }
	const r = runVariant(sb, v, P)
	assert.equal(r.trades.length + r.skippedOpenPosition + r.skippedWideStop, r.signals)
	for (const t of r.trades) {
		assert.ok(t.exitIdx > t.entryIdx, 'exit strictly after entry')
		assert.equal(t.r, (t.pts - 2.3) / t.risk)
		assert.equal(t.r2x, (t.pts - 4.6) / t.risk)
		assert.equal(t.side, 'SHORT')
	}
	for (let k = 1; k < r.trades.length; k++) assert.ok(r.trades[k]!.entryIdx > r.trades[k - 1]!.exitIdx, 'never two open positions')
})

test('ENTRY WINDOW: no entry on bars closing before 09:30 or after 14:45', () => {
	const path = Array.from({ length: 75 }, (_, k) => 1000 - k * 1.5 + (k % 5 === 4 ? 3 : 0))
	const sb = toSessionBars(session(path, 0, 1000), 5)
	for (const v of [{ id: 'V1', label: 'V1', trendEma: 20 }, { id: 'V2', label: 'V2', trendEma: 20 }] as VariantSpec[]) {
		for (const s of findSignals(sb, buildIndicators(sb, v), v, P)) {
			assert.ok(sb[s.i]!.closeMin >= 570 && sb[s.i]!.closeMin <= 885, `${v.id} entry at ${sb[s.i]!.closeMin}`)
		}
	}
})
