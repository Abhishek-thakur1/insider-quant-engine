// ============================================================
// backtest/sim/exit.ts — outcome simulation
//
// Turns a gated signal into a realised R-multiple by walking the underlying's
// forward bars.
//
// EXIT LEVELS. Detectors embed `SL ₹x | T1 ₹y` in their trigger string, and
// the live EV gate recovers them with `parseRiskRewardFromTrigger`. We call
// that SAME exported function rather than re-deriving the regexes, so the
// levels an outcome is measured against are exactly the levels the gate scored.
// When a detector embeds no levels, the harness default from config.SIM is used
// and the trade is labelled `harness-default` so the report can say so.
//
// FOUR THINGS THAT KEEP THIS HONEST:
//
//  1. Pessimistic intra-bar resolution. If a bar's range contains both the stop
//     and the target, the stop is taken. A 1-minute bar does not record which
//     came first, and assuming the target would flatter every result.
//
//  2. Non-zero slippage on both legs, in basis points so it scales across a
//     ₹50 stock and a 25,000 index.
//
//  3. No fill during a circuit lock. If the stop falls inside a bar that looks
//     locked (zero range, non-zero volume), the exit is DEFERRED to the next
//     bar with a real range — matching the live spec's stop-cannot-fill rule
//     rather than assuming an idealised fill at an untradable price.
//
//  4. Forced square-off. Anything still open at 15:15 IST exits at that bar's
//     close, because MIS intraday positions are closed by the broker.
//
// OPTION-ROUTED DETECTORS — IMPORTANT LIMITATION. Several Nifty detectors alert
// on an option strike (`NIFTY 24500 CE`) while their SL/T1 are INDEX levels.
// There is no historical option premium series available, so R for those
// detectors is measured on the underlying index move. Real option P&L would
// differ through delta and theta. The report flags every such detector.
// ============================================================

import { parseRiskRewardFromTrigger } from '../../src/detectors/janeStreetFilter.js'
import { NIFTY_SYMBOL, SIM, type ExitBasis } from '../config.js'
import { istMinutesOf } from '../core/clock.js'
import { isOptionSymbolPrecise } from '../core/symbolClass.js'
import { looksCircuitLocked } from '../replay/barToTicks.js'
import type { Bar } from '../data/store.js'
import type { RawSignal } from '../replay/engine.js'

export type ExitReason = 'stop' | 'target' | 'forced-square-off' | 'session-end' | 'no-forward-data'

export interface SimulatedTrade {
	detectorId: string
	sessionDate: string
	symbol: string
	underlying: string
	side: 'LONG' | 'SHORT'
	entryTs: number
	exitTs: number
	entryPrice: number
	exitPrice: number
	stopLevel: number
	targetLevel: number
	/** Realised R, after slippage on both legs. */
	r: number
	exitReason: ExitReason
	exitBasis: ExitBasis
	holdingMinutes: number
	/** Bars where a stop was due but the bar looked circuit-locked. */
	deferredByLock: number
	/** Diagnostic: did price also reach the detector's T2 before exiting? */
	t2Reached: boolean
	gateScore: number
	gatePassed: boolean
}

/**
 * Which price series an alert's levels refer to. Option alerts carry index
 * levels, so they must be walked against the index — the same rule the live
 * filter uses to pick a structure symbol.
 */
export const resolveUnderlying = (alertSymbol: string): string => {
	// PRECISE, not the live substring test. Getting this wrong would walk a
	// RELIANCE alert's levels against the Nifty series — see core/symbolClass.ts.
	if (alertSymbol === NIFTY_SYMBOL) return NIFTY_SYMBOL
	return isOptionSymbolPrecise(alertSymbol) ? NIFTY_SYMBOL : alertSymbol
}

const parseT2 = (trigger: string): number | null => {
	const m = trigger.match(/T2[:\s]*₹?([\d,]+(?:\.\d+)?)/i)
	if (!m) return null
	const v = parseFloat(m[1]!.replace(/,/g, ''))
	return Number.isFinite(v) && v > 0 ? v : null
}

export interface ExitLevels {
	stop: number
	target: number
	t2: number | null
	basis: ExitBasis
}

/** Reconstruct signed levels from the live parser's unsigned risk/reward. */
export const deriveLevels = (signal: RawSignal): ExitLevels => {
	const { price, side, trigger } = signal.payload
	const { risk, reward, parsed } = parseRiskRewardFromTrigger(trigger, price)

	if (parsed) {
		return side === 'LONG'
			? {
					stop: price - risk,
					target: price + reward,
					t2: parseT2(trigger),
					basis: 'detector-defined',
				}
			: {
					stop: price + risk,
					target: price - reward,
					t2: parseT2(trigger),
					basis: 'detector-defined',
				}
	}

	// No levels in the trigger — documented harness default.
	const defRisk = price * (SIM.defaultStopPct / 100)
	const defReward = defRisk * SIM.defaultTargetR
	return side === 'LONG'
		? { stop: price - defRisk, target: price + defReward, t2: null, basis: 'harness-default' }
		: { stop: price + defRisk, target: price - defReward, t2: null, basis: 'harness-default' }
}

const applySlippage = (price: number, side: 'LONG' | 'SHORT', leg: 'entry' | 'exit'): number => {
	const factor = SIM.slippageBps / 10_000
	// Slippage always works against the trade: pay up on entry, give up on exit.
	const adverse = leg === 'entry' ? (side === 'LONG' ? 1 : -1) : side === 'LONG' ? -1 : 1
	return price * (1 + adverse * factor)
}

/**
 * Walk forward bars and resolve the trade.
 * `forwardBars` must be the underlying's bars strictly AFTER the entry
 * timestamp, ascending — the caller slices them, which is also where the
 * no-look-ahead property is enforced.
 */
export const simulateExit = (
	signal: RawSignal,
	forwardBars: Bar[],
	underlying: string,
): SimulatedTrade | null => {
	const { side, price } = signal.payload
	const levels = deriveLevels(signal)
	const nominalRisk = Math.abs(price - levels.stop)

	// A zero-risk signal cannot be expressed in R. Skipping is correct: a
	// synthetic risk denominator would invent the very number we are measuring.
	if (!(nominalRisk > 0)) return null

	const entryFill = applySlippage(price, side, 'entry')
	const isLong = side === 'LONG'

	if (forwardBars.length === 0) {
		return {
			detectorId: signal.detectorId,
			sessionDate: signal.sessionDate,
			symbol: signal.payload.symbol,
			underlying,
			side,
			entryTs: signal.ts,
			exitTs: signal.ts,
			entryPrice: entryFill,
			exitPrice: entryFill,
			stopLevel: levels.stop,
			targetLevel: levels.target,
			r: 0,
			exitReason: 'no-forward-data',
			exitBasis: levels.basis,
			holdingMinutes: 0,
			deferredByLock: 0,
			t2Reached: false,
			gateScore: signal.gate?.score ?? 0,
			gatePassed: signal.gate?.passed ?? false,
		}
	}

	let deferredByLock = 0
	let t2Reached = false
	let exitPrice: number | null = null
	let exitTs = 0
	let exitReason: ExitReason = 'session-end'

	for (const bar of forwardBars) {
		if (levels.t2 !== null && !t2Reached) {
			t2Reached = isLong ? bar.h >= levels.t2 : bar.l <= levels.t2
		}

		const stopTouched = isLong ? bar.l <= levels.stop : bar.h >= levels.stop
		const targetTouched = isLong ? bar.h >= levels.target : bar.l <= levels.target

		// Circuit lock: a stop is due but there is no tradable liquidity at that
		// price. Do not fill; carry the position to the next tradable bar.
		if (stopTouched && SIM.circuitLockZeroRange && looksCircuitLocked(bar)) {
			deferredByLock++
			continue
		}

		if (stopTouched && targetTouched) {
			// Ambiguous bar — take the stop (see header note 1).
			exitPrice = SIM.pessimisticIntraBar ? levels.stop : levels.target
			exitReason = SIM.pessimisticIntraBar ? 'stop' : 'target'
			exitTs = bar.t
			break
		}
		if (stopTouched) {
			exitPrice = levels.stop
			exitReason = 'stop'
			exitTs = bar.t
			break
		}
		if (targetTouched) {
			exitPrice = levels.target
			exitReason = 'target'
			exitTs = bar.t
			break
		}

		// Intraday square-off.
		if (istMinutesOf(bar.t) >= SIM.forceExitIstMinutes) {
			exitPrice = bar.c
			exitReason = 'forced-square-off'
			exitTs = bar.t
			break
		}
	}

	if (exitPrice === null) {
		const last = forwardBars[forwardBars.length - 1]!
		exitPrice = last.c
		exitReason = 'session-end'
		exitTs = last.t
	}

	const exitFill = applySlippage(exitPrice, side, 'exit')
	const pnlPerUnit = isLong ? exitFill - entryFill : entryFill - exitFill
	const r = pnlPerUnit / nominalRisk

	return {
		detectorId: signal.detectorId,
		sessionDate: signal.sessionDate,
		symbol: signal.payload.symbol,
		underlying,
		side,
		entryTs: signal.ts,
		exitTs,
		entryPrice: entryFill,
		exitPrice: exitFill,
		stopLevel: levels.stop,
		targetLevel: levels.target,
		r,
		exitReason,
		exitBasis: levels.basis,
		holdingMinutes: Math.max(0, Math.round((exitTs - signal.ts) / 60_000)),
		deferredByLock,
		t2Reached,
		gateScore: signal.gate?.score ?? 0,
		gatePassed: signal.gate?.passed ?? false,
	}
}
