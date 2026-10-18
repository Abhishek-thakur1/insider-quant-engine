// ============================================================
// tests/positionStatus.test.ts — paper_trades status rules
//
// Exercises the real src/core/positionStatus.ts helpers that positionTracker
// uses for the insert status and the boot-time orphan decision.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

import { insertStatusFor, isOrphanedAtBoot, istDate } from '../src/core/positionStatus.js'

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
