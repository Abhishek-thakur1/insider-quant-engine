import { redisClient } from '../config/redis.js'
import type { MarketBias, VwapState } from '../core/types.js'
import { getISTDateString, getISTMinutes } from './marketHours.js'

const NIFTY_BIAS_KEY = 'market:nifty:bias'

// vwap:{symbol}:{date} is only read on its own IST day (getVwap, the seeder's isSeeded check, the
// API's stocksSeenToday). 36 h covers the session and a same-day restart; before 2026-10-27 the keys
// had no TTL and accumulated (4,485 on 26 Oct).
export const VWAP_TTL_SECS = 36 * 3600

// [FIX: CORRECTNESS] The original updateVwap used raw price (last trade price) as the
// price component. Standard VWAP = Σ(typicalPrice × volume) / Σ(volume), where
// typicalPrice = (high + low + close) / 3.
//
// For live ticks we only have the last trade price — we don't have a candle H/L.
// The correct live approximation is to treat each tick as its own "candle" where
// high = low = close = ltp, making typicalPrice = ltp. This is mathematically
// identical to what the seeder now uses once the session approaches the live feed.
// The key change is in the seeder (vwapSeeder.ts) which bootstraps from candles
// that DO have real H/L data. The live update formula stays the same.
//
// [WHAT TO CHANGE]: The function signature gains an optional `high` and `low`
// parameter. When called from websocket.ts with tick data (no H/L), they default
// to price — preserving the existing call signature exactly.
export const updateVwap = async (
	symbol: string,
	price: number,
	volume: number,
	high?: number, // [FIX] Optional — for candle-based callers; defaults to price
	low?: number, // [FIX] Optional — for candle-based callers; defaults to price
): Promise<number> => {
	const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0]
	const key = `vwap:${symbol}:${todayIST}`
	const raw = await redisClient.get(key)

	let state: VwapState = raw
		? (JSON.parse(raw) as VwapState)
		: { cumulativePV: 0, cumulativeVol: 0, vwap: price }

	// [FIX] Use typical price when H/L are available, otherwise fall back to price
	const typicalPrice = high !== undefined && low !== undefined ? (high + low + price) / 3 : price

	state.cumulativePV += typicalPrice * volume
	state.cumulativeVol += volume
	state.vwap = state.cumulativeVol > 0 ? state.cumulativePV / state.cumulativeVol : price

	await redisClient.setEx(key, VWAP_TTL_SECS, JSON.stringify(state))
	return state.vwap
}

// ── Session gate (2026-10-27) ────────────────────────────────────────────────
// The engine boots at 09:00. Before this gate, every equity tick with volume and every Nifty minute
// from boot onward entered the day's VWAP: the pre-open auction print (equities) and ~13 pre-open
// index minutes (Nifty, 388 candles on 26 Oct instead of 375). The seeder (1-minute candles from
// 09:15) and the backtest replay (bars from 09:15) never include them, so live and backtest VWAP
// differed most in the first hour. Only data from 09:15 IST counts now.
// Kill switch: VWAP_SESSION_GATE=false restores the old behaviour without a rebuild.
export const VWAP_SESSION_START_MIN = 9 * 60 + 15

export const vwapSessionGateEnabled = (): boolean => process.env.VWAP_SESSION_GATE !== 'false'

/** True when data stamped at `ms` may enter the day's VWAP. */
export const inVwapSession = (ms: number): boolean =>
	!vwapSessionGateEnabled() || getISTMinutes(ms) >= VWAP_SESSION_START_MIN

// ── Auction volume (2026-11-03) ─────────────────────────────────────────────
// The pre-open auction volume does NOT arrive before 09:15: on 3 Nov the feed was silent from 09:09:18 to
// 09:15:00, and the first ticks after the open carried the auction (TATASTEEL: received 09:15:00, last trade
// 09:08:53, vol_traded_today 136,578). Pre-open ticks carry no volume field, so the volume baseline was 0 and
// the whole auction became the first in-session delta, which a receive-time gate let through. The gate now
// uses the tick's exchange last-trade time when there is one: an auction-only tick (last trade before 09:15)
// stays out, and its volume becomes the baseline for the next delta (tickVolumeDelta always updates it).

/**
 * The time that decides whether an equity tick enters the VWAP: its last-trade time (epoch seconds) when
 * valid and on the receive day (IST); the receive time when the field is missing; null (left out) when the
 * last trade is on another day.
 */
export const vwapStampMs = (lastTradedSec: unknown, receivedMs: number): number | null => {
	const s = Number(lastTradedSec)
	if (lastTradedSec == null || !Number.isFinite(s) || s <= 0) return receivedMs
	const ms = s * 1000
	return getISTDateString(ms) === getISTDateString(receivedMs) ? ms : null
}

/** Volume traded since this symbol's previous tick; the first tick only sets the baseline. Updates `tracker`. */
export const tickVolumeDelta = (tracker: Map<string, number>, symbol: string, volTradedToday: number | undefined): number => {
	const cumulativeVol = volTradedToday || 0
	// ?? so a recorded 0 stays the baseline (not replaced by this tick's total)
	const previousVol = tracker.get(symbol) ?? cumulativeVol
	tracker.set(symbol, cumulativeVol) // always, so the next delta is right even when this tick is gated out
	return Math.max(0, cumulativeVol - previousVol)
}

/**
 * The live equity tick path: updateVwap for ticks from 09:15 IST. Returns null when skipped.
 * `lastTradedSec` (the feed's last_traded_time) decides when present; else the receive time `ms`.
 * VWAP_SESSION_GATE=false admits every tick, as before.
 */
export const updateSessionVwap = async (symbol: string, price: number, volume: number, ms: number, lastTradedSec?: unknown): Promise<number | null> => {
	if (!vwapSessionGateEnabled()) return updateVwap(symbol, price, volume)
	const stamp = lastTradedSec === undefined ? ms : vwapStampMs(lastTradedSec, ms)
	return stamp !== null && inVwapSession(stamp) ? updateVwap(symbol, price, volume) : null
}

// [FIX: SILENT FAILURE] The original getVwap returned null when no VWAP key existed.
// Detectors treated null as "no filter — allow the alert through", which means a
// seeder failure silently disables the most important filter for every symbol.
//
// [WHAT TO CHANGE]: getVwap now returns the value OR null, unchanged. But we expose
// a separate hasVwap() helper that detectors can use to distinguish "no data yet
// (engine just started)" from "seeder failed". Detectors should call hasVwap() at
// boot and log a WARNING if it returns false after the seeder has run.
export const getVwap = async (symbol: string): Promise<number | null> => {
	const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0]
	const key = `vwap:${symbol}:${todayIST}`
	const raw = await redisClient.get(key)
	if (!raw) return null
	return (JSON.parse(raw) as VwapState).vwap
}

// [FIX: NEW] Use this at engine startup to detect seeder failures loudly.
// Call from websocket.ts after seedHistoricalVwap() completes.
export const warnIfVwapMissing = async (symbols: string[]): Promise<void> => {
	const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0]
	const missing: string[] = []

	for (const symbol of symbols) {
		const key = `vwap:${symbol}:${todayIST}`
		const raw = await redisClient.get(key)
		if (!raw) missing.push(symbol)
	}

	if (missing.length > 0) {
		console.warn(
			`[VWAP] ⚠️  WARNING: ${missing.length} symbols have no seeded VWAP. ` +
				`VWAP filter is DISABLED for these symbols — alerts may fire without confirmation.\n` +
				`[VWAP] Missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` ...+${missing.length - 10} more` : ''}`,
		)
	}
}

export const resetVwap = async (symbol: string): Promise<void> => {
	await redisClient.del(`vwap:${symbol}`)
}

// Nifty bias logic — 0.15% band with hysteresis to prevent rapid flipping
//
// [FIX: STABILITY] The original bias used a simple symmetric threshold: > +0.15% = bullish,
// < -0.15% = bearish, else neutral. This caused frequent state flips when Nifty
// oscillates right on the VWAP boundary throughout the day.
//
// [WHAT TO CHANGE]: Added hysteresis — once the bias is bullish, it stays bullish until
// price falls below -0.05% (not just below +0.15%). This requires reading the CURRENT
// bias before writing the new one.
export const updateNiftyBias = async (niftyPrice: number, niftyVwap: number): Promise<void> => {
	const biasPct = ((niftyPrice - niftyVwap) / niftyVwap) * 100

	// [FIX] Read current bias for hysteresis logic
	const currentBiasRaw = await redisClient.get(NIFTY_BIAS_KEY)
	const currentBias = (currentBiasRaw as MarketBias | null) ?? 'neutral'

	let bias: MarketBias

	if (biasPct > 0.15) {
		// Clearly above VWAP — bullish
		bias = 'bullish'
	} else if (biasPct < -0.15) {
		// Clearly below VWAP — bearish
		bias = 'bearish'
	} else if (currentBias === 'bullish' && biasPct > -0.05) {
		// [FIX] Was bullish, still within tolerance band — hold bullish rather than
		// flipping to neutral on every tick that touches the 0.15% line
		bias = 'bullish'
	} else if (currentBias === 'bearish' && biasPct < 0.05) {
		// [FIX] Was bearish, still within tolerance band — hold bearish
		bias = 'bearish'
	} else {
		bias = 'neutral'
	}

	await redisClient.set(NIFTY_BIAS_KEY, bias)
}

export const getMarketBias = async (): Promise<MarketBias> => {
	const raw = await redisClient.get(NIFTY_BIAS_KEY)
	return (raw as MarketBias | null) ?? 'neutral'
}
