// ============================================================
// backtest/studies/edge-map/analyze.ts — the pre-registered analysis
//
//   BACKTEST_MODE=true npx tsx backtest/studies/edge-map/analyze.ts <replay-dir> <live-dir> <out-dir>
//
// Implements docs/studies/edge-map/PREREGISTRATION.md (frozen at 54cf86f). Offline only: reads
// the collector's sig_*.jsonl, the candle cache and the frozen live CSVs. Writes results.json and
// tables.md. Every number in REPORT.md comes from these two files.
// ============================================================
import '../../core/bootEnv.js'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { DATA, SIM } from '../../config.js'
import { istDateStringOf, istMinutesOf } from '../../core/clock.js'
import { loadSeries, type Bar } from '../../data/store.js'
import { looksCircuitLocked } from '../../replay/barToTicks.js'
import { simulateExit } from '../../sim/exit.js'
import type { RawSignal } from '../../replay/engine.js'

// ── pre-registered constants (§3, §4) ───────────────────────────────────────
const SEED = 20261023
const REPS = 10_000
const FLOOR = 30
const SPLIT = '2025-01-01' // train < SPLIT <= test
const BASE_COST_BPS = 17 // 5 bps slippage per leg + 7 bps charges, round trip (ASSUMED)
const SLIP_ONLY_BPS = 10 // the harness convention: 5 bps per leg, no charges
const COST_MULTS = [0, 0.5, 1, 2, 3]
const TARGET_R = 1.5
const BH_Q = 0.1
const ALPHA = 0.05
const EDGE_MIN_R = 0.05

type Side = 'LONG' | 'SHORT'
interface Sig { det: string; day: string; ts: number; symbol: string; side: Side; price: number; vwap: number; trigger: string; gate: { passed: boolean; score: number; regime: string; rejectedAt: string | null } | null }
interface Trade { day: string; ds: string; tod: string; regime: string; tier: string; score: number; passed: boolean; entry: number; risk: number; gross: number }

const DET_SHORT: Record<string, string> = { volatility_contraction: 'VCP', stock_momentum_breakout: 'SMB', 'Volatility_Contraction_V2': 'VCP', 'Stock Momentum Breakout': 'SMB' }
export const tod = (ms: number): string => { const m = istMinutesOf(ms); return m < 10 * 60 + 30 ? 'T1' : m < 13 * 60 + 30 ? 'T2' : 'T3' }
export const tier = (s: number): string => (s < 60 ? '<60' : s < 70 ? '60-69' : s < 78 ? '70-77' : '>=78')
const costR = (bps: number, entry: number, risk: number) => (bps * entry) / (10_000 * risk)
const net = (t: Trade, mult: number) => t.gross - costR(mult * BASE_COST_BPS, t.entry, t.risk)

// ── RNG + day-block bootstrap ───────────────────────────────────────────────
const mulberry = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))]! }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

// A statistic is a per-trade vector summed per day plus a finisher, so a bootstrap rep sums
// the drawn days' vectors instead of re-pooling trades (same estimator, far cheaper).
export interface Stat<T> { vec: (t: T) => number[]; fin: (a: number[]) => number }
export const MEAN = <T>(v: (t: T) => number): Stat<T> => ({ vec: (t) => [v(t), 1], fin: (a) => a[0]! / a[1]! })
/** OLS slope of y on x: (Sxy - SxSy/n) / (Sxx - Sx²/n). */
export const SLOPE = <T>(x: (t: T) => number, y: (t: T) => number): Stat<T> => ({
	vec: (t) => { const a = x(t), b = y(t); return [1, a, b, a * b, a * a] },
	fin: (s) => { const den = s[4]! - s[1]! ** 2 / s[0]!; return den > 0 ? (s[3]! - (s[1]! * s[2]!) / s[0]!) / den : NaN },
})

/** Resample trading days with replacement, REPS times. */
function bootstrap(dayVecs: number[][], fin: (a: number[]) => number, key: string): number[] {
	const rnd = mulberry(SEED ^ hash(key))
	const k = dayVecs[0]!.length
	const out: number[] = []
	for (let r = 0; r < REPS; r++) {
		const acc = new Array<number>(k).fill(0)
		for (let i = 0; i < dayVecs.length; i++) { const v = dayVecs[Math.floor(rnd() * dayVecs.length)]!; for (let j = 0; j < k; j++) acc[j]! += v[j]! }
		const s = fin(acc)
		if (Number.isFinite(s)) out.push(s)
	}
	return out
}

export interface Est { n: number; days: number; mean: number; lo: number; hi: number; p2: number; pUp: number }
export function estimate<T>(items: T[], dayOf: (t: T) => string, stat: Stat<T>, key: string): Est {
	if (!items.length) return { n: 0, days: 0, mean: NaN, lo: NaN, hi: NaN, p2: NaN, pUp: NaN }
	const byDay = new Map<string, number[]>()
	for (const it of items) { const v = stat.vec(it); const d = dayOf(it); const a = byDay.get(d); if (a) v.forEach((x, j) => (a[j]! += x)); else byDay.set(d, v) }
	const days = byDay.size
	const total = [...byDay.values()].reduce((a, v) => a.map((x, j) => x + v[j]!), new Array<number>(stat.vec(items[0]!).length).fill(0))
	const m = stat.fin(total)
	if (items.length < 2 || days < 2) return { n: items.length, days, mean: m, lo: NaN, hi: NaN, p2: NaN, pUp: NaN }
	const b = bootstrap([...byDay.values()], stat.fin, key)
	const le0 = b.filter((v) => v <= 0).length / b.length
	const ge0 = b.filter((v) => v >= 0).length / b.length
	return { n: items.length, days, mean: m, lo: pct(b, 0.025), hi: pct(b, 0.975), p2: Math.min(1, 2 * Math.min(le0, ge0)), pUp: le0 }
}
export const holm = (ps: number[], alpha = ALPHA) => { const idx = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]); const rej = new Array(ps.length).fill(false); for (let k = 0; k < idx.length; k++) { if (idx[k]![0] <= alpha / (idx.length - k)) rej[idx[k]![1]] = true; else break } return rej as boolean[] }
export const bh = (ps: number[], q = BH_Q) => { const idx = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]); let kMax = -1; idx.forEach(([p], k) => { if (p <= ((k + 1) / idx.length) * q) kMax = k }); const rej = new Array(ps.length).fill(false); for (let k = 0; k <= kMax; k++) rej[idx[k]![1]] = true; return rej as boolean[] }

// ── exit simulation with explicit levels (harness mechanics, no slippage: costs are applied in R) ──
export function simExit(side: Side, entry: number, stop: number, target: number, fwd: Bar[]): { exit: number; reason: string } {
	const isLong = side === 'LONG'
	for (const bar of fwd) {
		const stopT = isLong ? bar.l <= stop : bar.h >= stop
		const tgtT = isLong ? bar.h >= target : bar.l <= target
		if (stopT && SIM.circuitLockZeroRange && looksCircuitLocked(bar)) continue
		if (stopT) return { exit: stop, reason: tgtT ? 'stop(both)' : 'stop' }
		if (tgtT) return { exit: target, reason: 'target' }
		if (istMinutesOf(bar.t) >= SIM.forceExitIstMinutes) return { exit: bar.c, reason: 'square-off' }
	}
	const last = fwd[fwd.length - 1]
	return last ? { exit: last.c, reason: 'session-end' } : { exit: entry, reason: 'no-forward-data' }
}
export const parseSL = (trigger: string): number | null => { const m = trigger.match(/SL ₹\s*([\d,]+(?:\.\d+)?)/); return m ? Number(m[1]!.replace(/,/g, '')) : null }

// ── daily ATR(14, Wilder) and ADR(20) known BEFORE each session ─────────────
function dailyRefs(symbol: string): Map<string, { atr: number | null; adr: number | null }> {
	const bars = loadSeries(symbol, DATA.dailyResolution)?.bars ?? []
	const out = new Map<string, { atr: number | null; adr: number | null }>()
	let atr: number | null = null
	const trs: number[] = []
	for (let i = 0; i < bars.length; i++) {
		// refs for session i use bars 0..i-1 only
		const prior = bars.slice(Math.max(0, i - 20), i)
		const adr = prior.length === 20 ? mean(prior.map((b) => b.h - b.l)) : null
		out.set(istDateStringOf(bars[i]!.t), { atr, adr })
		const b = bars[i]!
		const pc = i > 0 ? bars[i - 1]!.c : b.c
		const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc))
		trs.push(tr)
		if (trs.length === 14) atr = mean(trs)
		else if (trs.length > 14 && atr !== null) atr = (atr * 13 + tr) / 14
	}
	return out
}

// ── minimal RFC 4180 CSV ────────────────────────────────────────────────────
export function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = []; let row: string[] = []; let f = ''; let q = false
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!
		if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c; continue }
		if (c === '"') q = true
		else if (c === ',') { row.push(f); f = '' }
		else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = '' }
		else f += c
	}
	if (f || row.length) { row.push(f); rows.push(row) }
	const [h, ...rest] = rows
	return rest.filter((r) => r.length === h!.length).map((r) => Object.fromEntries(h!.map((k, i) => [k, r[i]!])))
}

const fmt = (x: number, d = 3) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : '—')
const ci = (e: Est) => (Number.isFinite(e.lo) ? `[${fmt(e.lo)}, ${fmt(e.hi)}]` : '—')

function main(): void {
	const [replayDir, liveDir, outDir] = process.argv.slice(2)
	if (!replayDir || !liveDir || !outDir) throw new Error('usage: analyze.ts <replay-dir> <live-dir> <out-dir>')
	fs.mkdirSync(outDir, { recursive: true })
	const md: string[] = []
	const res: Record<string, unknown> = { registered: '54cf86f', seed: SEED, reps: REPS, baseCostBps: BASE_COST_BPS }
	const log = (s = '') => md.push(s)

	// ── load replay signals ──
	const sigs: Sig[] = []
	for (const f of fs.readdirSync(replayDir).filter((x) => /^sig_.*\.jsonl$/.test(x)).sort())
		for (const line of fs.readFileSync(path.join(replayDir, f), 'utf8').split('\n')) if (line.trim()) sigs.push(JSON.parse(line) as Sig)
	const noGate = sigs.filter((s) => !s.gate).length
	const symbols = [...new Set(sigs.map((s) => s.symbol))]
	const refs = new Map<string, Map<string, { atr: number | null; adr: number | null }>>()
	const barsByDay = new Map<string, Map<string, Bar[]>>()
	for (const s of symbols) {
		const m = new Map<string, Bar[]>()
		for (const b of loadSeries(s, DATA.intradayResolution)?.bars ?? []) { const d = istDateStringOf(b.t); const l = m.get(d); if (l) l.push(b); else m.set(d, [b]) }
		barsByDay.set(s, m)
		refs.set(s, dailyRefs(s))
	}
	// strictly after the signal, same session (the harness's no-look-ahead slice)
	const fwdOf = (s: Sig) => (barsByDay.get(s.symbol)?.get(s.day) ?? []).filter((b) => b.t > s.ts)

	// ── per signal, every stop rule ──
	type Rule = 'S0' | 'S1' | 'S2' | 'S3'
	const rules: Rule[] = ['S0', 'S1', 'S2', 'S3']
	const tradesBy: Record<Rule, Map<number, Trade>> = { S0: new Map(), S1: new Map(), S2: new Map(), S3: new Map() }
	const wrongSide: Array<{ day: string; ds: string; bps: number; split: string }> = []
	const old: Array<{ day: string; ds: string; r: number; passed: boolean }> = []
	const s0SlipOnly: Array<{ day: string; ds: string; r: number; passed: boolean }> = []
	const counts = { signals: sigs.length, noGate, s1Missing: 0, s2Missing: 0, s3Unparsed: 0, wrongSide: 0, noForward: 0 }
	sigs.forEach((s, i) => {
		if (!s.gate) return
		const fwd = fwdOf(s)
		if (!fwd.length) { counts.noForward++; return }
		const ds = `${DET_SHORT[s.det] ?? s.det}-${s.side}`
		const isLong = s.side === 'LONG'
		const base = { day: s.day, ds, tod: tod(s.ts), regime: s.gate.regime, tier: tier(s.gate.score), score: s.gate.score, passed: s.gate.passed, entry: s.price }
		const dir = isLong ? 1 : -1
		const add = (rule: Rule, stop: number) => {
			const risk = Math.abs(s.price - stop)
			if (!(risk > 0)) return
			const target = s.price + dir * TARGET_R * risk
			const { exit } = simExit(s.side, s.price, stop, target, fwd)
			tradesBy[rule].set(i, { ...base, risk, gross: (dir * (exit - s.price)) / risk })
		}
		// S0 live: VWAP x 0.998 / 1.002 (alertPipeline.ts), rounded as live
		const s0 = Number((s.vwap * (isLong ? 0.998 : 1.002)).toFixed(2))
		if (isLong ? s0 >= s.price : s0 <= s.price) {
			counts.wrongSide++
			// live exits on the first tick after entry (stop already crossed): first forward bar's open
			wrongSide.push({ day: s.day, ds, bps: (dir * (fwd[0]!.o - s.price) / s.price) * 10_000, split: s.day < SPLIT ? 'train' : 'test' })
		} else {
			add('S0', s0)
			const r0 = Math.abs(s.price - s0)
			const tgt = s.price + dir * TARGET_R * r0
			const { exit } = simExit(s.side, s.price, s0, tgt, fwd)
			const leg = SLIP_ONLY_BPS / 2 / 10_000
			const ef = s.price * (1 + dir * leg), xf = exit * (1 - dir * leg)
			s0SlipOnly.push({ day: s.day, ds, r: (dir * (xf - ef)) / r0, passed: s.gate.passed })
		}
		const rf = refs.get(s.symbol)!.get(s.day)
		if (rf?.atr) add('S1', s.price - dir * 0.5 * rf.atr); else counts.s1Missing++
		if (rf?.adr) add('S2', s.price - dir * 0.25 * rf.adr); else counts.s2Missing++
		const sl = parseSL(s.trigger)
		if (sl !== null) add('S3', sl); else counts.s3Unparsed++
		// OLD = the harness exactly (trigger SL + T1, 5 bps slippage per leg)
		const t = simulateExit({ detectorId: s.det, detectorDisplayName: s.det, ts: s.ts, sessionDate: s.day, payload: { symbol: s.symbol, price: s.price, side: s.side, trigger: s.trigger, vwap: s.vwap, percentageChange: 0, volumeSpikeRatio: 0, avgPrice: s.price }, gate: null } as unknown as RawSignal, fwd, s.symbol)
		if (t && t.exitReason !== 'no-forward-data') old.push({ day: s.day, ds, r: t.r, passed: s.gate.passed })
	})
	res.counts = counts

	const S0 = [...tradesBy.S0.values()]
	const split = (xs: Trade[], w: 'train' | 'test') => xs.filter((t) => (w === 'train' ? t.day < SPLIT : t.day >= SPLIT))
	const dss = [...new Set(S0.map((t) => t.ds))].sort()
	const statNet = (m: number) => MEAN<Trade>((t) => net(t, m))

	log('# Edge-map study: generated tables')
	log()
	log(`Generated by \`backtest/studies/edge-map/analyze.ts\` from the pre-registration at \`54cf86f\`. Seed ${SEED}, ${REPS} day-block bootstrap reps. Net R uses ${BASE_COST_BPS} bps round trip at 1×.`)
	log()
	log(`Replay signals: ${counts.signals} (no gate outcome: ${counts.noGate}; no forward bars: ${counts.noForward}). S0 wrong-side (stop on the wrong side of entry, as live records it): ${counts.wrongSide}. S1 no ATR history: ${counts.s1Missing}. S2 no ADR history: ${counts.s2Missing}. S3 trigger without SL: ${counts.s3Unparsed}.`)
	log()

	// ── old replay vs live-stop replay ──
	log('## A. Old replay (harness: trigger SL + T1) vs live-stop replay (S0), same signals')
	log()
	log('Both are in the harness convention, 5 bps slippage per leg and no charges, so only the stop and target rules differ. The window and gated flag match the committed `results_5m.json` (2025-03-17 → 2026-09-04) as a reproduction check.')
	log()
	log('| Detector-side | Set | Old: n | Old: mean R [95% CI] | S0 live stop: n | S0: mean R [95% CI] |')
	log('|---|---|---|---|---|---|')
	const cmp: unknown[] = []
	for (const ds of dss) for (const [label, f] of [['all, full period', () => true], ['gated, 2025-03-17 → 2026-09-04', (x: { day: string; passed: boolean }) => x.passed && x.day >= '2025-03-17' && x.day <= '2026-09-04']] as const) {
		const o = old.filter((x) => x.ds === ds && f(x)); const s = s0SlipOnly.filter((x) => x.ds === ds && f(x))
		const eo = estimate(o, (x) => x.day, MEAN((x) => x.r), `old|${ds}|${label}`)
		const es = estimate(s, (x) => x.day, MEAN((x) => x.r), `s0slip|${ds}|${label}`)
		cmp.push({ ds, set: label, old: eo, s0: es })
		log(`| ${ds} | ${label} | ${eo.n} | ${fmt(eo.mean)} ${ci(eo)} | ${es.n} | ${fmt(es.mean)} ${ci(es)} |`)
	}
	res.oldVsLive = cmp
	log()

	// ── H1 calibration ──
	log('## B. H1: calibration (slope of net R per score point, 1× cost)')
	log()
	log('| Detector-side | Split | n | days | slope [95% CI] | one-sided p | Holm |')
	log('|---|---|---|---|---|---|---|')
	const h1: Array<{ ds: string; train: Est; test?: Est; trainPass: boolean; confirmed: boolean }> = []
	for (const ds of dss) {
		const tr = split(S0, 'train').filter((t) => t.ds === ds)
		if (tr.length < FLOOR) continue
		h1.push({ ds, train: estimate(tr, (t) => t.day, SLOPE<Trade>((t) => t.score, (t) => net(t, 1)), `h1|${ds}|train`), trainPass: false, confirmed: false })
	}
	holm(h1.map((h) => h.train.pUp)).forEach((r, i) => (h1[i]!.trainPass = r))
	const h1Test = h1.filter((h) => h.trainPass)
	for (const h of h1Test) { const te = split(S0, 'test').filter((t) => t.ds === h.ds); h.test = estimate(te, (t) => t.day, SLOPE<Trade>((t) => t.score, (t) => net(t, 1)), `h1|${h.ds}|test`) }
	holm(h1Test.map((h) => (h.test!.n >= FLOOR ? h.test!.pUp : 1))).forEach((r, i) => (h1Test[i]!.confirmed = r))
	for (const h of h1) {
		log(`| ${h.ds} | train | ${h.train.n} | ${h.train.days} | ${fmt(h.train.mean, 4)} [${fmt(h.train.lo, 4)}, ${fmt(h.train.hi, 4)}] | ${h.train.pUp.toFixed(4)} | ${h.trainPass ? 'pass' : 'fail'} |`)
		if (h.test) log(`| ${h.ds} | test | ${h.test.n} | ${h.test.days} | ${fmt(h.test.mean, 4)} [${fmt(h.test.lo, 4)}, ${fmt(h.test.hi, 4)}] | ${h.test.pUp.toFixed(4)} | ${h.confirmed ? '**calibrated**' : 'not confirmed'} |`)
	}
	log()
	log('Tier table (descriptive, no test): mean net R at 1× by score tier.')
	log()
	log('| Detector-side | Split | <60 | 60-69 | 70-77 | >=78 |')
	log('|---|---|---|---|---|---|')
	const tiers = ['<60', '60-69', '70-77', '>=78']
	const tierRows: unknown[] = []
	for (const ds of dss) for (const w of ['train', 'test'] as const) {
		const cells = tiers.map((tt) => estimate(split(S0, w).filter((t) => t.ds === ds && t.tier === tt), (t) => t.day, statNet(1), `tier|${ds}|${w}|${tt}`))
		tierRows.push({ ds, split: w, cells })
		log(`| ${ds} | ${w} | ${cells.map((e) => `${fmt(e.mean)} ${ci(e)} n=${e.n}`).join(' | ')} |`)
	}
	res.h1 = h1; res.tiers = tierRows
	log()

	// ── H2 edge map ──
	const key = (t: Trade) => `${t.ds}|${t.tod}|${t.regime}|${t.tier}`
	const cellsOf = (xs: Trade[]) => { const m = new Map<string, Trade[]>(); for (const t of xs) { const k = key(t); const l = m.get(k); if (l) l.push(t); else m.set(k, [t]) } return m }
	const trainCells = cellsOf(split(S0, 'train')); const testCells = cellsOf(split(S0, 'test'))
	const allKeys = [...new Set([...trainCells.keys(), ...testCells.keys()])].sort()
	const rows = allKeys.map((k) => ({ k, train: estimate(trainCells.get(k) ?? [], (t) => t.day, statNet(1), `h2|${k}|train`), test: estimate(testCells.get(k) ?? [], (t) => t.day, statNet(1), `h2|${k}|test`), tested: false, disc: false, conf: false, edge: false, test2x: NaN }))
	const tested = rows.filter((r) => r.train.n >= FLOOR)
	tested.forEach((r) => (r.tested = true))
	bh(tested.map((r) => r.train.p2)).forEach((d, i) => (tested[i]!.disc = d))
	const disc = tested.filter((r) => r.disc)
	holm(disc.map((r) => (r.test.n >= FLOOR && Math.sign(r.test.mean) === Math.sign(r.train.mean) ? r.test.p2 : 1))).forEach((c, i) => (disc[i]!.conf = c))
	for (const r of disc) { r.test2x = mean((testCells.get(r.k) ?? []).map((t) => net(t, 2))); r.edge = r.conf && r.test.mean >= EDGE_MIN_R && r.test2x > 0 }
	res.h2 = { cellsSeen: allKeys.length, trainTested: tested.length, discoveries: disc.length, confirmed: disc.filter((r) => r.conf).length, edges: disc.filter((r) => r.edge).map((r) => r.k), rows }
	log('## C. H2: edge map (net R at 1×; detector-side | time of day | regime | score tier)')
	log()
	log(`Cells with any trade: ${allKeys.length}. Train cells at n ≥ ${FLOOR} (tested, BH q=${BH_Q}): **${tested.length}**. BH discoveries: **${disc.length}**. Confirmed on test (Holm): **${disc.filter((r) => r.conf).length}**. Meeting the full "edge found" rule: **${disc.filter((r) => r.edge).length}**.`)
	log()
	log('| Cell | Train n | Train mean [95% CI] | p | Test n | Test mean [95% CI] | Status |')
	log('|---|---|---|---|---|---|---|')
	for (const r of rows) log(`| ${r.k} | ${r.train.n} | ${fmt(r.train.mean)} ${ci(r.train)} | ${r.tested ? r.train.p2.toFixed(4) : '—'} | ${r.test.n} | ${fmt(r.test.mean)} ${ci(r.test)} | ${r.edge ? '**EDGE**' : r.conf ? 'confirmed (below edge rule)' : r.disc ? 'discovery, not confirmed' : r.tested ? 'tested, not significant' : 'below floor, not tested'} |`)
	log()
	log('Marginals (net R at 1×), each factor alone:')
	log()
	log('| Factor | Level | Train n | Train mean [95% CI] | Test n | Test mean [95% CI] |')
	log('|---|---|---|---|---|---|')
	const marg: unknown[] = []
	for (const [fname, fn] of [['detector-side', (t: Trade) => t.ds], ['time of day', (t: Trade) => t.tod], ['regime', (t: Trade) => t.regime], ['score tier', (t: Trade) => t.tier], ['gated (filter passed)', (t: Trade) => String(t.passed)]] as const) {
		for (const lv of [...new Set(S0.map(fn))].sort()) {
			const a = estimate(split(S0, 'train').filter((t) => fn(t) === lv), (t) => t.day, statNet(1), `m|${fname}|${lv}|tr`)
			const b = estimate(split(S0, 'test').filter((t) => fn(t) === lv), (t) => t.day, statNet(1), `m|${fname}|${lv}|te`)
			marg.push({ factor: fname, level: lv, train: a, test: b })
			log(`| ${fname} | ${lv} | ${a.n} | ${fmt(a.mean)} ${ci(a)} | ${b.n} | ${fmt(b.mean)} ${ci(b)} |`)
		}
	}
	res.marginals = marg
	log()

	// ── H3 stop geometry ──
	log('## D. H3: stop geometry (paired, same entries valid under all four rules; net R at 1×)')
	log()
	log('| Detector-side | Split | n | S0 live | S1 ATR | S2 ADR | S3 trigger | Chosen on train | Test diff vs S0 [95% CI] | Holm |')
	log('|---|---|---|---|---|---|---|---|---|---|')
	const common = [...tradesBy.S0.keys()].filter((i) => rules.every((r) => tradesBy[r].has(i)))
	const h3: Array<{ ds: string; chosen: Rule; train: Record<string, number>; test: Record<string, number>; n: [number, number]; diff?: Est; ok?: boolean }> = []
	for (const ds of dss) {
		const ids = common.filter((i) => tradesBy.S0.get(i)!.ds === ds)
		const tr = ids.filter((i) => tradesBy.S0.get(i)!.day < SPLIT), te = ids.filter((i) => tradesBy.S0.get(i)!.day >= SPLIT)
		if (tr.length < FLOOR) continue
		const m = (set: number[], r: Rule) => mean(set.map((i) => net(tradesBy[r].get(i)!, 1)))
		const trainM = Object.fromEntries(rules.map((r) => [r, m(tr, r)])); const testM = Object.fromEntries(rules.map((r) => [r, m(te, r)]))
		const chosen = rules.reduce((a, b) => (trainM[b]! > trainM[a]! ? b : a))
		const row: (typeof h3)[number] = { ds, chosen, train: trainM, test: testM, n: [tr.length, te.length] }
		if (chosen !== 'S0' && te.length >= FLOOR) row.diff = estimate(te, (i) => tradesBy.S0.get(i)!.day, MEAN<number>((i) => net(tradesBy[chosen].get(i)!, 1) - net(tradesBy.S0.get(i)!, 1)), `h3|${ds}`)
		h3.push(row)
	}
	const h3t = h3.filter((h) => h.diff)
	holm(h3t.map((h) => h.diff!.pUp)).forEach((ok, i) => (h3t[i]!.ok = ok && h3t[i]!.diff!.lo > 0 && h3t[i]!.diff!.mean >= EDGE_MIN_R))
	for (const h of h3) for (const w of ['train', 'test'] as const) {
		const v = w === 'train' ? h.train : h.test
		log(`| ${h.ds} | ${w} | ${w === 'train' ? h.n[0] : h.n[1]} | ${rules.map((r) => fmt(v[r]!)).join(' | ')} | ${w === 'train' ? h.chosen : ''} | ${w === 'test' && h.diff ? `${fmt(h.diff.mean)} ${ci(h.diff)}` : ''} | ${w === 'test' && h.diff ? (h.ok ? '**stop candidate**' : 'not confirmed') : ''} |`)
	}
	res.h3 = h3
	log()

	// ── costs ──
	log('## E. Cost sensitivity (S0, mean net R by cost multiple; base 17 bps round trip, ASSUMED)')
	log()
	log(`| Detector-side | Split | ${COST_MULTS.map((k) => `${k}×`).join(' | ')} | Break-even cost (bps) |`)
	log(`|---|---|${COST_MULTS.map(() => '---').join('|')}|---|`)
	const costRows: unknown[] = []
	for (const ds of dss) for (const w of ['train', 'test'] as const) {
		const xs = split(S0, w).filter((t) => t.ds === ds)
		const ms = COST_MULTS.map((k) => mean(xs.map((t) => net(t, k))))
		const be = mean(xs.map((t) => t.gross)) / mean(xs.map((t) => costR(1, t.entry, t.risk)))
		costRows.push({ ds, split: w, n: xs.length, means: ms, breakEvenBps: be })
		log(`| ${ds} | ${w} | ${ms.map((x) => fmt(x)).join(' | ')} | ${Number.isFinite(be) ? be.toFixed(1) : '—'} |`)
	}
	res.costs = costRows
	log()

	// ── wrong-side S0 ──
	log('## F. S0 wrong-side trades (stop on the wrong side of entry; live exits on the first tick)')
	log()
	log('| Detector-side | Split | n | mean gross P&L, bps of notional [95% CI] |')
	log('|---|---|---|---|')
	for (const ds of dss) for (const w of ['train', 'test'] as const) {
		const xs = wrongSide.filter((x) => x.ds === ds && x.split === w)
		const e = estimate(xs, (x) => x.day, MEAN((x) => x.bps), `ws|${ds}|${w}`)
		log(`| ${ds} | ${w} | ${e.n} | ${fmt(e.mean, 2)} ${Number.isFinite(e.lo) ? `[${fmt(e.lo, 2)}, ${fmt(e.hi, 2)}]` : '—'} |`)
	}
	log()

	// ── live (descriptive) ──
	const pt = parseCsv(fs.readFileSync(path.join(liveDir, 'paper_trades.csv'), 'utf8'))
	const closed = pt.filter((r) => r.status === 'CLOSED')
	const liveT = closed.map((r) => {
		const entry = Number(r.entry_price), stop = Number(r.stop_price), side = r.direction as Side
		const ms = Date.parse(r.entry_time!.replace(' ', 'T').replace(/\+00$/, 'Z'))
		const ws = side === 'LONG' ? stop >= entry : stop <= entry
		return { id: r.id!, day: istDateStringOf(ms), ds: `${DET_SHORT[r.detector!] ?? r.detector}-${side}`, tod: tod(ms), gated: r.gated === 't', ws, entry, risk: Math.abs(entry - stop), r: Number(r.r_multiple) }
	})
	const liveAllMean = mean(liveT.map((t) => t.r))
	log('## G. Live paper trades (descriptive only; R as recorded = gross)')
	log()
	log(`Frozen export: ${pt.length} rows, ${closed.length} CLOSED, ${pt.filter((r) => r.status === 'ORPHANED').length} ORPHANED (excluded), ${new Set(liveT.map((t) => t.day)).size} sessions. Mean recorded R over all CLOSED: ${fmt(liveAllMean, 4)} (owner's earlier figure: n=1,556, 0.004). Wrong-side geometry: ${liveT.filter((t) => t.ws).length}.`)
	log()
	log('| Detector-side | Time of day | n | days | mean gross R [95% CI] | mean net R at 1× (valid geometry only) [95% CI] |')
	log('|---|---|---|---|---|---|')
	const liveRows: unknown[] = []
	const liveDs = [...new Set(liveT.map((t) => t.ds))].sort()
	for (const ds of liveDs) for (const td of ['ALL', 'T1', 'T2', 'T3']) {
		const xs = liveT.filter((t) => t.ds === ds && (td === 'ALL' || t.tod === td))
		if (!xs.length) continue
		const g = estimate(xs, (t) => t.day, MEAN((t) => t.r), `live|${ds}|${td}|g`)
		const valid = xs.filter((t) => !t.ws && t.risk > 0)
		const nn = estimate(valid, (t) => t.day, MEAN((t) => t.r - costR(BASE_COST_BPS, t.entry, t.risk)), `live|${ds}|${td}|n`)
		liveRows.push({ ds, tod: td, gross: g, net: nn })
		log(`| ${ds} | ${td} | ${g.n} | ${g.days} | ${fmt(g.mean)} ${ci(g)} | ${fmt(nn.mean)} ${ci(nn)} (n=${nn.n}) |`)
	}
	const sg = parseCsv(fs.readFileSync(path.join(liveDir, 'signals.csv'), 'utf8'))
	const byId = new Map(liveT.map((t) => [t.id, t]))
	const scored = sg.filter((s) => s.trade_id && byId.has(s.trade_id)).map((s) => ({ score: Number(s.score), ...byId.get(s.trade_id!)! }))
	log()
	log(`Live scored trades (signals log from 2026-10-21): n=${scored.length}, below the n ≥ ${FLOOR} floor, so calibration is **insufficient** on live data and not tested.`)
	res.live = { rows: pt.length, closed: closed.length, meanR: liveAllMean, wrongSide: liveT.filter((t) => t.ws).length, table: liveRows, scored: scored.length }

	fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(res, null, 1))
	fs.writeFileSync(path.join(outDir, 'tables.md'), md.join('\n') + '\n')
	console.log(`[analyze] wrote ${outDir}/results.json and tables.md`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
