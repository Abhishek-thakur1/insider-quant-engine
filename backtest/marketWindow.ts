// ============================================================
// backtest/marketWindow.ts — keep backtest fetches off the live engine's rate limit
//
// The Fyers rate limit (Standard plan: 5 req/s) is per app, so a backtest fetch
// on the owner's PC competes with production's own history calls when both use
// the same app — per-minute (50) and per-day (5,000) limits included. On NSE
// trading days the fetch commands refuse to start during:
//   08:45–15:45 IST  engine boot + live session (VWAP seeding, anomaly promotions)
//   16:25–18:00 IST  the EOD screener job (quant_screener, 16:30; up to its
//                    2,200-request allocation at 40/min ≈ 55 min)
// Weekends and NSE holidays are always allowed. --allow-market-hours overrides.
// ============================================================

import { loadHolidays, tradingDayVerdict } from '../src/core/sessionGuard.js'
import { getISTDateString, getISTMinutes } from '../src/utils/marketHours.js'

export const BLOCKOUTS: Array<{ from: number; to: number; why: string }> = [
	{ from: 8 * 60 + 45, to: 15 * 60 + 45, why: 'engine boot and live session' },
	{ from: 16 * 60 + 25, to: 18 * 60, why: 'the 16:30 EOD screener job' },
]

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** A refusal message, or null when it's fine to fetch now. */
export const marketWindowViolation = (nowMs: number, holidays: Set<string> | null = loadHolidays()): string | null => {
	const day = getISTDateString(nowMs)
	if (!tradingDayVerdict(day, holidays ?? new Set()).trading) return null
	const m = getISTMinutes(nowMs)
	const hit = BLOCKOUTS.find((b) => m >= b.from && m < b.to)
	if (!hit) return null
	return `It is ${hhmm(m)} IST on trading day ${day} — blocked ${hhmm(hit.from)}–${hhmm(hit.to)} IST (${hit.why}). Backtest fetches share the Fyers rate limit with production. Allowed on trading days: before 08:45, 15:45–16:25, after 18:00; weekends/holidays any time. --allow-market-hours overrides.`
}
