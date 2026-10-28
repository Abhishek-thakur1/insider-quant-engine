// docs/proposals/screener-narrow/dryrun.ts — DESIGN.md §7: the §3 rule on the backtest cache. No Fyers call.
//   npx tsx docs/proposals/screener-narrow/dryrun.ts > docs/proposals/screener-narrow/dryrun_output.json
// Substitutions (DESIGN.md §7): F&O membership unknown offline (the liquidity and price filters stand in for U);
// Nifty 50 replaces Nifty 500 as the RS / residual benchmark.
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../../../src/screener/config.js'
import { screenAsOf } from '../../../src/screener/screen.js'
import type { DailyBar } from '../../../src/screener/indicators.js'

const DIR = 'backtest/data/cache/res-D'
const series = new Map<string, DailyBar[]>()
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json') && !x.endsWith('.coverage.json'))) {
	const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as { symbol: string; bars: DailyBar[] }
	series.set(j.symbol, j.bars)
}
const benchmark = series.get('NSE:NIFTY50-INDEX')!
series.delete('NSE:NIFTY50-INDEX')
const day = (t: number) => new Date(t + 19_800_000).toISOString().slice(0, 10)
const asOf = [...series.values()].map((b) => day(b.at(-1)!.t)).sort().at(-1)!
const core = ['NSE:RELIANCE-EQ', 'NSE:TCS-EQ', 'NSE:HDFCBANK-EQ', 'NSE:INFY-EQ', 'NSE:ICICIBANK-EQ']
const rule85 = (JSON.parse(fs.readFileSync(process.env.RULE85_JSON ?? '../iqe-wl50/docs/proposals/watchlist-50/list_output_85.json', 'utf8')) as { names: { symbol: string; group: string }[] }).names
const fixed = new Set(rule85.filter((n) => n.group !== 'screener (20 Oct)').map((n) => n.symbol))

const { config: base, hash } = loadConfig()
const run = (cfg: typeof base) => screenAsOf({ asOf, universe: [...series.keys()], series, benchmark, core, previous: null, fno: new Set(), config: cfg, configHash: hash })

// today's rule, for contrast
const today = run(base)
// §3 rule: liquidity ≥ ₹25 cr (30 bars), price ≥ 50, ADR ≥ 1.5%; score adds a volume-expansion rank
const narrowCfg = structuredClone(base)
narrowCfg.liquidity.minAvgTurnoverRupees = 25e7
narrowCfg.liquidity.minPrice = 50
narrowCfg.tradability.minAdrPct = 1.5
const narrow = run(narrowCfg)
const recs = Object.entries(narrow.records).filter(([, r]) => r.eligible)
const turnoverAvg = (bars: DailyBar[], n: number) => { const b = bars.slice(-n); return b.reduce((a, x) => a + x.c * x.v, 0) / b.length }
const volExp = new Map(recs.map(([s]) => { const b = series.get(s)!.filter((x) => day(x.t) <= asOf); return [s, turnoverAvg(b, 20) / turnoverAvg(b, 100)] as const }))
const sorted = [...volExp.entries()].sort((a, b) => a[1] - b[1])
const volRank = new Map(sorted.map(([s], i) => [s, sorted.length > 1 ? (i / (sorted.length - 1)) * 100 : 100]))
const scored = recs
	.filter(([, r]) => r.trend && r.adr >= 1.5 && r.volumeOk && r.rsRank !== null && r.residualRank !== null && r.proximityRank !== null)
	.map(([s, r]) => ({ symbol: s, score: Math.round((0.4 * r.rsRank! + 0.2 * r.residualRank! + 0.2 * r.proximityRank! + 0.2 * volRank.get(s)!) * 10) / 10, rs: r.rsRank, resid: r.residualRank, prox: r.proximityRank, vol: Math.round(volRank.get(s)!), adr: Math.round(r.adr * 10) / 10, turnoverCr: Math.round(r.turnover / 1e7) }))
	.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
const picks = scored.filter((x) => !fixed.has(x.symbol)).slice(0, 20)
console.log(JSON.stringify({
	asOf, benchmark: 'NSE:NIFTY50-INDEX (substitute for NIFTY500)', universe: series.size,
	todayRule: { funnel: today.funnel, watchlist: today.watchlist.filter((s) => !core.includes(s)) },
	narrow: { funnel: narrow.funnel, eligible: recs.length, trendGatedTradable: scored.length, ranked: scored, picksNotInRule85: picks, rankedAlreadyInRule85: scored.filter((x) => fixed.has(x.symbol)).length },
}, null, 1))
