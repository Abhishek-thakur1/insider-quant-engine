import fyers from 'fyers-api-v3'
import fs from 'fs'
import path from 'path'
import { ENV } from '../config/env.js'
import { redisClient } from '../config/redis.js'
import type { VwapState } from '../core/types.js'

const fyersApi = new fyers.fyersModel({ path: './', enableLogging: false })

const TOKEN_PATH = path.resolve('/app/token', 'access_token.txt')
const WATCHLIST_PATH = path.resolve(process.cwd(), 'watchlist.json')

const getTodayString = (): string => {
	const istDate = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return istDate.toISOString().split('T')[0]!
}

export const seedHistoricalVwap = async (): Promise<void> => {
	console.log('\n[Seeder] 🌱 Initiating Historical VWAP Sync...')

	if (!fs.existsSync(TOKEN_PATH) || !fs.existsSync(WATCHLIST_PATH)) {
		console.error('[Seeder] ❌ Missing auth files. Cannot seed VWAP.')
		return
	}

	const accessToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim()
	const watchlist: string[] = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'))

	// [FIX: MISMATCH] Original seeder only seeded 50 symbols while the engine
	// subscribes to 100. The other 50 symbols had no VWAP filter at open.
	// Now matches the engine's activeUniverse exactly.
	const activeUniverse = watchlist.slice(0, 100)

	fyersApi.setAppId(ENV.FYERS_APP_ID)
	fyersApi.setAccessToken(accessToken)

	const todayStr = getTodayString()
	let successCount = 0
	let failCount = 0

	console.log(`[Seeder] 📥 Downloading intraday data for ${activeUniverse.length} equities...`)

	for (const symbol of activeUniverse) {
		try {
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
					cumulativePV += typicalPrice * volume
					cumulativeVol += volume
				}

				if (cumulativeVol > 0) {
					const state: VwapState = {
						cumulativePV,
						cumulativeVol,
						vwap: cumulativePV / cumulativeVol,
					}
					await redisClient.set(`vwap:${symbol}:${todayStr}`, JSON.stringify(state))
					successCount++
				}
			}
		} catch (error: any) {
			failCount++
			console.error(`[Seeder] ⚠️ Failed: ${symbol}`)
			if (error.response?.data) {
				console.error(`[Fyers]:`, JSON.stringify(error.response.data))
			} else {
				console.error(`[Error]:`, error.message || error)
			}
		}

		// 100ms throttle — respect Fyers API rate limits
		await new Promise((resolve) => setTimeout(resolve, 100))
	}

	console.log(
		`[Seeder] ✅ Done. ${successCount}/${activeUniverse.length} seeded` +
		(failCount > 0 ? ` | ⚠️ ${failCount} failed — VWAP filter disabled for those symbols` : '') +
		'\n',
	)
}