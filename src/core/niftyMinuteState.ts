// ============================================================
// src/core/niftyMinuteState.ts — the Nifty 1-minute tracker, moved out of websocket.ts
// (2026-10-27) unchanged except for the VWAP session gate, so tests can drive the real code.
// ============================================================

import { updateVwap, inVwapSession } from '../utils/vwapUtils.js'
import { pushNiftyReturn } from '../utils/regimeDetector.js'

const NIFTY_SYMBOL = 'NSE:NIFTY50-INDEX'

// ── Nifty 1-minute state tracker ─────────────────────────────────────────────
// Builds 1-minute O/H/L/C candles from Nifty spot ticks. On each candle close:
//   1. computes the return % and pushes it to the Shannon entropy engine
//   2. advances the Nifty session reference price (see below)
//
// [FIX — root cause #1] The Nifty VWAP used to be updated on EVERY tick with a
// hardcoded weight of 1: `updateVwap(NIFTY, ltp, 1)`. With a constant weight,
// cumulativePV/cumulativeVol collapses to an unweighted arithmetic mean of tick
// PRICES, biased by tick arrival rate rather than by volume or by time. Combined
// with the index never being seeded, the reference every Nifty detector filters
// on was a mean of ticks since process boot.
//
// NSE indices have no traded volume, so a true VWAP is not computable from index
// data. What IS well-defined is an equal-weight-per-minute mean of the candle
// typical price (H+L+C)/3 — a session TWAP. We now advance it once per closed
// minute, which matches exactly how vwapSeeder seeds the index, so the seeded
// history and the live session are on the same weighting.
//
// The value is cached in memory so the per-tick bias check costs no Redis read.
interface MinuteCandle {
	open: number
	high: number
	low: number
	close: number
	startTs: number
}

const MINUTE_MS = 60 * 1000
let _niftyMinute: MinuteCandle | null = null
let lastNiftyVwap = 0

/** The cached Nifty session reference (0 until the first in-session minute closes or the seeder primes it). */
export const getLastNiftyVwap = (): number => lastNiftyVwap
/** Boot: prime the reference from the seeded `vwap:` key so bias checks work from the first tick. */
export const setLastNiftyVwap = (v: number): void => {
	lastNiftyVwap = v
}
/** Tests only: forget the minute in progress and the cached reference. */
export const resetNiftyMinuteState = (): void => {
	_niftyMinute = null
	lastNiftyVwap = 0
}

/** One Nifty spot tick. `now` defaults to the wall clock; tests pass the tick time. */
export const onNiftyTick = async (price: number, now: number = Date.now()): Promise<void> => {

	if (!_niftyMinute) {
		_niftyMinute = { open: price, high: price, low: price, close: price, startTs: now }
		return
	}

	if (now - _niftyMinute.startTs < MINUTE_MS) {
		_niftyMinute.high = Math.max(_niftyMinute.high, price)
		_niftyMinute.low = Math.min(_niftyMinute.low, price)
		_niftyMinute.close = price
		return
	}

	// Candle closed.
	const c = _niftyMinute
	_niftyMinute = { open: price, high: price, low: price, close: price, startTs: now }

	// 1. Regime engine
	const returnPct = ((c.close - c.open) / c.open) * 100
	await pushNiftyReturn(returnPct)

	// 2. Session reference price — weight 1 for this minute, typical price from H/L/C.
	//    updateVwap's optional high/low params yield typicalPrice = (h + l + c) / 3.
	//    Session gate (2026-10-27): only minutes that START at or after 09:15 IST count. On a 09:00
	//    boot the pre-open index ticks used to add ~13 minutes at the pre-open level (388 candles on
	//    26 Oct instead of 375); the seeder and the backtest both start at 09:15. The regime return
	//    above is NOT gated: it feeds the REGIME gate and stays exactly as it was.
	if (inVwapSession(c.startTs)) lastNiftyVwap = await updateVwap(NIFTY_SYMBOL, c.close, 1, c.high, c.low)
}
