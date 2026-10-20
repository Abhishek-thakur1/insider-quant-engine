// ============================================================
// core/tradingDayGate.ts — exit cleanly on weekends / NSE holidays
//
// Defence in depth behind scheduler/lifecycle.sh: also covers manual starts and
// a stale scheduler image. Exit 0, so `restart: on-failure` does not restart it.
// ============================================================

import { getISTDateString } from '../utils/marketHours.js'
import { calendarMissingYear, holidayFilePath, loadHolidays, tradingDayVerdict } from './sessionGuard.js'

/** Exits the process (code 0) on a non-trading day. Returns a warning string if the calendar looks stale. */
export const exitIfNotTradingDay = (tag: string, nowMs = Date.now()): string | null => {
	const today = getISTDateString(nowMs)
	const holidays = loadHolidays()
	if (!holidays) {
		const w = `NSE holiday calendar not readable at ${holidayFilePath()} — running without a holiday check`
		console.warn(`[${tag}] ⚠️ ${w}`)
		return w
	}
	const verdict = tradingDayVerdict(today, holidays)
	if (!verdict.trading) {
		console.log(`[${tag}] 🏖️ ${today} is not a trading day (${verdict.reason}). Exiting cleanly — exit 0, no restart.`)
		process.exit(0)
	}
	if (calendarMissingYear(holidays, today)) {
		const w = `NSE holiday calendar has no ${today.slice(0, 4)} entries — update scheduler/nse_holidays.txt`
		console.warn(`[${tag}] ⚠️ ${w}`)
		return w
	}
	return null
}
