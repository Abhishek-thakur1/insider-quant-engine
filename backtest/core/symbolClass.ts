// ============================================================
// backtest/core/symbolClass.ts - option vs equity classification
//
// 🟢 FIXED IN V2:
// The live engine used to decide whether a tick is an option with a bare substring test.
// This was fixed in v2 to use endsWith('CE') || endsWith('PE').
// ============================================================

/**
 * FAITHFUL to live: replicates the exact logic used in websocket.ts.
 */
export const isOptionSymbolLive = (symbol: string): boolean =>
	symbol.endsWith('CE') || symbol.endsWith('PE')

/**
 * CORRECT classification: an option symbol carries a strike - a run of at
 * least three digits immediately before the CE/PE suffix. Matches both the
 * detector alert form (`NIFTY 24500 CE`) and the Fyers broker form
 * (`NSE:NIFTY2541722500CE`), and rejects every equity name.
 *
 * Used where the answer must be right rather than bug-compatible: choosing
 * which price series an alert's SL/T1 levels refer to.
 */
export const isOptionSymbolPrecise = (symbol: string): boolean => /\d{3,}\s*(CE|PE)$/.test(symbol)

/** Symbols the live substring test misroutes. Surfaced in the report. */
export const misroutedByLiveTest = (symbols: string[]): string[] =>
	symbols.filter((s) => isOptionSymbolLive(s) && !isOptionSymbolPrecise(s))
