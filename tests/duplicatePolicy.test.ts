// ============================================================
// tests/duplicatePolicy.test.ts — one alert per symbol + side (owner, 2026-10-22)
//
// Oct 22 11:06: Stock Momentum Breakout (85) and VCP (88) fired on AEQUS LONG in the
// same minute, ran concurrently (websocket.ts dispatches detectors with Promise.all),
// and both were alerted and both paper rows counted. These run the REAL
// runAlertPipeline twice against SHARED fakes (alert store, claim store with the
// production Lua semantics, a tracker whose positions can be open or closed).
// Decisions: cooldown = while the first position is open, else 60 minutes; nothing
// sent for a duplicate (no message editing); second signals row DUPLICATE; second
// paper row flagged duplicate_signal and excluded from pnl:daily and the API stats.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { runAlertPipeline, type PipelineDeps } from '../src/workers/alertPipeline.js'
import { claimSymbolSide, symbolSideKeys, SYMBOL_SIDE_COOLDOWN_MS, type AlertStore } from '../src/workers/alertPolicy.js'
import { buildSignalRow, newSignalDraft, type SignalDraft } from '../src/db/signalRecord.js'
import type { OpenPosition } from '../src/core/positionTracker.js'
import type { AlertPayload } from '../src/workers/telegramWorker.js'
import { DAY, NOW, MAX, decision, equity, option, makeClaimStore } from './helpers/workerScenarios.js'

const MIN = 60_000

const world = (opts: { clockStepMs?: number; incrThrows?: boolean } = {}) => {
	let now = NOW
	const kv = new Map<string, string>()
	const open = new Map<string, OpenPosition>()
	const registered: OpenPosition[] = []
	const sends: string[] = []
	let failSends = false
	const store: AlertStore = {
		set: async (k, v, o) => (o.NX && kv.has(k) ? null : (kv.set(k, v), 'OK')),
		incr: async (k) => {
			if (opts.incrThrows) throw new Error('redis incr failed')
			const n = Number(kv.get(k) ?? 0) + 1
			kv.set(k, String(n))
			return n
		},
		decr: async (k) => {
			const n = Number(kv.get(k) ?? 0) - 1
			kv.set(k, String(n))
			return n
		},
		expire: async () => 1,
		del: async (k) => (kv.delete(k) ? 1 : 0),
	}
	const claims = makeClaimStore()
	const deps: PipelineDeps = {
		runFilter: async () => decision(),
		getTracker: async () => ({
			getCurrentNotional: () => 0,
			registerTrade: async (pos) => {
				registered.push(pos)
				open.set(pos.id, pos)
				return registered.length
			},
			getOpenPositions: () => [...open.values()],
		}),
		getAlertStore: async () => store,
		getClaimStore: async () => claims,
		sendChannel: async (text) => {
			if (failSends) throw new Error('telegram 400')
			sends.push(text)
		},
		sendAdmin: async () => {},
		now: () => (opts.clockStepMs ? (now += opts.clockStepMs) : now),
		config: { shadowMode: false, maxAlertsPerDay: MAX, capitalBase: 100000, capitalBehavior: 'REDUCE', hasAdmin: false },
	}
	const fire = async (p: AlertPayload) => {
		const draft = newSignalDraft(p, { signalId: crypto.randomUUID(), firedAt: now, shadowMode: false })
		const orig = { log: console.log, warn: console.warn, error: console.error }
		console.log = console.warn = console.error = () => {}
		try {
			await runAlertPipeline(p, deps, draft)
		} finally {
			Object.assign(console, orig)
		}
		return buildSignalRow(draft as SignalDraft, { threshold: 78, promotionSource: 'SCREENER' })
	}
	return {
		fire,
		sends,
		registered,
		kv,
		claims,
		advance: (ms: number) => void (now += ms),
		closeAll: () => open.clear(),
		failSends: (b: boolean) => void (failSends = b),
		incrThrows: (b: boolean) => void (opts.incrThrows = b),
	}
}

const smb: AlertPayload = { ...equity, symbol: 'NSE:AEQUS-EQ', detectorName: 'Stock Momentum Breakout' }
const vcp: AlertPayload = { ...equity, symbol: 'NSE:AEQUS-EQ', detectorName: 'Volatility_Contraction_V2' }

test('CONCURRENT PAIR (the AEQUS case): exactly one alert; second signals row DUPLICATE; second paper row flagged; one cap slot', async () => {
	const w = world()
	const [a, b] = await Promise.all([w.fire(smb), w.fire(vcp)])
	assert.equal(w.sends.length, 1, 'one Telegram alert')
	const rows = [a, b]
	const sent = rows.filter((r) => r.alert_sent)
	const dup = rows.filter((r) => r.alert_suppressed_reason === 'DUPLICATE')
	assert.equal(sent.length, 1)
	assert.equal(dup.length, 1)
	assert.equal(w.registered.length, 2, 'both still recorded as paper trades')
	assert.deepEqual(w.registered.map((p) => p.dataQuality ?? []).sort(), [[], ['duplicate_signal']])
	assert.ok((dup[0]!.data_quality as string[]).includes('duplicate_signal'), 'signals row flagged too')
	assert.ok(!(sent[0]!.data_quality as string[]).includes('duplicate_signal'))
	assert.equal(w.kv.get(`alert:count:${DAY}`), '1', 'the duplicate used no cap slot')
	assert.equal([...w.kv.keys()].filter((k) => k.startsWith('alert:sent:')).length, 1, 'no per-detector slot taken by the duplicate')
})

test('OPPOSITE SIDE never collides: LONG then SHORT on the same symbol both alert, no flags', async () => {
	const w = world()
	await w.fire(smb)
	const r = await w.fire({ ...vcp, side: 'SHORT', price: 497, trigger: 'x | SL ₹503 | T1 ₹490' })
	assert.equal(w.sends.length, 2)
	assert.equal(r.alert_sent, true)
	assert.ok(w.registered.every((p) => !p.dataQuality))
})

test('COOLDOWN, first position still OPEN: a fire 3 hours later is still a duplicate', async () => {
	const w = world()
	await w.fire(smb)
	w.advance(180 * MIN)
	const r = await w.fire(vcp)
	assert.equal(w.sends.length, 1)
	assert.equal(r.alert_suppressed_reason, 'DUPLICATE')
	assert.deepEqual(w.registered[1]!.dataQuality, ['duplicate_signal'])
})

test('COOLDOWN, first position CLOSED: duplicate inside 60 min, a fresh alert after', async () => {
	const w = world()
	await w.fire(smb)
	w.closeAll()
	w.advance(59 * MIN)
	assert.equal((await w.fire(vcp)).alert_suppressed_reason, 'DUPLICATE')
	w.closeAll()
	w.advance(2 * MIN) // 61 min after the first; the 59-min duplicate never alerted
	const r = await w.fire({ ...vcp, detectorName: 'Third Detector' })
	assert.equal(r.alert_sent, true)
	assert.equal(w.sends.length, 2)
	assert.equal(w.registered[2]!.dataQuality, undefined, 'a fresh paper row, not flagged')
	assert.equal(SYMBOL_SIDE_COOLDOWN_MS, 60 * MIN)
})

test('NIFTY OPTIONS share one key per side (dedupSymbol → NIFTY): 22650 CE then 22700 CE is a duplicate', async () => {
	const w = world()
	await w.fire({ ...option, symbol: 'NIFTY 22650 CE', detectorName: 'Nifty VWAP Reclaim' })
	const r = await w.fire({ ...option, symbol: 'NIFTY 22700 CE', detectorName: 'Nifty Trend Pulse' })
	assert.equal(r.alert_suppressed_reason, 'DUPLICATE')
	assert.ok(w.claims.data.has(`alert:sym:${DAY}:LONG:NIFTY`))
})

test('SEND FAILURE gives the alert claim back: the next fire on that symbol + side can still alert', async () => {
	const w = world()
	w.failSends(true)
	const a = await w.fire(smb)
	assert.equal(a.alert_suppressed_reason, 'SEND_FAILED')
	w.failSends(false)
	const b = await w.fire(vcp)
	assert.equal(b.alert_sent, true, 'not blocked by a claim that produced no alert')
	assert.deepEqual(w.registered[1]!.dataQuality, ['duplicate_signal'], 'the paper side still counts the first position once')
})

test('STALE HOLDER replaced atomically: two concurrent fires after the window → exactly one wins', async () => {
	const claims = makeClaimStore()
	const key = symbolSideKeys(DAY, 'LONG', 'NSE:X-EQ').alert
	await claims.set(key, JSON.stringify({ ts: NOW, positionId: 'old' }), { NX: true, EX: 100 })
	const later = NOW + 61 * MIN
	const results = await Promise.all([
		claimSymbolSide(claims, key, { ts: later, positionId: 'p1' }, () => false),
		claimSymbolSide(claims, key, { ts: later, positionId: 'p2' }, () => false),
	])
	assert.equal(results.filter((r) => r.first).length, 1)
})

test('EXCLUSIONS: pnl:daily skips duplicate_signal rows; the API excludes them from open, history and heatmap', () => {
	const tracker = fs.readFileSync('src/core/positionTracker.ts', 'utf8')
	assert.match(tracker, /if \(!pos\.dataQuality\?\.includes\('duplicate_signal'\)\) pipeline\.incrByFloat\('pnl:daily'/)
	const api = fs.readFileSync('src/api/server.ts', 'utf8')
	assert.match(api, /const NOT_DUPLICATE = ` AND NOT \('duplicate_signal' = ANY\(COALESCE\(data_quality, '\{\}'\)\)\)`/)
	assert.equal((api.match(/NOT_DUPLICATE/g) ?? []).length, 4, 'defined once, used by /api/today, /api/trades/history, /api/trades/heatmap')
})

// ── review of PR #22 (independent session, 2026-10-22) ──

test('REVIEW 1 (blocking): Nifty OPTION positions never close in-session, so options use only the 60-min window — a CE alert does not suppress CE alerts all day', async () => {
	const w = world()
	await w.fire({ ...option, symbol: 'NIFTY 22650 CE', detectorName: 'Nifty Trend Pulse' }) // position stays "open" forever (tracker never closes it)
	w.advance(30 * MIN)
	assert.equal((await w.fire({ ...option, symbol: 'NIFTY 22700 CE', detectorName: 'Nifty VWAP Reclaim' })).alert_suppressed_reason, 'DUPLICATE', 'inside 60 min: duplicate')
	w.advance(31 * MIN) // 61 min after the first alert, first "position" still open
	const r = await w.fire({ ...option, symbol: 'NIFTY 22750 CE', detectorName: 'Delta Hedging Pressure (Gamma Squeeze)' })
	assert.equal(r.alert_sent, true, 'after 60 min an option alert goes out even though the first option position never closed')
	// equities keep the "while open" rule
	const e = world()
	await e.fire(smb)
	e.advance(61 * MIN)
	assert.equal((await e.fire(vcp)).alert_suppressed_reason, 'DUPLICATE')
})

test('REVIEW 2: a fire its own detector already alerted today does not take the symbol claim, so a concurrent legitimate fire still alerts', async () => {
	const w = world()
	await w.fire(vcp) // VCP alerts AEQUS LONG at 10:30 (alert:sent for VCP is set for the day)
	w.closeAll()
	w.advance(90 * MIN)
	const [a, b] = await Promise.all([w.fire(vcp), w.fire(smb)]) // VCP again (per-detector duplicate) + Momentum, same minute
	assert.equal(a.alert_suppressed_reason, 'DUPLICATE', "VCP's own per-day duplicate")
	assert.equal(b.alert_sent, true, 'Momentum was legitimate and is sent')
	assert.equal(w.sends.length, 2)
})

test('REVIEW 3: one clock read — with a clock that moves on every read, a failed send still gives the claim back', async () => {
	const w = world({ clockStepMs: 1 })
	w.failSends(true)
	assert.equal((await w.fire(smb)).alert_suppressed_reason, 'SEND_FAILED')
	w.failSends(false)
	assert.equal((await w.fire(vcp)).alert_sent, true, 'claim was given back exactly')
})

test('REVIEW 4: an unexpected error after the claim (reserveAlertSlot throws) gives the claim back', async () => {
	const w = world({ incrThrows: true })
	assert.equal((await w.fire(smb)).alert_suppressed_reason, 'WORKER_ERROR')
	w.incrThrows(false)
	assert.equal((await w.fire(vcp)).alert_sent, true, 'not blocked by the claim of a fire that errored')
})
