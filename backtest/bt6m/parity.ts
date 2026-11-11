// ============================================================
// backtest/bt6m/parity.ts — the parity gate: backtest fires vs the live signals table, 4–9 Nov
//
// PREREGISTRATION.md §6 item 5. A live fire is matched by a backtest fire with the same detector, symbol and side
// within ±60 s (each backtest fire matches at most one live fire; nearest first). Reported: the share of live fires
// matched, the score difference (backtest − live) on matched pairs, alert-decision agreement, and backtest fires
// with no live match. PASS = matched ≥ 80% of live fires AND the median score difference within ±3.
// Usage: npx tsx backtest/bt6m/parity.ts <live signals.csv> <backtest signals.jsonl> [from] [to]
// ============================================================

import fs from 'node:fs'

export interface Fire { detector: string; symbol: string; direction: string; t: number; score: number | null; alerted: boolean; date: string }

export const PASS_MATCH_SHARE = 0.8
export const PASS_MEDIAN_SCORE_DIFF = 3
export const MATCH_WINDOW_MS = 60_000

const median = (xs: number[]): number | null => {
	if (!xs.length) return null
	const s = [...xs].sort((a, b) => a - b)
	const m = Math.floor(s.length / 2)
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export const matchFires = (live: Fire[], bt: Fire[]) => {
	const used = new Set<number>()
	const pairs: { live: Fire; bt: Fire }[] = []
	const unmatchedLive: Fire[] = []
	for (const l of [...live].sort((a, b) => a.t - b.t)) {
		let best = -1
		let bestDt = Infinity
		bt.forEach((b, i) => {
			if (used.has(i) || b.detector !== l.detector || b.symbol !== l.symbol || b.direction !== l.direction) return
			const dt = Math.abs(b.t - l.t)
			if (dt <= MATCH_WINDOW_MS && dt < bestDt) {
				best = i
				bestDt = dt
			}
		})
		if (best >= 0) {
			used.add(best)
			pairs.push({ live: l, bt: bt[best]! })
		} else unmatchedLive.push(l)
	}
	const extraBacktest = bt.filter((_, i) => !used.has(i))
	const diffs = pairs.filter((p) => p.live.score !== null && p.bt.score !== null).map((p) => p.bt.score! - p.live.score!)
	const share = live.length ? pairs.length / live.length : 0
	const med = median(diffs)
	return {
		liveFires: live.length,
		backtestFires: bt.length,
		matched: pairs.length,
		matchShare: share,
		scoreDiffMedian: med,
		scoreDiffMean: diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null,
		scoreWithin3: diffs.filter((d) => Math.abs(d) <= 3).length,
		alertAgreement: pairs.length ? pairs.filter((p) => p.live.alerted === p.bt.alerted).length / pairs.length : null,
		unmatchedLive,
		extraBacktest,
		pass: share >= PASS_MATCH_SHARE && med !== null && Math.abs(med) <= PASS_MEDIAN_SCORE_DIFF,
	}
}

/** Minimal CSV (psql \copy CSV HEADER): quoted fields, doubled quotes. */
export const parseCsv = (text: string): Record<string, string>[] => {
	const rows: string[][] = []
	let row: string[] = []
	let f = ''
	let q = false
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!
		if (q) {
			if (c === '"' && text[i + 1] === '"') { f += '"'; i++ }
			else if (c === '"') q = false
			else f += c
		} else if (c === '"') q = true
		else if (c === ',') { row.push(f); f = '' }
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++
			row.push(f); rows.push(row); row = []; f = ''
		} else f += c
	}
	if (f || row.length) { row.push(f); rows.push(row) }
	const [head, ...body] = rows
	return body.filter((r) => r.length === head!.length).map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i]!])))
}

const main = (): void => {
	const [liveCsv, btJsonl, from = '2026-11-04', to = '2026-11-09'] = process.argv.slice(2)
	if (!liveCsv || !btJsonl) throw new Error('usage: parity.ts <live signals.csv> <backtest signals.jsonl> [from] [to]')
	const inRange = (d: string) => d >= from && d <= to
	const live: Fire[] = parseCsv(fs.readFileSync(liveCsv, 'utf8'))
		.filter((r) => inRange(r.trade_date!))
		.map((r) => ({ detector: r.detector!, symbol: r.symbol!, direction: r.direction!, t: Date.parse(r.fired_at!.replace(' ', 'T').replace(/\+00$/, 'Z')), score: r.score ? Number(r.score) : null, alerted: r.alert_sent === 't', date: r.trade_date! }))
	const bt: Fire[] = fs
		.readFileSync(btJsonl, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>)
		.filter((r) => inRange(String(r.trade_date)))
		.map((r) => ({ detector: String(r.detector), symbol: String(r.symbol), direction: String(r.direction), t: Date.parse(String(r.fired_at)), score: r.score === null || r.score === undefined ? null : Number(r.score), alerted: r.alert_sent === true, date: String(r.trade_date) }))
	const m = matchFires(live, bt)
	console.log(JSON.stringify({ ...m, unmatchedLive: m.unmatchedLive.length, extraBacktest: m.extraBacktest.length, from, to }, null, 1))
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('backtest/bt6m/parity.ts')) main()
