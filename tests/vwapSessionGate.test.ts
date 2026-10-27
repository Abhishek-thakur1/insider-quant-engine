// ============================================================
// tests/vwapSessionGate.test.ts — the live VWAP matches the backtest's once pre-open data is gated out.
//
// Live boots at 09:00, so it sees pre-open data:
//   - the pre-open auction print for each equity;
//   - pre-open Nifty index minutes.
// The backtest replay starts at 09:15. With the session gate (src/utils/vwapUtils.ts), the live paths
// produce exactly the replay's VWAP state. Without it (VWAP_SESSION_GATE=false) they don't.
// Live paths: onNiftyTick (core/niftyMinuteState.ts) and updateSessionVwap, the equity tick path.
// Backtest: replaySession (backtest/replay/engine.ts), with no detectors.
//
// Data: real cached 1-minute bars for 2026-09-07 (tests/fixtures/vwapGate_2026-09-07.json):
//   - Nifty 09:10-10:14, including the 5 pre-open bars the cache happens to hold for that day;
//   - SBIN 09:15-10:14.
// The SBIN auction print is built from that day's real numbers: price = daily open, and
// volume = daily volume minus the sum of the 1-minute volumes. That volume is an upper bound, since it
// also holds the closing session. It only has to exist for the gate to drop it.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHANNEL_ID ??= '-1000000000000'
process.env.FYERS_APP_ID ??= 'TEST-APP-ID'
process.env.FYERS_SECRET_ID ??= 'test-secret'
process.env.FYERS_REDIRECT_URI ??= 'http://localhost:3000/callback'
process.env.BACKTEST_MODE = 'true'

const clock = await import('../backtest/core/clock.js')
const { installMemoryRedis } = await import('../backtest/core/memoryRedis.js')
const { redisClient } = await import('../src/config/redis.js')
const { replaySession } = await import('../backtest/replay/engine.js')
const { barToTicks } = await import('../backtest/replay/barToTicks.js')
const { updateSessionVwap, inVwapSession } = await import('../src/utils/vwapUtils.js')
const { onNiftyTick, resetNiftyMinuteState } = await import('../src/core/niftyMinuteState.js')

const DATE = '2026-09-07'
const NIFTY = 'NSE:NIFTY50-INDEX'
const SBIN = 'NSE:SBIN-EQ'
type Bar = { t: number; o: number; h: number; l: number; c: number; v: number }
const fx = JSON.parse(fs.readFileSync('tests/fixtures/vwapGate_2026-09-07.json', 'utf8')) as {
	sbinDay: { open: number; dailyVolume: number; sumOf1mVolume: number }
	nifty: [number, number, number, number, number][]
	sbin: [number, number, number, number, number, number][]
}
const niftyAll: Bar[] = fx.nifty.map(([t, o, h, l, c]) => ({ t, o, h, l, c, v: 0 }))
const sbin: Bar[] = fx.sbin.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }))
const OPEN_915 = clock.istEpoch(DATE, 9 * 60 + 15)
const niftySession = niftyAll.filter((b) => b.t >= OPEN_915)
const state = async (sym: string) => JSON.parse((await redisClient.get(`vwap:${sym}:${DATE}`)) ?? 'null')

/** The live engine's view of the morning: pre-open data, then the session, then one tick that closes the last minute. */
const runLive = async () => {
	resetNiftyMinuteState()
	type Ev = { ts: number; sym: string; price: number; volume: number }
	const evs: Ev[] = []
	for (const b of niftyAll) for (const t of barToTicks(b)) evs.push({ ts: t.timestamp, sym: NIFTY, price: t.price, volume: 1 })
	evs.push({ ts: clock.istEpoch(DATE, 9 * 60 + 8), sym: SBIN, price: fx.sbinDay.open, volume: fx.sbinDay.dailyVolume - fx.sbinDay.sumOf1mVolume })
	for (const b of sbin) for (const t of barToTicks(b)) evs.push({ ts: t.timestamp, sym: SBIN, price: t.price, volume: t.volume })
	const last = niftyAll.at(-1)!
	evs.push({ ts: last.t + 60_000, sym: NIFTY, price: last.c, volume: 1 }) // closes the 10:14 minute
	evs.sort((a, b) => a.ts - b.ts || (a.sym === NIFTY ? -1 : 1))
	for (const e of evs) {
		clock.setVirtualNow(e.ts)
		if (e.sym === NIFTY) await onNiftyTick(e.price, e.ts)
		else await updateSessionVwap(e.sym, e.price, e.volume, e.ts)
	}
	return { nifty: await state(NIFTY), sbin: await state(SBIN) }
}

const runBacktest = async () => {
	await replaySession({ sessionDate: DATE, barsBySymbol: new Map([[NIFTY, niftySession], [SBIN, sbin]]), specs: [] })
	return { nifty: await state(NIFTY), sbin: await state(SBIN) }
}

const withEnv = async <T>(gate: boolean, fn: () => Promise<T>): Promise<T> => {
	const prev = process.env.VWAP_SESSION_GATE
	process.env.VWAP_SESSION_GATE = gate ? 'true' : 'false'
	const uninstallClock = clock.installVirtualClock(clock.istEpoch(DATE, 9 * 60))
	const { uninstall } = installMemoryRedis()
	const quiet = { log: console.log, warn: console.warn }
	console.log = console.warn = () => {}
	try {
		return await fn()
	} finally {
		Object.assign(console, quiet)
		uninstall()
		uninstallClock()
		if (prev === undefined) delete process.env.VWAP_SESSION_GATE
		else process.env.VWAP_SESSION_GATE = prev
	}
}

test('fixture: real 2026-09-07 bars, with 5 Nifty pre-open minutes and a positive SBIN auction residual', () => {
	assert.equal(niftyAll.length - niftySession.length, 5)
	assert.equal(sbin.length, 60)
	assert.ok(fx.sbinDay.dailyVolume - fx.sbinDay.sumOf1mVolume > 0)
})

test('VWAP GATE PARITY: with the gate, live Nifty and equity VWAP state equals the backtest replay exactly', async () => {
	await withEnv(true, async () => {
		const live = await runLive()
		const bt = await runBacktest()
		assert.ok(live.nifty && live.sbin && bt.nifty && bt.sbin)
		assert.equal(live.nifty.cumulativeVol, 60, '60 in-session minutes, the 09:10-09:14 pre-open minutes dropped')
		assert.deepEqual(live.nifty, bt.nifty)
		assert.deepEqual(live.sbin, bt.sbin)
	})
})

test('VWAP GATE OFF (kill switch): live includes the pre-open data and differs from the backtest', async () => {
	await withEnv(false, async () => {
		const live = await runLive()
		const bt = await runBacktest()
		assert.equal(live.nifty.cumulativeVol, 65, 'the 5 pre-open minutes count without the gate')
		assert.notEqual(live.nifty.vwap, bt.nifty.vwap)
		assert.equal(live.sbin.cumulativeVol - bt.sbin.cumulativeVol, fx.sbinDay.dailyVolume - fx.sbinDay.sumOf1mVolume, 'the auction print is the only extra volume')
		assert.notEqual(live.sbin.vwap, bt.sbin.vwap)
	})
})

test('inVwapSession: 09:14:59 IST is out, 09:15:00 is in; the kill switch admits everything', async () => {
	await withEnv(true, async () => {
		assert.equal(inVwapSession(OPEN_915 - 1000), false)
		assert.equal(inVwapSession(OPEN_915), true)
	})
	await withEnv(false, async () => assert.equal(inVwapSession(OPEN_915 - 3600_000), true))
})
