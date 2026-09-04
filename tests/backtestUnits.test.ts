// ============================================================
// tests/backtestUnits.test.ts — the harness's own machinery
//
// These cover the pieces the backtest's correctness rests on: the virtual
// clock, virtual-time Redis TTLs, bar→tick fidelity, the look-ahead assertion,
// exit resolution, and the sample-size discipline in the metrics layer.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHANNEL_ID ??= '-1000000000000'
process.env.FYERS_APP_ID ??= 'TEST-APP-ID'
process.env.FYERS_SECRET_ID ??= 'test-secret'
process.env.FYERS_REDIRECT_URI ??= 'http://localhost:3000/callback'
process.env.BACKTEST_MODE = 'true'

const clock = await import('../backtest/core/clock.js')
const { installMemoryRedis } = await import('../backtest/core/memoryRedis.js')
const { barToTicks, mergeChronologically, assertChronological, looksCircuitLocked } =
	await import('../backtest/replay/barToTicks.js')
const { deriveLevels, simulateExit, resolveUnderlying } = await import('../backtest/sim/exit.js')
const { computeMetrics, rankByExpectancy } = await import('../backtest/sim/metrics.js')
const { REGISTRY, byId, constructDetector } = await import('../backtest/registry.js')
const { circuitLockedBar } = await import('../backtest/fixtures/synthetic.js')
const { SIM, METRICS } = await import('../backtest/config.js')

// ── virtual clock ───────────────────────────────────────────────────────────

test('clock: Date.now() and new Date() both follow the virtual clock', () => {
	const target = clock.istEpoch('2026-06-01', 10 * 60 + 30)
	const uninstall = clock.installVirtualClock(target)
	try {
		assert.equal(Date.now(), target)
		assert.equal(new Date().getTime(), target)
		// An explicit argument must still behave normally.
		assert.equal(new Date(0).getTime(), 0)

		clock.setVirtualNow(target + 60_000)
		assert.equal(Date.now(), target + 60_000)
	} finally {
		uninstall()
	}
	// Restored afterwards, or every later test would see a frozen clock.
	assert.ok(Math.abs(Date.now() - clock.realNow()) < 5_000)
})

test('clock: IST helpers match the arithmetic the detectors use', () => {
	// A detector computes: new Date(now + 5.5h) then getUTCHours()*60+getUTCMinutes()
	const epoch = clock.istEpoch('2026-06-01', 9 * 60 + 15)
	assert.equal(clock.istMinutesOf(epoch), 9 * 60 + 15)
	assert.equal(clock.istDateStringOf(epoch), '2026-06-01')

	const uninstall = clock.installVirtualClock(epoch)
	try {
		const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
		assert.equal(d.getUTCHours() * 60 + d.getUTCMinutes(), 9 * 60 + 15)
	} finally {
		uninstall()
	}
})

// ── memory Redis ────────────────────────────────────────────────────────────

test('memoryRedis: TTLs expire on SIMULATED time, not wall time', async () => {
	const start = clock.istEpoch('2026-06-01', 9 * 60 + 20)
	const uninstallClock = clock.installVirtualClock(start)
	const { store, uninstall } = installMemoryRedis()
	try {
		await store.setEx('cooldown:test', 1800, '1') // 30 simulated minutes
		assert.equal(await store.get('cooldown:test'), '1')

		clock.setVirtualNow(start + 29 * 60_000)
		assert.equal(await store.get('cooldown:test'), '1', 'still cooling down at +29 min')

		clock.setVirtualNow(start + 31 * 60_000)
		assert.equal(await store.get('cooldown:test'), null, 'expired by +31 min')
	} finally {
		uninstall()
		uninstallClock()
	}
})

test('memoryRedis: lPush prepends so index 0 is newest (detectors rely on this)', async () => {
	const uninstallClock = clock.installVirtualClock(Date.now())
	const { store, uninstall } = installMemoryRedis()
	try {
		await store.lPush('hist', 'a')
		await store.lPush('hist', 'b')
		await store.lPush('hist', 'c')
		assert.deepEqual(await store.lRange('hist', 0, -1), ['c', 'b', 'a'])

		await store.lTrim('hist', 0, 1)
		assert.deepEqual(await store.lRange('hist', 0, -1), ['c', 'b'])
	} finally {
		uninstall()
		uninstallClock()
	}
})

test('memoryRedis: multi() chains apply in order on exec()', async () => {
	const uninstallClock = clock.installVirtualClock(Date.now())
	const { store, uninstall } = installMemoryRedis()
	try {
		await store.multi().lPush('k', 'x').lPush('k', 'y').lTrim('k', 0, 0).exec()
		assert.deepEqual(await store.lRange('k', 0, -1), ['y'])

		await store.multi().hIncrBy('stats', 'fired', 1).hIncrBy('stats', 'fired', 2).exec()
		assert.deepEqual(await store.hGetAll('stats'), { fired: '3' })
	} finally {
		uninstall()
		uninstallClock()
	}
})

test('memoryRedis: installing swaps the SHARED client every importer holds', async () => {
	const { redisClient } = await import('../src/config/redis.js')
	const uninstallClock = clock.installVirtualClock(Date.now())
	const { uninstall } = installMemoryRedis()
	try {
		// Written through the shared binding, read through the shared binding.
		await redisClient.set('shared:probe', 'yes')
		assert.equal(await redisClient.get('shared:probe'), 'yes')
		assert.equal(redisClient.isOpen, true)
	} finally {
		uninstall()
		uninstallClock()
	}
})

// ── bar → tick ──────────────────────────────────────────────────────────────

test('barToTicks: preserves O/H/L/C exactly and conserves volume', () => {
	const bar = { t: 1_700_000_000_000, o: 100, h: 104, l: 99, c: 103, v: 1000 }
	const ticks = barToTicks(bar)
	assert.equal(ticks.length, 4)

	const prices = ticks.map((t) => t.price)
	assert.equal(prices[0], bar.o, 'first tick is the open')
	assert.equal(prices[3], bar.c, 'last tick is the close')
	assert.equal(Math.max(...prices), bar.h)
	assert.equal(Math.min(...prices), bar.l)
	assert.equal(
		ticks.reduce((s, t) => s + t.volume, 0),
		bar.v,
	)
	// Bullish bar probes the low first.
	assert.deepEqual(prices, [100, 99, 104, 103])

	// Timestamps stay strictly inside the bar's minute and ascend.
	for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i]!.timestamp > ticks[i - 1]!.timestamp)
	assert.ok(ticks[3]!.timestamp < bar.t + 60_000)
})

test('barToTicks: bearish bar probes the high first', () => {
	const prices = barToTicks({ t: 0, o: 100, h: 102, l: 95, c: 96, v: 400 }).map((t) => t.price)
	assert.deepEqual(prices, [100, 102, 95, 96])
})

test('mergeChronologically: interleaves symbols by time and passes the look-ahead assertion', () => {
	const a = [
		{ t: 300, o: 1, h: 1, l: 1, c: 1, v: 1 },
		{ t: 100, o: 1, h: 1, l: 1, c: 1, v: 1 },
	]
	const b = [{ t: 200, o: 2, h: 2, l: 2, c: 2, v: 1 }]
	const merged = mergeChronologically(
		new Map([
			['A', a],
			['B', b],
		]),
	)
	assert.deepEqual(
		merged.map((m) => [m.symbol, m.bar.t]),
		[
			['A', 100],
			['B', 200],
			['A', 300],
		],
	)
	assertChronological(merged) // must not throw
})

test('assertChronological: catches an out-of-order stream', () => {
	const bad = [
		{ symbol: 'A', bar: { t: 200, o: 1, h: 1, l: 1, c: 1, v: 1 } },
		{ symbol: 'B', bar: { t: 100, o: 1, h: 1, l: 1, c: 1, v: 1 } },
	]
	assert.throws(() => assertChronological(bad), /LOOK-AHEAD VIOLATION/)
})

test('looksCircuitLocked: only a zero-range bar WITH volume', () => {
	assert.equal(looksCircuitLocked(circuitLockedBar(0, 500)), true)
	assert.equal(looksCircuitLocked({ t: 0, o: 500, h: 500, l: 500, c: 500, v: 0 }), false)
	assert.equal(looksCircuitLocked({ t: 0, o: 500, h: 501, l: 500, c: 500, v: 100 }), false)
})

// ── exit levels ─────────────────────────────────────────────────────────────

const signalOf = (over: Record<string, unknown> = {}) => {
	const { payload: payloadOver, ...rest } = over
	return {
		detectorId: 'x',
		detectorDisplayName: 'X',
		ts: 1_000,
		sessionDate: '2026-06-01',
		gate: {
			passed: true,
			score: 90,
			posterior: 0.6,
			ev: 5,
			kellyHalf: 0.02,
			regime: 'trending',
			entropy: 1.2,
			rejectedAt: null,
			classificationSource: 'explicit',
		},
		...rest,
		payload: {
			symbol: 'NSE:TEST-EQ',
			price: 100,
			side: 'LONG',
			percentageChange: 0.3,
			volumeSpikeRatio: 3,
			trigger: 'Breakout | SL ₹98 | T1 ₹104 | T2 ₹106',
			vwap: 99.5,
			avgPrice: 100,
			...(payloadOver as object | undefined),
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any
}

test('deriveLevels: recovers signed levels from the LIVE filter parser', () => {
	const lv = deriveLevels(signalOf())
	assert.equal(lv.basis, 'detector-defined')
	assert.equal(lv.stop, 98)
	assert.equal(lv.target, 104)
	assert.equal(lv.t2, 106)
})

test('deriveLevels: mirrors the levels for a SHORT', () => {
	const lv = deriveLevels(
		signalOf({ payload: { side: 'SHORT', trigger: 'Breakdown | SL ₹102 | T1 ₹96' } }),
	)
	assert.equal(lv.stop, 102)
	assert.equal(lv.target, 96)
})

test('deriveLevels: falls back to the documented harness default when the trigger has no levels', () => {
	const lv = deriveLevels(signalOf({ payload: { trigger: 'Some setup with no levels' } }))
	assert.equal(lv.basis, 'harness-default')
	assert.equal(lv.stop, 100 - 100 * (SIM.defaultStopPct / 100))
	assert.ok(lv.target > 100)
})

test('symbolClass: the LIVE substring test misroutes five real equities', async () => {
	const { isOptionSymbolLive, isOptionSymbolPrecise, misroutedByLiveTest } =
		await import('../backtest/core/symbolClass.js')
	const watchlist = JSON.parse(
		(await import('fs')).readFileSync('watchlist.json', 'utf8'),
	) as string[]

	// The bug: an equity whose NAME contains CE/PE is treated as an option.
	assert.equal(isOptionSymbolLive('NSE:RELIANCE-EQ'), true, 'reproduces the live bug')
	assert.equal(isOptionSymbolPrecise('NSE:RELIANCE-EQ'), false, 'and the correct answer')

	// A real option is classified correctly by both.
	for (const opt of ['NIFTY 24500 CE', 'NSE:NIFTY2541722500CE', 'NIFTY 24000 PE']) {
		assert.equal(isOptionSymbolLive(opt), true, opt)
		assert.equal(isOptionSymbolPrecise(opt), true, opt)
	}

	const misrouted = misroutedByLiveTest(watchlist)
	assert.deepEqual(misrouted.sort(), [
		'NSE:BAJFINANCE-EQ',
		'NSE:CEATLTD-EQ',
		'NSE:KAJARIACER-EQ',
		'NSE:RELIANCE-EQ',
		'NSE:ULTRACEMCO-EQ',
	])
})

test('resolveUnderlying: option alerts resolve to the index, equities to themselves', () => {
	assert.equal(resolveUnderlying('NIFTY 24500 CE'), 'NSE:NIFTY50-INDEX')
	assert.equal(resolveUnderlying('NSE:NIFTY50-INDEX'), 'NSE:NIFTY50-INDEX')
	assert.equal(resolveUnderlying('NSE:RELIANCE-EQ'), 'NSE:RELIANCE-EQ')
})

// ── exit simulation ─────────────────────────────────────────────────────────

const bar = (t: number, o: number, h: number, l: number, c: number, v = 1000) => ({
	t,
	o,
	h,
	l,
	c,
	v,
})

test('simulateExit: target hit gives a positive R net of slippage', () => {
	const trade = simulateExit(signalOf(), [bar(2000, 100, 105, 100, 104)], 'NSE:TEST-EQ')!
	assert.equal(trade.exitReason, 'target')
	// Gross would be 2R (risk 2, reward 4); slippage on both legs shaves a little.
	assert.ok(trade.r > 1.9 && trade.r < 2.0, `expected just under 2R, got ${trade.r}`)
})

test('simulateExit: stop hit gives about −1R', () => {
	const trade = simulateExit(signalOf(), [bar(2000, 100, 100, 97, 98)], 'NSE:TEST-EQ')!
	assert.equal(trade.exitReason, 'stop')
	assert.ok(trade.r < -1.0 && trade.r > -1.1, `expected just past -1R, got ${trade.r}`)
})

test('simulateExit: a bar containing BOTH levels resolves pessimistically to the stop', () => {
	const trade = simulateExit(signalOf(), [bar(2000, 100, 105, 97, 101)], 'NSE:TEST-EQ')!
	assert.equal(trade.exitReason, 'stop', 'ambiguous bar must not be given the benefit of the doubt')
	assert.ok(trade.r < 0)
})

test('simulateExit: a stop inside a circuit-locked bar is NOT filled — it defers', () => {
	const trade = simulateExit(
		signalOf(),
		[
			circuitLockedBar(2000, 97), // stop level is inside, but untradable
			bar(3000, 97, 99, 96.5, 98.5), // first tradable bar afterwards
		],
		'NSE:TEST-EQ',
	)!
	assert.equal(trade.deferredByLock, 1, 'the locked bar must be recorded as a deferral')
	assert.equal(trade.exitReason, 'stop', 'and then filled on the next tradable bar')
})

test('simulateExit: anything still open at 15:15 IST is squared off', () => {
	const entry = clock.istEpoch('2026-06-01', 14 * 60)
	const sig = signalOf({ ts: entry })
	const bars = [
		bar(clock.istEpoch('2026-06-01', 14 * 60 + 30), 100, 101, 99.5, 100.5),
		bar(clock.istEpoch('2026-06-01', 15 * 60 + 15), 100.5, 101, 100, 100.8),
	]
	const trade = simulateExit(sig, bars, 'NSE:TEST-EQ')!
	assert.equal(trade.exitReason, 'forced-square-off')
})

test('simulateExit: no forward data yields a flat, labelled trade rather than a fake fill', () => {
	const trade = simulateExit(signalOf(), [], 'NSE:TEST-EQ')!
	assert.equal(trade.exitReason, 'no-forward-data')
	assert.equal(trade.r, 0)
})

test('simulateExit: an SL equal to the entry cannot produce an infinite R', () => {
	// A degenerate trigger (SL == entry) would divide by zero. The LIVE parser
	// already guards this — it only accepts a parse when risk > 0 — so the
	// harness default takes over and R stays finite. Asserting that rather than
	// assuming either layer handles it.
	const sig = signalOf({ payload: { trigger: 'degenerate | SL ₹100 | T1 ₹104' } })
	const levels = deriveLevels(sig)
	assert.equal(levels.basis, 'harness-default', 'zero-risk parse must be rejected')

	const trade = simulateExit(sig, [bar(2000, 100, 105, 100, 104)], 'NSE:TEST-EQ')!
	assert.ok(Number.isFinite(trade.r), `R must be finite, got ${trade.r}`)
})

// ── metrics ─────────────────────────────────────────────────────────────────

const tradeAt = (r: number, ts: number, passed = true) =>
	({
		detectorId: 'vcp',
		sessionDate: '2026-06-01',
		symbol: 'NSE:TEST-EQ',
		underlying: 'NSE:TEST-EQ',
		side: 'LONG',
		entryTs: ts,
		exitTs: ts + 60_000,
		entryPrice: 100,
		exitPrice: 100 + r,
		stopLevel: 99,
		targetLevel: 102,
		r,
		exitReason: r > 0 ? 'target' : 'stop',
		exitBasis: 'detector-defined',
		holdingMinutes: 5,
		deferredByLock: 0,
		t2Reached: false,
		gateScore: 90,
		gatePassed: passed,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any

test('metrics: expectancy, drawdown and profit factor', () => {
	const trades = [tradeAt(2, 1), tradeAt(-1, 2), tradeAt(-1, 3), tradeAt(3, 4)]
	const m = computeMetrics(byId('vcp'), 10, {}, trades)

	assert.equal(m.tradesGated, 4)
	assert.equal(m.signalsUngated, 10)
	assert.equal(m.gatePassRate, 0.4)
	assert.equal(m.gated.winRate, 0.5)
	assert.ok(Math.abs(m.gated.expectancyR! - 0.75) < 1e-9)
	assert.equal(m.gated.totalR, 3)
	// Peak 2 after trade 1, trough 0 after trade 3 → 2R drawdown.
	assert.equal(m.gated.maxDrawdownR, 2)
	assert.equal(m.gated.profitFactor, 5 / 2)
	assert.equal(m.gated.bestTradeR, 3)
	assert.equal(m.gated.worstTradeR, -1)
})

test('metrics: a gate-rejected trade lands in UNGATED only — never in gated', () => {
	// This is the whole point of the two blocks. If the filter blocks a winner,
	// gated must not see it, but ungated must — otherwise a fully-suppressed
	// detector reports nothing at all and over-suppression is invisible.
	const m = computeMetrics(byId('vcp'), 5, { EV: 1 }, [tradeAt(5, 1, false), tradeAt(1, 2, true)])
	assert.equal(m.gated.trades, 1)
	assert.equal(m.gated.totalR, 1, 'the rejected +5R must not reach gated')
	assert.equal(m.ungated.trades, 2)
	assert.equal(m.ungated.totalR, 6, 'ungated must include it')
	assert.equal(m.gatePassRate, 0.2)
})

test('metrics: a fully-suppressed detector still reports an ungated edge', () => {
	const rejected = Array.from({ length: 40 }, (_, i) => tradeAt(0.4, i, false))
	const m = computeMetrics(byId('vcp'), 40, { REGIME: 40 }, rejected)

	assert.equal(m.tradesGated, 0)
	assert.equal(m.gated.expectancyR, null, 'nothing traded, so no gated expectancy')
	assert.equal(m.ungated.trades, 40)
	assert.ok(Math.abs(m.ungated.expectancyR! - 0.4) < 1e-9)
	assert.equal(m.ungated.sufficientSample, true)
	assert.match(m.sampleNote, /UNGATED block/, 'the note must point the reader at ungated')
})

test('metrics: sample-size flag is enforced in the metrics layer, not left to the report', () => {
	const few = computeMetrics(byId('vcp'), 5, {}, [tradeAt(1, 1), tradeAt(1, 2)])
	assert.equal(few.sufficientSample, false)
	assert.match(few.sampleNote, /INSUFFICIENT/)

	const many = computeMetrics(
		byId('vcp'),
		200,
		{},
		Array.from({ length: METRICS.minGatedTradesForConfidence }, (_, i) => tradeAt(0.5, i)),
	)
	assert.equal(many.sufficientSample, true)
})

test('metrics: win concentration exposes a tail-driven expectancy', () => {
	// One 20R winner and nine -1R losers: positive expectancy, entirely from one
	// trade. Trade count alone would not reveal that; topWinShare must.
	const trades = [tradeAt(20, 1), ...Array.from({ length: 9 }, (_, i) => tradeAt(-1, i + 2))]
	const m = computeMetrics(byId('vcp'), 10, {}, trades)

	assert.equal(m.ungated.topWinShare, 1, 'the single winner supplied 100% of the gains')
	assert.equal(m.ungated.top3WinShare, 1)
	assert.ok(m.ungated.expectancyR! > 0, 'expectancy is positive despite a 10% win rate')
	assert.ok(
		m.ungated.tailDependenceWarning,
		'a 100% single-trade share must be flagged, not reported silently',
	)
	assert.match(m.ungated.tailDependenceWarning!, /single trade/)
})

test('metrics: an evenly-spread book is NOT flagged as tail-dependent', () => {
	const even = Array.from({ length: 20 }, (_, i) => tradeAt(i % 2 === 0 ? 1 : -0.5, i))
	const m = computeMetrics(byId('vcp'), 20, {}, even)
	assert.equal(m.ungated.topWinShare, 0.1, '10 equal winners → 10% each')
	assert.equal(m.ungated.tailDependenceWarning, null)
})

test('metrics: win concentration is null when nothing won', () => {
	const m = computeMetrics(byId('vcp'), 3, {}, [tradeAt(-1, 1), tradeAt(-1, 2)])
	assert.equal(m.ungated.topWinShare, null)
	assert.equal(m.ungated.top3WinShare, null)
	assert.equal(m.ungated.tailDependenceWarning, null)
})

test('metrics: an insufficient-sample detector can never outrank a sufficient one', () => {
	const lucky = computeMetrics(byId('vcp'), 3, {}, [tradeAt(9, 1), tradeAt(9, 2)])
	const solid = computeMetrics(
		byId('stock_momentum_breakout'),
		400,
		{},
		Array.from({ length: 60 }, (_, i) => tradeAt(0.2, i)),
	)
	const ranked = rankByExpectancy([lucky, solid])
	assert.equal(ranked[0]!.detectorId, 'stock_momentum_breakout')
	assert.equal(ranked[1]!.detectorId, 'vcp')
})

// ── registry ────────────────────────────────────────────────────────────────

test('registry: all 26 detector classes are present and constructible', () => {
	assert.equal(REGISTRY.length, 26, 'the audit found 26 detector classes')
	for (const spec of REGISTRY) {
		const d = constructDetector(spec.id, 'NSE:TEST-EQ')
		assert.equal(typeof d.analyze, 'function', `${spec.id} must implement analyze()`)
	}
})

test('registry: tier counts match the pruning decision', () => {
	const count = (t: string) => REGISTRY.filter((d) => d.tier === t).length
	assert.equal(count('ACTIVE'), 8)
	assert.equal(count('DORMANT'), 3)
	assert.equal(count('ARCHIVED_A'), 14)
	assert.equal(count('ARCHIVED_C'), 1)
})

test('registry: every not-backtestable detector states a reason', () => {
	for (const spec of REGISTRY) {
		if (!spec.backtestable) {
			assert.ok(
				spec.notBacktestableReason && spec.notBacktestableReason.length > 40,
				`${spec.id} must explain why it cannot be backtested`,
			)
		}
	}
})
