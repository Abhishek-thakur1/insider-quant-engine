import fyers, { fyersDataSocket } from 'fyers-api-v3'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { ENV } from '../config/env.js'
import { bootRedis, redisClient } from '../config/redis.js'
import { updateVwap, updateNiftyBias, warnIfVwapMissing } from '../utils/vwapUtils.js'
import { buildOptionUniverse, updateOptionTick, hasATMShifted } from '../utils/optionUtils.js'
import { seedHistoricalVwap } from './vwapSeeder.js'
import { feedTick } from '../utils/candleAggregator.js'

// [NEW] Regime detector feed
import { pushNiftyReturn } from '../utils/regimeDetector.js'

// Nifty detectors
import { OiLiquiditySweepDetector } from '../detectors/oiLiquiditySweepDetector.js'
import { DeltaHedgingPressureDetector } from '../detectors/deltahedgingpressuredetector.js'

// Equity detectors — full stack re-enabled

import { NiftyTrendPulseDetector } from '../detectors/v2/niftyTrendPulseDetector.js'
import { NiftyVwapReclaimDetector } from '../detectors/v2/niftyVwapReclaimDetector.js'
import { NiftyOpeningRangeExplosionDetector } from '../detectors/v2/niftyOpeningRangeExplosionDetector.js'
import { StockMomentumBreakoutDetector } from '../detectors/v2/stockMomentumBreakoutDetector.js'
import type { IDetector, TickData } from '../core/types.js'
import { fileURLToPath } from 'url'
import { NiftyLiquiditySweep } from '../detectors/v2/high_alpha/NiftyLiquiditySweep.js'
import { VolatilityContraction } from '../detectors/v2/high_alpha/VolatilityContraction.js'
import { GapAndGoMomentum } from '../detectors/v2/high_alpha/GapAndGoMomentum.js'

const NIFTY_SYMBOL = 'NSE:NIFTY50-INDEX'

// ── [NEW] Nifty 1-min candle tracker for regime detection ────────────────────
// Builds 1-minute candles from Nifty spot ticks.
// On each candle close: computes return % → pushes to Shannon entropy engine.
// This is the ONLY data source the regime detector uses.
interface RegimeCandle {
	open: number
	close: number
	startTs: number
}

const REGIME_CANDLE_MS = 60 * 1000 // 1-minute candles
let _regimeCandle: RegimeCandle | null = null

const updateRegimeCandle = async (price: number): Promise<void> => {
	const now = Date.now()

	if (!_regimeCandle) {
		_regimeCandle = { open: price, close: price, startTs: now }
		return
	}

	if (now - _regimeCandle.startTs < REGIME_CANDLE_MS) {
		// Still building this candle
		_regimeCandle.close = price
		return
	}

	// Candle closed — compute return and push to regime engine
	const returnPct = ((_regimeCandle.close - _regimeCandle.open) / _regimeCandle.open) * 100
	await pushNiftyReturn(returnPct)

	// Start new candle
	_regimeCandle = { open: price, close: price, startTs: now }
}
// ── END regime candle tracker ─────────────────────────────────────────────────

// Engine State
const strategyRouter = new Map<string, IDetector[]>()
const previousVolumeTracker = new Map<string, number>()
let lastSubscribedNiftySpot = 0
let subscribedOptionSymbols: string[] = []
let isShuttingDown = false

// ─── THE ARCHITECTURE UPGRADE: DECOUPLED EVENT BUS ───
const tickEmitter = new EventEmitter()
tickEmitter.setMaxListeners(200)

// High-Conviction Nifty Singleton Detectors
const oiSweepDetector = new OiLiquiditySweepDetector()
const niftyTrendPulse = new NiftyTrendPulseDetector()
const niftyVwapReclaim = new NiftyVwapReclaimDetector()
const niftyOpeningRangeExpl = new NiftyOpeningRangeExplosionDetector()
const deltaHedgingDetector = new DeltaHedgingPressureDetector()
const v2NiftySweepDetector = new NiftyLiquiditySweep()

export const startLiveEngine = async () => {
	console.log(`[Engine] 📡 Booting Institutional Quant Router with Jane Street Filter...`)

	const TOKEN_PATH = path.resolve('/app/token', 'access_token.txt')
	const WATCHLIST_PATH = path.resolve(process.cwd(), 'watchlist.json')

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

	// ── Boot Cleanup & Strategy Routing ──────────────────────────────────────
	await Promise.all(
		activeUniverse.map(async (symbol) => {
			strategyRouter.set(symbol, [
				new StockMomentumBreakoutDetector(symbol),
				new VolatilityContraction(symbol),
				new GapAndGoMomentum(symbol),
			])

			// Full boot cleanup — all detector state reset for new session
			await Promise.all([
				redisClient.del(`cooldown:v2:momentum:${symbol}`),
				redisClient.del(`v2:session_open:${symbol}`),
				redisClient.del(`v2:cooldown:vcp:${symbol}`),
				redisClient.del(`v2:cooldown:gapgo:${symbol}`),
				redisClient.del(`v2:vcp_history:${symbol}`),
			])
		}),
	)

	// Clear regime data from previous session so today starts fresh
	await Promise.all([
		redisClient.del('cooldown:v2:nifty_pulse'),
		redisClient.del('cooldown:v2:vwap_reclaim'),
		redisClient.del('cooldown:v2:nifty_ore'),
		redisClient.del('cooldown:oi_sweep'),
		redisClient.del('cooldown:delta_squeeze'),
		redisClient.del('market:nifty:bias'),
		redisClient.del('regime:nifty:returns_1min'),
		redisClient.del('regime:nifty:current'),
		redisClient.del('jsfilter:decisions'),
		redisClient.del(`v2:state:nifty_sweep`),
		redisClient.del(`v2:cooldown:nifty_sweep`),
	])

	console.log('[Engine] ✅ Full boot cleanup complete.')
	console.log(`[Engine] 📡 Equity stack: 9 detectors × ${activeUniverse.length} stocks`)
	console.log('[Engine] 📡 Nifty stack:  OI Sweep + Value Zone + Delta Hedging')
	console.log(
		'[Engine] 🧮 JaneStreetFilter ACTIVE — all signals gated (Regime → Bayes → EV → Kelly)',
	)

	// ─── ASYNCHRONOUS PROCESSING LAYER ───
	tickEmitter.on('processTick', async (tickData) => {
		try {
			const { rawTick, liveTick } = tickData

			// 1. Route Nifty Spot
			if (rawTick.symbol === NIFTY_SYMBOL) {
				const niftyVwap = await updateVwap(NIFTY_SYMBOL, rawTick.ltp, 1)
				await updateNiftyBias(rawTick.ltp, niftyVwap)

				// Feed Nifty price into regime candle builder (non-blocking)
				updateRegimeCandle(rawTick.ltp).catch((e) =>
					console.error('[Regime] Candle update error:', e),
				)

				feedTick(NIFTY_SYMBOL, rawTick.ltp, liveTick.volume)

				await niftyOpeningRangeExpl.analyze(liveTick)
				await niftyTrendPulse.analyze(liveTick)
				await niftyVwapReclaim.analyze(liveTick)
				await oiSweepDetector.analyze(liveTick)
				await deltaHedgingDetector.analyze(liveTick)
				await v2NiftySweepDetector.analyze(liveTick)

				// Option Chain Dynamic Rolling
				if (lastSubscribedNiftySpot === 0 || hasATMShifted(rawTick.ltp, lastSubscribedNiftySpot)) {
					const newOpts = buildOptionUniverse(rawTick.ltp)
					if (subscribedOptionSymbols.length > 0) skt.unsubscribe(subscribedOptionSymbols)
					skt.subscribe(newOpts)
					subscribedOptionSymbols = newOpts
					lastSubscribedNiftySpot = rawTick.ltp
					console.log(
						`[Options] 🔄 Subscribed ${newOpts.length} strikes around ATM ${Math.round(rawTick.ltp / 50) * 50}`,
					)
				}
				return
			}

			// 2. Route Options Data
			if (rawTick.symbol.includes('CE') || rawTick.symbol.includes('PE')) {
				updateOptionTick(rawTick.symbol, {
					ltp: rawTick.ltp,
					oi: rawTick.oi ?? 0,
					volume: rawTick.vol_traded_today ?? 0,
				})
				const match = rawTick.symbol.match(/NIFTY\d{4,6}(\d{4,6})(CE|PE)$/)
				if (match) {
					deltaHedgingDetector.updateStrikeTick(
						rawTick.symbol,
						parseInt(match[1]!),
						match[2] as 'CE' | 'PE',
						rawTick.ltp,
						rawTick.oi ?? 0,
					)
				}
				return
			}

			// 3. Route Equities
			await updateVwap(rawTick.symbol, liveTick.price, liveTick.volume)
			feedTick(rawTick.symbol, liveTick.price, liveTick.volume)
			const strategies = strategyRouter.get(rawTick.symbol)
			if (strategies) {
				await Promise.all(strategies.map((s) => s.analyze(liveTick)))
			}
		} catch (err) {
			console.error(`[Processing Error] ${tickData?.rawTick?.symbol}:`, err)
		}
	})

	// ─── SYNCHRONOUS INGESTION FIREHOSE ───
	const cleanAppId = ENV.FYERS_APP_ID.replace(/\s/g, '')
	const cleanToken = accessToken.replace(/\s/g, '')
	const skt = fyersDataSocket.getInstance(`${cleanAppId}:${cleanToken}`, './logs', false)

	skt.on('connect', () => {
		console.log('[Firehose] 🟢 Connected to Fyers Data Servers!')
		skt.subscribe([...activeUniverse, NIFTY_SYMBOL, ...subscribedOptionSymbols])
	})

	skt.on('message', (rawMessage: any) => {
		if (!rawMessage || isShuttingDown) return

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

		for (const tick of ticks) {
			if (!tick?.symbol || !tick?.ltp) continue

			const cumulativeVol = tick.vol_traded_today || 0
			// Use ?? so we don't accidentally fallback to cumulativeVol if it was recorded as 0
			const previousVol = previousVolumeTracker.get(tick.symbol) ?? cumulativeVol
			const actualTickVol = Math.max(0, cumulativeVol - previousVol)

			// FIX: ALWAYS track the volume regardless of asset class so the *next* tick diff is correct
			previousVolumeTracker.set(tick.symbol, cumulativeVol)

			const isIndexOrOption =
				tick.symbol === NIFTY_SYMBOL || tick.symbol.includes('CE') || tick.symbol.includes('PE')

			// FIX: Only discard zero-volume ticks for equities (preventing false bid/ask ticks from firing logic)
			if (!isIndexOrOption && actualTickVol <= 0) {
				continue
			}

			const liveTick: TickData = {
				price: tick.ltp,
				volume: actualTickVol || 1, // Fallback to 1 ensures zero-volume index ticks don't break VWAP division
				timestamp: Date.now(),
			}

			tickEmitter.emit('processTick', { rawTick: tick, liveTick })
		}
	})

	const shutdown = async (signal: string) => {
		if (isShuttingDown) return
		isShuttingDown = true
		console.log(`\n[Engine] 🛑 ${signal} received. Shutting down gracefully...`)
		try {
			skt.close()
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 3000))
		try {
			await redisClient.quit()
		} catch {}
		process.exit(0)
	}

	process.on('SIGTERM', () => shutdown('SIGTERM'))
	process.on('SIGINT', () => shutdown('SIGINT'))

	skt.autoreconnect(5)
	skt.connect()
}

const currentFilePath = fileURLToPath(import.meta.url)
if (process.argv[1] === currentFilePath) {
	startLiveEngine()
}

// import fyers, { fyersDataSocket } from 'fyers-api-v3'
// import fs from 'fs'
// import path from 'path'
// import { EventEmitter } from 'events'
// import { ENV } from '../config/env.js'
// import { bootRedis, redisClient } from '../config/redis.js'
// import { updateVwap, updateNiftyBias, warnIfVwapMissing } from '../utils/vwapUtils.js'
// import { buildOptionUniverse, updateOptionTick, hasATMShifted } from '../utils/optionUtils.js'
// import { seedHistoricalVwap } from './vwapSeeder.js'

// // Detectors
// import { OiLiquiditySweepDetector } from '../detectors/oiLiquiditySweepDetector.js'
// import { ValueZoneScalpDetector } from '../detectors/valueZoneScalpDetector.js'
// import { MultiTimeframeBreakoutDetector } from '../detectors/Multitimeframebreakoutdetector.js'
// import type { IDetector, TickData } from '../core/types.js'
// import { EquityLiquiditySweepDetector } from '../detectors/equityLiquiditySweepDetector.js'
// import { MorningMomentumDetector } from '../detectors/morningMomentumDetector.js'
// import { fileURLToPath } from 'url'
// import { DeltaHedgingPressureDetector } from '../detectors/deltahedgingpressuredetector.js'
// import { SmartMoneyDivergenceDetector } from '../detectors/smartmoneydivergencedetector.js'

// const NIFTY_SYMBOL = 'NSE:NIFTY50-INDEX'

// // Engine State
// const strategyRouter = new Map<string, IDetector[]>()
// const previousVolumeTracker = new Map<string, number>()
// let lastSubscribedNiftySpot = 0
// let subscribedOptionSymbols: string[] = []
// let isShuttingDown = false

// // ─── THE ARCHITECTURE UPGRADE: DECOUPLED EVENT BUS ───
// const tickEmitter = new EventEmitter()
// // Increase listener limit to prevent memory leak warnings under high load
// tickEmitter.setMaxListeners(200)

// // High-Conviction Nifty Singleton Detectors
// const oiSweepDetector = new OiLiquiditySweepDetector()
// const valueZoneScalpDetector = new ValueZoneScalpDetector()
// const deltaHedgingDetector = new DeltaHedgingPressureDetector()

// export const startLiveEngine = async () => {
// 	console.log(`[Engine] 📡 Booting Institutional Quant Router...`)

// 	const TOKEN_PATH = path.resolve('/app/token', 'access_token.txt')
// 	const WATCHLIST_PATH = path.resolve(process.cwd(), 'watchlist.json')

// 	if (!fs.existsSync(TOKEN_PATH) || !fs.existsSync(WATCHLIST_PATH)) {
// 		console.error('❌ CRITICAL: Missing access_token.txt or watchlist.json.')
// 		process.exit(1)
// 	}

// 	await bootRedis()
// 	await seedHistoricalVwap()

// 	const watchlist: string[] = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'))
// 	const activeUniverse = watchlist.slice(0, 100)
// 	await warnIfVwapMissing(activeUniverse)

// 	const accessToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim()

// 	// ── Boot Cleanup & Strategy Routing ──
// 	await Promise.all(
// 		activeUniverse.map(async (symbol) => {
// 			// Stripped down to the highest-conviction equity detector
// 			strategyRouter.set(symbol, [
// 				new MultiTimeframeBreakoutDetector(symbol),
// 				new EquityLiquiditySweepDetector(symbol),
// 				new MorningMomentumDetector(symbol),
// 				new SmartMoneyDivergenceDetector(symbol),
// 			])

// 			// Clean up state (omitted full list for brevity, keep your existing cleanup here)
// 			await redisClient.del(`cooldown:mtf_breakout:${symbol}`)
// 			await redisClient.del(`cooldown:eq_sweep:${symbol}`)
// 			await redisClient.del(`cooldown:smd:${symbol}`)
// 		}),
// 	)

// 	console.log('[Engine] ✅ Boot cleanup complete.')
// 	console.log('[Engine] 🆕 OiLiquiditySweepDetector ACTIVE on Nifty')

// 	// ─── ASYNCHRONOUS PROCESSING LAYER ───
// 	tickEmitter.on('processTick', async (tickData) => {
// 		try {
// 			const { rawTick, liveTick } = tickData

// 			// 1. Route Nifty Spot
// 			if (rawTick.symbol === NIFTY_SYMBOL) {
// 				const niftyVwap = await updateVwap(NIFTY_SYMBOL, rawTick.ltp, 1)
// 				await updateNiftyBias(rawTick.ltp, niftyVwap)

// 				await oiSweepDetector.analyze(liveTick)
// 				await valueZoneScalpDetector.analyze(liveTick)
// 				await deltaHedgingDetector.analyze(liveTick)

// 				// Option Chain Dynamic Rolling
// 				if (lastSubscribedNiftySpot === 0 || hasATMShifted(rawTick.ltp, lastSubscribedNiftySpot)) {
// 					const newOpts = buildOptionUniverse(rawTick.ltp)
// 					if (subscribedOptionSymbols.length > 0) skt.unsubscribe(subscribedOptionSymbols)
// 					skt.subscribe(newOpts)
// 					subscribedOptionSymbols = newOpts
// 					lastSubscribedNiftySpot = rawTick.ltp
// 					console.log(
// 						`[Options] 🔄 Subscribed ${newOpts.length} strikes around ATM ${Math.round(rawTick.ltp / 50) * 50}`,
// 					)
// 				}
// 				return
// 			}

// 			// 2. Route Options Data (Update OI/Premium state natively)
// 			if (rawTick.symbol.includes('CE') || rawTick.symbol.includes('PE')) {
// 				updateOptionTick(rawTick.symbol, {
// 					ltp: rawTick.ltp,
// 					oi: rawTick.oi ?? 0,
// 					volume: rawTick.vol_traded_today ?? 0,
// 				})
// 				// Feed delta hedging detector with live premium + OI per strike
// 				const match = rawTick.symbol.match(/NIFTY\d{4,6}(\d{4,6})(CE|PE)$/)
// 				if (match) {
// 					deltaHedgingDetector.updateStrikeTick(
// 						rawTick.symbol,
// 						parseInt(match[1]!),
// 						match[2] as 'CE' | 'PE',
// 						rawTick.ltp,
// 						rawTick.oi ?? 0,
// 					)
// 				}
// 				return
// 			}

// 			// 3. Route Equities
// 			await updateVwap(rawTick.symbol, liveTick.price, liveTick.volume)
// 			const strategies = strategyRouter.get(rawTick.symbol)
// 			if (strategies) {
// 				await Promise.all(strategies.map((s) => s.analyze(liveTick)))
// 			}
// 		} catch (err) {
// 			console.error(`[Processing Error] ${tickData?.rawTick?.symbol}:`, err)
// 		}
// 	})

// 	// ─── SYNCHRONOUS INGESTION FIREHOSE ───
// 	const cleanAppId = ENV.FYERS_APP_ID.replace(/\s/g, '')
// 	const cleanToken = accessToken.replace(/\s/g, '')
// 	const skt = fyersDataSocket.getInstance(`${cleanAppId}:${cleanToken}`, './logs', false)

// 	skt.on('connect', () => {
// 		console.log('[Firehose] 🟢 Connected to Fyers Data Servers!')
// 		skt.subscribe([...activeUniverse, NIFTY_SYMBOL, ...subscribedOptionSymbols])
// 	})

// 	skt.on('message', (rawMessage: any) => {
// 		if (!rawMessage || isShuttingDown) return

// 		let ticks: any[] = []
// 		try {
// 			const parsed = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage
// 			if (Array.isArray(parsed)) ticks = parsed
// 			else if (parsed?.symbol) ticks = [parsed]
// 			else if (parsed?.data && Array.isArray(parsed.data)) ticks = parsed.data
// 			else return
// 		} catch {
// 			return
// 		}

// 		for (const tick of ticks) {
// 			if (!tick?.symbol || !tick?.ltp) continue

// 			// Compute standard tick payload synchronously
// 			const cumulativeVol = tick.vol_traded_today || 0
// 			const previousVol = previousVolumeTracker.get(tick.symbol) || cumulativeVol
// 			const actualTickVol = Math.max(0, cumulativeVol - previousVol)

// 			if (
// 				tick.symbol !== NIFTY_SYMBOL &&
// 				!tick.symbol.includes('CE') &&
// 				!tick.symbol.includes('PE')
// 			) {
// 				previousVolumeTracker.set(tick.symbol, cumulativeVol)
// 				if (actualTickVol <= 0) continue
// 			}

// 			const liveTick: TickData = {
// 				price: tick.ltp,
// 				volume: actualTickVol || 1, // Index/Options might not calc tick-by-tick vol here
// 				timestamp: Date.now(),
// 			}

// 			// Fire and forget to the event bus
// 			tickEmitter.emit('processTick', { rawTick: tick, liveTick })
// 		}
// 	})

// 	// Shutdown logic remains the same...
// 	const shutdown = async (signal: string) => {
// 		if (isShuttingDown) return
// 		isShuttingDown = true
// 		console.log(`\n[Engine] 🛑 ${signal} received. Shutting down gracefully...`)
// 		try {
// 			skt.close()
// 		} catch {}
// 		await new Promise((resolve) => setTimeout(resolve, 3000))
// 		try {
// 			await redisClient.quit()
// 		} catch {}
// 		process.exit(0)
// 	}

// 	process.on('SIGTERM', () => shutdown('SIGTERM'))
// 	process.on('SIGINT', () => shutdown('SIGINT'))

// 	skt.autoreconnect(5)
// 	skt.connect()
// }

// const currentFilePath = fileURLToPath(import.meta.url)
// if (process.argv[1] === currentFilePath) {
// 	startLiveEngine()
// }
