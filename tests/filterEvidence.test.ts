// ============================================================
// tests/filterEvidence.test.ts — every rejection leaves evidence that survives restarts
//
// Exercises the real rejectionLogLine / jsStatsKey from janeStreetFilter.ts and
// checks the engine boot no longer wipes jsfilter:decisions. Logging only: the
// filter's decisions are not touched (see regimeGate.test.ts for those).
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

process.env.TELEGRAM_BOT_TOKEN ??= 'test'
process.env.TELEGRAM_CHANNEL_ID ??= 'test'
process.env.FYERS_APP_ID ??= 'test'
process.env.FYERS_SECRET_ID ??= 'test'

const { rejectionLogLine, jsStatsKey } = await import('../src/detectors/janeStreetFilter.js')

const payload = { symbol: 'NIFTY 23100 PE', side: 'SHORT' as const }
const base = { posterior: 0.627, ev: 11.2 }
const parts = [
	{ component: 'REGIME', points: 12, maxPoints: 12, reason: 'Universal detector' },
	{ component: 'STRUCTURE', points: 10, maxPoints: 20, reason: 'insufficient history' },
	{ component: 'BAYESIAN', points: 15.67, maxPoints: 25, reason: 'P=63%' },
]

test('score rejection (the Oct 19 case) names the gate, the threshold and every component', () => {
	const line = rejectionLogLine(payload, { ...base, score: 63, breakdown: parts }, 'Nifty VWAP Reclaim')
	assert.match(line, /^\[JSFilter\] ✗ NIFTY 23100 PE SHORT \[Nifty VWAP Reclaim\] rejected at SCORE — score 63 < 78/)
	assert.match(line, /REGIME=12\.0\/12 STRUCTURE=10\.0\/20 BAYESIAN=15\.7\/25/)
	assert.match(line, /P=0\.63 EV=11\.2/)
})

test('hard-gate rejections carry the gate reason', () => {
	const ev = rejectionLogLine(
		payload,
		{ ...base, ev: -11.3, score: 48, rejectedAt: 'EV', breakdown: [...parts, { component: 'EV', points: 0, maxPoints: 10, reason: 'R:R=1.50 (parsed) → NEGATIVE EV ₹-11.3' }] },
		'Nifty VWAP Reclaim',
	)
	assert.match(ev, /rejected at EV — R:R=1\.50 \(parsed\) → NEGATIVE EV ₹-11\.3/)
	const regime = rejectionLogLine(
		payload,
		{ ...base, score: 0, rejectedAt: 'REGIME', breakdown: [{ component: 'REGIME', points: 0, maxPoints: 12, reason: 'Ranging regime — MOMENTUM detector suppressed' }] },
		'Nifty Trend Pulse',
	)
	assert.match(regime, /rejected at REGIME — Ranging regime — MOMENTUM detector suppressed/)
})

test('stats are bucketed per IST day (a restart no longer resets them)', () => {
	assert.equal(jsStatsKey(Date.parse('2026-10-19T04:26:30Z')), 'jsfilter:stats:2026-10-19') // 09:56 IST
	assert.equal(jsStatsKey(Date.parse('2026-10-19T18:31:00Z')), 'jsfilter:stats:2026-10-20') // 00:01 IST next day
})

test('engine boot no longer deletes jsfilter:decisions', () => {
	const ws = fs
		.readFileSync(new URL('../src/ingestion/websocket.ts', import.meta.url), 'utf8')
		.split(/\r?\n/)
		.filter((l) => !l.trim().startsWith('//'))
		.join('\n')
	assert.doesNotMatch(ws, /del\('jsfilter:decisions'\)/)
})

test('every rejection is logged and stats get a TTL (source check of persistDecision)', () => {
	const src = fs.readFileSync(new URL('../src/detectors/janeStreetFilter.ts', import.meta.url), 'utf8')
	assert.match(src, /if \(!decision\.passed\) console\.log\(rejectionLogLine\(/)
	assert.match(src, /\.expire\(statsKey, JS_STATS_TTL_SECS\)/)
	assert.match(src, /\.lTrim\(JS_LOG_KEY, 0, JS_LOG_MAX - 1\)/)
})
