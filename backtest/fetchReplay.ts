// ============================================================
// backtest/fetchReplay.ts — one-off liquid-universe fetch for the Oct 15–22 replay
//
// Owner-approved plan (2026-10-21, widened to Oct 22 on 2026-10-21 evening):
//   - Universe: every NSE stock whose 30-session average traded value (close × volume
//     from daily candles) as of 2026-10-14 exceeds ₹15 cr. Most liquid first.
//   - Sessions 2026-10-15, 16, 19, 21, 22 (20th: holiday), 1-minute candles, plus ONE
//     Nifty 1-minute request covering Oct 15–22.
//   - Fetch rules (preflight below): only after 15:45 IST; only with the owner's explicit
//     OK for THAT evening (--owner-ok <today>); refuse if today's ledger shows any breach,
//     an exhausted day or an active cooldown; at most 1,000 requests per evening (and
//     never past the ledger's 'backtest' allocation); stop on the first quota stop.
//   - Resumable: a symbol whose cache file already holds every replay session is skipped,
//     so an interrupted evening continues where it stopped.
//   - Daily candles share the screener's cache (CandleStore at <data>/candles/D), so this
//     doubles as the screener's first fill and nothing is fetched twice.
//
// Pure functions + an injected runner, so every rule is tested without a network.
// ============================================================

import type { LedgerState, QuotaGate } from '../src/fyers/quota.js'
import { QuotaStopError } from '../src/fyers/quota.js'
import { getISTDateString, getISTMinutes } from '../src/utils/marketHours.js'

export const REPLAY_SESSIONS = ['2026-10-15', '2026-10-16', '2026-10-19', '2026-10-21', '2026-10-22'] as const
export const REPLAY_FROM = REPLAY_SESSIONS[0]
export const REPLAY_TO = REPLAY_SESSIONS[REPLAY_SESSIONS.length - 1]!
export const LIQUID_AS_OF = '2026-10-14'
export const LIQUID_LOOKBACK_SESSIONS = 30
export const LIQUID_MIN_TURNOVER_CR = 15
export const EVENING_REQUEST_CAP = 1000
export const EARLIEST_FETCH_IST_MIN = 15 * 60 + 45
export const NIFTY_SYMBOL = 'NSE:NIFTY50-INDEX'

const IST_MS = 330 * 60_000
const CRORE = 1e7
export const istDayOf = (t: number): string => new Date(t + IST_MS).toISOString().slice(0, 10)

export interface Bar {
	t: number
	o: number
	h: number
	l: number
	c: number
	v: number
}

// ── Preflight: every rule that must hold before the first live call ─────────

export interface PreflightInput {
	nowMs: number
	/** Today's ledger state (RedisLedger on EC2). */
	ledger: LedgerState
	/** The `backtest` allocation from config/fyers_quota.json. */
	backtestAllocation: number
	/** The day the owner OK'd, passed as --owner-ok YYYY-MM-DD; must equal today (IST). */
	ownerOkDay: string | null
	eveningCap?: number
}

export interface PreflightResult {
	ok: boolean
	refusals: string[]
	/** Requests this run may make (0 when refused). */
	budget: number
	today: string
}

export const preflight = (i: PreflightInput): PreflightResult => {
	const today = getISTDateString(i.nowMs)
	const refusals: string[] = []
	if (i.ownerOkDay !== today)
		refusals.push(`no owner OK for ${today} (got --owner-ok ${i.ownerOkDay ?? 'none'}); each evening needs its own explicit OK`)
	if (getISTMinutes(i.nowMs) < EARLIEST_FETCH_IST_MIN) refusals.push('before 15:45 IST: fetches run only after the close')
	if (i.ledger.breaches > 0) refusals.push(`today's ledger shows ${i.ledger.breaches} breach(es): no Fyers calls on a day with any breach`)
	if (i.ledger.exhausted) refusals.push("today's ledger is marked exhausted (Fyers daily limit)")
	if (i.ledger.cooldownUntil > i.nowMs) refusals.push(`a throttle cooldown is active until ${new Date(i.ledger.cooldownUntil).toISOString()}`)
	const left = Math.max(0, i.backtestAllocation - (i.ledger.used.backtest ?? 0))
	if (left === 0) refusals.push(`the 'backtest' allocation (${i.backtestAllocation}) is used up for ${today}`)
	const ok = refusals.length === 0
	return { ok, refusals, budget: ok ? Math.min(i.eveningCap ?? EVENING_REQUEST_CAP, left) : 0, today }
}

// ── The liquid universe (as of Oct 14, from daily candles only) ─────────────

export interface LiquidRow {
	symbol: string
	avgTurnoverCr: number
	sessions: number
}

export interface LiquidList {
	asOf: string
	minTurnoverCr: number
	lookback: number
	liquid: LiquidRow[]
	/** Fewer than `lookback` sessions on or before asOf: not ranked (listed, never silently dropped). */
	insufficientHistory: string[]
}

/**
 * Average traded value (close × volume) over the last `lookback` sessions on or before
 * `asOf`. Uses only bars dated ≤ asOf, so the ranking has no look-ahead into the replay week.
 * (The quote pre-filter that chooses which daily histories to fetch does: see the report.)
 */
export const buildLiquidList = (
	barsBySymbol: Map<string, Bar[]>,
	asOf = LIQUID_AS_OF,
	minTurnoverCr = LIQUID_MIN_TURNOVER_CR,
	lookback = LIQUID_LOOKBACK_SESSIONS,
): LiquidList => {
	const liquid: LiquidRow[] = []
	const insufficientHistory: string[] = []
	for (const [symbol, bars] of barsBySymbol) {
		const upTo = bars.filter((b) => istDayOf(b.t) <= asOf).sort((a, b) => a.t - b.t)
		const window = upTo.slice(-lookback)
		if (window.length < lookback) {
			insufficientHistory.push(symbol)
			continue
		}
		const avgTurnoverCr = window.reduce((s, b) => s + b.c * b.v, 0) / window.length / CRORE
		if (avgTurnoverCr > minTurnoverCr) liquid.push({ symbol, avgTurnoverCr: Number(avgTurnoverCr.toFixed(2)), sessions: window.length })
	}
	liquid.sort((a, b) => b.avgTurnoverCr - a.avgTurnoverCr || a.symbol.localeCompare(b.symbol))
	insufficientHistory.sort()
	return { asOf, minTurnoverCr, lookback, liquid, insufficientHistory }
}

// ── The runner: ordered, capped, resumable, stops on the first quota stop ──

export interface FetchTask {
	symbol: string
	/** Requests this symbol needs (1 for the 1-minute window; daily cold start may need 2). */
	requests: number
}

/** Runs one Fyers request through the quota gate (pacing, ledger, stops). */
export type Gated = <T>(fn: () => Promise<T>) => Promise<T>

export interface RunDeps {
	gate: QuotaGate
	/**
	 * The symbol's Fyers request(s), each through `gated` — exactly `task.requests` of them
	 * (1 for the 1-minute window; 1–2 for a daily fill). Returns the bars it got.
	 */
	fetchOne: (symbol: string, gated: Gated) => Promise<Bar[]>
	/** Already complete on disk? (resume) */
	isComplete: (symbol: string) => boolean
	/** Persist bars as they land, so a stop never loses fetched data. */
	save: (symbol: string, bars: Bar[]) => void
	log?: Pick<Console, 'log' | 'warn' | 'error'>
}

export interface RunReport {
	requested: number
	fetched: string[]
	noData: string[]
	failed: Record<string, string>
	skippedComplete: number
	/** Not attempted this evening (budget reached or stopped); a rerun resumes from the first of these. */
	remaining: string[]
	stoppedBy: string | null
}

export const runFetch = async (tasks: FetchTask[], budget: number, deps: RunDeps): Promise<RunReport> => {
	const log = deps.log ?? console
	const r: RunReport = { requested: 0, fetched: [], noData: [], failed: {}, skippedComplete: 0, remaining: [], stoppedBy: null }
	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i]!
		if (deps.isComplete(task.symbol)) {
			r.skippedComplete++
			continue
		}
		if (r.stoppedBy || r.requested + task.requests > budget) {
			if (!r.stoppedBy) r.stoppedBy = `evening budget of ${budget} requests reached`
			r.remaining.push(...tasks.slice(i).map((t) => t.symbol).filter((s) => !deps.isComplete(s)))
			break
		}
		try {
			// The budget check above used the task's declared count; a fetchOne that tries
			// more requests than it declared is stopped here, so the cap can't be overrun.
			let made = 0
			const gated: Gated = (fn) => {
				if (made >= task.requests) return Promise.reject(new Error(`${task.symbol}: more than the ${task.requests} declared request(s)`))
				made++
				r.requested++
				return deps.gate.call(fn)
			}
			const bars = await deps.fetchOne(task.symbol, gated)
			if (bars.length === 0) r.noData.push(task.symbol)
			else {
				deps.save(task.symbol, bars)
				r.fetched.push(task.symbol)
			}
		} catch (err) {
			if (err instanceof QuotaStopError) {
				r.stoppedBy = `quota stop: ${err.message}`
				r.remaining.push(...tasks.slice(i).map((t) => t.symbol))
				break
			}
			r.failed[task.symbol] = (err as Error)?.message ?? String(err)
		}
		const done = r.fetched.length + r.noData.length
		if (done > 0 && done % 100 === 0) log.log(`[fetch-replay] … ${r.requested}/${budget} requests, ${r.fetched.length} fetched`)
	}
	if (r.stoppedBy) log.warn(`[fetch-replay] ⛔ stopped: ${r.stoppedBy}; ${r.remaining.length} symbols left for the next evening`)
	return r
}

/** A 1-minute cache is complete when it holds bars on every replay session. */
export const coversReplaySessions = (bars: Bar[], sessions: readonly string[] = REPLAY_SESSIONS): boolean => {
	const days = new Set(bars.map((b) => istDayOf(b.t)))
	return sessions.every((d) => days.has(d))
}

// ── Sandbox guard for the replay (no network, no credentials, BACKTEST_MODE) ──

/** Env names whose presence means the replay could reach production. */
export const FORBIDDEN_ENV = /^(DATABASE_URL|POSTGRES_|PG(HOST|USER|PASSWORD|DATABASE)$|REDIS_(URL|HOST|PASSWORD)|TELEGRAM_|FYERS_(SECRET|ACCESS|TOKEN|PIN|TOTP)|AWS_)/

export const sandboxViolations = (env: Record<string, string | undefined>, tokenFileExists: boolean): string[] => {
	const v: string[] = []
	if (env.BACKTEST_MODE !== 'true') v.push('BACKTEST_MODE is not "true"')
	for (const k of Object.keys(env)) if (env[k] && FORBIDDEN_ENV.test(k)) v.push(`credential-like env var present: ${k}`)
	if (tokenFileExists) v.push('a Fyers access token file is reachable')
	return v
}

// ── Daily-candle candidates from the quote pre-filter (LOOK-AHEAD: fetch-day quotes) ──

export interface QuoteLike {
	lp: number
	volume: number
}

/**
 * Which symbols get a daily history, most liquid first. Uses the screener's own lenient
 * pre-filter thresholds (config/screener.json `prefilter`: price ≥ ₹20, traded value ≥ ₹2 cr)
 * on the FETCH DAY's quotes. That is look-ahead relative to the Oct 14 ranking (a name
 * liquid on Oct 14 but quiet on the fetch day is skipped); the replay report must state it.
 * Symbols without a quote are kept (lenient), after all quoted ones.
 */
export const dailyCandidates = (
	universe: string[],
	quotes: Map<string, QuoteLike>,
	pf: { minPrice: number; minTradedValueRupees: number },
): { candidates: string[]; skipped: number; noQuote: number } => {
	const quoted: { s: string; tv: number }[] = []
	const noQuote: string[] = []
	let skipped = 0
	for (const s of universe) {
		const q = quotes.get(s)
		if (!q) noQuote.push(s)
		else if (q.lp >= pf.minPrice && q.lp * q.volume >= pf.minTradedValueRupees) quoted.push({ s, tv: q.lp * q.volume })
		else skipped++
	}
	quoted.sort((a, b) => b.tv - a.tv || a.s.localeCompare(b.s))
	return { candidates: [...quoted.map((x) => x.s), ...noQuote], skipped, noQuote: noQuote.length }
}
