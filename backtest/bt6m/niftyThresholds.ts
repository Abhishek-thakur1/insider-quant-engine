// ============================================================
// backtest/bt6m/niftyThresholds.ts — the Nifty threshold study runner (offline, cached data, no Fyers)
//
// docs/studies/nifty-thresholds/PREREGISTRATION.md (variant V approved by the owner 11 Nov; amendment 1 of
// that file fixes the implementation details below before any run).
//   --mode P    the live stack (the live ORE class)                       → <out>
//   --mode V    ORE caps scaled by OR20(t) / 69.82 (oreVariant.ts)          → <out>
//   --mode EQ   equivalence: per session, the live class vs the copy at caps 120/80 — every signals row and every
//               ORE "why no alert" record must be identical; exits 2 on any difference.
// Each session runs through backtest/bt6m/liveSession.ts with no equities (the 5 live Nifty detectors, the live
// filter and runAlertPipeline). Each Nifty fire then gets an INDEX-MOVE outcome (simulateIndexExit) under the
// 6-month study's fill rules. Outcomes are "not tradable as options".
// Usage: BACKTEST_MODE=true SHADOW_MODE=true CONFIRMATION_THRESHOLD=78 npx tsx backtest/bt6m/niftyThresholds.ts --mode P --out <file.jsonl>
// ============================================================

import '../core/bootEnv.js'

import fs from 'node:fs'
import { NIFTY_SYMBOL } from '../config.js'
import { installVirtualClock, istDateStringOf, istEpoch, istMinutesOf } from '../core/clock.js'
import { installMemoryRedis } from '../core/memoryRedis.js'
import { barsInRange, loadSeries, type Bar } from '../data/store.js'
import { installMemoryPg } from './memoryPg.js'
import { barPath, levelsBetween, reorderAfterOpen, runLiveSession, sameBarSide } from './liveSession.js'
import { NiftyOreVariant, type OreCaps } from './oreVariant.js'
import { LIVE_CAPITAL } from './liveRun.js'

export const LIVE_CAPS: OreCaps = { range: 120, risk: 80 }
export const OR20_REF = 69.82 // median opening range, 20 sessions 2026-05-15 → 2026-06-12 (pre-registered)
export const WARMUP_SESSIONS = 20 // OR20 needs 20 prior sessions; the first 20 are excluded from every mode
const DAY_MS = 86_400_000
const STEP_MS = 15_000

/** ORE's opening range: high − low of the 09:15–09:19 one-minute bars (its first 5-minute candle). */
export const openingRange = (bars: Bar[]): number | null => {
	const first = bars.filter((b) => { const m = istMinutesOf(b.t); return m >= 9 * 60 + 15 && m < 9 * 60 + 20 })
	if (first.length < 5) return null
	return Math.max(...first.map((b) => b.h)) - Math.min(...first.map((b) => b.l))
}

const median = (xs: number[]): number => {
	const s = [...xs].sort((a, b) => a - b)
	const m = Math.floor(s.length / 2)
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export const vCaps = (or20: number): OreCaps => ({ range: LIVE_CAPS.range * (or20 / OR20_REF), risk: LIVE_CAPS.risk * (or20 / OR20_REF) })

export interface IndexExit { exit: number; reason: 'STOP_LOSS' | 'TARGET' | 'TIME' | 'SESSION_END'; exitTs: number }

/**
 * The index-move outcome of a fire under the 6-month study's fill rules (amendments 1 and 3): the fire's own bar
 * continues from the tick after the fire (re-ordered adverse-first if the fire was on the bar's open tick); later
 * bars take the adverse extreme first when both levels are inside; a level crossed between two ticks of a bar fills
 * at the level; a bar opening beyond a level fills at the open; from 15:15 the position closes at the last price.
 */
export const simulateIndexExit = (bars: Bar[], fireTs: number, side: 'LONG' | 'SHORT', entry: number, stop: number, target: number, squareOffAt: number): IndexExit => {
	const pos = { side, stopLoss: stop, target }
	const hit = (p: number): IndexExit['reason'] | null =>
		side === 'LONG' ? (p <= stop ? 'STOP_LOSS' : p >= target ? 'TARGET' : null) : p >= stop ? 'STOP_LOSS' : p <= target ? 'TARGET' : null
	let last = entry
	let lastTs = fireTs
	const b0 = bars.findIndex((b) => b.t <= fireTs && fireTs < b.t + 60_000)
	if (b0 < 0) return { exit: entry, reason: 'SESSION_END', exitTs: fireTs }
	for (let bi = b0; bi < bars.length; bi++) {
		const bar = bars[bi]!
		let path = barPath(bar, bi === b0 ? null : sameBarSide(bar, [pos])).map((t) => t.price)
		let start = 0
		if (bi === b0) {
			const k = Math.floor((fireTs - bar.t) / STEP_MS)
			if (k === 0) path = reorderAfterOpen(path, [pos])
			start = k + 1
		}
		for (let i = start; i < path.length; i++) {
			const ts = bar.t + i * STEP_MS
			if (ts >= squareOffAt) return { exit: last, reason: 'TIME', exitTs: ts }
			const p = path[i]!
			// Within a bar (or after the fire's own tick) a level crossed between two prices fills at the level;
			// a bar's open (i = 0, not the fire bar) is taken as it is: the gap-through rule.
			if (i > 0 || bi === b0) for (const lv of levelsBetween(last, p, [pos])) {
				const r = hit(lv)
				if (r) return { exit: lv, reason: r, exitTs: ts }
			}
			const r = hit(p)
			if (r) return { exit: p, reason: r, exitTs: ts }
			last = p
			lastTs = ts
		}
	}
	return { exit: last, reason: 'SESSION_END', exitTs: lastTs }
}

const arg = (n: string): string | undefined => {
	const i = process.argv.indexOf(`--${n}`)
	return i >= 0 ? process.argv[i + 1] : undefined
}

/**
 * Fields compared in the equivalence run: everything in a signals row except its random id and the paper row id
 * (both runs write into one in-memory paper table, so ids keep counting; whether a trade was registered is compared
 * through `trade_id === null`).
 */
const comparable = (s: Record<string, unknown>) => {
	const { signal_id: _id, trade_id: tid, ...rest } = s
	rest.has_trade = tid !== null
	return JSON.stringify(rest)
}

const main = async (): Promise<number> => {
	if (process.env.BACKTEST_MODE !== 'true' || process.env.SHADOW_MODE !== 'true' || process.env.CONFIRMATION_THRESHOLD !== '78') throw new Error('BACKTEST_MODE=true SHADOW_MODE=true CONFIRMATION_THRESHOLD=78 are required (live settings)')
	const mode = arg('mode')
	const out = arg('out')
	if (mode !== 'P' && mode !== 'V' && mode !== 'EQ') throw new Error('--mode P|V|EQ')
	if (mode !== 'EQ' && !out) throw new Error('--out <file.jsonl>')
	const series = loadSeries(NIFTY_SYMBOL, '1')
	if (!series?.bars.length) throw new Error('no cached Nifty 1-minute series')
	const days = [...new Set(series.bars.map((b) => istDateStringOf(b.t)))].sort()
	const sessions: { day: string; bars: Bar[]; or: number | null; prevClose: number | null }[] = []
	for (const day of days) {
		const bars = barsInRange(series.bars, istEpoch(day, 0), istEpoch(day, 0) + DAY_MS)
		if (bars.length < 300) continue
		sessions.push({ day, bars, or: openingRange(bars), prevClose: sessions.length ? sessions[sessions.length - 1]!.bars.at(-1)!.c : null })
	}
	const { uninstall: unRedis } = installMemoryRedis()
	const { store: paper, uninstall: unPg } = installMemoryPg()
	const unClock = installVirtualClock(istEpoch(sessions[0]!.day, 9 * 60))
	const w = out ? fs.createWriteStream(out, { flags: 'w' }) : null
	const log = console.log
	let mismatches = 0
	let compared = 0
	try {
		for (let si = WARMUP_SESSIONS; si < sessions.length; si++) {
			const s = sessions[si]!
			const prior = sessions.slice(si - WARMUP_SESSIONS, si).map((x) => x.or).filter((x): x is number => x !== null)
			const or20 = median(prior)
			const run = async (ore?: () => NiftyOreVariant) => {
				console.log = () => {}
				try {
					return await runLiveSession({ sessionDate: s.day, barsBySymbol: new Map([[NIFTY_SYMBOL, s.bars]]), entries: [], paper, config: LIVE_CAPITAL, ...(ore ? { niftyOre: ore } : {}) })
				} finally {
					console.log = log
				}
			}
			if (mode === 'EQ') {
				const a = await run()
				const b = await run(() => new NiftyOreVariant(LIVE_CAPS))
				const sa = a.signals.map((x) => comparable(x as Record<string, unknown>))
				const sb = b.signals.map((x) => comparable(x as Record<string, unknown>))
				const da = JSON.stringify(a.diagnostics.filter((d) => d.detector === 'Nifty Opening Range Explosion'))
				const db = JSON.stringify(b.diagnostics.filter((d) => d.detector === 'Nifty Opening Range Explosion'))
				compared++
				if (JSON.stringify(sa) !== JSON.stringify(sb) || da !== db || a.errors.length || b.errors.length) {
					mismatches++
					if (mismatches <= 5) log(JSON.stringify({ session: s.day, signals: [sa.length, sb.length], diagEqual: da === db, errors: [a.errors.slice(0, 2), b.errors.slice(0, 2)] }))
				}
				continue
			}
			const caps = mode === 'P' ? LIVE_CAPS : vCaps(or20)
			const r = await run(mode === 'V' ? () => new NiftyOreVariant(caps) : undefined)
			const squareOffAt = istEpoch(s.day, 15 * 60 + 15)
			const signals = r.signals.map((x) => {
				const sig = x as Record<string, unknown>
				const sl = sig.trigger_sl == null ? null : Number(sig.trigger_sl)
				const t1 = sig.trigger_t1 == null ? null : Number(sig.trigger_t1)
				const entry = Number(sig.price)
				const side = sig.direction as 'LONG' | 'SHORT'
				const outcome = sl !== null && t1 !== null && sl !== entry ? simulateIndexExit(s.bars, Date.parse(String(sig.fired_at)), side, entry, sl, t1, squareOffAt) : null
				const grossR = outcome ? ((side === 'LONG' ? outcome.exit - entry : entry - outcome.exit) / Math.abs(entry - sl!)) : null
				return {
					detector: sig.detector, direction: side, fired_at: sig.fired_at, price: entry, sl, t1, score: sig.score, filter_result: sig.filter_result,
					rejected_at: sig.rejected_at, alert_sent: sig.alert_sent, alert_suppressed_reason: sig.alert_suppressed_reason,
					riskPts: sl === null ? null : Math.abs(entry - sl), outcome, grossR,
				}
			})
			const diag: Record<string, number> = {}
			for (const d of r.diagnostics) diag[`${d.detector}|${d.reason}`] = (diag[`${d.detector}|${d.reason}`] ?? 0) + 1
			w!.write(JSON.stringify({ session: s.day, mode, or: s.or, or20, prevClose: s.prevClose, caps, signals, diag, errors: r.errors.slice(0, 5) }) + '\n')
		}
	} finally {
		console.log = log
		w?.end()
		unClock()
		unPg()
		unRedis()
	}
	if (mode === 'EQ') {
		log(JSON.stringify({ mode, sessionsCompared: compared, mismatches, verdict: mismatches === 0 ? 'IDENTICAL' : 'DIFFERENT' }))
		return mismatches === 0 ? 0 : 2
	}
	log(JSON.stringify({ mode, out, sessions: sessions.length - WARMUP_SESSIONS }))
	return 0
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('backtest/bt6m/niftyThresholds.ts')) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1) })
