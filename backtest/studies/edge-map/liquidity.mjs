// backtest/studies/edge-map/liquidity.mjs — tables §J (deviation 11). Descriptive only, no Fyers call.
// Inputs: the backtest cache (res-D, res-1) and a read-only export of the engine's vwap:{symbol}:{date}
// Redis keys (docs/studies/edge-map/liquidity_vwap_export_2026-10-26.tsv). The method is fixed in
// PREREGISTRATION.md, deviation 11, committed before this script ran.
//   node backtest/studies/edge-map/liquidity.mjs <cacheDir> <export.tsv>   → JSON on stdout
import fs from 'node:fs'
import path from 'node:path'

const [cacheDir, exportPath] = process.argv.slice(2)
const LIVE = ['RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','AARTIPHARM','AEQUS','CAPILLARY','GALLANTT','GENESYS','JAMNAAUTO','JAYKAY','JGCHEM','JINDWORLD','JSLL','JTLIND','MOTISONS','MRPL','RISHABH','ROLEXRINGS','RPEL','RPTECH','RSYSTEMS','SUNTV','SYNCOMF']
const PR34 = ['BSE','MCX','SBIN','ADANIENSOL','PAYTM','AXISBANK','KALYANKJIL','DIXON','TATASTEEL','BAJFINANCE','KOTAKBANK','HAL','HINDZINC','DIVISLAB','SOLARINDS','BEL','TVSMOTOR','COFORGE','HINDALCO','TECHM','POLYCAB','VEDL','TEJASNET','NTPC','ULTRACEMCO']
const OWNER = ['BSE','MCX','PAYTM','ATHERENERG']
const CORE = ['RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK']
const names = [...new Set([...LIVE, ...PR34, ...OWNER])]
const groups = (s) => [CORE.includes(s) ? 'core' : LIVE.includes(s) ? 'screener' : null, PR34.includes(s) ? '#34' : null, OWNER.includes(s) ? 'owner' : null].filter(Boolean).join(', ')

const IST = 19_800_000
const istDay = (t) => new Date(t + IST).toISOString().slice(0, 10)
const istMin = (t) => { const d = new Date(t + IST); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const load = (res, s) => { const f = path.join(cacheDir, `res-${res}`, `NSE_${s}-EQ.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).bars : null }

// (b) engine Redis: qualifying days = Nifty key holds 370-400 one-minute candles
const rows = fs.readFileSync(exportPath, 'utf8').trim().split('\n').map((l) => { const [k, v] = l.split('\t'); const m = k.match(/^vwap:(.+):(\d{4}-\d{2}-\d{2})$/); return { sym: m[1], day: m[2], st: JSON.parse(v) } })
const okDays = new Set(rows.filter((r) => r.sym === 'NSE:NIFTY50-INDEX' && r.st.cumulativeVol >= 370 && r.st.cumulativeVol <= 400).map((r) => r.day))

const ar = (bars) => { // Abdi-Ranaldo on consecutive in-session 1-min bars, 09:20-15:15
	let sum = 0, n = 0
	for (let i = 0; i + 1 < bars.length; i++) {
		const a = bars[i], b = bars[i + 1]
		if (istDay(a.t) !== istDay(b.t) || b.t - a.t !== 60_000) continue
		if (istMin(a.t) < 9 * 60 + 20 || istMin(b.t) > 15 * 60 + 15) continue
		const c = Math.log(a.c), e0 = (Math.log(a.h) + Math.log(a.l)) / 2, e1 = (Math.log(b.h) + Math.log(b.l)) / 2
		sum += (c - e0) * (c - e1); n++
	}
	return n ? { bps: Math.sqrt(Math.max(0, 4 * sum / n)) * 1e4, pairs: n } : null
}
const cs = (d) => { // Corwin-Schultz, 2-day, overnight-adjusted, negatives → 0, mean
	const k = 3 - 2 * Math.SQRT2, out = []
	for (let i = 0; i + 1 < d.length; i++) {
		let { h: h0, l: l0, c: c0 } = d[i], { h: h1, l: l1 } = d[i + 1]
		if (l1 > c0) { h1 -= l1 - c0; l1 = c0 } else if (h1 < c0) { l1 += c0 - h1; h1 = c0 }
		const beta = Math.log(h0 / l0) ** 2 + Math.log(h1 / l1) ** 2
		const gamma = Math.log(Math.max(h0, h1) / Math.min(l0, l1)) ** 2
		const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / k - Math.sqrt(gamma / k)
		out.push(Math.max(0, (2 * (Math.exp(alpha) - 1)) / (1 + Math.exp(alpha))))
	}
	return out.length ? (out.reduce((a, b) => a + b, 0) / out.length) * 1e4 : null
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10)

const out = names.map((s) => {
	const D = load('D', s), M = load('1', s)
	const d20 = D ? D.slice(-20) : null
	const engine = rows.filter((r) => r.sym === `NSE:${s}-EQ` && okDays.has(r.day)).sort((a, b) => a.day.localeCompare(b.day)).slice(-20)
	let m5 = null
	if (M) { const days = [...new Set(M.map((b) => istDay(b.t)))].slice(-5); m5 = { days, est: ar(M.filter((b) => days.includes(istDay(b.t)))) } }
	const primary = m5?.est?.bps ?? null
	return {
		symbol: s, groups: groups(s),
		cache: D ? { firstBar: istDay(D[0].t), lastBar: istDay(D.at(-1).t), adtvCr: r1(d20.reduce((a, b) => a + b.c * b.v, 0) / d20.length / 1e7), csDailyBps: r1(cs(d20)) } : null,
		ar1mBps: r1(primary), ar1mPairs: m5?.est?.pairs ?? 0, ar1mDays: m5 ? `${m5.days[0]}..${m5.days.at(-1)}` : null,
		engine: engine.length ? { n: engine.length, from: engine[0].day, to: engine.at(-1).day, adtvCr: r1(engine.reduce((a, r) => a + r.st.cumulativePV, 0) / engine.length / 1e7) } : null,
		flag: primary == null ? 'unknown' : primary > 10 ? '10 bps likely too low' : '',
	}
})
console.log(JSON.stringify({ qualifyingEngineDays: [...okDays].sort(), rows: out }, null, 1))
