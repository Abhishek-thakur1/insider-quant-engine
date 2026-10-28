// ============================================================
// tests/removeFlagRace.test.ts — removeFlag must not resurrect a position that is closing.
//
// processTick deletes the position from trades:open (pipeline), then awaits the Postgres close
// UPDATE, and only after that drops it from memory. A removeFlag (duplicate policy, alertPipeline)
// landing in that gap found the position still in memory and hSet it back into trades:open: a
// ghost that the next boot reloads and marks ORPHANED. Found by the PR #22 independent review.
// Real PositionTracker; Postgres and the Redis hash calls are in-test fakes (no network).
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

test('REMOVEFLAG RACE: a flag removal during a close does not put the position back in trades:open', async () => {
	const hash = new Map<string, string>()
	const restoreRedis = patch(redisClient, {
		hSet: (async (_k: string, f: string, v: string) => { hash.set(f, v); return 1 }) as Fn,
		hDel: (async (_k: string, f: string) => Number(hash.delete(f))) as Fn,
		publish: (async () => 0) as Fn,
		multi: (() => {
			const ops: (() => void)[] = []
			const chain = {
				hDel: (_k: string, f: string) => { ops.push(() => hash.delete(f)); return chain },
				lPush: () => chain,
				incrByFloat: () => chain,
				exec: async () => { ops.forEach((op) => op()); return [] },
			}
			return chain
		}) as Fn,
	})
	// Postgres: the INSERT returns id 1; the close UPDATE is held open until released.
	let releaseClose!: () => void
	let closeStarted!: () => void
	const closeSeen = new Promise<void>((r) => (closeStarted = r))
	const restorePg = patch(pool, {
		query: (async (sql: string) => {
			if (/INSERT INTO paper_trades/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 }
			if (/SET exit_price/.test(sql)) { closeStarted(); await new Promise<void>((r) => (releaseClose = r)); return { rows: [], rowCount: 1 } }
			return { rows: [], rowCount: 1 }
		}) as Fn,
	})
	const uninstallClock = clock.installVirtualClock(clock.istEpoch('2026-10-26', 10 * 60)) // 10:00 IST: no 15:15 square-off
	const quiet = { log: console.log, warn: console.warn }
	console.log = console.warn = () => {}
	try {
		const id = 'trade_1_NSE:RACE-EQ_test_abcdef'
		await positionTracker.registerTrade({
			id, symbol: 'NSE:RACE-EQ', side: 'LONG', entryPrice: 100, stopLoss: 99, target: 102, timestamp: Date.now(),
			detectorName: 'Test', size: 10, actualSize: 10, durationClass: 'INTRADAY', dataQuality: ['duplicate_signal'],
		})
		assert.ok(hash.has(id), 'registered position is in trades:open')

		const closing = positionTracker.processTick('NSE:RACE-EQ', { symbol: 'NSE:RACE-EQ', price: 98.5, volume: 1, timestamp: Date.now() } as never)
		await closeSeen // trades:open entry already deleted; the Postgres close is in flight
		assert.equal(hash.has(id), false)

		await positionTracker.removeFlag(id, 1, 'duplicate_signal') // the alert path, inside the gap
		releaseClose()
		await closing

		assert.equal(hash.has(id), false, 'a closed position must not be resurrected in trades:open')
		assert.equal(positionTracker.getOpenPositions().some((p) => p.id === id), false)
	} finally {
		Object.assign(console, quiet)
		uninstallClock()
		restorePg()
		restoreRedis()
	}
})
