// ============================================================
// backtest/studies/edge-map/collect.ts — signal collection for the edge-map study
//
//   BACKTEST_MODE=true npx tsx backtest/studies/edge-map/collect.ts <out.jsonl> [from] [to]
//
// Replays the cached sessions (harness default resolution) through the two live equity
// detectors and the real filter, exactly as backtest/run.ts cmdRun does, but writes EVERY
// signal with its gate outcome and payload (price, VWAP, side, trigger) instead of simulating
// exits. Exits are re-simulated per stop rule in analyze.ts (PREREGISTRATION.md §2.3).
// Sessions are independent (fresh state per session), so date ranges can run in parallel.
// ============================================================
import '../../core/bootEnv.js'
import fs from 'fs'
import { DATA, NIFTY_SYMBOL } from '../../config.js'
import { installVirtualClock, istDateStringOf, istEpoch } from '../../core/clock.js'
import { installMemoryRedis } from '../../core/memoryRedis.js'
import { REGISTRY } from '../../registry.js'
import { barsInRange, loadSeries, type Bar } from '../../data/store.js'
import { replaySession } from '../../replay/engine.js'

export const STUDY_DETECTORS = ['volatility_contraction', 'stock_momentum_breakout']
const DAY_MS = 24 * 60 * 60 * 1000

const main = async (): Promise<void> => {
	if (process.env.BACKTEST_MODE !== 'true') throw new Error('BACKTEST_MODE=true is required (telegram seam)')
	const [out, from = '2021-07-05', to = '2026-09-04'] = process.argv.slice(2)
	if (!out) throw new Error('usage: collect.ts <out.jsonl> [from] [to]')

	const daily = loadSeries(NIFTY_SYMBOL, DATA.dailyResolution)
	if (!daily?.bars.length) throw new Error('no daily Nifty series in the cache')
	const days = [...new Set(daily.bars.map((b) => istDateStringOf(b.t)))].sort().filter((d) => d >= from && d <= to)

	const symbols = fs.readdirSync(`backtest/data/cache/res-${DATA.intradayResolution}`)
		.filter((f) => f.endsWith('.json'))
		.map((f) => (JSON.parse(fs.readFileSync(`backtest/data/cache/res-${DATA.intradayResolution}/${f}`, 'utf8')) as { symbol: string }).symbol)
	const seriesCache = new Map<string, Bar[]>()
	for (const s of symbols) {
		const series = loadSeries(s, DATA.intradayResolution)
		if (series?.bars.length) seriesCache.set(s, series.bars)
	}
	if (!seriesCache.has(NIFTY_SYMBOL)) throw new Error('no intraday Nifty series in the cache')
	const specs = REGISTRY.filter((s) => s.backtestable && STUDY_DETECTORS.includes(s.id))
	if (specs.length !== STUDY_DETECTORS.length) throw new Error(`detector specs missing: got ${specs.map((s) => s.id)}`)

	console.log(`[collect] ${days.length} sessions ${days[0]} → ${days[days.length - 1]} · ${seriesCache.size - 1} stocks + Nifty · res ${DATA.intradayResolution} · ${specs.map((s) => s.id).join(', ')}`)
	const fd = fs.openSync(out, 'w')
	const { uninstall: uninstallRedis } = installMemoryRedis()
	const uninstallClock = installVirtualClock(istEpoch(days[0]!, 9 * 60 + 15))
	let n = 0
	try {
		for (const [i, day] of days.entries()) {
			const dayStart = istEpoch(day, 0)
			const barsBySymbol = new Map<string, Bar[]>()
			for (const [symbol, bars] of seriesCache) {
				const slice = barsInRange(bars, dayStart, dayStart + DAY_MS)
				if (slice.length > 0) barsBySymbol.set(symbol, slice)
			}
			if (!barsBySymbol.has(NIFTY_SYMBOL)) continue
			const result = await replaySession({ sessionDate: day, barsBySymbol, specs })
			for (const s of result.signals) {
				fs.writeSync(fd, JSON.stringify({
					det: s.detectorId, day: s.sessionDate, ts: s.ts, symbol: s.payload.symbol, side: s.payload.side,
					price: s.payload.price, vwap: s.payload.vwap, trigger: s.payload.trigger,
					gate: s.gate, gateError: s.gateError ?? null,
				}) + '\n')
				n++
			}
			for (const [id, msg] of result.errors) console.warn(`[collect] ${day} ${id} threw: ${msg}`)
			if ((i + 1) % 20 === 0) console.log(`[collect] ${i + 1}/${days.length} sessions · ${n} signals`)
		}
	} finally {
		uninstallClock()
		uninstallRedis()
		fs.closeSync(fd)
	}
	console.log(`[collect] done: ${days.length} sessions, ${n} signals → ${out}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
