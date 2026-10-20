// ============================================================
// screener/funnel.ts — the per-run funnel, as printed and as golden-tested
//
// Deterministic text (no timestamps) so tests/fixtures/screenerFunnel.golden.txt
// can pin it exactly.
// ============================================================

import type { ScreenResult } from './screen.js'

const row = (label: string, n: number, note = '') => `  ${label.padEnd(34)} ${String(n).padStart(6)}${note ? `  ${note}` : ''}`

export const formatFunnel = (r: ScreenResult, topN = 20): string => {
	const f = r.funnel
	const lines = [
		`[Screener] Funnel as of ${r.asOf} (config ${r.configHash}, benchmark ${r.benchmark})`,
		row('scanned', f.scanned),
		...(f.prefilterSkipped !== undefined ? [row('skipped by quote pre-filter', f.prefilterSkipped)] : []),
		row('fetched OK', f.fetchedOk),
		row('failed (after retries)', f.failed),
		row('no data', f.noData),
		row('insufficient history', f.insufficientHistory),
		row('after liquidity + price + circuit', f.afterLiquidity),
		row('after trend structure', f.afterTrend),
		row('after RS rank cutoff', f.afterRs),
		row('tier 1 (leaders)', f.tier1),
		row('tier 2 (setups)', f.tier2),
		row('held by hysteresis', f.held),
		row('core (always listed)', f.core),
		row('final watchlist', f.final, f.capped > 0 ? `(${f.capped} qualified names cut by the cap)` : ''),
		...r.notes.map((n) => `  note: ${n}`),
		`[Screener] Top ${topN} by score:`,
	]
	const ranked = r.entries.filter((e) => e.score !== null).sort((a, b) => b.score! - a.score! || a.symbol.localeCompare(b.symbol)).slice(0, topN)
	ranked.forEach((e, i) => {
		const rec = r.records[e.symbol]!
		lines.push(
			`  ${String(i + 1).padStart(2)}. ${e.symbol.padEnd(22)} score ${e.score!.toFixed(1).padStart(5)}  ${e.source.padEnd(15)} ` +
				`RS ${rec.rsRank!.toFixed(1).padStart(4)}  resid ${rec.residualRank!.toFixed(1).padStart(4)}  ` +
				`${(-rec.proximityPct! * 100).toFixed(1).padStart(4)}% off high  ADR ${rec.adr.toFixed(1)}%${e.held ? '  held' : ''}`,
		)
	})
	if (ranked.length === 0) lines.push('  (none)')
	return lines.join('\n')
}
