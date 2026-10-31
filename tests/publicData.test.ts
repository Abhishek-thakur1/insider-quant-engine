// ============================================================
// tests/publicData.test.ts — the dashboard's read-only API additions (src/api/publicData.ts)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { SIGNAL_COLUMNS, SIGNALS_LIMIT, coarseHealth, isIsoDate, mapSignalRow, signalsQuery } from '../src/api/publicData.js'

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
	assert.equal(signalsQuery('2026-02-30'), null, 'right shape, impossible date: rejected before Postgres')
})

test('DATE VALIDATION (audit of 31 Oct): real calendar dates only; /api/trades/history answers 400 before any query', () => {
	for (const ok of ['2026-10-30', '2024-02-29', '2026-12-31']) assert.equal(isIsoDate(ok), true, ok)
	for (const bad of ['abc', '', '2026-2-3', '2026-13-01', '2026-02-29', '2026-04-31', '2026-10-30T00:00', "2026-10-30'--", undefined, 20261030])
		assert.equal(isIsoDate(bad), false, String(bad))
	const src = fs.readFileSync('src/api/server.ts', 'utf8')
	const route = src.slice(src.indexOf("fastify.get('/api/trades/history'"), src.indexOf("fastify.get('/api/live-pnl'"))
	const check = route.indexOf('!isIsoDate(date)')
	assert.ok(check > 0, 'history route validates the date')
	assert.ok(check < route.indexOf('pool.query'), 'before the query')
	assert.match(route.slice(check, check + 200), /reply\.code\(400\)/)
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

test('HISTORY / TODAY: read-only additions — recorded levels and data-quality flags, no new writes', () => {
	const src = fs.readFileSync('src/api/server.ts', 'utf8')
	assert.match(src, /target: r\.target_price !== null/)
	assert.match(src, /stopLoss: r\.stop_price !== null/)
	assert.equal((src.match(/dataQuality: Array\.isArray\(r\.data_quality\)/g) ?? []).length, 2, 'history and today')
	assert.match(src, /gated: r\.gated === true/)
	assert.doesNotMatch(src, /(INSERT INTO|UPDATE paper_trades|DELETE FROM)/)
})
