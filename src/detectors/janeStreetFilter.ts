// ============================================================

//
// HOW THIS FIXES  REVERSAL PROBLEM:
//
// Currently your engine fires signals when a single detector
// confirms. This creates false conviction because:
//   1. No check if the market regime supports this detector type
//   2. No probability calculation across multiple signals
//   3. No EV check — you take low-edge trades as readily as high-edge ones
//   4. No size discipline — every signal gets the same treatment
//
// THE JS APPROACH:
// This filter intercepts every signal BEFORE Telegram fires.
// It runs 4 sequential gates. ALL must pass.
//
//   Gate 1: REGIME  — Is this detector appropriate for the current H?
//   Gate 2: BAYES   — Is posterior probability > 62%?
//   Gate 3: EV      — Is expected value positive (E[P&L] > 0)?
//   Gate 4: KELLY   — Is the edge large enough to size (Kelly > 0.5%)?
//
// If any gate fails: signal is BLOCKED, rejection logged to Redis.
// If all gates pass: signal fires WITH position sizing guidance.
//
// IMPLEMENTATION:
// Zero changes to existing detectors. The filter wraps
// sendTelegramAlert() in telegramWorker.ts — it's a pure
// interception layer. Detectors don't know it exists.
// ============================================================

import { redisClient } from '../config/redis.js'
import { computeBayesianPosterior } from '../utils/bayesianEngine.js'
import { getMarketRegime, checkRegimeCompatibility } from '../utils/regimeDetector.js'
import type { AlertPayload } from '../workers/telegramWorker.js'
import type { TradeSide } from '../core/types.js'

// ─── TUNABLE JS FILTER CONSTANTS ─────────────────────────────────────────────
const MIN_POSTERIOR = 0.6 // Minimum Bayesian confidence to fire
const MIN_EV_PTS = 5 // Minimum expected value in index points (₹5 per unit for scalps)
const MIN_KELLY_HALF_PCT = 0.008 // Half-Kelly must be >= 0.8% (there must be a real edge)
const DEFAULT_RR = 1.5 // Default R:R assumption if unparseable from trigger
const DEFAULT_RISK_PCT = 0.003 // Default risk = 0.3% of price if no SL in trigger
const JS_LOG_KEY = 'jsfilter:decisions'
const JS_STATS_KEY = 'jsfilter:stats'
// ─────────────────────────────────────────────────────────────────────────────

export interface FilterDecision {
	passed: boolean
	posterior: number // Bayesian P(win)
	ev: number // Expected value in points/₹
	kellyHalf: number // Half-Kelly % (recommended position size)
	regime: string // Current market regime
	entropy: number // Shannon entropy value
	sizeMult: number // Position size multiplier (0, 0.5, or 1.0)
	gateResults: GateResult[]
	rejectedAt?: GateName
	positionNote: string // Human-readable sizing guidance
}

interface GateResult {
	gate: GateName
	passed: boolean
	value: number | string
	reason: string
}

type GateName = 'REGIME' | 'BAYESIAN' | 'EV' | 'KELLY'

// ── Parse Stop Loss and Target 1 from trigger string ─────────────────────────
// Detectors include "SL ₹XXXX" and "T1 ₹XXXX" in their triggers.
// We parse these to compute actual R:R for the EV calculation.
const parseRiskRewardFromTrigger = (
	trigger: string,
	price: number,
): { risk: number; reward: number; rr: number; parsed: boolean } => {
	// Match patterns like: "SL ₹22450", "SL: ₹22450.50", "SL ₹22,450"
	const slMatch = trigger.match(/SL[:\s]*₹?([\d,]+(?:\.\d+)?)/i)
	// Match patterns like: "T1 ₹22600", "T1: ₹22600.50"
	const t1Match = trigger.match(/T1[:\s]*₹?([\d,]+(?:\.\d+)?)/i)

	if (slMatch && t1Match) {
		const sl = parseFloat(slMatch[1]!.replace(/,/g, ''))
		const t1 = parseFloat(t1Match[1]!.replace(/,/g, ''))

		if (sl > 0 && t1 > 0 && price > 0) {
			const risk = Math.abs(price - sl)
			const reward = Math.abs(price - t1)

			// Sanity check: risk/reward should be reasonable
			if (risk > 0 && reward > 0 && risk < price * 0.1 && reward < price * 0.2) {
				return { risk, reward, rr: reward / risk, parsed: true }
			}
		}
	}

	// Fallback: use default assumptions
	const defaultRisk = price * DEFAULT_RISK_PCT
	const defaultReward = defaultRisk * DEFAULT_RR
	return { risk: defaultRisk, reward: defaultReward, rr: DEFAULT_RR, parsed: false }
}

// ── Compute Expected Value ────────────────────────────────────────────────────
// EV = P(win) × Reward − P(loss) × Risk
// This is the poker player's fundamental question: "What's my edge?"
const computeEV = (pWin: number, reward: number, risk: number): number => {
	return pWin * reward - (1 - pWin) * risk
}

// ── Compute Kelly Criterion ───────────────────────────────────────────────────
// Full Kelly = P(win) − P(loss) / R:R
// Half Kelly = Full Kelly / 2 (standard safety margin)
// Cap at 5% of capital — no single trade should ever risk more.
const computeKelly = (pWin: number, rr: number): number => {
	const fullKelly = pWin - (1 - pWin) / Math.max(rr, 0.1)
	const halfKelly = Math.max(0, fullKelly) / 2
	return Math.min(halfKelly, 0.05) // Hard cap at 5% half-Kelly
}

// ── Position Note Generator ───────────────────────────────────────────────────
const buildPositionNote = (
	kelly: number,
	posterior: number,
	sizeMult: number,
	regime: string,
): string => {
	const effectiveKelly = kelly * sizeMult
	const kellyPct = (effectiveKelly * 100).toFixed(1)
	const postPct = (posterior * 100).toFixed(0)

	if (sizeMult === 0.5) {
		return `📊 JS [${regime.toUpperCase()}]: Half-Kelly ${kellyPct}% × 0.5 regime factor | P=${postPct}%`
	}
	if (effectiveKelly >= 0.03) {
		return `🏦 JS [${regime.toUpperCase()}]: HIGH edge — Half-Kelly ${kellyPct}% | P=${postPct}%`
	}
	if (effectiveKelly >= 0.015) {
		return `📊 JS [${regime.toUpperCase()}]: MODERATE edge — Half-Kelly ${kellyPct}% | P=${postPct}%`
	}
	return `⚡ JS [${regime.toUpperCase()}]: THIN edge — Half-Kelly ${kellyPct}% (size small) | P=${postPct}%`
}

// ── The Master Filter ─────────────────────────────────────────────────────────
export const runJaneStreetFilter = async (
	payload: AlertPayload,
	detectorName?: string,
): Promise<FilterDecision> => {
	const side = payload.side as TradeSide
	const gates: GateResult[] = []
	let rejectedAt: GateName | undefined

	// ── GATE 1: Regime Compatibility ─────────────────────────────────────────
	const regimeState = await getMarketRegime()
	const regimeCheck = checkRegimeCompatibility(
		regimeState.regime,
		regimeState.entropy,
		detectorName,
		payload.trigger,
	)

	gates.push({
		gate: 'REGIME',
		passed: regimeCheck.allowed,
		value: `H=${regimeState.entropy.toFixed(2)} [${regimeState.regime}]`,
		reason: regimeCheck.reason,
	})

	if (!regimeCheck.allowed) {
		rejectedAt = 'REGIME'
		const decision: FilterDecision = {
			passed: false,
			posterior: 0,
			ev: 0,
			kellyHalf: 0,
			regime: regimeState.regime,
			entropy: regimeState.entropy,
			sizeMult: 0,
			gateResults: gates,
			rejectedAt,
			positionNote: `🚫 REGIME GATE: ${regimeCheck.reason}`,
		}
		await persistDecision(payload, decision, detectorName)
		return decision
	}

	// ── GATE 2: Bayesian Posterior ────────────────────────────────────────────
	const bayesian = await computeBayesianPosterior(payload, side)

	gates.push({
		gate: 'BAYESIAN',
		passed: bayesian.pass,
		value: `P=${(bayesian.posterior * 100).toFixed(0)}%`,
		reason:
			bayesian.reasons.join(' | ') +
			(bayesian.pass ? '' : ` → BELOW ${MIN_POSTERIOR * 100}% threshold`),
	})

	if (!bayesian.pass) {
		rejectedAt = 'BAYESIAN'
		const decision: FilterDecision = {
			passed: false,
			posterior: bayesian.posterior,
			ev: 0,
			kellyHalf: 0,
			regime: regimeState.regime,
			entropy: regimeState.entropy,
			sizeMult: 0,
			gateResults: gates,
			rejectedAt,
			positionNote: `🚫 BAYESIAN GATE: P=${(bayesian.posterior * 100).toFixed(0)}% < ${MIN_POSTERIOR * 100}%`,
		}
		await persistDecision(payload, decision, detectorName)
		return decision
	}

	const pWin = bayesian.posterior

	// ── GATE 3: Expected Value ────────────────────────────────────────────────
	const { risk, reward, rr, parsed } = parseRiskRewardFromTrigger(payload.trigger, payload.price)
	const ev = computeEV(pWin, reward, risk)
	const evLabel = parsed ? `EV=₹${ev.toFixed(1)}` : `EV≈₹${ev.toFixed(1)} (est.)`

	gates.push({
		gate: 'EV',
		passed: ev >= MIN_EV_PTS,
		value: evLabel,
		reason: `R:R=${rr.toFixed(2)} | Risk=${risk.toFixed(0)}pts | Reward=${reward.toFixed(0)}pts | P=${(pWin * 100).toFixed(0)}%${ev < MIN_EV_PTS ? ' → NEGATIVE EV' : ''}`,
	})

	if (ev < MIN_EV_PTS) {
		rejectedAt = 'EV'
		const decision: FilterDecision = {
			passed: false,
			posterior: pWin,
			ev,
			kellyHalf: 0,
			regime: regimeState.regime,
			entropy: regimeState.entropy,
			sizeMult: 0,
			gateResults: gates,
			rejectedAt,
			positionNote: `🚫 EV GATE: ${evLabel} < ₹${MIN_EV_PTS} minimum`,
		}
		await persistDecision(payload, decision, detectorName)
		return decision
	}

	// ── GATE 4: Kelly Size Check ──────────────────────────────────────────────
	const kellyHalf = computeKelly(pWin, rr)
	const effectiveKelly = kellyHalf * regimeCheck.sizeMult

	gates.push({
		gate: 'KELLY',
		passed: effectiveKelly >= MIN_KELLY_HALF_PCT,
		value: `½K=${(effectiveKelly * 100).toFixed(1)}%`,
		reason: `Full Kelly=${(kellyHalf * 2 * 100).toFixed(1)}% → Half=${(kellyHalf * 100).toFixed(1)}% × ${regimeCheck.sizeMult} regime mult = ${(effectiveKelly * 100).toFixed(1)}%${effectiveKelly < MIN_KELLY_HALF_PCT ? ' → EDGE TOO THIN' : ''}`,
	})

	if (effectiveKelly < MIN_KELLY_HALF_PCT) {
		rejectedAt = 'KELLY'
		const decision: FilterDecision = {
			passed: false,
			posterior: pWin,
			ev,
			kellyHalf: effectiveKelly,
			regime: regimeState.regime,
			entropy: regimeState.entropy,
			sizeMult: regimeCheck.sizeMult,
			gateResults: gates,
			rejectedAt,
			positionNote: `🚫 KELLY GATE: Edge ${(effectiveKelly * 100).toFixed(1)}% < ${MIN_KELLY_HALF_PCT * 100}% minimum`,
		}
		await persistDecision(payload, decision, detectorName)
		return decision
	}

	// ── ALL GATES PASSED ──────────────────────────────────────────────────────
	const positionNote = buildPositionNote(kellyHalf, pWin, regimeCheck.sizeMult, regimeState.regime)

	const decision: FilterDecision = {
		passed: true,
		posterior: pWin,
		ev,
		kellyHalf: effectiveKelly,
		regime: regimeState.regime,
		entropy: regimeState.entropy,
		sizeMult: regimeCheck.sizeMult,
		gateResults: gates,
		positionNote,
	}

	await persistDecision(payload, decision, detectorName)
	return decision
}

// ── Persist decision to Redis for post-session analysis ──────────────────────
// Gives you a full audit trail of every signal and why it was approved/rejected.
// Run `redis-cli lrange jsfilter:decisions 0 49` after market close to review.
const persistDecision = async (
	payload: AlertPayload,
	decision: FilterDecision,
	detectorName?: string,
): Promise<void> => {
	const entry = {
		ts: new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(11, 19), // IST time HH:MM:SS
		symbol: payload.symbol,
		side: payload.side,
		price: payload.price.toFixed(2),
		detector: detectorName ?? 'unknown',
		result: decision.passed ? 'APPROVED' : `REJECTED@${decision.rejectedAt}`,
		P: `${(decision.posterior * 100).toFixed(0)}%`,
		EV: `₹${decision.ev.toFixed(0)}`,
		K: `${(decision.kellyHalf * 100).toFixed(1)}%`,
		H: decision.entropy.toFixed(2),
		regime: decision.regime,
	}

	const raw = JSON.stringify(entry)

	// Log to ordered decision list (last 500 entries)
	await redisClient.multi().lPush(JS_LOG_KEY, raw).lTrim(JS_LOG_KEY, 0, 499).exec()

	// Update daily stats counters
	const statsKey = `${JS_STATS_KEY}:${new Date().toISOString().split('T')[0]}`
	const field = decision.passed ? 'approved' : `rejected_${decision.rejectedAt ?? 'unknown'}`

	await redisClient
		.multi()
		.hIncrBy(statsKey, field, 1)
		.hIncrBy(statsKey, 'total', 1)
		.expire(statsKey, 86400) // Expire at end of day
		.exec()

	// Console log for debugging
	if (decision.passed) {
		console.log(
			`[JS ✅ PASS] ${payload.symbol} ${payload.side} | ` +
				`P=${(decision.posterior * 100).toFixed(0)}% | ` +
				`EV=₹${decision.ev.toFixed(0)} | ` +
				`Kelly=${(decision.kellyHalf * 100).toFixed(1)}% | ` +
				`Regime=${decision.regime} (H=${decision.entropy.toFixed(2)})`,
		)
	} else {
		console.log(
			`[JS ❌ ${decision.rejectedAt}] ${payload.symbol} ${payload.side} @ ₹${payload.price} | ` +
				`${decision.positionNote}`,
		)
	}
}

// ── Utility: Get today's filter stats ────────────────────────────────────────
// Call this to see how many signals were approved vs rejected today.
// redis-cli hgetall jsfilter:stats:2025-05-18
export const getFilterStats = async (): Promise<Record<string, string>> => {
	const statsKey = `${JS_STATS_KEY}:${new Date().toISOString().split('T')[0]}`
	return redisClient.hGetAll(statsKey)
}

// ── Utility: Get recent filter decisions ──────────────────────────────────────
// Returns last N decisions for post-session review.
export const getRecentDecisions = async (n = 20): Promise<object[]> => {
	const raw = await redisClient.lRange(JS_LOG_KEY, 0, n - 1)
	return raw.map((r) => {
		try {
			return JSON.parse(r)
		} catch {
			return { raw: r }
		}
	})
}
