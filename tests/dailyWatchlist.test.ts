// Daily watchlist (filters and ranking dw-2, list dw-3: PREREGISTRATION_dw3.md). No Fyers calls:
// the master, quotes, file writes and alerts are all fakes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	atomicWriter,
	budgeted,
	chooseWatchlist,
	CORE_SIZE,
	DAILY_FILE,
	eligibilityFunnel,
	eligible,
	inSessionWindow,
	MAX_STOCKS,
	percentiles,
	QUOTE_BATCH_CAP,
	QUOTE_REQUEST_CAP,
	QUOTE_RETRY_CAP,
	rankRotating,
	SCAN_REQUEST_CAP,
	runDailyScan,
	screenerEnabled,
	validateList,
	type DailyQuote,
	type ScanDeps,
} from '../src/screener/dailyWatchlist.js'

const AS_OF = '2026-11-02'
const FOR = '2026-11-03'
// Fyers `tt` ("Today's time") for 2 Nov 2026: a date stamp, 00:00 UTC = 05:30 IST
const TT = Math.floor(Date.parse('2026-11-02T00:00:00Z') / 1000)
const q = (o: Partial<DailyQuote> = {}): DailyQuote => ({ lp: 100, prevClose: 100, high: 102, low: 98, volume: 10_000_000, tt: TT, ...o })
const core = JSON.parse(fs.readFileSync(path.resolve('config/daily_watchlist_core.json'), 'utf8')) as string[]
const sym = (i: number) => `NSE:S${String(i).padStart(4, '0')}-EQ`

test('the committed core list is the 25 symbols of the 20 Oct list', () => {
	assert.equal(core.length, CORE_SIZE)
	assert.equal(new Set(core).size, 25)
	assert.equal(core[0], 'NSE:RELIANCE-EQ')
	assert.equal(core[24], 'NSE:SYNCOMF-EQ')
})

test('percentiles: 0..1, ties averaged', () => {
	assert.deepEqual(percentiles([10, 30, 20]), [0, 1, 0.5])
	assert.deepEqual(percentiles([5, 5, 9]), [0.25, 0.25, 1])
	assert.deepEqual(percentiles([7]), [1])
	assert.deepEqual(percentiles([]), [])
})

test('as-of rule (dw-2): the IST date of tt is the as-of day and volume > 0; then the floors', () => {
	assert.equal(eligible(q(), AS_OF), true, 'the date stamp 00:00 UTC (05:30 IST) of the as-of day counts')
	assert.equal(eligible(q({ tt: TT + 16 * 3600 }), AS_OF), true, 'any time on the as-of day (e.g. a fetch-time stamp at 21:30 IST)')
	assert.equal(eligible(q({ tt: TT + 86_400 }), AS_OF), false, 'a quote stamped on the target session is never used')
	assert.equal(eligible(q({ tt: TT - 86_400 }), AS_OF), false, 'stamped the day before')
	assert.equal(eligible(q({ volume: 0 }), AS_OF), false, 'did not trade')
	assert.equal(eligible(q({ lp: 49.9, prevClose: 49.9, high: 51, low: 48 }), AS_OF), false, 'below ₹50')
	assert.equal(eligible(q({ volume: 4_999_999 }), AS_OF), false, 'turnover below ₹50 crore')
	assert.equal(eligible(q({ high: 100, low: 100 }), AS_OF), false, 'stuck at one price')
	assert.equal(eligible(q({ prevClose: 0 }), AS_OF), false)
})

test('ranking: core excluded, 0.4 move + 0.3 range + 0.3 turnover, ties → turnover then symbol', () => {
	const quotes = new Map<string, DailyQuote>([
		[core[0]!, q({ lp: 150 })], // core: never ranked
		['NSE:BIGMOVE-EQ', q({ lp: 110 })], // move 10%
		['NSE:WIDE-EQ', q({ lp: 101, high: 108, low: 95 })], // range 13%
		['NSE:HEAVY-EQ', q({ lp: 100.5, volume: 90_000_000 })],
		['NSE:THIN-EQ', q({ volume: 1_000 })], // not eligible
	])
	const r = rankRotating(quotes, core, AS_OF)
	assert.deepEqual(r.map((e) => e.symbol), ['NSE:BIGMOVE-EQ', 'NSE:WIDE-EQ', 'NSE:HEAVY-EQ'])
	assert.equal(r[0]!.rank, 1)
	assert.ok(r.every((e) => e.group === 'rotating' && e.score !== undefined && e.move !== undefined && e.range !== undefined && e.turnover !== undefined))
	// exact score by hand: BIGMOVE move pct 1; range 4% ties HEAVY's 4% at the bottom → (0+1)/2/2 = 0.25; turnover pct 0.5
	assert.equal(r[0]!.score!.toFixed(4), (0.4 * 1 + 0.3 * 0.25 + 0.3 * 0.5).toFixed(4))
	// identical measures: higher turnover first, then symbol
	const tie = rankRotating(new Map([['NSE:B-EQ', q()], ['NSE:A-EQ', q()], ['NSE:C-EQ', q({ volume: 20_000_000 })]]), [], AS_OF)
	assert.equal(tie[0]!.symbol, 'NSE:C-EQ')
	assert.deepEqual(tie.slice(1).map((e) => e.symbol), ['NSE:A-EQ', 'NSE:B-EQ'])
	assert.equal(rankRotating(quotes, core, AS_OF, 1).length, 1)
})

test('validation: 60–79 unique well-formed stocks', () => {
	const list = (n: number) => Array.from({ length: n }, (_, i) => sym(i))
	assert.deepEqual(validateList(list(60)), [])
	assert.deepEqual(validateList(list(MAX_STOCKS)), [])
	assert.match(validateList(list(59)).join(), /59 stocks/)
	assert.match(validateList(list(80)).join(), /80 stocks/)
	assert.match(validateList([...list(70), sym(1)]).join(), /duplicate/)
	assert.match(validateList([...list(70), 'NSE:NIFTY50-INDEX', 'nse:x-eq']).join(), /malformed/)
	assert.match(validateList(list(70), { rotating: ['NSE:GONE-EQ'], universe: new Set(list(70)) }).join(), /not in the master/)
	assert.match(validateList('x').join(), /not an array/)
})

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dw-'))
const daily = (o: Record<string, unknown> = {}) => JSON.stringify({ rulesVersion: 'dw-3', asOf: AS_OF, forSession: FOR, generatedAt: 'x', requests: 49, symbols: Array.from({ length: 79 }, (_, i) => sym(i)), entries: [], ...o })

test('the engine uses the daily list only when enabled, valid and for today; otherwise the static file', () => {
	const dir = tmpDir()
	const staticPath = path.join(dir, 'watchlist.json')
	const dailyPath = path.join(dir, DAILY_FILE)
	fs.writeFileSync(staticPath, JSON.stringify(core))
	const pick = (enabled: boolean, today = FOR) => chooseWatchlist({ enabled, dailyPath, staticPath, today })

	let c = pick(true)
	assert.equal(c.source, 'static'); assert.equal(c.fellBack, true); assert.match(c.reason, /no readable/)
	fs.writeFileSync(dailyPath, daily())
	c = pick(true)
	assert.equal(c.source, 'daily'); assert.equal(c.symbols.length, 79); assert.equal(c.fellBack, false); assert.equal(c.path, dailyPath)
	c = pick(false)
	assert.equal(c.source, 'static'); assert.equal(c.fellBack, false); assert.equal(c.reason, 'SCREENER_ENABLED is not true'); assert.deepEqual(c.symbols, core)
	c = pick(true, '2026-11-04')
	assert.equal(c.source, 'static'); assert.equal(c.fellBack, true); assert.match(c.reason, /is for 2026-11-03/)
	fs.writeFileSync(dailyPath, daily({ symbols: core }))
	c = pick(true)
	assert.equal(c.source, 'static'); assert.match(c.reason, /25 stocks/)
	fs.writeFileSync(dailyPath, daily({ rulesVersion: 'dw-1' }))
	assert.equal(pick(true).source, 'static')
	fs.writeFileSync(dailyPath, '{not json')
	assert.equal(pick(true).source, 'static')
	assert.equal(fs.readFileSync(staticPath, 'utf8'), JSON.stringify(core), 'the static file is never written')
})

test('SCREENER_ENABLED defaults to false; only "true" turns it on (owner, 2 Nov)', () => {
	assert.equal(screenerEnabled({}), false)
	assert.equal(screenerEnabled({ SCREENER_ENABLED: 'true' }), true)
	assert.equal(screenerEnabled({ SCREENER_ENABLED: '1' }), false)
	assert.equal(screenerEnabled({ SCREENER_ENABLED: 'TRUE' }), false)
	assert.equal(screenerEnabled({ SCREENER_ENABLED: 'false' }), false)
})

test('the scan refuses to run 09:00–15:30 IST on a trading day', () => {
	const at = (utc: string) => Date.parse(utc)
	assert.equal(inSessionWindow(at('2026-11-03T03:30:00Z'), true), true) // 09:00
	assert.equal(inSessionWindow(at('2026-11-03T09:59:00Z'), true), true) // 15:29
	assert.equal(inSessionWindow(at('2026-11-03T10:00:00Z'), true), false) // 15:30
	assert.equal(inSessionWindow(at('2026-11-02T15:00:00Z'), true), false) // 20:30
	assert.equal(inSessionWindow(at('2026-11-03T05:00:00Z'), false), false) // holiday
})

/** A fake scan: universe of n symbols, a quote for each, every batch counted. */
const fakeScan = (o: { n?: number; quote?: (s: string, i: number) => DailyQuote | null; failBatch?: (i: number) => boolean; master?: () => Promise<string[]>; cap?: number } = {}) => {
	const n = o.n ?? 1200
	const universe = [...core, ...Array.from({ length: n - core.length }, (_, i) => sym(i))]
	const writes = new Map<string, string>()
	const alerts: string[] = []
	const rawLines: string[] = []
	let batchNo = 0
	const raw = budgeted(async (batch: string[]) => {
		const i = batchNo++
		if (o.failBatch?.(i)) throw new Error('boom')
		return { s: 'ok', d: batch.map((s) => { const qq = o.quote ? o.quote(s, universe.indexOf(s)) : q({ lp: 100 + (universe.indexOf(s) % 97) }); return qq ? { n: s, s: 'ok', v: { lp: qq.lp, prev_close_price: qq.prevClose, high_price: qq.high, low_price: qq.low, volume: qq.volume, tt: qq.tt } } : { n: s, s: 'error' } }) }
	}, o.cap)
	const deps: ScanDeps = {
		asOf: AS_OF,
		forSession: FOR,
		nowMs: Date.parse('2026-11-02T15:00:00Z'),
		core,
		downloadMaster: o.master ?? (async () => universe),
		getQuotes: raw.call,
		quoteRequestsUsed: raw.used,
		limitQuoteRequests: raw.limit,
		writeFile: (name, content) => writes.set(name, content),
		saveRaw: (line) => rawLines.push(line),
		notify: async (t) => alerts.push(t),
		log: { log: () => {}, warn: () => {} },
	}
	return { deps, writes, alerts, raw, rawLines }
}

test('a good scan writes the list and the day log: 25 core + 54 ranked, with reasons and the request count', async () => {
	const { deps, writes, alerts, raw, rawLines } = fakeScan()
	const r = await runDailyScan(deps)
	assert.equal(rawLines.length, 24, 'one raw line per quote batch')
	assert.equal(JSON.parse(rawLines[0]!).resp.s, 'ok')
	assert.equal(r.ok, true)
	assert.equal(alerts.length, 0)
	assert.equal(raw.used(), Math.ceil((1200 - 25) / 50)) // core isn't quoted: 24 batches
	const f = JSON.parse(writes.get(DAILY_FILE)!)
	assert.equal(writes.get(`watchlist_daily_history/${FOR}.json`), writes.get(DAILY_FILE))
	assert.equal(f.symbols.length, 79)
	assert.deepEqual(f.symbols.slice(0, 25), core)
	assert.equal(f.requests, 1 + 24)
	assert.equal(f.asOf, AS_OF); assert.equal(f.forSession, FOR); assert.equal(f.rulesVersion, 'dw-3')
	assert.deepEqual(f.funnel, { quoted: 1175, asOfDay: 1175, price: 1175, turnover: 1175, eligible: 1175 })
	const rot = f.entries.filter((e: { group: string }) => e.group === 'rotating')
	assert.equal(rot.length, 54)
	assert.ok(rot.every((e: { rank: number; score: number; move: number; range: number; turnover: number }) => e.rank > 0 && e.score >= 0 && e.move >= 0 && e.range > 0 && e.turnover > 0))
})

test('failures keep the previous list and alert the owner', async () => {
	const cases: [string, Parameters<typeof fakeScan>[0], RegExp][] = [
		['master down', { master: async () => { throw new Error('ECONNRESET') } }, /symbol master/],
		['tiny master', { master: async () => ['NSE:A-EQ'] }, /only 1 symbols/],
		['too few eligible', { quote: (_s, i) => (i < 50 ? q() : q({ volume: 1 })) }, /validation: .*stocks, need 60/],
		['quotes from the target session only', { quote: () => q({ tt: TT + 86_400 }) }, /validation/],
		['>10% batches failed', { failBatch: (i) => i % 5 === 0 }, /quote batches failed/],
		['request cap', { cap: 10 }, /quota stop: quote request cap 10/],
		['more batches than the cap allows', { n: 50 * QUOTE_BATCH_CAP + 26 }, /49 quote batches needed > cap 48/],
		['not traded (volume 0)', { quote: () => q({ volume: 0 }) }, /as-of day 0/],
	]
	for (const [name, opts, re] of cases) {
		const { deps, writes, alerts } = fakeScan(opts)
		const r = await runDailyScan(deps)
		assert.equal(r.ok, false, name)
		assert.equal(writes.size, 0, `${name}: nothing written`)
		assert.equal(alerts.length, 1, `${name}: one alert`)
		assert.match(alerts[0]!, /NOT updated/)
		assert.match(alerts[0]!, re, name)
		assert.ok((r as { requests: number }).requests <= 55, `${name}: within 55 requests`)
	}
})

test('the request cap counts every attempt, retries included: 55 = 1 master + 48 batches + 6 retries', async () => {
	let calls = 0
	const raw = budgeted(async () => { calls++; return { s: 'ok', d: [] } }, 3)
	await raw.call([]); await raw.call([]); await raw.call([]) // e.g. one batch tried 3 times by the gate
	await assert.rejects(raw.call([]), /cap 3 reached/)
	assert.equal(calls, 3)
	assert.equal(raw.used(), 3)
	assert.deepEqual([SCAN_REQUEST_CAP, QUOTE_BATCH_CAP, QUOTE_RETRY_CAP, QUOTE_REQUEST_CAP], [55, 48, 6, 54])
	raw.limit(10)
	await assert.rejects(raw.call([]), /cap 3 reached/, 'limit never raises the cap')
})

test('48 batches (the 3 Nov universe size) are allowed; quote attempts are capped at batches + 6', async () => {
	const n = 25 + 50 * QUOTE_BATCH_CAP // exactly 48 batches
	const ok = fakeScan({ n })
	const r = await runDailyScan(ok.deps)
	assert.equal(r.ok, true)
	assert.equal(ok.raw.used(), 48)
	assert.equal((r as { file: { requests: number } }).file.requests, 49)
	// a small universe: 24 batches → at most 30 attempts, even though 54 would fit the scan cap
	const small = fakeScan({ failBatch: () => false })
	await runDailyScan(small.deps)
	small.raw.limit(Infinity)
	for (let i = small.raw.used(); i < 30; i++) await small.raw.call([])
	await assert.rejects(small.raw.call([]), /cap 30 reached/)
})

test('atomic writer: temp file then rename, subdirectories created', () => {
	const dir = tmpDir()
	const w = atomicWriter(dir)
	w('watchlist_daily_history/2026-11-03.json', '{"a":1}')
	w(DAILY_FILE, '{"b":2}')
	assert.equal(fs.readFileSync(path.join(dir, DAILY_FILE), 'utf8'), '{"b":2}')
	assert.equal(fs.readFileSync(path.join(dir, 'watchlist_daily_history', '2026-11-03.json'), 'utf8'), '{"a":1}')
	assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), [])
})

test('a failed scan still keeps its raw quote sample, error batches included', async () => {
	const { deps, writes, rawLines } = fakeScan({ failBatch: (i) => i % 5 === 0 })
	const r = await runDailyScan(deps)
	assert.equal(r.ok, false)
	assert.equal(writes.size, 0)
	assert.equal(rawLines.length, 24)
	assert.equal(rawLines.filter((l) => JSON.parse(l).error).length, 5)
})

test('eligibility funnel counts each step in order, core excluded', () => {
	const quotes = new Map<string, DailyQuote>([
		[core[0]!, q()],
		['NSE:OK-EQ', q()],
		['NSE:OLD-EQ', q({ tt: TT - 86_400 })],
		['NSE:CHEAP-EQ', q({ lp: 10, prevClose: 10, high: 11, low: 9, volume: 1e9 })],
		['NSE:THIN-EQ', q({ volume: 10 })],
		['NSE:FLAT-EQ', q({ high: 100, low: 100 })],
	])
	assert.deepEqual(eligibilityFunnel(quotes, core, AS_OF), { quoted: 5, asOfDay: 4, price: 3, turnover: 2, eligible: 1 })
})
