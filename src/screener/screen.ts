// ============================================================
// screener/screen.ts — the point-in-time screen (pure)
//
// screenAsOf(input) uses ONLY bars dated on or before input.asOf (IST). The cut
// happens here, once, with a binary search, so no indicator can see a later bar
// — tests/screener.test.ts mutates every bar after D and asserts the screen for
// D is byte-identical.
//
// "High alpha" = persistent outperformance vs the benchmark (RS rank + residual
// momentum), not volatility. Liquidity and ADR are hard filters, not alpha.
// ============================================================

import type { ScreenerConfig } from './config.js'
import {
	adrPct,
	alignedBenchmarkReturn,
	avgTurnover,
	avgVolume,
	BenchIndex,
	ema,
	istDay,
	looksCircuitLocked,
	percentileRanks,
	periodReturn,
	proximityToHigh,
	rangePct,
	residualMomentum,
	sma,
	type DailyBar,
} from './indicators.js'

export type ScreenerSource = 'CORE' | 'SCREENER_LEADER' | 'SCREENER_SETUP'
export type FetchOutcome = 'OK' | 'NO_DATA' | 'FAILED'

export interface ScreenInput {
	asOf: string // YYYY-MM-DD (IST). Bars after this day are invisible.
	universe: string[] // every symbol scanned
	series: Map<string, DailyBar[]>
	benchmark: DailyBar[]
	core: string[]
	/** Yesterday's list (symbol → source), for hysteresis. null on the first run. */
	previous: Map<string, ScreenerSource> | null
	fno: Set<string>
	/** Per-symbol fetch result; omitted in the backtest (everything is cached). */
	fetchOutcome?: Map<string, FetchOutcome>
	config: ScreenerConfig
	configHash: string
}

/**
 * Per-symbol record. The first four fields keep the legacy universe_stats.json
 * shape that anomalyScanner.ts reads (Layer B); the rest is v2.
 */
export interface SymbolRecord {
	advShares: number
	adr: number
	turnover: number
	close: number
	bars: number
	fno: boolean
	circuitLocked: boolean
	/** Has a bar dated exactly on the as-of day (false = suspended / stale / no data). */
	barOnAsOf: boolean
	liquid: boolean
	rsRaw: number | null
	rsRank: number | null
	residual: number | null
	residualRank: number | null
	beta: number | null
	proximityPct: number | null
	proximityRank: number | null
	score: number | null
	trend: boolean
	sma50Rising: boolean
	aboveEma50: boolean
	volumeOk: boolean
	tight: boolean
	surge: boolean
	eligible: boolean
	tier: 'TIER1' | 'TIER2' | null
	held: boolean
	source: ScreenerSource | null
	reasons: string[]
}

export interface WatchlistEntry {
	symbol: string
	source: ScreenerSource
	tier: 'TIER1' | 'TIER2' | null
	score: number | null
	held: boolean
	reason: string
}

export interface Funnel {
	scanned: number
	fetchedOk: number
	failed: number
	noData: number
	insufficientHistory: number
	afterLiquidity: number
	afterTrend: number
	afterRs: number
	tier1: number
	tier2: number
	held: number
	core: number
	final: number
	capped: number
	/** Symbols the quote pre-filter decided not to fetch (job with fetchQuotes only). */
	prefilterSkipped?: number
}

export interface ScreenResult {
	asOf: string
	configHash: string
	benchmark: string
	funnel: Funnel
	records: Record<string, SymbolRecord>
	entries: WatchlistEntry[]
	watchlist: string[]
	notes: string[]
}

const DAY_MS = 86_400_000
const IST_MS = 5.5 * 3600 * 1000

/** Index of the last bar with istDay(t) <= asOf (binary search), or −1. */
export const cutIndex = (bars: DailyBar[], asOf: string): number => {
	// End of asOf in IST, as epoch ms (exclusive).
	const endMs = Date.parse(`${asOf}T00:00:00Z`) - IST_MS + DAY_MS
	let lo = 0
	let hi = bars.length - 1
	let ans = -1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		if (bars[mid]!.t < endMs) {
			ans = mid
			lo = mid + 1
		} else hi = mid - 1
	}
	return ans
}

export const cutAsOf = (bars: DailyBar[], asOf: string): DailyBar[] => bars.slice(0, cutIndex(bars, asOf) + 1)

const cr = (rupees: number) => `₹${(rupees / 1e7).toFixed(1)}cr`
const f1 = (n: number) => n.toFixed(1)

export const screenAsOf = (input: ScreenInput): ScreenResult => {
	const { config: c, asOf } = input
	const bench = new BenchIndex(cutAsOf(input.benchmark, asOf))
	const records: Record<string, SymbolRecord> = {}
	const rsRaw = new Map<string, number>()
	const residRaw = new Map<string, number>()
	const proxRaw = new Map<string, number>()
	const [e1, e2, e3] = c.trend.emaPeriods as [number, number, number]
	const maxRs = Math.max(...c.relativeStrength.lookbacks)
	let noData = 0
	let failed = 0
	let insufficient = 0

	for (const symbol of input.universe) {
		const outcome = input.fetchOutcome?.get(symbol) ?? 'OK'
		if (outcome === 'FAILED') failed++
		const bars = cutAsOf(input.series.get(symbol) ?? [], asOf)
		const reasons: string[] = []
		const rec: SymbolRecord = {
			advShares: 0, adr: 0, turnover: 0, close: 0, bars: bars.length, fno: input.fno.has(symbol),
			circuitLocked: false, barOnAsOf: false, liquid: false, rsRaw: null, rsRank: null, residual: null, residualRank: null,
			beta: null, proximityPct: null, proximityRank: null, score: null, trend: false, sma50Rising: false,
			aboveEma50: false, volumeOk: false, tight: false, surge: false, eligible: false, tier: null,
			held: false, source: null, reasons,
		}
		records[symbol] = rec
		if (outcome === 'FAILED') {
			reasons.push('fetch failed after retries')
			continue
		}
		if (bars.length === 0) {
			noData++
			reasons.push('no daily bars on or before as-of date')
			continue
		}
		const lastBar = bars[bars.length - 1]!
		const stale = istDay(lastBar.t) !== asOf // suspended / not traded on the as-of date
		rec.barOnAsOf = !stale
		rec.close = lastBar.c
		rec.turnover = avgTurnover(bars, c.liquidity.turnoverLookbackBars)
		rec.advShares = avgVolume(bars, c.liquidity.turnoverLookbackBars) ?? 0
		rec.adr = adrPct(bars, c.tradability.adrLookbackBars) ?? 0
		rec.circuitLocked = looksCircuitLocked(lastBar)
		rec.liquid = rec.turnover >= c.liquidity.minAvgTurnoverRupees && rec.close >= c.liquidity.minPrice

		if (!rec.liquid)
			reasons.push(rec.close < c.liquidity.minPrice ? `price ₹${rec.close} < ₹${c.liquidity.minPrice}` : `turnover ${cr(rec.turnover)} < ${cr(c.liquidity.minAvgTurnoverRupees)}`)
		if (rec.circuitLocked) reasons.push('circuit-locked on as-of date (zero-range bar)')
		if (stale) reasons.push(`no bar on ${asOf} (last ${istDay(lastBar.t)}) — suspended or stale`)
		if (bars.length < Math.max(c.history.minBars, maxRs + 1)) {
			insufficient++
			reasons.push(`history ${bars.length} bars < ${Math.max(c.history.minBars, maxRs + 1)}`)
			continue
		}

		// Trend structure (fixed EMA window → identical live and in backtest)
		const closes = bars.map((b) => b.c)
		const win = closes.slice(-c.trend.emaWindowBars)
		const ma1 = ema(win, e1)
		const ma2 = ema(win, e2)
		const ma3 = ema(win, e3)
		const smaNow = sma(closes, c.trend.sma)
		const smaThen = sma(closes, c.trend.sma, c.trend.smaRisingLookbackBars)
		rec.sma50Rising = smaNow !== null && smaThen !== null && smaNow > smaThen
		rec.aboveEma50 = ma3 !== null && rec.close > ma3
		rec.trend = ma1 !== null && ma2 !== null && ma3 !== null && rec.close > ma1 && ma1 > ma2 && ma2 > ma3 && rec.sma50Rising

		// Relative strength: weighted excess return vs the benchmark over 1M/3M/6M
		let rs = 0
		let rsOk = true
		c.relativeStrength.lookbacks.forEach((n, i) => {
			const r = periodReturn(bars, n)
			const b = alignedBenchmarkReturn(bars, bench, n)
			if (r === null || b === null) rsOk = false
			else rs += c.relativeStrength.weights[i]! * (r - b)
		})
		const resid = residualMomentum(bars, bench, c.residualMomentum.lookbackBars)
		rec.proximityPct = proximityToHigh(bars, c.proximity.highLookbackBars)

		const volShort = avgVolume(bars, c.tradability.volumeShortBars)
		const volLong = avgVolume(bars, c.tradability.volumeLongBars)
		rec.volumeOk = volShort !== null && volLong !== null && volLong > 0 && volShort >= c.tradability.minVolumeRatio * volLong

		const range = rangePct(bars, c.tags.tightRangeBars)
		const vTight = avgVolume(bars, c.tags.tightVolumeBars)
		const vBase = avgVolume(bars, c.tags.tightVolumeBaseBars)
		rec.tight = range !== null && rec.adr > 0 && vTight !== null && vBase !== null && vBase > 0 &&
			range <= c.tags.tightMaxRangeAdrMultiple * rec.adr && vTight <= c.tags.tightMaxVolumeRatio * vBase
		const vPrior = avgVolume(bars, c.tags.tightVolumeBaseBars, 1)
		rec.surge = vPrior !== null && vPrior > 0 && lastBar.v >= c.tags.surgeVolumeMultiple * vPrior

		if (!rsOk || resid === null || rec.proximityPct === null) {
			insufficient++
			reasons.push('benchmark-aligned RS / residual not computable')
			continue
		}
		rec.rsRaw = rs
		rec.residual = resid.score
		rec.beta = resid.beta
		if (rec.liquid && !rec.circuitLocked && !stale) {
			rec.eligible = true
			rsRaw.set(symbol, rs)
			residRaw.set(symbol, resid.score)
			proxRaw.set(symbol, rec.proximityPct)
		}
	}

	// Cross-sectional ranks over the eligible set only
	const rsRank = percentileRanks(rsRaw)
	const residRank = percentileRanks(residRaw)
	const proxRank = percentileRanks(proxRaw)
	const t = c.tiers
	for (const [symbol] of rsRaw) {
		const rec = records[symbol]!
		rec.rsRank = rsRank.get(symbol)!
		rec.residualRank = residRank.get(symbol)!
		rec.proximityRank = proxRank.get(symbol)!
		rec.score = Math.round((c.score.rsWeight * rec.rsRank + c.score.residualWeight * rec.residualRank + c.score.proximityWeight * rec.proximityRank) * 10) / 10

		const nearHigh = rec.proximityPct! >= -c.proximity.maxBelowHighPct / 100
		const tradable = rec.adr >= c.tradability.minAdrPct && rec.volumeOk
		const checks = [
			`RS ${f1(rec.rsRank)}`, `resid ${f1(rec.residualRank)}`, `${f1(-rec.proximityPct! * 100)}% below 52w high`,
			`ADR ${f1(rec.adr)}%`, rec.trend ? 'trend ✓' : 'trend ✗', rec.volumeOk ? 'volume ✓' : 'volume collapsing',
		]
		if (rec.trend && rec.rsRank >= t.tier1MinRsRank && nearHigh && tradable) rec.tier = 'TIER1'
		else if (tradable && rec.rsRank >= t.tier2MinRsRank && rec.aboveEma50 && rec.sma50Rising && rec.tight) rec.tier = 'TIER2'
		rec.reasons.push(`${rec.tier ?? 'not tiered'}: ${checks.join(', ')}${rec.tight ? ', tight' : ''}${rec.surge ? ', volume surge' : ''}`)
	}

	// Hysteresis: yesterday's screener names stay while they hold up
	const held = new Set<string>()
	for (const [symbol, src] of input.previous ?? []) {
		if (src === 'CORE') continue
		const rec = records[symbol]
		if (rec?.eligible && rec.rsRank !== null && rec.rsRank >= t.holdMinRsRank && rec.aboveEma50) held.add(symbol)
	}

	// Fill: CORE → held (by score) → new Tier 1 → new Tier 2, up to the cap
	const byScore = (a: string, b: string) => (records[b]!.score ?? 0) - (records[a]!.score ?? 0) || a.localeCompare(b)
	const entries: WatchlistEntry[] = []
	const taken = new Set<string>()
	const push = (symbol: string, source: ScreenerSource, isHeld: boolean) => {
		const rec = records[symbol]
		taken.add(symbol)
		if (rec) {
			rec.source = source
			rec.held = isHeld
		}
		entries.push({
			symbol, source, tier: rec?.tier ?? null, score: rec?.score ?? null, held: isHeld,
			reason: source === 'CORE' ? 'core_watchlist.json (always listed)' : `${isHeld ? 'held (hysteresis); ' : ''}${rec?.reasons.at(-1) ?? ''}`,
		})
	}
	for (const s of input.core) if (!taken.has(s)) push(s, 'CORE', false)
	const room = () => input.config.watchlistCap - entries.length
	const heldSorted = [...held].filter((s) => !taken.has(s)).sort(byScore)
	const tier1 = Object.keys(records).filter((s) => records[s]!.tier === 'TIER1' && !held.has(s) && !taken.has(s)).sort(byScore)
	const tier2 = Object.keys(records).filter((s) => records[s]!.tier === 'TIER2' && !held.has(s) && !taken.has(s)).sort(byScore)
	let capped = 0
	for (const [list, kind] of [[heldSorted, 'held'], [tier1, 'TIER1'], [tier2, 'TIER2']] as const) {
		for (const s of list) {
			if (room() <= 0) {
				capped++
				continue
			}
			const rec = records[s]!
			const src: ScreenerSource =
				rec.tier === 'TIER1' ? 'SCREENER_LEADER' : rec.tier === 'TIER2' ? 'SCREENER_SETUP' : (input.previous?.get(s) as ScreenerSource) ?? 'SCREENER_LEADER'
			push(s, src, kind === 'held')
		}
	}

	const eligible = Object.values(records).filter((r) => r.eligible)
	const funnel: Funnel = {
		scanned: input.universe.length,
		fetchedOk: input.universe.length - failed - noData,
		failed,
		noData,
		insufficientHistory: insufficient,
		afterLiquidity: eligible.length,
		afterTrend: eligible.filter((r) => r.trend).length,
		afterRs: eligible.filter((r) => r.trend && (r.rsRank ?? 0) >= t.tier1MinRsRank).length,
		tier1: eligible.filter((r) => r.tier === 'TIER1').length,
		tier2: eligible.filter((r) => r.tier === 'TIER2').length,
		held: entries.filter((e) => e.held).length,
		core: entries.filter((e) => e.source === 'CORE').length,
		final: entries.length,
		capped,
	}

	return {
		asOf,
		configHash: input.configHash,
		benchmark: c.benchmark,
		funnel,
		records,
		entries,
		watchlist: entries.map((e) => e.symbol),
		notes: [`market cap: ${c.filters.marketCap}`, `ASM/GSM: ${c.filters.asmGsm}`, `series: ${c.filters.seriesNote}`],
	}
}

/** Legacy per-symbol shape the anomaly scanner reads. */
export interface LayerBStats {
	advShares: number
	adr: number
	turnover: number
	close: number
}

/**
 * Layer B (anomalyScanner) scan set = the BENCH: the next `layerB.maxSymbols`
 * names by screener score that did not make the watchlist (eligible, traded on
 * the as-of date, turnover >= the scanner's own floor). The engine subscribes
 * watchlist + bench + Nifty only — Fyers Standard allows 100 symbols per user —
 * so the bench is what anomaly promotion can draw from (owner's choice (b),
 * 2026-10-21: bench ~30, watchlist cap 60, options 0 → at most 91 of 100).
 * Movers outside watchlist + bench are not seen.
 */
export const anomalyUniverse = (r: ScreenResult, c: ScreenerConfig): Record<string, LayerBStats> => {
	const listed = new Set(r.watchlist)
	const picked = Object.entries(r.records)
		.filter(([sym, rec]) => !listed.has(sym) && rec.eligible && rec.score !== null && rec.barOnAsOf && rec.turnover >= c.layerB.minTurnoverRupees)
		.sort((a, b) => b[1].score! - a[1].score! || a[0].localeCompare(b[0]))
		.slice(0, c.layerB.maxSymbols)
	return Object.fromEntries(picked.map(([sym, rec]) => [sym, { advShares: rec.advShares, adr: rec.adr, turnover: rec.turnover, close: rec.close }]))
}

/**
 * The OLD Layer A rule (dailyScreener.ts before v2), point-in-time: 30-bar mean
 * turnover >= ₹15 cr AND 20-bar ADR >= 4.5%, needing >= 20 bars, plus CORE. No
 * cap, no ranking. Universe (a) of the backtest comparison — the old logic
 * without the old screener's random API losses.
 */
export const oldLayerA = (asOf: string, universe: string[], series: Map<string, DailyBar[]>, core: string[]): string[] => {
	const out = new Set(core)
	for (const symbol of universe) {
		const bars = cutAsOf(series.get(symbol) ?? [], asOf)
		if (bars.length < 20) continue
		if (avgTurnover(bars, 30) >= 15_000_000 * 10 && (adrPct(bars, 20) ?? 0) >= 4.5) out.add(symbol)
	}
	return [...out]
}

export { istDay }
