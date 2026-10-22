// ============================================================
// tests/bootCleanup.test.ts — day-aware boot cleanup (core/bootCleanup.ts)
//
// Owner, 2026-10-22: a same-day restart must not delete regime, bias, pnl:daily or
// vcp_history keys; a new-day boot clears only previous days' keys. The Oct 22 11:46
// watchdog restart wiped all four mid-session.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { BOOT_DAY_KEY, runBootCleanup, describeBootCleanup, type BootCleanupRedis } from '../src/core/bootCleanup.js'

// regimeDetector → config/env.ts exits without credentials: stub them (as regimeGate.test.ts does)
// so this file also passes on a fresh clone with no .env.
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHANNEL_ID ??= '-1000000000000'
process.env.FYERS_APP_ID ??= 'TEST-APP-ID'
process.env.FYERS_SECRET_ID ??= 'test-secret'
process.env.FYERS_REDIRECT_URI ??= 'http://localhost:3000/callback'
const { regimeReturnsSnapshot, restoreRegimeReturns, resetRegimeState } = await import('../src/utils/regimeDetector.js')

const fakeRedis = (initial: Record<string, string>) => {
	const kv = new Map(Object.entries(initial))
	const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
	const r: BootCleanupRedis & { kv: Map<string, string> } = {
		kv,
		get: async (k) => kv.get(k) ?? null,
		set: async (k, v) => void kv.set(k, v),
		del: async (ks) => ks.filter((k) => kv.delete(k)).length,
		keys: async (p) => [...kv.keys()].filter((k) => glob(p).test(k)),
	}
	return r
}

// Everything a session leaves in Redis, today's or yesterday's.
const SESSION_STATE = {
	'market:nifty:bias': 'bearish',
	'regime:nifty:returns_1min': '[list]',
	'regime:nifty:current': '{"regime":"trending"}',
	'pnl:daily': '-123.5',
	'v2:vcp_history:NSE:AEQUS-EQ': '[6 candles]',
	'v2:vcp_history:NSE:JSLL-EQ': '[6 candles]',
}
// Never touched by the cleanup, on any boot.
const UNTOUCHED = {
	'cooldown:v2:momentum:NSE:AEQUS-EQ': 'true',
	'v2:cooldown:vcp:NSE:AEQUS-EQ': 'true',
	'v2:session_open:NSE:AEQUS-EQ': '245.1',
	'alert:sent:2026-10-22:Stock Momentum Breakout:NSE:AEQUS-EQ': '1',
	'alert:count:2026-10-22': '3',
	'trades:open': '{hash}',
	'jsfilter:decisions': '[list]',
	'jsfilter:stats:2026-10-22': '{hash}',
	'vwap:NSE:AEQUS-EQ:2026-10-22': '{state}',
	'ema_shadow:nifty:bars5': '[list]',
	'fyers:quota:2026-10-22': '{hash}',
	'engine:restarts:2026-10-22': '1',
}

test('SAME-DAY RESTART: regime, bias, pnl:daily and every VCP history are kept', async () => {
	const r = fakeRedis({ ...SESSION_STATE, ...UNTOUCHED, 'jsfilter:stats': 'legacy', [BOOT_DAY_KEY]: '2026-10-22' })
	const res = await runBootCleanup(r, '2026-10-22')
	assert.equal(res.sameDay, true)
	for (const k of Object.keys(SESSION_STATE)) assert.ok(r.kv.has(k), `kept ${k}`)
	for (const k of Object.keys(UNTOUCHED)) assert.ok(r.kv.has(k), `untouched ${k}`)
	assert.deepEqual(res.deleted, ['jsfilter:stats'], 'only the legacy un-dated stats hash')
	assert.equal(r.kv.has('jsfilter:stats'), false)
	assert.equal(r.kv.get(BOOT_DAY_KEY), '2026-10-22')
})

test("NEW-DAY BOOT: previous days' regime, bias, pnl:daily and ALL VCP histories (incl. symbols off the watchlist) are cleared", async () => {
	const r = fakeRedis({ ...SESSION_STATE, ...UNTOUCHED, 'v2:vcp_history:NSE:DROPPED-EQ': '[stale]', [BOOT_DAY_KEY]: '2026-10-22' })
	const res = await runBootCleanup(r, '2026-10-23')
	assert.equal(res.sameDay, false)
	assert.equal(res.previousBootDay, '2026-10-22')
	for (const k of Object.keys(SESSION_STATE)) assert.equal(r.kv.has(k), false, `cleared ${k}`)
	assert.equal(r.kv.has('v2:vcp_history:NSE:DROPPED-EQ'), false, 'stale history of a symbol no longer subscribed')
	for (const k of Object.keys(UNTOUCHED)) assert.ok(r.kv.has(k), `untouched ${k}`)
	assert.equal(r.kv.get(BOOT_DAY_KEY), '2026-10-23', 'marker advanced: the next restart today is same-day')
	assert.equal((await runBootCleanup(r, '2026-10-23')).sameDay, true)
})

test('NO MARKER (first boot after this deploy) is a new day: same cleanup as before the change', async () => {
	const r = fakeRedis({ ...SESSION_STATE })
	const res = await runBootCleanup(r, '2026-10-23')
	assert.equal(res.sameDay, false)
	assert.equal(res.previousBootDay, null)
	for (const k of Object.keys(SESSION_STATE)) assert.equal(r.kv.has(k), false)
})

test('REGIME RESTORE: the Redis mirror (newest first) is re-loaded oldest→newest, capped at the 20-return window', async () => {
	resetRegimeState()
	// 25 returns, newest first as LPUSH stores them: all tiny (|r| ≤ 0.05) → one entropy bin → H = 0
	const mirror = Array.from({ length: 25 }, (_, i) => (i % 2 ? '0.0100' : '-0.0100'))
	assert.equal(restoreRegimeReturns(mirror), 20)
	restoreRegimeReturns(['0.3', '0.2', '0.1'])
	assert.deepEqual(regimeReturnsSnapshot(), [0.1, 0.2, 0.3], 'oldest first, as pushNiftyReturn builds it')
	assert.equal(restoreRegimeReturns(['0.1', 'nope', '0.2']), 2, 'non-numbers skipped')
	assert.equal(restoreRegimeReturns([]), 0)
	resetRegimeState()
})

test('BOOT LINE says which case ran', () => {
	assert.match(describeBootCleanup({ sameDay: true, previousBootDay: '2026-10-22', deleted: ['jsfilter:stats'] }, '2026-10-22', 20), /same-day restart \(2026-10-22\) — kept regime \(20 returns restored\)/)
	assert.match(describeBootCleanup({ sameDay: false, previousBootDay: '2026-10-22', deleted: ['a', 'b'] }, '2026-10-23', 0), /new day 2026-10-23 \(last boot 2026-10-22\) — cleared 2 keys/)
})

test('WIRING: websocket.ts runs the day-aware cleanup and no longer deletes session keys itself', () => {
	const src = fs.readFileSync('src/ingestion/websocket.ts', 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/^\/\/.*$/gm, '')
	assert.match(src, /runBootCleanup\(/)
	assert.match(src, /restoreRegimeReturns\(/)
	for (const k of ['market:nifty:bias', 'regime:nifty:returns_1min', 'regime:nifty:current', 'pnl:daily', 'v2:vcp_history'])
		assert.doesNotMatch(src, new RegExp(`redisClient\\.del\\([^)]*${k.replace(/[.:]/g, '\\$&')}`), `websocket.ts deletes ${k} directly`)
})
