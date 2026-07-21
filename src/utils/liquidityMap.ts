// ============================================================
// liquidityMap.ts — Equal Highs/Lows, Stop Clusters, Sweep Detection
//
// MARKET INTUITION:
// Retail stop-losses and breakout entries cluster at obvious levels
// — equal highs, equal lows, round numbers, prior day high/low.
// Market makers and larger players know this. Two classic patterns:
//
//   1. STOP HUNT / SWEEP-AND-RECLAIM (high quality, works FOR you):
//      Price wicks through a liquidity pool (sweeping the stops
//      resting there) and then CLOSES back on the other side. That's
//      the liquidity grab completing — real demand/supply stepping
//      in after weak hands are shaken out. This is the single
//      highest-quality long/short trigger in this module.
//
//   2. UNTESTED POOL AHEAD (low quality, works AGAINST you):
//      Price is approaching a fresh, untested equal-high/low cluster
//      in the direction of your signal. That level is a magnet —
//      price often stalls or reverses right at it. Firing a momentum
//      signal into an untouched pool is the "false breakout" and
//      "liquidity trap" failure mode from your brief.
//
// EQUAL HIGH/LOW DETECTION:
// From the same swing points marketStructure.ts derives, cluster any
// two swing highs (or lows) within a tight tolerance band — these
// are the pools. Tolerance is relative (basis points) so it scales
// across price levels (₹50 stock vs ₹20,000 index).
// ============================================================

import { getClosedCandles, type Candle } from './candleAggregator.js'
import type { TradeSide } from '../core/types.js'

export interface LiquidityResult {
	score: number // 0-18 points
	reason: string
}

const MAX_SCORE = 18
const MIN_CANDLES = 15
const POOL_TOLERANCE_BPS = 8 // 0.08% — two swing points within this band count as "equal"

interface Pool {
	price: number
	type: 'high' | 'low'
	touches: number
}

const findSwings = (candles: Candle[]) => {
	const highs: { price: number; index: number }[] = []
	const lows: { price: number; index: number }[] = []
	for (let i = 1; i < candles.length - 1; i++) {
		const prev = candles[i - 1]!
		const cur = candles[i]!
		const next = candles[i + 1]!
		if (cur.high > prev.high && cur.high > next.high) highs.push({ price: cur.high, index: i })
		if (cur.low < prev.low && cur.low < next.low) lows.push({ price: cur.low, index: i })
	}
	return { highs, lows }
}

const clusterPools = (points: { price: number; index: number }[], type: 'high' | 'low'): Pool[] => {
	const pools: Pool[] = []
	for (const p of points) {
		const existing = pools.find(
			(pool) => Math.abs(pool.price - p.price) / p.price <= POOL_TOLERANCE_BPS / 10000,
		)
		if (existing) {
			existing.touches += 1
			existing.price = (existing.price + p.price) / 2
		} else {
			pools.push({ price: p.price, type, touches: 1 })
		}
	}
	// Only pools with 2+ touches are genuine liquidity clusters
	return pools.filter((p) => p.touches >= 2)
}

export const getLiquidityScore = (
	symbol: string,
	side: TradeSide,
	currentPrice: number,
): LiquidityResult => {
	const candles = getClosedCandles(symbol, 40)

	if (candles.length < MIN_CANDLES) {
		return { score: MAX_SCORE * 0.5, reason: `Liquidity: insufficient history — neutral` }
	}

	const { highs, lows } = findSwings(candles)
	const highPools = clusterPools(highs, 'high')
	const lowPools = clusterPools(lows, 'low')

	const last = candles[candles.length - 1]!
	const prev = candles[candles.length - 2]!
	const wantsUp = side === 'LONG'

	// ── Check for sweep-and-reclaim on the last 1-2 closed candles ──────────
	// Sweep-and-reclaim FOR a LONG: a low pool got wicked below, but candle
	// closed back above it.
	if (wantsUp) {
		const sweptPool = lowPools.find((p) => prev.low < p.price && last.close > p.price)
		if (sweptPool) {
			return {
				score: MAX_SCORE,
				reason: `✅ Swept low liquidity pool @ ~${sweptPool.price.toFixed(2)} and reclaimed — stop hunt confirmed`,
			}
		}
	} else {
		const sweptPool = highPools.find((p) => prev.high > p.price && last.close < p.price)
		if (sweptPool) {
			return {
				score: MAX_SCORE,
				reason: `✅ Swept high liquidity pool @ ~${sweptPool.price.toFixed(2)} and reclaimed — stop hunt confirmed`,
			}
		}
	}

	// ── Check for an untested pool sitting directly ahead (magnet risk) ────
	const nearestPoolAhead = wantsUp
		? highPools.filter((p) => p.price > currentPrice).sort((a, b) => a.price - b.price)[0]
		: lowPools.filter((p) => p.price < currentPrice).sort((a, b) => b.price - a.price)[0]

	if (nearestPoolAhead) {
		const distancePct = (Math.abs(nearestPoolAhead.price - currentPrice) / currentPrice) * 100
		if (distancePct < 0.15) {
			return {
				score: MAX_SCORE * 0.15,
				reason: `⚠️ Untested liquidity pool ${distancePct.toFixed(2)}% ahead @ ~${nearestPoolAhead.price.toFixed(2)} — likely stall/reversal zone`,
			}
		}
	}

	// ── Check if signal is breaking THROUGH a pool with no prior sweep ─────
	// i.e. price just crossed a pool in the signal direction on this candle
	// alone, with no earlier test — classic unconfirmed breakout / trap setup.
	const freshBreakThroughNoTest = wantsUp
		? highPools.find((p) => prev.close < p.price && last.close > p.price)
		: lowPools.find((p) => prev.close > p.price && last.close < p.price)

	if (freshBreakThroughNoTest) {
		return {
			score: MAX_SCORE * 0.35,
			reason: `⚠️ Breaking untested pool @ ~${freshBreakThroughNoTest.price.toFixed(2)} on first touch — unconfirmed, trap risk`,
		}
	}

	return {
		score: MAX_SCORE * 0.6,
		reason: `○ No major liquidity pool in immediate path — clear runway`,
	}
}
