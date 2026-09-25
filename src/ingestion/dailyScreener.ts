import fyers from 'fyers-api-v3'
import fs from 'fs'
import path from 'path'
import { ENV } from '../config/env.js'

const fyersApi = new fyers.fyersModel({ path: './', enableLogging: false })

const TOKEN_PATH = path.resolve('/app/token', 'access_token.txt')
const UNIVERSE_PATH = path.resolve(process.cwd(), 'fyersUniverse.json')
const WATCHLIST_PATH = path.resolve(process.cwd(), 'watchlist.json')
const CORE_WATCHLIST_PATH = path.resolve(process.cwd(), 'core_watchlist.json')
const STATS_PATH = path.resolve(process.cwd(), 'universe_stats.json')

const MIN_TURNOVER = 15_000_000 * 10 // ₹15 Crore
const MIN_ADR_PERCENT = 4.5

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

export const runDailyScreen = async () => {
	console.log('\n[Screener] 🔍 Starting Daily Universe Screen...')

	if (!fs.existsSync(TOKEN_PATH) || !fs.existsSync(UNIVERSE_PATH)) {
		console.error('[Screener] ❌ Missing access_token.txt or fyersUniverse.json')
		return
	}

	const accessToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim()
	const fullUniverse: string[] = JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf8'))
	
	let coreWatchlist: string[] = []
	if (fs.existsSync(CORE_WATCHLIST_PATH)) {
		coreWatchlist = JSON.parse(fs.readFileSync(CORE_WATCHLIST_PATH, 'utf8'))
	}

	fyersApi.setAppId(ENV.FYERS_APP_ID)
	fyersApi.setAccessToken(accessToken)

	const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000) // IST
	const todayStr = now.toISOString().split('T')[0]!
	
	// Fetch 45 calendar days to ensure we get 30 trading days
	const pastDate = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000)
	const pastDateStr = pastDate.toISOString().split('T')[0]!

	const MAX_REQ_PER_SEC = 5
	const MAX_RETRIES = 2
	const { limit: rateLimited, close: closeRateLimiter } = createRateLimiter(MAX_REQ_PER_SEC)

	const statsMap: Record<string, { advShares: number; adr: number; turnover: number; close: number }> = {}
	const shortlist: string[] = []
	
	let processed = 0
	let passed = 0

	const analyzeSymbol = async (symbol: string, attempt = 0): Promise<void> => {
		try {
			const response: any = await rateLimited(() =>
				fyersApi.getHistory({
					symbol,
					resolution: 'D',
					date_format: '1',
					range_from: pastDateStr,
					range_to: todayStr,
					cont_flag: '1',
				}),
			)

			if (response.s === 'ok' && response.candles && response.candles.length >= 20) {
				// We need at least 20 days for ADR
				const candles = response.candles
				
				// Take up to last 30 days
				const last30 = candles.slice(-30)
				const last20 = candles.slice(-20)

				let totalTurnover = 0
				let totalShares = 0
				for (const c of last30) {
					const close = c[4]
					const vol = c[5]
					totalTurnover += close * vol
					totalShares += vol
				}
				const avgTurnover = totalTurnover / last30.length
				const advShares = totalShares / last30.length

				let totalADR = 0
				for (const c of last20) {
					const high = c[2]
					const low = c[3]
					const close = c[4]
					totalADR += ((high - low) / close) * 100
				}
				const avgADR = totalADR / last20.length
				
				const lastClose = candles[candles.length - 1][4]

				statsMap[symbol] = {
					advShares,
					adr: avgADR,
					turnover: avgTurnover,
					close: lastClose
				}

				if (avgTurnover >= MIN_TURNOVER && avgADR >= MIN_ADR_PERCENT) {
					shortlist.push(symbol)
					passed++
				}
			}
			processed++
			if (processed % 100 === 0) {
				console.log(`[Screener] Processed ${processed}/${fullUniverse.length}. Found ${passed} candidates.`)
			}
		} catch (error: any) {
			const isRateLimit =
				error?.response?.status === 429 ||
				/rate.?limit/i.test(error?.message || '') ||
				/rate.?limit/i.test(JSON.stringify(error?.response?.data || ''))

			if (isRateLimit && attempt < MAX_RETRIES) {
				const backoffMs = 1000 * Math.pow(2, attempt + 1)
				await new Promise((resolve) => setTimeout(resolve, backoffMs))
				return analyzeSymbol(symbol, attempt + 1)
			}
			processed++
		}
	}

	try {
		await Promise.all(fullUniverse.map((s) => analyzeSymbol(s)))
		
		fs.writeFileSync(STATS_PATH, JSON.stringify(statsMap, null, 2))
		console.log(`[Screener] 💾 Saved stats for ${Object.keys(statsMap).length} symbols to ${STATS_PATH}`)

		const finalWatchlist = Array.from(new Set([...coreWatchlist, ...shortlist]))
		fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(finalWatchlist, null, 2))
		
		console.log(`[Screener] ✅ Daily screen complete. Final watchlist size: ${finalWatchlist.length} (Core + Layer A).`)
		console.log(`[Screener] Note: Market Cap filtering was omitted as Fyers does not provide fundamental data.`)
	} finally {
		closeRateLimiter()
	}
}

import { fileURLToPath } from 'url'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	runDailyScreen().catch(console.error)
}
