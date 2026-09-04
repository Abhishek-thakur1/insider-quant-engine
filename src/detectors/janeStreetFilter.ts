// ============================================================
// janeStreetFilter.ts — Unified Confirmation Engine (v3)
//
// WHAT CHANGED FROM v2 (the version currently live in your repo):
//
//   1. BUG FIX: v2 read `payload.sl` / `payload.t1` directly, but
//      the ACTIVE AlertPayload interface in telegramWorker.ts never
//      had those fields — every detector embeds SL/T1 as text inside
//      the `trigger` string instead (e.g. "SL ₹22450 | T1 ₹22600").
//      So `risk`/`reward` were computing off `undefined`, silently
//      producing NaN, and the EV gate was almost certainly rejecting
//      (or erroring past) every single signal. This is very likely
//      the actual reason the filter got disconnected — not a
//      deliberate architecture choice. Restored the trigger-text
//      parser (it already existed here, commented out) as the
//      primary path. No detector files need to change.
//
//   2. NEW: three additional evidence sources folded in —
//      market structure (BOS/CHOCH), liquidity/stop-hunt mapping,
//      and an order-flow (absorption/aggression) proxy. These read
//      from the shared candleAggregator buffer.
//
//   3. REDESIGNED SCORING: instead of 4 sequential hard pass/fail
//      gates, only two things are hard rejects now — REGIME
//      mismatch and NEGATIVE EV. Everything else (structure,
//      liquidity, order flow, Bayesian posterior, Kelly size)
//      contributes points to one 0-100 confidence score, fired
//      only above a configurable threshold. This avoids the
//      "any one weak gate kills an otherwise strong setup"
//      brittleness of the old all-or-nothing design — which is
//      also visible in your own history (the 0.62→0.55 posterior
//      fix, the VSR index-bypass fix — those were all patches for
//      exactly this brittleness).
//
//   4. SHADOW MODE: set SHADOW_MODE=true in .env to log every
//      decision (score, gates, reasons) without blocking Telegram.
//      Run in shadow mode for 1-2 weeks before flipping to blocking
//      mode — you have no outcome data yet for the 3 new modules
//      and the rescored Bayesian/Kelly weights.
// ============================================================

import { redisClient } from '../config/redis.js'
import { computeBayesianPosterior } from '../utils/bayesianEngine.js'
import { getMarketRegime, checkRegimeCompatibility } from '../utils/regimeDetector.js'
import { getStructureScore } from '../utils/marketStructure.js'
import { getLiquidityScore } from '../utils/liquidityMap.js'
import { getOrderFlowScore } from '../utils/orderFlowProxy.js'
import type { AlertPayload } from '../workers/telegramWorker.js'
import type { TradeSide } from '../core/types.js'

// ─── TUNABLE CONSTANTS ────────────────────────────────────────────────────────
const MIN_EV_PTS = 0 // Hard gate — never fire on negative expectancy
const DEFAULT_RR = 1.5 // Fallback R:R if trigger text is unparseable
const DEFAULT_RISK_PCT = 0.003 // Fallback risk = 0.3% of price if no SL in trigger
const SLIPPAGE_PTS = 2.0
const CONFIRMATION_THRESHOLD = Number(process.env.CONFIRMATION_THRESHOLD) || 78 // fire above this /100
const SHADOW_MODE = process.env.SHADOW_MODE === 'true'
const JS_LOG_KEY = 'jsfilter:decisions'
const JS_STATS_KEY = 'jsfilter:stats'

// Point budget — sums to 100
const WEIGHT_STRUCTURE = 20
const WEIGHT_LIQUIDITY = 18
const WEIGHT_ORDERFLOW = 15
const WEIGHT_BAYESIAN = 25
const WEIGHT_REGIME = 12
const WEIGHT_EV_KELLY = 10
// ─────────────────────────────────────────────────────────────────────────────

export interface FilterDecision {
	passed: boolean
	score: number // 0-100 unified confidence score
	posterior: number
	ev: number
	kellyHalf: number
	regime: string
	entropy: number
	sizeMult: number
	breakdown: ScoreComponent[]
	rejectedAt?: 'REGIME' | 'EV'
	positionNote: string
	shadowMode: boolean
}

interface ScoreComponent {
	component: string
	points: number
	maxPoints: number
	reason: string
}

const NIFTY_SPOT_SYMBOL = 'NSE:NIFTY50-INDEX'

// Option premiums don't have clean swing structure — they're derivative and
// theta/gamma-noisy intraday. Structure/liquidity/order-flow should always
// read the underlying index candles for options alerts, not the option
// contract's own (mostly meaningless) price series.
const resolveStructureSymbol = (payload: AlertPayload): string => {
	const isOption =
		payload.symbol.includes('CE') ||
		payload.symbol.includes('PE') ||
		payload.symbol.includes('NIFTY')
	return isOption ? NIFTY_SPOT_SYMBOL : payload.symbol
}

// ── Parse Stop Loss / Target 1 from the trigger string ───────────────────────
// Every current detector already embeds "SL ₹X ... T1 ₹Y" in the trigger text.
// This is the ONLY reliable source right now — payload.sl/t1 don't exist on
// the live AlertPayload type, so we never depend on them being present.
const parseRiskRewardFromTrigger = (
	trigger: string,
	price: number,
): { risk: number; reward: number; rr: number; parsed: boolean } => {
	const slMatch = trigger.match(/SL[:\s]*₹?([\d,]+(?:\.\d+)?)/i)
	const t1Match = trigger.match(/T1[:\s]*₹?([\d,]+(?:\.\d+)?)/i)

	if (slMatch && t1Match) {
		const sl = parseFloat(slMatch[1]!.replace(/,/g, ''))
		const t1 = parseFloat(t1Match[1]!.replace(/,/g, ''))

		if (sl > 0 && t1 > 0 && price > 0) {
			const risk = Math.abs(price - sl)
			const reward = Math.abs(price - t1)

			if (risk > 0 && reward > 0 && risk < price * 0.1 && reward < price * 0.2) {
				return { risk, reward, rr: reward / risk, parsed: true }
			}
		}
	}

	const defaultRisk = price * DEFAULT_RISK_PCT
	const defaultReward = defaultRisk * DEFAULT_RR
	return { risk: defaultRisk, reward: defaultReward, rr: DEFAULT_RR, parsed: false }
}

const computeEV = (pWin: number, reward: number, risk: number): number => {
	return pWin * reward - (1 - pWin) * risk - SLIPPAGE_PTS
}

const computeKelly = (pWin: number, rr: number): number => {
	const fullKelly = pWin - (1 - pWin) / Math.max(rr, 0.1)
	const halfKelly = Math.max(0, fullKelly) / 2
	return Math.min(halfKelly, 0.05) // hard cap at 5%
}

const kellyPoints = (effectiveKelly: number): number => {
	if (effectiveKelly >= 0.03) return WEIGHT_EV_KELLY // high edge
	if (effectiveKelly >= 0.015) return WEIGHT_EV_KELLY * 0.6 // moderate
	if (effectiveKelly >= 0.005) return WEIGHT_EV_KELLY * 0.3 // thin but real
	return 0
}

const buildPositionNote = (
	score: number,
	kelly: number,
	sizeMult: number,
	regime: string,
): string => {
	const effectiveKelly = kelly * sizeMult
	const kellyPct = (effectiveKelly * 100).toFixed(1)
	if (score >= 90)
		return `🏦 [${regime.toUpperCase()}] Score ${score}/100 — HIGH conviction, Half-Kelly ${kellyPct}%`
	if (score >= CONFIRMATION_THRESHOLD)
		return `📊 [${regime.toUpperCase()}] Score ${score}/100 — CONFIRMED, Half-Kelly ${kellyPct}%`
	return `⚡ [${regime.toUpperCase()}] Score ${score}/100 — below threshold, Half-Kelly ${kellyPct}%`
}

// ── The Unified Confirmation Engine ───────────────────────────────────────────
export const runJaneStreetFilter = async (
	payload: AlertPayload,
	detectorName?: string,
): Promise<FilterDecision> => {
	const side = payload.side as TradeSide
	const breakdown: ScoreComponent[] = []

	// ── HARD GATE: Regime Compatibility ──────────────────────────────────────
	const regimeState = await getMarketRegime()
	const regimeCheck = checkRegimeCompatibility(
		regimeState.regime,
		regimeState.entropy,
		detectorName ?? payload.detectorName,
		payload.trigger,
		payload.regimeClass,
	)

	if (!regimeCheck.allowed) {
		const decision: FilterDecision = {
			passed: false,
			score: 0,
			posterior: 0,
			ev: 0,
			kellyHalf: 0,
			regime: regimeState.regime,
			entropy: regimeState.entropy,
			sizeMult: 0,
			breakdown: [
				{ component: 'REGIME', points: 0, maxPoints: WEIGHT_REGIME, reason: regimeCheck.reason },
			],
			rejectedAt: 'REGIME',
			positionNote: `🚫 REGIME GATE: ${regimeCheck.reason}`,
			shadowMode: SHADOW_MODE,
		}
		await persistDecision(payload, decision, detectorName)
		return decision
	}

	breakdown.push({
		component: 'REGIME',
		points: WEIGHT_REGIME * regimeCheck.sizeMult,
		maxPoints: WEIGHT_REGIME,
		// classificationSource makes silent misclassification visible in the
		// jsfilter:decisions log — anything but 'explicit' means the detector
		// did not tag itself and we guessed from its name or trigger text.
		reason: `${regimeCheck.reason} [${regimeCheck.detectorType}/${regimeCheck.classificationSource}]`,
	})

	// ── NEW: Market Structure ────────────────────────────────────────────────
	const structureSymbol = resolveStructureSymbol(payload)
	const structure = getStructureScore(structureSymbol, side)
	breakdown.push({
		component: 'STRUCTURE',
		points: structure.score,
		maxPoints: WEIGHT_STRUCTURE,
		reason: structure.reason,
	})

	// ── NEW: Liquidity / Stop-Hunt Mapping ───────────────────────────────────
	const liquidity = getLiquidityScore(structureSymbol, side, payload.price)
	breakdown.push({
		component: 'LIQUIDITY',
		points: liquidity.score,
		maxPoints: WEIGHT_LIQUIDITY,
		reason: liquidity.reason,
	})

	// ── NEW: Order Flow Proxy ────────────────────────────────────────────────
	const orderFlow = getOrderFlowScore(structureSymbol, side)
	breakdown.push({
		component: 'ORDER_FLOW',
		points: orderFlow.score,
		maxPoints: WEIGHT_ORDERFLOW,
		reason: orderFlow.reason,
	})

	// ── Bayesian Posterior (existing engine, rescaled to points) ────────────
	const bayesian = await computeBayesianPosterior(payload, side)
	const bayesPoints = bayesian.posterior * WEIGHT_BAYESIAN
	breakdown.push({
		component: 'BAYESIAN',
		points: bayesPoints,
		maxPoints: WEIGHT_BAYESIAN,
		reason: `P=${(bayesian.posterior * 100).toFixed(0)}% | ${bayesian.reasons.join(' | ')}`,
	})

	const pWin = bayesian.posterior

	// ── HARD GATE: Expected Value ────────────────────────────────────────────
	const { risk, reward, rr, parsed } = parseRiskRewardFromTrigger(payload.trigger, payload.price)
	const ev = computeEV(pWin, reward, risk)

	if (ev < MIN_EV_PTS) {
		const decision: FilterDecision = {
			passed: false,
			score: Math.round(breakdown.reduce((s, b) => s + b.points, 0)),
			posterior: pWin,
			ev,
			kellyHalf: 0,
			regime: regimeState.regime,
			entropy: regimeState.entropy,
			sizeMult: regimeCheck.sizeMult,
			breakdown: [
				...breakdown,
				{
					component: 'EV',
					points: 0,
					maxPoints: WEIGHT_EV_KELLY,
					reason: `R:R=${rr.toFixed(2)} (${parsed ? 'parsed' : 'default'}) | Risk=${risk.toFixed(1)} | Reward=${reward.toFixed(1)} → NEGATIVE EV ₹${ev.toFixed(1)} incl. slippage`,
				},
			],
			rejectedAt: 'EV',
			positionNote: `🚫 EV GATE: ₹${ev.toFixed(1)} < 0 — never fire on negative expectancy`,
			shadowMode: SHADOW_MODE,
		}
		await persistDecision(payload, decision, detectorName)
		return decision
	}

	// ── Kelly Sizing (points, not a hard gate anymore) ──────────────────────
	const kellyHalf = computeKelly(pWin, rr)
	const effectiveKelly = kellyHalf * regimeCheck.sizeMult
	const evKellyPts = kellyPoints(effectiveKelly)
	breakdown.push({
		component: 'EV_KELLY',
		points: evKellyPts,
		maxPoints: WEIGHT_EV_KELLY,
		reason: `EV=₹${ev.toFixed(1)} | Half-Kelly=${(effectiveKelly * 100).toFixed(1)}% (${parsed ? 'SL/T1 parsed from trigger' : 'default R:R assumed'})`,
	})

	const score = Math.round(
		Math.max(
			0,
			Math.min(
				100,
				breakdown.reduce((s, b) => s + b.points, 0),
			),
		),
	)
	const passed = score >= CONFIRMATION_THRESHOLD
	const positionNote = buildPositionNote(score, kellyHalf, regimeCheck.sizeMult, regimeState.regime)

	const decision: FilterDecision = {
		passed,
		score,
		posterior: pWin,
		ev,
		kellyHalf: effectiveKelly,
		regime: regimeState.regime,
		entropy: regimeState.entropy,
		sizeMult: regimeCheck.sizeMult,
		breakdown,
		positionNote,
		shadowMode: SHADOW_MODE,
	}

	await persistDecision(payload, decision, detectorName)
	return decision
}

// ── Persist every decision to Redis for post-session review ──────────────────
// redis-cli lrange jsfilter:decisions 0 49
const persistDecision = async (
	payload: AlertPayload,
	decision: FilterDecision,
	detectorName?: string,
): Promise<void> => {
	try {
		const record = {
			ts: new Date().toISOString(),
			symbol: payload.symbol,
			side: payload.side,
			detector: detectorName ?? 'unknown',
			score: decision.score,
			passed: decision.passed,
			shadowMode: decision.shadowMode,
			rejectedAt: decision.rejectedAt ?? null,
			breakdown: decision.breakdown
				.map((b) => `${b.component}=${b.points.toFixed(1)}/${b.maxPoints}`)
				.join(' '),
		}

		await redisClient
			.multi()
			.lPush(JS_LOG_KEY, JSON.stringify(record))
			.lTrim(JS_LOG_KEY, 0, 999)
			.hIncrBy(JS_STATS_KEY, decision.passed ? 'fired' : 'blocked', 1)
			.exec()
	} catch (err) {
		console.error('[Confirmation Engine] Failed to persist decision:', err)
	}
}

export const getFilterStats = async (): Promise<Record<string, string>> => {
	return redisClient.hGetAll(JS_STATS_KEY)
}

export const getRecentDecisions = async (n = 20): Promise<object[]> => {
	const raw = await redisClient.lRange(JS_LOG_KEY, 0, n - 1)
	return raw.map((r: string) => JSON.parse(r))
}
