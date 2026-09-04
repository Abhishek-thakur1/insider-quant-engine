import fyers from 'fyers-api-v3'
import fs from 'fs'
import path from 'path'
import { ENV } from '../config/env.js'
import { redisClient } from '../config/redis.js'
import type { VwapState } from '../core/types.js'

const fyersApi = new fyers.fyersModel({ path: './', enableLogging: false })

const TOKEN_PATH = path.resolve('/app/token', 'access_token.txt')
const WATCHLIST_PATH = path.resolve(process.cwd(), 'watchlist.json')
const NIFTY_SYMBOL = 'NSE:NIFTY50-INDEX'

const getTodayString = (): string => {
	const istDate = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return istDate.toISOString().split('T')[0]!
}

// NSE indices have no traded volume: Fyers returns volume 0 on NIFTY50-INDEX
// candles, and the live tick feed reports vol_traded_today = 0 (which is why
// ingestion falls back to volume:1). A genuinely volume-weighted VWAP is
// therefore impossible from index data alone.
//
// `equalWeight` seeds those symbols as an equal-weight-per-minute mean of the
// candle typical price — a session TWAP. It is a well-defined session reference
// price, NOT a VWAP; see AGENTS.md 6.1 for the higher-fidelity alternative
// (borrowing volume from the Nifty futures contract).
const fetchAndSeedSymbol = async (
	symbol: string,
	todayStr: string,
	equalWeight = false,
): Promise<void> => {
	const response = await fyersApi.getHistory({
		symbol: symbol,
		resolution: '1',
		date_format: '1',
		range_from: todayStr,
		range_to: todayStr,
		cont_flag: '1',
	})

	if (response.s === 'ok' && response.candles && response.candles.length > 0) {
		let cumulativePV = 0
		let cumulativeVol = 0

		// Fyers Candle Format: [epoch_time, open, high, low, close, volume]
		for (const candle of response.candles) {
			const high = candle[2] as number
			const low = candle[3] as number
			const close = candle[4] as number
			const volume = candle[5] as number

			// Standard VWAP: typical price = (H + L + C) / 3
			const typicalPrice = (high + low + close) / 3
			// Index: one unit of weight per minute. Equity: real traded volume.
			const weight = equalWeight ? 1 : volume
			cumulativePV += typicalPrice * weight
			cumulativeVol += weight
		}

		if (cumulativeVol > 0) {
			const state: VwapState = {
				cumulativePV,
				cumulativeVol,
				vwap: cumulativePV / cumulativeVol,
			}
			await redisClient.set(`vwap:${symbol}:${todayStr}`, JSON.stringify(state))
		}
	} else {
		throw new Error(
			`API returned status: ${response.s} - ${response.message || 'No candles found'}`,
		)
	}
}

// ─── Simple token-bucket rate limiter ────────────────────────────────────────
// Refills `maxPerSecond` tokens every second. Callers queue up if no tokens
// are available and get drained in FIFO order as tokens refill.
// IMPORTANT: the interval is intentionally left refed (default) so it keeps
// the event loop alive between bursts, while items sit in the queue waiting
// for their turn — an unrefed timer can let Node exit mid-drain in a
// standalone/cron-triggered run where nothing else is holding the loop open.
// Callers MUST invoke the returned close() once done to avoid leaking the
// interval handle across repeated invocations (e.g. scheduled runs).
const createRateLimiter = (maxPerSecond: number) => {
	const queue: (() => void)[] = []
	let tokens = maxPerSecond

	const timer = setInterval(() => {
		tokens = maxPerSecond
		while (tokens > 0 && queue.length > 0) {
			tokens--
			const next = queue.shift()!
			next()
		}
	}, 1000)

	const limit = <T>(fn: () => Promise<T>): Promise<T> => {
		return new Promise((resolve, reject) => {
			const run = () => {
				fn().then(resolve).catch(reject)
			}
			if (tokens > 0) {
				tokens--
				run()
			} else {
				queue.push(run)
			}
		})
	}

	const close = () => clearInterval(timer)

	return { limit, close }
}

// ─── MAIN: The Rate-Limited VWAP Seeder ──────────────────────────────────────
export const seedHistoricalVwap = async (): Promise<void> => {
	console.log('\n[Seeder] 🌱 Initiating Historical VWAP Sync...')

	if (!fs.existsSync(TOKEN_PATH) || !fs.existsSync(WATCHLIST_PATH)) {
		console.error('[Seeder] ❌ Missing auth files. Cannot seed VWAP.')
		return
	}

	const accessToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim()
	const watchlist: string[] = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'))

	// The active universe tracked by the engine
	const activeUniverse = watchlist.slice(0, 100)

	fyersApi.setAppId(ENV.FYERS_APP_ID)
	fyersApi.setAccessToken(accessToken)

	const todayStr = getTodayString()
	let successCount = 0
	let failCount = 0

	console.log(
		`[Seeder] 📥 Downloading intraday data for ${activeUniverse.length} equities + Nifty index...`,
	)

	// ── RATE LIMIT CONFIGURATION ──
	// Tune MAX_REQ_PER_SEC to Fyers' documented limit for the history/candles
	// endpoint specifically (it is usually stricter than the general API limit).
	const MAX_REQ_PER_SEC = 5
	const MAX_RETRIES = 2

	const { limit: rateLimited, close: closeRateLimiter } = createRateLimiter(MAX_REQ_PER_SEC)

	const runWithRetry = async (symbol: string, equalWeight = false, attempt = 0): Promise<void> => {
		try {
			await rateLimited(() => fetchAndSeedSymbol(symbol, todayStr, equalWeight))
			successCount++
		} catch (error: any) {
			const isRateLimit =
				error?.response?.status === 429 ||
				/rate.?limit/i.test(error?.message || '') ||
				/rate.?limit/i.test(JSON.stringify(error?.response?.data || ''))

			if (isRateLimit && attempt < MAX_RETRIES) {
				const backoffMs = 1000 * Math.pow(2, attempt + 1) // 2s, then 4s
				console.warn(
					`[Seeder] ⏳ Rate limited on ${symbol}, retrying in ${backoffMs}ms (attempt ${
						attempt + 1
					}/${MAX_RETRIES})`,
				)
				await new Promise((resolve) => setTimeout(resolve, backoffMs))
				return runWithRetry(symbol, equalWeight, attempt + 1)
			}

			failCount++
			console.error(`[Seeder] ⚠️ Failed: ${symbol}`)
			if (error.response?.data) {
				console.error(`[Fyers]:`, JSON.stringify(error.response.data))
			} else {
				console.error(`[Error]:`, error.message || error)
			}
		}
	}

	try {
		await Promise.all([
			...activeUniverse.map((symbol) => runWithRetry(symbol)),
			// [FIX] The Nifty index was never seeded — it is not in watchlist.json — so
			// every Nifty detector's VWAP reference used to start from zero at engine
			// boot and reset on any mid-session restart. Seed it as an index (equal
			// weight per minute) so the reference is session-anchored from 09:15.
			runWithRetry(NIFTY_SYMBOL, true),
		])
	} finally {
		// Always clear the interval, even if something throws unexpectedly,
		// so the handle never outlives this run.
		closeRateLimiter()
	}

	console.log(
		`[Seeder] ✅ Done. ${successCount}/${activeUniverse.length + 1} seeded` +
			(failCount > 0 ? ` | ⚠️ ${failCount} failed — VWAP filter disabled for those symbols` : '') +
			'\n',
	)
}

// import fyers from 'fyers-api-v3'
// import fs from 'fs'
// import path from 'path'
// import { ENV } from '../config/env.js'
// import { redisClient } from '../config/redis.js'
// import type { VwapState } from '../core/types.js'

// const fyersApi = new fyers.fyersModel({ path: './', enableLogging: false })

// const TOKEN_PATH = path.resolve('/app/token', 'access_token.txt')
// const WATCHLIST_PATH = path.resolve(process.cwd(), 'watchlist.json')

// const getTodayString = (): string => {
// 	const istDate = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
// 	return istDate.toISOString().split('T')[0]!
// }

// const fetchAndSeedSymbol = async (symbol: string, todayStr: string): Promise<void> => {
// 	const response = await fyersApi.getHistory({
// 		symbol: symbol,
// 		resolution: '1',
// 		date_format: '1',
// 		range_from: todayStr,
// 		range_to: todayStr,
// 		cont_flag: '1',
// 	})

// 	if (response.s === 'ok' && response.candles && response.candles.length > 0) {
// 		let cumulativePV = 0
// 		let cumulativeVol = 0

// 		// Fyers Candle Format: [epoch_time, open, high, low, close, volume]
// 		for (const candle of response.candles) {
// 			const high = candle[2] as number
// 			const low = candle[3] as number
// 			const close = candle[4] as number
// 			const volume = candle[5] as number

// 			// Standard VWAP: typical price = (H + L + C) / 3
// 			const typicalPrice = (high + low + close) / 3
// 			cumulativePV += typicalPrice * volume
// 			cumulativeVol += volume
// 		}

// 		if (cumulativeVol > 0) {
// 			const state: VwapState = {
// 				cumulativePV,
// 				cumulativeVol,
// 				vwap: cumulativePV / cumulativeVol,
// 			}
// 			await redisClient.set(`vwap:${symbol}:${todayStr}`, JSON.stringify(state))
// 		}
// 	} else {
// 		throw new Error(
// 			`API returned status: ${response.s} - ${response.message || 'No candles found'}`,
// 		)
// 	}
// }

// // ─── MAIN: The Batched VWAP Seeder ───────────────────────────────────────────
// export const seedHistoricalVwap = async (): Promise<void> => {
// 	console.log('\n[Seeder] 🌱 Initiating Historical VWAP Sync...')

// 	if (!fs.existsSync(TOKEN_PATH) || !fs.existsSync(WATCHLIST_PATH)) {
// 		console.error('[Seeder] ❌ Missing auth files. Cannot seed VWAP.')
// 		return
// 	}

// 	const accessToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim()
// 	const watchlist: string[] = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'))

// 	// The active universe tracked by the engine
// 	const activeUniverse = watchlist.slice(0, 100)

// 	fyersApi.setAppId(ENV.FYERS_APP_ID)
// 	fyersApi.setAccessToken(accessToken)

// 	const todayStr = getTodayString()
// 	let successCount = 0
// 	let failCount = 0

// 	console.log(`[Seeder] 📥 Downloading intraday data for ${activeUniverse.length} equities...`)

// 	// ── BATCH CONFIGURATION ──
// 	const BATCH_SIZE = 10 // Process 10 stocks concurrently
// 	const DELAY_MS = 500 // Wait half a second before processing the next 10

// 	for (let i = 0; i < activeUniverse.length; i += BATCH_SIZE) {
// 		const batch = activeUniverse.slice(i, i + BATCH_SIZE)

// 		// Process a batch of 10 concurrently
// 		await Promise.all(
// 			batch.map(async (symbol) => {
// 				try {
// 					await fetchAndSeedSymbol(symbol, todayStr)
// 					successCount++
// 				} catch (error: any) {
// 					failCount++
// 					console.error(`[Seeder] ⚠️ Failed: ${symbol}`)
// 					if (error.response?.data) {
// 						console.error(`[Fyers]:`, JSON.stringify(error.response.data))
// 					} else {
// 						console.error(`[Error]:`, error.message || error)
// 					}
// 				}
// 			}),
// 		)

// 		// Pause before hitting the API with the next batch to prevent Rate Limiting
// 		if (i + BATCH_SIZE < activeUniverse.length) {
// 			await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
// 		}
// 	}

// 	console.log(
// 		`[Seeder] ✅ Done. ${successCount}/${activeUniverse.length} seeded` +
// 			(failCount > 0 ? ` | ⚠️ ${failCount} failed — VWAP filter disabled for those symbols` : '') +
// 			'\n',
// 	)
// }
