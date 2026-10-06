// ============================================================
// alertPolicy.ts — what is allowed to reach the Telegram channel
//
// Pure functions + a minimal injected store, so tests exercise exactly the
// code the worker runs (no env, no Redis connection, no Telegram).
//
// Policy (decided 2026-10-06, see AGENTS.md):
//   1. Only signals that PASSED the JaneStreetFilter (gated = true) are sent.
//      A filter error records the trade as ungated and sends nothing.
//   2. A trade fully skipped by the capital constraint is never sent.
//      A REDUCED trade is sent as a normal alert carrying the reduced qty,
//      with no capital-constraint wording.
//   3. At most one alert per detector + symbol per IST day (survives restarts —
//      the key lives in Redis, not in process memory).
//   4. At most TELEGRAM_MAX_ALERTS_PER_DAY alerts per IST day. When the cap is
//      first exceeded, one admin notice is sent; after that, silence.
//   Postgres recording is NOT affected by any of this — the worker registers
//   the trade before consulting the policy.
// ============================================================

export { getISTDateString } from '../utils/marketHours.js'

// Defaults are noise-control choices, not validated parameters.
export const DEFAULT_MAX_ALERTS_PER_DAY = 20
const KEY_TTL_SECONDS = 36 * 3600 // outlives the IST day; the date is in the key anyway

export const parseMaxAlertsPerDay = (raw: string | undefined): number => {
	const n = Number(raw)
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ALERTS_PER_DAY
}

// Option-routed Nifty alerts carry the strike in the symbol ("NIFTY 25000 CE"),
// which changes as spot moves. Dedup on the underlying so one Nifty detector
// cannot alert repeatedly by drifting across strikes.
export const dedupSymbol = (symbol: string): string =>
	/^NIFTY\s+\d+\s*(CE|PE)$/.test(symbol) ? 'NIFTY' : symbol

// ── Sizing ──────────────────────────────────────────────────────────────────

export interface SizingInput {
	entry: number
	stopLoss: number
	capitalBase: number
	currentNotional: number
	behavior: string // 'REDUCE' | 'SKIP'
}

export interface SizingResult {
	qty: number // unconstrained size, recorded for significance testing
	actualSize: number // size after the capital constraint (0 = skipped)
	capitalGated: boolean
	skip: boolean
}

export const computeSizing = (i: SizingInput): SizingResult => {
	const maxSingleName = i.capitalBase * 0.1
	const riskAmount = i.capitalBase * 0.01
	const stopDistance = Math.abs(i.entry - i.stopLoss) || i.entry * 0.01

	let qty = Math.floor(riskAmount / stopDistance)
	if (qty < 1) qty = 1
	if (qty * i.entry > maxSingleName) qty = Math.floor(maxSingleName / i.entry)

	const headroom = i.capitalBase - i.currentNotional
	if (qty * i.entry <= headroom) {
		return { qty, actualSize: qty, capitalGated: false, skip: false }
	}
	if (i.behavior === 'SKIP') return { qty, actualSize: 0, capitalGated: true, skip: true }

	const reduced = Math.floor(Math.max(0, headroom) / i.entry)
	return reduced >= 1
		? { qty, actualSize: reduced, capitalGated: true, skip: false }
		: { qty, actualSize: 0, capitalGated: true, skip: true }
}

// ── Dispatch eligibility (no I/O) ───────────────────────────────────────────

export type DispatchBlock = 'NOT_GATED' | 'CAPITAL_SKIP' | 'ZERO_SIZE'

// Option-routed Nifty alerts are priced at the INDEX level (~25 000), so the
// ₹10k single-name cap always sizes them to 0. Their paper size is meaningless
// (known issue), so the size checks apply to equities only.
export const dispatchBlockReason = (o: {
	gated: boolean
	skip: boolean
	actualSize: number
	isOption: boolean
}): DispatchBlock | null => {
	if (!o.gated) return 'NOT_GATED'
	if (o.isOption) return null
	if (o.skip) return 'CAPITAL_SKIP'
	if (o.actualSize < 1) return 'ZERO_SIZE'
	return null
}

// ── Per-day dedup + cap (Redis-backed) ──────────────────────────────────────

// The subset of node-redis v5 the policy needs. Injected for tests.
export interface AlertStore {
	set(key: string, value: string, opts: { NX: true; EX: number }): Promise<string | null>
	incr(key: string): Promise<number>
	expire(key: string, seconds: number): Promise<number | boolean>
	del(key: string): Promise<number>
	decr(key: string): Promise<number>
}

export type SlotDecision =
	| { action: 'SEND' }
	| { action: 'DUPLICATE' }
	| { action: 'CAP_REACHED'; notifyCap: boolean }

export const alertKeys = (day: string, detector: string, symbol: string) => ({
	dedup: `alert:sent:${day}:${detector}:${dedupSymbol(symbol)}`,
	count: `alert:count:${day}`,
})

export const reserveAlertSlot = async (
	store: AlertStore,
	o: { day: string; detector: string; symbol: string; maxPerDay: number },
): Promise<SlotDecision> => {
	const keys = alertKeys(o.day, o.detector, o.symbol)

	// Atomic claim: only the first caller per detector+symbol+day gets 'OK'.
	const claimed = await store.set(keys.dedup, String(Date.now()), { NX: true, EX: KEY_TTL_SECONDS })
	if (claimed === null) return { action: 'DUPLICATE' }

	const n = await store.incr(keys.count)
	if (n === 1) await store.expire(keys.count, KEY_TTL_SECONDS)
	if (n > o.maxPerDay) return { action: 'CAP_REACHED', notifyCap: n === o.maxPerDay + 1 }
	return { action: 'SEND' }
}

// If the Telegram send itself fails, give the slot back so a later signal for
// the same setup is not silently suppressed for the rest of the day.
export const releaseAlertSlot = async (
	store: AlertStore,
	o: { day: string; detector: string; symbol: string },
): Promise<void> => {
	const keys = alertKeys(o.day, o.detector, o.symbol)
	await store.del(keys.dedup)
	await store.decr(keys.count)
}

// ── Message (equity cash) ───────────────────────────────────────────────────

export interface EquityMessageInput {
	symbol: string
	side: 'LONG' | 'SHORT'
	trigger: string
	volumeSpikeRatio: number
	entry: number
	stopLoss: number
	target1: number
	target2: number
	qty: number
	durationClass: 'INTRADAY' | 'SWING'
	scoreLines: string
}

export const buildEquityMessage = (m: EquityMessageInput): string => {
	const actionLabel = m.side === 'LONG' ? '🟢 BUY LONG' : '🔴 SELL SHORT'
	const volumeStr =
		m.volumeSpikeRatio > 1.2 ? `\n• Volume: ${m.volumeSpikeRatio.toFixed(1)}x vs baseline` : ''
	const horizon = m.durationClass === 'SWING' ? 'Swing (multi-day)' : 'Intraday — closed by 15:15'

	return `
⚡ *NEW TRADE ALERT* ⚡

${actionLabel}
📌 *Asset:* ${m.symbol}

*📊 The Edge:*
• Strategy: ${m.trigger}${volumeStr}

*🎯 Execution Plan:*
• *Entry:* ₹${m.entry}
• *Stop Loss:* ₹${m.stopLoss}
• *Target 1:* ₹${m.target1}
• *Target 2:* ₹${m.target2}
• *Qty:* ${m.qty}${m.scoreLines}

⏳ *Horizon:* ${horizon}
⚖️ _Paper-trading signal. Respect the levels._
`.trim()
}
