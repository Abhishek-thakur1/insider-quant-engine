import fyers, { fyersDataSocket } from 'fyers-api-v3'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ENV } from '../config/env.js'
import { bootRedis, redisClient } from '../config/redis.js'
import { VcpDetector } from '../detectors/vcpDetector.js'
import { VolumeSpikeDetector } from '../detectors/volumeSpikeDetector.js'
import { updateVwap, updateNiftyBias, warnIfVwapMissing } from '../utils/vwapUtils.js'
import type { IDetector } from '../core/types.js'
import { seedHistoricalVwap } from './vwapSeeder.js'
import { OrbDetector } from '../detectors/orbDetector.js'
import { buildOptionUniverse, updateOptionTick, hasATMShifted } from '../utils/optionUtils.js'
import { ValueZoneScalpDetector } from '../detectors/valueZoneScalpDetector.js'
import { LiquiditySweepDetector } from '../detectors/liquiditySweepDetector.js'
import { OrderFlowExhaustionDetector } from '../detectors/Orderflowexhaustiondetector.js'
import { MultiTimeframeBreakoutDetector } from '../detectors/Multitimeframebreakoutdetector.js'


// ─────────────────────────────────────────────────────────────────────────────
// RECOMMENDED DETECTOR STACK — READ THIS BEFORE ENABLING/DISABLING
//
// Not all detectors should run at once. Running too many creates:
//   1. Alert fatigue — you can't act on 20 signals in the same minute
//   2. Redis saturation — every detector does 2–4 round trips per tick
//   3. Overlapping signals — same move gets alerted 3 different ways
//
// The stack below is designed for a SINGLE TRADER managing 1-2 trades at a time.
//
// ── FOR NIFTY (OPTIONS SCALPING) ────────────────────────────────────────────
//
//   [KEEP — HIGH PRIORITY]
//   ✅ OrderFlowExhaustionDetector  ← NEW. Best signal quality. VWAP mean reversion
//                                      with trapped-trader mechanics. Fire 1–3x/day.
//   ✅ ValueZoneScalpDetector       ← 21 EMA pullback in established trend.
//                                      Complements OFE — different entry timing.
//   ✅ LiquiditySweepDetector       ← Morning range sweep+reversal. Fires once/day max.
//                                      Very high quality when it fires. Keep it.
//
//   [DISABLE — REDUNDANT OR NOISY]
//   ❌ NiftyOptionsDetector         ← 3 consecutive HH/LL candles. The OFE detector
//                                      already captures this move with better filters.
//                                      Creates duplicate alerts. Disable.
//   ❌ VwapCrossoverDetector        ← VWAP cross on 1-min candle. Too frequent in
//                                      choppy markets. OFE handles the same move
//                                      with stronger confirmation.
//   ❌ VwapPullbackDetector         ← Valid strategy, but overlaps heavily with
//                                      ValueZoneScalpDetector. Keep one. VSDetector
//                                      has tighter rules (EMA + VWAP together).
//
// ── FOR STOCKS (EQUITY INTRADAY) ────────────────────────────────────────────
//
//   [KEEP — HIGH PRIORITY]
//   ✅ MultiTimeframeBreakoutDetector ← NEW. The only detector that checks 5-min +
//                                        15-min trend alignment before firing.
//                                        4 confluences = best R:R in the stack.
//   ✅ OrbDetector                  ← Opening Range Breakout. Best edge in the first
//                                      90 minutes. Fires 1–2x per stock. Keep it.
//   ✅ VcpDetector                  ← Volatility Contraction Pattern. Best mid-session
//                                      detector. Fires when accumulation ends. Keep.
//
//   [DISABLE — REDUNDANT OR NOISY]
//   ❌ VolumeSpikeDetector          ← Raw volume spike. The MTF detector already
//                                      requires volume explosion as one of 4 filters.
//                                      Running both creates duplicate stock alerts.
//                                      Disable once MTF is stable and backtested.
//   ❌ CandleBreakoutDetector       ← 5-candle box breakout. Weaker version of what
//                                      VcpDetector and MTF already do. Overlaps heavily
//                                      with both. Disable.
//   ❌ LiquidityTrapDetector        ← Valid concept, but same as OFE for stocks.
//                                      Keep disabled until OFE is adapted for stocks.
//
// ── RECOMMENDED DAILY ROUTINE ────────────────────────────────────────────────
//
//   9:15–9:45    Watch LiquiditySweep + ORB only. Let the range establish.
//   9:45–11:30   All 3 Nifty detectors + ORB + VCP active.
//   11:30–1:30   PAUSE. Lunch hour chop kills R:R. The engine will idle.
//   1:30–3:00    OFE + MTF + VCP active. Best afternoon setups.
//   3:00+        Exit all. No new entries. Engine stops at 3:30.
//
// ─────────────────────────────────────────────────────────────────────────────

const NIFTY_SYMBOL = 'NSE:NIFTY50-INDEX'

const strategyRouter = new Map<string, IDetector[]>()
const previousVolumeTracker = new Map<string, number>()

// Nifty singleton detectors — one instance shared across all ticks
const orderFlowExhaustionDetector = new OrderFlowExhaustionDetector()
const valueZoneScalpDetector = new ValueZoneScalpDetector()
const liquiditySweepDetector = new LiquiditySweepDetector()

let lastSubscribedNiftySpot = 0
let subscribedOptionSymbols: string[] = []
let isShuttingDown = false

// ── IST time helper ─────────────────────────────────────────────────────────
const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

export const startLiveEngine = async () => {
	console.log(`[Engine] 📡 Booting Institutional Quant Router...`)

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

	// Warn loudly if any symbol has no VWAP seed — its VWAP filter is silently off
	await warnIfVwapMissing(activeUniverse)

	const accessToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim()

	console.log(`[Engine] ⚙️  Initializing detectors for ${activeUniverse.length} equities...`)

	// ── Boot cleanup ─────────────────────────────────────────────────────────
	// Delete all per-symbol state from previous session.
	// Redis persistence (AOF) keeps VWAP keys because they're date-stamped.
	await Promise.all(
		activeUniverse.map(async (symbol) => {
			strategyRouter.set(symbol, [
				new MultiTimeframeBreakoutDetector(symbol),
				new OrbDetector(symbol),
				new VcpDetector(symbol),
			])

			await Promise.all([
				redisClient.del(`memory:vcp:${symbol}`),
				redisClient.del(`baseline:vcp:${symbol}`),
				redisClient.del(`armed:vcp:${symbol}`),
				redisClient.del(`cooldown:vcp:${symbol}`),
				redisClient.del(`memory:volume:${symbol}`),
				redisClient.del(`cooldown:volume:${symbol}`),
				redisClient.del(`vol_baseline_candles:${symbol}`),
				redisClient.del(`candles:${symbol}`),
				redisClient.del(`cooldown:candle:${symbol}`),
				redisClient.del(`cooldown:orb:${symbol}`),
				redisClient.del(`orb:15min:high:${symbol}`),
				redisClient.del(`orb:15min:low:${symbol}`),
				redisClient.del(`orb:30min:high:${symbol}`),
				redisClient.del(`orb:30min:low:${symbol}`),
				redisClient.del(`trap_candles:${symbol}`),
				redisClient.del(`cooldown:trap:${symbol}`),
				redisClient.del(`cooldown:mtf_breakout:${symbol}`),
				redisClient.del(`session_open:${symbol}`),
			])
		}),
	)

	// Nifty-level state reset
	await redisClient.del('market:nifty:bias')
	await redisClient.del('cooldown:ofe_scalper')
	await redisClient.del('cooldown:valuezone')
	await redisClient.del('cooldown:nifty_options')
	await redisClient.del('cooldown:nifty_vwap_pullback')
	await redisClient.del('cooldown:nifty_vwap_crossover')
	await redisClient.del(`cooldown:liquidity_sweep:${NIFTY_SYMBOL}`)
	await redisClient.del(`orb:15min:high:${NIFTY_SYMBOL}`)
	await redisClient.del(`orb:15min:low:${NIFTY_SYMBOL}`)
	await redisClient.del(`session_open:${NIFTY_SYMBOL}`)

	console.log('[Engine] ✅ Boot cleanup complete.')
	console.log('[Engine] 🆕 OrderFlowExhaustionDetector ACTIVE on Nifty')
	console.log(`[Engine] 🆕 MultiTimeframeBreakoutDetector ACTIVE on ${activeUniverse.length} stocks`)

	// ── WebSocket ─────────────────────────────────────────────────────────────
	const cleanAppId = ENV.FYERS_APP_ID.replace(/\s/g, '')
	const cleanToken = accessToken.replace(/\s/g, '')
	const skt = fyersDataSocket.getInstance(`${cleanAppId}:${cleanToken}`, './logs', false)

	skt.on('connect', () => {
		console.log('[Firehose] 🟢 Connected to Fyers Data Servers!')
		skt.subscribe([...activeUniverse, NIFTY_SYMBOL, ...subscribedOptionSymbols])
		console.log(`[Firehose] ✅ Subscribed: ${activeUniverse.length} equities + Nifty + options`)
	})

	skt.on('message', async (rawMessage: any) => {
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

		if (ticks.length === 0) return

		await Promise.all(
			ticks.map(async (tick) => {
				if (!tick?.symbol || !tick?.ltp) return

				// ── Nifty index path ──────────────────────────────────────────
				if (tick.symbol === NIFTY_SYMBOL) {
					const niftyVwap = await updateVwap(NIFTY_SYMBOL, tick.ltp, 1)
					await updateNiftyBias(tick.ltp, niftyVwap)

					// Record session open once at 9:15–9:20 for RS calculation in MTF
					const m = getISTMinutes()
					if (m >= 9 * 60 + 15 && m < 9 * 60 + 20) {
						const exists = await redisClient.get(`session_open:${NIFTY_SYMBOL}`)
						if (!exists) {
							await redisClient.setEx(`session_open:${NIFTY_SYMBOL}`, 8 * 3600, String(tick.ltp))
						}
					}

					const liveTick = {
						price: tick.ltp,
						volume: tick.vol_traded_today || 1,
						timestamp: Date.now(),
					}

					await orderFlowExhaustionDetector.analyze(liveTick)
					await valueZoneScalpDetector.analyze(liveTick)
					await liquiditySweepDetector.analyze(liveTick)

					// Resubscribe option strikes when ATM shifts
					if (
						lastSubscribedNiftySpot === 0 ||
						hasATMShifted(tick.ltp, lastSubscribedNiftySpot)
					) {
						const newOpts = buildOptionUniverse(tick.ltp)
						if (subscribedOptionSymbols.length > 0) skt.unsubscribe(subscribedOptionSymbols)
						skt.subscribe(newOpts)
						subscribedOptionSymbols = newOpts
						lastSubscribedNiftySpot = tick.ltp
						console.log(
							`[Options] 🔄 ${newOpts.length} strikes around ATM ` +
							`${Math.round(tick.ltp / 50) * 50}`,
						)
					}
					return
				}

				// ── Option tick — update live strike data store ───────────────
				if (tick.symbol.includes('CE') || tick.symbol.includes('PE')) {
					updateOptionTick(tick.symbol, {
						ltp: tick.ltp,
						oi: tick.oi ?? 0,
						volume: tick.vol_traded_today ?? 0,
					})
					return
				}

				// ── Equity tick ───────────────────────────────────────────────
				const cumulativeVol = tick.vol_traded_today || 0
				const previousVol = previousVolumeTracker.get(tick.symbol) || cumulativeVol
				const actualTickVol = cumulativeVol - previousVol
				previousVolumeTracker.set(tick.symbol, cumulativeVol)

				if (actualTickVol <= 0) return

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
			}),
		)
	})

	skt.on('error', (error: any) => console.error('[Firehose] ❌ WebSocket Error:', error))
	skt.on('close', () => {
		if (!isShuttingDown) console.log('[Firehose] 🔴 WebSocket Closed.')
	})

	skt.autoreconnect(5)
	skt.connect()

	// ── Graceful shutdown ─────────────────────────────────────────────────────
	// Docker stop sends SIGTERM. Without this handler the process exits mid-pipeline,
	// leaving orphaned Redis keys and incomplete multi() executions.
	// We set isShuttingDown=true first so new incoming ticks are dropped cleanly,
	// then give any in-flight async work 3 seconds to settle before disconnecting.
	const shutdown = async (signal: string) => {
		if (isShuttingDown) return
		isShuttingDown = true

		console.log(`\n[Engine] 🛑 ${signal} received. Shutting down gracefully...`)

		try {
			skt.close()
		} catch {
			// WebSocket may already be closed
		}

		// Allow in-flight tick handlers to complete
		await new Promise((resolve) => setTimeout(resolve, 3000))

		try {
			await redisClient.quit()
			console.log('[Engine] ✅ Redis connection closed cleanly.')
		} catch {
			// Redis may already be disconnected
		}

		console.log('[Engine] 👋 Shutdown complete.')
		process.exit(0)
	}

	process.on('SIGTERM', () => shutdown('SIGTERM'))
	process.on('SIGINT', () => shutdown('SIGINT'))
}

const currentFilePath = fileURLToPath(import.meta.url)
if (process.argv[1] === currentFilePath) {
	startLiveEngine()
}