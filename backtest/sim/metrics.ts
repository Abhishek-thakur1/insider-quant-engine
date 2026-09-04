// ============================================================
// backtest/sim/metrics.ts — per-detector performance aggregation
//
// Everything is in R-multiples, not rupees. R is scale-free, so a ₹50 stock and
// a 25,000 index are directly comparable, and — as the goal doc notes — a 40%
// win rate with 2.5R winners beats a 60% win rate with 0.6R winners. Ranking on
// win rate alone would order those backwards.
//
// TWO PERFORMANCE BLOCKS PER DETECTOR, and the reason matters:
//
//   gated   — only signals the JaneStreetFilter passed. What would have traded.
//   ungated — every signal the detector raised, gate ignored. The raw edge.
//
// Computing only the gated block was the original design and it was wrong: when
// the filter suppresses most or all of a detector's signals, the gated block is
// empty and the report can say nothing at all — not even whether the detector
// had an edge the filter threw away. Side-by-side is what answers the goal doc's
// actual question: is the filter over- or under-suppressing this detector?
//
// The sample-size flag is enforced here rather than in the report, so no
// consumer can present a 6-trade result as a finding.
// ============================================================

import { METRICS } from '../config.js'
import type { SimulatedTrade } from './exit.js'
import type { DetectorSpec } from '../registry.js'

export interface PerfBlock {
	trades: number
	winRate: number | null
	expectancyR: number | null
	totalR: number
	maxDrawdownR: number
	bestTradeR: number | null
	worstTradeR: number | null
	avgWinR: number | null
	avgLossR: number | null
	profitFactor: number | null
	holdingMinutes: { p25: number; median: number; p75: number; max: number } | null
	exitReasons: Record<string, number>
	tradesDeferredByLock: number
	/** Cumulative R after each trade, for the equity curve. */
	equityCurve: Array<{ ts: number; cumR: number }>
	rDistribution: number[]
	sufficientSample: boolean
}

export interface DetectorMetrics {
	detectorId: string
	displayName: string
	tier: DetectorSpec['tier']
	bias: DetectorSpec['bias']
	exitBasis: string

	signalsUngated: number
	tradesGated: number
	/** tradesGated / signalsUngated. Near zero ⇒ the filter is suppressing this. */
	gatePassRate: number
	/** Where the filter rejected, when it did. */
	rejections: Record<string, number>

	gated: PerfBlock
	ungated: PerfBlock

	sufficientSample: boolean
	sampleNote: string
}

const quantile = (sorted: number[], q: number): number => {
	if (sorted.length === 0) return 0
	const pos = (sorted.length - 1) * q
	const lo = Math.floor(pos)
	const hi = Math.ceil(pos)
	if (lo === hi) return sorted[lo]!
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

/**
 * Max peak-to-trough decline of the cumulative-R curve, computed on the trade
 * sequence. That is the right granularity: with no mark-to-market path for an
 * open position, an intra-trade drawdown is not observable from this data.
 */
const maxDrawdownR = (curve: number[]): number => {
	let peak = 0
	let maxDD = 0
	for (const cum of curve) {
		if (cum > peak) peak = cum
		const dd = peak - cum
		if (dd > maxDD) maxDD = dd
	}
	return maxDD
}

const perf = (trades: SimulatedTrade[]): PerfBlock => {
	const ordered = trades.slice().sort((a, b) => a.entryTs - b.entryTs)
	const rs = ordered.map((t) => t.r)
	const wins = rs.filter((r) => r > 0)
	const losses = rs.filter((r) => r <= 0)

	let cum = 0
	const equityCurve = ordered.map((t) => {
		cum += t.r
		return { ts: t.entryTs, cumR: Number(cum.toFixed(4)) }
	})

	const holdSorted = ordered.map((t) => t.holdingMinutes).sort((a, b) => a - b)
	const exitReasons: Record<string, number> = {}
	for (const t of ordered) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1

	const grossWin = wins.reduce((a, b) => a + b, 0)
	const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0))
	const n = ordered.length

	return {
		trades: n,
		winRate: n > 0 ? wins.length / n : null,
		expectancyR: n > 0 ? rs.reduce((a, b) => a + b, 0) / n : null,
		totalR: Number(rs.reduce((a, b) => a + b, 0).toFixed(4)),
		maxDrawdownR: Number(maxDrawdownR(equityCurve.map((p) => p.cumR)).toFixed(4)),
		bestTradeR: n > 0 ? Math.max(...rs) : null,
		worstTradeR: n > 0 ? Math.min(...rs) : null,
		avgWinR: wins.length > 0 ? grossWin / wins.length : null,
		avgLossR: losses.length > 0 ? -grossLoss / losses.length : null,
		profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
		holdingMinutes:
			n > 0
				? {
						p25: Math.round(quantile(holdSorted, 0.25)),
						median: Math.round(quantile(holdSorted, 0.5)),
						p75: Math.round(quantile(holdSorted, 0.75)),
						max: holdSorted[holdSorted.length - 1]!,
					}
				: null,
		exitReasons,
		tradesDeferredByLock: ordered.filter((t) => t.deferredByLock > 0).length,
		equityCurve,
		rDistribution: rs.map((r) => Number(r.toFixed(4))),
		sufficientSample: n >= METRICS.minGatedTradesForConfidence,
	}
}

export const computeMetrics = (
	spec: DetectorSpec,
	signalsUngated: number,
	rejections: Record<string, number>,
	/** ALL simulated trades, gate-rejected ones included (flagged by gatePassed). */
	allTrades: SimulatedTrade[],
): DetectorMetrics => {
	const gated = perf(allTrades.filter((t) => t.gatePassed))
	const ungated = perf(allTrades)

	const note = gated.sufficientSample
		? `${gated.trades} gated trades — at or above the ${METRICS.minGatedTradesForConfidence}-trade threshold.`
		: ungated.sufficientSample
			? `INSUFFICIENT GATED SAMPLE: only ${gated.trades} of ${signalsUngated} signals passed the filter, below the ${METRICS.minGatedTradesForConfidence}-trade threshold. The UNGATED block has ${ungated.trades} trades and is the more informative number here — read it as the detector's raw edge, and the gap between the two as how much the filter is suppressing.`
			: `INSUFFICIENT SAMPLE both gated (${gated.trades}) and ungated (${ungated.trades}), below the ${METRICS.minGatedTradesForConfidence}-trade threshold. Neither figure supports a conclusion.`

	return {
		detectorId: spec.id,
		displayName: spec.displayName,
		tier: spec.tier,
		bias: spec.bias,
		exitBasis: allTrades[0]?.exitBasis ?? spec.exitBasis,
		signalsUngated,
		tradesGated: gated.trades,
		gatePassRate: signalsUngated > 0 ? gated.trades / signalsUngated : 0,
		rejections,
		gated,
		ungated,
		sufficientSample: gated.sufficientSample,
		sampleNote: note,
	}
}

/**
 * Rank by GATED expectancy — that is what would actually have traded. An
 * insufficient-sample detector can never outrank a sufficient one, or a single
 * lucky 3-trade detector tops the table.
 */
export const rankByExpectancy = (all: DetectorMetrics[]): DetectorMetrics[] =>
	all.slice().sort((a, b) => {
		if (a.sufficientSample !== b.sufficientSample) return a.sufficientSample ? -1 : 1
		return (b.gated.expectancyR ?? -Infinity) - (a.gated.expectancyR ?? -Infinity)
	})

/** Combined curve for a set of detectors, merged on entry time. */
export const combinedEquityCurve = (
	all: DetectorMetrics[],
	which: 'gated' | 'ungated' = 'gated',
): Array<{ ts: number; cumR: number }> => {
	const points = all
		.flatMap((m) =>
			m[which].equityCurve.map((p, i) => ({ ts: p.ts, r: m[which].rDistribution[i] ?? 0 })),
		)
		.sort((a, b) => a.ts - b.ts)

	let cum = 0
	return points.map((p) => {
		cum += p.r
		return { ts: p.ts, cumR: Number(cum.toFixed(4)) }
	})
}
