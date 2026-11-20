// Daily watchlist from the NSE bhavcopy (rules dw-3, docs/studies/daily-watchlist/PREREGISTRATION_dw3.md).
// No network: the zip is built in memory. Rows below are real 3 Nov 2026 values (RELIANCE, TATASTEEL, JPL)
// in the real UDiFF column order; the rest are synthetic.
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { bhavcopyUrl, parseBhavcopy, parseCsv, runBhavScan, SCORE_SLOTS, TURNOVER_SLOTS, unzipFirst, type BhavScanDeps } from '../src/screener/bhavcopy.js'
import { CORE_SIZE, DAILY_FILE, MAX_STOCKS, ROTATING_SLOTS } from '../src/screener/dailyWatchlist.js'

const HEADER =
	'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4'
type Row = { day?: string | undefined; sym: string; series?: string; isin?: string; name?: string; high: number; low: number; last: number; prev: number; vol: number; sgmt?: string }
const row = (r: Row) =>
	[r.day ?? '2026-11-03', r.day ?? '2026-11-03', r.sgmt ?? 'CM', 'NSE', 'STK', '1', r.isin ?? `INE${r.sym.slice(0, 6).padEnd(6, '0')}01010`, r.sym, r.series ?? 'EQ', '', '', '', '', r.name ?? `${r.sym} LIMITED`, r.prev, r.high, r.low, r.last, r.last, r.prev, '', r.last, '', '', r.vol, (r.last * r.vol).toFixed(2), 100, 'F1', 1, '', '', '', '', ''].join(',')
const REAL = [
	row({ sym: 'RELIANCE', isin: 'INE002A01018', high: 1307.9, low: 1282, last: 1307.9, prev: 1300, vol: 42_319_913 }),
	row({ sym: 'TATASTEEL', isin: 'INE081A01020', high: 179, low: 175.05, last: 176.5, prev: 177.37, vol: 17_823_743 }),
	row({ sym: 'JPL', isin: 'INE0BJO01010', high: 1442, low: 1405, last: 1437.4, prev: 1420.7, vol: 10_314_943 }),
]

/** A one-entry zip (deflate), as NSE serves it; CRC left 0 (unzipFirst doesn't check it). */
const zipOf = (name: string, text: string, method: 0 | 8 = 8): Buffer => {
	const raw = Buffer.from(text, 'utf8')
	const data = method === 8 ? zlib.deflateRawSync(raw) : raw
	const n = Buffer.from(name)
	const local = Buffer.alloc(30)
	local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6) // flag 8: sizes in a data descriptor
	local.writeUInt16LE(method, 8); local.writeUInt16LE(n.length, 26)
	const cd = Buffer.alloc(46)
	cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24)
	cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(0, 42)
	const cdOffset = local.length + n.length + data.length
	const eocd = Buffer.alloc(22)
	eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cd.length + n.length, 12); eocd.writeUInt32LE(cdOffset, 16)
	return Buffer.concat([local, n, data, cd, n, eocd])
}

const core = Array.from({ length: CORE_SIZE }, (_, i) => `NSE:CORE${String(i).padStart(2, '0')}-EQ`)
/** The Fyers symbol list: every symbol except `missing` (a stand-in for fyersUniverse.json). */
const fyersExcept = (...missing: string[]) => ({ file: 'fyersUniverse.json', asOf: '2026-04-28', symbols: { has: (s: string) => !missing.includes(s), size: 2158 } as unknown as Set<string> })
/** A synthetic day: n eligible Main Board names plus the noise the filters must drop. */
const day = (n: number, o: { day?: string | undefined } = {}) => {
	const lines = [HEADER, ...REAL]
	for (let i = 0; i < n; i++) lines.push(row({ day: o.day, sym: `S${String(i).padStart(4, '0')}`, high: 110 + (i % 7), low: 100, last: 105 + (i % 11), prev: 100, vol: 6_000_000 + i * 1000 }))
	for (let i = 0; i < 1000; i++) lines.push(row({ day: o.day, sym: `THIN${i}`, high: 101, low: 99, last: 100, prev: 100, vol: 1000 })) // below ₹50 cr
	lines.push(row({ day: o.day, sym: 'SMEX', series: 'SM', high: 200, low: 100, last: 190, prev: 100, vol: 9e7 })) // SME: out
	lines.push(row({ day: o.day, sym: 'BEX', series: 'BE', high: 200, low: 100, last: 190, prev: 100, vol: 9e7 })) // trade-for-trade: out
	lines.push(row({ day: o.day, sym: 'NIFTYBEES', isin: 'INF204KB14I2', high: 300, low: 200, last: 290, prev: 200, vol: 9e7 })) // ETF: out
	lines.push(row({ day: o.day, sym: 'CHEAP', high: 49, low: 30, last: 45, prev: 30, vol: 9e8 })) // under ₹50: out
	lines.push(row({ day: o.day, sym: 'ANDCO', name: '"A, B AND CO LIMITED"', high: 300, low: 200, last: 290, prev: 200, vol: 9e7 })) // quoted comma
	return lines.join('\n') + '\n'
}

const deps = (zip: Buffer | null | Error, o: Partial<BhavScanDeps> = {}) => {
	const writes = new Map<string, string | Buffer>()
	const d: BhavScanDeps = {
		asOf: '2026-11-03',
		forSession: '2026-11-04',
		nowMs: Date.parse('2026-11-03T13:30:00Z'),
		core,
		fyers: fyersExcept(),
		fetchZip: async () => {
			if (zip instanceof Error) throw zip
			return zip
		},
		writeFile: (name, content) => writes.set(name, content),
		log: { log: () => {}, warn: () => {} },
		...o,
	}
	return { d, writes }
}

test('archive URL: the UDiFF common bhavcopy for the day', () => {
	assert.equal(bhavcopyUrl('2026-11-03'), 'https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20261103_F_0000.csv.zip')
})

test('unzip: deflate and stored entries; garbage is rejected', () => {
	for (const m of [0, 8] as const) {
		const z = unzipFirst(zipOf('BhavCopy_NSE_CM_0_0_0_20261103_F_0000.csv', 'a,b\n1,2\n', m))
		assert.equal(z.name, 'BhavCopy_NSE_CM_0_0_0_20261103_F_0000.csv')
		assert.equal(z.data.toString(), 'a,b\n1,2\n')
	}
	assert.throws(() => unzipFirst(Buffer.from('<html>blocked</html>')), /not a zip/)
	assert.throws(() => unzipFirst(Buffer.alloc(0)), /not a zip/)
})

test('CSV: quoted commas, doubled quotes, CRLF, no trailing newline', () => {
	assert.deepEqual(parseCsv('a,"b, c","d ""e"""\r\n1,2,3'), [['a', 'b, c', 'd "e"'], ['1', '2', '3']])
})

test('Main Board EQ only (Sgmt CM, series EQ, INE ISIN), in the dw-2 quote shape; real 3 Nov rows', () => {
	const b = parseBhavcopy(day(5))
	assert.equal(b.mainBoard.has('NSE:SMEX-EQ'), false, 'SME series SM is out')
	assert.equal(b.mainBoard.has('NSE:BEX-EQ'), false, 'BE is out')
	assert.equal(b.mainBoard.has('NSE:NIFTYBEES-EQ'), false, 'ETFs (INF ISIN) are out')
	assert.equal(b.mainBoard.has('NSE:ANDCO-EQ'), true, 'a quoted comma in the name does not shift columns')
	assert.deepEqual(b.mainBoard.get('NSE:RELIANCE-EQ'), { lp: 1307.9, prevClose: 1300, high: 1307.9, low: 1282, volume: 42_319_913, tt: Date.parse('2026-11-03T00:00:00Z') / 1000 })
	assert.deepEqual([...b.tradeDates], ['2026-11-03'])
	assert.throws(() => parseBhavcopy('TradDt,TckrSymb\n2026-11-03,X\n'), /columns missing: Sgmt/)
})

test('a good day: core 52 + top 27 = 79 stocks + Nifty = 80; the zip is kept; nothing from Fyers', async () => {
	const { d, writes } = deps(zipOf('f.csv', day(120)))
	const r = await runBhavScan(d)
	assert.equal(r.kind, 'written')
	const f = JSON.parse(writes.get(DAILY_FILE) as string)
	assert.equal(CORE_SIZE, 52); assert.equal(ROTATING_SLOTS, 27); assert.equal(MAX_STOCKS, 79)
	assert.equal(f.symbols.length, 79)
	assert.deepEqual(f.symbols.slice(0, 52), core)
	assert.deepEqual(f.fyersCheck, { file: 'fyersUniverse.json', asOf: '2026-04-28', symbols: 2158, dropped: [] })
	assert.equal(f.rulesVersion, 'dw-3'); assert.equal(f.requests, 0); assert.match(f.source, /^nse-bhavcopy f\.csv$/)
	assert.equal(f.asOf, '2026-11-03'); assert.equal(f.forSession, '2026-11-04')
	assert.equal(writes.get('watchlist_daily_history/2026-11-04.json'), writes.get(DAILY_FILE))
	assert.ok(Buffer.isBuffer(writes.get('bhavcopy/2026-11-03.csv.zip')))
	const rot = f.symbols.slice(52) as string[]
	for (const out of ['NSE:SMEX-EQ', 'NSE:BEX-EQ', 'NSE:NIFTYBEES-EQ', 'NSE:CHEAP-EQ']) assert.ok(!rot.includes(out), out)
	assert.ok(!rot.some((s) => s.startsWith('NSE:THIN')), 'below ₹50 crore turnover never ranks')
	assert.equal(new Set(f.symbols).size, 79)
})

test('not published yet / network error → not-yet (retried); nothing written', async () => {
	for (const z of [null, new Error('ETIMEDOUT')]) {
		const { d, writes } = deps(z)
		const r = await runBhavScan(d)
		assert.equal(r.kind, 'not-yet')
		assert.equal(writes.size, 0)
	}
})

test('a 200 that is not a zip (block page, cut-off body) is transient: retried, nothing written', async () => {
	const { d, writes } = deps(Buffer.from('<html>Access Denied</html>'))
	const r = await runBhavScan(d)
	assert.equal(r.kind, 'not-yet')
	assert.match((r as { reason: string }).reason, /not a zip/)
	assert.equal(writes.size, 0)
})

test('on success the live file is written before the history copy (the "already written" mark)', async () => {
	const order: string[] = []
	const { d } = deps(zipOf('f.csv', day(120)), { writeFile: (name) => void order.push(name) })
	await runBhavScan(d)
	assert.deepEqual(order, ['bhavcopy/2026-11-03.csv.zip', DAILY_FILE, 'watchlist_daily_history/2026-11-04.json'])
})

test('engine side: a daily list that does not fit the subscription cap falls back to the static list', async () => {
	const fs = await import('node:fs')
	const os = await import('node:os')
	const path = await import('node:path')
	const { resolveWatchlist } = await import('../src/screener/paths.js')
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw3-'))
	const sym = (i: number) => `NSE:S${String(i).padStart(4, '0')}-EQ`
	fs.writeFileSync(path.join(dir, 'watchlist.json'), JSON.stringify(Array.from({ length: 52 }, (_, i) => sym(i))))
	fs.writeFileSync(path.join(dir, DAILY_FILE), JSON.stringify({ rulesVersion: 'dw-3', asOf: '2026-11-03', forSession: '2026-11-04', generatedAt: 'x', requests: 0, symbols: Array.from({ length: 79 }, (_, i) => sym(i + 100)), entries: [] }))
	const prev = { d: process.env.SCREENER_DATA_DIR, e: process.env.SCREENER_ENABLED }
	process.env.SCREENER_DATA_DIR = dir
	process.env.SCREENER_ENABLED = 'true'
	try {
		const at = Date.parse('2026-11-04T03:30:00Z')
		assert.equal(resolveWatchlist(at).source, 'daily', '79 + Nifty fits 100')
		fs.writeFileSync(path.join(dir, 'anomaly_universe.json'), JSON.stringify(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [sym(i + 500), {}]))))
		const c = resolveWatchlist(at)
		assert.equal(c.source, 'static')
		assert.equal(c.fellBack, true)
		assert.match(c.reason, /doesn't fit the subscription cap \(room 69\)/)
	} finally {
		if (prev.d === undefined) delete process.env.SCREENER_DATA_DIR
		else process.env.SCREENER_DATA_DIR = prev.d
		if (prev.e === undefined) delete process.env.SCREENER_ENABLED
		else process.env.SCREENER_ENABLED = prev.e
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

test('bad files fail (alerted, not retried) and write no list', async () => {
	const cases: [string, Buffer, RegExp][] = [
		["yesterday's file", zipOf('f.csv', day(120, { day: '2026-11-02' })), /trade date .*2026-11-02.* ≠ as-of 2026-11-03/],
		['too few rows', zipOf('f.csv', [HEADER, ...REAL].join('\n')), /only 3 Main Board EQ rows/],
		// 55, not 56: the fixture's ANDCO (+45%) is excluded by the dw-3 amendment 2 move cap
		['too few eligible', zipOf('f.csv', day(0)), /validation: .*55 stocks, need 60/],
		['duplicate symbol', zipOf('f.csv', day(120) + REAL[0] + '\n'), /duplicate symbol/],
	]
	for (const [name, zip, re] of cases) {
		const { d, writes } = deps(zip)
		const r = await runBhavScan(d)
		assert.equal(r.kind, 'failed', name)
		assert.match((r as { reason: string }).reason, re, name)
		assert.equal(writes.size, 0, `${name}: nothing written (list or zip)`)
	}
})

test('Fyers check (amendment 1/1a/1b): a rotating name not in fyersUniverse.json is skipped and the next one refills the slot', async () => {
	const { d: d0, writes: w0 } = deps(zipOf('f.csv', day(120)))
	await runBhavScan(d0)
	const first = JSON.parse(w0.get(DAILY_FILE) as string) as { symbols: string[] }
	const firstRot = first.symbols[52]!
	const { d, writes } = deps(zipOf('f.csv', day(120)), { fyers: fyersExcept(firstRot) })
	const r = await runBhavScan(d)
	assert.equal(r.kind, 'written')
	const f = JSON.parse(writes.get(DAILY_FILE) as string)
	assert.deepEqual(f.fyersCheck.dropped, [firstRot])
	assert.equal(f.symbols.length, 79, 'refilled to 27 rotating: 79 stocks + Nifty = 80')
	assert.ok(!f.symbols.includes(firstRot))
	assert.equal(new Set(f.symbols).size, 79)
})

test('amendment 1b: 22 rotating by score + 5 by turnover (highest turnover not already in), tagged', async () => {
	const { d, writes } = deps(zipOf('f.csv', day(120)))
	await runBhavScan(d)
	const f = JSON.parse(writes.get(DAILY_FILE) as string)
	const rot = f.entries.filter((e: { group: string }) => e.group === 'rotating') as { symbol: string; pick: string; rank: number; turnover: number }[]
	assert.equal(SCORE_SLOTS, 22); assert.equal(TURNOVER_SLOTS, 5)
	const byScore = rot.filter((e) => e.pick === 'score')
	const byTurnover = rot.filter((e) => e.pick === 'turnover')
	assert.equal(byScore.length, 22); assert.equal(byTurnover.length, 5); assert.equal(rot.length, 27)
	assert.deepEqual(byScore.map((e) => e.rank), Array.from({ length: 22 }, (_, i) => i + 1), 'score group = the top 22 by score')
	// every turnover pick out-trades every eligible name left out
	const b = parseBhavcopy(day(120))
	const inList = new Set(f.symbols as string[])
	// eligible = the floors AND (amendment 2) |move| ≤ 40% — the fixture's ANDCO (+45%) is excluded, not "left out"
	const left = [...b.mainBoard].filter(([s, q]) => !inList.has(s) && q.lp >= 50 && q.lp * q.volume >= 50e7 && q.high > q.low && Math.abs(q.lp - q.prevClose) / q.prevClose <= 0.4).map(([, q]) => q.lp * q.volume)
	const minPick = Math.min(...byTurnover.map((e) => e.turnover))
	assert.ok(left.every((t) => t <= minPick), 'turnover picks are the highest-turnover eligible names not already in')
	for (let i = 1; i < byTurnover.length; i++) assert.ok(byTurnover[i - 1]!.turnover >= byTurnover[i]!.turnover, 'turnover order')
	assert.deepEqual(f.symbols.slice(52), rot.map((e) => e.symbol))
})

test('M&M: NSE TckrSymb "M&M" maps to Fyers NSE:M&M-EQ, passes the check and can be picked', async () => {
	const mm = row({ sym: 'M&M', isin: 'INE101A01026', high: 2930, low: 2850, last: 2908, prev: 2880, vol: 3_056_541 })
	const csv = `${day(120)}${mm}\n`
	const b = parseBhavcopy(csv)
	assert.ok(b.mainBoard.has('NSE:M&M-EQ'))
	const { d, writes } = deps(zipOf('f.csv', csv), { fyers: fyersExcept('NSE:NOTHING-EQ') })
	await runBhavScan(d)
	const f = JSON.parse(writes.get(DAILY_FILE) as string)
	assert.ok(f.symbols.includes('NSE:M&M-EQ'), 'M&M (₹889 cr) is among the 5 highest-turnover names not already in')
	assert.equal(f.entries.find((e: { symbol: string }) => e.symbol === 'NSE:M&M-EQ').pick, 'turnover')
	const real = JSON.parse((await import('node:fs')).readFileSync('fyersUniverse.json', 'utf8')) as string[]
	assert.ok(real.includes('NSE:M&M-EQ'), 'the real fyersUniverse.json has NSE:M&M-EQ')
})

test('Fyers check (amendment 1a): a core name missing from fyersUniverse.json stays in the list (e.g. JPL)', async () => {
	const jplCore = [...core.slice(0, 51), 'NSE:JPL-EQ']
	const { d, writes } = deps(zipOf('f.csv', day(120)), { core: jplCore, fyers: fyersExcept('NSE:JPL-EQ', core[3]!) })
	const r = await runBhavScan(d)
	assert.equal(r.kind, 'written')
	const f = JSON.parse(writes.get(DAILY_FILE) as string)
	assert.deepEqual(f.symbols.slice(0, 52), jplCore, 'all 52 core names kept, JPL included')
	assert.deepEqual(f.fyersCheck.dropped, [], 'core names are never dropped')
	assert.equal(f.symbols.length, 79)
})

test('Fyers check: a list that falls below 60 after the drops is rejected (static fallback), nothing written', async () => {
	const { d: d0, writes: w0 } = deps(zipOf('f.csv', day(120)))
	await runBhavScan(d0)
	const rot = (JSON.parse(w0.get(DAILY_FILE) as string).symbols as string[]).slice(52)
	// drop every rotating name the ranking can reach: 52 core alone < 60
	const { d, writes } = deps(zipOf('f.csv', day(120)), { fyers: fyersExcept(...rot, ...Array.from({ length: 200 }, (_, i) => `NSE:S${String(i).padStart(4, '0')}-EQ`), 'NSE:ANDCO-EQ', 'NSE:RELIANCE-EQ', 'NSE:TATASTEEL-EQ', 'NSE:JPL-EQ') })
	const r = await runBhavScan(d)
	assert.equal(r.kind, 'failed')
	assert.match((r as { reason: string }).reason, /52 stocks, need 60.*Fyers check dropped [0-9]+/)
	assert.equal(writes.size, 0)
})

test('dw-3 amendment 2: a rotating candidate with |source-day move| > 40% is excluded (score and turnover picks), recorded in moveCap; exactly 40% stays; the core is exempt', async () => {
	const { MAX_ABS_MOVE, overMoveCap } = await import('../src/screener/bhavcopy.js')
	assert.equal(MAX_ABS_MOVE, 0.4)
	// ANDCO (fixture): 200 → 290 = +45%, turnover ₹2,610 cr, the largest — without the cap it would be a turnover pick
	const big = row({ sym: 'BIGMOVE', high: 290, low: 140, last: 141, prev: 300, vol: 9e7 }) // −53%
	const edge = row({ sym: 'EDGE40', high: 145, low: 99, last: 140, prev: 100, vol: 9e7 }) // +40.0% exactly: stays
	const csv = `${day(120)}${big}
${edge}
`
	const { d, writes } = deps(zipOf('f.csv', csv))
	const r = await runBhavScan(d)
	assert.equal(r.kind, 'written')
	const f = JSON.parse(writes.get(DAILY_FILE) as string)
	assert.equal(f.moveCap.max, 0.4)
	assert.deepEqual(f.moveCap.excluded.map((e: { symbol: string }) => e.symbol), ['NSE:BIGMOVE-EQ', 'NSE:ANDCO-EQ'], 'largest move first')
	assert.equal(f.moveCap.excluded[1].move, 0.45)
	assert.ok(!f.symbols.includes('NSE:ANDCO-EQ') && !f.symbols.includes('NSE:BIGMOVE-EQ'), 'excluded from every pick')
	assert.ok(f.symbols.includes('NSE:EDGE40-EQ'), 'exactly 40% is not over the cap (high turnover: a turnover pick)')
	assert.equal(f.symbols.length, 79, 'the walk refills to 27 rotating')
	// the core is never excluded, whatever its move
	const b = parseBhavcopy(`${csv}`)
	assert.deepEqual(overMoveCap(b.mainBoard, ['NSE:ANDCO-EQ'], '2026-11-03').map((e) => e.symbol), ['NSE:BIGMOVE-EQ'])
})

test('dw-3 amendment 2: the cap compares in whole paise — exact ±40% stays even where floating point lands above 0.4', async () => {
	const { overCap } = await import('../src/screener/bhavcopy.js')
	assert.ok((70.42 - 50.3) / 50.3 > 0.4, 'the floating-point trap the review found: exactly +40% computes above 0.4')
	assert.equal(overCap(70.42, 50.3), false, '₹50.30 → ₹70.42 is exactly +40%: stays')
	assert.equal(overCap(60.21, 100.35), false, '₹100.35 → ₹60.21 is exactly −40%: stays')
	assert.equal(overCap(140, 100), false)
	assert.equal(overCap(70.43, 50.3), true, 'one paisa over +40%')
	assert.equal(overCap(60.2, 100.35), true, 'one paisa over −40%')
	assert.equal(overCap(140.01, 100), true)
	// through the scan: both exact-boundary names stay eligible (high turnover, so they're picked)
	const a = row({ sym: 'EXACTUP', high: 71, low: 50.3, last: 70.42, prev: 50.3, vol: 9e8 })
	const b = row({ sym: 'EXACTDN', high: 100.35, low: 60, last: 60.21, prev: 100.35, vol: 9e8 }) // above the ₹50 floor
	const { d, writes } = deps(zipOf('f.csv', `${day(120)}${a}\n${b}\n`))
	assert.equal((await runBhavScan(d)).kind, 'written')
	const f = JSON.parse(writes.get(DAILY_FILE) as string)
	assert.ok(f.symbols.includes('NSE:EXACTUP-EQ') && f.symbols.includes('NSE:EXACTDN-EQ'))
	assert.ok(!f.moveCap.excluded.some((e: { symbol: string }) => /EXACT/.test(e.symbol)))
})

test('dw-3 amendment 2: the core is exempt through the scan; signed moves recorded; capped names are not Fyers drops; null switches the cap off', async () => {
	const bigCore = row({ sym: 'CORE05', high: 170, low: 99, last: 165, prev: 100, vol: 9e7 }) // core, +65%
	const csv = `${day(120)}${bigCore}\n`
	const { d, writes } = deps(zipOf('f.csv', csv))
	assert.equal((await runBhavScan(d)).kind, 'written')
	const f = JSON.parse(writes.get(DAILY_FILE) as string)
	assert.ok(f.symbols.includes('NSE:CORE05-EQ'), 'a core name over 40% stays in the list')
	assert.equal(f.entries.find((e: { symbol: string }) => e.symbol === 'NSE:CORE05-EQ').group, 'core')
	assert.ok(!f.moveCap.excluded.some((e: { symbol: string }) => e.symbol === 'NSE:CORE05-EQ'), 'and is not recorded as excluded')
	assert.deepEqual(f.moveCap.excluded, [{ symbol: 'NSE:ANDCO-EQ', move: 0.45 }], 'signed move')
	assert.ok(!f.fyersCheck.dropped.includes('NSE:ANDCO-EQ'), 'a capped name is not also a Fyers drop')
	// no exclusions: a wider cap records an empty list
	const { d: d2, writes: w2 } = deps(zipOf('f.csv', csv), { moveCap: 0.5 })
	await runBhavScan(d2)
	assert.deepEqual(JSON.parse(w2.get(DAILY_FILE) as string).moveCap, { max: 0.5, excluded: [] })
	// switched off (the backtest's frozen lists): no moveCap field, and ANDCO is back in the ranking pool
	const { d: d3, writes: w3 } = deps(zipOf('f.csv', csv), { moveCap: null })
	await runBhavScan(d3)
	const f3 = JSON.parse(w3.get(DAILY_FILE) as string)
	assert.equal(f3.moveCap, undefined)
	assert.ok(f3.symbols.includes('NSE:ANDCO-EQ'), 'without the cap the +45% name is picked (it has the top turnover)')
	assert.ok(!f.symbols.includes('NSE:ANDCO-EQ'), 'with the cap it is not')
})

test('dw-3 amendment 2: the failure text shows the move-cap step in the funnel', async () => {
	const { d } = deps(zipOf('f.csv', day(0)))
	const r = await runBhavScan(d)
	assert.equal(r.kind, 'failed')
	assert.match((r as { reason: string }).reason, /→ eligible \d+ → move cap −1 → \d+/)
})
