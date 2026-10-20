// ============================================================
// tests/screener.test.ts — config, indicators, point-in-time, tiers, hysteresis, funnel
//
// Exercises the real src/screener/* modules (pure; no env, no network) on
// seeded synthetic markets from helpers/screenerFixtures.ts.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { configHash, loadConfig, validateConfig } from '../src/screener/config.js'
import { BenchIndex, ema, percentileRanks, residualMomentum, sma, adrPct, type DailyBar } from '../src/screener/indicators.js'
import { cutAsOf, oldLayerA, screenAsOf, type ScreenInput, type ScreenerSource } from '../src/screener/screen.js'
import { formatFunnel } from '../src/screener/funnel.js'
import { benchmarkReturns, benchmarkSeries, dayOf, makeSeries, weekdays } from './helpers/screenerFixtures.js'

const { config, hash } = loadConfig()

// ── Config ──────────────────────────────────────────────────────────────────

test('config/screener.json validates; hash ignores key order', () => {
	const raw = JSON.parse(fs.readFileSync('config/screener.json', 'utf8'))
	assert.equal(configHash(validateConfig(raw)), hash)
	const reordered = Object.fromEntries(Object.entries(raw).reverse())
	assert.equal(configHash(validateConfig(reordered)), hash)
	assert.equal(config.benchmark, 'NSE:NIFTY500-INDEX')
	assert.equal(config.watchlistCap, 100)
	assert.equal(config.tiers.tier1MinRsRank, 85)
	assert.equal(config.proximity.maxBelowHighPct, 25)
	assert.match(config.filters.asmGsm, /^not applied/)
	assert.match(config.filters.marketCap, /^not applied/)
})

test('invalid config is rejected with the field name', () => {
	const raw = JSON.parse(fs.readFileSync('config/screener.json', 'utf8'))
	assert.throws(() => validateConfig({ ...raw, score: { rsWeight: 0.5, residualWeight: 0.5, proximityWeight: 0.2 } }), /score weights must sum to 1/)
	assert.throws(() => validateConfig({ ...raw, tiers: { ...raw.tiers, holdMinRsRank: 90 } }), /hysteresis/)
	assert.throws(() => validateConfig({ ...raw, benchmark: 'NSE:RELIANCE-EQ' }), /index symbol/)
})

// ── Indicators (hand-checked) ───────────────────────────────────────────────

test('EMA / SMA / ADR match hand calculations', () => {
	// EMA(3) of 1..5: seed = mean(1,2,3) = 2; k = 0.5 → 3, then 4
	assert.equal(ema([1, 2, 3, 4, 5], 3), 4)
	assert.equal(ema([1, 2], 3), null)
	assert.equal(sma([1, 2, 3, 4, 5], 2), 4.5)
	assert.equal(sma([1, 2, 3, 4, 5], 2, 1), 3.5)
	const bars: DailyBar[] = [
		{ t: 0, o: 100, h: 105, l: 95, c: 100, v: 1 }, // 10%
		{ t: 1, o: 100, h: 102, l: 98, c: 100, v: 1 }, // 4%
	]
	assert.equal(adrPct(bars, 2), 7)
})

test('percentile ranks: 1–99, ties share the average rank', () => {
	const r = percentileRanks(new Map([['a', 1], ['b', 2], ['c', 2], ['d', 3]]))
	assert.equal(r.get('a'), 1)
	assert.equal(r.get('b'), 50)
	assert.equal(r.get('c'), 50)
	assert.equal(r.get('d'), 99)
})

test('residual momentum: high beta alone is not alpha; drift is', () => {
	const days = weekdays('2025-01-01', 200)
	const bench = benchmarkReturns(200, 3, 0.002) // strongly rising market
	const b = new BenchIndex(benchmarkSeries(days, bench))
	const highBeta = residualMomentum(makeSeries({ days, bench, beta: 2, drift: 0, noiseSd: 0.004, seed: 11 }), b, 126)!
	const alpha = residualMomentum(makeSeries({ days, bench, beta: 1, drift: 0.002, noiseSd: 0.004, seed: 12 }), b, 126)!
	assert.ok(Math.abs(highBeta.beta - 2) < 0.15, `beta ${highBeta.beta}`)
	assert.ok(Math.abs(highBeta.score) < 2.5, `high-beta score ${highBeta.score}`)
	assert.ok(alpha.score > 4, `alpha score ${alpha.score}`)
	assert.ok(alpha.score > highBeta.score + 3)
})

// ── A synthetic market: 101 stocks with ordered alpha ──────────────────────

const N_DAYS = 320
const DAYS = weekdays('2025-01-01', N_DAYS)
const BENCH = benchmarkReturns(N_DAYS, 5, 0.001, 0.004) // steadily rising market
const BENCH_BARS = benchmarkSeries(DAYS, BENCH)
const AS_OF = dayOf(DAYS[N_DAYS - 1]!)

/** stock i has daily alpha (i − 50)·1e-4 and tiny noise: position i ⇒ RS rank = 1 + 98·i/100 (all 101 eligible). */
const market = (overrides: Record<string, Partial<Parameters<typeof makeSeries>[0]>> = {}) => {
	const series = new Map<string, DailyBar[]>()
	for (let i = 0; i <= 100; i++) {
		const sym = `NSE:S${String(i).padStart(3, '0')}-EQ`
		series.set(sym, makeSeries({ days: DAYS, bench: BENCH, drift: (i - 50) * 0.0001, noiseSd: 0.0004, volume: 20_000_000, seed: 100 + i, ...overrides[sym] }))
	}
	return series
}

const input = (series: Map<string, DailyBar[]>, extra: Partial<ScreenInput> = {}): ScreenInput => ({
	asOf: AS_OF,
	universe: [...series.keys()],
	series,
	benchmark: BENCH_BARS,
	core: [],
	previous: null,
	fno: new Set(),
	config,
	configHash: hash,
	...extra,
})

test('ranks follow alpha; top names are Tier 1 leaders with reasons', () => {
	const r = screenAsOf(input(market()))
	const rank = (i: number) => r.records[`NSE:S${String(i).padStart(3, '0')}-EQ`]!
	assert.ok(rank(100).rsRank! > 95 && rank(0).rsRank! < 5, `${rank(100).rsRank} / ${rank(0).rsRank}`)
	assert.equal(rank(100).tier, 'TIER1')
	assert.equal(rank(30).tier, null)
	assert.match(rank(100).reasons.at(-1)!, /^TIER1: RS \d+/)
	assert.ok(r.entries.every((e) => e.source === 'SCREENER_LEADER'))
	assert.ok(r.watchlist.length > 0 && r.watchlist.length <= config.watchlistCap)
})

test('POINT-IN-TIME: changing or adding any bar after D leaves screen(D) byte-identical', () => {
	const base = market()
	const D = dayOf(DAYS[250]!)
	const before = JSON.stringify(screenAsOf(input(base, { asOf: D })))
	const future = new Map<string, DailyBar[]>()
	for (const [sym, bars] of base) {
		future.set(sym, bars.map((b) => (dayOf(b.t) > D ? { ...b, c: b.c * 10, h: b.h * 10, l: b.l * 0.1, v: b.v * 50 } : b)))
	}
	const benchFuture = BENCH_BARS.map((b) => (dayOf(b.t) > D ? { ...b, c: b.c * 3 } : b))
	const after = JSON.stringify(screenAsOf(input(future, { asOf: D, benchmark: benchFuture })))
	assert.equal(after, before)
	// and the cut really excludes later bars
	assert.ok(cutAsOf(base.get('NSE:S000-EQ')!, D).every((b) => dayOf(b.t) <= D))
	assert.equal(cutAsOf(base.get('NSE:S000-EQ')!, D).length, 251)
})

test('liquidity, price, circuit lock and short history exclude with a reason', () => {
	const s = market({
		'NSE:S100-EQ': { volume: 1000 }, // turnover far below ₹15 cr
		'NSE:S099-EQ': { startPrice: 2 }, // price stays below ₹20
	})
	s.set('NSE:NEW-EQ', s.get('NSE:S098-EQ')!.slice(-60)) // 60 bars only
	const locked = s.get('NSE:S097-EQ')!.slice()
	const lb = locked.at(-1)!
	locked[locked.length - 1] = { ...lb, o: lb.c, h: lb.c, l: lb.c }
	s.set('NSE:S097-EQ', locked)
	const r = screenAsOf(input(s))
	assert.equal(r.records['NSE:S100-EQ']!.eligible, false)
	assert.match(r.records['NSE:S100-EQ']!.reasons[0]!, /turnover ₹0\.\dcr < ₹15\.0cr/)
	assert.match(r.records['NSE:S099-EQ']!.reasons[0]!, /price ₹[\d.]+ < ₹20/)
	assert.match(r.records['NSE:NEW-EQ']!.reasons.join(' '), /history 60 bars < 127/)
	assert.equal(r.records['NSE:S097-EQ']!.circuitLocked, true)
	assert.equal(r.records['NSE:S097-EQ']!.eligible, false)
})

test('HYSTERESIS: enters at RS ≥ 85, stays at ~71 if listed yesterday, dropped below 70', () => {
	// Position p of 101 → rank 1 + 98p/100. S072 → 71.6, S069 → 68.6, S086 → 85.3.
	const r = screenAsOf(input(market()))
	const at = (p: number) => `NSE:S${String(p).padStart(3, '0')}-EQ`
	assert.ok(r.records[at(86)]!.rsRank! >= 85 && r.records[at(86)]!.tier === 'TIER1')
	assert.ok(r.records[at(72)]!.rsRank! >= 70 && r.records[at(72)]!.rsRank! < 85)
	assert.ok(r.records[at(69)]!.rsRank! < 70)
	assert.ok(!r.watchlist.includes(at(72)), 'not a new entry at 71.6')

	const prev = new Map<string, ScreenerSource>([[at(72), 'SCREENER_LEADER'], [at(69), 'SCREENER_LEADER']])
	const r2 = screenAsOf(input(market(), { previous: prev }))
	assert.ok(r2.watchlist.includes(at(72)), 'held at 71.6')
	assert.equal(r2.entries.find((e) => e.symbol === at(72))!.held, true)
	assert.ok(!r2.watchlist.includes(at(69)), 'dropped at 68.6')
})

test('cap: CORE first, then held, then Tier 1 by score; overflow counted', () => {
	const small = { ...config, watchlistCap: 5 }
	const core = ['NSE:RELIANCE-EQ', 'NSE:TCS-EQ']
	const r = screenAsOf(input(market(), { config: small, core }))
	assert.deepEqual(r.watchlist.slice(0, 2), core)
	assert.equal(r.watchlist.length, 5)
	const scores = r.entries.slice(2).map((e) => e.score!)
	assert.deepEqual(scores, [...scores].sort((a, b) => b - a))
	assert.ok(r.funnel.capped > 0)
	assert.equal(r.entries[0]!.source, 'CORE')
})

test('old Layer A (point-in-time): turnover ≥ ₹15 cr and ADR ≥ 4.5%, plus core', () => {
	const s = market({ 'NSE:S010-EQ': { rangePct: 2 }, 'NSE:S011-EQ': { volume: 1000 } })
	const a = oldLayerA(AS_OF, [...s.keys()], s, ['NSE:RELIANCE-EQ'])
	assert.ok(a.includes('NSE:RELIANCE-EQ'))
	assert.ok(!a.includes('NSE:S010-EQ'), 'low ADR excluded')
	assert.ok(!a.includes('NSE:S011-EQ'), 'illiquid excluded')
	assert.ok(a.includes('NSE:S012-EQ'))
})

test('GOLDEN: funnel output for a fixed 30-symbol market', () => {
	const s = new Map([...market()].filter(([k]) => Number(k.slice(5, 8)) % 4 === 0 || Number(k.slice(5, 8)) > 90).slice(0, 30))
	const outcome = new Map([...s.keys()].map((k, i) => [k, i === 3 ? ('FAILED' as const) : ('OK' as const)]))
	const r = screenAsOf(input(s, { core: ['NSE:RELIANCE-EQ'], previous: new Map([['NSE:S088-EQ', 'SCREENER_LEADER']]), fetchOutcome: outcome }))
	const text = formatFunnel(r)
	const golden = new URL('./fixtures/screenerFunnel.golden.txt', import.meta.url)
	if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(golden, text + '\n')
	assert.equal(text + '\n', fs.readFileSync(golden, 'utf8').replace(/\r\n/g, '\n'))
})

test('a symbol with no bar ON the as-of date (suspended / stale) is excluded with a reason', () => {
	const s = market()
	s.set('NSE:S095-EQ', s.get('NSE:S095-EQ')!.slice(0, -3)) // last 3 sessions missing
	const r = screenAsOf(input(s))
	const rec = r.records['NSE:S095-EQ']!
	assert.equal(rec.eligible, false)
	const why = rec.reasons.join(' ')
	assert.ok(why.includes(`no bar on ${AS_OF} (last `) && why.includes(') — suspended or stale'), why)
	assert.ok(!r.watchlist.includes('NSE:S095-EQ'))
})

test('LAYER B CAP: anomaly scan set = top N by turnover that traded on the as-of date, legacy 4-field shape', async () => {
	const { anomalyUniverse } = await import('../src/screener/screen.js')
	const s = market({ 'NSE:S100-EQ': { volume: 1000 } }) // far below the ₹1 cr scanner floor
	s.set('NSE:S095-EQ', s.get('NSE:S095-EQ')!.slice(0, -2)) // stale: no bar on the as-of date
	const r = screenAsOf(input(s))
	assert.equal(config.layerB.maxSymbols, 323)
	const capped = anomalyUniverse(r, { ...config, layerB: { ...config.layerB, maxSymbols: 10 } })
	const syms = Object.keys(capped)
	assert.equal(syms.length, 10)
	assert.ok(!syms.includes('NSE:S100-EQ') && !syms.includes('NSE:S095-EQ'))
	const eligibleByTurnover = Object.entries(r.records)
		.filter(([k, x]) => x.barOnAsOf && x.turnover >= config.layerB.minTurnoverRupees && k !== 'NSE:S095-EQ')
		.sort((a, b) => b[1].turnover - a[1].turnover)
		.slice(0, 10)
		.map(([k]) => k)
	assert.deepEqual(syms, eligibleByTurnover)
	assert.deepEqual(Object.keys(capped[syms[0]!]!).sort(), ['adr', 'advShares', 'close', 'turnover'])
	// with the real cap (323) and 101 names, it simply takes every qualifying name
	assert.equal(Object.keys(anomalyUniverse(r, config)).length, 99)
})
