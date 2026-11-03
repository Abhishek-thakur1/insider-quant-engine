// ============================================================
// scripts/daily_watchlist.ts — the evening daily-watchlist scan (rules dw-2)
//
// docs/studies/daily-watchlist/PREREGISTRATION_dw2.md. One scan: the public NSE_CM master
// (1 download) + batched quotes (≤ 50 symbols each, ≤ 48 batches + ≤ 6 retries, every attempt counted; 55 in all),
// through the shared quota gate and Redis ledger. No other Fyers call.
// Writes <SCREENER_DATA_DIR or /app/data>/watchlist_daily.json (+ watchlist_daily_history/<session>.json
// and the raw quote responses in raw_quotes/<session>.jsonl);
// never touches the static watchlist.json. On any failure the previous list stays
// and the owner gets a Telegram alert.
// Exit: 0 = written; 2 = not written (alerted); 3 = refused (session hours / no token); 1 = crash.
// Run (host, outside 09:00–15:30): docker compose run --rm --no-deps --entrypoint "" quant_engine
//   node --import tsx scripts/daily_watchlist.ts
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import fyers from 'fyers-api-v3'
import { ENV } from '../src/config/env.js'
import { lastCompletedSession, loadHolidays, tradingDayVerdict } from '../src/core/sessionGuard.js'
import { getISTDateString } from '../src/utils/marketHours.js'
import { notifyAdmin } from '../src/utils/adminNotify.js'
import { CM_URL, parseCashUniverse } from '../src/screener/masters.js'
import { screenerDataDir } from '../src/screener/paths.js'
import { bootRedis, redisClient } from '../src/config/redis.js'
import { createQuotaGate, loadQuotaConfig, RedisLedger } from '../src/fyers/quota.js'
import { atomicWriter, budgeted, inSessionWindow, runDailyScan } from '../src/screener/dailyWatchlist.js'

const TOKEN_PATH = path.resolve('/app/token', 'access_token.txt')

const nextTradingDay = (day: string, holidays: Set<string>): string => {
	let t = Date.parse(`${day}T00:00:00Z`)
	for (let i = 0; i < 15; i++) {
		t += 86_400_000
		const d = new Date(t).toISOString().slice(0, 10)
		if (tradingDayVerdict(d, holidays).trading) return d
	}
	throw new Error(`no trading day within 15 days after ${day}`)
}

const main = async (): Promise<number> => {
	const now = Date.now()
	const holidays = loadHolidays() ?? new Set<string>()
	const todayIst = getISTDateString(now)
	if (inSessionWindow(now, tradingDayVerdict(todayIst, holidays).trading)) {
		console.error('[DailyWatchlist] ⛔ refusing to scan between 09:00 and 15:30 IST on a trading day')
		return 3
	}
	const asOf = lastCompletedSession(now, holidays)
	const forSession = nextTradingDay(asOf, holidays)
	const dataDir = screenerDataDir()
	console.log(`[DailyWatchlist] 🔍 rules dw-2 · as of ${asOf} → for ${forSession} · ${dataDir}`)
	if (!fs.existsSync(TOKEN_PATH)) {
		await notifyAdmin(`⚠️ Daily watchlist for ${forSession} NOT updated (no Fyers token); the previous list is kept.`)
		return 3
	}
	const core: string[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'config', 'daily_watchlist_core.json'), 'utf8'))

	const api = new fyers.fyersModel({ path: './', enableLogging: false })
	api.setAppId(ENV.FYERS_APP_ID)
	api.setAccessToken(fs.readFileSync(TOKEN_PATH, 'utf8').trim())
	await bootRedis()
	const gate = createQuotaGate({ job: 'screener', config: loadQuotaConfig(), ledger: new RedisLedger(redisClient) })
	const raw = budgeted((batch) => api.getQuotes(batch))
	const getQuotes = (batch: string[]) =>
		gate.call(async () => {
			const r = (await raw.call(batch)) as { s?: string }
			if (r?.s !== 'ok') throw r // the gate classifies Fyers error bodies
			return r
		})

	const result = await runDailyScan({
		asOf,
		forSession,
		nowMs: now,
		core,
		downloadMaster: async () => parseCashUniverse((await axios.get<string>(CM_URL, { responseType: 'text', timeout: 60_000 })).data),
		getQuotes,
		quoteRequestsUsed: raw.used,
		limitQuoteRequests: raw.limit,
		writeFile: atomicWriter(dataDir),
		saveRaw: (line) => {
			fs.mkdirSync(path.join(dataDir, 'raw_quotes'), { recursive: true })
			fs.appendFileSync(path.join(dataDir, 'raw_quotes', `${forSession}.jsonl`), line + '\n')
		},
		notify: notifyAdmin,
	})
	const used = (await new RedisLedger(redisClient).state(getISTDateString())).used
	console.log(`[DailyWatchlist] quote requests this scan: ${raw.used()} (+1 master) · ledger today: ${JSON.stringify(used)}`)
	await redisClient.quit().catch(() => {})
	return result.ok ? 0 : 2
}

main()
	.then((code) => process.exit(code))
	.catch(async (err) => {
		console.error('[DailyWatchlist] ❌ crashed:', err)
		await notifyAdmin(`❌ Daily watchlist scan crashed: ${(err as Error)?.message ?? err}. The previous list is kept.`)
		process.exit(1)
	})
