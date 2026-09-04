// ============================================================
// backtest/demo.ts — render the report from SYNTHETIC data
//
//   npx tsx backtest/demo.ts
//
// Why this exists: a real run needs a Fyers access token, and the report format
// is worth reviewing before spending an overnight fetch on it. This drives the
// exact same replay → gate → exit → metrics → report pipeline as `run.ts`, but
// over generated bars.
//
// THE NUMBERS IN THE OUTPUT ARE MEANINGLESS. They describe a sine wave with a
// scripted breakout, not the market. The output is banner-marked as such. Use
// it to judge the report, never the strategies.
// ============================================================

// MUST come first — see core/bootEnv.ts.
import './core/bootEnv.js'

import fs from 'fs'
import path from 'path'
import { NIFTY_SYMBOL, OUTPUT_DIR, METRICS, SIM } from './config.js'
import { installVirtualClock, istEpoch, realNow, setVirtualNow } from './core/clock.js'
import { installMemoryRedis } from './core/memoryRedis.js'
import { misroutedByLiveTest } from './core/symbolClass.js'
import { REGISTRY, notBacktestable } from './registry.js'
import { syntheticIndexSession, syntheticSession } from './fixtures/synthetic.js'
import { replaySession } from './replay/engine.js'
import { resolveUnderlying, simulateExit, type SimulatedTrade } from './sim/exit.js'
import { computeMetrics, rankByExpectancy } from './sim/metrics.js'
import { renderHtmlReport } from './report/html.js'

const SESSIONS = 40
const SYMBOLS = ['NSE:TEJASNET-EQ', 'NSE:KAYNES-EQ', 'NSE:DIXON-EQ', 'NSE:RELIANCE-EQ']
const BASE_PRICES: Record<string, number> = {
	'NSE:TEJASNET-EQ': 520,
	'NSE:KAYNES-EQ': 6100,
	'NSE:DIXON-EQ': 15400,
	'NSE:RELIANCE-EQ': 1400,
}

const sessionDates = (n: number): string[] => {
	// Weekdays counting back from a fixed anchor, so the demo is reproducible.
	const out: string[] = []
	const d = new Date(Date.UTC(2026, 5, 26))
	while (out.length < n) {
		const dow = d.getUTCDay()
		if (dow !== 0 && dow !== 6) out.push(d.toISOString().split('T')[0]!)
		d.setUTCDate(d.getUTCDate() - 1)
	}
	return out.reverse()
}

const main = async (): Promise<void> => {
	if (process.env.BACKTEST_MODE !== 'true') {
		throw new Error('run with BACKTEST_MODE=true')
	}
	fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	const specs = REGISTRY.filter((s) => s.backtestable)
	const days = sessionDates(SESSIONS)

	const signalsUngated = new Map<string, number>()
	const rejections = new Map<string, Record<string, number>>()
	const trades = new Map<string, SimulatedTrade[]>()
	const errors = new Map<string, string>()
	let barsReplayed = 0
	let ticksDispatched = 0

	const { uninstall: uninstallRedis } = installMemoryRedis()
	const uninstallClock = installVirtualClock(istEpoch(days[0]!, 9 * 60 + 15))
	const started = realNow()

	try {
		for (const [i, day] of days.entries()) {
			setVirtualNow(istEpoch(day, 9 * 60 + 15))

			const barsBySymbol = new Map([[NIFTY_SYMBOL, syntheticIndexSession(day, 24_000 + i * 15)]])
			for (const [j, sym] of SYMBOLS.entries()) {
				barsBySymbol.set(
					sym,
					syntheticSession({
						date: day,
						basePrice: BASE_PRICES[sym]! * (1 + i * 0.002),
						seed: i * 100 + j,
						// Vary the shape so the R distribution is not a single spike.
						breakoutAtMinute: i % 4 === 3 ? null : 18 + (i % 5),
						drift: ((i % 7) - 2) * 0.004,
					}),
				)
			}

			const result = await replaySession({ sessionDate: day, barsBySymbol, specs })
			barsReplayed += result.barsReplayed
			ticksDispatched += result.ticksDispatched
			for (const [id, msg] of result.errors) if (!errors.has(id)) errors.set(id, msg)

			for (const sig of result.signals) {
				signalsUngated.set(sig.detectorId, (signalsUngated.get(sig.detectorId) ?? 0) + 1)

				// Rejected signals are still simulated — they populate the ungated
				// block (see sim/metrics.ts).
				if (sig.gate && !sig.gate.passed) {
					const key = sig.gate.rejectedAt ?? 'below-threshold'
					const rej = rejections.get(sig.detectorId) ?? {}
					rej[key] = (rej[key] ?? 0) + 1
					rejections.set(sig.detectorId, rej)
				}

				const underlying = resolveUnderlying(sig.payload.symbol)
				const series = barsBySymbol.get(underlying)
				if (!series) continue
				const trade = simulateExit(
					sig,
					series.filter((b) => b.t > sig.ts),
					underlying,
				)
				if (!trade) continue
				const list = trades.get(sig.detectorId) ?? []
				list.push(trade)
				trades.set(sig.detectorId, list)
			}

			if ((i + 1) % 10 === 0) console.log(`[demo] ${i + 1}/${days.length} sessions`)
		}
	} finally {
		uninstallClock()
		uninstallRedis()
	}

	const metrics = specs.map((spec) =>
		computeMetrics(
			spec,
			signalsUngated.get(spec.id) ?? 0,
			rejections.get(spec.id) ?? {},
			trades.get(spec.id) ?? [],
		),
	)

	const html = renderHtmlReport({
		generatedAt: new Date().toISOString(),
		banner: {
			title: 'SYNTHETIC DATA — these numbers are not results.',
			body: 'This report was generated from generated price series (a sine-wave opening range with a scripted breakout), not from market history. It exists to review the report format and to prove the harness runs end to end. Every win rate, expectancy and equity curve below is an artefact of the generator. Real numbers require a Fyers access token: run `npx tsx backtest/run.ts fetch` then `run`.',
		},
		run: {
			sessions: days.length,
			firstSession: days[0]!,
			lastSession: days[days.length - 1]!,
			symbols: SYMBOLS.length + 1,
			barsReplayed,
			ticksDispatched,
			wallClockSeconds: Math.round((realNow() - started) / 1000),
		},
		assumptions: {
			DATA_SOURCE: 'SYNTHETIC — not market data',
			slippageBps: SIM.slippageBps,
			pessimisticIntraBar: SIM.pessimisticIntraBar,
			defaultStopPct: SIM.defaultStopPct,
			defaultTargetR: SIM.defaultTargetR,
			forceExitIst: '15:15',
			circuitLockProxy: 'zero-range bar with non-zero volume',
			minGatedTradesForConfidence: METRICS.minGatedTradesForConfidence,
			ticksPerBar: 4,
			intraBarPath: 'bullish O→L→H→C, bearish O→H→L→C',
		},
		metrics: rankByExpectancy(metrics),
		notBacktestable: notBacktestable().map((d) => ({
			id: d.id,
			displayName: d.displayName,
			tier: d.tier,
			reason: d.notBacktestableReason,
		})),
		detectorErrors: Object.fromEntries(errors),
		registry: REGISTRY,
		misroutedSymbols: misroutedByLiveTest(SYMBOLS),
	})

	const out = path.join(OUTPUT_DIR, 'sample-report.html')
	fs.writeFileSync(out, html)
	console.log(`\n[demo] ${out}`)
	console.log(
		`[demo] ${barsReplayed.toLocaleString()} bars · ${ticksDispatched.toLocaleString()} ticks · ${[...signalsUngated.values()].reduce((a, b) => a + b, 0)} raw signals in ${Math.round((realNow() - started) / 1000)}s`,
	)
	// Gate diagnostics. Not decoration: if the filter rejects nearly everything,
	// the per-detector cards are all empty and the report looks broken when in
	// fact the gate is simply doing its job (or is mistuned). Printing the
	// breakdown is what distinguishes those two cases.
	const allRej: Record<string, number> = {}
	for (const r of rejections.values()) {
		for (const [k, v] of Object.entries(r)) allRej[k] = (allRej[k] ?? 0) + v
	}
	const totalSignals = [...signalsUngated.values()].reduce((a, b) => a + b, 0)
	const totalGated = metrics.reduce((a, m) => a + m.tradesGated, 0)
	console.log(
		`[demo] gate: ${totalGated}/${totalSignals} passed (${totalSignals ? ((totalGated / totalSignals) * 100).toFixed(1) : '0'}%)`,
	)
	console.log(
		`[demo] rejections: ${Object.entries(allRej)
			.sort((a, b) => b[1] - a[1])
			.map(([k, v]) => `${k}=${v}`)
			.join(' ')}`,
	)
	console.log(
		`[demo] sufficient sample — gated: ${metrics.filter((m) => m.gated.sufficientSample).length}/${metrics.length} · ungated: ${metrics.filter((m) => m.ungated.sufficientSample).length}/${metrics.length}`,
	)
	console.log('\n[demo] per-detector gate outcome (tier · signals · top rejection)')
	for (const m of rankByExpectancy(metrics)) {
		if (m.signalsUngated === 0) continue
		const top = Object.entries(m.rejections).sort((a, b) => b[1] - a[1])[0]
		console.log(
			`  ${m.displayName.padEnd(40).slice(0, 40)} ${m.tier.padEnd(11)} ${String(m.signalsUngated).padStart(4)} sig  ${String(m.tradesGated).padStart(3)} gated  ungatedE[R]=${m.ungated.expectancyR === null ? '—' : m.ungated.expectancyR.toFixed(3)}  ${top ? `${top[0]} x${top[1]}` : ''}`,
		)
	}
	console.log('\n[demo] REMINDER: synthetic input — the numbers are not results.')
}

main().catch((err) => {
	console.error('[demo] FAILED:', err instanceof Error ? err.message : err)
	process.exitCode = 1
})
