// ============================================================
// screener/paths.ts — where the screener's outputs live, and where the engine reads them
//
// quant_screener writes into the `screener_data` volume (/app/data); quant_engine
// mounts the same volume and only reads. Outside Docker (tests, backtest, a first
// deploy before the job has ever run) the engine falls back to the files baked
// into the image at /app/watchlist.json and /app/universe_stats.json.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import type { PromotionSource } from '../core/symbolSource.js'
import { loadHolidays, tradingDayVerdict } from '../core/sessionGuard.js'
import { getISTDateString } from '../utils/marketHours.js'
import { OPTION_STRIKE_COUNT } from '../utils/optionUtils.js'
import { subscriptionCapFromEnv } from '../core/subscriptionPlan.js'
import { chooseWatchlist, DAILY_FILE, screenerEnabled, type WatchlistChoice } from './dailyWatchlist.js'

export const screenerDataDir = (): string => process.env.SCREENER_DATA_DIR || '/app/data'

/**
 * Layer B's scan set: the screener's capped anomaly_universe.json; else (rollback /
 * before the first job run) a legacy universe_stats.json in the working dir written
 * by the old boot screener; else null (Layer B disabled, as before).
 */
export const resolveAnomalyUniverseFile = (): string | null => {
	const capped = path.join(screenerDataDir(), 'anomaly_universe.json')
	if (fs.existsSync(capped)) return capped
	const legacy = path.resolve(process.cwd(), 'universe_stats.json')
	return fs.existsSync(legacy) ? legacy : null
}

/** The screener's file if it exists, else the baked-in one (cwd). */
export const resolveScreenerFile = (name: 'watchlist.json' | 'universe_stats.json' | 'watchlist_meta.json'): string => {
	const fromJob = path.join(screenerDataDir(), name)
	return fs.existsSync(fromJob) ? fromJob : path.resolve(process.cwd(), name)
}

const readMeta = (): { asOf?: string; entries?: { symbol: string; source: string }[] } | null => {
	try {
		return JSON.parse(fs.readFileSync(path.join(screenerDataDir(), 'watchlist_meta.json'), 'utf8'))
	} catch {
		return null
	}
}

/** symbol → promotion source from the screener's meta (empty if there is none). */
export const readMetaSources = (): Map<string, PromotionSource> =>
	new Map((readMeta()?.entries ?? []).map((e) => [e.symbol, e.source as PromotionSource]))

/** NSE trading days strictly between two IST dates. */
export const tradingDaysBetween = (fromDay: string, toDay: string, holidays: Set<string>): number => {
	let n = 0
	for (let t = Date.parse(`${fromDay}T00:00:00Z`) + 86_400_000; t < Date.parse(`${toDay}T00:00:00Z`); t += 86_400_000) {
		if (tradingDayVerdict(new Date(t).toISOString().slice(0, 10), holidays).trading) n++
	}
	return n
}

export const MAX_STALE_TRADING_DAYS = 3

/**
 * A warning when the static watchlist is older than 3 trading days or its age is unknown; else null.
 * For the static list only: the daily list (dw-3) is used only when it is for today, so it has no
 * age to check, and watchlist_meta.json was written only by the retired quant_screener.
 * `usingPath`: the file the engine actually loaded (default: the volume's watchlist.json).
 */
export const screenerStaleness = (nowMs = Date.now(), usingPath?: string): string | null => {
	const meta = readMeta()
	if (!meta?.asOf) {
		// Without the meta file the watchlist's age is unknown. Name the file actually in use: the
		// volume's watchlist.json when it exists (resolveScreenerFile), else the image's baked-in copy.
		const fromJob = path.join(screenerDataDir(), 'watchlist.json')
		const using = usingPath ?? fromJob
		const inVolume = path.resolve(using).startsWith(path.resolve(screenerDataDir()) + path.sep)
		return inVolume && fs.existsSync(using)
			? `watchlist_meta.json missing or unreadable in ${screenerDataDir()} — using the static list ${using}; its age can't be checked`
			: `screener output not found in ${screenerDataDir()} — using the baked-in watchlist.json`
	}
	const today = getISTDateString(nowMs)
	const missed = tradingDaysBetween(meta.asOf, today, loadHolidays() ?? new Set())
	return missed > MAX_STALE_TRADING_DAYS
		? `static watchlist is from ${meta.asOf} — ${missed} trading days old (> ${MAX_STALE_TRADING_DAYS}); its writer (quant_screener) is retired: refresh it by hand or use the daily list`
		: null
}

/**
 * Symbols the watchlist may use under the Fyers subscription cap: the cap minus the bench (Layer B
 * scan set), the Nifty index and the option strikes, counted as websocket.ts plans them.
 */
export const watchlistRoom = (env: NodeJS.ProcessEnv = process.env): number => {
	const scanSet = resolveAnomalyUniverseFile()
	const bench = scanSet ? Object.keys(JSON.parse(fs.readFileSync(scanSet, 'utf8'))).length : 0
	const options = env.NIFTY_OPTIONS_ENABLED === 'true' ? OPTION_STRIKE_COUNT : 0
	return subscriptionCapFromEnv(env.SUBSCRIPTION_CAP) - bench - 1 - options
}

/**
 * The watchlist the engine and the VWAP seeder use today (dw-3): the daily
 * watchlist_daily.json when SCREENER_ENABLED is 'true', the file is valid and for today (IST)
 * and it fits the subscription cap; otherwise the static watchlist.json (resolveScreenerFile).
 * A daily list that doesn't fit falls back (with the alert) instead of the engine refusing to boot.
 */
export const resolveWatchlist = (nowMs = Date.now()): WatchlistChoice => {
	const opts = {
		enabled: screenerEnabled(),
		dailyPath: path.join(screenerDataDir(), DAILY_FILE),
		staticPath: resolveScreenerFile('watchlist.json'),
		today: getISTDateString(nowMs),
	}
	const c = chooseWatchlist(opts)
	if (c.source !== 'daily') return c
	const room = watchlistRoom()
	if (c.symbols.length <= room) return c
	return { ...chooseWatchlist({ ...opts, enabled: false }), reason: `daily list of ${c.symbols.length} doesn't fit the subscription cap (room ${room})`, fellBack: true }
}
