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
//   - Rate limited with the same token-bucket shape as the live seeder,
//     including the deliberately-refed interval (an unrefed timer lets Node
//     exit mid-drain in a standalone run) and a close() in a finally.
// ============================================================

import fyers from 'fyers-api-v3'
import fs from 'fs'
import path from 'path'
import { ENV } from '../../src/config/env.js'
import { DATA } from '../config.js'
import { isPlaceholder } from '../core/bootEnv.js'
import { ensureDirs, loadSeries, saveSeries, type Bar } from './store.js'
import { istDateStringOf, realNow } from '../core/clock.js'

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

// ── token bucket (same shape as the live seeder) ───────────────────────────
const createRateLimiter = (maxPerSecond: number) => {
	const queue: (() => void)[] = []
	let tokens = maxPerSecond
	const timer = setInterval(() => {
		tokens = maxPerSecond
		while (tokens > 0 && queue.length > 0) {
			tokens--
			queue.shift()!()
		}
	}, 1000)

	const limit = <T>(fn: () => Promise<T>): Promise<T> =>
		new Promise((resolve, reject) => {
			const run = () => fn().then(resolve).catch(reject)
			if (tokens > 0) {
				tokens--
				run()
			} else queue.push(run)
		})

	return { limit, close: () => clearInterval(timer) }
}

const isRateLimitError = (error: unknown): boolean => {
	const e = error as { response?: { status?: number; data?: unknown }; message?: string }
	return (
		e?.response?.status === 429 ||
		/rate.?limit/i.test(e?.message ?? '') ||
		/rate.?limit/i.test(JSON.stringify(e?.response?.data ?? ''))
	)
}

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

const fetchChunk = async (
	symbol: string,
	resolution: string,
	fromMs: number,
	toMs: number,
): Promise<Bar[]> => {
	const response = await fyersApi.getHistory({
		symbol,
		resolution,
		date_format: '1',
		range_from: istDateStringOf(fromMs),
		range_to: istDateStringOf(toMs),
		cont_flag: '1',
	})

	if (response.s !== 'ok') {
		throw new Error(`Fyers status=${response.s} ${response.message ?? ''}`)
	}
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

	let chunksFetched = 0
	let barsCached = cached?.bars.length ?? 0

	for (let start = fromMs; start < toMs; start += chunkMs) {
		const end = Math.min(start + chunkMs, toMs)

		// Skip a chunk we already appear to hold. Cheap heuristic: if the cache
		// already has a bar inside every one of this chunk's weekdays, refetching
		// buys nothing. Kept conservative — it only skips when clearly covered.
		if (cached && cached.bars.length > 0) {
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
				chunksFetched++
				break
			} catch (error) {
				if (isRateLimitError(error) && attempt < DATA.maxRetries) {
					const backoff = 1000 * Math.pow(2, attempt + 1)
					console.warn(`[fetch] rate limited on ${symbol} ${resolution}, retry in ${backoff}ms`)
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
): Promise<FetchSummary[]> => {
	ensureDirs()
	const auth = authenticate()
	if (!auth.ok) throw new Error(auth.reason)

	const { limit, close } = createRateLimiter(DATA.maxRequestsPerSecond)
	const started = realNow()
	const summaries: FetchSummary[] = []

	try {
		// Sequential per symbol so progress logging is legible on a long run; the
		// limiter is what governs throughput, not the concurrency here.
		let done = 0
		for (const symbol of symbols) {
			summaries.push(await fetchSymbol(symbol, resolution, fromMs, toMs, limit))
			done++
			if (done % 10 === 0 || done === symbols.length) {
				const secs = ((realNow() - started) / 1000).toFixed(0)
				console.log(`[fetch] res=${resolution} ${done}/${symbols.length} symbols (${secs}s)`)
			}
		}
	} finally {
		close()
	}

	const failed = summaries.filter((s) => s.failed)
	if (failed.length > 0) {
		console.warn(`[fetch] ${failed.length} symbol(s) failed at res=${resolution}:`)
		for (const f of failed.slice(0, 10)) console.warn(`  ${f.symbol}: ${f.error}`)
	}
	return summaries
}
