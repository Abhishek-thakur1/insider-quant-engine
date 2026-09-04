// ============================================================
// backtest/core/symbolClass.ts — option vs equity classification
//
// ── A LIVE BUG THIS FILE DOCUMENTS ─────────────────────────────────────────
//
// The live engine decides whether a tick is an option with a bare substring
// test (src/ingestion/websocket.ts:223):
//
//     if (rawTick.symbol.includes('CE') || rawTick.symbol.includes('PE'))
//
// Five symbols in the current watchlist contain "CE" or "PE" inside their
// COMPANY NAME and are therefore misrouted into the option branch:
//
//     NSE:RELIANCE-EQ      NSE:ULTRACEMCO-EQ    NSE:CEATLTD-EQ
//     NSE:BAJFINANCE-EQ    NSE:KAJARIACER-EQ
//
// For those five, in production right now:
//   · updateVwap() is never called → they have no live VWAP
//   · feedTick() is never called   → no candles for structure/liquidity/flow
//   · strategyRouter is never consulted → all 3 equity detectors never run
//   · and at websocket.ts:290 `isIndexOrOption` is also true, so their
//     zero-volume ticks are not filtered and tick volume falls back to 1
//
// The same substring test also appears in janeStreetFilter (structure symbol
// resolution), bayesianEngine (volume bypass, DTE evidence) and
// telegramWorker (message template).
//
// Fixing it is OUT OF SCOPE here — the backtest guardrails forbid modifying
// websocket.ts or live detector logic. It is reported instead.
// ============================================================

/**
 * FAITHFUL to live: replicates the substring test verbatim, bug included.
 * Used for replay ROUTING so the backtest measures the engine that actually
 * runs, not an idealised one.
 */
export const isOptionSymbolLive = (symbol: string): boolean =>
	symbol.includes('CE') || symbol.includes('PE')

/**
 * CORRECT classification: an option symbol carries a strike — a run of at
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
