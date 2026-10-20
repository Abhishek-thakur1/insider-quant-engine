// ============================================================
// tests/screenerPrefilter.test.ts — quote pre-filter, quota stops, multi-day resume
//
// Real src/screener/{prefilter,quotes,job,fetchDaily}.ts + src/fyers/quota.ts with
// a fake Fyers (quotes + history) on a virtual clock, in temp directories.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { batches, decidePrefilter, parseQuotes, updatePrefilterState, QUOTE_BATCH } from '../src/screener/prefilter.js'
import { fetchQuotesBatched } from '../src/screener/quotes.js'
import { runScreenerJob, type JobDeps } from '../src/screener/job.js'
import { fetchDailyUniverse, type HistoryResponse } from '../src/screener/fetchDaily.js'
import { CandleStore } from '../src/screener/candleStore.js'
import { loadConfig } from '../src/screener/config.js'
import { screenAsOf } from '../src/screener/screen.js'
import { createQuotaGate, loadQuotaConfig, MemoryLedger, type QuotaConfig } from '../src/fyers/quota.js'
import type { DailyBar } from '../src/screener/indicators.js'
import { VirtualClock } from './helpers/virtualClock.js'
import { benchmarkReturns, benchmarkSeries, dayOf, makeSeries, weekdays } from './helpers/screenerFixtures.js'

const { config, hash } = loadConfig()
const quota = loadQuotaConfig()
const quiet = { log: () => {}, warn: () => {}, error: () => {} }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-prefilter-'))

// ── Pure rules ──────────────────────────────────────────────────────────────

test('quote batches never exceed 50 symbols (the 2,352-symbol universe = 48 requests)', () => {
	const u = Array.from({ length: 2352 }, (_, i) => `S${i}`)
	const b = batches(u)
	assert.equal(QUOTE_BATCH, 50)
	assert.equal(b.length, 48)
	assert.ok(b.every((x) => x.length <= 50))
	assert.deepEqual(b.flat(), u)
})

test('parseQuotes reads Fyers {d:[{n,s,v:{lp,volume}}]}; bad rows mean "no quote"', () => {
	const q = parseQuotes({
		s: 'ok',
		d: [
			{ n: 'NSE:SBIN-EQ', s: 'ok', v: { lp: 812.5, volume: 9_000_000, ch: 1.2 } },
			{ n: 'NSE:BAD-EQ', s: 'error', v: { lp: 1, volume: 1 } },
			{ n: 'NSE:NOV-EQ', s: 'ok', v: { lp: 'x' } },
		],
	})
	assert.deepEqual([...q], [['NSE:SBIN-EQ', { lp: 812.5, volume: 9_000_000 }]])
	assert.equal(parseQuotes({ s: 'error' }).size, 0)
})

test('LENIENT rules: always-list and no-quote names are fetched; loose price/value bar; weekly recheck', () => {
	const today = '2026-10-22'
	const d = decidePrefilter({
		universe: ['CORE', 'LISTED', 'NOQUOTE', 'CHEAP', 'THIN', 'OK', 'REJ_RECENT', 'REJ_OLD'],
		quotes: new Map([
			['CORE', { lp: 5, volume: 1 }], // fails the bar but always fetched
			['LISTED', { lp: 10, volume: 1 }],
			['CHEAP', { lp: 12, volume: 10_000_000 }],
			['THIN', { lp: 100, volume: 100_000 }], // ₹1 cr today
			['OK', { lp: 100, volume: 300_000 }], // ₹3 cr today
			['REJ_RECENT', { lp: 100, volume: 300_000 }],
			['REJ_OLD', { lp: 100, volume: 300_000 }],
		]),
		always: new Set(['CORE', 'LISTED']),
		state: { rejected: { REJ_RECENT: { on: '2026-10-19', reason: 'turnover ₹9.0cr < ₹15.0cr' }, REJ_OLD: { on: '2026-10-15', reason: 'turnover ₹9.0cr < ₹15.0cr' } } },
		today,
		config: config.prefilter,
	})
	assert.deepEqual(d.fetch, ['CORE', 'LISTED', 'NOQUOTE', 'OK', 'REJ_OLD'])
	assert.match(d.skipped.get('CHEAP')!, /price ₹12 < ₹20/)
	assert.match(d.skipped.get('THIN')!, /today's traded value ₹1\.0 cr < ₹2\.0 cr/)
	assert.match(d.skipped.get('REJ_RECENT')!, /screen rejected on 2026-10-19 .* weekly recheck in 4 day\(s\)/)
	assert.deepEqual(d.counts, { always: 2, noQuote: 1, quoteFail: 2, recheckWait: 1, recheckDue: 1, pass: 1 })
	assert.ok(config.prefilter.minTradedValueRupees < config.liquidity.minAvgTurnoverRupees, 'pre-filter looser than the screen')
})

test('state update: illiquid fetched names start a 7-day wait; liquid clears it; no bar = no verdict', () => {
	const s = updatePrefilterState({ rejected: { A: { on: '2026-10-01', reason: 'x' }, C: { on: '2026-10-01', reason: 'y' } } }, '2026-10-22', {
		A: { liquid: true, barOnAsOf: true, reasons: [] },
		B: { liquid: false, barOnAsOf: true, reasons: ['turnover ₹3.0cr < ₹15.0cr'] },
		C: { liquid: false, barOnAsOf: false, reasons: ['no bar'] },
	})
	assert.deepEqual(s.rejected, { B: { on: '2026-10-22', reason: 'turnover ₹3.0cr < ₹15.0cr' }, C: { on: '2026-10-01', reason: 'y' } })
})

// ── Synthetic market + fake Fyers (quotes and history) ─────────────────────

const N = 320
const DAYS = weekdays('2025-01-01', N)
const BENCH = benchmarkReturns(N, 5, 0.001, 0.004)
const FULL = new Map<string, DailyBar[]>()
for (let i = 0; i < 40; i++) {
	const thin = i >= 30 // 10 illiquid names: ~₹0.4 cr/day
	FULL.set(`NSE:P${String(i).padStart(2, '0')}-EQ`, makeSeries({ days: DAYS, bench: BENCH, drift: (i - 15) * 0.0002, noiseSd: 0.0004, volume: thin ? 4_000 : 20_000_000, seed: 500 + i }))
}
FULL.set(config.benchmark, benchmarkSeries(DAYS, BENCH))
const UNIVERSE = [...FULL.keys()].filter((s) => s !== config.benchmark)
const TODAY = dayOf(DAYS[N - 1]!)

const fakeFyers = (clock: VirtualClock) => {
	const history: string[] = []
	const quoteCalls: number[] = []
	const getHistory = async (symbol: string, from: string, to: string): Promise<HistoryResponse> => {
		history.push(symbol)
		await clock.sleep(100)
		const bars = (FULL.get(symbol) ?? []).filter((x) => dayOf(x.t) >= from && dayOf(x.t) <= to)
		return { s: 'ok', candles: bars.map((x) => [x.t / 1000, x.o, x.h, x.l, x.c, x.v]) }
	}
	const getQuotes = async (batch: string[]): Promise<unknown> => {
		quoteCalls.push(batch.length)
		await clock.sleep(100)
		return { s: 'ok', d: batch.map((n) => ({ n, s: 'ok', v: { lp: FULL.get(n)!.at(-1)!.c, volume: FULL.get(n)!.at(-1)!.v } })) }
	}
	return { history, quoteCalls, getHistory, getQuotes: getQuotes as (batch: string[]) => Promise<unknown> }
}

const deps = (dir: string, clock: VirtualClock, fy: ReturnType<typeof fakeFyers>, ledger: MemoryLedger, q: QuotaConfig = quota, notes: string[] = []): JobDeps => {
	const store = new CandleStore(path.join(dir, 'candles'))
	const gate = createQuotaGate({ job: 'screener', config: q, ledger, clock, log: quiet })
	return {
		dataDir: dir, store, universe: UNIVERSE, core: ['NSE:P00-EQ'], fno: new Set(), config, configHash: hash, todayIst: TODAY,
		fetchQuotes: (symbols) => fetchQuotesBatched(symbols, { getQuotes: fy.getQuotes, gate }),
		fetchAll: (symbols) => fetchDailyUniverse(symbols, { getHistory: fy.getHistory, store, todayIst: TODAY, gate, clock, log: quiet }),
		notifyAdmin: async (t) => void notes.push(t),
		log: quiet,
	}
}

test('JOB: illiquid names never get a history request; funnel and files record the pre-filter', async () => {
	const dir = tmp()
	const clock = new VirtualClock(Date.parse('2026-10-21T11:00:00Z'))
	const fy = fakeFyers(clock)
	const ledger = new MemoryLedger()
	const r = await clock.run(runScreenerJob(deps(dir, clock, fy, ledger)))
	assert.equal(r.status, 'WRITTEN')
	assert.deepEqual(fy.quoteCalls, [40], 'one quote request for 40 symbols')
	const thin = UNIVERSE.filter((s) => Number(s.slice(5, 7)) >= 30)
	assert.ok(!fy.history.some((s) => thin.includes(s)), 'no history request for the 10 illiquid names')
	if (r.status === 'WRITTEN') {
		assert.match(r.funnelText, /skipped by quote pre-filter\s+10/)
		assert.equal(r.result.funnel.scanned, 40)
	}
	const skipped = JSON.parse(fs.readFileSync(path.join(dir, 'prefilter_skipped.json'), 'utf8'))
	assert.equal(Object.keys(skipped).length, 10)
	const meta = JSON.parse(fs.readFileSync(path.join(dir, 'watchlist_meta.json'), 'utf8'))
	assert.equal(meta.prefilter.fetch, 30)
	assert.equal(meta.prefilter.quoteRequests, 1)
})

test('PROPERTY: skipping the illiquid names does not change the watchlist (they could never qualify)', () => {
	const full = screenAsOf({ asOf: TODAY, universe: UNIVERSE, series: FULL, benchmark: FULL.get(config.benchmark)!, core: ['NSE:P00-EQ'], previous: null, fno: new Set(), config, configHash: hash })
	const liquid = UNIVERSE.filter((s) => Number(s.slice(5, 7)) < 30)
	const pre = screenAsOf({ asOf: TODAY, universe: liquid, series: FULL, benchmark: FULL.get(config.benchmark)!, core: ['NSE:P00-EQ'], previous: null, fno: new Set(), config, configHash: hash })
	assert.deepEqual(pre.watchlist, full.watchlist)
	assert.deepEqual(pre.entries, full.entries)
	assert.ok(UNIVERSE.filter((s) => !liquid.includes(s)).every((s) => !full.records[s]!.liquid))
})

test('QUOTA STOP → INCOMPLETE: old list kept, progress saved; next day resumes only what is missing', async () => {
	const dir = tmp()
	const previous = JSON.stringify(['NSE:OLD-EQ'])
	fs.writeFileSync(path.join(dir, 'watchlist.json'), previous)
	const clock = new VirtualClock(Date.parse('2026-10-21T11:00:00Z'))
	const ledger = new MemoryLedger()
	const tight: QuotaConfig = { ...quota, allocations: { ...quota.allocations, screener: 25 } } // 1 quote + 24 history
	const notes: string[] = []
	const fy1 = fakeFyers(clock)
	const r1 = await clock.run(runScreenerJob(deps(dir, clock, fy1, ledger, tight, notes)))
	assert.equal(r1.status, 'INCOMPLETE')
	assert.equal(fs.readFileSync(path.join(dir, 'watchlist.json'), 'utf8'), previous, 'previous watchlist untouched')
	assert.match(notes[0]!, /stopped by the Fyers quota guard — screener used its 25 Data-API requests/)
	assert.ok(fs.existsSync(path.join(dir, `incomplete_${TODAY}.json`)))
	const firstNight = new Set(fy1.history)
	assert.ok(firstNight.size > 0 && firstNight.size < 31)

	// Next day (new allocation): only symbols not yet cached are requested in full
	clock.t = Date.parse('2026-10-22T11:00:00Z')
	const fy2 = fakeFyers(clock)
	const r2 = await clock.run(runScreenerJob({ ...deps(dir, clock, fy2, ledger, quota), todayIst: TODAY }))
	assert.equal(r2.status, 'WRITTEN')
	const cold = fy2.history.filter((s) => !firstNight.has(s))
	assert.ok(cold.length > 0)
	assert.ok(fy2.history.length < 31 * 2, `resume re-requested too much: ${fy2.history.length}`)
	assert.notEqual(fs.readFileSync(path.join(dir, 'watchlist.json'), 'utf8'), previous)
})

test('DAILY LIMIT during quotes → INCOMPLETE immediately, zero history requests', async () => {
	const dir = tmp()
	const clock = new VirtualClock(Date.parse('2026-10-21T11:00:00Z'))
	const fy = fakeFyers(clock)
	fy.getQuotes = async () => ({ s: 'error', code: -360, message: "You've reached the Standard plan limit of 5,000 requests/day. Upgrade to Prime for higher API limits." })
	const ledger = new MemoryLedger()
	const r = await clock.run(runScreenerJob(deps(dir, clock, fy, ledger)))
	assert.equal(r.status, 'INCOMPLETE')
	assert.equal(fy.history.length, 0)
	assert.equal((await ledger.state('2026-10-21')).exhausted, true)
})

test('a failed quote batch is lenient: its symbols are fetched anyway', async () => {
	const clock = new VirtualClock(Date.parse('2026-10-21T11:00:00Z'))
	const gate = createQuotaGate({ job: 'screener', config: quota, ledger: new MemoryLedger(), clock, log: quiet })
	const syms = Array.from({ length: 120 }, (_, i) => `NSE:Q${i}-EQ`)
	let n = 0
	const r = await clock.run(
		fetchQuotesBatched(syms, {
			gate,
			getQuotes: async (b) => {
				n++
				if (n === 2) return { s: 'error', message: 'invalid symbol in batch' }
				return { s: 'ok', d: b.map((x) => ({ n: x, s: 'ok', v: { lp: 50, volume: 1e6 } })) }
			},
		}),
	)
	assert.equal(r.requests, 3)
	assert.equal(r.failed.length, 50)
	assert.equal(r.quotes.size, 70)
	const d = decidePrefilter({ universe: syms, quotes: r.quotes, always: new Set(), state: { rejected: {} }, today: '2026-10-21', config: config.prefilter })
	assert.equal(d.fetch.length, 120, 'no-quote symbols are fetched')
})
