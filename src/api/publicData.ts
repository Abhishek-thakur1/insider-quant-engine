// ============================================================
// api/publicData.ts — the dashboard's two read-only additions (pure, tested)
//
//   GET /api/signals?date=YYYY-MM-DD   every fire of the day from the `signals` table:
//                                       detector, score, filter outcome, whether it alerted.
//                                       Answers "why no alert?". SELECT only.
//   GET /api/health                    COARSE public health (owner, 2026-10-23): status,
//                                       ticks per 5 min, stocks seen. No quota, monitor,
//                                       restart or host details — the dashboard has no login.
//
// Ticks per 5 min: the engine logs it but does not publish it yet. Until a later
// engine change writes it to Redis, this returns null (shown as "not available").
// ============================================================

import { SESSION_CLOSE_MIN, SESSION_OPEN_MIN, tradingDayVerdict } from '../core/sessionGuard.js'
import { getISTDateString, getISTMinutes } from '../utils/marketHours.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** A real calendar date as YYYY-MM-DD. The shape alone lets 2026-02-30 through to Postgres, which
 *  then fails the query with a 500 that carries the database's error text (audit of 31 Oct). */
export const isIsoDate = (s: unknown): s is string => {
	if (typeof s !== 'string' || !DATE_RE.test(s)) return false
	const [y, m, d] = s.split('-').map(Number) as [number, number, number]
	const t = new Date(Date.UTC(y, m - 1, d))
	return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}
export const SIGNALS_LIMIT = 500

/** Columns safe to expose publicly (no trigger text with sizes, no capital fields). */
export const SIGNAL_COLUMNS = [
	'signal_id',
	'fired_at',
	'trade_date',
	'symbol',
	'detector',
	'direction',
	'score',
	'score_threshold',
	'filter_result',
	'rejected_at',
	'regime_class',
	'market_regime',
	'alert_sent',
	'alert_suppressed_reason',
	'data_quality',
	'trade_id',
] as const

export const signalsQuery = (date: string): { sql: string; params: unknown[] } | null => {
	if (!isIsoDate(date)) return null
	return {
		sql: `SELECT ${SIGNAL_COLUMNS.join(', ')} FROM signals WHERE trade_date = $1 ORDER BY fired_at DESC LIMIT ${SIGNALS_LIMIT}`,
		params: [date],
	}
}

export interface SignalRowOut {
	id: string
	firedAt: number
	symbol: string
	detector: string
	side: string
	score: number | null
	threshold: number | null
	outcome: string // PASSED | REJECTED | ERROR …
	rejectedAt: string | null
	regimeClass: string | null
	marketRegime: string | null
	alerted: boolean
	suppressedReason: string | null
	dataQuality: string[]
	tradeId: number | null
}

const num = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v))

export const mapSignalRow = (r: Record<string, unknown>): SignalRowOut => ({
	id: String(r.signal_id),
	firedAt: new Date(r.fired_at as string).getTime(),
	symbol: String(r.symbol),
	detector: String(r.detector),
	side: String(r.direction),
	score: num(r.score),
	threshold: num(r.score_threshold),
	outcome: String(r.filter_result),
	rejectedAt: (r.rejected_at as string | null) ?? null,
	regimeClass: (r.regime_class as string | null) ?? null,
	marketRegime: (r.market_regime as string | null) ?? null,
	alerted: r.alert_sent === true,
	suppressedReason: (r.alert_suppressed_reason as string | null) ?? null,
	dataQuality: Array.isArray(r.data_quality) ? (r.data_quality as string[]) : [],
	tradeId: num(r.trade_id),
})

export type PublicStatus = 'live' | 'stale' | 'closed' | 'holiday'

export interface CoarseHealth {
	status: PublicStatus
	asOf: number
	ticksPer5m: number | null
	stocksSeenToday: number
	lastIndexCandleAt: number | null
}

/**
 * Status from what Redis already holds, no engine change:
 *  - closed / holiday: outside 09:15–15:30 IST, a weekend or an NSE holiday;
 *  - live: in session and the newest closed 5-minute Nifty candle (the EMA shadow's own
 *    store) ended within the last 10 minutes;
 *  - stale: in session but no recent candle (engine down, feed silent, or the shadow disabled).
 */
export const coarseHealth = (i: {
	nowMs: number
	holidays: Set<string> | null
	lastBarStartMs: number | null
	stocksSeenToday: number
	ticksPer5m?: number | null
}): CoarseHealth => {
	const day = getISTDateString(i.nowMs)
	const verdict = i.holidays ? tradingDayVerdict(day, i.holidays) : null
	const m = getISTMinutes(i.nowMs)
	const lastCandleEnd = i.lastBarStartMs !== null ? i.lastBarStartMs + 5 * 60_000 : null
	let status: PublicStatus
	if (verdict && !verdict.trading) status = verdict.reason === 'HOLIDAY' ? 'holiday' : 'closed'
	else if (m < SESSION_OPEN_MIN || m >= SESSION_CLOSE_MIN) status = 'closed'
	else status = lastCandleEnd !== null && i.nowMs - lastCandleEnd <= 10 * 60_000 ? 'live' : 'stale'
	return { status, asOf: i.nowMs, ticksPer5m: i.ticksPer5m ?? null, stocksSeenToday: i.stocksSeenToday, lastIndexCandleAt: lastCandleEnd }
}
