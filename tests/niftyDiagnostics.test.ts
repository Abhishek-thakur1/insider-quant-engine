// ============================================================
// tests/niftyDiagnostics.test.ts — "why no alert" records for the Nifty detectors
// (src/core/detectorDiagnostics.ts). Observation only: these tests prove the detectors' signals
// are identical with diagnostics on and off, that the 26 Oct reasons are recorded, and that the
// records are bounded (one per detector per candle, window reasons once a day, a daily cap).
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHANNEL_ID ??= '-1000000000000'
process.env.FYERS_APP_ID ??= 'TEST-APP-ID'
process.env.FYERS_SECRET_ID ??= 'test-secret'
process.env.FYERS_REDIRECT_URI ??= 'http://localhost:3000/callback'
process.env.BACKTEST_MODE = 'true' // before telegramWorker loads: signals are collected, never sent

const clock = await import('../backtest/core/clock.js')
const { installMemoryRedis, getMemoryRedis } = await import('../backtest/core/memoryRedis.js')
const { replaySession } = await import('../backtest/replay/engine.js')
const { REGISTRY } = await import('../backtest/registry.js')
const { NIFTY_SYMBOL } = await import('../backtest/config.js')
const diag = await import('../src/core/detectorDiagnostics.js')

const DATE = '2026-10-26'
const NIFTY = REGISTRY.filter((s) => ['nifty_opening_range_explosion', 'nifty_trend_pulse', 'nifty_vwap_reclaim'].includes(s.id))
// 26 Oct 2026 5-minute Nifty bars, the same rows as tests/niftyOreLock.test.ts (09:15-10:10)
const OCT26: [string, number, number, number, number][] = [
	['09:15', 22508.2, 22516.2, 22436.5, 22437.9], ['09:20', 22439.05, 22441.25, 22398.25, 22410.15],
	['09:25', 22413.9, 22471.7, 22387.45, 22471.4], ['09:30', 22472.15, 22486.9, 22436.55, 22437.3],
	['09:35', 22438.5, 22456.95, 22420.05, 22425.4], ['09:40', 22425.75, 22471.85, 22413.25, 22461.05],
	['09:45', 22462.2, 22492.25, 22444.35, 22458.45], ['09:50', 22460.2, 22550.95, 22457.6, 22550.95],
	['09:55', 22551.15, 22658.9, 22549.75, 22636.2], ['10:00', 22635.7, 22657.25, 22618.8, 22636.5],
	['10:05', 22636.55, 22705.7, 22627.2, 22684.6], ['10:10', 22684.6, 22700, 22670, 22690],
]
const bars = () => OCT26.map(([hhmm, o, h, l, c]) => { const [hh, mm] = hhmm.split(':').map(Number); return { t: clock.istEpoch(DATE, hh! * 60 + mm!), o, h, l, c, v: 0 } })

const run = async (enabled: boolean) => {
	process.env.NIFTY_DIAG_ENABLED = enabled ? 'true' : 'false'
	const uninstallClock = clock.installVirtualClock(clock.istEpoch(DATE, 9 * 60 + 15))
	const { uninstall } = installMemoryRedis()
	const quiet = { log: console.log, warn: console.warn }
	console.log = console.warn = () => {}
	try {
		const r = await replaySession({ sessionDate: DATE, barsBySymbol: new Map([[NIFTY_SYMBOL, bars()]]), specs: NIFTY })
		await new Promise((res) => setTimeout(res, 20)) // let the fire-and-forget Redis writes land
		const list = await getMemoryRedis().lRange(diag.diagKey(DATE), 0, -1)
		return { signals: r.signals.map((s) => ({ det: s.detectorId, side: s.payload.side, price: s.payload.price, ts: s.ts, trigger: s.payload.trigger })), records: [...diag.recentDiagnostics()], list }
	} finally {
		Object.assign(console, quiet)
		uninstall()
		uninstallClock()
		delete process.env.NIFTY_DIAG_ENABLED
	}
}

test('DIAG PARITY: the Nifty detectors emit exactly the same signals with diagnostics on and off (26 Oct bars)', async () => {
	const off = await run(false)
	const on = await run(true)
	assert.deepEqual(on.signals, off.signals)
	assert.equal(off.records.length, 0, 'kill switch: nothing recorded when off')
	assert.ok(on.records.length > 0)
})

// 26 Oct only fires VWAP Reclaim, so it can't catch a parity break in ORE or Trend Pulse (PR #32
// review, 27 Oct). These three real cached sessions fire all three detectors between them.
const FIRE = JSON.parse(fs.readFileSync('tests/fixtures/niftyDiag_fireDays.json', 'utf8')) as { days: Record<string, [number, number, number, number, number][]> }
const runDay = async (date: string, enabled: boolean) => {
	process.env.NIFTY_DIAG_ENABLED = enabled ? 'true' : 'false'
	const rows = FIRE.days[date]!
	const uninstallClock = clock.installVirtualClock(rows[0]![0])
	const { uninstall } = installMemoryRedis()
	const quiet = { log: console.log, warn: console.warn }
	console.log = console.warn = () => {}
	try {
		const r = await replaySession({ sessionDate: date, barsBySymbol: new Map([[NIFTY_SYMBOL, rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c, v: 0 }))]]), specs: NIFTY })
		return r.signals.map((s) => ({ det: s.detectorId, side: s.payload.side, price: s.payload.price, ts: s.ts, trigger: s.payload.trigger }))
	} finally {
		Object.assign(console, quiet)
		uninstall()
		uninstallClock()
		delete process.env.NIFTY_DIAG_ENABLED
	}
}

test('DIAG PARITY on fire days: ORE, Trend Pulse and VWAP Reclaim emit identical signals with diagnostics on and off', async () => {
	const fired = new Set<string>()
	for (const date of Object.keys(FIRE.days)) {
		const off = await runDay(date, false)
		const on = await runDay(date, true)
		assert.deepEqual(on, off, `signals differ on ${date}`)
		for (const s of off) fired.add(s.det)
	}
	// the fixture must exercise every detector, or a parity break there would go unseen
	assert.deepEqual([...fired].sort(), ['nifty_opening_range_explosion', 'nifty_trend_pulse', 'nifty_vwap_reclaim'])
})

test('DIAG 26 OCT: the reasons that had to be rebuilt by hand are now recorded', async () => {
	const { records, list } = await run(true)
	const by = (det: string, reason: string) => records.filter((r) => r.detector === det && r.reason === reason)
	assert.ok(by('Nifty Opening Range Explosion', 'lock_candle_not_evaluated').some((r) => r.nums?.close === 22410.15), 'the 09:20 lock candle')
	const oreRisk = by('Nifty Opening Range Explosion', 'risk_cap')
	assert.ok(oreRisk.some((r) => r.side === 'LONG' && (r.nums?.risk ?? 0) > 80), 'ORE breakout blocked by the 80-pt risk cap')
	assert.ok(by('Nifty Trend Pulse', 'risk_cap').some((r) => r.side === 'LONG' && (r.nums?.risk ?? 0) > 60), 'Trend Pulse blocked by the 60-pt risk cap')
	assert.ok(by('Nifty Trend Pulse', 'warmup').length >= 1)
	assert.equal(by('Nifty VWAP Reclaim', 'window_not_open').length, 1, 'window reason once a day, not per candle')
	assert.equal(list.length, records.length, 'every record also lands in the bounded Redis list')
	// one record per detector per candle
	const keys = records.filter((r) => !r.reason.startsWith('window_')).map((r) => `${r.detector}|${r.t}`)
	assert.equal(new Set(keys).size, keys.length)
})

test('DIAG BOUNDS: daily cap, per-candle dedupe, never throws', () => {
	diag.resetDiagnostics()
	const quiet = console.log
	console.log = () => {}
	try {
		const t0 = clock.istEpoch(DATE, 9 * 60 + 15)
		for (let i = 0; i < diag.DAILY_CAP + 50; i++) diag.noteBlocked('X', t0 + i * 60_000, null, 'no_break')
		assert.equal(diag.recentDiagnostics().filter((r) => r.detector === 'X').length, diag.DAILY_CAP)
		diag.resetDiagnostics()
		diag.noteBlocked('Y', t0, 'LONG', 'risk_cap', { risk: 100 })
		diag.noteBlocked('Y', t0, 'LONG', 'body_too_small')
		assert.equal(diag.recentDiagnostics().length, 1, 'first reason per candle wins')
		assert.doesNotThrow(() => diag.noteBlocked('Z', Number.NaN, null, 'weird', { x: Number.NaN }))
	} finally {
		console.log = quiet
		diag.resetDiagnostics()
	}
})
