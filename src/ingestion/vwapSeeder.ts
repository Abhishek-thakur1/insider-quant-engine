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
	const activeUniverse = watchlist.slice(0, 50)

	fyersApi.setAppId(ENV.FYERS_APP_ID)
	fyersApi.setAccessToken(accessToken)

	const todayStr = getTodayString()
	let successCount = 0

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
					// [FIX: CORRECTNESS] The original code used close price alone as the price
					// component: cumulativePV += closePrice * volume
					//
					// Standard VWAP uses "typical price" = (high + low + close) / 3
					// This is what every charting platform (TradingView, Zerodha Kite,
					// NSE charts) uses. Using close-only diverges from the market
					// consensus VWAP and causes detectors to see "above VWAP" / "below VWAP"
					// at different levels than institutional traders are watching.
					//
					// [WHAT TO CHANGE]: Replace the single closePrice variable with typicalPrice
					const high = candle[2] as number
					const low = candle[3] as number
					const close = candle[4] as number
					const volume = candle[5] as number

					// [FIX] Use typical price = (H + L + C) / 3
					const typicalPrice = (high + low + close) / 3

					cumulativePV += typicalPrice * volume
					cumulativeVol += volume
				}

				if (cumulativeVol > 0) {
					const finalVwap = cumulativePV / cumulativeVol
					const state: VwapState = {
						cumulativePV,
						cumulativeVol,
						vwap: finalVwap,
					}

					const key = `vwap:${symbol}:${todayStr}`
					await redisClient.set(key, JSON.stringify(state))
					successCount++
				}
			}
		} catch (error: any) {
			console.error(`[Seeder] ⚠️ Failed to fetch history for ${symbol}`)
			if (error.response && error.response.data) {
				console.error(`[Fyers Rejection]:`, JSON.stringify(error.response.data))
			} else {
				console.error(`[System Error]:`, error.message || error)
			}
		}

		await new Promise((resolve) => setTimeout(resolve, 100))
	}

	console.log(
		`[Seeder] ✅ VWAP Sync Complete. ${successCount}/${activeUniverse.length} equities seeded.\n`,
	)
}
