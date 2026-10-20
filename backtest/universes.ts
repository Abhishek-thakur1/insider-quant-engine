// ============================================================
// backtest/universes.ts — point-in-time watchlists for the universe comparison
//
// For every trading day D in the window, the list used to TRADE on D is screened
// as of the previous trading day D−1 (the live job runs at 16:30 on D−1), from
// daily bars only — screenAsOf() cuts every series at its as-of date.
//
//   old       old Layer A rule (turnover >= ₹15 cr, ADR >= 4.5%) + CORE, no cap
//   new       screener v2 Tier 1 + Tier 2 + CORE, cap 100, hysteresis carried day to day
//   randomK   CORE + a seeded random draw from that day's liquid names, sized to
//             match `new` exactly (seeds 1..3)
//
// Survivorship: the symbol universe is TODAY's master — names delisted during
// the window are absent for every list alike.
// ============================================================

import type { ScreenerConfig } from '../src/screener/config.js'
import { avgTurnover, type DailyBar } from '../src/screener/indicators.js'
import { cutAsOf, oldLayerA, screenAsOf, type ScreenerSource } from '../src/screener/screen.js'

export interface UniverseSet {
	configHash: string
	benchmark: string
	window: { first: string; last: string; sessions: number }
	note: string
	/** list name → trading day → symbols traded that day */
	lists: Record<string, Record<string, string[]>>
	/** per day: screener funnel for `new` (audit) */
	funnels: Record<string, unknown>
}

/** mulberry32 — seeded, deterministic. */
const rng = (seed: number) => () => {
	seed |= 0
	seed = (seed + 0x6d2b79f5) | 0
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const hashDay = (day: string) => [...day].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7)

/** Names a random control may draw from on asOf: liquid, priced, with a bar on asOf and enough history. */
export const liquidPool = (asOf: string, universe: string[], series: Map<string, DailyBar[]>, c: ScreenerConfig): string[] =>
	universe.filter((s) => {
		const bars = cutAsOf(series.get(s) ?? [], asOf)
		if (bars.length < c.history.minBars) return false
		const last = bars[bars.length - 1]!
		const lastDay = new Date(last.t + 5.5 * 3600e3).toISOString().slice(0, 10)
		return lastDay === asOf && last.c >= c.liquidity.minPrice && avgTurnover(bars, c.liquidity.turnoverLookbackBars) >= c.liquidity.minAvgTurnoverRupees
	})

export const buildUniverses = (args: {
	tradingDays: string[] // ascending; the first day is used only as the as-of for the second
	universe: string[]
	series: Map<string, DailyBar[]>
	benchmark: DailyBar[]
	core: string[]
	config: ScreenerConfig
	configHash: string
	randomSeeds?: number[]
}): UniverseSet => {
	const { tradingDays, universe, series, core, config, configHash } = args
	const seeds = args.randomSeeds ?? [1, 2, 3]
	const lists: UniverseSet['lists'] = { old: {}, new: {} }
	for (const k of seeds) lists[`random${k}`] = {}
	const funnels: UniverseSet['funnels'] = {}
	let previous: Map<string, ScreenerSource> | null = null

	for (let i = 1; i < tradingDays.length; i++) {
		const asOf = tradingDays[i - 1]!
		const day = tradingDays[i]!
		const r = screenAsOf({ asOf, universe, series, benchmark: args.benchmark, core, previous, fno: new Set(), config, configHash })
		previous = new Map(r.entries.map((e) => [e.symbol, e.source]))
		lists.new![day] = r.watchlist
		funnels[day] = r.funnel
		lists.old![day] = oldLayerA(asOf, universe, series, core)

		const coreSet = new Set(core)
		const pool = liquidPool(asOf, universe, series, config).filter((s) => !coreSet.has(s)).sort()
		const want = Math.max(0, r.watchlist.length - core.length)
		for (const k of seeds) {
			const rand = rng(k * 1_000_003 + hashDay(day))
			const p = pool.slice()
			for (let j = p.length - 1; j > 0; j--) {
				const x = Math.floor(rand() * (j + 1))
				;[p[j], p[x]] = [p[x]!, p[j]!]
			}
			lists[`random${k}`]![day] = [...core, ...p.slice(0, want)]
		}
	}
	return {
		configHash,
		benchmark: config.benchmark,
		window: { first: tradingDays[1] ?? '', last: tradingDays.at(-1) ?? '', sessions: Math.max(0, tradingDays.length - 1) },
		note: "Point-in-time: day D's list is screened as of D−1 from daily bars only. Symbol universe = today's Fyers master (survivorship bias: delisted names absent).",
		lists,
		funnels,
	}
}

/** Every symbol any list ever traded — what needs intraday bars. */
export const unionOf = (set: UniverseSet): string[] => {
	const out = new Set<string>()
	for (const byDay of Object.values(set.lists)) for (const syms of Object.values(byDay)) for (const s of syms) out.add(s)
	return [...out].sort()
}
