import fyers from 'fyers-api-v3'
const fyersApi = new fyers.fyersModel({ path: './', enableLogging: false })
import fs from 'fs'
import { AnomalyScanner } from '../src/ingestion/anomalyScanner.js'

// Hardcoded for testing; the real engine reads .env and token_store
const APP_ID = process.env.FYERS_APP_ID!
const TOKEN_PATH = '/app/token/access_token.txt'

async function run() {
	if (!fs.existsSync(TOKEN_PATH)) {
		console.error(`❌ Token not found at ${TOKEN_PATH}`)
		process.exit(1)
	}

	fyersApi.setAppId(APP_ID)
	fyersApi.setAccessToken(fs.readFileSync(TOKEN_PATH, 'utf-8').trim())

	const symbols = ['NSE:KSCL-EQ', 'NSE:HGINFRA-EQ']
	const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0]!

	const scanner = new AnomalyScanner()
	
	const STATS_PATH = '/app/universe_stats.json'
	if (fs.existsSync(STATS_PATH)) {
		const realStats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8'))
		;(scanner as any).stats = realStats
		console.log('✅ Loaded real baseline stats from universe_stats.json')
	} else {
		console.log('⚠️ universe_stats.json not found! Falling back to mocked ADV stats.')
		;(scanner as any).stats = {
			'NSE:KSCL-EQ': { advShares: 500_000 },     // Assume 500k ADV -> 25k 5min threshold
			'NSE:HGINFRA-EQ': { advShares: 1_000_000 }, // Assume 1M ADV -> 50k 5min threshold
		}
	}

	for (const sym of symbols) {
		console.log(`\n📊 Fetching 1-min candles for ${sym}...`)
		const res = await fyersApi.getHistory({
			symbol: sym,
			resolution: '1',
			date_format: '1',
			range_from: today,
			range_to: today,
			cont_flag: '1'
		})

		if (res.s !== 'ok' || !res.candles) {
			console.log(`❌ Failed to fetch data for ${sym}:`, res)
			continue
		}

		console.log(`✅ Loaded ${res.candles.length} candles for ${sym}. Simulating scanner...`)
		let promoted = false
		scanner.onPromote = (s, reason) => {
			console.log(`🚀 [PROMOTION TRIGGERED] ${s} at candle close! Reason: ${reason}`)
			promoted = true
		}

		let cumulativeVol = 0
		const activeSet = new Set<string>()

		for (const candle of res.candles) {
			// candle: [epoch, O, H, L, C, V]
			const close = candle[4]
			const vol = candle[5]
			cumulativeVol += vol

			// Feed the candle close as a tick
			scanner.updateTick(sym, close, cumulativeVol)
			;(scanner as any).processMinuteBoundary(activeSet)

			if (promoted) {
				console.log(`   (Trigger timestamp: ${new Date(candle[0] * 1000).toISOString()})`)
				break // Stop simulating after first promotion
			}
		}

		if (!promoted) {
			console.log(`   ⚠️ Never triggered on ${sym} today. (Did the move take longer than 5 mins?)`)
		}
	}
}

run().catch(console.error)
