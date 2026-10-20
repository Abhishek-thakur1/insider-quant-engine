// ============================================================
// scripts/screener_eod.ts — end-of-day screener job (quant_screener container)
//
// Started by the scheduler at 16:30 IST on trading days:
//   lifecycle.sh run_screener → docker start -a quant_screener
// Writes into /app/data (named volume shared with quant_engine, which only
// READS watchlist.json at boot — the engine never screens and never calls the
// history API for screening).
//
// As-of date: the last COMPLETED session (today after 15:30 on a trading day,
// else the previous trading day), so a manual run on a holiday or before the open
// screens the last real session. SCREENER_AS_OF=YYYY-MM-DD overrides. The 16:30
// cron run only fires on trading days (lifecycle.sh checks trading_day.sh).
//
// Fyers quota: every Data-API call (quotes + history) goes through the shared
// gate (src/fyers/quota.ts): 4/s and 40/min, the screener's daily allocation in
// the Redis ledger shared with the engine, hard stop on the daily limit,
// cooldown + stop on throttling. A quote pre-filter (50 symbols per request)
// decides which symbols need history at all.
//
// Exit codes: 0 = written; 2 = run not trusted (previous watchlist kept, admin
// told); 4 = stopped by the quota guard (fetched candles kept, next run resumes,
// previous watchlist kept); 3 = no token / setup error; 1 = crash.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import fyers from 'fyers-api-v3'
import { ENV } from '../src/config/env.js'
import { calendarMissingYear, lastCompletedSession, loadHolidays } from '../src/core/sessionGuard.js'
import { getISTDateString } from '../src/utils/marketHours.js'
import { notifyAdmin } from '../src/utils/adminNotify.js'
import { loadConfig } from '../src/screener/config.js'
import { CandleStore } from '../src/screener/candleStore.js'
import { fetchDailyUniverse, type HistoryResponse } from '../src/screener/fetchDaily.js'
import { runScreenerJob } from '../src/screener/job.js'
import { CM_URL, FO_URL, parseCashUniverse, parseFnoCashSymbols } from '../src/screener/masters.js'
import { screenerDataDir } from '../src/screener/paths.js'
import { fetchQuotesBatched } from '../src/screener/quotes.js'
import { bootRedis, redisClient } from '../src/config/redis.js'
import { createQuotaGate, loadQuotaConfig, RedisLedger } from '../src/fyers/quota.js'

const TOKEN_PATH = path.resolve('/app/token', 'access_token.txt')

const download = async (url: string): Promise<string> =>
	(await axios.get<string>(url, { responseType: 'text', timeout: 60_000 })).data

const main = async (): Promise<number> => {
	const holidays = loadHolidays() ?? new Set<string>()
	const now = Date.now()
	const today = process.env.SCREENER_AS_OF || lastCompletedSession(now, holidays)
	if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`bad SCREENER_AS_OF "${today}" (want YYYY-MM-DD)`)
	if (calendarMissingYear(holidays, getISTDateString(now))) {
		await notifyAdmin(`⚠️ Screener: NSE holiday calendar has no ${getISTDateString(now).slice(0, 4)} entries — as-of date may be wrong`)
	}
	const { config, hash } = loadConfig()
	const dataDir = screenerDataDir()
	console.log(`[Screener] 🔍 EOD screen as of ${today} (last completed session; now ${getISTDateString(now)}) · config ${hash} → ${dataDir}`)

	if (!fs.existsSync(TOKEN_PATH)) {
		const msg = `⚠️ Screener ${today}: no Fyers token at ${TOKEN_PATH} — previous watchlist kept.`
		console.error(`[Screener] ${msg}`)
		await notifyAdmin(msg)
		return 3
	}

	// Universe: today's Fyers master; fall back to the image's fyersUniverse.json.
	let universe: string[]
	try {
		universe = parseCashUniverse(await download(CM_URL))
		if (universe.length < 1000) throw new Error(`only ${universe.length} symbols parsed`)
	} catch (err) {
		console.warn('[Screener] ⚠️ NSE_CM master unavailable, using fyersUniverse.json:', (err as Error).message)
		universe = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'fyersUniverse.json'), 'utf8'))
	}
	let fno = new Set<string>()
	try {
		fno = parseFnoCashSymbols(await download(FO_URL))
	} catch (err) {
		console.warn('[Screener] ⚠️ NSE_FO master unavailable — fno flags will all be false:', (err as Error).message)
	}
	const core: string[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'core_watchlist.json'), 'utf8'))

	const api = new fyers.fyersModel({ path: './', enableLogging: false })
	api.setAppId(ENV.FYERS_APP_ID)
	api.setAccessToken(fs.readFileSync(TOKEN_PATH, 'utf8').trim())
	const getHistory = (symbol: string, from: string, to: string): Promise<HistoryResponse> =>
		api.getHistory({ symbol, resolution: 'D', date_format: '1', range_from: from, range_to: to, cont_flag: '1' })

	// One gate for the whole run (quotes and history share Fyers' Data-API quota).
	await bootRedis()
	const gate = createQuotaGate({ job: 'screener', config: loadQuotaConfig(), ledger: new RedisLedger(redisClient) })
	const getQuotes = (batch: string[]) => api.getQuotes(batch)

	const store = new CandleStore(path.join(dataDir, 'candles', 'D'))
	const started = Date.now()
	const result = await runScreenerJob({
		dataDir,
		store,
		universe,
		core,
		fno,
		config,
		configHash: hash,
		todayIst: today,
		fetchQuotes: (symbols) => fetchQuotesBatched(symbols, { getQuotes, gate, log: console }),
		fetchAll: (symbols) => fetchDailyUniverse(symbols, { getHistory, store, todayIst: today, gate }),
		notifyAdmin,
	})
	const secs = Math.round((Date.now() - started) / 1000)
	const used = (await new RedisLedger(redisClient).state(getISTDateString())).used
	console.log(`[Screener] Fyers Data-API requests today (ledger): ${JSON.stringify(used)}`)
	await redisClient.quit().catch(() => {})
	if (result.status === 'KEPT_PREVIOUS') return 2
	if (result.status === 'INCOMPLETE') return 4
	console.log(`[Screener] ✅ ${result.result.watchlist.length} symbols written in ${secs}s.`)
	return 0
}

main()
	.then((code) => process.exit(code))
	.catch(async (err) => {
		console.error('[Screener] ❌ crashed:', err)
		await notifyAdmin(`❌ Screener crashed: ${(err as Error)?.message ?? err}. Previous watchlist kept.`)
		process.exit(1)
	})
