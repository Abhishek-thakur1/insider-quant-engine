// ============================================================
// candleAggregator.ts — Shared Per-Symbol Candle Buffer
//
// WHY THIS EXISTS:
// marketStructure.ts, liquidityMap.ts, and orderFlowProxy.ts all
// need the same thing: a rolling window of recent 1-min OHLCV
// candles per symbol. Rather than each module building its own
// tick→candle aggregation (and drifting out of sync with each
// other), they all read from this single buffer.
//
// PATTERN: mirrors the existing in-memory + capped-array approach
// already used in regimeDetector.ts (inMemoryReturns). No Redis
// round-trip needed — this is a hot path called on every tick.
//
// INTEGRATION: call feedTick() once per symbol per tick from the
// single ingestion point in websocket.ts (both the Nifty branch
// and the equity branch). Nothing else needs to change.
// ============================================================

export interface Candle {
	open: number
	high: number
	low: number
	close: number
	volume: number
	startTs: number
}

const CANDLE_INTERVAL_MS = 60 * 1000 // 1-minute candles
const MAX_CANDLES = 60 // 1 hour of rolling history — enough for swing/BOS detection

// symbol -> array of CLOSED candles, oldest first, capped at MAX_CANDLES
const closedCandles = new Map<string, Candle[]>()
// symbol -> candle currently being built
const formingCandle = new Map<string, Candle>()

/**
 * Feed one tick into the aggregator. Call this from the single
 * websocket ingestion point — once for Nifty, once per equity tick.
 */
export const feedTick = (
	symbol: string,
	price: number,
	volume: number,
	timestamp = Date.now(),
): void => {
	const current = formingCandle.get(symbol)

	if (!current) {
		formingCandle.set(symbol, {
			open: price,
			high: price,
			low: price,
			close: price,
			volume: Math.max(0, volume),
			startTs: timestamp,
		})
		return
	}

	if (timestamp - current.startTs < CANDLE_INTERVAL_MS) {
		current.high = Math.max(current.high, price)
		current.low = Math.min(current.low, price)
		current.close = price
		current.volume += Math.max(0, volume)
		return
	}

	// Candle closed — push to history, start a new one
	const history = closedCandles.get(symbol) ?? []
	history.push(current)
	if (history.length > MAX_CANDLES) history.shift()
	closedCandles.set(symbol, history)

	formingCandle.set(symbol, {
		open: price,
		high: price,
		low: price,
		close: price,
		volume: Math.max(0, volume),
		startTs: timestamp,
	})
}

/**
 * Last n CLOSED candles, oldest first. Does not include the
 * in-progress candle — structure/liquidity checks should only
 * trust confirmed (closed) candles to avoid repainting.
 */
export const getClosedCandles = (symbol: string, n = MAX_CANDLES): Candle[] => {
	const history = closedCandles.get(symbol) ?? []
	return history.slice(Math.max(0, history.length - n))
}

export const getFormingCandle = (symbol: string): Candle | null => formingCandle.get(symbol) ?? null

/** Clear a symbol's buffers — call on session reset alongside other boot cleanup. */
export const resetCandles = (symbol: string): void => {
	closedCandles.delete(symbol)
	formingCandle.delete(symbol)
}
