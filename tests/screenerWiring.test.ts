// ============================================================
// tests/screenerWiring.test.ts — how the engine and scheduler use the screener
//
// Real src/screener/paths.ts and src/core/symbolSource.ts against temp dirs, plus
// source checks of docker-compose.yml / crontab / lifecycle.sh for the contract:
// no screening at boot, job at 16:30, token purge at 17:15.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readMetaSources, resolveScreenerFile, screenerStaleness, tradingDaysBetween } from '../src/screener/paths.js'
import { clearSymbolSources, dailyListSources, getSymbolSource, registerDailySources, registerWatchlistSources } from '../src/core/symbolSource.js'

const withDataDir = <T>(fn: (dir: string) => T): T => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-wiring-'))
	const prev = process.env.SCREENER_DATA_DIR
	process.env.SCREENER_DATA_DIR = dir
	try {
		return fn(dir)
	} finally {
		if (prev === undefined) delete process.env.SCREENER_DATA_DIR
		else process.env.SCREENER_DATA_DIR = prev
	}
}
const istNoon = (day: string) => Date.parse(`${day}T06:30:00Z`)
const meta = (asOf: string, entries: { symbol: string; source: string }[] = []) => JSON.stringify({ asOf, entries })

test('engine reads the screener volume when present, else the baked-in file', () => {
	withDataDir((dir) => {
		assert.equal(resolveScreenerFile('watchlist.json'), path.resolve(process.cwd(), 'watchlist.json'))
		fs.writeFileSync(path.join(dir, 'watchlist.json'), '[]')
		assert.equal(resolveScreenerFile('watchlist.json'), path.join(dir, 'watchlist.json'))
		assert.equal(resolveScreenerFile('universe_stats.json'), path.resolve(process.cwd(), 'universe_stats.json'))
	})
})

test('promotion source: per-symbol from watchlist_meta.json; CORE wins; legacy list = SCREENER', () => {
	withDataDir((dir) => {
		fs.writeFileSync(path.join(dir, 'watchlist_meta.json'), meta('2026-10-19', [
			{ symbol: 'NSE:RELIANCE-EQ', source: 'CORE' },
			{ symbol: 'NSE:LEAD-EQ', source: 'SCREENER_LEADER' },
			{ symbol: 'NSE:SETUP-EQ', source: 'SCREENER_SETUP' },
		]))
		clearSymbolSources()
		registerWatchlistSources(['NSE:RELIANCE-EQ', 'NSE:LEAD-EQ', 'NSE:SETUP-EQ', 'NSE:OLD-EQ'], ['NSE:RELIANCE-EQ'], readMetaSources())
		assert.equal(getSymbolSource('NSE:RELIANCE-EQ'), 'CORE')
		assert.equal(getSymbolSource('NSE:LEAD-EQ'), 'SCREENER_LEADER')
		assert.equal(getSymbolSource('NSE:SETUP-EQ'), 'SCREENER_SETUP')
		assert.equal(getSymbolSource('NSE:OLD-EQ'), 'SCREENER')
		clearSymbolSources()
	})
})

test('daily list sources: core group CORE, rotating DAILY_SCORE / DAILY_TURNOVER by pick; legacy → SCREENER', () => {
	const entries = [
		{ symbol: 'NSE:RELIANCE-EQ', group: 'core' as const },
		{ symbol: 'NSE:JPL-EQ', group: 'core' as const },
		{ symbol: 'NSE:FUSION-EQ', group: 'rotating' as const, pick: 'score' as const },
		{ symbol: 'NSE:M&M-EQ', group: 'rotating' as const, pick: 'turnover' as const },
		{ symbol: 'NSE:OLDPICK-EQ', group: 'rotating' as const }, // dw-3 before 1b: no pick → score
	]
	const watchlist = [...entries.map((e) => e.symbol), 'NSE:NOTINENTRIES-EQ']
	clearSymbolSources()
	// what websocket.ts calls on the daily path, schema current
	const counts = registerDailySources(watchlist, entries, null)
	assert.deepEqual(Object.fromEntries(counts), { CORE: 2, DAILY_SCORE: 2, DAILY_TURNOVER: 1, SCREENER: 1 })
	assert.equal(getSymbolSource('NSE:RELIANCE-EQ'), 'CORE')
	assert.equal(getSymbolSource('NSE:JPL-EQ'), 'CORE') // a daily core name, not in core_watchlist.json
	assert.equal(getSymbolSource('NSE:FUSION-EQ'), 'DAILY_SCORE')
	assert.equal(getSymbolSource('NSE:M&M-EQ'), 'DAILY_TURNOVER')
	assert.equal(getSymbolSource('NSE:OLDPICK-EQ'), 'DAILY_SCORE')
	assert.equal(getSymbolSource('NSE:NOTINENTRIES-EQ'), 'SCREENER')
	const legacy = dailyListSources(entries, { legacy: true })
	assert.deepEqual([...new Set(legacy.values())].sort(), ['CORE', 'SCREENER'])
	// schema not current (e.g. 0008 pending) → no DAILY_* value can reach an insert
	clearSymbolSources()
	const degraded = registerDailySources(watchlist, entries, '1 pending migration(s): 0008_daily_list_sources')
	assert.deepEqual(Object.fromEntries(degraded), { CORE: 2, SCREENER: 4 })
	assert.equal(getSymbolSource('NSE:M&M-EQ'), 'SCREENER')
	assert.equal(getSymbolSource('NSE:JPL-EQ'), 'CORE')
	clearSymbolSources()
})

test('every PromotionSource is allowed by the latest signals CHECK (no insert can fail it)', () => {
	const ts = fs.readFileSync('src/core/symbolSource.ts', 'utf8')
	const union = ts.slice(ts.indexOf('export type PromotionSource'), ts.indexOf('const sources'))
	const values = [...union.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)
	assert.ok(values.includes('DAILY_SCORE') && values.includes('DAILY_TURNOVER'))
	const dir = 'db/migrations'
	const last = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f) && /signals_promotion_source_check/.test(fs.readFileSync(path.join(dir, f), 'utf8'))).sort().at(-1)!
	const sql = fs.readFileSync(path.join(dir, last), 'utf8').replace(/--.*$/gm, '')
	const check = /CHECK \(promotion_source IN \(([^)]*)\)\)/.exec(sql)![1]!
	const allowed = new Set([...check.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!))
	assert.equal(last, '0008_daily_list_sources.sql')
	for (const v of values) assert.ok(allowed.has(v), `${v} not allowed by ${last}`)
})

test('engine: the meta-file age check runs only for the static list; the daily path sets daily sources', () => {
	const ws = fs.readFileSync('src/ingestion/websocket.ts', 'utf8').replace(/\r\n/g, '\n')
	const i = ws.indexOf("if (choice.source === 'daily') {")
	assert.ok(i > 0)
	const elseAt = ws.indexOf('} else {', i)
	const dailyBranch = ws.slice(i, elseAt)
	assert.match(dailyBranch, /registerDailySources\(watchlist, choice\.entries \?\? \[\], schemaIssue\)/)
	assert.doesNotMatch(dailyBranch, /screenerStaleness/)
	assert.equal(ws.match(/screenerStaleness\(/g)?.length, 1)
	assert.ok(ws.indexOf('screenerStaleness(') > elseAt)
	// the schema check that decides `legacy` runs before the sources are registered
	assert.ok(ws.indexOf('const schemaIssue = await schemaProblem') < i)
})

test('chooseWatchlist: the daily choice carries its entries; the static choice has none', async () => {
	const { chooseWatchlist, RULES_VERSION } = await import('../src/screener/dailyWatchlist.js')
	const symbols = Array.from({ length: 60 }, (_, k) => `NSE:S${String(k).padStart(3, '0')}-EQ`)
	const entries = symbols.map((symbol, k) => ({ symbol, group: k < 52 ? 'core' : 'rotating', ...(k >= 52 ? { pick: k < 57 ? 'score' : 'turnover' } : {}) }))
	const files: Record<string, string> = {
		daily: JSON.stringify({ rulesVersion: RULES_VERSION, asOf: '2026-11-04', forSession: '2026-11-05', symbols, entries }),
		static: JSON.stringify(['NSE:RELIANCE-EQ']),
	}
	const read = (p: string) => files[p]!
	const d = chooseWatchlist({ enabled: true, dailyPath: 'daily', staticPath: 'static', today: '2026-11-05', readFile: read })
	assert.equal(d.source, 'daily')
	assert.equal(d.entries?.length, 60)
	assert.equal(d.entries?.filter((e) => e.pick === 'turnover').length, 3)
	const s = chooseWatchlist({ enabled: false, dailyPath: 'daily', staticPath: 'static', today: '2026-11-05', readFile: read })
	assert.equal(s.source, 'static')
	assert.equal(s.entries, undefined)
})

test('staleness message names the static file actually loaded', () => {
	withDataDir((dir) => {
		const used = path.join(dir, 'watchlist.json')
		fs.writeFileSync(used, '[]')
		assert.match(screenerStaleness(istNoon('2026-11-05'), used)!, new RegExp(`using the static list ${used.replace(/[\\.]/g, '\\$&')}; its age can't be checked`))
		// the image's baked-in copy (outside the volume) is named as such, even when it exists
		assert.match(screenerStaleness(istNoon('2026-11-05'), path.resolve(process.cwd(), 'package.json'))!, /using the baked-in watchlist\.json/)
	})
})

test('staleness: > 3 trading days old warns; a weekend or a holiday does not count', () => {
	const holidays = new Set(['2026-11-10'])
	assert.equal(tradingDaysBetween('2026-10-23', '2026-10-26', holidays), 0) // Fri → Mon
	assert.equal(tradingDaysBetween('2026-11-06', '2026-11-12', holidays), 2) // Mon 9, Wed 11 (Tue 10 holiday)
	withDataDir((dir) => {
		assert.match(screenerStaleness(istNoon('2026-10-26'))!, /screener output not found/)
		// The volume's watchlist.json without meta (EC2 since 20 Oct): name that file, not the baked-in one
		fs.writeFileSync(path.join(dir, 'watchlist.json'), '[]')
		const msg = screenerStaleness(istNoon('2026-10-26'))!
		assert.match(msg, /watchlist_meta\.json missing or unreadable .* using .*watchlist\.json; its age can't be checked/)
		// a meta file without asOf (or unparseable) gets the same message: "missing or unreadable" covers both
		fs.writeFileSync(path.join(dir, 'watchlist_meta.json'), '{}')
		assert.match(screenerStaleness(istNoon('2026-10-26'))!, /watchlist_meta\.json missing or unreadable/)
		fs.rmSync(path.join(dir, 'watchlist_meta.json'))
		assert.doesNotMatch(msg, /baked-in/)
		fs.writeFileSync(path.join(dir, 'watchlist_meta.json'), meta('2026-10-23'))
		assert.equal(screenerStaleness(istNoon('2026-10-26')), null)
		assert.equal(screenerStaleness(istNoon('2026-10-29')), null) // Mon, Tue, Wed missed = 3
		assert.match(screenerStaleness(istNoon('2026-10-30'))!, /from 2026-10-23 — 4 trading days old/)
	})
})

const compose = fs.readFileSync('docker-compose.yml', 'utf8').replace(/\r\n/g, '\n')
const live = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
const service = (name: string) => {
	const body = live(compose)
	const start = body.indexOf(`\n  ${name}:\n`)
	assert.ok(start >= 0, `service ${name} not found`)
	const next = body.slice(start + 1).search(/\n {2}[a-z_]+:\n|\nvolumes:\n/)
	return body.slice(start, start + 1 + next)
}

test('compose: the engine no longer screens at boot and mounts the screener volume', () => {
	const engine = service('quant_engine')
	assert.doesNotMatch(engine, /dailyScreener/)
	assert.match(engine, /- screener_data:\/app\/data/)
	assert.match(engine, /src\/ingestion\/websocket\.ts/)
})

test('compose: quant_screener is a profiled job with the right command, token and data volumes', () => {
	const job = service('quant_screener')
	assert.match(job, /profiles: \['jobs'\]/)
	assert.match(job, /command: node --import tsx scripts\/screener_eod\.ts/)
	assert.match(job, /restart: 'no'/)
	assert.match(job, /- token_store:\/app\/token/)
	assert.match(job, /- screener_data:\/app\/data/)
	assert.match(live(compose), /\nvolumes:\n[\s\S]*\n {2}screener_data:\n/)
})

test('scheduler: screener at 16:30 and token purge at 17:15 on weekdays; stop_engine no longer purges', () => {
	const cron = live(fs.readFileSync('scheduler/crontab', 'utf8').replace(/\r\n/g, '\n'))
	assert.match(cron, /^30 16 \* \* 1-5 \/usr\/local\/bin\/lifecycle\.sh run_screener /m)
	assert.match(cron, /^15 17 \* \* 1-5 \/usr\/local\/bin\/lifecycle\.sh purge_token /m)
	const lc = fs.readFileSync('scheduler/lifecycle.sh', 'utf8').replace(/\r\n/g, '\n')
	const stopEngine = lc.slice(lc.indexOf('  stop_engine)'), lc.indexOf('  run_screener)'))
	assert.doesNotMatch(live(stopEngine), /rm -f|quant_token_store/)
	const purge = lc.slice(lc.indexOf('  purge_token)'), lc.indexOf('  *)'))
	assert.match(purge, /rm -f \/app\/token\/access_token\.txt/)
	const run = lc.slice(lc.indexOf('  run_screener)'), lc.indexOf('  purge_token)'))
	assert.match(run, /trading_day\.sh/)
	assert.match(run, /docker start -a quant_screener/)
})

test('masters: cash universe = -EQ with INE ISIN; F&O = underlyings with a FUT contract', async () => {
	const { parseCashUniverse, parseFnoCashSymbols } = await import('../src/screener/masters.js')
	const cm = [
		'101000000016921,20 MICRONS LTD,0,1,0.01,INE144J01027,0915-1530|1815-1915:,2026-10-19,,NSE:20MICRONS-EQ,10,10,16921,20MICRONS,16921,-1.0,XX,101000000016921,None,1,2.0',
		'1010000000999,SOME ETF,0,1,0.01,INF204K01EY0,0915-1530:,2026-10-19,,NSE:SOMEETF-EQ,10,10,999,SOMEETF,999,-1.0,XX,1,None,1,2.0', // INF → excluded
		'1010000000998,SOME BE STOCK,0,1,0.01,INE000A01011,0915-1530:,2026-10-19,,NSE:SOMEBE-BE,10,10,998,SOMEBE,998,-1.0,XX,1,None,1,2.0', // BE → excluded
		'1010000000997,"ACME, LTD",0,1,0.01,INE111B01011,0915-1530:,2026-10-19,,NSE:ACME-EQ,10,10,997,ACME,997,-1.0,XX,1,None,1,2.0', // comma in name
	].join('\n')
	assert.deepEqual(parseCashUniverse(cm), ['NSE:20MICRONS-EQ', 'NSE:ACME-EQ'])
	const fo = [
		'101126102748699,BANKNIFTY 27 Oct 26 FUT,11,30,0.2,,0915-1540|1815-1915:,2026-10-19,1793095800,NSE:BANKNIFTY26OCTFUT,10,11,48699,BANKNIFTY,26009,-1.0,XX,1,None,0,0.0',
		'101126102735054,RELIANCE 27 Oct 26 FUT,11,500,0.1,,0915-1530:,2026-10-19,1793095800,NSE:RELIANCE26OCTFUT,10,11,1,RELIANCE,2885,-1.0,XX,1,None,0,0.0',
		'101126110335054,NIFTY 03 Nov 26 17350 CE,14,65,0.05,,0915-1540:,2026-10-19,1793700600,NSE:NIFTY26N0317350CE,10,11,35054,NIFTY,26000,17350.0,CE,1,None,0,0.0',
	].join('\n')
	assert.deepEqual([...parseFnoCashSymbols(fo)].sort(), ['NSE:BANKNIFTY-EQ', 'NSE:RELIANCE-EQ'])
})

test('Layer B reads the capped anomaly_universe.json, else a legacy universe_stats.json, else nothing', async () => {
	const { resolveAnomalyUniverseFile } = await import('../src/screener/paths.js')
	withDataDir((dir) => {
		const legacy = path.resolve(process.cwd(), 'universe_stats.json')
		const hadLegacy = fs.existsSync(legacy)
		if (!hadLegacy) assert.equal(resolveAnomalyUniverseFile(), null)
		fs.writeFileSync(path.join(dir, 'universe_stats.json'), '{}') // full stats are NOT the scan set
		if (!hadLegacy) assert.equal(resolveAnomalyUniverseFile(), null)
		fs.writeFileSync(path.join(dir, 'anomaly_universe.json'), '{}')
		assert.equal(resolveAnomalyUniverseFile(), path.join(dir, 'anomaly_universe.json'))
	})
	const scanner = fs.readFileSync('src/ingestion/anomalyScanner.ts', 'utf8')
	assert.match(scanner, /resolveAnomalyUniverseFile\(\)/)
	assert.doesNotMatch(scanner, /resolveScreenerFile\('universe_stats\.json'\)/)
})
