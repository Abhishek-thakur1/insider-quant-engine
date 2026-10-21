// ============================================================
// backtest/fullReport.ts — one consolidated, self-contained report over several runs
//
//   npx tsx backtest/fullReport.ts            → backtest/output/full/report.html + summary.md
//
// REPORT ONLY. No tuning, pruning or keep/archive verdicts. Reads the per-run
// files the harness wrote (results_<label>.json, trades_<label>.json), labels
// every session with the committed trend-day rule (config/trend_day.json), and
// renders: pins (commit SHA, screener config hash, trend-day config hash), run
// status, limitations, a ranked table (insufficient samples greyed), per-detector
// cards (equity curves in R, R histograms, holding times, regime split), the
// Nifty trend-day study (cold vs warm), and the reconciliation with results_5m.json.
//
// CIs: 95% day-block bootstrap — trading days that had trades are resampled with
// replacement (2,000 resamples, fixed seed); trades on one day are not independent.
// ============================================================

import './core/bootEnv.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DATA, NIFTY_SYMBOL, OUTPUT_DIR } from './config.js'
import { loadSeries } from './data/store.js'
import { istDateStringOf } from './core/clock.js'
import { REGISTRY } from './registry.js'
import { labelSession, loadTrendDayConfig, type SessionLabel } from './trendDay.js'
import { loadConfig } from '../src/screener/config.js'

// ── types ────────────────────────────────────────────────────────────────────
interface Trade {
	detectorId: string
	sessionDate: string
	symbol: string
	underlying: string
	side: 'LONG' | 'SHORT'
	entryTs: number
	exitTs: number
	entryPrice: number
	exitPrice: number
	r: number
	exitReason: string
	holdingMinutes: number
	gatePassed: boolean
}
interface RunFile {
	run: { sessions: number; firstSession: string; lastSession: string; symbols: number; barsReplayed: number; resolution?: string; multidayLedger?: boolean; warmCandles?: number; window?: unknown; wallClockSeconds: number }
	assumptions: Record<string, unknown>
	metrics: Array<{ detectorId: string; displayName: string; tier: string; bias: string; exitBasis: string; signalsUngated: number; tradesGated: number; gatePassRate: number; rejections: Record<string, number> }>
	notBacktestable: Array<{ id: string; displayName: string; tier: string; reason?: string }>
	detectorErrors: Record<string, string>
}
export interface Summary {
	n: number
	tradeDays: number
	winRate: number | null
	expectancyR: number | null
	ci95: [number, number] | null
	profitFactor: number | null
	maxDrawdownR: number
	bestR: number | null
	worstR: number | null
	hold: { p10: number; p25: number; p50: number; p75: number; p90: number; max: number } | null
	sufficient: boolean
}

export const MIN_N = 30
export const BOOT_ITER = 2000
const SEED = 20261021

// ── stats ────────────────────────────────────────────────────────────────────
const rng = (seed: number) => () => {
	seed |= 0
	seed = (seed + 0x6d2b79f5) | 0
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const q = (s: number[], p: number) => {
	if (!s.length) return NaN
	const pos = (s.length - 1) * p
	const lo = Math.floor(pos)
	const hi = Math.ceil(pos)
	return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)
}

/** 95% day-block bootstrap CI of mean R per trade. null with < 2 trade days. */
export const dayBlockCI = (trades: { r: number; sessionDate: string }[], iterations = BOOT_ITER, seed = SEED): [number, number] | null => {
	const byDay = new Map<string, { s: number; n: number }>()
	for (const t of trades) {
		const d = byDay.get(t.sessionDate) ?? { s: 0, n: 0 }
		d.s += t.r
		d.n++
		byDay.set(t.sessionDate, d)
	}
	const days = [...byDay.values()]
	if (days.length < 2) return null
	const rand = rng(seed)
	const means: number[] = []
	for (let i = 0; i < iterations; i++) {
		let s = 0
		let n = 0
		for (let k = 0; k < days.length; k++) {
			const d = days[Math.floor(rand() * days.length)]!
			s += d.s
			n += d.n
		}
		if (n) means.push(s / n)
	}
	means.sort((a, b) => a - b)
	return [q(means, 0.025), q(means, 0.975)]
}

export const summarizeTrades = (trades: Trade[] | { r: number; sessionDate: string; entryTs: number; holdingMinutes: number }[]): Summary => {
	const n = trades.length
	const rs = trades.map((t) => t.r)
	const wins = rs.filter((r) => r > 0)
	const gw = wins.reduce((a, b) => a + b, 0)
	const gl = Math.abs(rs.filter((r) => r <= 0).reduce((a, b) => a + b, 0))
	let cum = 0
	let peak = 0
	let dd = 0
	for (const t of [...trades].sort((a, b) => a.entryTs - b.entryTs)) {
		cum += t.r
		peak = Math.max(peak, cum)
		dd = Math.max(dd, peak - cum)
	}
	const h = trades.map((t) => t.holdingMinutes).sort((a, b) => a - b)
	return {
		n,
		tradeDays: new Set(trades.map((t) => t.sessionDate)).size,
		winRate: n ? wins.length / n : null,
		expectancyR: n ? rs.reduce((a, b) => a + b, 0) / n : null,
		ci95: dayBlockCI(trades),
		profitFactor: gl > 0 ? gw / gl : null,
		maxDrawdownR: dd,
		bestR: n ? Math.max(...rs) : null,
		worstR: n ? Math.min(...rs) : null,
		hold: n ? { p10: q(h, 0.1), p25: q(h, 0.25), p50: q(h, 0.5), p75: q(h, 0.75), p90: q(h, 0.9), max: h[h.length - 1]! } : null,
		sufficient: n >= MIN_N,
	}
}

const equityPoints = (trades: Trade[], maxPts = 300): number[] => {
	const ordered = [...trades].sort((a, b) => a.entryTs - b.entryTs)
	const pts: number[] = []
	let c = 0
	for (const t of ordered) pts.push((c += t.r))
	if (pts.length <= maxPts) return pts
	const step = pts.length / maxPts
	return Array.from({ length: maxPts }, (_, i) => pts[Math.min(pts.length - 1, Math.floor((i + 1) * step) - 1)]!)
}

// ── inputs ───────────────────────────────────────────────────────────────────
export const RUNS: Array<{ label: string; title: string; role: string }> = [
	{ label: 'base_5m', title: 'Baseline · 5-minute · full cached window · intraday', role: 'baseline' },
	{ label: 'recon_1m', title: 'Reconciliation · 1-minute · results_5m.json window · intraday', role: 'reconcile' },
	{ label: 'multiday_smb_5m', title: 'EXTRA (labelled) · multi-day ledger · Stock Momentum Breakout only', role: 'extra' },
	{ label: 'warm15_5m', title: 'Trend-day study · WARM-start variant (prev. session’s last 15 five-minute candles)', role: 'warm' },
]

const readRun = (label: string): { res: RunFile; trades: Record<string, Trade[]> } | null => {
	const rp = path.join(OUTPUT_DIR, `results_${label}.json`)
	const tp = path.join(OUTPUT_DIR, `trades_${label}.json`)
	if (!fs.existsSync(rp) || !fs.existsSync(tp)) return null
	return { res: JSON.parse(fs.readFileSync(rp, 'utf8')), trades: JSON.parse(fs.readFileSync(tp, 'utf8')) }
}

const sha256File = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 12)
const git = (args: string[]) => {
	try {
		return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
	} catch {
		return 'unknown'
	}
}

// ── html helpers ─────────────────────────────────────────────────────────────
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d))
const pc = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)
const ciTxt = (s: Summary) => (s.ci95 ? `[${f(s.ci95[0])}, ${f(s.ci95[1])}]` : '—')
const holdTxt = (s: Summary) => (s.hold ? `${Math.round(s.hold.p25)} / ${Math.round(s.hold.p50)} / ${Math.round(s.hold.p75)} min (max ${Math.round(s.hold.max)})` : '—')

const lineSvg = (pts: number[], w = 360, h = 110) => {
	if (pts.length < 2) return '<div class="empty">fewer than 2 trades — no curve</div>'
	const min = Math.min(0, ...pts)
	const max = Math.max(0, ...pts)
	const sx = (i: number) => 6 + (i / (pts.length - 1)) * (w - 12)
	const sy = (v: number) => 6 + (1 - (v - min) / (max - min || 1)) * (h - 12)
	const d = pts.map((v, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join('')
	const last = pts[pts.length - 1]!
	return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="Equity curve, final ${last.toFixed(1)} R"><line x1="6" x2="${w - 6}" y1="${sy(0).toFixed(1)}" y2="${sy(0).toFixed(1)}" class="zero"/><path d="${d}" class="${last >= 0 ? 'up' : 'down'}"/><text x="${w - 8}" y="14" text-anchor="end" class="lbl">${last.toFixed(1)} R</text></svg>`
}
const EDGES = [-Infinity, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3, 4, Infinity]
const histSvg = (rs: number[], w = 360, h = 110) => {
	if (!rs.length) return '<div class="empty">no trades</div>'
	const c = new Array(EDGES.length - 1).fill(0) as number[]
	for (const r of rs) for (let i = 0; i < c.length; i++) if (r >= EDGES[i]! && r < EDGES[i + 1]!) c[i] = (c[i] ?? 0) + 1
	const m = Math.max(...c, 1)
	const bw = (w - 12) / c.length
	const lab = (i: number) => (i === 0 ? '<-2' : i === c.length - 1 ? '≥4' : `${EDGES[i]}`)
	return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="R-multiple distribution of ${rs.length} trades">${c
		.map((v, i) => {
			const bh = (v / m) * (h - 26)
			return `<rect x="${(6 + i * bw + 1).toFixed(1)}" y="${(h - 16 - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" class="${EDGES[i + 1]! <= 0 ? 'loss' : 'win'}"><title>${lab(i)}…: ${v}</title></rect><text x="${(6 + i * bw + bw / 2).toFixed(1)}" y="${h - 4}" text-anchor="middle" class="tick">${lab(i)}</text>`
		})
		.join('')}</svg>`
}

const statRow = (label: string, s: Summary) =>
	`<tr class="${s.sufficient ? '' : 'insufficient'}"><td>${esc(label)}</td><td class="n">${s.n}</td><td class="n">${pc(s.winRate)}</td><td class="n">${f(s.expectancyR)}</td><td class="n">${ciTxt(s)}</td><td class="n">${f(s.profitFactor, 2)}</td><td class="n">${f(s.maxDrawdownR, 1)}</td><td class="n">${f(s.bestR, 2)} / ${f(s.worstR, 2)}</td><td class="n">${holdTxt(s)}</td><td>${s.sufficient ? 'ok' : '<b>n &lt; 30 — insufficient</b>'}</td></tr>`
const STAT_HEAD = '<tr><th></th><th>n</th><th>win</th><th>E[R]</th><th>95% CI</th><th>PF</th><th>max DD (R)</th><th>best / worst R</th><th>hold p25 / p50 / p75</th><th>sample</th></tr>'

// ── main ─────────────────────────────────────────────────────────────────────
export const buildFullReport = () => {
	const runs = RUNS.map((r) => ({ ...r, data: readRun(r.label) }))
	const base = runs.find((r) => r.label === 'base_5m')?.data
	if (!base) throw new Error('results_base_5m.json / trades_base_5m.json missing — run backtest/output/full/run_all.sh first')

	// Session labels from the NIFTY daily bars, committed rule
	const tcfg = loadTrendDayConfig()
	const daily = loadSeries(NIFTY_SYMBOL, DATA.dailyResolution)?.bars ?? []
	const labelOf = new Map<string, SessionLabel>(daily.map((b) => [istDateStringOf(b.t), labelSession(b, tcfg)]))
	const dailyOf = new Map(daily.map((b) => [istDateStringOf(b.t), b]))
	const LABELS: SessionLabel[] = ['trend-down', 'trend-up', 'chop']

	const runsLog = fs.existsSync(path.join(OUTPUT_DIR, 'full', 'runs.log')) ? fs.readFileSync(path.join(OUTPUT_DIR, 'full', 'runs.log'), 'utf8') : ''
	const runSha = runsLog.match(/sha=(\w+)/)?.[1] ?? 'unknown'
	const pins = {
		commit: runSha,
		reportCommit: git(['rev-parse', '--short', 'HEAD']),
		screenerConfigHash: loadConfig().hash,
		trendDayConfigHash: sha256File(path.resolve(process.cwd(), 'config', 'trend_day.json')),
		trendDayCommittedIn: git(['log', '-1', '--format=%h %ad', '--date=iso', '--', 'config/trend_day.json']),
		firstRunStarted: runsLog.match(/start=(\S+)/)?.[1] ?? 'unknown',
	}

	const summaryMd: string[] = []
	const specsById = new Map(REGISTRY.map((s) => [s.id, s]))
	const detIds = base.res.metrics.map((m) => m.detectorId)

	// Ranked table (baseline)
	const rows = base.res.metrics.map((m) => {
		const all = base.trades[m.detectorId] ?? []
		return { m, g: summarizeTrades(all.filter((t) => t.gatePassed)), u: summarizeTrades(all), spec: specsById.get(m.detectorId) }
	})
	rows.sort((a, b) => (a.g.sufficient !== b.g.sufficient ? (a.g.sufficient ? -1 : 1) : (b.g.expectancyR ?? -Infinity) - (a.g.expectancyR ?? -Infinity)))

	const ranked = `<table class="t"><tr><th>#</th><th>detector</th><th>tier</th><th>scope</th><th>signals</th><th>gated n</th><th>win</th><th>E[R] gated</th><th>95% CI</th><th>PF</th><th>ungated n</th><th>E[R] ungated</th><th>95% CI</th></tr>${rows
		.map(
			(r, i) =>
				`<tr class="${r.g.sufficient ? '' : 'insufficient'}"><td>${i + 1}</td><td>${esc(r.m.displayName)}</td><td>${esc(r.m.tier)}</td><td>${esc(r.spec?.scope ?? '')}</td><td class="n">${r.m.signalsUngated}</td><td class="n">${r.g.n}</td><td class="n">${pc(r.g.winRate)}</td><td class="n">${f(r.g.expectancyR)}</td><td class="n">${ciTxt(r.g)}</td><td class="n">${f(r.g.profitFactor, 2)}</td><td class="n">${r.u.n}</td><td class="n">${f(r.u.expectancyR)}</td><td class="n">${ciTxt(r.u)}</td></tr>`,
		)
		.join('')}</table>`

	// Regime split (baseline)
	const regimeTable = `<table class="t"><tr><th>detector</th>${LABELS.map((l) => `<th colspan="3">${l}</th>`).join('')}</tr><tr><th></th>${LABELS.map(() => '<th>n (gated / all)</th><th>E[R] gated</th><th>E[R] all</th>').join('')}</tr>${rows
		.map((r) => {
			const all = base.trades[r.m.detectorId] ?? []
			return `<tr><td>${esc(r.m.displayName)}</td>${LABELS.map((l) => {
				const a = all.filter((t) => labelOf.get(t.sessionDate) === l)
				const g = a.filter((t) => t.gatePassed)
				const sg = summarizeTrades(g)
				const sa = summarizeTrades(a)
				return `<td class="n ${sa.sufficient ? '' : 'insufficient'}">${sg.n} / ${sa.n}</td><td class="n ${sg.sufficient ? '' : 'insufficient'}">${f(sg.expectancyR)}</td><td class="n ${sa.sufficient ? '' : 'insufficient'}">${f(sa.expectancyR)}</td>`
			}).join('')}</tr>`
		})
		.join('')}</table>`

	// Session label counts in the baseline window
	const windowDays = [...labelOf.keys()].filter((d) => d >= base.res.run.firstSession && d <= base.res.run.lastSession)
	const counts = Object.fromEntries(LABELS.map((l) => [l, windowDays.filter((d) => labelOf.get(d) === l).length]))

	// Per-detector cards
	const extraByDet = (label: string, det: string) => {
		const run = runs.find((x) => x.label === label)?.data
		if (!run || !run.trades[det]) return null
		return { g: summarizeTrades(run.trades[det]!.filter((t) => t.gatePassed)), u: summarizeTrades(run.trades[det]!) }
	}
	const cards = rows
		.map((r) => {
			const all = base.trades[r.m.detectorId] ?? []
			const g = all.filter((t) => t.gatePassed)
			const extraRows: string[] = []
			for (const [label, name] of [['warm15_5m', 'WARM start (15 candles)'], ['multiday_smb_5m', 'EXTRA multi-day ledger'], ['recon_1m', '1-minute, results_5m window']] as const) {
				const e = extraByDet(label, r.m.detectorId)
				if (e) extraRows.push(statRow(`${name} · gated`, e.g), statRow(`${name} · ungated`, e.u))
			}
			const reg = LABELS.map((l) => statRow(`${l} · ungated`, summarizeTrades(all.filter((t) => labelOf.get(t.sessionDate) === l)))).join('')
			const rej = Object.entries(r.m.rejections).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || 'none'
			return `<section class="card ${r.g.sufficient ? '' : 'dim'}" id="d-${esc(r.m.detectorId)}">
<h3>${esc(r.m.displayName)} <span class="tag">${esc(r.m.tier)}</span> <span class="tag">${esc(r.spec?.scope ?? '')}</span> <span class="tag">exit: ${esc(r.m.exitBasis)}</span>${r.g.sufficient ? '' : ' <span class="tag warn">gated n &lt; 30 — insufficient</span>'}</h3>
<p class="muted">signals ${r.m.signalsUngated} · gate pass ${(r.m.gatePassRate * 100).toFixed(1)}% · rejections: ${rej}</p>
<div class="grid"><figure><figcaption>Equity, gated (R)</figcaption>${lineSvg(equityPoints(g))}</figure><figure><figcaption>Equity, ungated (R)</figcaption>${lineSvg(equityPoints(all))}</figure><figure><figcaption>R distribution, ungated</figcaption>${histSvg(all.map((t) => t.r))}</figure></div>
<table class="t">${STAT_HEAD}${statRow('baseline · gated', r.g)}${statRow('baseline · ungated', r.u)}${reg}${extraRows.join('')}</table>
${(r.spec?.caveats ?? []).length ? `<p class="muted">Caveats: ${(r.spec!.caveats ?? []).map(esc).join(' · ')}</p>` : ''}</section>`
		})
		.join('\n')

	// Nifty trend-day study: cold (baseline) vs warm, per label, + capture of the day's move
	const warm = runs.find((x) => x.label === 'warm15_5m')?.data
	const niftyIds = detIds.filter((id) => specsById.get(id)?.scope === 'nifty-singleton')
	const capture = (trades: Trade[], l: SessionLabel) => {
		const days = windowDays.filter((d) => labelOf.get(d) === l)
		let num = 0
		let den = 0
		for (const d of days) {
			const b = dailyOf.get(d)!
			den += Math.abs(b.c - b.o)
			for (const t of trades.filter((x) => x.sessionDate === d)) num += (t.side === 'LONG' ? 1 : -1) * (t.exitPrice - t.entryPrice)
		}
		return den > 0 ? num / den : null
	}
	const study = niftyIds
		.map((id) => {
			const name = base.res.metrics.find((m) => m.detectorId === id)!.displayName
			const cold = base.trades[id] ?? []
			const w = warm?.trades[id] ?? []
			return `<tr><td rowspan="2">${esc(name)}</td><td>cold (live-like)</td>${LABELS.map((l) => {
				const s = summarizeTrades(cold.filter((t) => labelOf.get(t.sessionDate) === l))
				return `<td class="n ${s.sufficient ? '' : 'insufficient'}">${s.n}</td><td class="n ${s.sufficient ? '' : 'insufficient'}">${f(s.expectancyR)} ${ciTxt(s)}</td><td class="n">${pc(capture(cold, l))}</td>`
			}).join('')}</tr><tr><td>warm (15 candles)</td>${LABELS.map((l) => {
				if (!warm) return '<td colspan="3" class="muted">not run</td>'
				const s = summarizeTrades(w.filter((t) => labelOf.get(t.sessionDate) === l))
				return `<td class="n ${s.sufficient ? '' : 'insufficient'}">${s.n}</td><td class="n ${s.sufficient ? '' : 'insufficient'}">${f(s.expectancyR)} ${ciTxt(s)}</td><td class="n">${pc(capture(w, l))}</td>`
			}).join('')}</tr>`
		})
		.join('')
	const studyTable = `<table class="t"><tr><th rowspan="2">Nifty detector</th><th rowspan="2">variant</th>${LABELS.map((l) => `<th colspan="3">${l} (${counts[l]} sessions)</th>`).join('')}</tr><tr>${LABELS.map(() => '<th>n</th><th>E[R] all trades [95% CI]</th><th>move captured</th>').join('')}</tr>${study}</table>`

	// Reconciliation with results_5m.json (Stock Momentum Breakout, gated)
	const ref = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'results_5m.json'), 'utf8')) as { run: RunFile['run']; metrics: Array<{ detectorId: string; signalsUngated: number; tradesGated: number; gatePassRate: number; rejections: Record<string, number>; gated: { trades: number; winRate: number; expectancyR: number; profitFactor: number } }> }
	const refSmb = ref.metrics.find((m) => m.detectorId === 'stock_momentum_breakout')!
	const rec = runs.find((x) => x.label === 'recon_1m')?.data
	const recSmbM = rec?.res.metrics.find((m) => m.detectorId === 'stock_momentum_breakout')
	const recSmbS = rec ? summarizeTrades((rec.trades.stock_momentum_breakout ?? []).filter((t) => t.gatePassed)) : null
	const sameWin5 = summarizeTrades((base.trades.stock_momentum_breakout ?? []).filter((t) => t.gatePassed && t.sessionDate >= ref.run.firstSession && t.sessionDate <= ref.run.lastSession))
	const changes = git(['log', '--format=%h %ad %s', '--date=short', '--since=2026-09-07T01:30', '--', 'src/detectors/v2/stockMomentumBreakoutDetector.ts', 'src/detectors/janeStreetFilter.ts', 'src/utils/bayesianEngine.ts', 'src/utils/regimeDetector.ts', 'src/utils/marketStructure.ts', 'src/utils/liquidityMap.ts', 'src/utils/orderFlowProxy.ts', 'src/utils/vwapUtils.ts', 'backtest/sim', 'backtest/replay'])
	const recon = `<table class="t"><tr><th>Stock Momentum Breakout, gated</th><th>window</th><th>bars</th><th>signals</th><th>gated n</th><th>gate pass</th><th>win</th><th>E[R]</th><th>PF</th><th>rejections</th></tr>
<tr><td>results_5m.json (2026-09-07)</td><td>${ref.run.firstSession} → ${ref.run.lastSession}</td><td>1-minute (${ref.run.barsReplayed.toLocaleString()} bars)</td><td class="n">${refSmb.signalsUngated}</td><td class="n">${refSmb.tradesGated}</td><td class="n">${(refSmb.gatePassRate * 100).toFixed(1)}%</td><td class="n">${pc(refSmb.gated.winRate)}</td><td class="n">${f(refSmb.gated.expectancyR)}</td><td class="n">${f(refSmb.gated.profitFactor, 2)}</td><td>${esc(JSON.stringify(refSmb.rejections))}</td></tr>
${rec && recSmbM && recSmbS ? `<tr><td>recon_1m (this run, code ${esc(runSha)})</td><td>${rec.res.run.firstSession} → ${rec.res.run.lastSession}</td><td>1-minute (${rec.res.run.barsReplayed.toLocaleString()} bars)</td><td class="n">${recSmbM.signalsUngated}</td><td class="n">${recSmbS.n}</td><td class="n">${(recSmbM.gatePassRate * 100).toFixed(1)}%</td><td class="n">${pc(recSmbS.winRate)}</td><td class="n">${f(recSmbS.expectancyR)} ${ciTxt(recSmbS)}</td><td class="n">${f(recSmbS.profitFactor, 2)}</td><td>${esc(JSON.stringify(recSmbM.rejections))}</td></tr>` : '<tr><td colspan="10" class="muted">recon_1m not run</td></tr>'}
<tr><td>base_5m restricted to the same window</td><td>${ref.run.firstSession} → ${ref.run.lastSession}</td><td>5-minute</td><td class="n">—</td><td class="n">${sameWin5.n}</td><td class="n">—</td><td class="n">${pc(sameWin5.winRate)}</td><td class="n">${f(sameWin5.expectancyR)} ${ciTxt(sameWin5)}</td><td class="n">${f(sameWin5.profitFactor, 2)}</td><td>—</td></tr></table>
<p>Commits since results_5m.json was generated that touch the detector, the filter, its inputs or the simulator:</p><pre>${esc(changes || '(none)')}</pre>`

	const nb = base.res.notBacktestable.map((d) => `<li><b>${esc(d.displayName)}</b> (${esc(d.tier)}): ${esc(d.reason ?? '')}</li>`).join('')
	const errs = Object.entries(base.res.detectorErrors)
	const status = runs
		.map((r) => `<tr><td>${esc(r.title)}</td><td>${r.data ? `ran · ${r.data.res.run.sessions} sessions · ${r.data.res.run.firstSession} → ${r.data.res.run.lastSession} · ${r.data.res.run.symbols} series · ${r.data.res.run.wallClockSeconds}s` : '<b>not run / missing</b>'}</td></tr>`)
		.join('')

	const css = `:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#6b6a66;--line:#e2e0da;--card:#fff;--up:#1f7a4d;--down:#b3412e;--win:#7fb89a;--loss:#d9a093;--warn:#9a6b00}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#161615;--fg:#ecebe6;--mut:#a3a29c;--line:#34332f;--card:#1f1f1d;--up:#5cc28e;--down:#e07a66;--win:#3f7a5c;--loss:#8a4b3f;--warn:#e0b04a}}
:root[data-theme="dark"]{--bg:#161615;--fg:#ecebe6;--mut:#a3a29c;--line:#34332f;--card:#1f1f1d;--up:#5cc28e;--down:#e07a66;--win:#3f7a5c;--loss:#8a4b3f;--warn:#e0b04a}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:24px 16px;max-width:1200px;margin-inline:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:15px;margin:0 0 6px}
.muted{color:var(--mut)}.tag{font-size:11px;border:1px solid var(--line);border-radius:4px;padding:1px 6px;margin-left:4px;color:var(--mut)}.tag.warn{color:var(--warn);border-color:var(--warn)}
table.t{border-collapse:collapse;width:100%;font-size:12.5px;margin:8px 0;display:block;overflow-x:auto}table.t th,table.t td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;white-space:nowrap}td.n{text-align:right;font-variant-numeric:tabular-nums}
tr.insufficient td,td.insufficient{color:var(--mut);opacity:.55}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;margin:14px 0}.card.dim{opacity:.8}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}figure{margin:0}figcaption{font-size:12px;color:var(--mut)}
svg.chart{width:100%;height:auto}svg .zero{stroke:var(--line)}svg path{fill:none;stroke-width:2}svg path.up{stroke:var(--up)}svg path.down{stroke:var(--down)}svg rect.win{fill:var(--win)}svg rect.loss{fill:var(--loss)}svg .tick,svg .lbl{font-size:9px;fill:var(--mut)}
.pins{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px;font-size:12.5px}.pins div{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
pre{white-space:pre-wrap;font-size:12px;background:var(--card);border:1px solid var(--line);padding:8px;border-radius:6px}.empty{color:var(--mut);font-size:12px;padding:20px 0}`

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Backtest Report</title><style>${css}</style></head><body>
<h1>Full backtest report</h1>
<p class="muted">Report only — no tuning, pruning or keep/archive verdicts. Generated ${esc(new Date().toISOString())}.</p>
<div class="pins"><div><b>Commit (runs)</b><br>${esc(pins.commit)}</div><div><b>Commit (report)</b><br>${esc(pins.reportCommit)}</div><div><b>Screener config hash</b><br>${esc(pins.screenerConfigHash)}</div><div><b>Trend-day config</b><br>${esc(pins.trendDayConfigHash)} · committed ${esc(pins.trendDayCommittedIn)}</div><div><b>First run started</b><br>${esc(pins.firstRunStarted)}</div><div><b>Data</b><br>Fyers history, cached 2026-09-07; 5-minute bars aggregated exactly from 1-minute</div></div>

<h2>What ran</h2><table class="t">${status}</table>
<p><b>Not run in this report</b> (needs new Fyers data; the fetch is quota-limited and needs the owner's go):</p>
<ul><li><b>Old 25-stock list and the full liquid universe</b> — the cache holds the 90-stock July-2026 watchlist only.</li>
<li><b>Screener v2 comparison</b> (old Layer A vs Tier 1+2 vs 3 random) — needs daily bars for ~2,350 symbols (~7,000 requests) and 5-minute bars for the union (~2,000–4,000): about 7–8 evenings at the 1,500/evening backtest allocation.</li></ul>

<h2>Limitations — read before any number</h2><ul>
<li><b>Selection / survivorship:</b> the universe is the 90-stock watchlist chosen in July 2026, replayed back to 2021 — a look-ahead-selected list; names delisted or dropped earlier are absent (the current master already lacks 151 names of the old universe file).</li>
<li><b>Single history window</b> (${esc(base.res.run.firstSession)} → ${esc(base.res.run.lastSession)}); regimes inside it are labelled, but one window is one sample of market history.</li>
<li><b>5-minute bars derived from 1-minute</b> (exact OHLCV aggregation, not Fyers' own 5-minute candles). Each bar becomes 4 synthetic ticks; the engine's regime model gets one return per 5-minute bar (live: per minute) and the Nifty VWAP updates per bar.</li>
<li><b>Daily bars are as Fyers returns them</b> (split/bonus adjustment not verified); used here only for session labels.</li>
<li><b>Nifty detectors are measured on the index</b> (R on index points), not on option premium — Fyers has no historical premiums or OI.</li>
<li><b>Not backtestable:</b><ul>${nb}</ul></li>
<li><b>Live misrouting reproduced:</b> equities whose names contain "CE"/"PE" are dropped exactly as live does (see AGENTS.md §6.11).</li>
<li>Intraday only (forced exit 15:15 IST), like live; the multi-day ledger appears only in the labelled EXTRA run.</li>
<li>CIs: 95% day-block bootstrap over trade days, ${BOOT_ITER.toLocaleString()} resamples. n &lt; 30: shown greyed, no conclusion.</li></ul>

<h2>Ranked — baseline, by gated E[R] (insufficient samples last, greyed)</h2>${ranked}
<h2>By market regime — baseline</h2><p class="muted">Session labels from the committed trend-day rule on the NIFTY daily bar: trend-down ${counts['trend-down']}, trend-up ${counts['trend-up']}, chop ${counts.chop} sessions.</p>${regimeTable}
<h2>Nifty trend-day study — cold (live-like) vs warm start</h2><p class="muted">"Move captured" = signed index points of the detector's trades on those sessions ÷ Σ|close − open| of those sessions.</p>${studyTable}
<h2>Reconciliation with results_5m.json</h2>${recon}
<h2>Per-detector cards</h2>${cards}
${errs.length ? `<h2>Detector errors during replay</h2><pre>${esc(errs.map(([k, v]) => `${k}: ${v}`).join('\n'))}</pre>` : ''}
</body></html>`

	// Markdown summary of anything that failed or looked wrong
	summaryMd.push(`# Full backtest — summary of failures and oddities`, '', `Runs at commit ${pins.commit}; screener config ${pins.screenerConfigHash}; trend-day config ${pins.trendDayConfigHash}.`, '')
	for (const r of runs) if (!r.data) summaryMd.push(`- **${r.title}: not run / output missing.**`)
	for (const [k, v] of errs) summaryMd.push(`- Detector error during replay — ${k}: ${v}`)
	const zero = rows.filter((r) => r.m.signalsUngated === 0).map((r) => r.m.displayName)
	if (zero.length) summaryMd.push(`- Zero signals over the whole window: ${zero.join(', ')}.`)
	const noPass = rows.filter((r) => r.m.signalsUngated > 0 && r.g.n === 0).map((r) => `${r.m.displayName} (${r.m.signalsUngated} signals)`)
	if (noPass.length) summaryMd.push(`- Signals but **no** trade passed the filter: ${noPass.join(', ')}.`)
	const neg = rows.filter((r) => r.g.sufficient && (r.g.expectancyR ?? 0) < 0 && r.g.ci95 && r.g.ci95[1] < 0).map((r) => `${r.m.displayName} (${f(r.g.expectancyR)} R, CI ${ciTxt(r.g)})`)
	if (neg.length) summaryMd.push(`- Gated expectancy negative with the whole 95% CI below zero: ${neg.join('; ')}.`)
	if (rec && recSmbS) summaryMd.push(`- Reconciliation, Stock Momentum Breakout gated: results_5m.json ${refSmb.tradesGated} trades / ${f(refSmb.gated.expectancyR)} R / PF ${f(refSmb.gated.profitFactor, 2)} vs recon_1m ${recSmbS.n} / ${f(recSmbS.expectancyR)} R / PF ${f(recSmbS.profitFactor, 2)} (same window, 1-minute). See the report for the code changes in between.`)
	summaryMd.push('', 'Not run (needs a quota-limited Fyers fetch and the owner’s go): old 25-stock list, full liquid universe, screener v2 comparison.')

	fs.mkdirSync(path.join(OUTPUT_DIR, 'full'), { recursive: true })
	fs.writeFileSync(path.join(OUTPUT_DIR, 'full', 'report.html'), html)
	fs.writeFileSync(path.join(OUTPUT_DIR, 'full', 'summary.md'), summaryMd.join('\n') + '\n')
	return { pins, counts, rows: rows.map((r) => ({ id: r.m.detectorId, g: r.g, u: r.u })) }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (isMain) {
	const out = buildFullReport()
	console.log(`[full-report] commit ${out.pins.commit} · screener ${out.pins.screenerConfigHash} · trend-day ${out.pins.trendDayConfigHash}`)
	console.log(`[full-report] sessions: ${JSON.stringify(out.counts)}`)
	console.log(`[full-report] → ${path.join(OUTPUT_DIR, 'full', 'report.html')} and summary.md`)
}
