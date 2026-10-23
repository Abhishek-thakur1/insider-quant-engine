// ============================================================
// tests/edgeMapStudy.test.ts — the edge-map study's statistics and exit mechanics
// (backtest/studies/edge-map/analyze.ts, pre-registered at 54cf86f)
// ============================================================

import '../backtest/core/bootEnv.js'
import test from 'node:test'
import assert from 'node:assert/strict'

import { MEAN, SLOPE, bh, estimate, fyersComponents, holm, parseCsv, parseSL, simExit, tier, tod } from '../backtest/studies/edge-map/analyze.js'

const IST = 330 * 60_000
const at = (hhmm: string) => Date.parse(`2024-03-04T${hhmm}:00Z`) - IST
const bar = (hhmm: string, o: number, h: number, l: number, c: number, v = 100) => ({ t: at(hhmm), o, h, l, c, v })

test('EDGE-MAP HOLM: step-down stops at the first non-rejection', () => {
	assert.deepEqual(holm([0.01, 0.04, 0.03]), [true, false, false]) // 0.01<=0.05/3; 0.03 > 0.05/2
	assert.deepEqual(holm([0.001, 0.02, 0.04]), [true, true, true])
})

test('EDGE-MAP BH: rejects every p up to the largest k with p_(k) <= k/m*q', () => {
	// m=4, q=0.1: thresholds .025 .05 .075 .1 → p_(3)=0.07 qualifies, so the first three are discoveries
	assert.deepEqual(bh([0.07, 0.01, 0.2, 0.04]), [true, true, false, true])
	assert.deepEqual(bh([0.5, 0.6]), [false, false])
})

test('EDGE-MAP ESTIMATE: point mean is the plain mean; CI brackets it; seeded and reproducible', () => {
	const items = Array.from({ length: 60 }, (_, i) => ({ day: `d${i % 20}`, v: (i % 5) - 1 })) // mean 1
	const a = estimate(items, (x) => x.day, MEAN((x) => x.v), 'k')
	const b = estimate(items, (x) => x.day, MEAN((x) => x.v), 'k')
	assert.equal(a.mean, 1)
	assert.equal(a.n, 60); assert.equal(a.days, 20)
	assert.ok(a.lo <= 1 && a.hi >= 1)
	assert.deepEqual(a, b, 'same seed and key → identical bootstrap')
	assert.equal(estimate([], (x: { day: string }) => x.day, MEAN(() => 0), 'e').n, 0)
})

test('EDGE-MAP SLOPE: recovers an exact linear relation', () => {
	const pts = Array.from({ length: 40 }, (_, i) => ({ day: `d${i % 10}`, x: 50 + i, y: 0.02 * (50 + i) - 1 }))
	const e = estimate(pts, (p) => p.day, SLOPE((p) => p.x, (p) => p.y), 's')
	assert.ok(Math.abs(e.mean - 0.02) < 1e-12)
})

test('EDGE-MAP EXIT: stop wins an ambiguous bar; target; 15:15 square-off; circuit-locked stop deferred', () => {
	assert.deepEqual(simExit('LONG', 100, 99, 101.5, [bar('10:00', 100, 102, 98, 100)]).reason, 'stop(both)')
	assert.deepEqual(simExit('LONG', 100, 99, 101.5, [bar('10:00', 100, 101.6, 99.5, 101)]), { exit: 101.5, reason: 'target' })
	assert.deepEqual(simExit('SHORT', 100, 101, 98.5, [bar('10:00', 100, 101.2, 99.8, 100)]), { exit: 101, reason: 'stop' })
	assert.deepEqual(simExit('LONG', 100, 99, 101.5, [bar('15:10', 100, 100.5, 99.5, 100.2), bar('15:15', 100.2, 100.4, 99.9, 100.3)]), { exit: 100.3, reason: 'square-off' })
	// zero-range bar with volume below the stop = circuit lock: the stop is not filled there
	const locked = simExit('LONG', 100, 99, 101.5, [bar('10:00', 98, 98, 98, 98, 500), bar('10:05', 98, 98.5, 97.5, 98.2)])
	assert.equal(locked.reason, 'stop'); assert.equal(locked.exit, 99)
})

test('EDGE-MAP BUCKETS: time of day and score tier boundaries are the registered ones', () => {
	assert.equal(tod(at('10:29')), 'T1'); assert.equal(tod(at('10:30')), 'T2'); assert.equal(tod(at('13:30')), 'T3')
	assert.deepEqual([59, 60, 69, 70, 77, 78].map(tier), ['<60', '60-69', '60-69', '70-77', '70-77', '>=78'])
})

test('EDGE-MAP PARSE: trigger SL and a quoted CSV with embedded commas, quotes and newlines', () => {
	assert.equal(parseSL('Entry ₹995.80 | SL ₹980.88 | T1 ₹1018.18'), 980.88)
	assert.equal(parseSL('Entry ₹1,995.80 | SL ₹1,980.5 | T1'), 1980.5)
	assert.equal(parseSL('no levels'), null)
	const rows = parseCsv('id,j,n\n1,"{""a"":1,""b"":2}",x\n2,"line1\nline2",y\n')
	assert.equal(rows.length, 2)
	assert.equal(rows[0]!.j, '{"a":1,"b":2}')
	assert.equal(rows[1]!.j, 'line1\nline2')
})

test('EDGE-MAP FYERS COSTS: brokerage cap, one-sided STT and stamp, GST base', () => {
	const bps = (n: number, name: string) => fyersComponents(n).find((c) => c.name.startsWith(name))!.bps
	assert.ok(Math.abs(bps(10_000, 'Brokerage') - 6) < 1e-9, '0.03% of ₹10k = ₹3 per leg = 6 bps round trip')
	assert.ok(Math.abs(bps(100_000, 'Brokerage') - 4) < 1e-9, '₹20 cap per leg at ₹1L = 4 bps round trip')
	assert.ok(Math.abs(bps(10_000, 'STT') - 2.5) < 1e-9)
	assert.ok(Math.abs(bps(10_000, 'Stamp') - 0.2) < 1e-9)
	const g = fyersComponents(10_000)
	const base = ['Brokerage', 'NSE transaction', 'Clearing', 'SEBI', 'NSE IPFT'].reduce((a, n) => a + g.find((c) => c.name.startsWith(n))!.bps, 0)
	assert.ok(Math.abs(g.find((c) => c.name === 'GST')!.bps - 0.18 * base) < 1e-9)
	assert.ok(Math.abs(bps(10_000, 'Slippage') - 10) < 1e-9)
})
