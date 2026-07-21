// ============================================================
// marketStructure.ts — Swing / BOS / CHOCH Confirmation
//
// MARKET INTUITION:
// Price doesn't move in a straight line — it moves in swings.
// An uptrend is a sequence of Higher-Highs and Higher-Lows (HH-HL).
// A downtrend is Lower-Highs and Lower-Lows (LH-LL).
//
//   BOS (Break of Structure) = price closes beyond the most recent
//   swing point IN the direction of the prevailing sequence. This
//   confirms trend continuation — real evidence, not just a price
//   poke.
//
//   CHOCH (Change of Character) = price closes beyond a swing point
//   AGAINST the prevailing sequence. First sign the trend is
//   turning. A signal firing right after a fresh CHOCH against it
//   is exactly the "entries at local tops/bottoms" failure mode
//   from your brief.
//
// TREND MATURITY:
// The 1st and 2nd BOS in a fresh sequence are high-quality — real
// continuation. The 4th, 5th, 6th consecutive BOS in the same
// direction is late-stage — you're chasing an extended move that's
// statistically closer to exhaustion than to more room. We penalize
// entries into an over-extended run rather than rewarding "yet
// another breakout."
//
// SWING DETECTION:
// Simple 3-candle fractal on CLOSED candles from candleAggregator:
// a swing high is a candle whose high is greater than both
// neighbors; a swing low is a candle whose low is less than both
// neighbors. This is standard, lag-tolerant, and doesn't repaint
// once a candle has closed.
// ============================================================

import { getClosedCandles, type Candle } from './candleAggregator.js'
import type { TradeSide } from '../core/types.js'

interface SwingPoint {
	price: number
	type: 'high' | 'low'
	index: number // index into the candle array it was found in
}

export interface StructureResult {
	score: number // 0-20 points
	reason: string
	sequence: 'HH-HL' | 'LH-LL' | 'unclear'
	consecutiveBOS: number
}

const MAX_SCORE = 20
const MIN_CANDLES_FOR_STRUCTURE = 12
const MAX_TRACKED_SWINGS = 10

// symbol -> consecutive same-direction BOS count (for trend maturity)
const bosStreak = new Map<string, { direction: 'up' | 'down'; count: number }>()

const findSwingPoints = (candles: Candle[]): SwingPoint[] => {
	const swings: SwingPoint[] = []
	for (let i = 1; i < candles.length - 1; i++) {
		const prev = candles[i - 1]!
		const cur = candles[i]!
		const next = candles[i + 1]!

		if (cur.high > prev.high && cur.high > next.high) {
			swings.push({ price: cur.high, type: 'high', index: i })
		} else if (cur.low < prev.low && cur.low < next.low) {
			swings.push({ price: cur.low, type: 'low', index: i })
		}
	}
	return swings.slice(-MAX_TRACKED_SWINGS)
}

const classifySequence = (swings: SwingPoint[]): 'HH-HL' | 'LH-LL' | 'unclear' => {
	const highs = swings.filter((s) => s.type === 'high').slice(-2)
	const lows = swings.filter((s) => s.type === 'low').slice(-2)

	if (highs.length < 2 || lows.length < 2) return 'unclear'

	const higherHighs = highs[1]!.price > highs[0]!.price
	const higherLows = lows[1]!.price > lows[0]!.price
	const lowerHighs = highs[1]!.price < highs[0]!.price
	const lowerLows = lows[1]!.price < lows[0]!.price

	if (higherHighs && higherLows) return 'HH-HL'
	if (lowerHighs && lowerLows) return 'LH-LL'
	return 'unclear'
}

export const getStructureScore = (symbol: string, side: TradeSide): StructureResult => {
	const candles = getClosedCandles(symbol, 40)

	if (candles.length < MIN_CANDLES_FOR_STRUCTURE) {
		return {
			score: MAX_SCORE * 0.5, // neutral — not enough data to judge, don't punish or reward
			reason: `Structure: insufficient candle history (${candles.length}) — neutral`,
			sequence: 'unclear',
			consecutiveBOS: 0,
		}
	}

	const swings = findSwingPoints(candles)
	const sequence = classifySequence(swings)
	const lastClose = candles[candles.length - 1]!.close
	const wantsUp = side === 'LONG'

	const sequenceAligned = (wantsUp && sequence === 'HH-HL') || (!wantsUp && sequence === 'LH-LL')
	const sequenceOpposed = (wantsUp && sequence === 'LH-LL') || (!wantsUp && sequence === 'HH-HL')

	// Find the most recent swing point in the direction relevant to a BOS check
	const relevantSwing = wantsUp
		? [...swings].reverse().find((s) => s.type === 'high')
		: [...swings].reverse().find((s) => s.type === 'low')

	let isBOS = false
	let isCHOCH = false

	if (relevantSwing) {
		if (wantsUp && lastClose > relevantSwing.price && sequenceAligned) isBOS = true
		if (!wantsUp && lastClose < relevantSwing.price && sequenceAligned) isBOS = true
		if (wantsUp && lastClose < relevantSwing.price && sequenceOpposed) isCHOCH = true
		if (!wantsUp && lastClose > relevantSwing.price && sequenceOpposed) isCHOCH = true
	}

	// Track consecutive same-direction BOS for trend-maturity penalty
	const dir = wantsUp ? 'up' : 'down'
	const streak = bosStreak.get(symbol)
	let consecutiveBOS = 0

	if (isBOS) {
		if (streak && streak.direction === dir) {
			streak.count += 1
			consecutiveBOS = streak.count
		} else {
			bosStreak.set(symbol, { direction: dir, count: 1 })
			consecutiveBOS = 1
		}
	} else if (streak) {
		consecutiveBOS = streak.count
	}

	let score = MAX_SCORE * 0.5 // neutral baseline
	let reason = `Structure: ${sequence} sequence, no fresh BOS/CHOCH`

	if (isCHOCH) {
		score = 2
		reason = `⚠️ CHOCH just fired against ${side} — structure is turning, high reversal risk`
	} else if (isBOS && consecutiveBOS <= 2) {
		score = MAX_SCORE
		reason = `✅ Fresh BOS (${consecutiveBOS === 1 ? '1st' : '2nd'} in sequence) confirms ${side} continuation`
	} else if (isBOS && consecutiveBOS >= 3) {
		// Late-stage trend — penalize proportionally to how extended it is
		const penalty = Math.min(0.7, (consecutiveBOS - 2) * 0.2)
		score = MAX_SCORE * (1 - penalty)
		reason = `⚠️ BOS #${consecutiveBOS} in same direction — trend maturing, chasing an extended move`
	} else if (sequenceAligned) {
		score = MAX_SCORE * 0.65
		reason = `○ ${sequence} sequence supports ${side}, but no fresh BOS yet — early`
	} else if (sequenceOpposed) {
		score = MAX_SCORE * 0.2
		reason = `⚠️ ${sequence} sequence opposes ${side} — trading against prevailing structure`
	}

	return { score: Math.max(0, Math.min(MAX_SCORE, score)), reason, sequence, consecutiveBOS }
}

export const resetStructure = (symbol: string): void => {
	bosStreak.delete(symbol)
}
