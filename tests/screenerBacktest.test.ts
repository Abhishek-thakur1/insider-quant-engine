// ============================================================
// tests/screenerBacktest.test.ts — point-in-time universes and the comparison verdict
//
// Real backtest/universes.ts and backtest/compare.ts on synthetic data. No
// market data, no network.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { buildUniverses, liquidPool, unionOf } from '../backtest/universes.js'
import { compareUniverses, diffCI, renderMarkdown, summarize, type TradeLite } from '../backtest/compare.js'
import { DATA } from '../backtest/config.js'
import { loadConfig } from '../src/screener/config.js'
import { oldLayerA, screenAsOf, type ScreenerSource } from '../src/screener/screen.js'
import type { DailyBar } from '../src/screener/indicators.js'
import { benchmarkReturns, benchmarkSeries, dayOf, makeSeries, mulberry32, weekdays } from './helpers/screenerFixtures.js'

const { config, hash } = loadConfig()
const N = 340
const DAYS = weekdays('2025-01-01', N)
const BENCH = benchmarkReturns(N, 9, 0.0008, 0.005)
const BENCH_BARS = benchmarkSeries(DAYS, BENCH)
const SERIES = new Map<string, DailyBar[]>()
for (let i = 0; i < 60; i++)
	SERIES.set(`NSE:U${String(i).padStart(2, '0')}-EQ`, makeSeries({ days: DAYS, bench: BENCH, drift: (i - 30) * 0.00012, noiseSd: 0.003, volume: 20_000_000, seed: 700 + i }))
const UNIVERSE = [...SERIES.keys()]
const CORE = ['NSE:U00-EQ']
const TRADING = DAYS.slice(-21).map(dayOf) // 20 sessions + the as-of day before the first

const set = buildUniverses({ tradingDays: TRADING, universe: UNIVERSE, series: SERIES, benchmark: BENCH_BARS, core: CORE, config, configHash: hash })

test('universes: 20 sessions, lists for old / new / random1..3', () => {
	assert.equal(set.window.sessions, 20)
	assert.deepEqual(Object.keys(set.lists).sort(), ['new', 'old', 'random1', 'random2', 'random3'])
	for (const l of Object.keys(set.lists)) assert.equal(Object.keys(set.lists[l]!).length, 20, l)
	assert.ok(unionOf(set).length > 0)
})

test('POINT-IN-TIME: day D trades the list screened as of D−1 (hysteresis carried); old = old rule at D−1', () => {
	let previous: Map<string, ScreenerSource> | null = null
	for (let i = 1; i < TRADING.length; i++) {
		const r = screenAsOf({ asOf: TRADING[i - 1]!, universe: UNIVERSE, series: SERIES, benchmark: BENCH_BARS, core: CORE, previous, fno: new Set(), config, configHash: hash })
		previous = new Map(r.entries.map((e) => [e.symbol, e.source]))
		assert.deepEqual(set.lists.new![TRADING[i]!], r.watchlist, TRADING[i])
		assert.deepEqual(set.lists.old![TRADING[i]!], oldLayerA(TRADING[i - 1]!, UNIVERSE, SERIES, CORE))
	}
})

test('NO LOOK-AHEAD: corrupting day D\'s own bar (and everything after) leaves the list for D unchanged', () => {
	const D = TRADING[10]!
	const corrupted = new Map<string, DailyBar[]>()
	for (const [s, bars] of SERIES) corrupted.set(s, bars.map((b) => (dayOf(b.t) >= D ? { ...b, c: b.c * 7, h: b.h * 7, v: 1 } : b)))
	const bench2 = BENCH_BARS.map((b) => (dayOf(b.t) >= D ? { ...b, c: b.c * 0.2 } : b))
	const set2 = buildUniverses({ tradingDays: TRADING, universe: UNIVERSE, series: corrupted, benchmark: bench2, core: CORE, config, configHash: hash })
	for (const l of Object.keys(set.lists)) {
		for (const day of TRADING.slice(1)) {
			if (day > D) continue // lists AFTER D may (correctly) change
			assert.deepEqual(set2.lists[l]![day], set.lists[l]![day], `${l} ${day}`)
		}
	}
})

test('random controls: same size as new each day, include CORE, drawn from the liquid pool, seeded', () => {
	for (let i = 1; i < TRADING.length; i++) {
		const day = TRADING[i]!
		const pool = new Set(liquidPool(TRADING[i - 1]!, UNIVERSE, SERIES, config))
		for (const k of [1, 2, 3]) {
			const r = set.lists[`random${k}`]![day]!
			assert.equal(r.length, set.lists.new![day]!.length, `random${k} ${day} size`)
			assert.equal(r[0], CORE[0])
			for (const s of r.slice(1)) assert.ok(pool.has(s), `${s} not liquid on ${TRADING[i - 1]}`)
		}
	}
	const again = buildUniverses({ tradingDays: TRADING, universe: UNIVERSE, series: SERIES, benchmark: BENCH_BARS, core: CORE, config, configHash: hash })
	assert.deepEqual(again.lists.random1, set.lists.random1, 'deterministic')
	assert.notDeepEqual(set.lists.random1, set.lists.random2, 'seeds differ')
})

// ── Comparison ──────────────────────────────────────────────────────────────

const SESSIONS = Array.from({ length: 120 }, (_, i) => dayOf(DAYS[i]!))
const synth = (meanR: number, perDay: number, seed: number, det = 'stock_momentum_breakout'): TradeLite[] => {
	const rand = mulberry32(seed)
	return SESSIONS.flatMap((d, di) =>
		Array.from({ length: perDay }, (_, k) => ({ r: meanR + (rand() - 0.5) * 2, sessionDate: d, entryTs: DAYS[di]! + k, gatePassed: true, detectorId: det })),
	)
}
const POOLED = ['stock_momentum_breakout', 'volatility_contraction']
const fast = { iterations: 2000 }
const universeTrades = (newMean: number, oldMean: number, randMean: number, perDay = 2) => ({
	old: { stock_momentum_breakout: synth(oldMean, perDay, 1) },
	new: { stock_momentum_breakout: synth(newMean, perDay, 2) },
	random1: { stock_momentum_breakout: synth(randMean, perDay, 3) },
	random2: { stock_momentum_breakout: synth(randMean, perDay, 4) },
	random3: { stock_momentum_breakout: synth(randMean, perDay, 5) },
})

test('bootstrap: day-block CI brackets the sample mean; identical samples give a zero-width difference', () => {
	const t = synth(0.1, 3, 11)
	const s = summarize(t, SESSIONS, 7, 2000)
	assert.ok(s.ci95![0] < s.expectancyR! && s.expectancyR! < s.ci95![1])
	assert.deepEqual(diffCI(t, [t], SESSIONS, 7, 500), [0, 0])
})

test('verdict PASS: new clearly better and positive — no negative-expectancy statement', () => {
	const c = compareUniverses(universeTrades(0.4, 0.0, 0.0), POOLED, fast)
	assert.equal(c.verdict, 'PASS', c.reasons.join('; '))
	assert.equal(c.negativeExpectancyStatement, null)
})

test('"NOT WORSE" BUT NEGATIVE: passes the rule, and the report says plainly it still loses', () => {
	const c = compareUniverses(universeTrades(-0.05, -0.4, -0.4), POOLED, fast)
	assert.equal(c.verdict, 'PASS', c.reasons.join('; '))
	assert.match(c.negativeExpectancyStatement!, /is "not worse" than the old list and the random controls, but it still has NEGATIVE expectancy: -0\.0\d\dR per gated trade/)
	const md = renderMarkdown(c, { window: 'w', resolution: '5', configHash: hash, pooled: POOLED, names: {} })
	assert.match(md, /NEGATIVE expectancy/)
})

test('verdict FAIL when new is worse; INCONCLUSIVE below 100 trades or when the CI dips under −0.05R', () => {
	assert.equal(compareUniverses(universeTrades(-0.3, 0.1, 0.1), POOLED, fast).verdict, 'FAIL')
	const tiny = compareUniverses(universeTrades(0.4, 0, 0, 0), POOLED, fast) // 0 trades/day
	assert.equal(tiny.verdict, 'INCONCLUSIVE')
	const close = compareUniverses(universeTrades(0.1, 0.0, 0.0, 1), POOLED, fast) // better point estimate, but 1 trade/day is too noisy
	assert.equal(close.verdict, 'INCONCLUSIVE', close.reasons.join('; '))
	assert.ok(close.reasons.some((r) => /lower 95% bound/.test(r)))
})

test('report: n < 30 rows are flagged INSUFFICIENT and the limitations section is always present', () => {
	const trades = universeTrades(0.1, 0.1, 0.1)
	;(trades.new as Record<string, TradeLite[]>).volatility_contraction = synth(0.1, 1, 9, 'volatility_contraction').slice(0, 12)
	const md = renderMarkdown(compareUniverses(trades, POOLED, fast), { window: 'w', resolution: '5', configHash: hash, pooled: POOLED, names: {} })
	assert.match(md, /### volatility_contraction[\s\S]*\| 12 \|[^\n]*INSUFFICIENT \(n < 30\) — no conclusion/)
	for (const k of ['Survivorship bias', 'Single regime window', 'Intraday only', '5-minute bars']) assert.match(md, new RegExp(k))
})

test('harness defaults: 5-minute bars, multi-day ledger opt-in only', () => {
	assert.equal(DATA.intradayResolution, '5')
	const run = fs.readFileSync('backtest/run.ts', 'utf8')
	assert.match(run, /const multiday = opts\.multiday === true/)
	assert.match(run, /if \(multiday && MULTIDAY_DETECTORS\.includes\(signal\.detectorId\)\)/)
	assert.match(run, /multiday \? globalMultidayLedger\.evaluateEndOfDay/)
	assert.doesNotMatch(run.replace(/multiday && MULTIDAY_DETECTORS|multiday \? globalMultidayLedger/g, ''), /if \(MULTIDAY_DETECTORS\.includes/)
})

test('no CI when trades span fewer than 10 sessions (a one-day sample must not look certain)', () => {
	const oneDay = synth(0.3, 1, 21).filter((t) => t.sessionDate === SESSIONS[5]).concat(
		Array.from({ length: 10 }, (_, k) => ({ r: 0.5, sessionDate: SESSIONS[5]!, entryTs: k, gatePassed: true, detectorId: 'x' })),
	)
	const s = summarize(oneDay, SESSIONS, 7, 500)
	assert.equal(s.tradeDays, 1)
	assert.equal(s.ci95, null)
	assert.equal(diffCI(oneDay, [synth(0, 2, 22)], SESSIONS, 7, 500), null)
	const trades = universeTrades(0.1, 0.1, 0.1)
	;(trades.new as Record<string, TradeLite[]>).volatility_contraction = oneDay
	const md = renderMarkdown(compareUniverses(trades, POOLED, fast), { window: 'w', resolution: '5', configHash: hash, pooled: POOLED, names: {} })
	assert.match(md, /— \(trades on 1 day < 10\)/)
})
