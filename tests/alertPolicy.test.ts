// ============================================================
// tests/alertPolicy.test.ts — what may reach the Telegram channel
//
// Exercises the real src/workers/alertPolicy.ts (the functions telegramWorker
// calls) against an in-memory store with Redis SET NX / INCR semantics.
// alertPolicy imports nothing that touches env, so no dummy credentials needed.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
	buildEquityMessage,
	computeSizing,
	dispatchBlockReason,
	parseMaxAlertsPerDay,
	releaseAlertSlot,
	reserveAlertSlot,
	DEFAULT_MAX_ALERTS_PER_DAY,
	type AlertStore,
} from '../src/workers/alertPolicy.js'
import { isMarketHours, getISTDateString } from '../src/utils/marketHours.js'

// Minimal Redis stand-in. It persists across "restarts" exactly as Redis does:
// the policy holds no state of its own, so a new process sees the same keys.
const makeStore = (): AlertStore & { data: Map<string, string> } => {
	const data = new Map<string, string>()
	return {
		data,
		async set(key, value, opts) {
			if (opts.NX && data.has(key)) return null
			data.set(key, value)
			return 'OK'
		},
		async incr(key) {
			const n = Number(data.get(key) ?? 0) + 1
			data.set(key, String(n))
			return n
		},
		async decr(key) {
			const n = Number(data.get(key) ?? 0) - 1
			data.set(key, String(n))
			return n
		},
		async expire() {
			return 1
		},
		async del(key) {
			return data.delete(key) ? 1 : 0
		},
	}
}

const DAY = '2026-10-06'
const SMB = 'Stock Momentum Breakout'

// ── Capital constraint never produces channel noise ─────────────────────────

test('REDUCE: trade is reduced, still alertable, and the message carries the reduced qty with no capital wording', () => {
	// ₹1L base, ₹95k already deployed → ₹5k headroom on a ₹500 stock
	const s = computeSizing({ entry: 500, stopLoss: 495, capitalBase: 100000, currentNotional: 95000, behavior: 'REDUCE' })
	assert.equal(s.qty, 20) // min(1000/5 = 200, 10000/500 = 20)
	assert.equal(s.capitalGated, true)
	assert.equal(s.skip, false)
	assert.equal(s.actualSize, 10) // 5000 / 500

	assert.equal(dispatchBlockReason({ gated: true, skip: s.skip, actualSize: s.actualSize, isOption: false }), null)

	const msg = buildEquityMessage({
		symbol: 'NSE:TEST-EQ', side: 'LONG', trigger: 'setup', volumeSpikeRatio: 3,
		entry: 500, stopLoss: 495, target1: 507.5, target2: 512.5,
		qty: s.actualSize, durationClass: 'INTRADAY', scoreLines: '',
	})
	assert.match(msg, /\*Qty:\* 10\b/)
	assert.doesNotMatch(msg, /capital|cap\b|reduced|skipped/i)
})

test('capital exhausted: full skip is recorded but never alerted', () => {
	const s = computeSizing({ entry: 500, stopLoss: 495, capitalBase: 100000, currentNotional: 99900, behavior: 'REDUCE' })
	assert.equal(s.skip, true)
	assert.equal(s.actualSize, 0)
	assert.equal(dispatchBlockReason({ gated: true, skip: s.skip, actualSize: s.actualSize, isOption: false }), 'CAPITAL_SKIP')
})

test('SKIP behaviour: over-cap trade is skipped silently', () => {
	const s = computeSizing({ entry: 500, stopLoss: 495, capitalBase: 100000, currentNotional: 95000, behavior: 'SKIP' })
	assert.equal(s.skip, true)
	assert.equal(dispatchBlockReason({ gated: true, skip: s.skip, actualSize: s.actualSize, isOption: false }), 'CAPITAL_SKIP')
})

test('within capital: full size, not capital-gated', () => {
	const s = computeSizing({ entry: 500, stopLoss: 495, capitalBase: 100000, currentNotional: 0, behavior: 'REDUCE' })
	assert.deepEqual(s, { qty: 20, actualSize: 20, capitalGated: false, skip: false })
})

test('the worker source no longer contains any capital-constraint Telegram text', () => {
	const live = fs
		.readFileSync(new URL('../src/workers/telegramWorker.ts', import.meta.url), 'utf8')
		.split(/\r?\n/)
		.filter((l) => !l.trim().startsWith('//'))
		.join('\n')
	assert.doesNotMatch(live, /Size reduced to fit|Trade Skipped|capital constraint \(/i)
})

// ── Gated-only ──────────────────────────────────────────────────────────────

test('ungated signals are never alerted (equity or option)', () => {
	assert.equal(dispatchBlockReason({ gated: false, skip: false, actualSize: 20, isOption: false }), 'NOT_GATED')
	assert.equal(dispatchBlockReason({ gated: false, skip: false, actualSize: 0, isOption: true }), 'NOT_GATED')
})

test('gated Nifty option alert is not killed by its meaningless 0 paper size', () => {
	// Index-level entry (~25 000) > ₹10k single-name cap → qty 0
	const s = computeSizing({ entry: 25000, stopLoss: 24970, capitalBase: 100000, currentNotional: 0, behavior: 'REDUCE' })
	assert.equal(s.actualSize, 0)
	assert.equal(dispatchBlockReason({ gated: true, skip: s.skip, actualSize: s.actualSize, isOption: true }), null)
})

test('gated equity with zero size is not alerted', () => {
	assert.equal(dispatchBlockReason({ gated: true, skip: false, actualSize: 0, isOption: false }), 'ZERO_SIZE')
})

// ── Dedup: one alert per detector + symbol per IST day ──────────────────────

test('second signal for the same detector+symbol on the same day is a duplicate', async () => {
	const store = makeStore()
	const o = { day: DAY, detector: SMB, symbol: 'NSE:TEST-EQ', maxPerDay: 20 }
	assert.deepEqual(await reserveAlertSlot(store, o), { action: 'SEND' })
	assert.deepEqual(await reserveAlertSlot(store, o), { action: 'DUPLICATE' })
})

test('dedup survives an engine restart (state lives in the store, not the process)', async () => {
	const redis = makeStore()
	const o = { day: DAY, detector: SMB, symbol: 'NSE:TEST-EQ', maxPerDay: 20 }
	await reserveAlertSlot(redis, o)
	// "restart": nothing in-process is reused; only the store persists
	const { reserveAlertSlot: freshReserve } = await import('../src/workers/alertPolicy.js?restart' as string)
	assert.deepEqual(await freshReserve(redis, o), { action: 'DUPLICATE' })
})

test('different detector, different symbol, or a new day is not a duplicate', async () => {
	const store = makeStore()
	const base = { day: DAY, detector: SMB, symbol: 'NSE:TEST-EQ', maxPerDay: 20 }
	await reserveAlertSlot(store, base)
	assert.equal((await reserveAlertSlot(store, { ...base, detector: 'Volatility_Contraction_V2' })).action, 'SEND')
	assert.equal((await reserveAlertSlot(store, { ...base, symbol: 'NSE:OTHER-EQ' })).action, 'SEND')
	assert.equal((await reserveAlertSlot(store, { ...base, day: '2026-10-07' })).action, 'SEND')
})

test('a Nifty detector cannot re-alert by drifting across strikes', async () => {
	const store = makeStore()
	const o = { day: DAY, detector: 'Nifty Trend Pulse', maxPerDay: 20 }
	assert.equal((await reserveAlertSlot(store, { ...o, symbol: 'NIFTY 25000 CE' })).action, 'SEND')
	assert.equal((await reserveAlertSlot(store, { ...o, symbol: 'NIFTY 25050 CE' })).action, 'DUPLICATE')
	assert.equal((await reserveAlertSlot(store, { ...o, symbol: 'NIFTY 24950 PE' })).action, 'DUPLICATE')
})

test('a failed send releases the slot so the setup can still alert', async () => {
	const store = makeStore()
	const o = { day: DAY, detector: SMB, symbol: 'NSE:TEST-EQ' }
	await reserveAlertSlot(store, { ...o, maxPerDay: 20 })
	await releaseAlertSlot(store, o)
	assert.equal((await reserveAlertSlot(store, { ...o, maxPerDay: 20 })).action, 'SEND')
	assert.equal(store.data.get(`alert:count:${DAY}`), '1')
})

// ── Daily cap ───────────────────────────────────────────────────────────────

test('daily cap: alerts beyond the cap are suppressed, with exactly one cap notice', async () => {
	const store = makeStore()
	const r = async (sym: string) => reserveAlertSlot(store, { day: DAY, detector: SMB, symbol: sym, maxPerDay: 2 })
	assert.deepEqual(await r('A'), { action: 'SEND' })
	assert.deepEqual(await r('B'), { action: 'SEND' })
	assert.deepEqual(await r('C'), { action: 'CAP_REACHED', notifyCap: true })
	assert.deepEqual(await r('D'), { action: 'CAP_REACHED', notifyCap: false })
	assert.deepEqual(await r('E'), { action: 'CAP_REACHED', notifyCap: false })
})

test('cap env parsing falls back to the documented default on bad input', () => {
	assert.equal(parseMaxAlertsPerDay(undefined), DEFAULT_MAX_ALERTS_PER_DAY)
	assert.equal(parseMaxAlertsPerDay('abc'), DEFAULT_MAX_ALERTS_PER_DAY)
	assert.equal(parseMaxAlertsPerDay('0'), DEFAULT_MAX_ALERTS_PER_DAY)
	assert.equal(parseMaxAlertsPerDay('-3'), DEFAULT_MAX_ALERTS_PER_DAY)
	assert.equal(parseMaxAlertsPerDay('12'), 12)
})

// ── Watchdog window ─────────────────────────────────────────────────────────

const ist = (hh: number, mm: number) => Date.UTC(2026, 9, 6, hh, mm) - 5.5 * 3600 * 1000

test('watchdog only treats silence as a dead socket during 09:15–15:30 IST', () => {
	assert.equal(isMarketHours(ist(9, 0)), false) // engine boot
	assert.equal(isMarketHours(ist(9, 10)), false) // pre-open lull
	assert.equal(isMarketHours(ist(9, 15)), true)
	assert.equal(isMarketHours(ist(15, 29)), true)
	assert.equal(isMarketHours(ist(15, 30)), false)
})

test('IST day boundary: 23:59 IST and 00:01 IST are different alert days', () => {
	assert.equal(getISTDateString(ist(23, 59)), '2026-10-06')
	assert.equal(getISTDateString(ist(24, 1)), '2026-10-07')
})
