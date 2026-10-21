// ============================================================
// fyers/quota.ts — one quota discipline for every Fyers Data-API caller
//
// Fyers Standard plan, Data APIs (history AND quotes, both on api-t1.fyers.in/data):
// 5/s, 50/min, 5,000/day; > 3 per-minute breaches in a day = blocked for the rest of
// the day. On 2026-10-20 the first screener run paced at 4/s (= 240/min), was
// throttled by Cloudflare (1015) and then hit the daily cap: 2,352/2,352 failed.
//
// Every call goes through a QuotaGate:
//   - pacing: <= perSecond AND <= perMinute starts in any rolling window (config)
//   - a daily LEDGER (Redis on EC2, a file on the owner's PC) with per-job
//     allocations: screener / seeder / anomaly / backtest. A job stops at its
//     allocation so the others keep theirs.
//   - HARD STOP on the daily-limit message: the day is marked exhausted in the
//     ledger and every job refuses further calls that day.
//   - COOLDOWN on throttling (Cloudflare 1015 / 429 / -429 / -360): every caller
//     sharing the ledger waits out max(retry_after, cooldownMs); each counts as a
//     breach, and at maxBreachesPerDay (2, below Fyers' 3) the job stops for the day.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { getISTDateString } from '../utils/marketHours.js'
import type { LimiterClock } from '../utils/rateLimit.js'

export type QuotaJob = 'screener' | 'seeder' | 'anomaly' | 'backtest'
export const QUOTA_JOBS: QuotaJob[] = ['screener', 'seeder', 'anomaly', 'backtest']

export interface QuotaConfig {
	dataApi: { perSecond: number; perMinute: number; perDay: number }
	allocations: Record<QuotaJob, number>
	maxBreachesPerDay: number
	cooldownMs: number
	maxRetries: number
}

export const validateQuotaConfig = (raw: unknown): QuotaConfig => {
	const c = raw as QuotaConfig
	const bad = (m: string): never => {
		throw new Error(`config/fyers_quota.json: ${m}`)
	}
	if (!c?.dataApi) bad('missing dataApi')
	const { perSecond, perMinute, perDay } = c.dataApi
	if (!(perSecond > 0 && perSecond <= 5)) bad('dataApi.perSecond must be 1–5 (Fyers Standard: 5/s)')
	if (!(perMinute > 0 && perMinute <= 50)) bad('dataApi.perMinute must be 1–50 (Fyers Standard: 50/min)')
	if (!(perDay > 0 && perDay <= 5000)) bad('dataApi.perDay must be 1–5000 (Fyers Standard: 5,000/day)')
	for (const j of QUOTA_JOBS) if (!(Number.isInteger(c.allocations?.[j]) && c.allocations[j] >= 0)) bad(`allocations.${j} must be a non-negative integer`)
	const sum = QUOTA_JOBS.reduce((a, j) => a + c.allocations[j], 0)
	if (sum > perDay) bad(`allocations sum to ${sum} > perDay ${perDay}`)
	if (!(c.maxBreachesPerDay >= 1 && c.maxBreachesPerDay <= 3)) bad('maxBreachesPerDay must be 1–3 (Fyers blocks the day after more than 3)')
	if (!(c.cooldownMs >= 30_000)) bad('cooldownMs must be >= 30000 (Cloudflare retry_after is 30 s)')
	if (!(Number.isInteger(c.maxRetries) && c.maxRetries >= 0 && c.maxRetries <= 5)) bad('maxRetries must be 0–5')
	return c
}

export const loadQuotaConfig = (file = process.env.FYERS_QUOTA_CONFIG || path.resolve(process.cwd(), 'config', 'fyers_quota.json')): QuotaConfig =>
	validateQuotaConfig(JSON.parse(fs.readFileSync(file, 'utf8')))

// ── Errors that stop a job (never retried) ───────────────────────────────────

export class QuotaStopError extends Error {}
/** Fyers said the daily limit is reached. Every job is done for the day. */
export class DailyQuotaExhaustedError extends QuotaStopError {}
/** This job used its allocation; other jobs keep theirs. Resume tomorrow. */
export class AllocationExhaustedError extends QuotaStopError {}
/** Throttled maxBreachesPerDay times today — stop before Fyers blocks the whole day. */
export class BreachLimitError extends QuotaStopError {}

export type ErrorKind = 'DAILY' | 'THROTTLE' | 'OTHER'

const textOf = (err: unknown): string => {
	if (!err) return ''
	if (typeof err === 'string') return err
	const e = err as { message?: string; detail?: string; title?: string }
	let json = ''
	try {
		json = JSON.stringify(err)
	} catch {
		/* circular */
	}
	return `${e.message ?? ''} ${e.title ?? ''} ${e.detail ?? ''} ${json}`
}

/** Shapes seen on 2026-10-19/20 plus Fyers' documented -429 / HTTP 429. */
export const classifyFyersError = (err: unknown): ErrorKind => {
	const t = textOf(err)
	if (/requests\/day|per day|daily limit/i.test(t)) return 'DAILY'
	const e = (err ?? {}) as { code?: number | string; status?: number; error_code?: number; cloudflare_error?: boolean; response?: { status?: number } }
	if (e.error_code === 1015 || e.cloudflare_error === true || e.status === 429 || e.response?.status === 429) return 'THROTTLE'
	if (['-360', '-429', '429'].includes(String(e.code))) return 'THROTTLE'
	if (/requests\/second|requests\/minute|rate.?limit|too many requests/i.test(t)) return 'THROTTLE'
	return 'OTHER'
}

const retryAfterMs = (err: unknown): number => {
	const e = (err ?? {}) as { retry_after?: number }
	return typeof e.retry_after === 'number' ? e.retry_after * 1000 + 1000 : 0
}

// ── Ledger ───────────────────────────────────────────────────────────────────

export interface LedgerState {
	used: Partial<Record<QuotaJob, number>>
	breaches: number
	exhausted: boolean
	cooldownUntil: number
}

export interface QuotaLedger {
	state(day: string): Promise<LedgerState>
	/** Count n requests for job; returns the job's new total for the day. */
	add(day: string, job: QuotaJob, n: number): Promise<number>
	/** Record a throttle; returns today's breach count. */
	breach(day: string, cooldownUntil: number): Promise<number>
	markExhausted(day: string): Promise<void>
}

const emptyState = (): LedgerState => ({ used: {}, breaches: 0, exhausted: false, cooldownUntil: 0 })

export class MemoryLedger implements QuotaLedger {
	days = new Map<string, LedgerState>()
	private s(day: string) {
		let x = this.days.get(day)
		if (!x) this.days.set(day, (x = emptyState()))
		return x
	}
	async state(day: string) {
		return structuredClone(this.s(day))
	}
	async add(day: string, job: QuotaJob, n: number) {
		const s = this.s(day)
		s.used[job] = (s.used[job] ?? 0) + n
		return s.used[job]!
	}
	async breach(day: string, until: number) {
		const s = this.s(day)
		s.breaches++
		s.cooldownUntil = Math.max(s.cooldownUntil, until)
		return s.breaches
	}
	async markExhausted(day: string) {
		this.s(day).exhausted = true
	}
}

/** One JSON file — the owner's PC (backtest). Survives restarts and multiple nights. */
export class FileLedger implements QuotaLedger {
	constructor(readonly file: string) {}
	private read(): Record<string, LedgerState> {
		try {
			return JSON.parse(fs.readFileSync(this.file, 'utf8'))
		} catch {
			return {}
		}
	}
	private write(all: Record<string, LedgerState>) {
		fs.mkdirSync(path.dirname(this.file), { recursive: true })
		const tmp = `${this.file}.${process.pid}.tmp`
		fs.writeFileSync(tmp, JSON.stringify(all, null, 2))
		fs.renameSync(tmp, this.file)
	}
	private mutate<T>(day: string, f: (s: LedgerState) => T): T {
		const all = this.read()
		const s = (all[day] ??= emptyState())
		const r = f(s)
		this.write(all)
		return r
	}
	async state(day: string) {
		return this.read()[day] ?? emptyState()
	}
	async add(day: string, job: QuotaJob, n: number) {
		return this.mutate(day, (s) => (s.used[job] = (s.used[job] ?? 0) + n))
	}
	async breach(day: string, until: number) {
		return this.mutate(day, (s) => {
			s.cooldownUntil = Math.max(s.cooldownUntil, until)
			return ++s.breaches
		})
	}
	async markExhausted(day: string) {
		this.mutate(day, (s) => {
			s.exhausted = true
		})
	}
}

/** Minimal surface of the node-redis v4 client used here (keeps tests free of Redis). */
export interface RedisLike {
	hIncrBy(key: string, field: string, n: number): Promise<number>
	hGetAll(key: string): Promise<Record<string, string>>
	hSet(key: string, field: string, value: string): Promise<number>
	expire(key: string, secs: number): Promise<boolean | number>
}

/**
 * EC2: one hash per IST day, shared by the engine (seeder, anomaly) and the
 * screener container. Key fyers:quota:{day}, 3-day TTL, never cleared at boot.
 */
export class RedisLedger implements QuotaLedger {
	constructor(private readonly redis: RedisLike) {}
	static key = (day: string) => `fyers:quota:${day}`
	private async touch(day: string) {
		await this.redis.expire(RedisLedger.key(day), 3 * 24 * 3600)
	}
	async state(day: string) {
		const h = await this.redis.hGetAll(RedisLedger.key(day))
		const used: LedgerState['used'] = {}
		for (const j of QUOTA_JOBS) if (h[`used:${j}`]) used[j] = Number(h[`used:${j}`])
		return { used, breaches: Number(h.breaches ?? 0), exhausted: h.exhausted === '1', cooldownUntil: Number(h.cooldownUntil ?? 0) }
	}
	async add(day: string, job: QuotaJob, n: number) {
		const v = await this.redis.hIncrBy(RedisLedger.key(day), `used:${job}`, n)
		await this.touch(day)
		return v
	}
	async breach(day: string, until: number) {
		const k = RedisLedger.key(day)
		const cur = Number((await this.redis.hGetAll(k)).cooldownUntil ?? 0)
		if (until > cur) await this.redis.hSet(k, 'cooldownUntil', String(until))
		const b = await this.redis.hIncrBy(k, 'breaches', 1)
		await this.touch(day)
		return b
	}
	async markExhausted(day: string) {
		await this.redis.hSet(RedisLedger.key(day), 'exhausted', '1')
		await this.touch(day)
	}
}

// ── Pacing: several rolling windows at once ─────────────────────────────────

export const createMultiWindowLimiter = (windows: { max: number; windowMs: number }[], clock: LimiterClock) => {
	const starts: number[] = [] // ascending
	const longest = Math.max(...windows.map((w) => w.windowMs))
	let tail: Promise<void> = Promise.resolve()
	const acquire = async () => {
		for (;;) {
			const now = clock.now()
			while (starts.length && now - starts[0]! >= longest) starts.shift()
			let waitUntil = 0
			for (const w of windows) {
				const inWindow = starts.filter((t) => now - t < w.windowMs)
				if (inWindow.length >= w.max) waitUntil = Math.max(waitUntil, inWindow[0]! + w.windowMs)
			}
			if (waitUntil === 0) {
				starts.push(now)
				return
			}
			await clock.sleep(waitUntil - now)
		}
	}
	/** Resolves when a slot is free; the slot is taken at that moment. FIFO. */
	const slot = (): Promise<void> => {
		const p = tail.then(acquire)
		tail = p.catch(() => {})
		return p
	}
	return { slot }
}

// ── The gate ─────────────────────────────────────────────────────────────────

const realClock: LimiterClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }

export interface QuotaGate {
	/** Run one Data-API request under pacing, allocation, cooldown and stop rules. */
	call<T>(fn: () => Promise<T>): Promise<T>
	readonly job: QuotaJob
}

export const createQuotaGate = (opts: {
	job: QuotaJob
	config: QuotaConfig
	ledger: QuotaLedger
	clock?: LimiterClock
	/** Share one limiter between gates in the same process (engine: seeder + anomaly). */
	limiter?: ReturnType<typeof createMultiWindowLimiter>
	log?: Pick<Console, 'warn' | 'error'>
}): QuotaGate => {
	const { job, config: c, ledger } = opts
	const clock = opts.clock ?? realClock
	const log = opts.log ?? console
	const limiter =
		opts.limiter ??
		createMultiWindowLimiter(
			[
				{ max: c.dataApi.perSecond, windowMs: 1000 },
				{ max: c.dataApi.perMinute, windowMs: 60_000 },
			],
			clock,
		)
	const alloc = c.allocations[job]

	const call = async <T>(fn: () => Promise<T>): Promise<T> => {
		for (let attempt = 0; ; attempt++) {
			// Pace first, THEN read the ledger: a caller queued in the limiter must
			// see a stop or cooldown that another caller recorded while it waited.
			await limiter.slot()
			const day = getISTDateString(clock.now())
			const st = await ledger.state(day)
			if (st.exhausted) throw new DailyQuotaExhaustedError(`Fyers daily Data-API limit already reached on ${day} — no further calls today`)
			if (st.breaches >= c.maxBreachesPerDay)
				throw new BreachLimitError(`throttled ${st.breaches}× on ${day} (limit ${c.maxBreachesPerDay}) — stopping before Fyers blocks the day`)
			if (st.cooldownUntil > clock.now()) {
				await clock.sleep(st.cooldownUntil - clock.now())
				attempt-- // waiting out a cooldown is not an attempt
				continue
			}
			// Check before counting, so callers queued past the allocation don't inflate it.
			if ((st.used[job] ?? 0) >= alloc) throw new AllocationExhaustedError(`${job} used its ${alloc} Data-API requests for ${day} — resume on the next run`)
			// Counted before the call: Fyers counts every request, failed ones included.
			const used = await ledger.add(day, job, 1)
			if (used > alloc) throw new AllocationExhaustedError(`${job} used its ${alloc} Data-API requests for ${day} — resume on the next run`)
			try {
				return await fn()
			} catch (err) {
				const kind = classifyFyersError(err)
				if (kind === 'DAILY') {
					await ledger.markExhausted(day)
					throw new DailyQuotaExhaustedError(`Fyers: daily Data-API limit reached on ${day} (${textOf(err).trim().slice(0, 160)})`)
				}
				if (kind === 'THROTTLE') {
					const until = clock.now() + Math.max(retryAfterMs(err), c.cooldownMs)
					const breaches = await ledger.breach(day, until)
					// Fyers' own words, so a throttle can be diagnosed from the log (Oct 21 kept only the classification).
					const said = textOf(err).replace(/\s+/g, ' ').trim().slice(0, 300) || '(no error text)'
					log.warn(`[FyersQuota] ${job}: throttled (breach ${breaches}/${c.maxBreachesPerDay} today) — all callers cool down ${Math.round((until - clock.now()) / 1000)} s — Fyers said: ${said}`)
					if (breaches >= c.maxBreachesPerDay)
						throw new BreachLimitError(`throttled ${breaches}× on ${day} — stopping before Fyers blocks the day (last: ${said})`)
					if (attempt < c.maxRetries) continue
				}
				throw err
			}
		}
	}
	return { call, job }
}
