// tests/trendDay.test.ts — the committed trend-day rule, hand-checked
import test from 'node:test'
import assert from 'node:assert/strict'
import { labelSession, loadTrendDayConfig } from '../backtest/trendDay.js'

const cfg = loadTrendDayConfig()

test('committed thresholds: body >= 60% of range, close in the outer 25%', () => {
	assert.deepEqual({ b: cfg.bodyFraction, c: cfg.closeFraction }, { b: 0.6, c: 0.25 })
})

test('labels: trend-down, trend-up, chop, and the boundaries', () => {
	// range 100: open 23100, close 23020 (body -80), close 20 above the low → trend-down
	assert.equal(labelSession({ o: 23100, h: 23110, l: 23000, c: 23020 }, cfg), 'trend-down')
	assert.equal(labelSession({ o: 23000, h: 23100, l: 22990, c: 23080 }, cfg), 'trend-up')
	// big body but close far from the extreme (40 above the low = 40% of range) → chop
	assert.equal(labelSession({ o: 23100, h: 23100, l: 23000, c: 23040 }, cfg), 'chop')
	// exactly 60% body and exactly 25% from the low → trend-down (inclusive)
	assert.equal(labelSession({ o: 23085, h: 23100, l: 23000, c: 23025 }, cfg), 'trend-down')
	assert.equal(labelSession({ o: 1, h: 1, l: 1, c: 1 }, cfg), 'chop')
})
