// ============================================================
// backtest/emaCostSensitivity.ts — labelled cost correction for the Nifty EMA study
//
//   npx tsx backtest/emaCostSensitivity.ts
//
// The study's first report compared V0–V2 (2.3 points round trip) with the
// current Nifty detectors as the harness costs them (5 bps slippage per leg,
// ≈ 15–25 index points). This re-costs EVERY variant and detector on the SAME
// assumption, three ways: the study's 2.3 points, a futures model and an
// at-the-money option model (config/nifty_cost_models.json — NOT VALIDATED).
// Nothing is re-run: trades, entries, exits and stops are unchanged; only the
// cost subtracted from gross index points differs. The harness default is
// untouched. Appends a labelled correction to backtest/output/ema/results.md
// and report.html and writes cost-sensitivity.md.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'

import { summarize, MIN_SAMPLE, type TradeLite } from './compare.js'
import { labelSession, loadTrendDayConfig, type SessionLabel } from './trendDay.js'

const ROOT = process.cwd()
const OUT = path.join(ROOT, 'backtest', 'output', 'ema')
const study = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'nifty_ema_study.json'), 'utf8'))
const cm = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'nifty_cost_models.json'), 'utf8'))
const SLIP = 5 / 10_000 // harness SIM.slippageBps, to recover gross points from its fills

// ── cost models (index points per unit, for an index level) ─────────────────
const fixedCost = () => study.costs.roundTripPts as number
const futuresCost = (px: number): number => {
	const f = cm.models.futures
	const brokerage = (2 * cm.brokeragePerOrderRupees) / cm.lotSize
	const txn = 2 * f.exchangeTxnFractionPerSide * px
	const sebi = 2 * f.sebiFractionPerSide * px
	const gst = cm.gstOnBrokerageAndCharges * (brokerage + txn + sebi)
	return 2 * f.spreadAndSlippagePtsPerSide + f.sttSellSideFraction * px + txn + sebi + f.stampBuySideFraction * px + brokerage + gst
}
const optionCost = (px: number): number => {
	const o = cm.models.atmOption
	const prem = o.premiumFractionOfIndex * px
	const brokerage = (2 * cm.brokeragePerOrderRupees) / cm.lotSize
	const txn = 2 * o.exchangeTxnFractionOfPremiumPerSide * prem
	const gst = cm.gstOnBrokerageAndCharges * (brokerage + txn)
	const premiumRupees = 2 * o.spreadRupeesPerSide + o.sttSellSideFractionOfPremium * prem + txn + o.stampBuySideFractionOfPremium * prem + brokerage + gst
	return premiumRupees / o.delta
}
const MODELS: { id: string; label: string; cost: (px: number) => number }[] = [
	{ id: 'fixed', label: `study fixed ${study.costs.roundTripPts} pts`, cost: fixedCost },
	{ id: 'futures', label: cm.models.futures.label, cost: futuresCost },
	{ id: 'option', label: `${cm.models.atmOption.label} — theta NOT modelled`, cost: optionCost },
]

// ── normalised trades: gross signed index points, initial risk, index level ─
interface T { name: string; sessionDate: string; entryTs: number; gross: number; risk: number; px: number }
const trades: T[] = []
const studyTrades = JSON.parse(fs.readFileSync(path.join(OUT, 'trades.json'), 'utf8')) as { label: string; trades: { sessionDate: string; entryTs: number; pts: number; risk: number; entry: number }[] }[]
for (const v of studyTrades.filter((x) => !x.label.includes('[robustness]')))
	for (const t of v.trades) trades.push({ name: v.label, sessionDate: t.sessionDate, entryTs: t.entryTs, gross: t.pts, risk: t.risk, px: t.entry })
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'backtest', 'output', 'trades_nifty_baselines_5m.json'), 'utf8')) as Record<string, { detectorId: string; sessionDate: string; side: 'LONG' | 'SHORT'; entryTs: number; entryPrice: number; exitPrice: number; stopLevel: number }[]>
for (const t of Object.values(base).flat().filter((x) => /^nifty_/.test(x.detectorId))) {
	const L = t.side === 'LONG'
	const entry = L ? t.entryPrice / (1 + SLIP) : t.entryPrice / (1 - SLIP) // signal price
	const exit = L ? t.exitPrice / (1 - SLIP) : t.exitPrice / (1 + SLIP) // level hit / bar close
	trades.push({ name: `${t.detectorId} (ungated)`, sessionDate: t.sessionDate, entryTs: t.entryTs, gross: L ? exit - entry : entry - exit, risk: Math.abs(entry - t.stopLevel), px: entry })
}
const names = [...new Set(trades.map((t) => t.name))]

// ── sessions and labels (same as the study) ─────────────────────────────────
const daily = (JSON.parse(fs.readFileSync(path.join(ROOT, 'backtest', 'data', 'cache', 'res-D', 'NSE_NIFTY50-INDEX.json'), 'utf8')) as { bars: { t: number; o: number; h: number; l: number; c: number }[] }).bars
const tdc = loadTrendDayConfig()
const label = new Map<string, SessionLabel>()
for (const d of daily) label.set(new Date(d.t + 330 * 60_000).toISOString().slice(0, 10), labelSession(d, tdc))
const intraday = (JSON.parse(fs.readFileSync(path.join(ROOT, 'backtest', 'data', 'cache', 'res-5', 'NSE_NIFTY50-INDEX.json'), 'utf8')) as { bars: { t: number }[] }).bars
const sessions = [...new Set(intraday.map((b) => new Date(b.t + 330 * 60_000).toISOString().slice(0, 10)))].sort()
const GROUPS: [string, (d: string) => boolean][] = [
	['all sessions', () => true],
	['trend-down', (d) => label.get(d) === 'trend-down'],
	['trend-up', (d) => label.get(d) === 'trend-up'],
	['chop', (d) => label.get(d) === 'chop'],
	['2021–2024', (d) => d.slice(0, 4) <= '2024'],
	['2025–2026', (d) => d.slice(0, 4) >= '2025'],
]

const f = (x: number | null, d = 3) => (x === null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`)
const lines: string[] = []
const at = (px: number) => MODELS.map((m) => `${m.id} ${m.cost(px).toFixed(1)}`).join(' · ')
lines.push(
	'## Correction (2026-10-21): every variant and detector re-costed on the same assumption',
	'',
	'**Why:** the first report charged V0–V2 a fixed 2.3 points round trip, while the current detectors carried the harness cost: 5 bps slippage per leg, about 15–25 index points. That made the current detectors look much worse than V1/V2. This section re-costs every trade with ONE model at a time. **Trades, entries, exits and stops are unchanged.** Only the cost subtracted from gross index points differs. EMA10/30 robustness runs are omitted.',
	'',
	`**Cost models (config/nifty_cost_models.json). NONE IS VALIDATED.** Points per round trip at an index of 20,000 / 25,000: ${at(20000)} / ${at(25000)}. The futures model assumes STT of 0.05% on the sell side. The option model is an ATM weekly bought at delta 0.5 with premium = 0.5% of the index, and **does not model theta** (optimistic). The harness default is unchanged.`,
	'',
	`R = (gross index points − model cost) / initial risk. CI: day-block bootstrap, ${study.statistics.resamples.toLocaleString('en-IN')} resamples. ⚠ = n < ${MIN_SAMPLE}.`,
	'',
)
const csv: string[] = ['name,model,group,n,perSession,winRate,expR,ciLo,ciHi']
for (const m of MODELS) {
	lines.push(`### ${m.label}`, '', '| strategy | all sessions | trend-down | trend-up | chop | 2021–2024 | 2025–2026 | trades/session |', '|---|---|---|---|---|---|---|---|')
	for (const n of names) {
		const cells: string[] = []
		let perSession = 0
		for (const [g, inG] of GROUPS) {
			const days = sessions.filter(inG)
			const ds = new Set(days)
			const tl: TradeLite[] = trades
				.filter((t) => t.name === n && ds.has(t.sessionDate) && t.risk > 0)
				.map((t) => ({ r: (t.gross - m.cost(t.px)) / t.risk, sessionDate: t.sessionDate, entryTs: t.entryTs, gatePassed: true, detectorId: n }))
			const s = summarize(tl, days, study.statistics.seed, study.statistics.resamples)
			if (g === 'all sessions') perSession = tl.length / days.length
			cells.push(`${f(s.expectancyR)} ${s.ci95 ? `[${f(s.ci95[0], 2)}, ${f(s.ci95[1], 2)}]` : ''} (n ${s.n})${s.sufficient ? '' : ' ⚠'}`)
			csv.push([n, m.id, g, s.n, (tl.length / days.length).toFixed(3), s.winRate?.toFixed(3) ?? '', s.expectancyR?.toFixed(4) ?? '', s.ci95?.[0].toFixed(4) ?? '', s.ci95?.[1].toFixed(4) ?? ''].join(','))
		}
		lines.push(`| ${n} | ${cells.join(' | ')} | ${perSession.toFixed(2)} |`)
	}
	lines.push('')
}
lines.push('Baseline gross points are recovered from the harness fills by removing its 5 bps per leg. Their entry is the signal price and their exit is the stop or target level (or the bar close at square-off) — the harness exit rules, not the study\'s.', '')
const block = lines.join('\n')

fs.writeFileSync(path.join(OUT, 'cost-sensitivity.md'), `# Nifty EMA study — cost sensitivity (labelled correction)\n\n${block}`)
fs.writeFileSync(path.join(OUT, 'cost-sensitivity.csv'), csv.join('\n'))
const MARK = '<!-- cost-correction -->'
const md = fs.readFileSync(path.join(OUT, 'results.md'), 'utf8').split(MARK)[0]!
fs.writeFileSync(path.join(OUT, 'results.md'), `${md}${MARK}\n${block}`)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const mdToHtml = (s: string) =>
	s
		.split('\n\n')
		.map((para) => {
			if (para.startsWith('|')) {
				const rows = para.split('\n').filter((r) => !/^\|---/.test(r))
				return `<div class="wrap"><table>${rows.map((r, i) => `<tr>${r.split('|').slice(1, -1).map((c) => (i === 0 ? `<th>${esc(c.trim())}</th>` : `<td>${esc(c.trim())}</td>`)).join('')}</tr>`).join('')}</table></div>`
			}
			if (para.startsWith('### ')) return `<h3>${esc(para.slice(4))}</h3>`
			if (para.startsWith('## ')) return `<h2>${esc(para.slice(3))}</h2>`
			return `<p>${esc(para).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`
		})
		.join('\n')
const html = fs.readFileSync(path.join(OUT, 'report.html'), 'utf8').split(MARK)[0]!.replace('</body></html>', '')
fs.writeFileSync(path.join(OUT, 'report.html'), `${html}${MARK}\n<section>${mdToHtml(block)}</section></body></html>`)
console.log(block)
