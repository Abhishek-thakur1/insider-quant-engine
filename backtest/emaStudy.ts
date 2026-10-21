// ============================================================
// backtest/emaStudy.ts — run the pre-registered Nifty EMA trend study, write the report
//
//   npx tsx backtest/emaStudy.ts
//
// Offline: reads backtest/data/cache/res-5 and res-D for NSE:NIFTY50-INDEX and,
// if present, backtest/output/trades_nifty_baselines_5m.json (the harness run
// of the current Nifty detectors). No Fyers calls. Writes backtest/output/ema/.
// Parameters: config/nifty_ema_study.json (committed before any run).
// ============================================================

import fs from 'node:fs'
import path from 'node:path'

import { summarize, MIN_SAMPLE, type TradeLite } from './compare.js'
import { labelSession, loadTrendDayConfig, type SessionLabel } from './trendDay.js'
import { runVariant, toSessionBars, type Bar, type RunResult, type StudyParams, type Trade, type VariantSpec } from './emaTrend.js'

const ROOT = process.cwd()
const OUT = path.join(ROOT, 'backtest', 'output', 'ema')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'nifty_ema_study.json'), 'utf8'))

const loadBars = (res: string): Bar[] => {
	const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'backtest', 'data', 'cache', `res-${res}`, 'NSE_NIFTY50-INDEX.json'), 'utf8')) as { bars: Bar[] }
	return j.bars.slice().sort((a, b) => a.t - b.t)
}

const P: StudyParams = {
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
}
const SEED: number = cfg.statistics.seed
const ITER: number = cfg.statistics.resamples

const VARIANTS: { spec: VariantSpec; robustness: boolean }[] = [
	{ spec: { id: 'V0', label: 'V0 crossover 9/21', fast: cfg.variants.V0.fast, slow: cfg.variants.V0.slow, trendEma: 20 }, robustness: false },
	{ spec: { id: 'V1', label: 'V1 alignment (EMA20)', trendEma: cfg.variants.V1.ema }, robustness: false },
	{ spec: { id: 'V2', label: 'V2 pullback (EMA20)', trendEma: cfg.variants.V2.ema }, robustness: false },
	...(cfg.robustness.emaVariants as number[]).flatMap((n) => [
		{ spec: { id: 'V1' as const, label: `V1 alignment (EMA${n}) [robustness]`, trendEma: n }, robustness: true },
		{ spec: { id: 'V2' as const, label: `V2 pullback (EMA${n}) [robustness]`, trendEma: n }, robustness: true },
	]),
]

// ── sessions, labels, day moves ─────────────────────────────────────────────
const intraday = toSessionBars(loadBars(cfg.data.intradayResolution), P.barMinutes)
const daily = loadBars(cfg.data.dailyResolution)
const tdc = loadTrendDayConfig()
const dayInfo = new Map<string, { label: SessionLabel; move: number; o: number; c: number }>()
for (const d of daily) {
	const day = new Date(d.t + 330 * 60_000).toISOString().slice(0, 10)
	dayInfo.set(day, { label: labelSession(d, tdc), move: Math.abs(d.c - d.o), o: d.o, c: d.c })
}
const barsPerDay = new Map<string, number>()
for (const b of intraday) barsPerDay.set(b.day, (barsPerDay.get(b.day) ?? 0) + 1)
const sessions = [...barsPerDay.keys()].sort()
const shortSessions = sessions.filter((d) => (barsPerDay.get(d) ?? 0) < 75)
const unlabelled = sessions.filter((d) => !dayInfo.has(d))
const labelOf = (d: string): SessionLabel | 'unlabelled' => dayInfo.get(d)?.label ?? 'unlabelled'
const yearOf = (d: string) => d.slice(0, 4)
const splitOf = (d: string) => (yearOf(d) <= '2024' ? '2021–2024' : '2025–2026')

// ── metrics ─────────────────────────────────────────────────────────────────
interface Row {
	group: string
	sessions: number
	signals: number
	skippedOpen: number
	skippedWide: number
	n: number
	perSession: number
	winRate: number | null
	expR: number | null
	ci: [number, number] | null
	expR2x: number | null
	pf: number | null
	maxDD: number
	best: number | null
	worst: number | null
	holdMin: number | null
	capture: number | null // trend rows only
	sufficient: boolean
}

const lite = (t: Trade, r = t.r): TradeLite => ({ r, sessionDate: t.sessionDate, entryTs: t.entryTs, gatePassed: true, detectorId: t.variant })

const rowFor = (group: string, days: string[], res: RunResult, trades: Trade[], withCapture: boolean): Row => {
	const ds = new Set(days)
	const tr = trades.filter((t) => ds.has(t.sessionDate))
	const sl = res.signalLog.filter((s) => ds.has(s.sessionDate))
	const s1 = summarize(tr.map((t) => lite(t)), days, SEED, ITER)
	const s2 = tr.some((t) => Number.isNaN(t.r2x)) ? null : summarize(tr.map((t) => lite(t, t.r2x)), days, SEED, 1)
	let capture: number | null = null
	if (withCapture) {
		const shares = days
			.filter((d) => (dayInfo.get(d)?.move ?? 0) > 0)
			.map((d) => tr.filter((t) => t.sessionDate === d).reduce((a, t) => a + t.pts, 0) / dayInfo.get(d)!.move)
		capture = shares.length ? shares.reduce((a, x) => a + x, 0) / shares.length : null
	}
	return {
		group,
		sessions: days.length,
		signals: sl.length,
		skippedOpen: sl.filter((s) => s.outcome === 'SKIP_OPEN').length,
		skippedWide: sl.filter((s) => s.outcome === 'SKIP_WIDE').length,
		n: tr.length,
		perSession: days.length ? tr.length / days.length : 0,
		winRate: s1.winRate,
		expR: s1.expectancyR,
		ci: s1.ci95,
		expR2x: s2 ? s2.expectancyR : null,
		pf: s1.profitFactor,
		maxDD: s1.maxDrawdownR,
		best: tr.length ? Math.max(...tr.map((t) => t.r)) : null,
		worst: tr.length ? Math.min(...tr.map((t) => t.r)) : null,
		holdMin: tr.length ? tr.reduce((a, t) => a + t.holdMin, 0) / tr.length : null,
		capture,
		sufficient: tr.length >= MIN_SAMPLE,
	}
}

const groupsFor = (res: RunResult, trades: Trade[]): Row[] => {
	const rows: Row[] = [rowFor('all sessions', sessions, res, trades, false)]
	for (const lab of ['trend-down', 'trend-up', 'chop'] as const) rows.push(rowFor(lab, sessions.filter((d) => labelOf(d) === lab), res, trades, lab !== 'chop'))
	for (const sp of ['2021–2024', '2025–2026']) {
		rows.push(rowFor(`${sp} · all`, sessions.filter((d) => splitOf(d) === sp), res, trades, false))
		for (const lab of ['trend-down', 'trend-up', 'chop'] as const)
			rows.push(rowFor(`${sp} · ${lab}`, sessions.filter((d) => splitOf(d) === sp && labelOf(d) === lab), res, trades, lab !== 'chop'))
	}
	for (const y of [...new Set(sessions.map(yearOf))]) rows.push(rowFor(`year ${y}`, sessions.filter((d) => yearOf(d) === y), res, trades, false))
	return rows
}

// ── baselines from the harness run (optional) ───────────────────────────────
interface BaseTrade { detectorId: string; sessionDate: string; side: 'LONG' | 'SHORT'; entryTs: number; entryPrice: number; exitPrice: number; r: number; holdingMinutes: number; gateScore: number | null; gatePassed: boolean }
const baselinePath = path.join(ROOT, 'backtest', 'output', 'trades_nifty_baselines_5m.json')
const baselineRows: { detector: string; gated: string; rows: Row[] }[] = []
let baselineNote = 'Baseline harness run not found — baselines omitted.'
if (fs.existsSync(baselinePath)) {
	const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Record<string, BaseTrade[]>
	const all = Object.values(raw).flat().filter((t) => /^nifty_/.test(t.detectorId))
	baselineNote = `Harness run \`trades_nifty_baselines_5m.json\`: ${all.length} trades. Exits are the harness's own (not the study's), R as the harness computes it.`
	for (const det of [...new Set(all.map((t) => t.detectorId))].sort()) {
		for (const gated of ['ungated', 'gated'] as const) {
			const sel = all.filter((t) => t.detectorId === det && (gated === 'ungated' || t.gatePassed))
			const trades: Trade[] = sel.map((t) => ({
				variant: det, side: t.side, sessionDate: t.sessionDate, entryIdx: 0, entryTs: t.entryTs, entry: t.entryPrice, stop: 0, risk: 1,
				exitIdx: 0, exitTs: 0, exit: t.exitPrice, reason: 'TIME',
				pts: t.side === 'LONG' ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice, r: t.r, r2x: Number.NaN, holdMin: t.holdingMinutes, // harness R carries its own costs: no 2× re-costing
			}))
			const fake: RunResult = { trades, signals: trades.length, skippedOpenPosition: 0, skippedWideStop: 0, sessionEndGaps: [], signalLog: trades.map((t) => ({ sessionDate: t.sessionDate, side: t.side, outcome: 'TRADE' })) }
			baselineRows.push({ detector: det, gated, rows: groupsFor(fake, trades).filter((r) => !r.group.startsWith('year ')) })
		}
	}
}

// ── run ─────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true })
const started = Date.now()
const results = VARIANTS.map(({ spec, robustness }) => {
	const res = runVariant(intraday, spec, P)
	return { label: spec.label, robustness, signals: res.signals, skippedOpen: res.skippedOpenPosition, skippedWide: res.skippedWideStop, sessionEndGaps: res.sessionEndGaps, rows: groupsFor(res, res.trades), trades: res.trades }
})

const meta = {
	study: 'nifty-ema-trend',
	config: 'config/nifty_ema_study.json',
	window: `${sessions[0]} → ${sessions.at(-1)}`,
	sessions: sessions.length,
	labels: Object.fromEntries((['trend-down', 'trend-up', 'chop', 'unlabelled'] as const).map((l) => [l, sessions.filter((d) => labelOf(d) === l).length])),
	shortSessions,
	unlabelled,
	resamples: ITER,
	seed: SEED,
	generatedAt: new Date().toISOString(),
	runtimeSec: Math.round((Date.now() - started) / 1000),
}
fs.writeFileSync(path.join(OUT, 'trades.json'), JSON.stringify(results.map((r) => ({ label: r.label, trades: r.trades }))))
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ meta, variants: results.map(({ trades: _t, ...r }) => r), baselines: baselineRows, baselineNote }, null, 2))

// ── render ──────────────────────────────────────────────────────────────────
const f = (x: number | null, d = 2) => (x === null || !Number.isFinite(x) ? '—' : x.toFixed(d))
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(0)}%`)
const ciTxt = (r: Row) => (r.ci ? `[${f(r.ci[0])}, ${f(r.ci[1])}]` : '—')
const flag = (r: Row) => (r.sufficient ? '' : ' ⚠ n<30')
const HEAD = '| group | sessions | signals | skip open | skip >80 | n | n/session | win | E[R] | 95% CI | E[R] 2× cost | PF | max DD R | best | worst | avg hold min | capture |'
const SEP = '|' + '---|'.repeat(17)
const mdRow = (r: Row) =>
	`| ${r.group}${flag(r)} | ${r.sessions} | ${r.signals} | ${r.skippedOpen} | ${r.skippedWide} | ${r.n} | ${f(r.perSession)} | ${pct(r.winRate)} | ${f(r.expR, 3)} | ${ciTxt(r)} | ${f(r.expR2x, 3)} | ${f(r.pf)} | ${f(r.maxDD, 1)} | ${f(r.best)} | ${f(r.worst)} | ${f(r.holdMin, 0)} | ${r.capture === null ? '—' : pct(r.capture)} |`

const CAVEAT = '**Index points only — no option premium, theta or OI is modelled.** "VWAP" is a TWAP proxy (index volume is 0). Costs: 2.3 points round trip; 2× shown. CI: day-block bootstrap, ' + ITER.toLocaleString('en-IN') + ' resamples. Rows with n < 30 are insufficient: no conclusion.'

let md = `# Nifty EMA trend study — results (report only)\n\nPre-registered: \`config/nifty_ema_study.json\`, \`backtest/studies/nifty-ema-trend/PREREGISTRATION.md\`. Window ${meta.window}, ${meta.sessions} sessions (trend-down ${meta.labels['trend-down']}, trend-up ${meta.labels['trend-up']}, chop ${meta.labels.chop}, unlabelled ${meta.labels.unlabelled}).\n\n${CAVEAT}\n\n`
for (const r of results) {
	md += `## ${r.label}\n\n${r.robustness ? '_Robustness check — reported separately, not for selection._\n\n' : ''}Signals ${r.signals} · skipped (position open) ${r.skippedOpen} · skipped (stop > 80 pts) ${r.skippedWide} · sessions exiting at a data gap ${r.sessionEndGaps.length}\n\n${HEAD}\n${SEP}\n${r.rows.map(mdRow).join('\n')}\n\n`
}
md += `## Baselines — current Nifty detectors\n\n${baselineNote}\n\n`
for (const b of baselineRows) md += `### ${b.detector} — ${b.gated}\n\n${HEAD}\n${SEP}\n${b.rows.map(mdRow).join('\n')}\n\n`
md += `## Data notes\n\n- Sessions with fewer than 75 five-minute bars: ${shortSessions.length}${shortSessions.length ? ` (${shortSessions.slice(0, 20).join(', ')}${shortSessions.length > 20 ? ', …' : ''})` : ''}.\n- Sessions without a daily bar (unlabelled): ${unlabelled.length}.\n- Capture = mean over trend sessions of (Σ gross signed trade points that day) / |close − open|; sessions with no trade count as 0.\n`
fs.writeFileSync(path.join(OUT, 'results.md'), md)

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const htmlTable = (rows: Row[]) =>
	`<table><thead><tr>${HEAD.split('|').slice(1, -1).map((h) => `<th>${esc(h.trim())}</th>`).join('')}</tr></thead><tbody>${rows
		.map((r) => `<tr class="${r.sufficient ? '' : 'insuff'}">${mdRow(r).split('|').slice(1, -1).map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(c.trim())}</td>`).join('')}</tr>`)
		.join('')}</tbody></table>`
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nifty EMA Study</title>
<style>:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#6b675f;--line:#e4e0d8;--warn:#9a5b00;--card:#ffffff}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#ecebe7;--muted:#a19d94;--line:#34312c;--warn:#e0a24a;--card:#1f1e1b}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:1400px}
h1{font-size:22px}h2{font-size:17px;margin-top:32px}h3{font-size:15px}.note{color:var(--muted)}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;font-variant-numeric:tabular-nums;white-space:nowrap}th,td{padding:5px 9px;border-bottom:1px solid var(--line);text-align:left}
td.num{text-align:right}tr.insuff td{color:var(--muted)}tr.insuff td:first-child{color:var(--warn)}</style></head><body>
<h1>Nifty EMA trend study — results (report only)</h1>
<p class="note">Window ${meta.window} · ${meta.sessions} sessions (trend-down ${meta.labels['trend-down']}, trend-up ${meta.labels['trend-up']}, chop ${meta.labels.chop}). Pre-registered in <code>config/nifty_ema_study.json</code>.</p>
<p><strong>Index points only — no option premium, theta or OI is modelled.</strong> “VWAP” is a TWAP proxy (index volume is 0). Costs 2.3 pts round trip; 2× shown. CI: day-block bootstrap, ${ITER.toLocaleString('en-IN')} resamples. Grey rows marked ⚠ have n &lt; 30: no conclusion.</p>
${results.map((r) => `<h2>${esc(r.label)}</h2><p class="note">${r.robustness ? 'Robustness check — not for selection. ' : ''}Signals ${r.signals} · skipped (position open) ${r.skippedOpen} · skipped (stop &gt; 80) ${r.skippedWide} · data-gap exits ${r.sessionEndGaps.length}</p><div class="wrap">${htmlTable(r.rows)}</div>`).join('')}
<h2>Baselines — current Nifty detectors</h2><p class="note">${esc(baselineNote)}</p>
${baselineRows.map((b) => `<h3>${esc(b.detector)} — ${b.gated}</h3><div class="wrap">${htmlTable(b.rows)}</div>`).join('')}
<h2>Data notes</h2><p class="note">Sessions with fewer than 75 bars: ${shortSessions.length}. Unlabelled sessions: ${unlabelled.length}. Capture = mean over trend sessions of Σ gross signed trade points / |close − open|; no-trade sessions count as 0.</p>
</body></html>`
fs.writeFileSync(path.join(OUT, 'report.html'), html)
console.log(`[ema-study] ${meta.sessions} sessions ${meta.window} · ${results.length} runs · ${meta.runtimeSec}s → ${path.relative(ROOT, OUT)}/{results.md,report.html,results.json,trades.json}`)
for (const r of results) {
	const a = r.rows[0]!
	console.log(`  ${r.label.padEnd(40)} n=${String(a.n).padStart(5)} E[R]=${f(a.expR, 3)} CI ${ciTxt(a)}`)
}
