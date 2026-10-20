// ============================================================
// src/core/symbolSource.ts — why a symbol is in the live universe
//
// Filled by websocket.ts (boot watchlist + anomaly promotions), read when a
// signal is logged. Observation only: nothing in the trading path reads it.
//   CORE      core_watchlist.json
//   SCREENER  rest of watchlist.json (dailyScreener Layer A)
//   ANOMALY   promoted intraday by AnomalyScanner
//   INDEX     Nifty index / option-routed symbols (not in any watchlist)
// ============================================================

export type PromotionSource = 'CORE' | 'SCREENER' | 'ANOMALY' | 'INDEX' | 'UNKNOWN'

const sources = new Map<string, PromotionSource>()

export const setSymbolSource = (symbol: string, source: PromotionSource): void => {
	sources.set(symbol, source)
}

/** Boot: core symbols are CORE, the rest of the screener's watchlist is SCREENER. */
export const registerWatchlistSources = (watchlist: string[], core: Iterable<string>): void => {
	const coreSet = new Set(core)
	for (const s of watchlist) sources.set(s, coreSet.has(s) ? 'CORE' : 'SCREENER')
}

export const getSymbolSource = (symbol: string): PromotionSource =>
	sources.get(symbol) ?? (/NIFTY/i.test(symbol) ? 'INDEX' : 'UNKNOWN')

/** Test hook. */
export const clearSymbolSources = (): void => sources.clear()
