// ============================================================
// scripts/daily_watchlist_bhav.ts — the evening daily watchlist from the NSE bhavcopy (rules dw-3)
//
// docs/studies/daily-watchlist/PREREGISTRATION_dw3.md. Run by the scheduler (lifecycle.sh run_watchlist →
// docker start -a quant_watchlist) at 19:00, 19:30, … 22:00 IST on trading days. One attempt per run:
// download today's bhavcopy from NSE's archive, rank (dw-2 rules), validate, write
// <SCREENER_DATA_DIR or /app/data>/watchlist_daily.json for the next trading day. No Fyers call.
// - Already written for that session → nothing to do (exit 0).
// - Not published yet / network error → exit 5, retried at the next half hour; alerted after 22:00.
// - Bad file or validation failure → exit 2, alerted at once; a marker skips the rest of the evening.
// On any failure nothing is written: the engine boots from the static watchlist.json and says so.
// BHAVCOPY_FILE=<path> reads a local zip instead of downloading (dry run / the first list).
// Exit: 0 written or nothing to do; 5 not yet (retry); 2 failed (alerted); 3 refused (before 15:30); 1 crash.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import { loadHolidays, tradingDayVerdict } from '../src/core/sessionGuard.js'
import { getISTDateString, getISTMinutes } from '../src/utils/marketHours.js'
import { notifyAdmin } from '../src/utils/adminNotify.js'
import { screenerDataDir } from '../src/screener/paths.js'
import { atomicWriter, DAILY_FILE, HISTORY_DIR, RULES_VERSION } from '../src/screener/dailyWatchlist.js'
import { bhavcopyUrl, runBhavScan } from '../src/screener/bhavcopy.js'

const FINAL_MIN = 22 * 60 // the 22:00 run is the last of the evening
// fyersUniverse.json carries no date of its own; this is when it last changed in git (ac7e962). Update with the file.
const FYERS_UNIVERSE_AS_OF = '2026-04-28'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

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
	const holidays = loadHolidays()
	if (!holidays) {
		// Alert once per evening: the 19:00 run (or a manual run); the later half-hourly runs only log.
		console.error('[DailyWatchlist] ❌ holiday file unreadable')
		if (getISTMinutes(now) < 19 * 60 + 30) await notifyAdmin('⚠️ Daily watchlist NOT updated (holiday file unreadable); the static list will be used.')
		return 2
	}
	const asOf = getISTDateString(now)
	if (!tradingDayVerdict(asOf, holidays).trading) {
		console.log(`[DailyWatchlist] ${asOf} is not a trading day — nothing to do`)
		return 0
	}
	if (getISTMinutes(now) < 15 * 60 + 30) {
		console.error('[DailyWatchlist] ⛔ refusing to run before 15:30 IST on a trading day (the day’s file comes after the close)')
		return 3
	}
	const forSession = nextTradingDay(asOf, holidays)
	const dataDir = screenerDataDir()
	const final = getISTMinutes(now) >= FINAL_MIN || process.env.WATCHLIST_FINAL === 'true'
	const local = process.env.BHAVCOPY_FILE
	console.log(`[DailyWatchlist] 🔍 rules ${RULES_VERSION} · NSE bhavcopy ${local ? `(local ${local})` : ''} · as of ${asOf} → for ${forSession} · ${dataDir}${final ? ' · final run' : ''}`)

	const done = path.join(dataDir, HISTORY_DIR, `${forSession}.json`)
	const live = path.join(dataDir, DAILY_FILE)
	try {
		const h = JSON.parse(fs.readFileSync(done, 'utf8')) as { rulesVersion?: string }
		const l = JSON.parse(fs.readFileSync(live, 'utf8')) as { forSession?: string }
		if (h.rulesVersion === RULES_VERSION && l.forSession === forSession) {
			console.log(`[DailyWatchlist] already written for ${forSession} — nothing to do`)
			return 0
		}
	} catch {}
	const marker = path.join(dataDir, HISTORY_DIR, `${forSession}.failed.txt`)
	if (fs.existsSync(marker)) {
		console.log(`[DailyWatchlist] failed earlier this evening (${marker}) — not retried`)
		return 2
	}

	const write = atomicWriter(dataDir)
	const result = await runBhavScan({
		asOf,
		forSession,
		nowMs: now,
		core: JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'config', 'daily_watchlist_core.json'), 'utf8')),
		fyers: { file: 'fyersUniverse.json', asOf: FYERS_UNIVERSE_AS_OF, symbols: new Set(JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'fyersUniverse.json'), 'utf8')) as string[]) },
		fetchZip: async () => {
			if (local) return fs.readFileSync(local)
			const r = await axios.get<ArrayBuffer>(bhavcopyUrl(asOf), {
				responseType: 'arraybuffer',
				timeout: 60_000,
				headers: { 'User-Agent': UA, Accept: '*/*' },
				validateStatus: (s) => s === 200 || s === 404,
			})
			return r.status === 404 ? null : Buffer.from(r.data)
		},
		writeFile: write,
	})

	if (result.kind === 'written') {
		const short = (s: string) => s.replace(/^NSE:|-EQ$/g, '')
		const rot = result.file.entries.filter((e) => e.group === 'rotating').map((e) => short(e.symbol))
		const core = result.file.entries.length - rot.length
		const dropped = result.file.fyersCheck?.dropped ?? []
		await notifyAdmin(
			`✅ Daily watchlist (${RULES_VERSION}, NSE bhavcopy ${asOf}) for ${forSession}: ${result.file.symbols.length} stocks + Nifty (core ${core} + ${rot.length}). Used at the next 09:00 boot when SCREENER_ENABLED=true.\nRotating: ${rot.join(', ')}\nDropped (not in fyersUniverse.json of ${FYERS_UNIVERSE_AS_OF}): ${dropped.map(short).join(', ') || 'none'}`,
		)
		return 0
	}
	if (result.kind === 'not-yet') {
		console.warn(`[DailyWatchlist] ⏳ ${result.reason}${final ? '' : ' — retried at the next half hour'}`)
		if (final) await notifyAdmin(`⚠️ Daily watchlist for ${forSession} NOT updated (${result.reason}, last try 22:00); the static list will be used.`)
		return 5
	}
	console.warn(`[DailyWatchlist] ❌ ${result.reason}`)
	try {
		write(`${HISTORY_DIR}/${forSession}.failed.txt`, `${new Date(now).toISOString()} ${result.reason}\n`)
	} catch {}
	await notifyAdmin(`⚠️ Daily watchlist for ${forSession} NOT updated (${result.reason}); the static list will be used.`)
	return 2
}

main()
	.then((code) => process.exit(code))
	.catch(async (err) => {
		console.error('[DailyWatchlist] ❌ crashed:', err)
		await notifyAdmin(`❌ Daily watchlist job crashed: ${(err as Error)?.message ?? err}. The static list will be used.`)
		process.exit(1)
	})
