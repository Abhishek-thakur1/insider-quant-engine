// docs/proposals/watchlist-50/build_list_85.mjs — applies RULE-85.md exactly. Offline: cache + committed exports only.
//   node build_list_85.mjs <cache dir> <engine vwap export .tsv> <engine_adtv.csv>  → JSON on stdout
// Pool / eligibility / T20 identical to build_list.mjs (RULE.md). Liquidity columns: edge-map deviations 11 and 12.
import fs from 'node:fs'
import path from 'node:path'

const [cacheDir, exportPath, adtvCsv] = process.argv.slice(2)
const TARGET = 84, MIN_BARS = 20, MIN_PRICE = 20
const live = JSON.parse(fs.readFileSync('live_watchlist_2026-10-20.json', 'utf8'))
const owner = ['NSE:BSE-EQ', 'NSE:MCX-EQ', 'NSE:PAYTM-EQ', 'NSE:ATHERENERG-EQ']
const r34 = JSON.parse(fs.readFileSync('list_output.json', 'utf8')).add.map((a) => a.symbol).filter((s) => !owner.includes(s))
const fixed = [...live, ...owner, ...r34]
if (new Set(fixed).size !== 51) throw new Error(`fixed set is ${new Set(fixed).size}, expected 51`)

const IST = 19_800_000
const istDay = (t) => new Date(t + IST).toISOString().slice(0, 10)
const istMin = (t) => { const d = new Date(t + IST); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const load = (res, sym) => { const f = path.join(cacheDir, `res-${res}`, `${sym.replace(':', '_')}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).bars : null }

// pool (RULE.md §2)
const dDir = path.join(cacheDir, 'res-D')
const series = fs.readdirSync(dDir).filter((f) => /-EQ\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dDir, f), 'utf8')))
const common = series.map((s) => istDay(s.bars.at(-1).t)).sort().at(-1)
const pool = series.map((s) => {
	const b = s.bars.slice(-MIN_BARS)
	const t20 = b.reduce((a, x) => a + x.c * x.v, 0) / b.length / 1e7
	const why = s.bars.length < MIN_BARS ? 'bars<20' : istDay(s.bars.at(-1).t) !== common ? `last bar ${istDay(s.bars.at(-1).t)}` : s.bars.at(-1).c < MIN_PRICE ? 'price<20' : ''
	return { symbol: s.symbol, t20, why }
}).sort((a, b) => b.t20 - a.t20 || a.symbol.localeCompare(b.symbol))
pool.forEach((r, i) => (r.rank = i + 1))
const fill = pool.filter((r) => !r.why && !fixed.includes(r.symbol)).slice(0, TARGET - fixed.length)
const names = [...fixed, ...fill.map((r) => r.symbol)]

// liquidity (deviation 11: engine ADTV over up to 20 full-session days; AR 1-min over the last 5 cached sessions)
const rows = fs.readFileSync(exportPath, 'utf8').trim().split('\n').map((l) => { const [k, v] = l.replace(/\r$/, '').split('\t'); const m = k.match(/^vwap:(.+):(\d{4}-\d{2}-\d{2})$/); return { sym: m[1], day: m[2], st: JSON.parse(v) } })
const okDays = new Set(rows.filter((r) => r.sym === 'NSE:NIFTY50-INDEX' && r.st.cumulativeVol >= 370 && r.st.cumulativeVol <= 400).map((r) => r.day))
const adtv12 = new Map(fs.readFileSync(adtvCsv, 'utf8').trim().split('\n').slice(1).map((l) => { const c = l.split(','); return [c[0], Number(c[4])] }))
const ar = (bars) => {
	let sum = 0, n = 0
	for (let i = 0; i + 1 < bars.length; i++) {
		const a = bars[i], b = bars[i + 1]
		if (istDay(a.t) !== istDay(b.t) || b.t - a.t !== 60_000) continue
		if (istMin(a.t) < 9 * 60 + 20 || istMin(b.t) > 15 * 60 + 15) continue
		const c = Math.log(a.c), e0 = (Math.log(a.h) + Math.log(a.l)) / 2, e1 = (Math.log(b.h) + Math.log(b.l)) / 2
		sum += (c - e0) * (c - e1); n++
	}
	return n ? Math.sqrt(Math.max(0, (4 * sum) / n)) * 1e4 : null
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10)
const group = (s) => (['NSE:RELIANCE-EQ', 'NSE:TCS-EQ', 'NSE:HDFCBANK-EQ', 'NSE:INFY-EQ', 'NSE:ICICIBANK-EQ'].includes(s) ? 'core' : live.includes(s) ? 'screener (20 Oct)' : owner.includes(s) ? 'owner pick' : r34.includes(s) ? '#34 rule' : 'extension fill')
const out = names.map((s) => {
	const p = pool.find((r) => r.symbol === s)
	const eng = rows.filter((r) => r.sym === s && okDays.has(r.day)).sort((a, b) => a.day.localeCompare(b.day)).slice(-20)
	const M = load('1', s)
	let spread = null
	if (M) { const days = [...new Set(M.map((b) => istDay(b.t)))].slice(-5); spread = ar(M.filter((b) => days.includes(istDay(b.t)))) }
	const a12 = adtv12.get(s)
	return {
		symbol: s, group: group(s), t20: p ? r1(p.t20) : null, rank: p?.rank ?? null, fno: 'pending',
		engineAdtv: eng.length ? r1(eng.reduce((a, r) => a + r.st.cumulativePV, 0) / eng.length / 1e7) : null, engineDays: eng.length,
		ar1m: r1(spread), flag10: spread == null ? 'unknown' : spread > 10 ? '10 bps likely too low' : 'ok',
		dev12: a12 == null ? 'unknown' : a12 >= 15 ? 'liquid' : 'thin',
	}
})
console.log(JSON.stringify({ commonLastDate: common, poolSize: pool.length, eligibleNotFixed: pool.filter((r) => !r.why && !fixed.includes(r.symbol)).length, fixed: fixed.length, fill: fill.length, total: names.length, nextAfterFill: pool.filter((r) => !r.why && !fixed.includes(r.symbol)).slice(TARGET - fixed.length, TARGET - fixed.length + 5).map((r) => [r.symbol, r1(r.t20)]), ineligible: pool.filter((r) => r.why).map((r) => [r.symbol, r.why]), names: out }, null, 1))
