// ============================================================
// tests/tickSerialization.test.ts — two overlapping ticks never close one position twice.
//
// The tick handler calls positionTracker.processTick without awaiting it. Before 2026-10-28 two calls
// for one symbol could overlap: both saw the position open, both closed it, giving two
// trades:history rows, pnl:daily counted twice, and two Postgres UPDATEs. processTick is now
// serialised per symbol. This test fails on the code before the fix (checked by removing the queue).
// Real PositionTracker; Redis and Postgres are in-test fakes.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

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

test('SERIALISED: two overlapping ticks that both cross the stop close the position exactly once', async () => {
	const history: string[] = []
	let pnlIncrements = 0
	const closes: unknown[][] = []
	let release: () => void = () => {}
	const held = new Promise<void>((r) => (release = r))
	const restoreRedis = patch(redisClient, {
		hSet: (async () => 1) as Fn,
		hDel: (async () => 1) as Fn,
		publish: (async () => 0) as Fn,
		multi: (() => {
			const ops: (() => void)[] = []
			const chain = {
				hDel: () => chain,
				lPush: (_k: string, v: string) => (ops.push(() => history.push(v)), chain),
				incrByFloat: () => (ops.push(() => pnlIncrements++), chain),
				exec: async () => (ops.forEach((op) => op()), []),
			}
			return chain
		}) as Fn,
	})
	const restorePg = patch(pool, {
		query: (async (sql: string, params: unknown[]) => {
			if (/INSERT INTO paper_trades/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 }
			if (/SET exit_price/.test(sql)) {
				closes.push(params)
				await held // the first close is still writing when the second tick arrives
			}
			return { rows: [], rowCount: 1 }
		}) as Fn,
	})
	const uninstallClock = clock.installVirtualClock(clock.istEpoch('2026-10-28', 10 * 60))
	const quiet = { log: console.log, warn: console.warn }
	console.log = console.warn = () => {}
	try {
		await positionTracker.registerTrade({
			id: 'trade_1_NSE:SER-EQ_test_abcdef', symbol: 'NSE:SER-EQ', side: 'LONG', entryPrice: 100, stopLoss: 99, target: 102,
			timestamp: Date.now(), detectorName: 'Test', size: 10, actualSize: 10, durationClass: 'INTRADAY',
		})
		const t1 = positionTracker.processTick('NSE:SER-EQ', { price: 98.9, volume: 1, timestamp: Date.now() })
		const t2 = positionTracker.processTick('NSE:SER-EQ', { price: 98.8, volume: 1, timestamp: Date.now() })
		await new Promise((r) => setTimeout(r, 20))
		release()
		await Promise.all([t1, t2])
		assert.equal(closes.length, 1, 'one Postgres close')
		assert.equal(history.length, 1, 'one trades:history row')
		assert.equal(pnlIncrements, 1, 'pnl:daily counted once')
		assert.equal(closes[0]![0], 98.9, 'the first tick in line closes it')
		assert.equal(positionTracker.getOpenPositions().some((p) => p.symbol === 'NSE:SER-EQ'), false)
	} finally {
		Object.assign(console, quiet)
		uninstallClock()
		restorePg()
		restoreRedis()
	}
})

test('SERIALISED: ticks for different symbols are not held up by a slow close elsewhere', async () => {
	let release: () => void = () => {}
	const held = new Promise<void>((r) => (release = r))
	let n = 1
	const closes: string[] = []
	const restoreRedis = patch(redisClient, {
		hSet: (async () => 1) as Fn, hDel: (async () => 1) as Fn, publish: (async () => 0) as Fn,
		multi: (() => { const c = { hDel: () => c, lPush: () => c, incrByFloat: () => c, exec: async () => [] }; return c }) as Fn,
	})
	const restorePg = patch(pool, {
		query: (async (sql: string, params: unknown[]) => {
			if (/INSERT INTO paper_trades/.test(sql)) return { rows: [{ id: n++ }], rowCount: 1 }
			if (/SET exit_price/.test(sql)) {
				closes.push(String(params[0]))
				if (params[0] === 98.9) await held // symbol A's close is slow
			}
			return { rows: [], rowCount: 1 }
		}) as Fn,
	})
	const uninstallClock = clock.installVirtualClock(clock.istEpoch('2026-10-28', 10 * 60))
	const quiet = { log: console.log, warn: console.warn }
	console.log = console.warn = () => {}
	try {
		for (const s of ['NSE:SERA-EQ', 'NSE:SERB-EQ'])
			await positionTracker.registerTrade({ id: `trade_2_${s}_test_abcdef`, symbol: s, side: 'LONG', entryPrice: 100, stopLoss: 99, target: 102, timestamp: Date.now(), detectorName: 'Test', size: 1, actualSize: 1, durationClass: 'INTRADAY' })
		const a = positionTracker.processTick('NSE:SERA-EQ', { price: 98.9, volume: 1, timestamp: Date.now() })
		await positionTracker.processTick('NSE:SERB-EQ', { price: 98.7, volume: 1, timestamp: Date.now() }) // completes while A waits
		assert.deepEqual(closes, ['98.9', '98.7'])
		release()
		await a
	} finally {
		Object.assign(console, quiet)
		uninstallClock()
		restorePg()
		restoreRedis()
	}
})
