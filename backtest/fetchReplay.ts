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

import fs from 'node:fs'
import path from 'node:path'
import type { LedgerState, QuotaConfig, QuotaGate } from '../src/fyers/quota.js'
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
/** No run starts after 16:15 IST (the EOD screener starts 16:30 with its own pacer; token purged 17:15). */
export const LATEST_START_IST_MIN = 16 * 60 + 15
/** Hard stop: no request at or after 16:25 IST, so the run never overlaps the 16:30 screener. */
export const FETCH_WINDOW_END_IST_MIN = 16 * 60 + 25
/** Consecutive non-quota failures that end a run (an expired token must not burn the budget). */
export const MAX_CONSECUTIVE_FAILURES = 3
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
	/**
	 * Requests this run may make (0 when refused): min(1,000 − backtest requests already in
	 * today's ledger, allocation left). The cap is per EVENING across runs, since the
	 * 'backtest' job on EC2 has no other user; retries are in the ledger, so they count.
	 */
	budget: number
	today: string
}

export const preflight = (i: PreflightInput): PreflightResult => {
	const today = getISTDateString(i.nowMs)
	const refusals: string[] = []
	if (i.ownerOkDay !== today)
		refusals.push(`no owner OK for ${today} (got --owner-ok ${i.ownerOkDay ?? 'none'}); each evening needs its own explicit OK`)
	const m = getISTMinutes(i.nowMs)
	if (m < EARLIEST_FETCH_IST_MIN) refusals.push('before 15:45 IST: fetches run only after the close')
	if (m >= LATEST_START_IST_MIN) refusals.push('after 16:15 IST: a run would overlap the 16:30 screener (or the 17:15 token purge)')
	if (i.ledger.breaches > 0) refusals.push(`today's ledger shows ${i.ledger.breaches} breach(es): no Fyers calls on a day with any breach`)
	if (i.ledger.exhausted) refusals.push("today's ledger is marked exhausted (Fyers daily limit)")
	if (i.ledger.cooldownUntil > i.nowMs) refusals.push(`a throttle cooldown is active until ${new Date(i.ledger.cooldownUntil).toISOString()}`)
	const used = i.ledger.used.backtest ?? 0
	const left = Math.max(0, Math.min((i.eveningCap ?? EVENING_REQUEST_CAP) - used, i.backtestAllocation - used))
	if (left === 0) refusals.push(`no requests left for ${today}: ${used} 'backtest' requests already in the ledger (evening cap ${i.eveningCap ?? EVENING_REQUEST_CAP}, allocation ${i.backtestAllocation})`)
	const ok = refusals.length === 0
	return { ok, refusals, budget: ok ? left : 0, today }
}

/**
 * The gate config for this job: the shared pacing and allocation, but the FIRST throttle
 * stops the run (owner's rule) — maxBreachesPerDay 1 makes the gate throw BreachLimitError
 * on breach 1, and maxRetries 0 means nothing is retried.
 */
export const replayGateConfig = (shared: QuotaConfig): QuotaConfig => ({ ...shared, maxBreachesPerDay: 1, maxRetries: 0 })

/**
 * Checked against the LIVE ledger before every request, so the run stops on anything that
 * happens mid-run: a breach by any job, an exhausted day, the IST day changing, the evening
 * cap reached by ledger count (retries included), or the 16:25 window end.
 */
export const midRunStop = (st: LedgerState, o: { nowMs: number; startDay: string; eveningCap?: number }): string | null => {
	const day = getISTDateString(o.nowMs)
	if (day !== o.startDay) return `the IST day changed (${o.startDay} → ${day}); the owner's OK was for ${o.startDay}`
	if (st.breaches > 0) return `a throttle breach is in today's ledger (${st.breaches})`
	if (st.exhausted) return "today's ledger is marked exhausted"
	const used = st.used.backtest ?? 0
	if (used >= (o.eveningCap ?? EVENING_REQUEST_CAP)) return `the evening cap is reached by the ledger count (${used} backtest requests today)`
	if (getISTMinutes(o.nowMs) >= FETCH_WINDOW_END_IST_MIN) return 'it is 16:25 IST: stopping before the 16:30 screener'
	return null
}

/** Fyers auth / token errors: no point retrying the next symbol with the same token. */
export const isAuthShaped = (err: unknown): boolean => {
	const e = err as { code?: unknown; s?: unknown; message?: unknown } | null
	const code = Number(e?.code)
	if ([-8, -15, -16, -17, 401, 403].includes(code)) return true
	return /token|auth|unauthori[sz]ed|login/i.test(String(e?.message ?? ''))
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
	/** Before EVERY request: a reason to stop the run (production: midRunStop on the live ledger), or null. */
	checkBeforeCall?: () => Promise<string | null>
	log?: Pick<Console, 'log' | 'warn' | 'error'>
}

/** Thrown from `gated` when checkBeforeCall says stop; ends the run like a quota stop. */
export class RunStopError extends QuotaStopError {}

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
	let consecutiveFailures = 0
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
			const gated: Gated = async (fn) => {
				if (made >= task.requests) throw new Error(`${task.symbol}: more than the ${task.requests} declared request(s)`)
				const stop = deps.checkBeforeCall ? await deps.checkBeforeCall() : null
				if (stop) throw new RunStopError(stop)
				made++
				r.requested++
				return deps.gate.call(fn)
			}
			const bars = await deps.fetchOne(task.symbol, gated)
			consecutiveFailures = 0
			if (bars.length === 0) r.noData.push(task.symbol)
			else {
				deps.save(task.symbol, bars)
				r.fetched.push(task.symbol)
			}
		} catch (err) {
			if (err instanceof QuotaStopError) {
				r.stoppedBy = `${err instanceof RunStopError ? 'stop' : 'quota stop'}: ${err.message}`
				r.remaining.push(...tasks.slice(i).map((t) => t.symbol))
				break
			}
			r.failed[task.symbol] = (err as Error)?.message ?? JSON.stringify(err)
			consecutiveFailures++
			const why = isAuthShaped(err)
				? `auth/token error at ${task.symbol}`
				: consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
					? `${consecutiveFailures} consecutive failures (last: ${r.failed[task.symbol]})`
					: null
			if (why) {
				r.stoppedBy = why
				r.remaining.push(...tasks.slice(i + 1).map((t) => t.symbol))
				break
			}
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

// ── 1-minute cache (same file shape as the screener's CandleStore, labelled resolution '1') ──

/**
 * One JSON file per symbol under `dir`, `{ symbol, resolution: '1', bars, fetchedAt }`,
 * merged on timestamp and written atomically — the shape backtest/data/store.loadSeries reads.
 * Kept here (not a src/ change) so this PR touches nothing under src/.
 */
export class MinuteStore {
	constructor(readonly dir: string) {}
	private file(symbol: string) {
		return path.join(this.dir, `${symbol.replace(/[:\/]/g, '_')}.json`)
	}
	load(symbol: string): Bar[] {
		try {
			const j = JSON.parse(fs.readFileSync(this.file(symbol), 'utf8')) as { bars?: Bar[] }
			return Array.isArray(j.bars) ? j.bars : []
		} catch {
			return []
		}
	}
	merge(symbol: string, incoming: Bar[]): number {
		const byTs = new Map<number, Bar>()
		for (const b of this.load(symbol)) byTs.set(b.t, b)
		for (const b of incoming) byTs.set(b.t, b)
		const bars = [...byTs.values()].sort((a, b) => a.t - b.t)
		fs.mkdirSync(this.dir, { recursive: true })
		const tmp = `${this.file(symbol)}.${process.pid}.tmp`
		fs.writeFileSync(tmp, JSON.stringify({ symbol, resolution: '1', bars, fetchedAt: new Date().toISOString() }))
		fs.renameSync(tmp, this.file(symbol))
		return bars.length
	}
}
