// ============================================================
// backtest/replayReport.ts — per-setup, per-day report of the Oct 15–22 liquid replay
//
// Owner's spec (2026-10-21): for every setup and day — fires, filter outcome and
// reason, and the stock and time of every fire — with n on every row, stating plainly
// that a handful of sessions supports no edge conclusion and that options are not
// replayable. Simulated R is shown per fire, labelled; no win rates, no averages.
//
//   node --import tsx backtest/replayReport.ts <trades_<label>.json> [<replay data dir>] > report.md
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ReplayTrade {
	detectorId: string
	sessionDate: string
	symbol: string
	side: 'LONG' | 'SHORT'
	entryTs: number
	r: number
	exitReason: string
	gateScore: number
	gatePassed: boolean
	gateRejectedAt?: string | null
}

export interface ReplayMeta {
	sessions: string[]
	liquidCount?: number | undefined
	liquidAsOf?: string | undefined
	quoteDay?: string | undefined
	notReplayable?: string[]
}

const IST = 330 * 60_000
const hhmm = (t: number) => new Date(t + IST).toISOString().slice(11, 16)
export const outcomeOf = (t: ReplayTrade): string => (t.gatePassed ? 'PASSED' : t.gateRejectedAt ? `rejected ${t.gateRejectedAt}` : 'rejected SCORE < 78')

export const buildReplayReport = (byDetector: Record<string, ReplayTrade[]>, meta: ReplayMeta): string => {
	const all = Object.values(byDetector).flat()
	const n = all.length
	const L: string[] = []
	L.push(`# Liquid replay ${meta.sessions[0]} → ${meta.sessions.at(-1)}: per setup, per day`)
	L.push('')
	L.push(`> **Far too few sessions for any edge conclusion.** ${meta.sessions.length} sessions, n = ${n} fires in total. Every count below carries its own n. Nothing here is a measured win rate or expectancy.`)
	L.push('>')
	L.push('> **Options are not replayable.** Institutional OI Liquidity Sweep and Delta Hedging Pressure need live option-chain OI, which isn\'t cached; they are absent here. Nifty setups are replayed on the index only.')
	L.push('>')
	L.push(`> **Universe:** ${meta.liquidCount ?? '?'} stocks with a 30-session average traded value above ₹15 cr as of ${meta.liquidAsOf ?? '2026-10-14'} (daily bars dated on or before that day only).`)
	L.push(`> **Look-ahead in the pre-filter:** which daily histories were fetched was decided from quotes taken on ${meta.quoteDay ?? 'the fetch day'}, after the ranking date. A stock liquid on Oct 14 but quiet on the quote day could be missing.`)
	if (meta.notReplayable?.length) L.push(`> Not replayed: ${meta.notReplayable.join(', ')}.`)
	L.push('')
	L.push('## Summary by setup and day')
	L.push('')
	L.push(`| Setup | ${meta.sessions.join(' | ')} | Total |`)
	L.push(`|---|${meta.sessions.map(() => '---').join('|')}|---|`)
	for (const det of Object.keys(byDetector).sort()) {
		const ts = byDetector[det]!
		const cell = (day: string) => {
			const d = ts.filter((t) => t.sessionDate === day)
			const p = d.filter((t) => t.gatePassed).length
			return d.length === 0 ? 'n = 0' : `n = ${d.length} (${p} passed)`
		}
		L.push(`| ${det} | ${meta.sessions.map(cell).join(' | ')} | n = ${ts.length} (${ts.filter((t) => t.gatePassed).length} passed) |`)
	}
	L.push('')
	L.push('## Filter outcomes by setup (n per reason)')
	L.push('')
	for (const det of Object.keys(byDetector).sort()) {
		const counts = new Map<string, number>()
		for (const t of byDetector[det]!) counts.set(outcomeOf(t), (counts.get(outcomeOf(t)) ?? 0) + 1)
		L.push(`- **${det}** (n = ${byDetector[det]!.length}): ${[...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'no fires'}`)
	}
	L.push('')
	L.push('## Every fire')
	L.push('')
	L.push('Simulated R is from the backtest exit model (stop first, 15:15 exit, slippage). It is one simulated path per fire, not a result.')
	L.push('')
	for (const day of meta.sessions) {
		const d = all.filter((t) => t.sessionDate === day).sort((a, b) => a.entryTs - b.entryTs || a.symbol.localeCompare(b.symbol))
		L.push(`### ${day} (n = ${d.length})`)
		L.push('')
		if (d.length === 0) {
			L.push('No fires.')
			L.push('')
			continue
		}
		L.push('| Time (IST) | Stock | Setup | Side | Score | Outcome | Simulated R | Exit |')
		L.push('|---|---|---|---|---|---|---|---|')
		for (const t of d) L.push(`| ${hhmm(t.entryTs)} | ${t.symbol} | ${t.detectorId} | ${t.side} | ${Math.round(t.gateScore)} | ${outcomeOf(t)} | ${t.r.toFixed(2)} | ${t.exitReason} |`)
		L.push('')
	}
	return L.join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [tradesFile, replayDir] = process.argv.slice(2)
	if (!tradesFile) {
		console.error('usage: replayReport.ts <trades_<label>.json> [<replay data dir>]')
		process.exit(2)
	}
	const byDetector = JSON.parse(fs.readFileSync(tradesFile, 'utf8')) as Record<string, ReplayTrade[]>
	const readMaybe = <T>(f: string): T | null => (replayDir && fs.existsSync(path.join(replayDir, f)) ? (JSON.parse(fs.readFileSync(path.join(replayDir, f), 'utf8')) as T) : null)
	const liquid = readMaybe<{ liquid: unknown[]; asOf: string }>('liquid15cr.json')
	const cands = readMaybe<{ quoteDay: string }>('daily-candidates.json')
	const sessions = [...new Set(Object.values(byDetector).flat().map((t) => t.sessionDate))].sort()
	process.stdout.write(
		buildReplayReport(byDetector, {
			sessions: process.env.REPLAY_SESSIONS?.split(',') ?? sessions,
			liquidCount: liquid?.liquid.length,
			liquidAsOf: liquid?.asOf,
			quoteDay: cands?.quoteDay,
		}) + '\n',
	)
}
