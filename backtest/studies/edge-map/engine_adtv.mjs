// backtest/studies/edge-map/engine_adtv.mjs — deviation 12: per-symbol engine-recorded ADTV (₹ crore)
// from a read-only export of the engine's vwap:{symbol}:{date} Redis keys (full-session days only:
// the Nifty key that day holds 370-400 one-minute candles). Mean over ALL qualifying days per symbol.
//   node backtest/studies/edge-map/engine_adtv.mjs <export.tsv> > docs/studies/edge-map/liquidity_engine_adtv.csv
import fs from 'node:fs'
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => { const [k, v] = l.replace(/\r$/, '').split('\t'); const m = k.match(/^vwap:(.+):(\d{4}-\d{2}-\d{2})$/); return { sym: m[1], day: m[2], st: JSON.parse(v) } })
const ok = new Set(rows.filter((r) => r.sym === 'NSE:NIFTY50-INDEX' && r.st.cumulativeVol >= 370 && r.st.cumulativeVol <= 400).map((r) => r.day))
const by = new Map()
for (const r of rows) if (r.sym.endsWith('-EQ') && ok.has(r.day)) { const a = by.get(r.sym) ?? []; a.push(r); by.set(r.sym, a) }
console.log('symbol,days,first,last,adtv_cr')
for (const [s, a] of [...by].sort((x, y) => x[0].localeCompare(y[0]))) {
	const d = a.map((r) => r.day).sort()
	console.log(`${s},${a.length},${d[0]},${d.at(-1)},${(a.reduce((x, r) => x + r.st.cumulativePV, 0) / a.length / 1e7).toFixed(2)}`)
}
