// ============================================================
// orderFlowProxy.ts — Absorption / Aggression Approximation
//
// We don't have real tape (bid/ask prints), so we approximate order
// flow from price + volume shape, which is the standard workaround:
//
//   AGGRESSION (good — real conviction):
//   Large volume + large candle body (close far from open, in the
//   signal direction) = aggressive market orders pushing price with
//   size behind it. This is what a genuine breakout looks like.
//
//   ABSORPTION (bad if against your side — a rejection):
//   Large volume + small body + long wick AGAINST the move = size
//   traded, but price didn't go anywhere — it got absorbed. Someone
//   large was on the other side soaking up the aggression. This is
//   the classic "false breakout" fingerprint: volume shows up, but
//   the candle can't hold the extreme.
//
// This reuses the same closed-candle buffer as the other two
// modules — no separate tick tracking needed.
// ============================================================

import { getClosedCandles, type Candle } from './candleAggregator.js'
import type { TradeSide } from '../core/types.js'

export interface OrderFlowResult {
	score: number // 0-15 points
	reason: string
}

const MAX_SCORE = 15
const LOOKBACK = 10 // candles used to establish average volume baseline
const MIN_CANDLES = 6

const bodyRatio = (c: Candle): number => {
	const range = c.high - c.low
	if (range <= 0) return 0
	return Math.abs(c.close - c.open) / range
}

const upperWickRatio = (c: Candle): number => {
	const range = c.high - c.low
	if (range <= 0) return 0
	const upperWick = c.high - Math.max(c.open, c.close)
	return upperWick / range
}

const lowerWickRatio = (c: Candle): number => {
	const range = c.high - c.low
	if (range <= 0) return 0
	const lowerWick = Math.min(c.open, c.close) - c.low
	return lowerWick / range
}

export const getOrderFlowScore = (symbol: string, side: TradeSide): OrderFlowResult => {
	const candles = getClosedCandles(symbol, LOOKBACK + 2)

	if (candles.length < MIN_CANDLES) {
		return { score: MAX_SCORE * 0.5, reason: `Order flow: insufficient history — neutral` }
	}

	const last = candles[candles.length - 1]!
	const baseline = candles.slice(0, -1)
	const avgVolume = baseline.reduce((sum, c) => sum + c.volume, 0) / Math.max(1, baseline.length)
	const volRatio = avgVolume > 0 ? last.volume / avgVolume : 1

	const wantsUp = side === 'LONG'
	const bullishBody = last.close > last.open
	const bearishBody = last.close < last.open
	const body = bodyRatio(last)
	const upperWick = upperWickRatio(last)
	const lowerWick = lowerWickRatio(last)

	const highVolume = volRatio >= 1.8

	// AGGRESSION in signal direction: big body, in the right direction, above-average volume
	const aggressionAligned =
		body >= 0.55 && highVolume && ((wantsUp && bullishBody) || (!wantsUp && bearishBody))

	if (aggressionAligned) {
		return {
			score: MAX_SCORE,
			reason: `✅ Aggressive candle (${volRatio.toFixed(1)}x vol, ${(body * 100).toFixed(0)}% body) confirms ${side} conviction`,
		}
	}

	// ABSORPTION against signal direction: high volume, small body, long wick
	// opposing the intended direction — price tried to move and got rejected.
	const absorptionAgainstLong = wantsUp && highVolume && upperWick >= 0.5 && body < 0.4
	const absorptionAgainstShort = !wantsUp && highVolume && lowerWick >= 0.5 && body < 0.4

	if (absorptionAgainstLong || absorptionAgainstShort) {
		return {
			score: MAX_SCORE * 0.1,
			reason: `⚠️ Absorption detected — high volume (${volRatio.toFixed(1)}x) rejected at the extreme, against ${side}`,
		}
	}

	// High volume but body/direction inconclusive — mild positive, real
	// participation without a clear read either way.
	if (highVolume) {
		return {
			score: MAX_SCORE * 0.6,
			reason: `○ Elevated volume (${volRatio.toFixed(1)}x) but no clear directional imbalance`,
		}
	}

	return {
		score: MAX_SCORE * 0.45,
		reason: `○ Normal volume — no strong order flow signature either way`,
	}
}
