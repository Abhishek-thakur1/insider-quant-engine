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
import { clearSymbolSources, getSymbolSource, registerWatchlistSources } from '../src/core/symbolSource.js'

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

test('staleness: > 3 trading days old warns; a weekend or a holiday does not count', () => {
	const holidays = new Set(['2026-11-10'])
	assert.equal(tradingDaysBetween('2026-10-23', '2026-10-26', holidays), 0) // Fri → Mon
	assert.equal(tradingDaysBetween('2026-11-06', '2026-11-12', holidays), 2) // Mon 9, Wed 11 (Tue 10 holiday)
	withDataDir((dir) => {
		assert.match(screenerStaleness(istNoon('2026-10-26'))!, /screener output not found/)
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
