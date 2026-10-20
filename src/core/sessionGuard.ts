// ============================================================
// core/sessionGuard.ts — trading-day calendar + watchdog policy (pure)
//
// Decides, without I/O, whether the engine should run today, what a silent
// socket means at a given moment, and what to do when the watchdog trips.
// websocket.ts owns the side effects (exit codes, Redis counter, Telegram).
//
// Exit codes matter: quant_engine runs with `restart: on-failure`, so
//   exit 1 → Docker restarts it immediately (no backoff for containers that
//            ran > 10 s, which every boot does), and
//   exit 0 → it stays down until the scheduler's next `docker start`.
// The Oct 20 holiday crash loop (415 restarts) was exit 1 on every trip.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { getISTDateString, getISTMinutes } from '../utils/marketHours.js'

export const SESSION_OPEN_MIN = 9 * 60 + 15
export const SESSION_CLOSE_MIN = 15 * 60 + 30
/** From 15:15 IST a restart cannot be back before the close: stand down instead. */
export const LATE_SESSION_MIN = 15 * 60 + 15
export const WATCHDOG_TIMEOUT_MS = 30_000
export const MAX_RESTARTS_PER_DAY = 6
export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_MAX_MS = 5 * 60_000

// ── Trading calendar ────────────────────────────────────────────────────────

/** Parse scheduler/nse_holidays.txt: one YYYY-MM-DD per line, '#' comments. */
export const parseHolidays = (text: string): Set<string> => {
	const out = new Set<string>()
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim()
		if (!line || line.startsWith('#')) continue
		const m = line.match(/^(\d{4}-\d{2}-\d{2})\b/)
		if (m) out.add(m[1]!)
	}
	return out
}

/** Same file the scheduler reads (Dockerfile COPY . . puts it at /app/scheduler/). */
export const holidayFilePath = (): string =>
	process.env.NSE_HOLIDAY_FILE || path.resolve(process.cwd(), 'scheduler', 'nse_holidays.txt')

export const loadHolidays = (file = holidayFilePath()): Set<string> | null => {
	try {
		return parseHolidays(fs.readFileSync(file, 'utf8'))
	} catch {
		return null
	}
}

const weekdayOf = (istDate: string): number => new Date(`${istDate}T00:00:00Z`).getUTCDay()

export type DayVerdict =
	| { trading: true }
	| { trading: false; reason: 'WEEKEND' | 'HOLIDAY' }

export const tradingDayVerdict = (istDate: string, holidays: Set<string>): DayVerdict => {
	const wd = weekdayOf(istDate)
	if (wd === 0 || wd === 6) return { trading: false, reason: 'WEEKEND' }
	if (holidays.has(istDate)) return { trading: false, reason: 'HOLIDAY' }
	return { trading: true }
}

/** True when the calendar has no entry for this year — it is then probably stale. */
export const calendarMissingYear = (holidays: Set<string>, istDate: string): boolean => {
	const year = istDate.slice(0, 4)
	for (const d of holidays) if (d.startsWith(year)) return false
	return true
}

// ── Watchdog ────────────────────────────────────────────────────────────────

export type WatchdogCheck = 'RESET_CLOCK' | 'OK' | 'TRIP'

/**
 * Called every 10 s. Outside 09:15–15:30 IST silence is normal: the caller
 * keeps lastTickMs fresh so the first in-session check measures from the open.
 */
export const checkWatchdog = (nowMs: number, lastTickMs: number, timeoutMs = WATCHDOG_TIMEOUT_MS): WatchdogCheck => {
	const m = getISTMinutes(nowMs)
	if (m < SESSION_OPEN_MIN || m >= SESSION_CLOSE_MIN) return 'RESET_CLOCK'
	return nowMs - lastTickMs > timeoutMs ? 'TRIP' : 'OK'
}

export type TripAction =
	| { action: 'RESTART'; exitCode: 1; reason: string }
	| { action: 'STAND_DOWN'; exitCode: 0; reason: string }

/**
 * What a watchdog trip does. `tripsToday` includes this trip (the caller
 * increments the persisted counter first). A trip that restarts is one restart.
 */
export const decideTrip = (nowMs: number, tripsToday: number, maxRestarts = MAX_RESTARTS_PER_DAY): TripAction => {
	if (getISTMinutes(nowMs) >= LATE_SESSION_MIN) {
		return { action: 'STAND_DOWN', exitCode: 0, reason: 'after 15:15 IST — a restart cannot be back before the close' }
	}
	if (tripsToday > maxRestarts) {
		return { action: 'STAND_DOWN', exitCode: 0, reason: `restart limit reached (${maxRestarts}/day)` }
	}
	return { action: 'RESTART', exitCode: 1, reason: `restart ${tripsToday}/${maxRestarts}` }
}

/** Wait before reconnecting after the n-th restart today: 30 s, 60 s, 120 s, 240 s, then 5 min. */
export const restartBackoffMs = (restartsToday: number): number => {
	if (restartsToday <= 0) return 0
	return Math.min(BACKOFF_BASE_MS * 2 ** (restartsToday - 1), BACKOFF_MAX_MS)
}

export const restartCounterKey = (nowMs: number): string => `engine:restarts:${getISTDateString(nowMs)}`
export const RESTART_COUNTER_TTL_SECS = 2 * 24 * 3600
