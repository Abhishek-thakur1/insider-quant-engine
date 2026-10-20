// ============================================================
// src/core/symbolSource.ts — why a symbol is in the live universe
//
// Filled by websocket.ts (boot watchlist + anomaly promotions), read when a
// signal is logged. Observation only: nothing in the trading path reads it.
//   CORE             core_watchlist.json
//   SCREENER_LEADER  screener v2 Tier 1 (trend + RS leader) — watchlist_meta.json
//   SCREENER_SETUP   screener v2 Tier 2 (leader in a tight consolidation)
//   SCREENER         legacy: a watchlist.json with no meta (old Layer A / baked file)
//   ANOMALY          promoted intraday by AnomalyScanner
//   INDEX            Nifty index / option-routed symbols (not in any watchlist)
// ============================================================

export type PromotionSource = 'CORE' | 'SCREENER' | 'SCREENER_LEADER' | 'SCREENER_SETUP' | 'ANOMALY' | 'INDEX' | 'UNKNOWN'

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

export const getSymbolSource = (symbol: string): PromotionSource =>
	sources.get(symbol) ?? (/NIFTY/i.test(symbol) ? 'INDEX' : 'UNKNOWN')

/** Test hook. */
export const clearSymbolSources = (): void => sources.clear()
