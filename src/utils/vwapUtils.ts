import { redisClient } from '../config/redis.js'
import type { MarketBias, VwapState } from '../core/types.js'

const NIFTY_BIAS_KEY = 'market:nifty:bias'

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

	await redisClient.set(key, JSON.stringify(state))
	return state.vwap
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
