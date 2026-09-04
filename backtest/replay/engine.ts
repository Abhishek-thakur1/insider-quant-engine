// ============================================================
// backtest/replay/engine.ts — chronological session replay
//
// Replays ONE trading session through the real detector classes.
//
// WHAT THIS FILE REPLICATES AND WHAT IT DOES NOT:
// It replicates websocket.ts's ROUTING — which util gets called with what, in
// what order — because that routing lives inline inside the socket handler and
// is not exported. It does NOT reimplement any detector's signal logic; every
// signal comes from the real class via `registry.constructDetector`.
//
// FIVE THINGS THAT MAKE THIS FAITHFUL:
//
//  1. Fresh state per session. Live boots at 09:15, is stopped at 15:30, and
//     wipes its Redis keys on boot — so detectors genuinely start each day
//     blank. We construct new detector instances, flush the in-memory Redis,
//     and reset every module-level singleton (candle buffers, BOS streaks,
//     option store, regime returns) per simulated day.
//
//  2. Global chronological interleaving across symbols, asserted (see
//     barToTicks.mergeChronologically).
//
//  3. Nifty VWAP advances AFTER the minute's ticks are dispatched, never
//     before. Live updates it on candle close, so during minute N the value a
//     detector reads reflects minutes 1..N-1. Updating first would leak the
//     current bar's close into the filter the detector is being judged by.
//
//  4. Sequential (not Promise.all) detector dispatch. Live uses
//     `Promise.all(strategies.map(s => s.analyze(t)))`; concurrent execution
//     would interleave async continuations and destroy signal attribution
//     (see below). Sequential is deterministic and, since detectors share no
//     mutable state beyond their own Redis keys, produces the same signals.
//
//  5. Attribution by execution context, not by payload. Archived detectors do
//     not set `detectorName`, so the sink cannot identify them from the
//     payload. Instead the engine records which detector it is currently
//     awaiting; `sendTelegramAlert` invokes the collector synchronously before
//     its first await, so whatever is in `currentAttribution` at that moment
//     is necessarily the detector that fired.
// ============================================================

import type { IDetector, TickData } from '../../src/core/types.js'
import { runJaneStreetFilter } from '../../src/detectors/janeStreetFilter.js'
import { backtestSink, type AlertPayload } from '../../src/workers/telegramWorker.js'
import { updateVwap, updateNiftyBias, getVwap } from '../../src/utils/vwapUtils.js'
import { feedTick, resetCandles } from '../../src/utils/candleAggregator.js'
import { resetStructure } from '../../src/utils/marketStructure.js'
import { pruneStaleStrikes } from '../../src/utils/optionUtils.js'
import { pushNiftyReturn, resetRegimeState } from '../../src/utils/regimeDetector.js'
import { NIFTY_SYMBOL } from '../config.js'
import { getMemoryRedis } from '../core/memoryRedis.js'
import { setVirtualNow, istMinutesOf, MARKET_CLOSE_MIN } from '../core/clock.js'
import { REGISTRY, constructDetector, type DetectorSpec } from '../registry.js'
import type { Bar } from '../data/store.js'
import { barToTicks, mergeChronologically, assertChronological } from './barToTicks.js'
import { isOptionSymbolLive, misroutedByLiveTest } from '../core/symbolClass.js'

/** What the live gating chain decided about this signal, at signal time. */
export interface GateOutcome {
	passed: boolean
	score: number
	posterior: number
	ev: number
	kellyHalf: number
	regime: string
	entropy: number
	rejectedAt: string | null
	/** 'explicit' | 'name' | 'trigger' | 'default' — parsed out of the reason. */
	classificationSource: string
}

export interface RawSignal {
	detectorId: string
	detectorDisplayName: string
	/** Simulated moment the alert was raised. */
	ts: number
	sessionDate: string
	payload: AlertPayload
	/**
	 * Filled in immediately after the detector returns, while the simulated
	 * clock and all shared state are still exactly as they were when the signal
	 * fired. Scoring it later would judge the signal against future state.
	 * null only if the filter itself threw.
	 */
	gate: GateOutcome | null
	gateError?: string
}

export interface SessionResult {
	sessionDate: string
	barsReplayed: number
	ticksDispatched: number
	signals: RawSignal[]
	/** Detector ids that threw during this session, with the first message. */
	errors: Map<string, string>
	/**
	 * Equity symbols the LIVE substring option test misroutes (RELIANCE and
	 * friends — see core/symbolClass.ts). Replay reproduces the misrouting so
	 * the numbers describe the engine that actually runs; these symbols
	 * therefore contribute no equity signals at all.
	 */
	misroutedSymbols: string[]
}

export interface ReplayInputs {
	sessionDate: string
	/** 1-minute bars per symbol for this session. Must include NIFTY_SYMBOL. */
	barsBySymbol: Map<string, Bar[]>
	/** Which detectors to run. Defaults to every backtestable one. */
	specs?: DetectorSpec[]
}

/** Set immediately before awaiting a detector; read by the sink. */
let currentAttribution: { id: string; displayName: string } | null = null

export const replaySession = async (inputs: ReplayInputs): Promise<SessionResult> => {
	const { sessionDate, barsBySymbol } = inputs
	const specs = inputs.specs ?? REGISTRY.filter((s) => s.backtestable)

	const equitySymbols = [...barsBySymbol.keys()].filter((s) => s !== NIFTY_SYMBOL)
	const signals: RawSignal[] = []
	const errors = new Map<string, string>()

	// ── 1. blank slate for this session ────────────────────────────────────
	const redis = getMemoryRedis()
	redis.flushAll()
	resetRegimeState()
	pruneStaleStrikes([]) // clears the option tick store entirely
	for (const symbol of [...equitySymbols, NIFTY_SYMBOL]) {
		resetCandles(symbol)
		resetStructure(symbol)
	}

	// ── 2. build detector instances ────────────────────────────────────────
	const singletons: Array<{ spec: DetectorSpec; detector: IDetector }> = []
	const perSymbol = new Map<string, Array<{ spec: DetectorSpec; detector: IDetector }>>()

	for (const spec of specs) {
		if (spec.scope === 'nifty-singleton') {
			singletons.push({ spec, detector: constructDetector(spec.id, NIFTY_SYMBOL) })
		} else {
			for (const symbol of equitySymbols) {
				const list = perSymbol.get(symbol) ?? []
				list.push({ spec, detector: constructDetector(spec.id, symbol) })
				perSymbol.set(symbol, list)
			}
		}
	}

	// ── 3. install the collector ───────────────────────────────────────────
	let collectTs = 0
	backtestSink.collect = (payload: AlertPayload) => {
		if (!currentAttribution) {
			// Should be unreachable: every analyze() call is wrapped. If it ever
			// fires, attribution is broken and silently dropping the signal would
			// be worse than failing loudly.
			throw new Error('[replay] signal raised with no attribution context — cannot attribute')
		}
		signals.push({
			detectorId: currentAttribution.id,
			detectorDisplayName: currentAttribution.displayName,
			ts: collectTs,
			sessionDate,
			payload: { ...payload },
			gate: null,
		})
	}

	// ── 4. the replay loop ─────────────────────────────────────────────────
	const stream = mergeChronologically(barsBySymbol)
	assertChronological(stream)

	let ticksDispatched = 0

	const runDetector = async (
		entry: { spec: DetectorSpec; detector: IDetector },
		tick: TickData,
	): Promise<void> => {
		currentAttribution = { id: entry.spec.id, displayName: entry.spec.displayName }
		const before = signals.length
		try {
			await entry.detector.analyze(tick)
		} catch (err) {
			if (!errors.has(entry.spec.id)) {
				errors.set(entry.spec.id, (err as Error).message ?? String(err))
			}
		} finally {
			currentAttribution = null
		}

		// Score anything this detector just raised, HERE — before the clock or any
		// shared state advances. This is what makes the gated numbers meaningful:
		// the regime entropy, Nifty bias, VWAP and candle buffers the filter reads
		// are the ones that existed at the instant the detector fired.
		for (let i = before; i < signals.length; i++) {
			const sig = signals[i]!
			try {
				const d = await runJaneStreetFilter(sig.payload, entry.spec.displayName)
				const regimeReason = d.breakdown.find((b) => b.component === 'REGIME')?.reason ?? ''
				const srcMatch = regimeReason.match(/\[(?:MOMENTUM|REVERSION|UNIVERSAL)\/(\w+)\]/)
				sig.gate = {
					passed: d.passed,
					score: d.score,
					posterior: d.posterior,
					ev: d.ev,
					kellyHalf: d.kellyHalf,
					regime: d.regime,
					entropy: d.entropy,
					rejectedAt: d.rejectedAt ?? null,
					classificationSource: srcMatch?.[1] ?? 'unknown',
				}
			} catch (err) {
				sig.gate = null
				sig.gateError = (err as Error).message ?? String(err)
			}
		}
	}

	try {
		for (const { symbol, bar } of stream) {
			const isNifty = symbol === NIFTY_SYMBOL
			const ticks = barToTicks(bar)

			for (const tick of ticks) {
				// The virtual clock drives every Date.now() the detectors read, and
				// every TTL in the in-memory Redis.
				setVirtualNow(tick.timestamp)
				collectTs = tick.timestamp
				ticksDispatched++

				if (isNifty) {
					// Live feeds the shared candle buffer with volume 1 for the index
					// (vol_traded_today is 0 for indices, so ingestion's `|| 1`
					// fallback applies). Mirrored here so orderFlowProxy behaves the
					// same way it does in production.
					feedTick(NIFTY_SYMBOL, tick.price, 1, tick.timestamp)

					const niftyVwap = await getVwap(NIFTY_SYMBOL)
					if (niftyVwap && niftyVwap > 0) await updateNiftyBias(tick.price, niftyVwap)

					for (const entry of singletons) await runDetector(entry, tick)
				} else if (isOptionSymbolLive(symbol)) {
					// FAITHFUL REPRODUCTION OF A LIVE BUG. websocket.ts routes any
					// symbol merely CONTAINING 'CE'/'PE' to the option branch, which
					// swallows five real equities (RELIANCE, ULTRACEMCO, CEATLTD,
					// BAJFINANCE, KAJARIACER). In production they get no VWAP, no
					// candles and no detectors. Replaying them correctly here would
					// report a system that does not exist, so we drop them exactly as
					// live does and surface the list in the report instead.
					continue
				} else {
					await updateVwap(symbol, tick.price, tick.volume)
					feedTick(symbol, tick.price, tick.volume, tick.timestamp)

					for (const entry of perSymbol.get(symbol) ?? []) await runDetector(entry, tick)
				}
			}

			// ── post-bar state advance ───────────────────────────────────────
			// Deliberately AFTER the ticks: see header note 3.
			if (isNifty) {
				await updateVwap(NIFTY_SYMBOL, bar.c, 1, bar.h, bar.l)
				await pushNiftyReturn(((bar.c - bar.o) / bar.o) * 100)
			}
		}
	} finally {
		backtestSink.collect = null
		currentAttribution = null
	}

	return {
		sessionDate,
		barsReplayed: stream.length,
		ticksDispatched,
		signals,
		errors,
		misroutedSymbols: misroutedByLiveTest(equitySymbols),
	}
}

/** True once the session has passed the intraday square-off boundary. */
export const isPastForceExit = (epochMs: number, forceExitMin: number): boolean =>
	istMinutesOf(epochMs) >= forceExitMin

export const isPastClose = (epochMs: number): boolean => istMinutesOf(epochMs) >= MARKET_CLOSE_MIN
