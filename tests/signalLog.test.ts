// ============================================================
// tests/signalLog.test.ts — signals row builder + non-blocking writer
//
// Exercises the real src/db/signalRecord.ts (pure column mapping) and
// src/db/signalLog.ts (batching, retry, counters) with a fake query function.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

import {
	buildSignalRow,
	capitalOutcome,
	gateColumns,
	newSignalDraft,
	suppressionReason,
	SIGNAL_COLUMNS,
	type SignalRow,
} from '../src/db/signalRecord.js'
import { SignalLog, buildInsertSql, type QueryFn } from '../src/db/signalLog.js'
import {
	clearSymbolSources,
	getSymbolSource,
	registerWatchlistSources,
	setSymbolSource,
} from '../src/core/symbolSource.js'
import type { FilterDecision } from '../src/detectors/janeStreetFilter.js'

const NOW = Date.parse('2026-10-19T05:00:00Z')

const decision = (o: Partial<FilterDecision> = {}): FilterDecision => ({
	passed: true,
	score: 85,
	posterior: 0.62,
	ev: 4.2,
	kellyHalf: 0.021,
	regime: 'TRENDING',
	entropy: 0.41,
	sizeMult: 1,
	breakdown: [
		{ component: 'REGIME', points: 12, maxPoints: 12, reason: 'ok [MOMENTUM/explicit]' },
		{ component: 'BAYESIAN', points: 15.5, maxPoints: 25, reason: 'P=62%' },
		{ component: 'EV_KELLY', points: 6, maxPoints: 10, reason: 'EV=₹4.2' },
	],
	positionNote: '',
	shadowMode: false,
	...o,
})

const draft = (symbol = 'NSE:TEST-EQ', trigger = 'x | SL ₹496 | T1 ₹506') =>
	newSignalDraft(
		{ symbol, side: 'LONG', price: 500, trigger, detectorName: 'Stock Momentum Breakout' },
		{ signalId: 'id-1', firedAt: NOW, shadowMode: false },
	)

// ── gate columns ────────────────────────────────────────────────────────────

test('REGIME reject: later stages are NULL (not evaluated), never PASS', () => {
	const g = gateColumns(
		decision({
			passed: false,
			score: 0,
			rejectedAt: 'REGIME',
			breakdown: [{ component: 'REGIME', points: 0, maxPoints: 12, reason: 'blocked' }],
		}),
		false,
		78,
	)
	assert.equal(g.regime_result, 'REJECT')
	assert.equal(g.regime_reason, 'blocked')
	assert.equal(g.filter_result, 'REJECTED')
	assert.equal(g.rejected_at, 'REGIME')
	for (const k of [
		'bayesian_posterior',
		'ev_result',
		'ev_value',
		'kelly_half',
		'score_result',
	] as const)
		assert.equal(g[k], null, k)
})

test('EV reject: regime PASS, Bayesian recorded, EV REJECT, Kelly and score NULL', () => {
	const g = gateColumns(
		decision({
			passed: false,
			score: 40,
			rejectedAt: 'EV',
			ev: -3,
			breakdown: [
				{ component: 'REGIME', points: 12, maxPoints: 12, reason: 'ok [MOMENTUM/explicit]' },
				{ component: 'BAYESIAN', points: 10, maxPoints: 25, reason: 'P=40%' },
				{ component: 'EV', points: 0, maxPoints: 10, reason: 'NEGATIVE EV' },
			],
		}),
		false,
		78,
	)
	assert.equal(g.regime_result, 'PASS')
	assert.equal(g.bayesian_points, 10)
	assert.equal(g.ev_result, 'REJECT')
	assert.equal(g.ev_reason, 'NEGATIVE EV')
	assert.equal(g.ev_value, -3)
	assert.equal(g.kelly_half, null)
	assert.equal(g.score_result, null)
	assert.equal(g.rejected_at, 'EV')
})

test('below threshold → rejected_at SCORE; pass → PASSED with every stage filled', () => {
	const below = gateColumns(decision({ passed: false, score: 60 }), false, 78)
	assert.deepEqual(
		[below.score_result, below.filter_result, below.rejected_at],
		['BELOW_THRESHOLD', 'REJECTED', 'SCORE'],
	)
	const pass = gateColumns(decision(), false, 78)
	assert.deepEqual(
		[pass.score_result, pass.filter_result, pass.rejected_at, pass.ev_result],
		['PASS', 'PASSED', null, 'PASS'],
	)
	assert.equal(pass.kelly_points, 6)
	assert.equal(pass.score_threshold, 78)
})

test('filter error → ERROR, all stages NULL; guessed regime class is flagged', () => {
	const err = gateColumns(undefined, true, 78)
	assert.equal(err.filter_result, 'ERROR')
	assert.equal(err.regime_result, null)
	const guessed = gateColumns(
		decision({
			breakdown: [
				{ component: 'REGIME', points: 12, maxPoints: 12, reason: 'ok [MOMENTUM/trigger]' },
			],
		}),
		false,
		78,
	)
	assert.equal(guessed.regime_guessed, true)
	assert.equal(gateColumns(decision(), false, 78).regime_guessed, false)
})

test('non-finite numbers become NULL', () => {
	const g = gateColumns(decision({ ev: Number.NaN, entropy: Infinity }), false, 78)
	assert.equal(g.ev_value, null)
	assert.equal(g.entropy, null)
})

// ── capital / suppression mapping ───────────────────────────────────────────

test('capital outcome mapping', () => {
	assert.equal(capitalOutcome(undefined), null)
	assert.equal(
		capitalOutcome({ qty: 20, actualSize: 20, capitalGated: false, skip: false }),
		'TRADED',
	)
	assert.equal(
		capitalOutcome({ qty: 20, actualSize: 10, capitalGated: true, skip: false }),
		'REDUCED',
	)
	assert.equal(
		capitalOutcome({ qty: 20, actualSize: 0, capitalGated: true, skip: true }),
		'SKIPPED_CAPITAL',
	)
})

test('suppression reason: sent → null; filter error → FILTER_ERROR not NOT_GATED; unknown end → WORKER_ERROR', () => {
	const d = draft()
	assert.equal(suppressionReason({ ...d, alertSent: true }), null)
	assert.equal(
		suppressionReason({ ...d, filterError: true, suppressed: 'NOT_GATED' }),
		'FILTER_ERROR',
	)
	assert.equal(suppressionReason({ ...d, suppressed: 'DUPLICATE' }), 'DUPLICATE')
	assert.equal(suppressionReason(d), 'WORKER_ERROR')
})

// ── row builder ─────────────────────────────────────────────────────────────

test('row has exactly the INSERT columns, IST trade_date, trigger levels and data_quality flags', () => {
	const row = buildSignalRow(
		{ ...draft(), decision: decision(), alertSent: true, tradeId: 7 },
		{ threshold: 78, promotionSource: 'CORE' },
	)
	assert.deepEqual(Object.keys(row).sort(), [...SIGNAL_COLUMNS].sort())
	assert.equal(row.trade_date, '2026-10-19')
	assert.equal(row.fired_at, '2026-10-19T05:00:00.000Z')
	assert.equal(row.trigger_sl, 496)
	assert.equal(row.trigger_t1, 506)
	assert.equal(row.levels_parsed, true)
	assert.equal(row.entry_price, null) // never sized in this draft
	assert.deepEqual(row.data_quality, [])
	assert.equal(typeof row.breakdown, 'string')

	const opt = buildSignalRow(draft('NIFTY 25000 CE', 'no levels here'), {
		threshold: 78,
		promotionSource: 'INDEX',
	})
	assert.deepEqual(opt.data_quality, ['index_option_proxy', 'levels_default_rr'])
	assert.equal(opt.trigger_sl, null)
	assert.equal(opt.breakdown, null)
})

test('IST day boundary: 20:00 UTC is the next IST day', () => {
	const d = { ...draft(), firedAt: Date.parse('2026-10-19T20:00:00Z') }
	assert.equal(
		buildSignalRow(d, { threshold: 78, promotionSource: 'CORE' }).trade_date,
		'2026-10-20',
	)
})

// ── promotion source registry ───────────────────────────────────────────────

test('promotion source: core vs screener vs anomaly vs index', () => {
	clearSymbolSources()
	registerWatchlistSources(['NSE:A-EQ', 'NSE:B-EQ'], ['NSE:A-EQ'])
	setSymbolSource('NSE:C-EQ', 'ANOMALY')
	assert.equal(getSymbolSource('NSE:A-EQ'), 'CORE')
	assert.equal(getSymbolSource('NSE:B-EQ'), 'SCREENER')
	assert.equal(getSymbolSource('NSE:C-EQ'), 'ANOMALY')
	assert.equal(getSymbolSource('NIFTY 25000 CE'), 'INDEX')
	assert.equal(getSymbolSource('NSE:Z-EQ'), 'UNKNOWN')
	clearSymbolSources()
})

// ── writer ──────────────────────────────────────────────────────────────────

const rowN = (n: number): SignalRow =>
	buildSignalRow(
		{ ...draft(), signalId: `id-${n}`, firedAt: NOW + n },
		{ threshold: 78, promotionSource: 'CORE' },
	)

const quietLog = () => {
	const lines: string[] = []
	const push = (...a: unknown[]) => lines.push(a.map(String).join(' '))
	return { lines, log: { log: push, warn: push, error: push } }
}

test('insert SQL: one placeholder per column per row, ON CONFLICT DO NOTHING', () => {
	const { text, values } = buildInsertSql([rowN(1), rowN(2)])
	assert.equal(values.length, SIGNAL_COLUMNS.length * 2)
	assert.match(text, /ON CONFLICT DO NOTHING$/)
	assert.ok(text.includes(`$${SIGNAL_COLUMNS.length * 2}`))
})

test('enqueue never throws or awaits, even when the database rejects everything', async () => {
	const { log } = quietLog()
	const sl = new SignalLog({
		query: async () => Promise.reject(new Error('db down')),
		log,
		flushMs: 60_000,
	})
	const t0 = Date.now()
	for (let i = 0; i < 10; i++) assert.equal(sl.enqueue(rowN(i)), undefined)
	assert.ok(Date.now() - t0 < 50)
	await sl.flush()
	assert.equal(sl.stats.failedDropped, 10)
	await sl.shutdown(100)
})

test('batches by size: 250 rows → 3 INSERTs of 100/100/50', async () => {
	const calls: number[] = []
	const query: QueryFn = async (_t, v) => {
		calls.push(v.length / SIGNAL_COLUMNS.length)
		return { rowCount: v.length / SIGNAL_COLUMNS.length }
	}
	const { log } = quietLog()
	const sl = new SignalLog({ query, log, flushMs: 60_000 })
	for (let i = 0; i < 250; i++) sl.enqueue(rowN(i))
	await sl.flush()
	assert.deepEqual(calls, [100, 100, 50])
	assert.equal(sl.stats.inserted, 250)
	await sl.shutdown(100)
})

test('flushes on the timer without reaching batch size', async () => {
	let inserted = 0
	const { log } = quietLog()
	const sl = new SignalLog({
		query: async (_t, v) => ((inserted += v.length / SIGNAL_COLUMNS.length), { rowCount: 1 }),
		log,
		flushMs: 20,
	})
	sl.enqueue(rowN(1))
	await new Promise((r) => setTimeout(r, 80))
	assert.equal(inserted, 1)
	await sl.shutdown(100)
})

test('UNIQUE conflicts are counted and logged', async () => {
	const { lines, log } = quietLog()
	// Pretend 2 of 5 rows already existed
	const sl = new SignalLog({ query: async () => ({ rowCount: 3 }), log, flushMs: 60_000 })
	for (let i = 0; i < 5; i++) sl.enqueue(rowN(i))
	await sl.flush()
	assert.equal(sl.stats.conflictSkipped, 2)
	assert.equal(sl.stats.inserted, 3)
	assert.ok(
		lines.some((l) => l.includes('2 row(s) skipped by UNIQUE constraint (session total 2)')),
	)
	await sl.shutdown(100)
	assert.ok(lines.some((l) => l.includes('unique_skipped=2')))
})

test('queue cap drops the oldest rows, counts and logs them', async () => {
	const { lines, log } = quietLog()
	const seen: unknown[] = []
	let release!: () => void
	const gate = new Promise<void>((r) => (release = r))
	const query: QueryFn = async (_t, v) => {
		await gate
		seen.push(v[0])
		return { rowCount: v.length / SIGNAL_COLUMNS.length }
	}
	const sl = new SignalLog({ query, log, flushMs: 60_000, batchSize: 1000, maxQueue: 3 })
	for (let i = 0; i < 5; i++) sl.enqueue(rowN(i)) // ids 0,1 dropped
	assert.equal(sl.stats.queueCapDropped, 2)
	assert.ok(lines.some((l) => l.includes('Queue full (3)')))
	release()
	await sl.flush()
	assert.deepEqual(seen, ['id-2'])
	await sl.shutdown(100)
	assert.ok(lines.some((l) => l.includes('queue_cap_dropped=2')))
})

test('failed batch is retried row by row: only the bad row is dropped, and it is logged', async () => {
	const { lines, log } = quietLog()
	const query: QueryFn = async (_t, v) => {
		const rows = v.length / SIGNAL_COLUMNS.length
		if (rows > 1) throw new Error('batch failed')
		if (v[0] === 'id-2') throw new Error('check constraint')
		return { rowCount: 1 }
	}
	const sl = new SignalLog({ query, log, flushMs: 60_000 })
	for (let i = 0; i < 4; i++) sl.enqueue(rowN(i))
	await sl.flush()
	assert.equal(sl.stats.inserted, 3)
	assert.equal(sl.stats.failedDropped, 1)
	assert.equal(sl.stats.batchRetries, 1)
	assert.ok(
		lines.some(
			(l) =>
				l.startsWith('[SignalLog] DROPPED (check constraint') && l.includes('"signal_id":"id-2"'),
		),
	)
	await sl.shutdown(100)
})

test('shutdown flushes pending rows and logs totals', async () => {
	const { lines, log } = quietLog()
	let inserted = 0
	const sl = new SignalLog({
		query: async (_t, v) => (
			(inserted += v.length / SIGNAL_COLUMNS.length),
			{ rowCount: v.length / SIGNAL_COLUMNS.length }
		),
		log,
		flushMs: 60_000,
	})
	sl.enqueue(rowN(1))
	sl.enqueue(rowN(2))
	await sl.shutdown(500)
	assert.equal(inserted, 2)
	assert.equal(sl.pending, 0)
	assert.ok(
		lines.some((l) =>
			l.includes(
				'session totals: enqueued=2 inserted=2 unique_skipped=0 queue_cap_dropped=0 failed_dropped=0',
			),
		),
	)
})

// ── Oct 21 stall: a flush on an EMPTY queue left `flushing` set forever ─────
// Live: GALLANTT's row was written at 14:22; the 1-second timer then ran
// flush() on an empty queue; MRPL, JINDWORLD and AEQUS (14:27–14:38) were
// enqueued but never written, and nothing was logged.

const countingQuery = () => {
	const box = { inserted: 0 }
	const query: QueryFn = async (_t, v) => {
		const n = v.length / SIGNAL_COLUMNS.length
		box.inserted += n
		return { rowCount: n }
	}
	return { box, query }
}

test('STALL: rows enqueued after a timer flush of an empty queue are still written', async () => {
	const { box, query } = countingQuery()
	const { log } = quietLog()
	const sl = new SignalLog({ query, log, flushMs: 20 })
	sl.enqueue(rowN(1))
	await new Promise((r) => setTimeout(r, 70)) // row 1 written, then ≥ 1 tick on an empty queue
	assert.equal(box.inserted, 1)
	sl.enqueue(rowN(2))
	sl.enqueue(rowN(3))
	await new Promise((r) => setTimeout(r, 70))
	assert.equal(box.inserted, 3, 'rows after the empty tick were never written')
	assert.equal(sl.pending, 0)
	await sl.shutdown(100)
})

test('STALL: flush() on an empty queue does not wedge later flushes', async () => {
	const { box, query } = countingQuery()
	const { log } = quietLog()
	const sl = new SignalLog({ query, log, flushMs: 60_000 })
	await sl.flush() // empty
	sl.enqueue(rowN(1))
	await sl.flush()
	assert.equal(box.inserted, 1)
	await sl.shutdown(100)
})

test('STALL: shutdown after an empty flush still writes pending rows', async () => {
	const { box, query } = countingQuery()
	const { log } = quietLog()
	const sl = new SignalLog({ query, log, flushMs: 60_000 })
	await sl.flush() // empty
	sl.enqueue(rowN(1))
	sl.enqueue(rowN(2))
	await sl.shutdown(500)
	assert.equal(box.inserted, 2)
	assert.equal(sl.pending, 0)
})
