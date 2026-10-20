// ============================================================
// backtest/data/fyersClient.ts — rate-limited historical fetcher
//
// Uses the SAME integration the live seeder uses (`fyersApi.getHistory`), only
// with `resolution: 'D'` for the daily store, exactly as the goal doc
// specifies — a parameter change, not a new integration.
//
// Design notes:
//   - Chunked. Fyers caps the span per getHistory call, and the cap is tighter
//     for 1-minute than for daily, so the two use different chunk sizes.
//   - Resumable. Every chunk is merged into the cache as it lands, so an
//     interrupted overnight run continues instead of restarting.
//   - Rate limited by the live sliding-window limiter (<= 4 starts per rolling
//     second) with the live rate-limit detection (-360, 429, Cloudflare 1015).
// ============================================================

import fyers from 'fyers-api-v3'
import fs from 'fs'
import path from 'path'
import { ENV } from '../../src/config/env.js'
import { DATA, DATA_DIR } from '../config.js'
import { isPlaceholder } from '../core/bootEnv.js'
import { addCoverage, ensureDirs, isCovered, loadCoverage, loadSeries, saveSeries, type Bar } from './store.js'
import { istDateStringOf, realNow } from '../core/clock.js'
import { isRateLimitError, retryDelayMs } from '../../src/utils/rateLimit.js'
import { createQuotaGate, FileLedger, loadQuotaConfig, QuotaStopError, type QuotaGate } from '../../src/fyers/quota.js'

/**
 * The owner's PC ledger for the shared Fyers Data-API quota (job "backtest",
 * config/fyers_quota.json allocation per IST day). It survives across nights,
 * so a fetch that hits its allocation resumes the next night.
 */
export const BACKTEST_LEDGER_FILE = path.join(DATA_DIR, '..', 'quota-ledger.json')
export const backtestGate = (): QuotaGate =>
	createQuotaGate({ job: 'backtest', config: loadQuotaConfig(), ledger: new FileLedger(BACKTEST_LEDGER_FILE) })

const fyersApi = new fyers.fyersModel({ path: './', enableLogging: false })

/**
 * The live engine reads /app/token/access_token.txt (a Docker volume path).
 * A backtest usually runs outside the container, so allow an override and
 * check the common locations.
 */
export const resolveTokenPath = (): string | null => {
	const candidates = [
		process.env.FYERS_TOKEN_PATH,
		path.resolve('/app/token', 'access_token.txt'),
		path.resolve(process.cwd(), 'access_token.txt'),
		path.resolve(process.cwd(), 'backtest', 'access_token.txt'),
	].filter((p): p is string => !!p)

	for (const p of candidates) if (fs.existsSync(p)) return p
	return null
}

export const authenticate = (): { ok: true } | { ok: false; reason: string } => {
	const tokenPath = resolveTokenPath()
	if (!tokenPath) {
		return {
			ok: false,
			reason:
				'No Fyers access token found. Looked at $FYERS_TOKEN_PATH, /app/token/access_token.txt, ./access_token.txt and ./backtest/access_token.txt. Run the auth bridge (src/config/auth.ts) and point $FYERS_TOKEN_PATH at the resulting file.',
		}
	}
	if (!ENV.FYERS_APP_ID || isPlaceholder('FYERS_APP_ID')) {
		return {
			ok: false,
			reason:
				'FYERS_APP_ID is not set — bootEnv filled a placeholder. Create a .env with real Fyers credentials (see README) before fetching data.',
		}
	}

	fyersApi.setAppId(ENV.FYERS_APP_ID)
	fyersApi.setAccessToken(fs.readFileSync(tokenPath, 'utf8').trim())
	return { ok: true }
}

// Rate limiting and rate-limit detection are the live modules (src/utils/rateLimit.ts):
// the old token bucket here let simultaneous retries burst past Fyers' 5/s, and its
// regex missed Fyers' -360 "plan limit" body. Tested in tests/seederRateLimit.test.ts.

const DAY_MS = 24 * 60 * 60 * 1000

/** Fyers candle tuple: [epochSeconds, open, high, low, close, volume]. */
const toBars = (candles: unknown[][]): Bar[] =>
	candles.map((c) => ({
		t: (c[0] as number) * 1000,
		o: c[1] as number,
		h: c[2] as number,
		l: c[3] as number,
		c: c[4] as number,
		v: c[5] as number,
	}))

/** Fyers getHistory request/response, as used here. */
type HistoryRequest = { symbol: string; resolution: string; date_format: string; range_from: string; range_to: string; cont_flag: string }
type HistoryFn = (req: HistoryRequest) => Promise<{ s: string; candles?: unknown[][]; message?: string; code?: number }>
let historyFn: HistoryFn = (req) => fyersApi.getHistory(req)
/** Test seam: replace the Fyers call (null restores it). Never used by the CLI. */
export const __setHistoryFnForTests = (fn: HistoryFn | null): void => {
	historyFn = fn ?? ((req) => fyersApi.getHistory(req))
}

/**
 * The token was rejected (expired at the end of its day, or revoked). Every
 * further call would fail the same way, so the whole fetch stops here instead of
 * marking each remaining symbol failed. Progress is already on disk.
 */
export class TokenExpiredError extends Error {}

// Fyers auth failures: -8 / -15 / -16 / -17 ("token expired", "invalid token",
// "could not authenticate"), or HTTP 401. Codes plus a message match, because the
// exact code varies by endpoint.
export const isAuthError = (err: unknown): boolean => {
	if (!err || typeof err !== 'object') return false
	const e = err as { code?: number; status?: number; message?: string; response?: { status?: number } }
	if (e.code !== undefined && [-8, -15, -16, -17].includes(Number(e.code))) return true
	if (e.status === 401 || e.response?.status === 401) return true
	return /token.{0,20}(expired|invalid)|invalid.{0,20}token|could not authenticate|unauthori[sz]ed|access.?token/i.test(e.message ?? '')
}

const fetchChunk = async (
	symbol: string,
	resolution: string,
	fromMs: number,
	toMs: number,
): Promise<Bar[]> => {
	const response = await historyFn({
		symbol,
		resolution,
		date_format: '1',
		range_from: istDateStringOf(fromMs),
		range_to: istDateStringOf(toMs),
		cont_flag: '1',
	})

	if (response.s === 'no_data') return []
	if (response.s !== 'ok') throw response // keeps code -360 visible to isRateLimitError
	if (!response.candles || response.candles.length === 0) return []
	return toBars(response.candles as unknown[][])
}

export interface FetchSummary {
	symbol: string
	resolution: string
	barsCached: number
	chunksFetched: number
	failed: boolean
	error?: string
}

/**
 * Fill the cache for one symbol at one resolution over the requested window,
 * skipping chunks already covered by the cache.
 */
export const fetchSymbol = async (
	symbol: string,
	resolution: string,
	fromMs: number,
	toMs: number,
	rateLimited: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<FetchSummary> => {
	const chunkDays =
		resolution === DATA.dailyResolution ? DATA.dailyChunkDays : DATA.intradayChunkDays
	const chunkMs = chunkDays * DAY_MS

	const cached = loadSeries(symbol, resolution)
	const haveTs = new Set((cached?.bars ?? []).map((b) => b.t))
	const coverage = loadCoverage(symbol, resolution)

	let chunksFetched = 0
	let barsCached = cached?.bars.length ?? 0

	for (let start = fromMs; start < toMs; start += chunkMs) {
		const end = Math.min(start + chunkMs, toMs)

		// Skip a chunk fully inside the recorded coverage (exact, survives restarts
		// and token expiry). Caches written before coverage existed fall back to
		// the old bar-span heuristic.
		if (isCovered(coverage, start, end)) continue
		if (coverage.length === 0 && cached && cached.bars.length > 0) {
			const covered = cached.bars.some((b) => b.t >= start && b.t < end)
			const spansWholeChunk =
				cached.bars.some((b) => b.t <= start + DAY_MS) &&
				cached.bars.some((b) => b.t >= end - DAY_MS)
			if (covered && spansWholeChunk) continue
		}

		let attempt = 0
		for (;;) {
			try {
				const bars = await rateLimited(() => fetchChunk(symbol, resolution, start, end))
				const fresh = bars.filter((b) => !haveTs.has(b.t))
				if (fresh.length > 0) {
					barsCached = saveSeries(symbol, resolution, bars)
					for (const b of fresh) haveTs.add(b.t)
				}
				// Recorded only after the bars are on disk. The newest range stays open
				// to new data: tomorrow's 'to' is later, so that chunk isn't contained.
				addCoverage(symbol, resolution, start, end)
				chunksFetched++
				break
			} catch (error) {
				// Quota stops (allocation used, daily limit, throttle limit) end the
				// whole fetch — never retried here (the gate already handled throttles).
				if (error instanceof QuotaStopError) throw error
				if (isAuthError(error)) {
					throw new TokenExpiredError(`Fyers rejected the token at ${symbol} (${(error as Error).message ?? JSON.stringify(error)})`)
				}
				// A long fetch is resumable, so after a few retries it is better to
				// record the failure and move on than to stall the whole run.
				if (isRateLimitError(error) && attempt < DATA.maxRetries) {
					const backoff = retryDelayMs(attempt, error)
					console.warn(`[fetch] rate limited on ${symbol} ${resolution}, retry in ${backoff}ms (attempt ${attempt + 1}/${DATA.maxRetries})`)
					await new Promise((r) => setTimeout(r, backoff))
					attempt++
					continue
				}
				return {
					symbol,
					resolution,
					barsCached,
					chunksFetched,
					failed: true,
					error: (error as Error).message ?? String(error),
				}
			}
		}
	}

	return { symbol, resolution, barsCached, chunksFetched, failed: false }
}

export const fetchUniverse = async (
	symbols: string[],
	resolution: string,
	fromMs: number,
	toMs: number,
	opts: { skipAuth?: boolean; gate?: QuotaGate } = {},
): Promise<FetchSummary[]> => {
	ensureDirs()
	if (!opts.skipAuth) {
		const auth = authenticate()
		if (!auth.ok) throw new Error(auth.reason)
	}

	// Every request through the quota gate: 4/s and 40/min, the backtest's nightly
	// allocation in the PC ledger, hard stop on the daily limit, cooldown on throttles.
	const gate = opts.gate ?? backtestGate()
	const limit = <T>(fn: () => Promise<T>): Promise<T> => gate.call(fn)
	const started = realNow()
	const summaries: FetchSummary[] = []

	try {
		// Sequential per symbol so progress logging is legible on a long run; the
		// limiter is what governs throughput, not the concurrency here.
		let done = 0
		for (const symbol of symbols) {
			try {
				summaries.push(await fetchSymbol(symbol, resolution, fromMs, toMs, limit))
			} catch (err) {
				if (err instanceof QuotaStopError) {
					console.error(`\n[fetch] ⏸️ ${err.message}`)
					console.error(`[fetch] Stopped after ${done}/${symbols.length} symbols at res=${resolution}. Everything fetched so far is saved; usage is in ${BACKTEST_LEDGER_FILE}.`)
					console.error('[fetch] Rerun the SAME command on the next allowed evening — only missing chunks are requested.')
				}
				if (err instanceof TokenExpiredError) {
					console.error(`\n[fetch] ⛔ ${err.message}`)
					console.error(`[fetch] Stopped after ${done}/${symbols.length} symbols at res=${resolution}. Everything fetched so far is saved in the cache.`)
					console.error('[fetch] Get a fresh token and rerun the SAME command — already-covered chunks are skipped.')
				}
				throw err
			}
			done++
			if (done % 10 === 0 || done === symbols.length) {
				const secs = ((realNow() - started) / 1000).toFixed(0)
				console.log(`[fetch] res=${resolution} ${done}/${symbols.length} symbols (${secs}s)`)
			}
		}
	} finally {
		// sliding-window limiter holds no timer — nothing to close
	}

	const failed = summaries.filter((s) => s.failed)
	if (failed.length > 0) {
		console.warn(`[fetch] ${failed.length} symbol(s) failed at res=${resolution}:`)
		for (const f of failed.slice(0, 10)) console.warn(`  ${f.symbol}: ${f.error}`)
	}
	return summaries
}
