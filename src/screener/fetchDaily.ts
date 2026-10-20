// ============================================================
// screener/fetchDaily.ts — incremental, rate-limited daily-candle fetch + failure budget
//
// - Shared limiter: <= 4 request STARTS in any rolling second (utils/rateLimit.ts),
//   the same one the VWAP seeder uses. Fyers' Standard plan allows 5/s.
// - -360 and Cloudflare 429/1015 are retried after 1 s, 2 s, 4 s (+ jitter), max 3.
// - Incremental: only bars from the last cached day onward are requested (the last
//   day is re-fetched so a partial bar is refreshed). Cold start pulls enough
//   history for the 300-bar EMA window and the 252-bar high, in <= 365-day chunks.
// - Every symbol ends as OK / NO_DATA / FAILED. Nothing is dropped silently: the
//   old screener counted a non-ok response as "processed" and moved on.
// ============================================================

import { createSlidingWindowLimiter, isRateLimitError, retryDelayMs, type LimiterClock } from '../utils/rateLimit.js'
import type { CandleStore } from './candleStore.js'
import { istDay, type DailyBar } from './indicators.js'
import type { FetchOutcome } from './screen.js'
import { QuotaStopError, type QuotaGate } from '../fyers/quota.js'

export const FETCH_MAX_PER_SECOND = 4
export const FETCH_MAX_RETRIES = 3
export const COLD_START_CALENDAR_DAYS = 460 // ≈ 315 trading days: 300-bar EMA window + margin
const CHUNK_DAYS = 365 // Fyers caps a daily getHistory call at ~366 days
const DAY_MS = 86_400_000

/** Fyers getHistory response (resolution 'D', date_format '1'). */
export interface HistoryResponse {
	s: string
	candles?: number[][]
	message?: string
	code?: number
}

export interface FetchDeps {
	getHistory: (symbol: string, fromDay: string, toDay: string) => Promise<HistoryResponse>
	store: CandleStore
	todayIst: string
	clock?: LimiterClock
	log?: Pick<Console, 'warn' | 'error'>
	rand?: () => number
	/** The shared Fyers quota gate (production). Without it: local 4/s limiter + retries (tests). */
	gate?: QuotaGate
}

export interface FetchReport {
	outcomes: Map<string, FetchOutcome>
	errors: Map<string, string>
	requests: number
	retries: number
	/** Set when the quota gate stopped the run (allocation, daily limit, throttle limit). Symbols not reached have no outcome. */
	stopped: QuotaStopError | null
}

const toBars = (candles: number[][]): DailyBar[] =>
	candles.map((c) => ({ t: c[0]! * 1000, o: c[1]!, h: c[2]!, l: c[3]!, c: c[4]!, v: c[5]! }))

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** Date ranges [from, to] to request for a symbol given what's cached. */
export const plannedRanges = (cached: DailyBar[], today: string): [string, string][] => {
	if (cached.length > 0) {
		const lastDay = istDay(cached[cached.length - 1]!.t)
		if (lastDay >= today) return []
		return [[lastDay, today]] // re-fetch the last cached day: refreshes a partial bar
	}
	const ranges: [string, string][] = []
	let from = addDays(today, -COLD_START_CALENDAR_DAYS)
	while (from <= today) {
		const to = addDays(from, CHUNK_DAYS - 1) < today ? addDays(from, CHUNK_DAYS - 1) : today
		ranges.push([from, to])
		from = addDays(to, 1)
	}
	return ranges
}

export const fetchDailyUniverse = async (symbols: string[], deps: FetchDeps): Promise<FetchReport> => {
	const clock = deps.clock ?? { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }
	const log = deps.log ?? console
	const { limit } = createSlidingWindowLimiter(FETCH_MAX_PER_SECOND, 1000, clock)
	const report: FetchReport = { outcomes: new Map(), errors: new Map(), requests: 0, retries: 0, stopped: null }
	const started = clock.now()
	let done = 0

	const getChecked = async (symbol: string, from: string, to: string): Promise<HistoryResponse> => {
		report.requests++
		const res = await deps.getHistory(symbol, from, to)
		// Fyers sometimes resolves (rather than rejects) with an error body.
		if (res.s !== 'ok' && res.s !== 'no_data') throw res
		return res
	}

	const request = async (symbol: string, from: string, to: string): Promise<HistoryResponse> => {
		// Production: the shared quota gate paces (4/s, 40/min), counts, cools down and stops.
		if (deps.gate) return deps.gate.call(() => getChecked(symbol, from, to))
		for (let attempt = 0; ; attempt++) {
			try {
				return await limit(() => getChecked(symbol, from, to))
			} catch (err) {
				if (isRateLimitError(err) && attempt < FETCH_MAX_RETRIES) {
					report.retries++
					await clock.sleep(retryDelayMs(attempt, err, deps.rand))
					continue
				}
				throw err
			}
		}
	}

	await Promise.all(
		symbols.map(async (symbol) => {
			if (report.stopped) return // a quota stop ends the run; saved candles stay
			const cached = deps.store.load(symbol)
			const ranges = plannedRanges(cached, deps.todayIst)
			if (ranges.length === 0) {
				report.outcomes.set(symbol, 'OK')
			} else {
				try {
					let got = 0
					for (const [from, to] of ranges) {
						if (report.stopped) return
						const res = await request(symbol, from, to)
						if (res.s === 'ok' && res.candles && res.candles.length > 0) {
							deps.store.merge(symbol, toBars(res.candles)) // saved per chunk: a stop never loses fetched bars
							got += res.candles.length
						}
					}
					report.outcomes.set(symbol, got > 0 || cached.length > 0 ? 'OK' : 'NO_DATA')
				} catch (err) {
					if (err instanceof QuotaStopError) {
						report.stopped ??= err
						return
					}
					report.outcomes.set(symbol, 'FAILED')
					const msg = (err as { message?: string })?.message ?? JSON.stringify(err)
					report.errors.set(symbol, msg)
					log.error(`[Screener] ⚠️ ${symbol} failed after retries: ${msg}`)
				}
			}
			done++
			if (done % 100 === 0) {
				const failed = [...report.outcomes.values()].filter((o) => o === 'FAILED').length
				log.warn(`[Screener] … ${done}/${symbols.length} symbols, ${report.requests} requests, ${failed} failed, ${Math.round((clock.now() - started) / 1000)} s`)
			}
		}),
	)
	if (report.stopped) log.error(`[Screener] ⛔ Fetch stopped after ${done}/${symbols.length} symbols: ${report.stopped.message}`)
	return report
}

export interface BudgetVerdict {
	ok: boolean
	failedPct: number
	noDataPct: number
	failed: string[]
	reason: string | null
}

/**
 * > maxFailedPct failed after retries, or > maxNoDataPct with no data (a token
 * or API problem looks like mass no_data) → the run is not trusted: keep the
 * previous watchlist.
 */
export const evaluateFailureBudget = (
	outcomes: Map<string, FetchOutcome>,
	budget: { maxFailedPct: number; maxNoDataPct: number },
): BudgetVerdict => {
	const n = outcomes.size || 1
	const failed = [...outcomes].filter(([, o]) => o === 'FAILED').map(([s]) => s).sort()
	const noData = [...outcomes.values()].filter((o) => o === 'NO_DATA').length
	const failedPct = (failed.length / n) * 100
	const noDataPct = (noData / n) * 100
	const reason =
		failedPct > budget.maxFailedPct
			? `${failed.length}/${outcomes.size} symbols failed (${failedPct.toFixed(1)}% > ${budget.maxFailedPct}%)`
			: noDataPct > budget.maxNoDataPct
				? `${noData}/${outcomes.size} symbols returned no data (${noDataPct.toFixed(1)}% > ${budget.maxNoDataPct}%)`
				: null
	return { ok: reason === null, failedPct, noDataPct, failed, reason }
}
