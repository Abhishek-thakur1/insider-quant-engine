import { fyersDataSocket } from 'fyers-api-v3'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { ENV } from '../config/env.js'
import { bootRedis, redisClient } from '../config/redis.js'
import { updateVwap, getVwap, updateNiftyBias, warnIfVwapMissing } from '../utils/vwapUtils.js'
import { buildOptionUniverse, updateOptionTick, hasATMShifted, OPTION_STRIKE_COUNT } from '../utils/optionUtils.js'
import { seedHistoricalVwap, fetchAndSeedSymbol, getTodayString } from './vwapSeeder.js'
import { feedTick } from '../utils/candleAggregator.js'
import { AnomalyScanner } from './anomalyScanner.js'
import {
	checkWatchdog,
	decideTrip,
	restartBackoffMs,
	restartCounterKey,
	RESTART_COUNTER_TTL_SECS,
} from '../core/sessionGuard.js'
import { formatTickStats, newTickStats, sampleOf } from '../core/tickStats.js'
import { NiftyEmaShadow, emaShadowEnabled, jsonlWriter, redisBarStore } from '../detectors/shadow/niftyEmaShadow.js'
import { describePlan, planSubscription, subscriptionCapFromEnv } from '../core/subscriptionPlan.js'
import { exitIfNotTradingDay } from '../core/tradingDayGate.js'
import { notifyAdmin } from '../utils/adminNotify.js'
import { getISTDateString } from '../utils/marketHours.js'

// [NEW] Regime detector feed
import { pushNiftyReturn, restoreRegimeReturns } from '../utils/regimeDetector.js'
import { describeBootCleanup, runBootCleanup } from '../core/bootCleanup.js'

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
import { VolatilityContraction } from '../detectors/v2/high_alpha/VolatilityContraction.js'

const NIFTY_SYMBOL = 'NSE:NIFTY50-INDEX'

// ── Nifty 1-minute state tracker ─────────────────────────────────────────────
// Builds 1-minute O/H/L/C candles from Nifty spot ticks. On each candle close:
//   1. computes the return % and pushes it to the Shannon entropy engine
//   2. advances the Nifty session reference price (see below)
//
// [FIX — root cause #1] The Nifty VWAP used to be updated on EVERY tick with a
// hardcoded weight of 1: `updateVwap(NIFTY, ltp, 1)`. With a constant weight,
// cumulativePV/cumulativeVol collapses to an unweighted arithmetic mean of tick
// PRICES, biased by tick arrival rate rather than by volume or by time. Combined
// with the index never being seeded, the reference every Nifty detector filters
// on was a mean of ticks since process boot.
//
// NSE indices have no traded volume, so a true VWAP is not computable from index
// data. What IS well-defined is an equal-weight-per-minute mean of the candle
// typical price (H+L+C)/3 — a session TWAP. We now advance it once per closed
// minute, which matches exactly how vwapSeeder seeds the index, so the seeded
// history and the live session are on the same weighting.
//
// The value is cached in memory so the per-tick bias check costs no Redis read.
interface MinuteCandle {
	open: number
	high: number
	low: number
	close: number
	startTs: number
}

const MINUTE_MS = 60 * 1000
let _niftyMinute: MinuteCandle | null = null
let lastNiftyVwap = 0

const updateNiftyMinuteState = async (price: number): Promise<void> => {
	const now = Date.now()

	if (!_niftyMinute) {
		_niftyMinute = { open: price, high: price, low: price, close: price, startTs: now }
		return
	}

	if (now - _niftyMinute.startTs < MINUTE_MS) {
		_niftyMinute.high = Math.max(_niftyMinute.high, price)
		_niftyMinute.low = Math.min(_niftyMinute.low, price)
		_niftyMinute.close = price
		return
	}

	// Candle closed.
	const c = _niftyMinute
	_niftyMinute = { open: price, high: price, low: price, close: price, startTs: now }

	// 1. Regime engine
	const returnPct = ((c.close - c.open) / c.open) * 100
	await pushNiftyReturn(returnPct)

	// 2. Session reference price — weight 1 for this minute, typical price from H/L/C.
	//    updateVwap's optional high/low params yield typicalPrice = (h + l + c) / 3.
	lastNiftyVwap = await updateVwap(NIFTY_SYMBOL, c.close, 1, c.high, c.low)
}

// ── END Nifty minute state tracker ───────────────────────────────────────────

// Engine State
const strategyRouter = new Map<string, IDetector[]>()
const previousVolumeTracker = new Map<string, number>()
let lastSubscribedNiftySpot = 0
let subscribedOptionSymbols: string[] = []
let isShuttingDown = false

// ─── THE ARCHITECTURE UPGRADE: DECOUPLED EVENT BUS ───
const tickEmitter = new EventEmitter()
tickEmitter.setMaxListeners(200)

import { positionTracker } from '../core/positionTracker.js'
import { pool } from '../config/db.js'
import { schemaProblem } from '../db/migrate.js'
import { signalLog } from '../db/signalLog.js'
import { registerWatchlistSources, setSymbolSource } from '../core/symbolSource.js'
import { readMetaSources, resolveAnomalyUniverseFile, resolveScreenerFile, screenerStaleness } from '../screener/paths.js'
import { engineGate } from '../fyers/engineGates.js'

// High-Conviction Nifty Singleton Detectors
const oiSweepDetector = new OiLiquiditySweepDetector()
const niftyTrendPulse = new NiftyTrendPulseDetector()
const niftyVwapReclaim = new NiftyVwapReclaimDetector()
const niftyOpeningRangeExpl = new NiftyOpeningRangeExplosionDetector()
const deltaHedgingDetector = new DeltaHedgingPressureDetector()

// The live Nifty stack, in the order analyze() is called below (AGENTS.md §4.1).
const NIFTY_STACK = [niftyOpeningRangeExpl, niftyTrendPulse, niftyVwapReclaim, oiSweepDetector, deltaHedgingDetector]

// The live EQUITY stack — the only per-symbol detectors that run (AGENTS.md §4.3).
// Both wiring sites (boot and anomaly promotion) use this one factory, and the boot
// banner reads EQUITY_STACK_NAMES, so the banner can no longer drift from what runs.
// GapAndGoMomentum was unwired in e170317 (2026-09-07) and is archived; the rest
// of the archived / dormant classes are listed in src/detectors/deprecated/README.md.
const EQUITY_STACK_NAMES = ['Stock Momentum Breakout', 'Volatility Contraction'] as const
const buildEquityStack = (symbol: string): IDetector[] => [new StockMomentumBreakoutDetector(symbol), new VolatilityContraction(symbol)]

export const startLiveEngine = async () => {
	console.log(`[Engine] 📡 Booting Institutional Quant Router with Jane Street Filter...`)

	// Weekend / NSE holiday → exit 0 (no Docker restart). Behind lifecycle.sh's check.
	const calendarWarning = exitIfNotTradingDay('Engine')
	if (calendarWarning) void notifyAdmin(`⚠️ quant_engine: ${calendarWarning}`)

	const TOKEN_PATH = path.resolve('/app/token', 'access_token.txt')
	// The EOD screener (scripts/screener_eod.ts) writes /app/data/watchlist.json; the
	// engine only reads it. Falls back to the baked-in file before the first run.
	const WATCHLIST_PATH = resolveScreenerFile('watchlist.json')

	if (!fs.existsSync(TOKEN_PATH) || !fs.existsSync(WATCHLIST_PATH)) {
		console.error('❌ CRITICAL: Missing access_token.txt or watchlist.json.')
		process.exit(1)
	}

	// Subscription plan (core/subscriptionPlan.ts): only what the engine evaluates,
	// checked against the Fyers per-user symbol cap before any Fyers call is made.
	// The bench is the Layer B scan set; promotions draw from it and add nothing.
	const watchlist: string[] = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'))
	const scanSetPath = resolveAnomalyUniverseFile()
	const bench: string[] = scanSetPath ? Object.keys(JSON.parse(fs.readFileSync(scanSetPath, 'utf8'))) : []
	const optionsEnabled = process.env.NIFTY_OPTIONS_ENABLED === 'true' // off until the expiry fix
	const subscriptionPlan = planSubscription({
		watchlist,
		bench,
		indexSymbol: NIFTY_SYMBOL,
		optionStrikes: optionsEnabled ? OPTION_STRIKE_COUNT : 0,
		cap: subscriptionCapFromEnv(process.env.SUBSCRIPTION_CAP),
	})
	console.log(`[Engine] 🧾 Subscription plan: ${describePlan(subscriptionPlan)}`)
	if (subscriptionPlan.overCap) {
		// Exit 0: `restart: on-failure` must not loop on a config problem.
		const msg = `subscription plan ${describePlan(subscriptionPlan)} is over the cap — refusing to boot (Fyers drops over-cap subscriptions without an error). Shrink watchlist.json / anomaly_universe.json or raise SUBSCRIPTION_CAP.`
		console.error(`[Engine] ⛔ ${msg}`)
		await notifyAdmin(`⛔ quant_engine: ${msg}`)
		process.exit(0)
	}

	await bootRedis()

	// Restart backoff: each watchdog trip today incremented this counter before
	// exiting 1. Docker restarts immediately, so the wait happens here.
	let restartsToday = 0
	try {
		restartsToday = Number(await redisClient.get(restartCounterKey(Date.now()))) || 0
	} catch {}
	const backoffMs = restartBackoffMs(restartsToday)
	if (backoffMs > 0) {
		console.warn(`[Engine] ⏳ Restart ${restartsToday} today — backing off ${backoffMs / 1000}s before connecting.`)
		await new Promise((resolve) => setTimeout(resolve, backoffMs))
	}

	await seedHistoricalVwap()
	// Read-only. registerTrade writes data_quality (migration 0002), so a
	// pending migration means trade inserts will fail — warn loudly, don't block.
	const schemaIssue = await schemaProblem(pool)
	if (schemaIssue) console.error(`[Engine] ❌ Database schema not current: ${schemaIssue}`)
	await positionTracker.init()

	const activeUniverse = [...watchlist]
	const activeUniverseSet = new Set<string>(activeUniverse)

	// Promotion source for the signals log (observation only): per-symbol from the
	// screener's watchlist_meta.json when present (SCREENER_LEADER / SCREENER_SETUP).
	console.log(`[Engine] 📋 Watchlist: ${WATCHLIST_PATH} (${watchlist.length} symbols)`)
	const staleMsg = screenerStaleness()
	if (staleMsg) {
		console.warn(`[Engine] ⚠️ ${staleMsg}`)
		void notifyAdmin(`⚠️ quant_engine: ${staleMsg}`)
	}
	try {
		const corePath = path.resolve(process.cwd(), 'core_watchlist.json')
		const core: string[] = fs.existsSync(corePath) ? JSON.parse(fs.readFileSync(corePath, 'utf8')) : []
		registerWatchlistSources(watchlist, core, readMetaSources())
	} catch (err) {
		console.warn('[Engine] ⚠️ Could not read core_watchlist.json — signals will log promotion_source SCREENER/UNKNOWN:', err)
		registerWatchlistSources(watchlist, [])
	}

	await warnIfVwapMissing(activeUniverse)

	const accessToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim()

	// Anomaly Scanner for Dynamic Promotion
	const anomalyScanner = new AnomalyScanner()
	anomalyScanner.onPromote = async (symbol: string, reason: string) => {
		if (activeUniverseSet.has(symbol)) return
		console.log(`[Scanner] 🚀 Anomaly detected! Promoting ${symbol} to active universe. Reason: ${reason}`)
		activeUniverseSet.add(symbol)
		activeUniverse.push(symbol)
		setSymbolSource(symbol, 'ANOMALY')

		// Seed VWAP dynamically (runs async)
		// Through the engine's Fyers quota gate (40/min, 'anomaly' allocation, stop on quota).
		engineGate('anomaly')
			.call(() => fetchAndSeedSymbol(symbol, getTodayString()))
			.catch((e) => console.error(`[Scanner] ❌ VWAP seed failed for ${symbol}:`, (e as Error)?.message ?? e))

		strategyRouter.set(symbol, buildEquityStack(symbol))

		// Nothing is deleted on promotion (2026-10-22): cooldown / session-open keys are
		// TTL'd, and a v2:vcp_history key can only be today's — the new-day boot cleanup
		// (core/bootCleanup.ts) wipes every v2:vcp_history:*, and a same-day restart that
		// re-promotes the symbol must keep the history it built before the restart.

		// bot.telegram.sendMessage(ENV.TELEGRAM_CHANNEL_ID, `🚀 *DYNAMIC PROMOTION*\nSymbol: \`${symbol}\`\nReason: ${reason}\nStatus: Full detectors engaged.`, { parse_mode: 'Markdown' }).catch(console.error)
	}
	anomalyScanner.start(activeUniverseSet)

	// ── Boot Cleanup & Strategy Routing ──────────────────────────────────────
	for (const symbol of activeUniverse) strategyRouter.set(symbol, buildEquityStack(symbol))

	// Day-aware (core/bootCleanup.ts, owner 2026-10-22): a NEW-DAY boot clears the previous
	// session's regime returns, bias, pnl:daily and every v2:vcp_history:*; a SAME-DAY restart
	// (watchdog) keeps them and re-loads the regime returns into memory. Cooldown and
	// session-open keys are TTL'd (≤ 8 h) and never deleted here: wiping them on a restart
	// let the same setups re-alert.
	const today = getISTDateString()
	const cleanup = await runBootCleanup(
		{
			get: (k) => redisClient.get(k),
			set: (k, v, o) => redisClient.set(k, v, o),
			del: (ks) => redisClient.del(ks),
			keys: async (pattern) => {
				const out: string[] = []
				for await (const batch of redisClient.scanIterator({ MATCH: pattern, COUNT: 500 })) out.push(...batch)
				return out
			},
		},
		today,
	)
	const restoredReturns = cleanup.sameDay ? restoreRegimeReturns(await redisClient.lRange('regime:nifty:returns_1min', 0, -1)) : 0
	console.log(describeBootCleanup(cleanup, today, restoredReturns))

	// Nifty cooldown keys (cooldown:v2:nifty_pulse, cooldown:v2:vwap_reclaim,
	// cooldown:v2:nifty_ore, cooldown:oi_sweep, cooldown:delta_squeeze) are TTL'd
	// and intentionally survive restarts — see the per-symbol note above.
	// alert:sent:{day}:* / alert:count:{day} / alert:sym:{day}:* / paper:sym:{day}:* (alertPolicy) are date-keyed and
	// must never be cleared here either.
	// trades:open is NOT cleared: positionTracker.init() (above) already loaded
	// it, and deleting it orphaned every position still open at the next boot.
	// SWING positions now carry over; prior-day INTRADAY ones are marked ORPHANED.
	// jsfilter:decisions is NOT cleared: a mid-session restart used to wipe the day's
	// filter evidence (Oct 16). Stats are per-day keys (jsfilter:stats:YYYY-MM-DD); the
	// cleanup above removes only the legacy un-dated jsfilter:stats hash.
	// ema_shadow:nifty:bars5 is NOT cleared: it is the EMA shadow's warm-up history
	// (its own closed 5-min candles, capped at MAX_STORED_BARS).
	// engine:boot_day is the cleanup's own marker (IST date of the last boot, 7-day TTL).

	// EMA trend study in SHADOW (owner spec 2026-10-21): no alerts, no filter,
	// no paper trades. Kill switch EMA_SHADOW_ENABLED=false.
	let emaShadow: NiftyEmaShadow | null = null
	if (emaShadowEnabled(process.env.EMA_SHADOW_ENABLED)) {
		try {
			const cfg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'config', 'nifty_ema_study.json'), 'utf8'))
			emaShadow = new NiftyEmaShadow(cfg, redisBarStore(redisClient), jsonlWriter(process.env.EMA_SHADOW_DIR || '/app/data/ema_shadow'))
			await emaShadow.init(Date.now())
		} catch (err) {
			emaShadow = null
			console.error('[EmaShadow] ❌ Could not start — shadow disabled for this session (engine unaffected):', err)
		}
	} else {
		console.log('[EmaShadow] ⏸️ Disabled (EMA_SHADOW_ENABLED=false)')
	}

	// Prime the in-memory Nifty reference from the seeded value so bias checks
	// work from the very first tick rather than waiting a full minute.
	lastNiftyVwap = (await getVwap(NIFTY_SYMBOL)) ?? 0
	if (lastNiftyVwap > 0) {
		console.log(`[Engine] 🎯 Nifty session reference seeded at ₹${lastNiftyVwap.toFixed(2)}`)
	} else {
		console.warn(
			'[Engine] ⚠️  Nifty session reference NOT seeded — bias/VWAP filters stay off until the first 1-min candle closes.',
		)
	}

	console.log('[Engine] ✅ Full boot cleanup complete.')
	console.log(`[Engine] 📡 Equity stack: ${EQUITY_STACK_NAMES.length} detectors (${EQUITY_STACK_NAMES.join(' + ')}) × ${activeUniverse.length} stocks`)
	console.log(`[Engine] 📡 Nifty stack: ${NIFTY_STACK.length} detectors (${NIFTY_STACK.map((d) => d.name).join(' + ')})`)
	console.log(
		'[Engine] 🧮 JaneStreetFilter ACTIVE — all signals gated (Regime → Bayes → EV → Kelly)',
	)

	// ─── ASYNCHRONOUS PROCESSING LAYER ───
	tickEmitter.on('processTick', async (tickData) => {
		try {
			const { rawTick, liveTick } = tickData

			// 0. Shadow Execution Layer (PnL Tracker)
			positionTracker.processTick(rawTick.symbol, liveTick).catch(e => console.error('[PositionTracker] Error:', e))

			// 1. Route Nifty Spot
			if (rawTick.symbol === NIFTY_SYMBOL) {
				// Advances the regime engine and the session reference price on each
				// closed 1-min candle (non-blocking).
				updateNiftyMinuteState(rawTick.ltp).catch((e) =>
					console.error('[Nifty] Minute state update error:', e),
				)

				// Bias is still evaluated per tick, but against the cached minute-anchored
				// reference instead of a tick mean. Skipped until the reference exists so a
				// seeder failure can never silently pin the bias to a bogus level.
				if (lastNiftyVwap > 0) await updateNiftyBias(rawTick.ltp, lastNiftyVwap)

				feedTick(NIFTY_SYMBOL, rawTick.ltp, liveTick.volume)

				// Shadow only; a failure here must never touch the live Nifty stack.
				try {
					emaShadow?.onTick(rawTick.ltp, liveTick.timestamp)
				} catch (e) {
					console.error('[EmaShadow] ❌ Tick error (shadow only):', e)
				}

				await niftyOpeningRangeExpl.analyze(liveTick)
				await niftyTrendPulse.analyze(liveTick)
				await niftyVwapReclaim.analyze(liveTick)
				await oiSweepDetector.analyze(liveTick)
				await deltaHedgingDetector.analyze(liveTick)

				// Option Chain Dynamic Rolling
				if (optionsEnabled && (lastSubscribedNiftySpot === 0 || hasATMShifted(rawTick.ltp, lastSubscribedNiftySpot))) {
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
			if (rawTick.symbol.endsWith('CE') || rawTick.symbol.endsWith('PE')) {
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
			if (activeUniverseSet.has(rawTick.symbol)) {
				await updateVwap(rawTick.symbol, liveTick.price, liveTick.volume)
				feedTick(rawTick.symbol, liveTick.price, liveTick.volume)
				const strategies = strategyRouter.get(rawTick.symbol)
				if (strategies) {
					await Promise.all(strategies.map((s) => s.analyze(liveTick)))
				}
			} else {
				// Feed inactive equities to the anomaly scanner
				anomalyScanner.updateTick(rawTick.symbol, rawTick.ltp, rawTick.vol_traded_today ?? 0)
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

		// The plan checked at boot (watchlist + bench + Nifty), plus option strikes when enabled.
		const allSymbols = [...subscriptionPlan.symbols, ...subscribedOptionSymbols]
		// FIX: Chunk subscriptions to avoid SDK internal dictionary corruption.
		// FIX2: Stagger with 600ms delay — sending all chunks simultaneously causes Fyers
		// server to silently drop later chunks, leaving the socket subscribed to nothing
		// and triggering the watchdog loop. Each chunk must be fully acknowledged before
		// the next is sent.
		const chunkSize = 200
		const CHUNK_DELAY_MS = 600
		let chunkIndex = 0
		const sendNextChunk = () => {
			if (chunkIndex >= allSymbols.length) {
				console.log(`[Firehose] ✅ All ${allSymbols.length} symbols subscribed across ${Math.ceil(allSymbols.length / chunkSize)} chunks`)
				return
			}
			const chunk = allSymbols.slice(chunkIndex, chunkIndex + chunkSize)
			skt.subscribe(chunk)
			console.log(`[Firehose] 📡 Chunk ${Math.floor(chunkIndex / chunkSize) + 1}: subscribed ${chunk.length} symbols`)
			chunkIndex += chunkSize
			setTimeout(sendNextChunk, CHUNK_DELAY_MS)
		}
		sendNextChunk()
	})

	// lastTickTime drives the watchdog (kept fresh outside the session);
	// lastMessageAt / messagesSinceBeat are for the heartbeat log only.
	let lastTickTime = Date.now()
	let lastMessageAt = 0
	let messagesSinceBeat = 0
	let tickStats = newTickStats()
	let lastBeatAt = Date.now()
	const HEARTBEAT_MS = 5 * 60 * 1000
	const istClock = (ms: number) => (ms ? new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(11, 19) : 'never')

	// Policy in core/sessionGuard.ts: restart (exit 1, backoff on the next boot)
	// up to MAX_RESTARTS_PER_DAY, never after 15:15 IST; otherwise stand down
	// (exit 0, so `restart: on-failure` leaves it down). Admin notified on every trip.
	const onWatchdogTrip = async (nowMs: number) => {
		const silentSecs = Math.round((nowMs - lastTickTime) / 1000)
		let tripsToday = 1
		try {
			const key = restartCounterKey(nowMs)
			tripsToday = await redisClient.incr(key)
			await redisClient.expire(key, RESTART_COUNTER_TTL_SECS)
		} catch (err) {
			console.error('[Watchdog] Could not update the restart counter — assuming first trip:', err)
		}
		const trip = decideTrip(nowMs, tripsToday)
		const next = trip.action === 'RESTART' ? `restart after ${restartBackoffMs(tripsToday) / 1000}s backoff` : 'stand down until the next scheduled start'
		const summary = `[Watchdog] ⚠️ No socket message for ${silentSecs}s at ${istClock(nowMs)} IST (last message ${istClock(lastMessageAt)}). Trip ${tripsToday} today → ${trip.action} (${trip.reason}); ${next}. Exit ${trip.exitCode}.`
		console.error(summary)
		await notifyAdmin(`🚨 quant_engine ${summary}`)
		anomalyScanner.stop()
		try { skt.close() } catch {}
		// Same flush as the SIGTERM path: don't lose the last second of signals rows.
		await signalLog.shutdown(2000)
		try { await redisClient.quit() } catch {}
		process.exit(trip.exitCode)
	}

	const watchdog = setInterval(() => {
		if (isShuttingDown) return
		const now = Date.now()
		if (now - lastBeatAt >= HEARTBEAT_MS) {
			console.log(`[Firehose] ♥ ${messagesSinceBeat} msgs in last ${Math.round((now - lastBeatAt) / 60000)} min, last at ${istClock(lastMessageAt)} IST`)
			for (const line of formatTickStats(tickStats, activeUniverseSet.size)) console.log(line)
			messagesSinceBeat = 0
			tickStats = newTickStats()
			lastBeatAt = now
		}
		const check = checkWatchdog(now, lastTickTime)
		if (check === 'RESET_CLOCK') {
			lastTickTime = now
			return
		}
		if (check === 'OK') return
		isShuttingDown = true // stops tick handling and makes a racing SIGTERM a no-op
		clearInterval(watchdog)
		void onWatchdogTrip(now)
	}, 10000)

	// Diagnostics only: before these, a silent socket left no trace in the log
	// (Oct 19 15:15:50 trip had no disconnect line before it).
	skt.on('error', (err: unknown) => console.error('[Firehose] ❌ Socket error:', (err as Error | null)?.message ?? err))
	skt.on('close', () => console.warn(`[Firehose] 🔌 Socket closed at ${istClock(Date.now())} IST (last message ${istClock(lastMessageAt)})`))

	skt.on('message', (rawMessage: any) => {
		if (!rawMessage || isShuttingDown) return
		lastTickTime = Date.now()
		lastMessageAt = lastTickTime
		messagesSinceBeat++

		let ticks: any[] = []
		try {
			const parsed = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage
			if (Array.isArray(parsed)) ticks = parsed
			else if (parsed?.symbol) ticks = [parsed]
			else if (parsed?.data && Array.isArray(parsed.data)) ticks = parsed.data
			else {
				tickStats.unparsed++
				if (!tickStats.sampleUnparsed) tickStats.sampleUnparsed = sampleOf(parsed)
				return
			}
		} catch {
			tickStats.unparsed++
			if (!tickStats.sampleUnparsed) tickStats.sampleUnparsed = sampleOf(rawMessage)
			return
		}

		for (const tick of ticks) {
			tickStats.ticks++
			if (!tick?.symbol || !tick?.ltp) {
				tickStats.noLtp++
				continue
			}

			const cumulativeVol = tick.vol_traded_today || 0
			// Use ?? so we don't accidentally fallback to cumulativeVol if it was recorded as 0
			const previousVol = previousVolumeTracker.get(tick.symbol) ?? cumulativeVol
			const actualTickVol = Math.max(0, cumulativeVol - previousVol)

			// FIX: ALWAYS track the volume regardless of asset class so the *next* tick diff is correct
			previousVolumeTracker.set(tick.symbol, cumulativeVol)

			const isIndexOrOption =
				tick.symbol === NIFTY_SYMBOL || tick.symbol.endsWith('CE') || tick.symbol.endsWith('PE')

			// Diagnostics only (core/tickStats.ts) — counted after the decision, never alters it.
			if (tick.symbol === NIFTY_SYMBOL) tickStats.index++
			else if (isIndexOrOption) tickStats.option++
			else {
				if (!tickStats.sampleEquity) tickStats.sampleEquity = sampleOf(tick)
				if (activeUniverseSet.has(tick.symbol)) tickStats.activeSymbols.add(tick.symbol)
				if (!tick.vol_traded_today) tickStats.eqNoVolField++
				if (actualTickVol <= 0) tickStats.eqZeroVol++
				else if (activeUniverseSet.has(tick.symbol)) tickStats.eqActive++
				else tickStats.eqInactive++
			}

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
		clearInterval(watchdog)
		anomalyScanner.stop()
		console.log(`\n[Engine] 🛑 ${signal} received. Shutting down gracefully...`)
		try {
			skt.close()
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 3000))
		// Flush signals logged in the last second (bounded; never throws).
		await signalLog.shutdown(2000)
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
