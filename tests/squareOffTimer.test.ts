// ============================================================
// tests/squareOffTimer.test.ts — the 15:15 TIME exit no longer waits for a traded tick.
//
// On 28 Oct the feed thinned after 15:15 and six INTRADAY positions closed at about 15:28, at the
// 15:28 price. positionTracker now notes the last price of every feed message and, from 15:15 IST,
// a timer (squareOffSweep) closes open INTRADAY positions at that last known price through the same
// close path. processTick calls for one symbol are serialised so a timer close and a tick close of
// the same position can't both happen. Real PositionTracker; Redis and Postgres are in-test fakes.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHANNEL_ID ??= '-1000000000000'
process.env.FYERS_APP_ID ??= 'TEST-APP-ID'
process.env.FYERS_SECRET_ID ??= 'test-secret'
process.env.FYERS_REDIRECT_URI ??= 'http://localhost:3000/callback'

const clock = await import('../backtest/core/clock.js')
const { redisClient } = await import('../src/config/redis.js')
const { pool } = await import('../src/config/db.js')
const { positionTracker } = await import('../src/core/positionTracker.js')

type Fn = (...a: never[]) => unknown
const patch = (obj: object, impl: Record<string, Fn>) => {
	const o = obj as Record<string, unknown>
	const saved = Object.fromEntries(Object.keys(impl).map((k) => [k, Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined]))
	Object.assign(o, impl)
	return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete o[k]; else o[k] = v } }
}

const DAY = '2026-10-28'
const at = (h: number, m: number, s = 0) => clock.istEpoch(DAY, h * 60 + m) + s * 1000

/** Fakes for one test: a trades:open hash, counted history pushes / pnl increments, and Postgres close UPDATEs (optionally held open). */
const harness = (opts: { holdClose?: boolean } = {}) => {
	const hash = new Map<string, string>()
	const history: string[] = []
	let pnlIncrements = 0
	const closes: unknown[][] = []
	let release: () => void = () => {}
	const held = new Promise<void>((r) => (release = r))
	let nextId = 1
	const restoreRedis = patch(redisClient, {
		hSet: (async (_k: string, f: string, v: string) => (hash.set(f, v), 1)) as Fn,
		hDel: (async (_k: string, f: string) => Number(hash.delete(f))) as Fn,
		publish: (async () => 0) as Fn,
		multi: (() => {
			const ops: (() => void)[] = []
			const chain = {
				hDel: (_k: string, f: string) => (ops.push(() => hash.delete(f)), chain),
				lPush: (_k: string, v: string) => (ops.push(() => history.push(v)), chain),
				incrByFloat: () => (ops.push(() => pnlIncrements++), chain),
				exec: async () => (ops.forEach((op) => op()), []),
			}
			return chain
		}) as Fn,
	})
	const restorePg = patch(pool, {
		query: (async (sql: string, params: unknown[]) => {
			if (/INSERT INTO paper_trades/.test(sql)) return { rows: [{ id: nextId++ }], rowCount: 1 }
			if (/SET exit_price/.test(sql)) {
				closes.push(params)
				if (opts.holdClose) await held
			}
			return { rows: [], rowCount: 1 }
		}) as Fn,
	})
	const quiet = { log: console.log, warn: console.warn }
	console.log = console.warn = () => {}
	return {
		hash, history, closes, release,
		get pnlIncrements() { return pnlIncrements },
		restore: () => { Object.assign(console, quiet); restorePg(); restoreRedis() },
	}
}

const open = (sym: string, extra: Record<string, unknown> = {}) =>
	positionTracker.registerTrade({
		id: `trade_${Date.now()}_${sym}_test_aaaaaa`, symbol: sym, side: 'LONG', entryPrice: 100, stopLoss: 99, target: 102,
		timestamp: Date.now(), detectorName: 'Test', size: 10, actualSize: 10, durationClass: 'INTRADAY', ...extra,
	} as never)

test('TIMER: with no traded tick after 15:15, the sweep closes an INTRADAY position at the last known price (TIME, exit time = sweep time)', async () => {
	const h = harness()
	const un = clock.installVirtualClock(at(10, 0))
	try {
		await open('NSE:SQ1-EQ')
		positionTracker.notePrice('NSE:SQ1-EQ', 100.5, at(15, 10)) // a zero-volume quote the router dropped
		clock.setVirtualNow(at(15, 14, 59))
		assert.equal(await positionTracker.squareOffSweep(at(15, 14, 59)), 0, 'nothing before 15:15')
		assert.equal(h.closes.length, 0)
		clock.setVirtualNow(at(15, 15, 5))
		assert.equal(await positionTracker.squareOffSweep(at(15, 15, 5)), 1)
		assert.equal(h.closes.length, 1)
		const [exitPrice, exitTs, pnl, r, reason] = h.closes[0]!
		assert.deepEqual([exitPrice, exitTs, pnl, r, reason], [100.5, at(15, 15, 5), 5, 0.5, 'TIME'])
		assert.equal(positionTracker.getOpenPositions().some((p) => p.symbol === 'NSE:SQ1-EQ'), false)
		assert.equal(await positionTracker.squareOffSweep(at(15, 15, 10)), 0, 'nothing left to sweep')
	} finally {
		un()
		h.restore()
	}
})

test('NO DOUBLE CLOSE: a sweep and a traded tick at the same moment close the position exactly once', async () => {
	const h = harness({ holdClose: true })
	const un = clock.installVirtualClock(at(10, 0))
	try {
		await open('NSE:SQ2-EQ')
		positionTracker.notePrice('NSE:SQ2-EQ', 100.4, at(15, 14))
		clock.setVirtualNow(at(15, 15, 1))
		const sweep = positionTracker.squareOffSweep(at(15, 15, 1)) // starts closing, Postgres held open
		const tick = positionTracker.processTick('NSE:SQ2-EQ', { price: 100.6, volume: 5, timestamp: at(15, 15, 1) }) // lands meanwhile
		await new Promise((r) => setTimeout(r, 20))
		h.release()
		await Promise.all([sweep, tick])
		assert.equal(h.closes.length, 1, 'one Postgres close')
		assert.equal(h.history.length, 1, 'one history row')
		assert.equal(h.pnlIncrements, 1, 'pnl:daily counted once')
		assert.equal(h.closes[0]![0], 100.4, 'the first close in line (the sweep) wins')
	} finally {
		un()
		h.restore()
	}
})

test('SCOPE: SWING positions are left alone, and a symbol with no known price waits for its next traded tick', async () => {
	const h = harness()
	const un = clock.installVirtualClock(at(10, 0))
	try {
		await open('NSE:SQ3-EQ', { durationClass: 'SWING' })
		positionTracker.notePrice('NSE:SQ3-EQ', 100.2, at(15, 10))
		await open('NSE:SQ4-EQ') // INTRADAY, but no price noted
		clock.setVirtualNow(at(15, 16))
		assert.equal(await positionTracker.squareOffSweep(at(15, 16)), 0)
		assert.equal(h.closes.length, 0)
		const ids = positionTracker.getOpenPositions().map((p) => p.symbol)
		assert.ok(ids.includes('NSE:SQ3-EQ') && ids.includes('NSE:SQ4-EQ'))
		// the next traded tick still closes the INTRADAY one, as before
		await positionTracker.processTick('NSE:SQ4-EQ', { price: 100.3, volume: 1, timestamp: at(15, 16, 5) })
		assert.equal(h.closes.length, 1)
		assert.equal(h.closes[0]![4], 'TIME')
	} finally {
		un()
		h.restore()
	}
})

test('WIRING: the engine notes prices before the zero-volume filter and starts the timer after init; kill switch', () => {
	const ws = fs.readFileSync('src/ingestion/websocket.ts', 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
	const note = ws.indexOf('positionTracker.notePrice(tick.symbol, tick.ltp')
	const zeroVolFilter = ws.indexOf('if (!isIndexOrOption && actualTickVol <= 0)')
	assert.ok(note > 0 && zeroVolFilter > note, 'notePrice runs before the zero-volume ticks are dropped')
	assert.ok(ws.indexOf('positionTracker.startSquareOffTimer()') > ws.indexOf('await positionTracker.init()'))
	const prev = process.env.SQUARE_OFF_TIMER
	process.env.SQUARE_OFF_TIMER = 'false'
	positionTracker.startSquareOffTimer(1_000_000)
	assert.equal((positionTracker as unknown as { squareOffTimer: unknown }).squareOffTimer, null, 'kill switch: no timer')
	if (prev === undefined) delete process.env.SQUARE_OFF_TIMER
	else process.env.SQUARE_OFF_TIMER = prev
})
