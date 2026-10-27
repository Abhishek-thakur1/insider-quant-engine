// ============================================================
// tests/positionStatus.test.ts — paper_trades status rules
//
// Exercises the real src/core/positionStatus.ts helpers that positionTracker
// uses for the insert status and the boot-time orphan decision.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

import fs from 'node:fs'

import { insertStatusFor, isOrphanedAtBoot, istDate, orphanUpdate, rowMatch } from '../src/core/positionStatus.js'

// 2026-10-16 10:00 IST and 2026-10-17 10:00 IST
const DAY1 = Date.parse('2026-10-16T04:30:00Z')
const DAY2 = Date.parse('2026-10-17T04:30:00Z')

test('istDate buckets by IST, not UTC', () => {
	// 2026-10-16 20:00 UTC is already 2026-10-17 01:30 IST
	assert.equal(istDate(Date.parse('2026-10-16T20:00:00Z')), '2026-10-17')
	assert.equal(istDate(DAY1), '2026-10-16')
})

test('capital-skipped signals are inserted as SKIPPED with a capital_skipped flag', () => {
	assert.deepEqual(insertStatusFor({ size: 50, actualSize: 0 }), {
		status: 'SKIPPED',
		dataQuality: ['capital_skipped'],
	})
	assert.deepEqual(insertStatusFor({ size: 50, actualSize: 20 }), {
		status: 'OPEN',
		dataQuality: [],
	})
	// actualSize absent → falls back to size, matching registerTrade's actual_size column
	assert.deepEqual(insertStatusFor({ size: 50 }), { status: 'OPEN', dataQuality: [] })
	assert.equal(insertStatusFor({ size: 0 }).status, 'SKIPPED')
})

test('prior-day INTRADAY positions are orphaned at boot; same-day and SWING are kept', () => {
	assert.equal(isOrphanedAtBoot({ timestamp: DAY1, durationClass: 'INTRADAY' }, DAY2), true)
	assert.equal(isOrphanedAtBoot({ timestamp: DAY1 }, DAY2), true) // missing class = INTRADAY
	assert.equal(isOrphanedAtBoot({ timestamp: DAY1, durationClass: 'SWING' }, DAY2), false)
	assert.equal(
		isOrphanedAtBoot({ timestamp: DAY2 - 3600_000, durationClass: 'INTRADAY' }, DAY2),
		false,
	)
})

test('boot orphan update touches only OPEN rows, never SKIPPED (26 Oct finding: rows 1599, 1603)', () => {
	const q = orphanUpdate(rowMatch({ dbId: 1599, symbol: 'NIFTY 22450 PE', timestamp: DAY1 }, 1))
	assert.match(q.text, /SET status = 'ORPHANED'/)
	assert.match(q.text, /WHERE id = \$1 AND status = 'OPEN'$/)
	assert.doesNotMatch(q.text, /SKIPPED/, 'a capital-skipped row must keep its SKIPPED status')
	assert.deepEqual(q.params, [1599])
	// legacy rows (no dbId) keep the symbol + entry_time match, still OPEN-only
	const legacy = orphanUpdate(rowMatch({ symbol: 'NSE:X-EQ', timestamp: DAY1 }, 1))
	assert.match(legacy.text, /symbol = \$1 AND entry_time = to_timestamp\(\$2 \/ 1000\.0\) AND status = 'OPEN'$/)
})

test('positionTracker uses orphanUpdate (no inline orphan SQL that could re-add SKIPPED)', () => {
	const src = fs.readFileSync('src/core/positionTracker.ts', 'utf8').replace(/^\s*\/\/.*$/gm, '')
	assert.match(src, /orphanUpdate\(rowMatch\(pos, 1\)\)/)
	assert.doesNotMatch(src, /SET status = 'ORPHANED'/, 'the orphan SQL lives only in positionStatus.orphanUpdate')
})
