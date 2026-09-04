// ============================================================
// tests/backtestReplay.test.ts — end-to-end replay
//
// This is the test that proves the harness actually works: a synthetic session
// is pushed through the REAL detector classes, the REAL telegramWorker seam and
// the REAL JaneStreetFilter gating chain, with no Fyers token, no Redis server
// and no network.
//
// If these pass, the only thing standing between this harness and real numbers
// is historical data.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHANNEL_ID ??= '-1000000000000'
process.env.FYERS_APP_ID ??= 'TEST-APP-ID'
process.env.FYERS_SECRET_ID ??= 'test-secret'
process.env.FYERS_REDIRECT_URI ??= 'http://localhost:3000/callback'
// Must be set BEFORE telegramWorker is first imported: it reads the flag once
// at module load, so setting it later would leave the seam inert and the test
// would try to reach Telegram.
process.env.BACKTEST_MODE = 'true'

const clock = await import('../backtest/core/clock.js')
const { installMemoryRedis } = await import('../backtest/core/memoryRedis.js')
const { replaySession } = await import('../backtest/replay/engine.js')
const { syntheticSession, syntheticIndexSession } =
	await import('../backtest/fixtures/synthetic.js')
const { REGISTRY } = await import('../backtest/registry.js')
const { NIFTY_SYMBOL } = await import('../backtest/config.js')
const { simulateExit, resolveUnderlying } = await import('../backtest/sim/exit.js')
const { computeMetrics } = await import('../backtest/sim/metrics.js')
const { renderHtmlReport } = await import('../backtest/report/html.js')

const DATE = '2026-06-01'
const SPECS = REGISTRY.filter((s) => s.backtestable)

const buildSession = () =>
	new Map([
		[NIFTY_SYMBOL, syntheticIndexSession(DATE)],
		// TEJASNET is a clean name; RELIANCE is included deliberately to prove the
		// live misrouting is reproduced rather than silently corrected.
		['NSE:TEJASNET-EQ', syntheticSession({ date: DATE, basePrice: 520, seed: 11 })],
		['NSE:RELIANCE-EQ', syntheticSession({ date: DATE, basePrice: 1400, seed: 12 })],
	])

const runOnce = async () => {
	const bars = buildSession()
	const uninstallClock = clock.installVirtualClock(clock.istEpoch(DATE, 9 * 60 + 15))
	const { uninstall } = installMemoryRedis()
	try {
		return {
			result: await replaySession({ sessionDate: DATE, barsBySymbol: bars, specs: SPECS }),
			bars,
		}
	} finally {
		uninstall()
		uninstallClock()
	}
}

test('replay: dispatches every bar as 4 ticks and never violates chronology', async () => {
	const { result, bars } = await runOnce()
	const totalBars = [...bars.values()].reduce((s, b) => s + b.length, 0)

	assert.equal(result.barsReplayed, totalBars)
	assert.equal(result.ticksDispatched, totalBars * 4, 'every bar becomes exactly 4 ticks')
	// assertChronological runs inside replaySession and throws on violation, so
	// reaching here means the merged stream was ordered.
})

test('replay: real detectors fire through the real seam — signals are collected, not sent', async () => {
	const { result } = await runOnce()

	assert.ok(
		result.signals.length > 0,
		'the synthetic session is built to trigger an opening-range breakout; zero signals means the clock, the seam or the routing is broken',
	)

	// Every signal is attributed to a registered detector.
	const ids = new Set(SPECS.map((s) => s.id))
	for (const sig of result.signals) {
		assert.ok(ids.has(sig.detectorId), `unknown detector id ${sig.detectorId}`)
		assert.equal(sig.sessionDate, DATE)
		assert.ok(sig.payload.price > 0)
		assert.ok(sig.ts > 0)
	}
})

test('replay: every signal carries a gate decision scored at signal time', async () => {
	const { result } = await runOnce()
	assert.ok(result.signals.length > 0)

	for (const sig of result.signals) {
		assert.ok(sig.gate !== null, `signal from ${sig.detectorId} has no gate outcome`)
		const g = sig.gate!
		assert.ok(g.score >= 0 && g.score <= 100, `score out of range: ${g.score}`)
		assert.ok(g.posterior >= 0 && g.posterior <= 1)
		assert.ok(['trending', 'transition', 'ranging'].includes(g.regime), `bad regime ${g.regime}`)
		assert.equal(typeof g.passed, 'boolean')
	}
})

test('replay: ACTIVE detectors are classified from their EXPLICIT tag, not guessed', async () => {
	const { result } = await runOnce()
	const activeIds = new Set(REGISTRY.filter((s) => s.tier === 'ACTIVE').map((s) => s.id))
	const fromActive = result.signals.filter((s) => activeIds.has(s.detectorId))

	if (fromActive.length === 0) return // nothing to assert this session

	for (const sig of fromActive) {
		assert.equal(
			sig.gate?.classificationSource,
			'explicit',
			`${sig.detectorId} should carry a regimeClass tag — falling back to '${sig.gate?.classificationSource}' means the tag was dropped`,
		)
	}
})

test('replay: reproduces the live CE/PE misrouting instead of silently fixing it', async () => {
	const { result } = await runOnce()

	assert.deepEqual(
		result.misroutedSymbols,
		['NSE:RELIANCE-EQ'],
		'RELIANCE must be reported as misrouted by the live substring test',
	)
	// And it must genuinely produce nothing, exactly as in production.
	const fromReliance = result.signals.filter((s) => s.payload.symbol === 'NSE:RELIANCE-EQ')
	assert.equal(
		fromReliance.length,
		0,
		'RELIANCE is swallowed by the option branch in live, so it must yield no equity signals here either',
	)
})

test('replay: a second session starts from a genuinely blank slate', async () => {
	// Cooldowns are Redis TTL keys and detectors hold in-memory candle state.
	// If either leaked across sessions, run 2 would differ from run 1.
	const a = await runOnce()
	const b = await runOnce()
	assert.equal(
		b.result.signals.length,
		a.result.signals.length,
		'identical input must give identical output — a difference means state leaked between sessions',
	)
})

test('replay: no detector throws during a full session', async () => {
	const { result } = await runOnce()
	assert.deepEqual(
		[...result.errors.entries()],
		[],
		'a detector threw while analysing synthetic bars',
	)
})

test('pipeline: signals → exits → metrics → HTML report', async () => {
	const { result, bars } = await runOnce()

	const tradesById = new Map<string, ReturnType<typeof simulateExit>[]>()
	for (const sig of result.signals) {
		// Rejected signals are simulated too — they populate the ungated block.
		const underlying = resolveUnderlying(sig.payload.symbol)
		const series = bars.get(underlying)
		if (!series) continue
		const trade = simulateExit(
			sig,
			series.filter((b) => b.t > sig.ts),
			underlying,
		)
		if (!trade) continue
		const list = tradesById.get(sig.detectorId) ?? []
		list.push(trade)
		tradesById.set(sig.detectorId, list)
	}

	const metrics = SPECS.map((spec) =>
		computeMetrics(
			spec,
			result.signals.filter((s) => s.detectorId === spec.id).length,
			{},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(tradesById.get(spec.id) ?? []) as any,
		),
	)

	// Every R must be a real number — an infinite or NaN R would poison the
	// expectancy of everything downstream.
	for (const m of metrics) {
		for (const block of [m.gated, m.ungated]) {
			for (const r of block.rDistribution) {
				assert.ok(Number.isFinite(r), `${m.detectorId} produced a non-finite R: ${r}`)
			}
			assert.ok(Number.isFinite(block.totalR))
			assert.ok(block.maxDrawdownR >= 0, 'drawdown is a magnitude and cannot be negative')
		}
		// Gated is a subset of ungated, always.
		assert.ok(
			m.gated.trades <= m.ungated.trades,
			`${m.detectorId}: gated (${m.gated.trades}) cannot exceed ungated (${m.ungated.trades})`,
		)
	}

	const html = renderHtmlReport({
		generatedAt: new Date().toISOString(),
		run: {
			sessions: 1,
			firstSession: DATE,
			lastSession: DATE,
			symbols: bars.size,
			barsReplayed: result.barsReplayed,
			ticksDispatched: result.ticksDispatched,
			wallClockSeconds: 0,
		},
		assumptions: { slippageBps: 5, note: 'synthetic' },
		metrics,
		notBacktestable: REGISTRY.filter((s) => !s.backtestable).map((s) => ({
			id: s.id,
			displayName: s.displayName,
			tier: s.tier,
			reason: s.notBacktestableReason,
		})),
		detectorErrors: {},
		registry: REGISTRY,
	})

	assert.match(html, /<title>Detector Backtest Report<\/title>/)
	assert.match(html, /Pruning re-evaluation/)
	assert.match(html, /Simulation assumptions/)
	assert.match(html, /Not backtestable/)
	assert.ok(html.includes('prefers-color-scheme'), 'report must be theme-aware')
	assert.ok(!html.includes('<script src'), 'report must be self-contained — no external scripts')
	assert.ok(html.length > 20_000, 'report looks truncated')
})
