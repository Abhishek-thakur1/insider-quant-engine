// ============================================================
// src/core/detectorDiagnostics.ts — "why no alert" records for the Nifty detectors (observation only)
//
// When a Nifty detector evaluates a closed candle and does NOT fire, it calls noteBlocked() with
// the reason (risk cap, body too small, warm-up, cooldown, outside window, ...). This module only
// records; it never throws, is never awaited by a detector, and cannot change alerts, positions,
// gates or thresholds. Bounded on purpose:
//   - one record per detector per candle (the first reason wins);
//   - each window_* reason (window_not_open, window_midday_pause, window_closed) at most once per
//     detector per IST day;
//   - DAILY_CAP records per detector per IST day;
//   - Redis list diag:nifty:{IST-date}, LTRIM to LIST_MAX, 36 h TTL (date-keyed, never cleared
//     at boot, like alert:sent:*); plus one log line per record.
// Kill switch: NIFTY_DIAG_ENABLED=false. (2026-10-26, owner request after the 22,386 → 22,700
// move produced no Nifty alert and the reasons had to be rebuilt from bars.)
// ============================================================
import { redisClient } from '../config/redis.js'

export const DAILY_CAP = 300
export const LIST_MAX = 500
export const LIST_TTL_SECS = 36 * 3600
export const diagKey = (istDate: string) => `diag:nifty:${istDate}`

export interface DiagRecord { detector: string; t: number; ist: string; side: 'LONG' | 'SHORT' | null; reason: string; nums?: Record<string, number> }

const enabled = () => process.env.NIFTY_DIAG_ENABLED !== 'false'
const istStamp = (ms: number) => { const iso = new Date(ms + 330 * 60_000).toISOString(); return { date: iso.slice(0, 10), time: iso.slice(11, 16) } }

const seenCandle = new Map<string, string>() // detector -> last candle key recorded
const windowNoted = new Set<string>() // `${detector}|${date}|${reason}`
const perDay = new Map<string, number>() // `${detector}|${date}` -> count
const recent: DiagRecord[] = [] // last records, for tests and debugging (bounded)

/** Record why a detector's closed candle produced no alert. Never throws, never awaited. */
export function noteBlocked(detector: string, candleStartMs: number, side: DiagRecord['side'], reason: string, nums?: Record<string, number>): void {
	try {
		if (!enabled()) return
		const { date, time } = istStamp(candleStartMs)
		const dayKey = `${detector}|${date}`
		if (reason.startsWith('window_')) {
			if (windowNoted.has(`${dayKey}|${reason}`)) return
			windowNoted.add(`${dayKey}|${reason}`)
		} else {
			const ck = `${date}|${candleStartMs}`
			if (seenCandle.get(detector) === ck) return
			seenCandle.set(detector, ck)
		}
		const n = (perDay.get(dayKey) ?? 0) + 1
		if (n > DAILY_CAP) return
		perDay.set(dayKey, n)
		const rec: DiagRecord = { detector, t: candleStartMs, ist: time, side, reason, ...(nums ? { nums } : {}) }
		recent.push(rec)
		if (recent.length > LIST_MAX) recent.shift()
		const numStr = nums ? ' ' + Object.entries(nums).map(([k, v]) => `${k}=${Number.isFinite(v) ? Number(v.toFixed(2)) : v}`).join(' ') : ''
		console.log(`[Diag] ${detector} ${time} ${side ?? '-'} ${reason}${numStr}`)
		const key = diagKey(date)
		void Promise.resolve()
			.then(async () => {
				await redisClient.lPush(key, JSON.stringify(rec))
				await redisClient.lTrim(key, 0, LIST_MAX - 1)
				await redisClient.expire(key, LIST_TTL_SECS)
			})
			.catch(() => { /* diagnostics must never affect the engine */ })
	} catch {
		/* never throw into a detector */
	}
}

/** Test/debug view of the latest records (in memory). */
export const recentDiagnostics = (): readonly DiagRecord[] => recent
/** Reset in-memory state (tests and the replay harness's per-session reset). */
export const resetDiagnostics = (): void => { seenCandle.clear(); windowNoted.clear(); perDay.clear(); recent.length = 0 }
