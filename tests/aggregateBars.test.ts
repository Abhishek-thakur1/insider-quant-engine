// tests/aggregateBars.test.ts — 1-minute → 5-minute aggregation is exact and session-aligned
import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateBars } from '../backtest/data/store.js'

const IST = 5.5 * 3600e3
const at = (day: string, h: number, m: number) => Date.parse(`${day}T00:00:00Z`) - IST + (h * 60 + m) * 60e3

test('five 1-minute bars 09:15–09:19 become one 09:15 bar: first open, max high, min low, last close, summed volume', () => {
	const ones = [0, 1, 2, 3, 4].map((k) => ({ t: at('2026-09-07', 9, 15 + k), o: 100 + k, h: 101 + k + (k === 2 ? 5 : 0), l: 99 + k - (k === 3 ? 4 : 0), c: 100.5 + k, v: 10 + k }))
	const five = aggregateBars(ones, 5)
	assert.equal(five.length, 1)
	assert.deepEqual(five[0], { t: at('2026-09-07', 9, 15), o: 100, h: 108, l: 98, c: 104.5, v: 60 })
})

test('a full session (09:15–15:29) gives 75 bars aligned to 09:15, 09:20, …, 15:25; days never merge', () => {
	const ones = []
	for (const day of ['2026-09-04', '2026-09-07'])
		for (let m = 9 * 60 + 15; m < 15 * 60 + 30; m++) ones.push({ t: at(day, 0, m), o: 1, h: 2, l: 0.5, c: 1.5, v: 1 })
	const five = aggregateBars(ones, 5)
	assert.equal(five.length, 150)
	assert.equal(five[0]!.t, at('2026-09-04', 9, 15))
	assert.equal(five[74]!.t, at('2026-09-04', 15, 25))
	assert.equal(five[75]!.t, at('2026-09-07', 9, 15))
	assert.ok(five.every((b) => b.v === 5))
})

test('a missing minute does not shift buckets', () => {
	const ones = [{ t: at('2026-09-07', 9, 18), o: 5, h: 6, l: 4, c: 5, v: 1 }, { t: at('2026-09-07', 9, 21), o: 7, h: 8, l: 6, c: 7, v: 1 }]
	assert.deepEqual(aggregateBars(ones, 5).map((b) => b.t), [at('2026-09-07', 9, 15), at('2026-09-07', 9, 20)])
})
