// ============================================================
// core/emaTrend.ts — Nifty EMA / trend-continuation engine (pure; study + live shadow)
//
// Pre-registered in config/nifty_ema_study.json and
// backtest/studies/nifty-ema-trend/PREREGISTRATION.md (committed before any
// run). Offline, report only: nothing here is imported by live code.
//
// No look-ahead: every decision at bar t reads indicator values computed from
// bars 0..t only (emaSeries / sessionTwap are causal), and exits only look at
// bars strictly after the entry bar. tests/emaTrend.test.ts mutates future
// bars and asserts the earlier signals do not change.
// ============================================================

export interface Bar {
	t: number // bar START, epoch ms
	o: number
	h: number
	l: number
	c: number
}

export interface SBar extends Bar {
	day: string // IST date of the bar
	startMin: number // IST minutes after midnight
	closeMin: number // startMin + bar minutes
}

export type Side = 'LONG' | 'SHORT'
export type VariantId = 'V0' | 'V1' | 'V2'

export interface StudyParams {
	barMinutes: number
	entryFirstCloseMinute: number
	entryLastCloseMinute: number
	forcedExitCloseMinute: number
	slopeLookbackBars: number
	stopLookbackBars: number
	stopBufferPts: number
	maxStopPts: number
	roundTripPts: number
	costMultiplier: number
	touchPct: number
	minBarsBetweenEntries: number
}

export interface VariantSpec {
	id: VariantId
	label: string // e.g. 'V1' or 'V1-ema10'
	/** V0: fast/slow crossover; trail EMA = trailEma. */
	fast?: number
	slow?: number
	/** V1/V2: the trend EMA (20, or 10/30 in robustness runs) — also the trail. */
	trendEma: number
}

export interface Trade {
	variant: string
	side: Side
	sessionDate: string
	entryIdx: number
	entryTs: number // close time of the entry bar, epoch ms
	entry: number
	stop: number
	risk: number
	exitIdx: number
	exitTs: number
	exit: number
	reason: 'STOP' | 'STOP_GAP' | 'TRAIL' | 'TIME' | 'SESSION_END_GAP'
	pts: number // signed gross index points
	r: number // (pts - cost) / risk
	r2x: number // with costMultiplier × cost
	holdMin: number
}

export interface RunResult {
	trades: Trade[]
	signals: number
	skippedOpenPosition: number
	skippedWideStop: number
	sessionEndGaps: string[]
	/** What happened to every signal, in order. */
	signalLog: { sessionDate: string; side: Side; outcome: 'TRADE' | 'SKIP_OPEN' | 'SKIP_WIDE' }[]
}

const IST_MS = 330 * 60_000

export const istDay = (t: number): string => new Date(t + IST_MS).toISOString().slice(0, 10)
export const istMinute = (t: number): number => {
	const d = new Date(t + IST_MS)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

export const toSessionBars = (bars: Bar[], barMinutes: number): SBar[] =>
	bars.map((b) => {
		const startMin = istMinute(b.t)
		return { ...b, day: istDay(b.t), startMin, closeMin: startMin + barMinutes }
	})

/** EMA(n) of closes, continuous, seeded with the SMA of the first n closes. null before index n-1. */
export const emaSeries = (closes: number[], n: number): (number | null)[] => {
	const out: (number | null)[] = new Array(closes.length).fill(null)
	if (closes.length < n) return out
	let sum = 0
	for (let i = 0; i < n; i++) sum += closes[i]!
	let e = sum / n
	out[n - 1] = e
	const a = 2 / (n + 1)
	for (let i = n; i < closes.length; i++) {
		e = a * closes[i]! + (1 - a) * e
		out[i] = e
	}
	return out
}

/** Session TWAP of typical price (H+L+C)/3, bars 0..t of the same IST day (index volume is 0). */
export const sessionTwap = (bars: SBar[]): number[] => {
	const out: number[] = new Array(bars.length)
	let day = ''
	let sum = 0
	let n = 0
	for (let i = 0; i < bars.length; i++) {
		const b = bars[i]!
		if (b.day !== day) {
			day = b.day
			sum = 0
			n = 0
		}
		sum += (b.h + b.l + b.c) / 3
		n++
		out[i] = sum / n
	}
	return out
}

interface Indicators {
	trend: (number | null)[] // trend / trail EMA
	fast: (number | null)[]
	slow: (number | null)[]
	vwap: number[]
}

export const buildIndicators = (bars: SBar[], v: VariantSpec): Indicators => {
	const closes = bars.map((b) => b.c)
	return {
		trend: emaSeries(closes, v.trendEma),
		fast: v.fast ? emaSeries(closes, v.fast) : [],
		slow: v.slow ? emaSeries(closes, v.slow) : [],
		vwap: sessionTwap(bars),
	}
}

/** V1 alignment at bar i for a side (uses bars <= i only). */
export const aligned = (bars: SBar[], ind: Indicators, i: number, side: Side, slopeBars: number): boolean => {
	const e = ind.trend[i]
	const ePrev = i - slopeBars >= 0 ? ind.trend[i - slopeBars] : null
	if (e == null || ePrev == null) return false
	// The slope may compare across a session boundary: the EMA is continuous by pre-registration.
	const c = bars[i]!.c
	const vw = ind.vwap[i]!
	return side === 'SHORT' ? c < e && e < ePrev && c < vw : c > e && e > ePrev && c > vw
}

export interface Signal {
	i: number
	side: Side
}

/**
 * All signals of a variant, independent of position state (one-position is
 * applied by the simulator). Causal: signal at i reads bars/indicators <= i.
 */
export const findSignals = (bars: SBar[], ind: Indicators, v: VariantSpec, p: StudyParams): Signal[] => {
	const out: Signal[] = []
	const inWindow = (i: number) => bars[i]!.closeMin >= p.entryFirstCloseMinute && bars[i]!.closeMin <= p.entryLastCloseMinute
	if (v.id === 'V0') {
		for (let i = 1; i < bars.length; i++) {
			const f0 = ind.fast[i - 1], s0 = ind.slow[i - 1], f1 = ind.fast[i], s1 = ind.slow[i]
			if (f0 == null || s0 == null || f1 == null || s1 == null) continue
			if (!inWindow(i)) continue
			if (f0 <= s0 && f1 > s1) out.push({ i, side: 'LONG' })
			else if (f0 >= s0 && f1 < s1) out.push({ i, side: 'SHORT' })
		}
		return out
	}
	for (const side of ['LONG', 'SHORT'] as const) {
		let episodeEntered = false // V1: the episode's entry already taken
		let lastV2 = -Infinity
		for (let i = 0; i < bars.length; i++) {
			const newDay = i === 0 || bars[i]!.day !== bars[i - 1]!.day
			const al = aligned(bars, ind, i, side, p.slopeLookbackBars)
			const prevAl = !newDay && i > 0 && aligned(bars, ind, i - 1, side, p.slopeLookbackBars)
			if (!al) {
				episodeEntered = false
				lastV2 = -Infinity
				continue
			}
			if (!prevAl) {
				// a new episode starts at i (episodes never cross a session: VWAP resets)
				episodeEntered = false
				lastV2 = -Infinity
			}
			if (!inWindow(i)) continue
			if (v.id === 'V1') {
				// first in-window bar of the episode (an episode that began before 09:30 enters at the first in-window bar)
				if (!episodeEntered) {
					out.push({ i, side })
					episodeEntered = true
				}
				continue
			}
			// V2: pullback touch of trend EMA or VWAP, close back on the trend side
			const b = bars[i]!
			const levels = [ind.trend[i]!, ind.vwap[i]!]
			const k = p.touchPct / 100
			const touched = levels.some((lv) => (side === 'SHORT' ? b.h >= lv * (1 - k) && b.c < lv : b.l <= lv * (1 + k) && b.c > lv))
			if (touched && i - lastV2 >= p.minBarsBetweenEntries) {
				out.push({ i, side })
				lastV2 = i
			}
		}
	}
	return out.sort((a, b) => a.i - b.i || (a.side < b.side ? -1 : 1))
}

/** Initial stop for an entry at bar i: extreme of bars i-(L-1)..i ± buffer. */
export const initialStop = (bars: SBar[], i: number, side: Side, p: StudyParams): number => {
	const from = Math.max(0, i - (p.stopLookbackBars - 1))
	const win = bars.slice(from, i + 1)
	return side === 'SHORT' ? Math.max(...win.map((b) => b.h)) + p.stopBufferPts : Math.min(...win.map((b) => b.l)) - p.stopBufferPts
}

/** Exit of a position entered at the close of bar i. Looks at bars > i only. */
export const simulateExit = (
	bars: SBar[],
	trail: (number | null)[],
	i: number,
	side: Side,
	stop: number,
	p: StudyParams,
): { j: number; price: number; reason: Trade['reason'] } => {
	for (let j = i + 1; j < bars.length; j++) {
		const b = bars[j]!
		if (b.day !== bars[i]!.day) {
			// previous bar was the session's last bar and closed before 15:15 — data gap
			return { j: j - 1, price: bars[j - 1]!.c, reason: 'SESSION_END_GAP' }
		}
		// 1. stop first (conservative)
		if (side === 'SHORT') {
			if (b.o >= stop) return { j, price: b.o, reason: 'STOP_GAP' }
			if (b.h >= stop) return { j, price: stop, reason: 'STOP' }
		} else {
			if (b.o <= stop) return { j, price: b.o, reason: 'STOP_GAP' }
			if (b.l <= stop) return { j, price: stop, reason: 'STOP' }
		}
		// 2. trailing close through the EMA
		const e = trail[j]
		if (e != null && (side === 'SHORT' ? b.c > e : b.c < e)) return { j, price: b.c, reason: 'TRAIL' }
		// 3. forced time exit
		if (b.closeMin >= p.forcedExitCloseMinute) return { j, price: b.c, reason: 'TIME' }
	}
	const last = bars.length - 1
	return { j: last, price: bars[last]!.c, reason: 'SESSION_END_GAP' }
}

export const runVariant = (bars: SBar[], v: VariantSpec, p: StudyParams): RunResult => {
	const ind = buildIndicators(bars, v)
	const signals = findSignals(bars, ind, v, p)
	const trades: Trade[] = []
	let busyUntil = -1 // index of the exit bar of the open position
	let skippedOpenPosition = 0
	let skippedWideStop = 0
	const gaps = new Set<string>()
	const signalLog: RunResult['signalLog'] = []
	const barMs = p.barMinutes * 60_000
	for (const s of signals) {
		// A position open at the START of bar s.i (entered earlier, exiting at or after s.i) blocks it.
		if (s.i <= busyUntil) {
			skippedOpenPosition++
			signalLog.push({ sessionDate: bars[s.i]!.day, side: s.side, outcome: 'SKIP_OPEN' })
			continue
		}
		const b = bars[s.i]!
		const stop = initialStop(bars, s.i, s.side, p)
		const risk = Math.abs(b.c - stop)
		if (!(risk > 0) || risk > p.maxStopPts) {
			skippedWideStop++
			signalLog.push({ sessionDate: b.day, side: s.side, outcome: 'SKIP_WIDE' })
			continue
		}
		signalLog.push({ sessionDate: b.day, side: s.side, outcome: 'TRADE' })
		const x = simulateExit(bars, ind.trend, s.i, s.side, stop, p)
		if (x.reason === 'SESSION_END_GAP') gaps.add(b.day)
		const pts = s.side === 'LONG' ? x.price - b.c : b.c - x.price
		const cost = p.roundTripPts
		trades.push({
			variant: v.label,
			side: s.side,
			sessionDate: b.day,
			entryIdx: s.i,
			entryTs: b.t + barMs,
			entry: b.c,
			stop,
			risk,
			exitIdx: x.j,
			exitTs: bars[x.j]!.t + barMs,
			exit: x.price,
			reason: x.reason,
			pts,
			r: (pts - cost) / risk,
			r2x: (pts - cost * p.costMultiplier) / risk,
			holdMin: (bars[x.j]!.t - b.t) / 60_000,
		})
		busyUntil = x.j
	}
	return { trades, signals: signals.length, skippedOpenPosition, skippedWideStop, sessionEndGaps: [...gaps].sort(), signalLog }
}

// ── config/nifty_ema_study.json → engine inputs (shared by the study runner and the live shadow) ──

/** The subset of config/nifty_ema_study.json the engine reads. */
export interface EmaStudyConfig {
	data: { intradayResolution: string }
	session: { entryFirstCloseMinute: number; entryLastCloseMinute: number; forcedExitCloseMinute: number }
	indicators: { slopeLookbackBars: number }
	variants: { V0: { fast: number; slow: number }; V1: { ema: number }; V2: { ema: number; touchPct: number; minBarsBetweenEntries: number } }
	robustness: { emaVariants: number[] }
	exits: { stopLookbackBars: number; stopBufferPts: number; maxStopPts: number }
	costs: { roundTripPts: number; sensitivityMultiplier: number }
}

export const studyParams = (cfg: EmaStudyConfig): StudyParams => ({
	barMinutes: Number(cfg.data.intradayResolution),
	entryFirstCloseMinute: cfg.session.entryFirstCloseMinute,
	entryLastCloseMinute: cfg.session.entryLastCloseMinute,
	forcedExitCloseMinute: cfg.session.forcedExitCloseMinute,
	slopeLookbackBars: cfg.indicators.slopeLookbackBars,
	stopLookbackBars: cfg.exits.stopLookbackBars,
	stopBufferPts: cfg.exits.stopBufferPts,
	maxStopPts: cfg.exits.maxStopPts,
	roundTripPts: cfg.costs.roundTripPts,
	costMultiplier: cfg.costs.sensitivityMultiplier,
	touchPct: cfg.variants.V2.touchPct,
	minBarsBetweenEntries: cfg.variants.V2.minBarsBetweenEntries,
})

/** The three pre-registered variants (EMA20). Robustness runs are study-only. */
export const studyVariants = (cfg: EmaStudyConfig): VariantSpec[] => [
	{ id: 'V0', label: 'V0 crossover 9/21', fast: cfg.variants.V0.fast, slow: cfg.variants.V0.slow, trendEma: 20 },
	{ id: 'V1', label: 'V1 alignment (EMA20)', trendEma: cfg.variants.V1.ema },
	{ id: 'V2', label: 'V2 pullback (EMA20)', trendEma: cfg.variants.V2.ema },
]
