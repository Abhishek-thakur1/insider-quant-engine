// ============================================================
// tests/helpers/workerScenarios.ts — shared alert-worker scenarios and fakes
//
// Used by tests/alertPipeline.test.ts (hook is observational) and
// tests/legacyWorkerParity.test.ts (new pipeline vs the pre-hook worker).
// Every side effect is recorded as an Effect so runs can be compared exactly.
// ============================================================

import { runAlertPipeline, type PipelineDeps } from '../../src/workers/alertPipeline.js'
import { alertKeys, type AlertStore } from '../../src/workers/alertPolicy.js'
import { getISTDateString } from '../../src/utils/marketHours.js'
import type { SignalDraft } from '../../src/db/signalRecord.js'
import type { FilterDecision } from '../../src/detectors/janeStreetFilter.js'
import type { AlertPayload } from '../../src/workers/telegramWorker.js'

export const NOW = Date.parse('2026-10-19T05:00:00Z') // Mon 10:30 IST
export const DAY = getISTDateString(NOW)
export const MAX = 20

export type Effect = [string, ...unknown[]]

export const decision = (o: Partial<FilterDecision> = {}): FilterDecision => ({
	passed: true,
	score: 85,
	posterior: 0.62,
	ev: 4.2,
	kellyHalf: 0.021,
	regime: 'TRENDING',
	entropy: 0.41,
	sizeMult: 1,
	breakdown: [
		{ component: 'REGIME', points: 12, maxPoints: 12, reason: 'ok [MOMENTUM/explicit]' },
		{ component: 'BAYESIAN', points: 15.5, maxPoints: 25, reason: 'P=62%' },
		{ component: 'EV_KELLY', points: 6, maxPoints: 10, reason: 'EV=₹4.2 | Half-Kelly=2.1%' },
	],
	positionNote: '',
	shadowMode: false,
	...o,
})

export const equity: AlertPayload = {
	symbol: 'NSE:TEST-EQ',
	price: 500,
	side: 'LONG',
	percentageChange: 1.2,
	volumeSpikeRatio: 2.4,
	trigger: 'Breakout | SL ₹496 | T1 ₹506',
	vwap: 499, // → SL 498.00, risk 2, qty 20 (₹10k single-name cap)
	avgPrice: 495,
	detectorName: 'Stock Momentum Breakout',
	regimeClass: 'MOMENTUM',
	durationClass: 'INTRADAY',
}

export const option: AlertPayload = {
	...equity,
	symbol: 'NIFTY 25000 CE',
	price: 25000,
	trigger: 'OI sweep | SL ₹24950 | T1 ₹25100',
	vwap: 24990,
	detectorName: 'OI Liquidity Sweep',
}

export interface Scenario {
	name: string
	payload?: AlertPayload
	decision?: FilterDecision
	filterThrows?: boolean
	registerThrows?: boolean
	shadowMode?: boolean
	behavior?: 'REDUCE' | 'SKIP'
	notional?: number
	preClaimed?: boolean // already alerted today for this detector+symbol
	preCount?: number // alerts already sent today
	sendFail?: 'markdown' | 'both'
	golden: { registered: boolean; sends: number; delivered: boolean; admin: boolean }
	row: Record<string, unknown>
}

export const scenarios: Scenario[] = [
	{
		name: 'passed equity → recorded and alerted',
		decision: decision(),
		golden: { registered: true, sends: 1, delivered: true, admin: false },
		row: {
			alert_sent: true,
			alert_suppressed_reason: null,
			capital_outcome: 'TRADED',
			trade_id: 42,
			filter_result: 'PASSED',
			rejected_at: null,
		},
	},
	{
		name: 'REGIME reject → not recorded, not alerted',
		decision: decision({
			passed: false,
			score: 0,
			rejectedAt: 'REGIME',
			breakdown: [
				{ component: 'REGIME', points: 0, maxPoints: 12, reason: 'MOMENTUM blocked in CHOPPY' },
			],
		}),
		golden: { registered: false, sends: 0, delivered: false, admin: false },
		row: {
			alert_sent: false,
			alert_suppressed_reason: 'FILTER_REJECTED',
			capital_outcome: null,
			trade_id: null,
			filter_result: 'REJECTED',
			rejected_at: 'REGIME',
			bayesian_posterior: null,
			ev_result: null,
		},
	},
	{
		name: 'EV reject → not recorded, not alerted',
		decision: decision({ passed: false, score: 40, rejectedAt: 'EV', ev: -3 }),
		golden: { registered: false, sends: 0, delivered: false, admin: false },
		row: {
			alert_suppressed_reason: 'FILTER_REJECTED',
			filter_result: 'REJECTED',
			rejected_at: 'EV',
			ev_result: 'REJECT',
			kelly_half: null,
		},
	},
	{
		name: 'below score threshold → not recorded, not alerted',
		decision: decision({ passed: false, score: 60 }),
		golden: { registered: false, sends: 0, delivered: false, admin: false },
		row: {
			alert_suppressed_reason: 'FILTER_REJECTED',
			filter_result: 'REJECTED',
			rejected_at: 'SCORE',
			score_result: 'BELOW_THRESHOLD',
			trade_id: null,
		},
	},
	{
		name: 'below threshold in SHADOW_MODE → recorded ungated, not alerted',
		decision: decision({ passed: false, score: 60, shadowMode: true }),
		shadowMode: true,
		golden: { registered: true, sends: 0, delivered: false, admin: false },
		row: {
			alert_suppressed_reason: 'NOT_GATED',
			filter_result: 'REJECTED',
			rejected_at: 'SCORE',
			trade_id: 42,
			shadow_mode: true,
		},
	},
	{
		name: 'hard gate in SHADOW_MODE → still blocked',
		decision: decision({ passed: false, score: 40, rejectedAt: 'EV', ev: -3, shadowMode: true }),
		shadowMode: true,
		golden: { registered: false, sends: 0, delivered: false, admin: false },
		row: { alert_suppressed_reason: 'FILTER_REJECTED', rejected_at: 'EV' },
	},
	{
		name: 'filter throws → recorded ungated, not alerted',
		filterThrows: true,
		golden: { registered: true, sends: 0, delivered: false, admin: false },
		row: {
			alert_suppressed_reason: 'FILTER_ERROR',
			filter_result: 'ERROR',
			trade_id: 42,
			regime_result: null,
		},
	},
	{
		name: 'capital REDUCE → recorded and alerted with reduced qty',
		decision: decision(),
		notional: 95000,
		golden: { registered: true, sends: 1, delivered: true, admin: false },
		row: { alert_sent: true, capital_outcome: 'REDUCED', qty: 20, actual_size: 10 },
	},
	{
		name: 'capital SKIP → recorded, not alerted',
		decision: decision(),
		notional: 95000,
		behavior: 'SKIP',
		golden: { registered: true, sends: 0, delivered: false, admin: false },
		row: {
			alert_suppressed_reason: 'CAPITAL_SKIP',
			capital_outcome: 'SKIPPED_CAPITAL',
			actual_size: 0,
			trade_id: 42,
		},
	},
	{
		name: 'gated Nifty option with 0 paper size → still alerted',
		payload: option,
		decision: decision(),
		golden: { registered: true, sends: 1, delivered: true, admin: false },
		row: { alert_sent: true, actual_size: 0, promotion_source: 'INDEX' },
	},
	{
		name: 'already alerted today → recorded, DUPLICATE',
		decision: decision(),
		preClaimed: true,
		golden: { registered: true, sends: 0, delivered: false, admin: false },
		row: { alert_suppressed_reason: 'DUPLICATE', trade_id: 42 },
	},
	{
		name: 'daily cap first overflow → recorded, one admin notice',
		decision: decision(),
		preCount: MAX,
		golden: { registered: true, sends: 0, delivered: false, admin: true },
		row: { alert_suppressed_reason: 'CAP_REACHED' },
	},
	{
		name: 'Markdown rejected → plain-text retry delivers',
		decision: decision(),
		sendFail: 'markdown',
		golden: { registered: true, sends: 2, delivered: true, admin: false },
		row: { alert_sent: true, alert_suppressed_reason: null },
	},
	{
		name: 'both sends fail → slot released, SEND_FAILED',
		decision: decision(),
		sendFail: 'both',
		golden: { registered: true, sends: 2, delivered: false, admin: false },
		row: { alert_sent: false, alert_suppressed_reason: 'SEND_FAILED' },
	},
	{
		name: 'registerTrade throws → caught, WORKER_ERROR',
		decision: decision(),
		registerThrows: true,
		golden: { registered: false, sends: 0, delivered: false, admin: false },
		row: { alert_suppressed_reason: 'WORKER_ERROR', trade_id: null, capital_outcome: 'TRADED' },
	},
]

export const makeStore = (effects: Effect[], sc: Scenario): AlertStore => {
	const data = new Map<string, string>()
	const payload = sc.payload ?? equity
	const keys = alertKeys(DAY, payload.detectorName!, payload.symbol)
	if (sc.preClaimed) data.set(keys.dedup, '1')
	if (sc.preCount !== undefined) data.set(keys.count, String(sc.preCount))
	return {
		async set(key, value, opts) {
			effects.push(['redis.set', key])
			if (opts.NX && data.has(key)) return null
			data.set(key, value)
			return 'OK'
		},
		async incr(key) {
			const n = Number(data.get(key) ?? 0) + 1
			data.set(key, String(n))
			effects.push(['redis.incr', key, n])
			return n
		},
		async decr(key) {
			const n = Number(data.get(key) ?? 0) - 1
			data.set(key, String(n))
			effects.push(['redis.decr', key, n])
			return n
		},
		async expire(key) {
			effects.push(['redis.expire', key])
			return 1
		},
		async del(key) {
			effects.push(['redis.del', key])
			return data.delete(key) ? 1 : 0
		},
	}
}

export const makeDeps = (sc: Scenario, effects: Effect[]): PipelineDeps => ({
	runFilter: async (d) => {
		effects.push(['filter', d.symbol])
		if (sc.filterThrows) throw new Error('filter bug')
		return sc.decision!
	},
	getTracker: async () => ({
		getCurrentNotional: () => sc.notional ?? 0,
		registerTrade: async (pos) => {
			effects.push(['registerTrade', pos])
			if (sc.registerThrows) throw new Error('tracker bug')
			return 42
		},
	}),
	getAlertStore: async () => makeStore(effects, sc),
	sendChannel: async (text, markdown) => {
		effects.push(['send', markdown, text])
		if (sc.sendFail === 'both' || (sc.sendFail === 'markdown' && markdown))
			throw new Error('telegram 400')
		effects.push(['delivered'])
	},
	sendAdmin: async (text) => {
		effects.push(['admin', text])
	},
	now: () => NOW,
	config: {
		shadowMode: !!sc.shadowMode,
		maxAlertsPerDay: MAX,
		capitalBase: 100000,
		capitalBehavior: sc.behavior ?? 'REDUCE',
		hasAdmin: true,
	},
})

// Console output is behaviour too: capture it per run. Date.now is pinned to NOW
// so code that reads the clock directly (the pre-hook worker) is deterministic.
export const captureRun = async (effects: Effect[], fn: () => Promise<void>): Promise<Effect[]> => {
	const orig = { log: console.log, warn: console.warn, error: console.error }
	const origNow = Date.now
	const capture =
		(kind: string) =>
		(...args: unknown[]) =>
			effects.push([
				`console.${kind}`,
				args.map((a) => (a instanceof Error ? `Error: ${a.message}` : a)),
			])
	console.log = capture('log')
	console.warn = capture('warn')
	console.error = capture('error')
	Date.now = () => NOW
	try {
		await fn()
		await new Promise((r) => setImmediate(r)) // let the fire-and-forget admin notice land
	} finally {
		Object.assign(console, orig)
		Date.now = origNow
	}
	return effects
}

/** Run the current pipeline (src/workers/alertPipeline.ts) for a scenario. */
export const runPipeline = async (sc: Scenario, obs: SignalDraft | null): Promise<Effect[]> => {
	const effects: Effect[] = []
	return captureRun(effects, () =>
		runAlertPipeline(sc.payload ?? equity, makeDeps(sc, effects), obs),
	)
}
