import fyers from 'fyers-api-v3'
import fs from 'fs'
import path from 'path'
import { ENV } from '../config/env.js'
import { redisClient } from '../config/redis.js'
import type { VwapState } from '../core/types.js'
import { resolveScreenerFile } from '../screener/paths.js'
import { getISTMinutes } from '../utils/marketHours.js'
import { VWAP_TTL_SECS } from '../utils/vwapUtils.js'
import { createSlidingWindowLimiter, isRateLimitError, retryDelayMs, type LimiterClock } from '../utils/rateLimit.js'
import { QuotaStopError, type QuotaGate } from '../fyers/quota.js'
import { engineGate } from '../fyers/engineGates.js'

const fyersApi = new fyers.fyersModel({ path: './', enableLogging: false })

const TOKEN_PATH = path.resolve('/app/token', 'access_token.txt')
const WATCHLIST_PATH = resolveScreenerFile('watchlist.json')
const NIFTY_SYMBOL = 'NSE:NIFTY50-INDEX'

export const getTodayString = (): string => {
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
export const fetchAndSeedSymbol = async (
	symbol: string,
	todayStr: string,
	equalWeight = false,
): Promise<'SEEDED' | 'NO_DATA'> => {
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
			await redisClient.setEx(`vwap:${symbol}:${todayStr}`, VWAP_TTL_SECS, JSON.stringify(state))
			return 'SEEDED'
		}
		return 'NO_DATA' // candles but zero total weight (e.g. all-zero volume)
	} else if (response.s === 'no_data' || (response.s === 'ok' && (!response.candles || response.candles.length === 0))) {
		// Fyers answers s:'no_data' before the open or for an inactive symbol — not an error.
		console.warn(`[Seeder] ⚠️ No candles for ${symbol}. Market may be closed, delayed, or symbol inactive.`)
		return 'NO_DATA'
	} else {
		throw new Error(
			`API returned status: ${response.s} - ${response.message || 'No candles found'}`,
		)
	}
}

// ─── Seeding core (pure; I/O injected so tests can run it on virtual time) ───
export type SeedOutcome = 'SEEDED' | 'ALREADY_SEEDED' | 'NO_DATA' | 'FAILED'

export interface SeedDeps {
	fetch: (symbol: string, equalWeight: boolean) => Promise<'SEEDED' | 'NO_DATA'>
	isSeeded: (symbol: string) => Promise<boolean>
	clock?: LimiterClock
	log?: Pick<Console, 'warn' | 'error'>
	maxPerSecond?: number
	maxRetries?: number
	rand?: () => number
	/** Production: the engine's shared Fyers quota gate. Without it: local 4/s limiter + retries (tests). */
	gate?: QuotaGate
}

// Fyers Standard plan: 5 req/s. 4 leaves headroom for the anomaly scanner's
// promotion seeds, which share the same API key.
export const SEED_MAX_PER_SECOND = 4
export const SEED_MAX_RETRIES = 3

export const seedSymbols = async (
	symbols: { symbol: string; equalWeight: boolean }[],
	deps: SeedDeps,
): Promise<Map<string, SeedOutcome>> => {
	const clock = deps.clock ?? { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }
	const log = deps.log ?? console
	const maxRetries = deps.maxRetries ?? SEED_MAX_RETRIES
	const { limit } = createSlidingWindowLimiter(deps.maxPerSecond ?? SEED_MAX_PER_SECOND, 1000, clock)
	const outcomes = new Map<string, SeedOutcome>()

	let stopped: QuotaStopError | null = null
	const seedOne = async (symbol: string, equalWeight: boolean): Promise<SeedOutcome> => {
		// Mid-session restart: keep the live-accumulated VWAP, spend no API call.
		if (await deps.isSeeded(symbol).catch(() => false)) return 'ALREADY_SEEDED'
		if (stopped) return 'FAILED'
		if (deps.gate) {
			// The gate paces (4/s, 40/min), retries throttles after a cooldown and stops on quota.
			try {
				return await deps.gate.call(() => deps.fetch(symbol, equalWeight))
			} catch (error: unknown) {
				if (error instanceof QuotaStopError) {
					if (!stopped) log.error(`[Seeder] ⛔ ${error.message} — remaining symbols not seeded (VWAP builds from live ticks)`)
					stopped ??= error
				} else log.error(`[Seeder] ⚠️ Failed: ${symbol}`, error)
				return 'FAILED'
			}
		}
		for (let attempt = 0; ; attempt++) {
			try {
				return await limit(() => deps.fetch(symbol, equalWeight))
			} catch (error: unknown) {
				if (isRateLimitError(error) && attempt < maxRetries) {
					const waitMs = retryDelayMs(attempt, error, deps.rand)
					log.warn(`[Seeder] ⏳ Rate limited on ${symbol}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`)
					await clock.sleep(waitMs)
					continue
				}
				const data = (error as { response?: { data?: unknown } } | null)?.response?.data
				log.error(`[Seeder] ⚠️ Failed: ${symbol}`, data ? JSON.stringify(data) : error)
				return 'FAILED'
			}
		}
	}

	await Promise.all(
		symbols.map(async ({ symbol, equalWeight }) => {
			outcomes.set(symbol, await seedOne(symbol, equalWeight))
		}),
	)
	return outcomes
}

// ─── MAIN: The Rate-Limited VWAP Seeder ──────────────────────────────────────
export const seedHistoricalVwap = async (nowMs = Date.now()): Promise<void> => {
	console.log('\n[Seeder] 🌱 Initiating Historical VWAP Sync...')

	// The engine boots at 09:00. Before the 09:15 open there are no intraday
	// candles: every request returns no_data (Oct 19: 0/26 seeded, 26 calls
	// spent, several -360s). VWAP then builds from live ticks, as it did anyway.
	if (getISTMinutes(nowMs) < 9 * 60 + 15) {
		console.log('[Seeder] ⏭️ Before 09:15 IST — no intraday candles exist yet. Skipping; VWAP builds from live ticks.\n')
		return
	}

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
	console.log(
		`[Seeder] 📥 Downloading intraday data for ${activeUniverse.length} equities + Nifty index (≤ ${SEED_MAX_PER_SECOND} req/s)...`,
	)

	const outcomes = await seedSymbols(
		[
			...activeUniverse.map((symbol) => ({ symbol, equalWeight: false })),
			// [FIX] The Nifty index is not in watchlist.json; seed it as an index
			// (equal weight per minute) so the reference is session-anchored.
			{ symbol: NIFTY_SYMBOL, equalWeight: true },
		],
		{
			fetch: (symbol, equalWeight) => fetchAndSeedSymbol(symbol, todayStr, equalWeight),
			isSeeded: async (symbol) => (await redisClient.exists(`vwap:${symbol}:${todayStr}`)) === 1,
			gate: engineGate('seeder'),
		},
	)

	const count = (o: SeedOutcome) => [...outcomes.values()].filter((v) => v === o).length
	const failed = count('FAILED')
	console.log(
		`[Seeder] ✅ Done. ${count('SEEDED')} seeded, ${count('ALREADY_SEEDED')} already seeded today, ` +
			`${count('NO_DATA')} no data, ${failed} failed of ${outcomes.size}` +
			(failed > 0 ? ' — VWAP filter disabled for the failed symbols' : '') +
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
