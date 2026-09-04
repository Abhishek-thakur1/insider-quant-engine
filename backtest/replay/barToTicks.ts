// ============================================================
// backtest/replay/barToTicks.ts — synthesising a tick stream from OHLCV bars
//
// The detectors consume `TickData { price, volume, timestamp }` and build their
// own candles internally from timestamp deltas. So the seam between historical
// data and unmodified detector code is: turn each 1-minute bar into a short
// sequence of ticks. Nothing about a detector changes.
//
// ASSUMPTION — INTRA-BAR PATH ORDERING. An OHLC bar does not record whether the
// high or the low came first. We use the standard convention:
//
//     bullish bar (close >= open):  O → L → H → C
//     bearish bar (close <  open):  O → H → L → C
//
// i.e. price is assumed to probe against the eventual direction first. This is
// the conservative reading for a momentum entry (the pullback happens before
// the push) and it is the same convention used for resolving stop-vs-target
// ambiguity in sim/exit.ts.
//
// ASSUMPTION — VOLUME. The bar's volume is split evenly across its 4 ticks.
// Candle-level totals are therefore exact (detectors sum tick volume into
// their own candles); only per-tick volume is an approximation. This matters
// for the handful of detectors that test a single tick's value — see the
// tick-count caveats in registry.ts.
//
// WHY 4 TICKS AND NOT MORE: 4 is the minimum that preserves O/H/L/C exactly.
// More ticks per bar would multiply an already 10^8-scale operation count
// without adding information — the source data has no intra-minute detail.
// ============================================================

import type { TickData } from '../../src/core/types.js'
import type { Bar } from '../data/store.js'

export const TICKS_PER_BAR = 4

/** Offsets within the bar, in ms. The last stays strictly inside the minute. */
const OFFSETS_MS = [0, 15_000, 30_000, 45_000]

/**
 * Expand one bar into its tick sequence. Timestamps are spread across the
 * bar's minute so a detector building 3-min or 5-min candles rolls on the
 * correct boundary.
 */
export const barToTicks = (bar: Bar): TickData[] => {
	const bullish = bar.c >= bar.o
	const path = bullish ? [bar.o, bar.l, bar.h, bar.c] : [bar.o, bar.h, bar.l, bar.c]
	const vShare = Math.max(0, bar.v) / TICKS_PER_BAR

	return path.map((price, i) => ({
		price,
		volume: vShare,
		timestamp: bar.t + OFFSETS_MS[i]!,
	}))
}

/**
 * A bar where open == high == low == close and volume traded is the signature
 * of a symbol pinned at a circuit band: size changed hands but price could not
 * move. Fyers getHistory does not return the circuit band itself, so this is
 * inference — see config.SIM.circuitLockZeroRange and the README's fidelity
 * gaps. Used by the exit simulator to refuse a fill.
 */
export const looksCircuitLocked = (bar: Bar): boolean =>
	bar.h === bar.l && bar.o === bar.c && bar.h === bar.o && bar.v > 0

/**
 * Merge many symbols' bars into one globally chronological stream.
 *
 * THIS IS THE LOOK-AHEAD GUARANTEE. Detectors for symbol A must never observe
 * a state (Nifty bias, regime entropy, VWAP) computed from a bar that is
 * stamped later than the bar they are currently reacting to. Interleaving
 * every symbol by timestamp — rather than replaying symbol-by-symbol — is what
 * enforces that. A stable tiebreak on symbol keeps runs reproducible.
 */
export const mergeChronologically = (
	perSymbol: Map<string, Bar[]>,
): Array<{ symbol: string; bar: Bar }> => {
	const merged: Array<{ symbol: string; bar: Bar }> = []
	for (const [symbol, bars] of perSymbol) {
		for (const bar of bars) merged.push({ symbol, bar })
	}
	merged.sort((a, b) =>
		a.bar.t === b.bar.t ? a.symbol.localeCompare(b.symbol) : a.bar.t - b.bar.t,
	)
	return merged
}

/** Assert the stream really is non-decreasing in time. Cheap; run it always. */
export const assertChronological = (stream: Array<{ symbol: string; bar: Bar }>): void => {
	for (let i = 1; i < stream.length; i++) {
		if (stream[i]!.bar.t < stream[i - 1]!.bar.t) {
			throw new Error(
				`[replay] LOOK-AHEAD VIOLATION: bar ${i} (${stream[i]!.symbol} @ ${stream[i]!.bar.t}) precedes bar ${i - 1} (${stream[i - 1]!.symbol} @ ${stream[i - 1]!.bar.t})`,
			)
		}
	}
}
