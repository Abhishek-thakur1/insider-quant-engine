// ============================================================
// src/core/tradeLevels.ts — the entry / stop / target levels a fire is tracked with.
//
// Moved out of workers/alertPipeline.ts unchanged (2026-10-27), so that the paper trade and the
// EV-reject shadow outcome (core/evShadow.ts) are guaranteed to use the same numbers.
// ============================================================

import type { AlertPayload } from '../workers/telegramWorker.js'

export interface TradeLevels {
	entry: number
	stopLoss: number
	target1: number
	target2: number
	/** Nifty option fire: the levels are index-level, parsed from the trigger text. */
	isOptions: boolean
}

export const computeTradeLevels = (data: AlertPayload): TradeLevels => {
	const isLong = data.side === 'LONG'
	const isOptions = data.symbol.endsWith('CE') || data.symbol.endsWith('PE')
	const entry = data.price

	let stopLoss: number
	let target1: number
	let target2: number

	if (!isOptions) {
		stopLoss = isLong
			? Number((data.vwap * 0.998).toFixed(2))
			: Number((data.vwap * 1.002).toFixed(2))
		const risk = Math.abs(entry - stopLoss)
		target1 = isLong
			? Number((entry + risk * 1.5).toFixed(2))
			: Number((entry - risk * 1.5).toFixed(2))
		target2 = isLong
			? Number((entry + risk * 2.5).toFixed(2))
			: Number((entry - risk * 2.5).toFixed(2))
	} else {
		// Option alerts embed index-level SL/T1 in the trigger text.
		const slMatch = data.trigger.match(/SL ₹(\d+(\.\d+)?)/)
		const t1Match = data.trigger.match(/T1 ₹(\d+(\.\d+)?)/)
		stopLoss = slMatch ? Number(slMatch[1]) : isLong ? entry * 0.9 : entry * 1.1
		target1 = t1Match ? Number(t1Match[1]) : isLong ? entry * 1.2 : entry * 0.8
		target2 = target1
	}
	return { entry, stopLoss, target1, target2, isOptions }
}
