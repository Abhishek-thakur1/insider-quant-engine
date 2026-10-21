// ============================================================
// tests/tickStats.test.ts — heartbeat tick accounting (diagnostics only)
//
// Exercises the real src/core/tickStats.ts that websocket.ts prints on every
// heartbeat. Routing is not covered here: the counters never change it.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

import { formatTickStats, newTickStats, sampleOf } from '../src/core/tickStats.js'

test('fresh stats are all zero and print "none" for the equity sample', () => {
	const lines = formatTickStats(newTickStats(), 25)
	assert.equal(lines.length, 2)
	assert.match(lines[0]!, /ticks 0 \| index 0 \| option 0 \| eq→router 0/)
	assert.match(lines[0]!, /active symbols seen 0\/25/)
	assert.match(lines[1]!, /none this beat/)
})

test('counts, distinct active symbols and both samples are printed', () => {
	const s = newTickStats()
	s.ticks = 7
	s.eqZeroVol = 3
	s.eqNoVolField = 3
	s.activeSymbols.add('NSE:TCS-EQ').add('NSE:TCS-EQ').add('NSE:INFY-EQ')
	s.sampleEquity = sampleOf({ symbol: 'NSE:TCS-EQ', ltp: 1 })
	s.sampleUnparsed = sampleOf('hello')
	const lines = formatTickStats(s, 25)
	assert.equal(lines.length, 3)
	assert.match(lines[0]!, /ticks 7 .*eq dropped zero-vol 3 \(no vol field 3\).*active symbols seen 2\/25/)
	assert.match(lines[1]!, /"symbol":"NSE:TCS-EQ"/)
	assert.match(lines[2]!, /hello/)
})

test('samples are truncated and never throw', () => {
	assert.equal(sampleOf('x'.repeat(1000)).length, 300)
	const cyclic: Record<string, unknown> = {}
	cyclic.self = cyclic
	assert.equal(sampleOf(cyclic), '[unserialisable]')
	assert.equal(sampleOf(undefined), 'undefined')
})
