// ============================================================
// backtest/run.ts — CLI entry point
//
//   npx tsx backtest/run.ts fetch            # populate the candle cache
//   npx tsx backtest/run.ts run              # replay + simulate + report
//   npx tsx backtest/run.ts run --days 20    # limit sessions (smoke run)
//   npx tsx backtest/run.ts report           # rebuild HTML from results.json
//   npx tsx backtest/run.ts cache            # what's in the cache
//
// BACKTEST_MODE=true is required and is asserted below — without it the
// telegramWorker seam stays inert and detector signals would be dispatched to
// Telegram instead of collected.
// ============================================================

// MUST come first — see core/bootEnv.ts.
import './core/bootEnv.js'

import fs from 'fs'
import path from 'path'
import { DATA, METRICS, NIFTY_SYMBOL, OUTPUT_DIR, SIM, filterEnvSnapshot } from './config.js'
import { installVirtualClock, istDateStringOf, istEpoch, realNow } from './core/clock.js'
import { installMemoryRedis } from './core/memoryRedis.js'
import { REGISTRY, notBacktestable, type DetectorSpec } from './registry.js'
import { barsInRange, cacheReport, ensureDirs, loadSeries, type Bar } from './data/store.js'
import { fetchUniverse } from './data/fyersClient.js'
import { replaySession } from './replay/engine.js'
import { resolveUnderlying, simulateExit, type SimulatedTrade } from './sim/exit.js'
import { computeMetrics, rankByExpectancy, type DetectorMetrics } from './sim/metrics.js'
import { renderHtmlReport } from './report/html.js'

const DAY_MS = 24 * 60 * 60 * 1000
const RESULTS_JSON = path.join(OUTPUT_DIR, 'results.json')
const REPORT_HTML = path.join(OUTPUT_DIR, 'backtest-report.html')

const loadWatchlist = (): string[] => {
	const p = path.resolve(process.cwd(), 'watchlist.json')
	const list = JSON.parse(fs.readFileSync(p, 'utf8')) as string[]
	return list.slice(0, 100) // same slice the live engine applies
}

// ── fetch ───────────────────────────────────────────────────────────────────
const cmdFetch = async (): Promise<void> => {
	ensureDirs()
	const symbols = loadWatchlist()
	const to = realNow()
	// Calendar days, generously padded so the window contains at least the
	// requested number of TRADING days.
	const from = to - Math.ceil(DATA.lookbackTradingDays * 1.5) * DAY_MS

	console.log(
		`[fetch] window ${istDateStringOf(from)} → ${istDateStringOf(to)} for ${symbols.length} symbols + Nifty`,
	)

	// Daily first: it is cheap and gives the trading-day calendar the replay
	// iterates over.
	await fetchUniverse([NIFTY_SYMBOL, ...symbols], DATA.dailyResolution, from, to)
	await fetchUniverse([NIFTY_SYMBOL, ...symbols], DATA.intradayResolution, from, to)

	console.log('\n[fetch] cache now holds:')
	for (const r of cacheReport()) {
		console.log(`  res=${r.resolution}: ${r.symbols} symbols, ${r.bars.toLocaleString()} bars`)
	}
}

// ── trading calendar ────────────────────────────────────────────────────────
/**
 * Trading days come from the NIFTY DAILY series, not from a generated weekday
 * list — that way NSE holidays are excluded automatically instead of being
 * hardcoded.
 */
const tradingDays = (limit?: number): string[] => {
	const daily = loadSeries(NIFTY_SYMBOL, DATA.dailyResolution)
	if (!daily || daily.bars.length === 0) {
		throw new Error(
			`No daily series cached for ${NIFTY_SYMBOL}. Run \`npx tsx backtest/run.ts fetch\` first.`,
		)
	}
	const days = daily.bars.map((b) => istDateStringOf(b.t))
	const unique = [...new Set(days)].sort()
	return limit ? unique.slice(-limit) : unique
}

// ── run ─────────────────────────────────────────────────────────────────────
interface RunAccumulator {
	signalsUngated: Map<string, number>
	rejections: Map<string, Record<string, number>>
	trades: Map<string, SimulatedTrade[]>
	errors: Map<string, string>
	sessionsReplayed: number
	barsReplayed: number
	ticksDispatched: number
}

const cmdRun = async (dayLimit?: number): Promise<void> => {
	if (process.env.BACKTEST_MODE !== 'true') {
		throw new Error(
			'BACKTEST_MODE=true is required. Without it the telegramWorker seam is inert and detector signals would be DISPATCHED TO TELEGRAM instead of collected.',
		)
	}

	fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	const symbols = loadWatchlist()
	const days = tradingDays(dayLimit)
	const specs = REGISTRY.filter((s) => s.backtestable)

	console.log(`[run] ${days.length} sessions × ${specs.length} backtestable detectors`)
	console.log(`[run] ${notBacktestable().length} detector(s) reported as NOT BACKTESTABLE`)
	console.log(`[run] sessions ${days[0]} → ${days[days.length - 1]}`)

	// Preload every series once; slicing per day is a binary search, not a re-read.
	const seriesCache = new Map<string, Bar[]>()
	for (const symbol of [NIFTY_SYMBOL, ...symbols]) {
		const s = loadSeries(symbol, DATA.intradayResolution)
		if (s && s.bars.length > 0) seriesCache.set(symbol, s.bars)
	}
	if (!seriesCache.has(NIFTY_SYMBOL)) {
		throw new Error(
			`No intraday series cached for ${NIFTY_SYMBOL}. Every detector depends on the Nifty reference — run \`fetch\` first.`,
		)
	}
	console.log(`[run] intraday series loaded for ${seriesCache.size} symbols`)

	const acc: RunAccumulator = {
		signalsUngated: new Map(),
		rejections: new Map(),
		trades: new Map(),
		errors: new Map(),
		sessionsReplayed: 0,
		barsReplayed: 0,
		ticksDispatched: 0,
	}

	const { uninstall: uninstallRedis } = installMemoryRedis()
	const uninstallClock = installVirtualClock(istEpoch(days[0]!, 9 * 60 + 15))
	const startedAt = realNow()

	try {
		for (const day of days) {
			const dayStart = istEpoch(day, 0)
			const dayEnd = dayStart + DAY_MS

			const barsBySymbol = new Map<string, Bar[]>()
			for (const [symbol, bars] of seriesCache) {
				const slice = barsInRange(bars, dayStart, dayEnd)
				if (slice.length > 0) barsBySymbol.set(symbol, slice)
			}
			if (!barsBySymbol.has(NIFTY_SYMBOL)) continue // no index data ⇒ cannot judge context

			const result = await replaySession({ sessionDate: day, barsBySymbol, specs })
			acc.sessionsReplayed++
			acc.barsReplayed += result.barsReplayed
			acc.ticksDispatched += result.ticksDispatched
			for (const [id, msg] of result.errors) if (!acc.errors.has(id)) acc.errors.set(id, msg)

			// ── outcome simulation, per signal, within the same session ───────
			for (const signal of result.signals) {
				acc.signalsUngated.set(
					signal.detectorId,
					(acc.signalsUngated.get(signal.detectorId) ?? 0) + 1,
				)

				// Record the rejection, then simulate the exit ANYWAY. The trade
				// carries gatePassed=false, so it lands in the ungated block only.
				// Skipping it here was the original design and it left the report
				// blank whenever the filter suppressed a detector entirely — which
				// is exactly the case the gated/ungated comparison exists to expose.
				if (signal.gate && !signal.gate.passed) {
					const key = signal.gate.rejectedAt ?? 'below-threshold'
					const rej = acc.rejections.get(signal.detectorId) ?? {}
					rej[key] = (rej[key] ?? 0) + 1
					acc.rejections.set(signal.detectorId, rej)
				}

				const underlying = resolveUnderlying(signal.payload.symbol)
				const series = barsBySymbol.get(underlying)
				if (!series) continue

				// Strictly AFTER the signal: the entry bar itself is not replayed
				// for exits, or the same bar that triggered could also resolve it.
				const forward = series.filter((b) => b.t > signal.ts)
				const trade = simulateExit(signal, forward, underlying)
				if (!trade) continue

				const list = acc.trades.get(signal.detectorId) ?? []
				list.push(trade)
				acc.trades.set(signal.detectorId, list)
			}

			if (acc.sessionsReplayed % 10 === 0) {
				const secs = ((realNow() - startedAt) / 1000).toFixed(0)
				const sig = [...acc.signalsUngated.values()].reduce((a, b) => a + b, 0)
				console.log(
					`[run] ${acc.sessionsReplayed}/${days.length} sessions · ${acc.ticksDispatched.toLocaleString()} ticks · ${sig} raw signals · ${secs}s`,
				)
			}
		}
	} finally {
		uninstallClock()
		uninstallRedis()
	}

	// ── aggregate ──────────────────────────────────────────────────────────
	const metrics: DetectorMetrics[] = specs.map((spec: DetectorSpec) =>
		computeMetrics(
			spec,
			acc.signalsUngated.get(spec.id) ?? 0,
			acc.rejections.get(spec.id) ?? {},
			acc.trades.get(spec.id) ?? [],
		),
	)

	const payload = {
		generatedAt: new Date().toISOString(),
		run: {
			sessions: acc.sessionsReplayed,
			firstSession: days[0] ?? '',
			lastSession: days[days.length - 1] ?? '',
			symbols: seriesCache.size,
			barsReplayed: acc.barsReplayed,
			ticksDispatched: acc.ticksDispatched,
			wallClockSeconds: Math.round((realNow() - startedAt) / 1000),
		},
		assumptions: {
			slippageBps: SIM.slippageBps,
			pessimisticIntraBar: SIM.pessimisticIntraBar,
			defaultStopPct: SIM.defaultStopPct,
			defaultTargetR: SIM.defaultTargetR,
			forceExitIst: '15:15',
			circuitLockProxy: 'zero-range bar with non-zero volume',
			minGatedTradesForConfidence: METRICS.minGatedTradesForConfidence,
			ticksPerBar: 4,
			intraBarPath: 'bullish O→L→H→C, bearish O→H→L→C',
			filter: filterEnvSnapshot(),
		},
		metrics: rankByExpectancy(metrics),
		notBacktestable: notBacktestable().map((d) => ({
			id: d.id,
			displayName: d.displayName,
			tier: d.tier,
			reason: d.notBacktestableReason,
		})),
		detectorErrors: Object.fromEntries(acc.errors),
		registry: REGISTRY,
	}

	fs.writeFileSync(RESULTS_JSON, JSON.stringify(payload, null, 2))
	console.log(`\n[run] results → ${RESULTS_JSON}`)

	fs.writeFileSync(REPORT_HTML, renderHtmlReport(payload))
	console.log(`[run] report  → ${REPORT_HTML}`)

	printConsoleSummary(payload.metrics)
}

const printConsoleSummary = (metrics: DetectorMetrics[]): void => {
	const pad = (s: string, n: number) => s.padEnd(n).slice(0, n)
	console.log()
	console.log('── ranked by GATED expectancy (insufficient-sample rows last) ──')
	console.log(
		`${pad('detector', 38)} ${pad('tier', 11)} ${pad('signals', 8)} ${pad('gated', 6)} ${pad('pass%', 6)} ${pad('win%', 6)} ${pad('E[R]g', 8)} ${pad('E[R]u', 8)} sample`,
	)
	for (const m of metrics) {
		console.log(
			`${pad(m.displayName, 38)} ${pad(m.tier, 11)} ${pad(String(m.signalsUngated), 8)} ${pad(String(m.tradesGated), 6)} ${pad((m.gatePassRate * 100).toFixed(0), 6)} ${pad(m.gated.winRate === null ? '—' : (m.gated.winRate * 100).toFixed(0), 6)} ${pad(m.gated.expectancyR === null ? '—' : m.gated.expectancyR.toFixed(3), 8)} ${pad(m.ungated.expectancyR === null ? '—' : m.ungated.expectancyR.toFixed(3), 8)} ${m.sufficientSample ? 'ok' : 'INSUFFICIENT'}`,
		)
	}

	// The gate's aggregate behaviour is the headline of the whole exercise: a
	// pass rate near zero means the report is measuring the filter, not the
	// strategies, and that has to be visible without opening the HTML.
	const totalSignals = metrics.reduce((a, m) => a + m.signalsUngated, 0)
	const totalGated = metrics.reduce((a, m) => a + m.tradesGated, 0)
	const rej: Record<string, number> = {}
	for (const m of metrics) {
		for (const [k, v] of Object.entries(m.rejections)) rej[k] = (rej[k] ?? 0) + v
	}
	console.log(
		`
gate: ${totalGated}/${totalSignals} signals passed (${totalSignals ? ((totalGated / totalSignals) * 100).toFixed(1) : '0'}%)`,
	)
	console.log(
		`rejections: ${Object.entries(rej)
			.sort((a, b) => b[1] - a[1])
			.map(([k, v]) => `${k}=${v}`)
			.join(' ')}`,
	)
	console.log(
		`sufficient sample — gated: ${metrics.filter((m) => m.gated.sufficientSample).length}/${metrics.length} · ungated: ${metrics.filter((m) => m.ungated.sufficientSample).length}/${metrics.length}`,
	)
}

// ── report-only ─────────────────────────────────────────────────────────────
const cmdReport = (): void => {
	if (!fs.existsSync(RESULTS_JSON)) {
		throw new Error(`No ${RESULTS_JSON}. Run \`npx tsx backtest/run.ts run\` first.`)
	}
	const payload = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8'))
	fs.writeFileSync(REPORT_HTML, renderHtmlReport(payload))
	console.log(`[report] → ${REPORT_HTML}`)
}

// ── main ────────────────────────────────────────────────────────────────────
const main = async (): Promise<void> => {
	const [cmd, ...rest] = process.argv.slice(2)
	const daysFlag = rest.indexOf('--days')
	const dayLimit = daysFlag >= 0 ? Number(rest[daysFlag + 1]) : undefined

	switch (cmd) {
		case 'fetch':
			await cmdFetch()
			break
		case 'run':
			await cmdRun(dayLimit)
			break
		case 'report':
			cmdReport()
			break
		case 'cache':
			console.log(cacheReport())
			break
		default:
			console.log('usage: npx tsx backtest/run.ts <fetch|run|report|cache> [--days N]')
			process.exitCode = 1
	}
}

main().catch((err) => {
	console.error('\n[backtest] FAILED:', err instanceof Error ? err.message : err)
	process.exitCode = 1
})
