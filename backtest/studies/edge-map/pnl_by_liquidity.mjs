// backtest/studies/edge-map/pnl_by_liquidity.mjs — deviation 12: live paper P&L split by engine ADTV.
// Absolute sums, not shares: the totals are near zero, so a share of the total is meaningless.
// CLOSED rows; synthetic_close / index_option_proxy excluded (deviation 7). R and realized_pnl as recorded (gross).
//   node backtest/studies/edge-map/pnl_by_liquidity.mjs <adtv.csv> <freeze-dir>...   → markdown rows
import fs from 'node:fs'
import path from 'node:path'
const [adtvCsv, ...dirs] = process.argv.slice(2)
const adtv = new Map(fs.readFileSync(adtvCsv, 'utf8').trim().split('\n').slice(1).map((l) => { const c = l.split(','); return [c[0], Number(c[4])] }))
const parseCsv = (txt) => { // RFC-4180 enough for these exports (quoted fields, doubled quotes)
	const rows = []; let row = [], f = '', q = false
	for (let i = 0; i < txt.length; i++) {
		const ch = txt[i]
		if (q) { if (ch === '"') { if (txt[i + 1] === '"') { f += '"'; i++ } else q = false } else f += ch }
		else if (ch === '"') q = true
		else if (ch === ',') { row.push(f); f = '' }
		else if (ch === '\n' || ch === '\r') { if (ch === '\r' && txt[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = '' }
		else f += ch
	}
	if (f || row.length) { row.push(f); rows.push(row) }
	const [h, ...body] = rows.filter((r) => r.length > 1)
	return body.map((r) => Object.fromEntries(h.map((k, j) => [k, r[j] ?? ''])))
}
const bucket = (sym) => sym.startsWith('NIFTY ') ? 'Nifty options' : !adtv.has(sym) ? 'unknown (no engine day)' : adtv.get(sym) >= 15 ? 'liquid (≥ ₹15 cr)' : 'thin (< ₹15 cr)'
const ORDER = ['liquid (≥ ₹15 cr)', 'thin (< ₹15 cr)', 'unknown (no engine day)', 'Nifty options']
for (const dir of dirs) {
	const pt = parseCsv(fs.readFileSync(path.join(dir, 'paper_trades.csv'), 'utf8'))
	const closed = pt.filter((r) => r.status === 'CLOSED' && !/synthetic_close|index_option_proxy/.test(r.data_quality))
	const tot = { n: closed.length, r: closed.reduce((a, r) => a + Number(r.r_multiple || 0), 0), pnl: closed.reduce((a, r) => a + Number(r.realized_pnl || 0), 0) }
	console.log(`\n**Freeze \`${path.basename(dir)}\`:** ${tot.n} kept CLOSED rows, ΣR ${tot.r.toFixed(2)}, Σ realized_pnl ₹${tot.pnl.toFixed(2)}.\n`)
	console.log('| Bucket | n | symbols | ΣR | mean R | Σ realized_pnl, ₹ |')
	console.log('|---|---|---|---|---|---|')
	for (const b of ORDER) {
		const xs = closed.filter((r) => bucket(r.symbol) === b)
		if (!xs.length) { console.log(`| ${b} | 0 | 0 | — | — | — |`); continue }
		const sr = xs.reduce((a, r) => a + Number(r.r_multiple || 0), 0), sp = xs.reduce((a, r) => a + Number(r.realized_pnl || 0), 0)
		console.log(`| ${b} | ${xs.length} | ${new Set(xs.map((r) => r.symbol)).size} | ${sr.toFixed(2)} | ${(sr / xs.length).toFixed(4)} | ${sp.toFixed(2)} |`)
	}
}
