// ============================================================
// screener/indicators.ts — pure daily-bar indicators
//
// Every function takes bars ALREADY CUT at the as-of date (screen.ts does the
// cut), so nothing here can see the future. Bars are ascending by time.
// Functions return null when there isn't enough history rather than guessing.
// ============================================================

/** One daily OHLCV bar. `t` = epoch milliseconds (same shape as backtest/data/store.ts). */
export interface DailyBar {
	t: number
	o: number
	h: number
	l: number
	c: number
	v: number
}

const IST_MS = 5.5 * 3600 * 1000
export const istDay = (t: number): string => new Date(t + IST_MS).toISOString().slice(0, 10)

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
const last = <T>(xs: T[], n: number): T[] => xs.slice(Math.max(0, xs.length - n))

/** EMA over the whole series, seeded with the SMA of the first `period` closes. */
export const ema = (closes: number[], period: number): number | null => {
	if (closes.length < period) return null
	const k = 2 / (period + 1)
	let e = mean(closes.slice(0, period))
	for (let i = period; i < closes.length; i++) e = closes[i]! * k + e * (1 - k)
	return e
}

/** SMA of the `period` closes ending `offset` bars before the last. */
export const sma = (closes: number[], period: number, offset = 0): number | null => {
	const end = closes.length - offset
	if (end < period) return null
	return mean(closes.slice(end - period, end))
}

/** Mean daily range % over the last n bars, (H − L) / C × 100 — same formula as the old screener. */
export const adrPct = (bars: DailyBar[], n: number): number | null => {
	if (bars.length < n) return null
	return mean(last(bars, n).map((b) => ((b.h - b.l) / b.c) * 100))
}

/** Mean daily turnover (close × volume) over the last n bars. Uses what exists if fewer. */
export const avgTurnover = (bars: DailyBar[], n: number): number =>
	bars.length === 0 ? 0 : mean(last(bars, n).map((b) => b.c * b.v))

export const avgVolume = (bars: DailyBar[], n: number, skipLast = 0): number | null => {
	const src = bars.slice(0, bars.length - skipLast)
	if (src.length === 0) return null
	return mean(last(src, n).map((b) => b.v))
}

/** Return over n bars: close_t / close_{t−n} − 1. */
export const periodReturn = (bars: DailyBar[], n: number): number | null => {
	if (bars.length < n + 1) return null
	const now = bars[bars.length - 1]!.c
	const then = bars[bars.length - 1 - n]!.c
	return then > 0 ? now / then - 1 : null
}

/**
 * Benchmark return over the SAME dates as the stock's n-bar return: from the
 * benchmark close on (or last before) the stock's start date to the benchmark
 * close on (or last before) the stock's end date. Keeps a suspended stock's
 * window aligned in calendar terms.
 */
export const alignedBenchmarkReturn = (stock: DailyBar[], bench: BenchIndex, n: number): number | null => {
	if (stock.length < n + 1) return null
	const start = bench.closeOnOrBefore(stock[stock.length - 1 - n]!.t)
	const end = bench.closeOnOrBefore(stock[stock.length - 1]!.t)
	return start && end ? end / start - 1 : null
}

/** Benchmark closes indexed for "close on or before t" lookups (binary search). */
export class BenchIndex {
	readonly ts: number[]
	readonly closes: number[]
	constructor(bars: DailyBar[]) {
		this.ts = bars.map((b) => b.t)
		this.closes = bars.map((b) => b.c)
	}
	closeOnOrBefore(t: number): number | null {
		let lo = 0
		let hi = this.ts.length - 1
		let ans = -1
		while (lo <= hi) {
			const mid = (lo + hi) >> 1
			if (this.ts[mid]! <= t) {
				ans = mid
				lo = mid + 1
			} else hi = mid - 1
		}
		return ans >= 0 ? this.closes[ans]! : null
	}
}

/**
 * Residual (beta-adjusted) momentum over the last `n` daily log returns:
 * OLS r = α + β·r_B + ε, score = α·√m / σ_ε (t-stat of alpha). A high-beta
 * stock that only rose with the market scores ~0; persistent outperformance
 * scores high.
 */
export const residualMomentum = (
	stock: DailyBar[],
	bench: BenchIndex,
	n: number,
): { score: number; beta: number; alpha: number } | null => {
	if (stock.length < n + 1) return null
	const rs: number[] = []
	const rb: number[] = []
	const window = stock.slice(stock.length - 1 - n)
	for (let i = 1; i < window.length; i++) {
		const b0 = bench.closeOnOrBefore(window[i - 1]!.t)
		const b1 = bench.closeOnOrBefore(window[i]!.t)
		if (!b0 || !b1 || window[i - 1]!.c <= 0) continue
		rs.push(Math.log(window[i]!.c / window[i - 1]!.c))
		rb.push(Math.log(b1 / b0))
	}
	const m = rs.length
	if (m < Math.max(20, Math.floor(n * 0.8))) return null
	const mx = mean(rb)
	const my = mean(rs)
	let sxx = 0
	let sxy = 0
	for (let i = 0; i < m; i++) {
		sxx += (rb[i]! - mx) ** 2
		sxy += (rb[i]! - mx) * (rs[i]! - my)
	}
	if (sxx === 0) return null
	const beta = sxy / sxx
	const alpha = my - beta * mx
	// OLS residuals (with intercept) always sum to zero, so they can't carry the
	// signal. The signal is the beta-adjusted excess return Σ(r − β·r_B) = m·α,
	// scaled by residual volatility: score = m·α / (σ_ε·√m) = α·√m / σ_ε, i.e.
	// the t-statistic of alpha.
	const resid = rs.map((r, i) => r - alpha - beta * rb[i]!)
	const sd = Math.sqrt(resid.reduce((a, e) => a + e * e, 0) / Math.max(1, m - 2))
	if (sd === 0) return null
	return { score: (alpha * Math.sqrt(m)) / sd, beta, alpha }
}

/** close / max(high over last n bars) − 1. ≤ 0. Uses available bars if fewer than n. */
export const proximityToHigh = (bars: DailyBar[], n: number): number | null => {
	if (bars.length === 0) return null
	const hi = Math.max(...last(bars, n).map((b) => b.h))
	return hi > 0 ? bars[bars.length - 1]!.c / hi - 1 : null
}

/** (max high − min low) over the last n bars, as % of the last close. */
export const rangePct = (bars: DailyBar[], n: number): number | null => {
	if (bars.length < n) return null
	const w = last(bars, n)
	return ((Math.max(...w.map((b) => b.h)) - Math.min(...w.map((b) => b.l))) / bars[bars.length - 1]!.c) * 100
}

/** Same proxy as the backtest harness: a zero-range bar with volume = pinned at a band. */
export const looksCircuitLocked = (b: DailyBar): boolean => b.h === b.l && b.o === b.c && b.h === b.c && b.v > 0

/**
 * Percentile rank 1–99 of each value within the set (ties share the average
 * rank). A single value gets 50.
 */
export const percentileRanks = (values: Map<string, number>): Map<string, number> => {
	const entries = [...values.entries()].sort((a, b) => a[1] - b[1])
	const n = entries.length
	const out = new Map<string, number>()
	if (n === 0) return out
	if (n === 1) {
		out.set(entries[0]![0], 50)
		return out
	}
	let i = 0
	while (i < n) {
		let j = i
		while (j + 1 < n && entries[j + 1]![1] === entries[i]![1]) j++
		const avgPos = (i + j) / 2
		const rank = 1 + (98 * avgPos) / (n - 1)
		for (let k = i; k <= j; k++) out.set(entries[k]![0], Math.round(rank * 10) / 10)
		i = j + 1
	}
	return out
}
