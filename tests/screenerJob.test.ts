// ============================================================
// tests/screenerJob.test.ts — fetch, rate limit, failure budget, outputs
//
// Runs the real fetchDailyUniverse / runScreenerJob / CandleStore against a
// fake Fyers on a virtual clock and a temp directory. The fake enforces the
// Standard plan's rolling 5 req/s and answers -360 when it's exceeded.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { CandleStore } from '../src/screener/candleStore.js'
import { evaluateFailureBudget, fetchDailyUniverse, plannedRanges, type HistoryResponse } from '../src/screener/fetchDaily.js'
import { runScreenerJob, type JobDeps } from '../src/screener/job.js'
import { loadConfig } from '../src/screener/config.js'
import type { DailyBar } from '../src/screener/indicators.js'
import { VirtualClock } from './helpers/virtualClock.js'
import { benchmarkReturns, benchmarkSeries, dayOf, makeSeries, weekdays } from './helpers/screenerFixtures.js'

const { config, hash } = loadConfig()
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-screener-'))
const quiet = { log: () => {}, warn: () => {}, error: () => {} }

const N = 320
const DAYS = weekdays('2025-01-01', N)
const BENCH = benchmarkReturns(N, 5, 0.001, 0.004)
const TODAY = dayOf(DAYS[N - 1]!)
const FULL = new Map<string, DailyBar[]>()
for (let i = 0; i < 40; i++)
	FULL.set(`NSE:S${String(i).padStart(3, '0')}-EQ`, makeSeries({ days: DAYS, bench: BENCH, drift: (i - 20) * 0.0002, noiseSd: 0.0004, volume: 20_000_000, seed: 300 + i }))
FULL.set(config.benchmark, benchmarkSeries(DAYS, BENCH))
const UNIVERSE = [...FULL.keys()].filter((s) => s !== config.benchmark)

const maxInAnyWindow = (starts: number[], w: number) => {
	const s = [...starts].sort((a, b) => a - b)
	let best = 0
	for (let i = 0, j = 0; i < s.length; i++) {
		while (s[i]! - s[j]! >= w) j++
		best = Math.max(best, i - j + 1)
	}
	return best
}

const FYERS_360 = { code: -360, message: "You've reached the Standard plan limit of 5 requests/second.", s: 'error' }

/** Fake Fyers daily history. `behaviour` overrides per symbol. */
const fakeFyers = (clock: VirtualClock, behaviour: Record<string, 'fail' | 'nodata' | 'flaky' | 'error-body'> = {}) => {
	const calls: { symbol: string; at: number; from: string; to: string }[] = []
	const flakyHits = new Map<string, number>()
	const getHistory = async (symbol: string, from: string, to: string): Promise<HistoryResponse> => {
		const at = clock.now()
		calls.push({ symbol, at, from, to })
		const recent = calls.filter((c) => at - c.at < 1000).length
		await clock.sleep(120)
		if (recent > 5) throw FYERS_360
		const b = behaviour[symbol]
		if (b === 'fail') throw new Error('API returned status: error - invalid symbol')
		if (b === 'nodata') return { s: 'no_data', candles: [] }
		if (b === 'flaky' && (flakyHits.get(symbol) ?? 0) < 2) {
			flakyHits.set(symbol, (flakyHits.get(symbol) ?? 0) + 1)
			throw FYERS_360
		}
		if (b === 'error-body' && (flakyHits.get(symbol) ?? 0) < 1) {
			flakyHits.set(symbol, 1)
			return FYERS_360 // resolved, not rejected
		}
		const bars = (FULL.get(symbol) ?? []).filter((x) => dayOf(x.t) >= from && dayOf(x.t) <= to)
		return { s: 'ok', candles: bars.map((x) => [x.t / 1000, x.o, x.h, x.l, x.c, x.v]) }
	}
	return { calls, getHistory }
}

// ── Planning ────────────────────────────────────────────────────────────────

test('cold start: ≤365-day chunks covering 460 calendar days; incremental: from the last cached day', () => {
	const cold = plannedRanges([], '2026-10-20')
	assert.deepEqual(cold, [['2025-07-17', '2026-07-16'], ['2026-07-17', '2026-10-20']])
	const cached = [{ t: Date.parse('2026-10-15T00:00:00Z') - 5.5 * 3600e3, o: 1, h: 1, l: 1, c: 1, v: 1 }]
	assert.deepEqual(plannedRanges(cached, '2026-10-20'), [['2026-10-15', '2026-10-20']])
	assert.deepEqual(plannedRanges(cached, '2026-10-15'), [])
})

// ── Fetch ───────────────────────────────────────────────────────────────────

test('fetch: ≤4 starts in any 1000 ms window against a strict 5/s Fyers; -360 retried; outcomes for every symbol', async () => {
	const clock = new VirtualClock(0)
	const fy = fakeFyers(clock, { 'NSE:S001-EQ': 'flaky', 'NSE:S002-EQ': 'error-body', 'NSE:S003-EQ': 'nodata', 'NSE:S004-EQ': 'fail' })
	const store = new CandleStore(tmp())
	const r = await clock.run(fetchDailyUniverse(UNIVERSE, { getHistory: fy.getHistory, store, todayIst: TODAY, clock, log: quiet, rand: () => 0 }))
	assert.equal(maxInAnyWindow(fy.calls.map((c) => c.at), 1000), 4)
	assert.equal(r.outcomes.size, 40)
	assert.equal(r.outcomes.get('NSE:S001-EQ'), 'OK', 'thrown -360 retried')
	assert.equal(r.outcomes.get('NSE:S002-EQ'), 'OK', 'resolved -360 body retried')
	assert.equal(r.outcomes.get('NSE:S003-EQ'), 'NO_DATA')
	assert.equal(r.outcomes.get('NSE:S004-EQ'), 'FAILED')
	assert.match(r.errors.get('NSE:S004-EQ')!, /invalid symbol/)
	assert.equal(r.retries, 3)
	assert.ok(store.load('NSE:S010-EQ').length >= 300, `bars ${store.load('NSE:S010-EQ').length}`)
})

test('fetch is incremental: a second run asks only from the last cached day', async () => {
	const clock = new VirtualClock(0)
	const store = new CandleStore(tmp())
	const yesterday = dayOf(DAYS[N - 2]!)
	const fy1 = fakeFyers(clock)
	await clock.run(fetchDailyUniverse(['NSE:S010-EQ'], { getHistory: fy1.getHistory, store, todayIst: yesterday, clock, log: quiet }))
	const fy2 = fakeFyers(clock)
	await clock.run(fetchDailyUniverse(['NSE:S010-EQ'], { getHistory: fy2.getHistory, store, todayIst: TODAY, clock, log: quiet }))
	assert.deepEqual(fy2.calls.map((c) => [c.from, c.to]), [[yesterday, TODAY]])
	assert.equal(dayOf(store.load('NSE:S010-EQ').at(-1)!.t), TODAY)
})

// ── Failure budget ──────────────────────────────────────────────────────────

test('budget: >3% failed or >10% no data is a breach', () => {
	const mk = (f: number, nd: number) => new Map(Array.from({ length: 100 }, (_, i) => [`S${i}`, i < f ? 'FAILED' : i < f + nd ? 'NO_DATA' : 'OK'] as const))
	assert.equal(evaluateFailureBudget(mk(3, 0), config.failureBudget).ok, true)
	assert.equal(evaluateFailureBudget(mk(4, 0), config.failureBudget).ok, false)
	assert.equal(evaluateFailureBudget(mk(0, 10), config.failureBudget).ok, true)
	assert.match(evaluateFailureBudget(mk(0, 11), config.failureBudget).reason!, /11\/100 symbols returned no data/)
})

const jobDeps = (dataDir: string, clock: VirtualClock, behaviour: Record<string, 'fail' | 'nodata'> = {}, notes: string[] = []): JobDeps => {
	const store = new CandleStore(path.join(dataDir, 'candles'))
	const fy = fakeFyers(clock, behaviour)
	return {
		dataDir, store, universe: UNIVERSE, core: ['NSE:S000-EQ'], fno: new Set(['NSE:S039-EQ']), config, configHash: hash, todayIst: TODAY,
		fetchAll: (symbols) => clock.run(fetchDailyUniverse(symbols, { getHistory: fy.getHistory, store, todayIst: TODAY, clock, log: quiet })),
		notifyAdmin: async (t) => void notes.push(t),
		log: quiet,
	}
}

test('PARTIAL SCAN KEEPS THE OLD LIST: 2/40 failed (5%) → watchlist.json untouched, failures logged, admin told', async () => {
	const dir = tmp()
	const previous = JSON.stringify(['NSE:OLD1-EQ', 'NSE:OLD2-EQ'], null, 2)
	fs.writeFileSync(path.join(dir, 'watchlist.json'), previous)
	const notes: string[] = []
	const r = await runScreenerJob(jobDeps(dir, new VirtualClock(0), { 'NSE:S005-EQ': 'fail', 'NSE:S006-EQ': 'fail' }, notes))
	assert.equal(r.status, 'KEPT_PREVIOUS')
	assert.equal(fs.readFileSync(path.join(dir, 'watchlist.json'), 'utf8'), previous)
	assert.ok(!fs.existsSync(path.join(dir, 'watchlist_meta.json')))
	const failed = JSON.parse(fs.readFileSync(path.join(dir, `failed_${TODAY}.json`), 'utf8'))
	assert.deepEqual(failed.failed, ['NSE:S005-EQ', 'NSE:S006-EQ'])
	assert.equal(notes.length, 1)
	assert.match(notes[0]!, /NOT trusted — 2\/40 symbols failed \(5\.0% > 3%\)\. Previous watchlist kept\. Failed: NSE:S005-EQ, NSE:S006-EQ/)
})

test('benchmark unavailable → keep the old list', async () => {
	const dir = tmp()
	const notes: string[] = []
	const r = await runScreenerJob(jobDeps(dir, new VirtualClock(0), { [config.benchmark]: 'fail' }, notes))
	assert.equal(r.status, 'KEPT_PREVIOUS')
	assert.match(notes[0]!, /benchmark NSE:NIFTY500-INDEX unavailable/)
})

test('1/40 failed (2.5%) → written: watchlist, meta, stats (with anomaly-scanner fields), dated gz copy; rerun uses hysteresis', async () => {
	const dir = tmp()
	const r = await runScreenerJob(jobDeps(dir, new VirtualClock(0), { 'NSE:S005-EQ': 'fail' }))
	assert.equal(r.status, 'WRITTEN')
	const wl = JSON.parse(fs.readFileSync(path.join(dir, 'watchlist.json'), 'utf8')) as string[]
	assert.equal(wl[0], 'NSE:S000-EQ', 'core first')
	const meta = JSON.parse(fs.readFileSync(path.join(dir, 'watchlist_meta.json'), 'utf8'))
	assert.equal(meta.configHash, hash)
	assert.deepEqual(meta.fetch.failed, ['NSE:S005-EQ'])
	assert.equal(meta.funnel.failed, 1)
	const stats = JSON.parse(fs.readFileSync(path.join(dir, 'universe_stats.json'), 'utf8'))
	for (const k of ['advShares', 'adr', 'turnover', 'close']) assert.equal(typeof stats['NSE:S020-EQ'][k], 'number', k)
	assert.equal(stats['NSE:S039-EQ'].fno, true)
	const layerB = JSON.parse(fs.readFileSync(path.join(dir, 'anomaly_universe.json'), 'utf8'))
	assert.ok(Object.keys(layerB).length <= config.layerB.maxSymbols)
	assert.equal(meta.layerB.cap, 323)
	assert.equal(meta.layerB.symbols, Object.keys(layerB).length)
	const hist = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'history', `${TODAY}.json.gz`))).toString())
	assert.deepEqual(hist.meta.entries, meta.entries)
	if (r.status === 'WRITTEN') assert.match(r.funnelText, /final watchlist/)

	// Rerun the same day: yesterday's list is read back for hysteresis
	const r2 = await runScreenerJob(jobDeps(dir, new VirtualClock(0)))
	assert.equal(r2.status, 'WRITTEN')
	if (r2.status === 'WRITTEN') assert.ok(r2.result.entries.some((e) => e.held), 'previous entries are held')
})
