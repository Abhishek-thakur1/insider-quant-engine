// ============================================================
// tests/publicData.test.ts — the dashboard's read-only API additions (src/api/publicData.ts)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { SIGNAL_COLUMNS, SIGNALS_LIMIT, coarseHealth, mapSignalRow, signalsQuery } from '../src/api/publicData.js'

const IST = 330 * 60_000
const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00Z`) - IST

test('SIGNALS QUERY: SELECT only, parameterised date, capped, no capital or trigger fields', () => {
	const q = signalsQuery('2026-10-22')!
	assert.match(q.sql, /^SELECT /)
	assert.doesNotMatch(q.sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i)
	assert.deepEqual(q.params, ['2026-10-22'])
	assert.match(q.sql, new RegExp(`LIMIT ${SIGNALS_LIMIT}$`))
	for (const c of ['trigger', 'qty', 'actual_size', 'capital_outcome', 'breakdown']) assert.ok(!(SIGNAL_COLUMNS as readonly string[]).includes(c), `${c} not exposed`)
	assert.equal(signalsQuery("2026-10-22'; DROP TABLE signals; --"), null, 'bad date rejected, never interpolated')
	assert.equal(signalsQuery(''), null)
})

test('SIGNALS ROW: maps the AEQUS 11:06 fire (real row shape) to the public shape', () => {
	const r = mapSignalRow({
		signal_id: 'u1', fired_at: '2026-10-22T05:36:28.166Z', trade_date: '2026-10-22', symbol: 'NSE:AEQUS-EQ', detector: 'Volatility_Contraction_V2',
		direction: 'LONG', score: '88', score_threshold: '78', filter_result: 'PASSED', rejected_at: null, regime_class: 'MOMENTUM', market_regime: 'trending',
		alert_sent: true, alert_suppressed_reason: null, data_quality: [], trade_id: 1592,
	})
	assert.deepEqual(r, {
		id: 'u1', firedAt: Date.parse('2026-10-22T05:36:28.166Z'), symbol: 'NSE:AEQUS-EQ', detector: 'Volatility_Contraction_V2', side: 'LONG', score: 88, threshold: 78,
		outcome: 'PASSED', rejectedAt: null, regimeClass: 'MOMENTUM', marketRegime: 'trending', alerted: true, suppressedReason: null, dataQuality: [], tradeId: 1592,
	})
})

test('HEALTH: closed outside 09:15–15:30, weekend and holiday; live with a recent candle; stale without', () => {
	const hol = new Set(['2026-11-10'])
	const base = { holidays: hol, stocksSeenToday: 25 }
	assert.equal(coarseHealth({ ...base, nowMs: at('2026-10-23', '09:10'), lastBarStartMs: null }).status, 'closed')
	assert.equal(coarseHealth({ ...base, nowMs: at('2026-10-24', '11:00'), lastBarStartMs: null }).status, 'closed', 'Saturday')
	assert.equal(coarseHealth({ ...base, nowMs: at('2026-11-10', '11:00'), lastBarStartMs: null }).status, 'holiday')
	assert.equal(coarseHealth({ ...base, nowMs: at('2026-10-23', '11:00'), lastBarStartMs: at('2026-10-23', '10:50') }).status, 'live', 'candle ended 10:55')
	assert.equal(coarseHealth({ ...base, nowMs: at('2026-10-23', '11:00'), lastBarStartMs: at('2026-10-23', '10:40') }).status, 'stale', 'candle ended 10:45')
	assert.equal(coarseHealth({ ...base, nowMs: at('2026-10-23', '11:00'), lastBarStartMs: null }).status, 'stale')
	assert.equal(coarseHealth({ ...base, nowMs: at('2026-10-23', '15:30'), lastBarStartMs: at('2026-10-23', '15:20') }).status, 'closed')
})

test('HEALTH: coarse fields only — no quota, monitor, restart or host details; ticks per 5 min not available yet', () => {
	const h = coarseHealth({ nowMs: at('2026-10-23', '11:00'), holidays: new Set(), lastBarStartMs: at('2026-10-23', '10:50'), stocksSeenToday: 25 })
	assert.deepEqual(Object.keys(h).sort(), ['asOf', 'lastIndexCandleAt', 'status', 'stocksSeenToday', 'ticksPer5m'])
	assert.equal(h.ticksPer5m, null)
	assert.equal(h.stocksSeenToday, 25)
})

test('WIRING: both routes are GET, read-only, and the API still never writes', () => {
	const src = fs.readFileSync('src/api/server.ts', 'utf8')
	assert.match(src, /fastify\.get\('\/api\/signals'/)
	assert.match(src, /fastify\.get\('\/api\/health'/)
	assert.doesNotMatch(src, /\b(INSERT INTO|UPDATE paper_trades|UPDATE signals|DELETE FROM)\b/)
	assert.doesNotMatch(src, /redisClient\.(set|del|hSet|lPush|incr|expire)\(/, 'API never writes Redis')
})
