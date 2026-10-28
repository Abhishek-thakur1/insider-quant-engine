// docs/proposals/watchlist-50/build_list.mjs — applies RULE.md exactly. Offline: reads the cache only.
//   node build_list.mjs <res-D cache dir> <live watchlist json> [NSE_FO.csv]
// Without the F&O master, rule 2(c) is reported as "pending" and NOT applied.
import fs from 'node:fs'
import path from 'node:path'

const [dir, livePath, foCsv] = process.argv.slice(2)
const TARGET = 50, MIN_BARS = 20, MIN_PRICE = 20
const live = JSON.parse(fs.readFileSync(livePath, 'utf8'))
const fno = foCsv ? new Set(fs.readFileSync(foCsv, 'utf8').split('\n').map((l) => l.split(',')[13]).filter(Boolean)) : null // underlying column, checked when used

const series = fs.readdirSync(dir).filter((f) => /-EQ\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
const lastDate = (s) => new Date(s.bars.at(-1).t + 5.5 * 3600e3).toISOString().slice(0, 10)
const common = series.map(lastDate).sort().at(-1)
const rows = series.map((s) => {
	const b = s.bars.slice(-MIN_BARS)
	const t20 = b.reduce((a, x) => a + x.c * x.v, 0) / b.length / 1e7
	const why = s.bars.length < MIN_BARS ? 'bars<20' : lastDate(s) !== common ? `last bar ${lastDate(s)}` : s.bars.at(-1).c < MIN_PRICE ? 'price<20' : fno && !fno.has(s.symbol.replace(/^NSE:|-EQ$/g, '')) ? 'not F&O' : ''
	return { symbol: s.symbol, t20, last: s.bars.at(-1).c, why, live: live.includes(s.symbol) }
}).sort((a, b) => b.t20 - a.t20 || a.symbol.localeCompare(b.symbol))
rows.forEach((r, i) => (r.rank = i + 1))
const add = rows.filter((r) => !r.why && !r.live).slice(0, TARGET - live.length)
console.log(JSON.stringify({ pool: rows.length, commonLastDate: common, fnoApplied: !!fno, liveInPool: rows.filter((r) => r.live).map((r) => r.symbol), add: add.map(({ symbol, t20, rank, last }) => ({ symbol, t20: +t20.toFixed(1), rank, last })), ineligible: rows.filter((r) => r.why).map((r) => [r.symbol, r.why]), next5: rows.filter((r) => !r.why && !r.live).slice(TARGET - live.length, TARGET - live.length + 5).map((r) => [r.symbol, +r.t20.toFixed(1)]) }, null, 1))
