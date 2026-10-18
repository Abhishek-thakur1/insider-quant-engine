// ============================================================
// src/db/signalRecord.ts — one detector fire → one `signals` row (pure)
//
// The alert pipeline fills a SignalDraft as it runs (observation only); this
// module turns the draft into column values. No I/O, no env — fully testable.
//
// Gate semantics (AGENTS.md §5): only REGIME and EV can reject. Bayesian and
// Kelly contribute points to the score; the score threshold is the third
// rejection point. A stage that never ran is NULL ("not evaluated"), never PASS.
// ============================================================

import type { FilterDecision } from '../detectors/janeStreetFilter.js'
import type { DispatchBlock } from '../workers/alertPolicy.js'
import type { PromotionSource } from '../core/symbolSource.js'
import { parseRiskRewardFromTrigger } from '../utils/triggerLevels.js'
import { getISTDateString } from '../utils/marketHours.js'

export type SuppressReason =
	| 'FILTER_REJECTED'
	| 'FILTER_ERROR'
	| DispatchBlock // NOT_GATED | CAPITAL_SKIP | ZERO_SIZE
	| 'DUPLICATE'
	| 'CAP_REACHED'
	| 'SEND_FAILED'
	| 'WORKER_ERROR'

export interface SignalDraft {
	signalId: string
	firedAt: number // epoch ms
	payload: {
		symbol: string
		side: 'LONG' | 'SHORT'
		price: number
		trigger: string
		detectorName?: string | undefined
		regimeClass?: string | undefined
		durationClass?: string | undefined
	}
	shadowMode: boolean
	decision?: FilterDecision
	filterError?: boolean
	levels?: { entry: number; stopLoss: number; target1: number }
	sizing?: { qty: number; actualSize: number; capitalGated: boolean; skip: boolean }
	tradeRegistered?: boolean
	tradeId?: number | null
	suppressed?: SuppressReason
	alertSent?: boolean
}

export const newSignalDraft = (
	payload: SignalDraft['payload'],
	opts: { signalId: string; firedAt: number; shadowMode: boolean },
): SignalDraft => ({
	signalId: opts.signalId,
	firedAt: opts.firedAt,
	shadowMode: opts.shadowMode,
	payload: {
		symbol: payload.symbol,
		side: payload.side,
		price: payload.price,
		trigger: payload.trigger,
		detectorName: payload.detectorName,
		regimeClass: payload.regimeClass,
		durationClass: payload.durationClass,
	},
})

/** Column order of the INSERT. Every key of SignalRow, exactly once. */
export const SIGNAL_COLUMNS = [
	'signal_id',
	'fired_at',
	'trade_date',
	'symbol',
	'detector',
	'direction',
	'price',
	'trigger',
	'duration_class',
	'regime_class',
	'trigger_sl',
	'trigger_t1',
	'levels_parsed',
	'entry_price',
	'stop_price',
	'target_price',
	'regime_result',
	'regime_reason',
	'market_regime',
	'entropy',
	'bayesian_posterior',
	'bayesian_points',
	'bayesian_reason',
	'ev_result',
	'ev_value',
	'ev_reason',
	'kelly_half',
	'kelly_points',
	'kelly_reason',
	'score',
	'score_threshold',
	'score_result',
	'filter_result',
	'rejected_at',
	'shadow_mode',
	'breakdown',
	'capital_outcome',
	'qty',
	'actual_size',
	'promotion_source',
	'alert_sent',
	'alert_suppressed_reason',
	'trade_id',
	'data_quality',
] as const

export type SignalColumn = (typeof SIGNAL_COLUMNS)[number]
export type SignalRow = Record<SignalColumn, unknown>

/** Non-finite numbers (NaN, ±Infinity) become NULL rather than failing the insert. */
const num = (v: number | null | undefined): number | null =>
	typeof v === 'number' && Number.isFinite(v) ? v : null

type Component = FilterDecision['breakdown'][number]
const component = (d: FilterDecision, name: string): Component | undefined =>
	d.breakdown.find((b) => b.component === name)

export interface GateColumns {
	regime_result: 'PASS' | 'REJECT' | null
	regime_reason: string | null
	market_regime: string | null
	entropy: number | null
	bayesian_posterior: number | null
	bayesian_points: number | null
	bayesian_reason: string | null
	ev_result: 'PASS' | 'REJECT' | null
	ev_value: number | null
	ev_reason: string | null
	kelly_half: number | null
	kelly_points: number | null
	kelly_reason: string | null
	score: number | null
	score_threshold: number | null
	score_result: 'PASS' | 'BELOW_THRESHOLD' | null
	filter_result: 'PASSED' | 'REJECTED' | 'ERROR' | null
	rejected_at: 'REGIME' | 'EV' | 'SCORE' | null
	regime_guessed: boolean
}

export const gateColumns = (
	decision: FilterDecision | undefined,
	filterError: boolean,
	threshold: number,
): GateColumns => {
	const empty: GateColumns = {
		regime_result: null,
		regime_reason: null,
		market_regime: null,
		entropy: null,
		bayesian_posterior: null,
		bayesian_points: null,
		bayesian_reason: null,
		ev_result: null,
		ev_value: null,
		ev_reason: null,
		kelly_half: null,
		kelly_points: null,
		kelly_reason: null,
		score: null,
		score_threshold: num(threshold),
		score_result: null,
		filter_result: filterError ? 'ERROR' : null,
		rejected_at: null,
		regime_guessed: false,
	}
	if (!decision) return empty

	const regime = component(decision, 'REGIME')
	const bayes = component(decision, 'BAYESIAN')
	const evReject = component(decision, 'EV')
	const evKelly = component(decision, 'EV_KELLY')
	const out: GateColumns = {
		...empty,
		market_regime: decision.regime,
		entropy: num(decision.entropy),
		regime_result: decision.rejectedAt === 'REGIME' ? 'REJECT' : 'PASS',
		regime_reason: regime?.reason ?? null,
		// classificationSource is appended as "[TYPE/source]" when the regime gate passes
		regime_guessed: /\[[A-Z_]+\/(name|trigger|default)\]\s*$/.test(regime?.reason ?? ''),
	}
	if (decision.rejectedAt === 'REGIME') {
		return { ...out, score: num(decision.score), filter_result: 'REJECTED', rejected_at: 'REGIME' }
	}

	out.bayesian_posterior = num(decision.posterior)
	out.bayesian_points = num(bayes?.points)
	out.bayesian_reason = bayes?.reason ?? null
	out.ev_value = num(decision.ev)
	out.score = num(decision.score)

	if (decision.rejectedAt === 'EV') {
		return {
			...out,
			ev_result: 'REJECT',
			ev_reason: evReject?.reason ?? null,
			filter_result: 'REJECTED',
			rejected_at: 'EV',
		}
	}

	out.ev_result = 'PASS'
	out.ev_reason = evKelly?.reason ?? null
	out.kelly_half = num(decision.kellyHalf)
	out.kelly_points = num(evKelly?.points)
	out.kelly_reason = evKelly?.reason ?? null
	out.score_result = decision.passed ? 'PASS' : 'BELOW_THRESHOLD'
	out.filter_result = decision.passed ? 'PASSED' : 'REJECTED'
	out.rejected_at = decision.passed ? null : 'SCORE'
	return out
}

export const capitalOutcome = (
	sizing: SignalDraft['sizing'],
): 'TRADED' | 'REDUCED' | 'SKIPPED_CAPITAL' | null => {
	if (!sizing) return null
	if (!sizing.capitalGated) return 'TRADED'
	return sizing.skip || sizing.actualSize < 1 ? 'SKIPPED_CAPITAL' : 'REDUCED'
}

export const suppressionReason = (d: SignalDraft): SuppressReason | null => {
	if (d.alertSent) return null
	// A filter error flows on as "ungated", so the policy reports NOT_GATED; name the real cause.
	if (d.filterError && (d.suppressed === 'NOT_GATED' || !d.suppressed)) return 'FILTER_ERROR'
	return d.suppressed ?? 'WORKER_ERROR'
}

const isOptionSymbol = (s: string): boolean => s.endsWith('CE') || s.endsWith('PE')

export const buildSignalRow = (
	d: SignalDraft,
	ctx: { threshold: number; promotionSource: PromotionSource },
): SignalRow => {
	const p = d.payload
	const g = gateColumns(d.decision, !!d.filterError, ctx.threshold)
	const lv = parseRiskRewardFromTrigger(p.trigger, p.price)

	const flags: string[] = []
	if (isOptionSymbol(p.symbol)) flags.push('index_option_proxy')
	if (!lv.parsed) flags.push('levels_default_rr')
	if (g.regime_guessed) flags.push('regime_guessed')

	return {
		signal_id: d.signalId,
		fired_at: new Date(d.firedAt).toISOString(),
		trade_date: getISTDateString(d.firedAt),
		symbol: p.symbol,
		detector: p.detectorName || 'UNKNOWN',
		direction: p.side,
		price: num(p.price),
		trigger: p.trigger,
		duration_class: p.durationClass || 'INTRADAY',
		regime_class: p.regimeClass ?? null,
		trigger_sl: num(lv.sl),
		trigger_t1: num(lv.t1),
		levels_parsed: lv.parsed,
		entry_price: num(d.levels?.entry),
		stop_price: num(d.levels?.stopLoss),
		target_price: num(d.levels?.target1),
		regime_result: g.regime_result,
		regime_reason: g.regime_reason,
		market_regime: g.market_regime,
		entropy: g.entropy,
		bayesian_posterior: g.bayesian_posterior,
		bayesian_points: g.bayesian_points,
		bayesian_reason: g.bayesian_reason,
		ev_result: g.ev_result,
		ev_value: g.ev_value,
		ev_reason: g.ev_reason,
		kelly_half: g.kelly_half,
		kelly_points: g.kelly_points,
		kelly_reason: g.kelly_reason,
		score: g.score,
		score_threshold: g.score_threshold,
		score_result: g.score_result,
		filter_result: g.filter_result,
		rejected_at: g.rejected_at,
		shadow_mode: d.shadowMode,
		breakdown: d.decision ? JSON.stringify(d.decision.breakdown) : null,
		capital_outcome: capitalOutcome(d.sizing),
		qty: num(d.sizing?.qty),
		actual_size: num(d.sizing?.actualSize),
		promotion_source: ctx.promotionSource,
		alert_sent: !!d.alertSent,
		alert_suppressed_reason: suppressionReason(d),
		trade_id: d.tradeId ?? null,
		data_quality: flags,
	}
}
