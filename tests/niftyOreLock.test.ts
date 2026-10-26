// ============================================================
// tests/niftyOreLock.test.ts — Nifty Opening Range Explosion: the candle that closes at the
// range lock must be evaluated (defect found 2026-10-26).
//
// The detector builds the opening range from the first 5-min candle and locks it when the second
// candle closes. Until this fix the lock step returned immediately, so that second candle (09:20
// on 26 Oct, close 22410.15, below the range low) was never checked for a breakout.
// Runs the real detector through the replay harness (virtual clock, in-memory Redis, Nifty VWAP).
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHANNEL_ID ??= '-1000000000000'
process.env.FYERS_APP_ID ??= 'TEST-APP-ID'
process.env.FYERS_SECRET_ID ??= 'test-secret'
process.env.FYERS_REDIRECT_URI ??= 'http://localhost:3000/callback'
process.env.BACKTEST_MODE = 'true' // before telegramWorker loads: signals are collected, never sent

const clock = await import('../backtest/core/clock.js')
const { installMemoryRedis } = await import('../backtest/core/memoryRedis.js')
const { replaySession } = await import('../backtest/replay/engine.js')
const { REGISTRY } = await import('../backtest/registry.js')
const { NIFTY_SYMBOL } = await import('../backtest/config.js')

const DATE = '2026-10-26'
const ORE = REGISTRY.filter((s) => s.id === 'nifty_opening_range_explosion')
type B = [string, number, number, number, number] // IST HH:MM, o, h, l, c
const bars = (rows: B[]) => rows.map(([hhmm, o, h, l, c]) => {
	const [hh, mm] = hhmm.split(':').map(Number)
	return { t: clock.istEpoch(DATE, hh! * 60 + mm!), o, h, l, c, v: 0 }
})

const run = async (rows: B[]) => {
	const uninstallClock = clock.installVirtualClock(clock.istEpoch(DATE, 9 * 60 + 15))
	const { uninstall } = installMemoryRedis()
	const quiet = { log: console.log, warn: console.warn }
	console.log = console.warn = () => {}
	try {
		const r = await replaySession({ sessionDate: DATE, barsBySymbol: new Map([[NIFTY_SYMBOL, bars(rows)]]), specs: ORE })
		return r.signals.map((s) => ({ side: s.payload.side, price: s.payload.price, at: clock.istMinutesOf(s.ts) }))
	} finally {
		Object.assign(console, quiet)
		uninstall()
		uninstallClock()
	}
}

test('ORE LOCK CANDLE: a breakdown on the candle that closes at the lock fires (fails before the fix)', async () => {
	// 40-pt opening range 22480-22520; the 09:20 candle closes 22450 (< 22475 = low - 5), bearish,
	// body 0.18%, risk = (22520 + 5) - 22450 = 75 <= 80. The 09:25 candle stays below but is bullish.
	const sig = await run([
		['09:15', 22500, 22520, 22480, 22490],
		['09:20', 22490, 22492, 22445, 22450],
		['09:25', 22450, 22458, 22446, 22455],
		['09:30', 22455, 22462, 22450, 22458],
	])
	assert.equal(sig.length, 1, `expected one SHORT from the 09:20 lock candle, got ${JSON.stringify(sig)}`)
	assert.equal(sig[0]!.side, 'SHORT')
	assert.equal(sig[0]!.price, 22450)
})

test('ORE 26 OCT: the real bars produce no fire either way: an 80-pt range makes every breakout risk > 80', async () => {
	// Risk = opposite range edge +/- 5 minus the close, so it always exceeds range + 10 = 90 > 80.
	const sig = await run([
		['09:15', 22508.2, 22516.2, 22436.5, 22437.9],
		['09:20', 22439.05, 22441.25, 22398.25, 22410.15],
		['09:25', 22413.9, 22471.7, 22387.45, 22471.4],
		['09:30', 22472.15, 22486.9, 22436.55, 22437.3],
		['09:35', 22438.5, 22456.95, 22420.05, 22425.4],
		['09:40', 22425.75, 22471.85, 22413.25, 22461.05],
		['09:45', 22462.2, 22492.25, 22444.35, 22458.45],
		['09:50', 22460.2, 22550.95, 22457.6, 22550.95],
		['09:55', 22551.15, 22658.9, 22549.75, 22636.2],
		['10:00', 22635.7, 22657.25, 22618.8, 22636.5],
		['10:05', 22636.55, 22705.7, 22627.2, 22684.6],
		['10:10', 22684.6, 22700, 22670, 22690],
	])
	assert.deepEqual(sig, [])
})
