import fyers, { fyersDataSocket } from 'fyers-api-v3'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ENV } from '../config/env.js'
import { bootRedis, redisClient } from '../config/redis.js'
import { VcpDetector } from '../detectors/vcpDetector.js'
import { VolumeSpikeDetector } from '../detectors/volumeSpikeDetector.js'
import { updateVwap, updateNiftyBias, resetVwap, warnIfVwapMissing } from '../utils/vwapUtils.js'
import type { IDetector } from '../core/types.js'
import { seedHistoricalVwap } from './vwapSeeder.js'
import { CandleBreakoutDetector } from '../detectors/candleBreakoutDetector.js'
import { OrbDetector } from '../detectors/orbDetector.js'
import { NiftyOptionsDetector } from '../detectors/niftyOptionsDetector.js'
import { buildOptionUniverse, updateOptionTick, hasATMShifted } from '../utils/optionUtils.js'
import { VwapPullbackDetector } from '../detectors/vwapPullbackDetector.js'
import { LiquidityTrapDetector } from '../detectors/liquidityTrapDetector.js'
import { VwapCrossoverDetector } from '../detectors/vwapCrossoverDetector.js'
import { ValueZoneScalpDetector } from '../detectors/valueZoneScalpDetector.js'
import { LiquiditySweepDetector } from '../detectors/liquiditySweepDetector.js'

const fyersApi = new fyers.fyersModel({ path: './', enableLogging: false })
const TOKEN_PATH = path.resolve('/app/token', 'access_token.txt')
const WATCHLIST_PATH = path.resolve(process.cwd(), 'watchlist.json')

const NIFTY_SYMBOL = 'NSE:NIFTY50-INDEX'

const strategyRouter = new Map<string, IDetector[]>()
const previousVolumeTracker = new Map<string, number>()

const niftyOptionsDetector = new NiftyOptionsDetector()
const vwapPullbackDetector = new VwapPullbackDetector()
const vwapCrossoverDetector = new VwapCrossoverDetector()
const valueZoneScalpDetector = new ValueZoneScalpDetector()
const liquiditySweepDetector = new LiquiditySweepDetector()

let lastSubscribedNiftySpot = 0
let subscribedOptionSymbols: string[] = []

export const startLiveEngine = async () => {
	console.log(`[Engine] 📡 Booting Institutional Quant Router...`)

	if (!fs.existsSync(TOKEN_PATH) || !fs.existsSync(WATCHLIST_PATH)) {
		console.error('❌ CRITICAL: Missing access_token.txt or watchlist.json.')
		process.exit(1)
	}

	await bootRedis()
	await seedHistoricalVwap()

	const watchlist: string[] = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'))
	const activeUniverse = watchlist.slice(0, 100)
	await warnIfVwapMissing(activeUniverse)

	const accessToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim()

	console.log(`[Engine] ⚙️  Initializing detectors for ${activeUniverse.length} equities...`)

	await Promise.all(
		activeUniverse.map(async (symbol) => {
			strategyRouter.set(symbol, [
				new VcpDetector(symbol),
				new VolumeSpikeDetector(symbol),
				// new CandleBreakoutDetector(symbol),
				new OrbDetector(symbol),
				// new LiquidityTrapDetector(symbol),
			])

			await Promise.all([
				redisClient.del(`memory:vcp:${symbol}`),
				redisClient.del(`baseline:vcp:${symbol}`),
				redisClient.del(`memory:volume:${symbol}`),
				redisClient.del(`cooldown:volume:${symbol}`),
				redisClient.del(`cooldown:vcp:${symbol}`),
				redisClient.del(`candles:${symbol}`),
				redisClient.del(`cooldown:candle:${symbol}`),
				redisClient.del(`cooldown:orb:${symbol}`),
				redisClient.del(`trap_candles:${symbol}`),
				redisClient.del(`cooldown:trap:${symbol}`),

				// Without this, a symbol armed at EOD would re-arm tomorrow
				// before the pattern re-establishes.
				redisClient.del(`armed:vcp:${symbol}`),
				// introduced by the fixed VolumeSpikeDetector.
				redisClient.del(`vol_baseline_candles:${symbol}`),
				// [FIX] Clean up ORB keys persisted by the fixed OrbDetector
				redisClient.del(`orb:15min:high:${symbol}`),
				redisClient.del(`orb:15min:low:${symbol}`),
				redisClient.del(`orb:30min:high:${symbol}`),
				redisClient.del(`orb:30min:low:${symbol}`),
			])
		}),
	)

	await redisClient.del('market:nifty:bias')
	await redisClient.del('cooldown:nifty_options')
	// [FIX] Clean up Nifty-level cooldowns and ORB keys on boot
	await redisClient.del('cooldown:nifty_vwap_pullback')
	await redisClient.del('cooldown:nifty_vwap_crossover')
	await redisClient.del('cooldown:valuezone')
	await redisClient.del(`cooldown:liquidity_sweep:${NIFTY_SYMBOL}`)
	await redisClient.del(`orb:15min:high:${NIFTY_SYMBOL}`)
	await redisClient.del(`orb:15min:low:${NIFTY_SYMBOL}`)
	console.log(`[Engine] 🗺️  Market bias tracking initialized (${NIFTY_SYMBOL})`)

	const cleanAppId = ENV.FYERS_APP_ID.replace(/\s/g, '')
	const cleanToken = accessToken.replace(/\s/g, '')
	const wsToken = `${cleanAppId}:${cleanToken}`

	const skt = fyersDataSocket.getInstance(wsToken, './logs', false)

	skt.on('connect', () => {
		console.log('[Firehose] 🟢 Connected to Fyers Data Servers!')
		const symbolsToSubscribe = [...activeUniverse, NIFTY_SYMBOL, ...subscribedOptionSymbols]
		skt.subscribe(symbolsToSubscribe)
		console.log(`[Firehose] ✅ Subscribed: ${activeUniverse.length} equities + ${NIFTY_SYMBOL}`)
	})

	skt.on('message', async (rawMessage: any) => {
		if (!rawMessage) return

		let ticks: any[] = []

		try {
			const parsed = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage
			if (Array.isArray(parsed)) ticks = parsed
			else if (parsed?.symbol) ticks = [parsed]
			else if (parsed?.data && Array.isArray(parsed.data)) ticks = parsed.data
			else return
		} catch {
			return
		}

		if (ticks.length === 0) return

		await Promise.all(
			ticks.map(async (tick) => {
				if (!tick?.symbol || !tick?.ltp) return

				if (tick.symbol === NIFTY_SYMBOL) {
					const niftyVwap = await updateVwap(NIFTY_SYMBOL, tick.ltp, 1)
					await updateNiftyBias(tick.ltp, niftyVwap)

					const liveTick = {
						price: tick.ltp,
						volume: tick.vol_traded_today || 1,
						timestamp: Date.now(),
					}

					await valueZoneScalpDetector.analyze(liveTick)
					await liquiditySweepDetector.analyze(liveTick)

					if (lastSubscribedNiftySpot === 0 || hasATMShifted(tick.ltp, lastSubscribedNiftySpot)) {
						const newOptionSymbols = buildOptionUniverse(tick.ltp)

						if (subscribedOptionSymbols.length > 0) {
							skt.unsubscribe(subscribedOptionSymbols)
						}

						skt.subscribe(newOptionSymbols)
						subscribedOptionSymbols = newOptionSymbols
						lastSubscribedNiftySpot = tick.ltp

						console.log(
							`[Options] 🔄 Shifted to ${newOptionSymbols.length} options around ATM ${Math.round(tick.ltp / 50) * 50}`,
						)
					}
					return
				}

				if (tick.symbol.includes('CE') || tick.symbol.includes('PE')) {
					updateOptionTick(tick.symbol, {
						ltp: tick.ltp,
						oi: tick.oi ?? 0,
						volume: tick.vol_traded_today ?? 0,
					})
					return
				}

				const cumulativeVol = tick.vol_traded_today || 0
				const previousVol = previousVolumeTracker.get(tick.symbol) || cumulativeVol
				const actualTickVol = cumulativeVol - previousVol

				previousVolumeTracker.set(tick.symbol, cumulativeVol)

				if (actualTickVol > 0) {
					const liveTick = {
						price: tick.ltp,
						volume: actualTickVol,
						timestamp: Date.now(),
					}

					await updateVwap(tick.symbol, liveTick.price, liveTick.volume)

					const strategies = strategyRouter.get(tick.symbol)
					if (strategies) {
						await Promise.all(strategies.map((s) => s.analyze(liveTick)))
					}
				}
			}),
		)
	})

	skt.on('error', (error: any) => console.error('[Firehose] ❌ WebSocket Error:', error))
	skt.on('close', () => console.log('[Firehose] 🔴 WebSocket Closed.'))

	skt.autoreconnect(5)
	skt.connect()
}

const currentFilePath = fileURLToPath(import.meta.url)
if (process.argv[1] === currentFilePath) {
	startLiveEngine()
}
