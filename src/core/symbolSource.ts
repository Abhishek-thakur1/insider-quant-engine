// ============================================================
// src/core/symbolSource.ts — why a symbol is in the live universe
//
// Filled by websocket.ts (boot watchlist + anomaly promotions), read when a
// signal is logged. Observation only: nothing in the trading path reads it.
//   CORE             core_watchlist.json, or the daily list's core group (dw-3)
//   DAILY_SCORE      daily list (dw-3), rotating, picked by score
//   DAILY_TURNOVER   daily list (dw-3), rotating, picked by turnover
//   SCREENER_LEADER  screener v2 Tier 1 (trend + RS leader) — watchlist_meta.json
//   SCREENER_SETUP   screener v2 Tier 2 (leader in a tight consolidation)
//   SCREENER         legacy: a watchlist.json with no meta (old Layer A / baked file)
//   ANOMALY          promoted intraday by AnomalyScanner
//   INDEX            Nifty index / option-routed symbols (not in any watchlist)
// ============================================================

export type PromotionSource =
	| 'CORE'
	| 'DAILY_SCORE'
	| 'DAILY_TURNOVER'
	| 'SCREENER'
	| 'SCREENER_LEADER'
	| 'SCREENER_SETUP'
	| 'ANOMALY'
	| 'INDEX'
	| 'UNKNOWN'

const sources = new Map<string, PromotionSource>()

export const setSymbolSource = (symbol: string, source: PromotionSource): void => {
	sources.set(symbol, source)
}

/**
 * Boot: the screener's per-symbol source (watchlist_meta.json) when present;
 * otherwise core symbols are CORE and the rest of the watchlist is SCREENER.
 */
export const registerWatchlistSources = (
	watchlist: string[],
	core: Iterable<string>,
	meta?: Map<string, PromotionSource>,
): void => {
	const coreSet = new Set(core)
	for (const s of watchlist) sources.set(s, coreSet.has(s) ? 'CORE' : (meta?.get(s) ?? 'SCREENER'))
}

/**
 * Sources from the daily list's entries (dw-3): core group → CORE, rotating → DAILY_SCORE or
 * DAILY_TURNOVER by `pick` (a rotating entry without one is a score pick, as in dw-3 before 1b).
 * `legacy` (migration 0008 not applied) maps both rotating groups to SCREENER, which the signals
 * CHECK already accepts, so a missing migration can't make signal inserts fail.
 */
export const dailyListSources = (
	entries: { symbol: string; group: 'core' | 'rotating'; pick?: 'score' | 'turnover' }[],
	opts: { legacy?: boolean } = {},
): Map<string, PromotionSource> =>
	new Map(
		entries.map((e) => [
			e.symbol,
			e.group === 'core' ? 'CORE' : opts.legacy ? 'SCREENER' : e.pick === 'turnover' ? 'DAILY_TURNOVER' : 'DAILY_SCORE',
		]),
	)

/**
 * Boot, daily list: register the sources from its entries. `schemaIssue` is websocket.ts's boot
 * schemaProblem(): any problem (pending migration, failed check) means legacy (rotating → SCREENER).
 * Returns the count per source, for the boot line.
 */
export const registerDailySources = (
	watchlist: string[],
	entries: Parameters<typeof dailyListSources>[0],
	schemaIssue: string | null,
): Map<PromotionSource, number> => {
	const daily = dailyListSources(entries, { legacy: schemaIssue !== null })
	registerWatchlistSources(watchlist, [...daily].filter(([, s]) => s === 'CORE').map(([s]) => s), daily)
	const counts = new Map<PromotionSource, number>()
	for (const s of watchlist) {
		const src = sources.get(s)!
		counts.set(src, (counts.get(src) ?? 0) + 1)
	}
	return counts
}

export const getSymbolSource =(symbol: string): PromotionSource =>
	sources.get(symbol) ?? (/NIFTY/i.test(symbol) ? 'INDEX' : 'UNKNOWN')

/** Test hook. */
export const clearSymbolSources = (): void => sources.clear()
