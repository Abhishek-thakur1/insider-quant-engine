// ============================================================
// screener/dailyWatchlist.ts — the daily watchlist (filters and ranking: dw-2; list: dw-3)
//
// Rules: docs/studies/daily-watchlist/PREREGISTRATION_dw3.md (dw-3 = dw-2's filters and ranking on the
// NSE bhavcopy, 80 symbols incl. Nifty; the source runner is screener/bhavcopy.ts). dw-2 and dw-1 are
// kept as records. Pure functions (ranking, validation, which file the engine boots from) plus the
// legacy Fyers-quote scan runner (runDailyScan, scripts/daily_watchlist.ts; not scheduled).
// The Fyers scan = 1 master download + at most 48 quote batches + at most 6 retries (hard cap 55).
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { QuotaStopError } from '../fyers/quota.js'
import { batches, QUOTE_BATCH } from './prefilter.js'

export const RULES_VERSION = 'dw-3'
export const CORE_SIZE = 52 // the owner's 3 Nov watchlist (dw-3 amendment 1; was the 20 Oct 25)
export const MIN_STOCKS = 60
export const MAX_STOCKS = 79
export const ROTATING_SLOTS = MAX_STOCKS - CORE_SIZE // 52 core + 27 = 79 stocks + Nifty = 80 symbols (owner, 3 Nov)
export const SCAN_REQUEST_CAP = 55 // master download + quote requests (owner, 4 Nov scan)
export const QUOTE_BATCH_CAP = 48 // more batches needed → fail before any quote call
export const QUOTE_RETRY_CAP = 6 // attempts beyond the batch count
export const QUOTE_REQUEST_CAP = SCAN_REQUEST_CAP - 1 // 54 = 48 + 6
export const MIN_PRICE = 50
export const MIN_TURNOVER_RUPEES = 50 * 1e7 // ₹50 crore
export const MAX_FAILED_BATCH_SHARE = 0.1
export const WEIGHTS = { move: 0.4, range: 0.3, turnover: 0.3 } as const
export const SYMBOL_RE = /^NSE:[A-Z0-9&_.-]+-EQ$/
export const DAILY_FILE = 'watchlist_daily.json'
export const HISTORY_DIR = 'watchlist_daily_history'

export interface DailyQuote {
	lp: number
	prevClose: number
	high: number
	low: number
	volume: number
	tt: number // Fyers "Today's time": a date stamp (00:00 UTC of the day), epoch seconds — not a trade time
}

export interface RankedEntry {
	symbol: string
	group: 'core' | 'rotating'
	pick?: 'score' | 'turnover' // dw-3 amendment 1b: which rotating group (evidence only; the engine reads `symbols`)
	rank?: number
	score?: number
	move?: number
	range?: number
	turnover?: number
}

export interface DailyWatchlistFile {
	rulesVersion: string
	asOf: string
	forSession: string
	generatedAt: string
	requests: number
	source?: string // dw-3: 'nse-bhavcopy <file name>'
	fyersCheck?: { file: string; asOf: string; symbols: number; dropped: string[] } // dw-3 amendment 1
	funnel?: ReturnType<typeof eligibilityFunnel>
	symbols: string[]
	entries: RankedEntry[]
}

const IST_MS = 5.5 * 3_600_000
const istDay = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10)
const istMinutes = (ms: number) => {
	const d = new Date(ms + IST_MS)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** Fyers quotes { s:'ok', d:[{ n, s:'ok', v:{ lp, prev_close_price, high_price, low_price, volume, tt } }] }. */
export const parseDailyQuotes = (resp: unknown): Map<string, DailyQuote> => {
	const out = new Map<string, DailyQuote>()
	const d = (resp as { d?: unknown[] })?.d
	if (!Array.isArray(d)) return out
	for (const row of d) {
		const r = row as { n?: string; s?: string; v?: Record<string, unknown> }
		if (!r?.n || r.s !== 'ok' || !r.v) continue
		const q = {
			lp: Number(r.v.lp),
			prevClose: Number(r.v.prev_close_price),
			high: Number(r.v.high_price),
			low: Number(r.v.low_price),
			volume: Number(r.v.volume),
			tt: Number(r.v.tt),
		}
		if (Object.values(q).every(Number.isFinite)) out.set(r.n, q)
	}
	return out
}

/** Percentile rank in [0, 1], ties averaged (a single value → 1). */
export const percentiles = (xs: number[]): number[] => {
	const n = xs.length
	if (n === 0) return []
	if (n === 1) return [1]
	const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
	const out = new Array<number>(n)
	for (let i = 0; i < n; ) {
		let j = i
		while (j + 1 < n && order[j + 1]![0] === order[i]![0]) j++
		const p = (i + j) / 2 / (n - 1)
		for (let k = i; k <= j; k++) out[order[k]![1]] = p
		i = j + 1
	}
	return out
}

/** As-of rule (dw-2): the IST date of `tt` is the as-of day and the stock traded (volume > 0). */
export const quoteOnAsOf = (q: DailyQuote, asOf: string): boolean => istDay(q.tt * 1000) === asOf && q.volume > 0

/** How many quotes pass each eligibility step, in order (diagnostics for the log and the owner). */
export const eligibilityFunnel = (quotes: Map<string, DailyQuote>, core: string[], asOf: string) => {
	const coreSet = new Set(core)
	const qs = [...quotes].filter(([s]) => !coreSet.has(s)).map(([, q]) => q)
	const a = qs.filter((q) => quoteOnAsOf(q, asOf))
	const p = a.filter((q) => q.lp >= MIN_PRICE)
	const t = p.filter((q) => q.lp * q.volume >= MIN_TURNOVER_RUPEES)
	const r = t.filter((q) => q.prevClose > 0 && q.high > q.low)
	return { quoted: qs.length, asOfDay: a.length, price: p.length, turnover: t.length, eligible: r.length }
}

export const eligible = (q: DailyQuote, asOf: string): boolean =>
	quoteOnAsOf(q, asOf) && q.lp >= MIN_PRICE && q.lp * q.volume >= MIN_TURNOVER_RUPEES && q.prevClose > 0 && q.high > q.low

/** Rank the rotating candidates (rules dw-2). Core symbols are never ranked. */
export const rankRotating = (quotes: Map<string, DailyQuote>, core: string[], asOf: string, slots = ROTATING_SLOTS): RankedEntry[] => {
	const coreSet = new Set(core)
	const rows = [...quotes]
		.filter(([s, q]) => !coreSet.has(s) && SYMBOL_RE.test(s) && eligible(q, asOf))
		.map(([symbol, q]) => ({
			symbol,
			move: Math.abs(q.lp - q.prevClose) / q.prevClose,
			range: (q.high - q.low) / q.prevClose,
			turnover: q.lp * q.volume,
		}))
	const pm = percentiles(rows.map((r) => r.move))
	const pr = percentiles(rows.map((r) => r.range))
	const pt = percentiles(rows.map((r) => r.turnover))
	const scored = rows.map((r, i) => ({ ...r, score: WEIGHTS.move * pm[i]! + WEIGHTS.range * pr[i]! + WEIGHTS.turnover * pt[i]! }))
	scored.sort((a, b) => b.score - a.score || b.turnover - a.turnover || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
	return scored.slice(0, slots).map((r, i) => ({ group: 'rotating' as const, rank: i + 1, ...r }))
}

/** Problems with a list (empty array = valid). `universe` checks the rotating names against the master. */
export const validateList = (symbols: unknown, opts: { rotating?: string[]; universe?: Set<string> } = {}): string[] => {
	const errs: string[] = []
	if (!Array.isArray(symbols)) return ['symbols is not an array']
	const bad = symbols.filter((s) => typeof s !== 'string' || !SYMBOL_RE.test(s))
	if (bad.length) errs.push(`${bad.length} malformed symbol(s): ${bad.slice(0, 3).map(String).join(', ')}`)
	const unique = new Set(symbols)
	if (unique.size !== symbols.length) errs.push(`${symbols.length - unique.size} duplicate symbol(s)`)
	if (unique.size < MIN_STOCKS || unique.size > MAX_STOCKS) errs.push(`${unique.size} stocks, need ${MIN_STOCKS}–${MAX_STOCKS} (${MIN_STOCKS + 1}–${MAX_STOCKS + 1} with Nifty)`)
	if (opts.universe && opts.rotating) {
		const missing = opts.rotating.filter((s) => !opts.universe!.has(s))
		if (missing.length) errs.push(`${missing.length} rotating name(s) not in the master: ${missing.slice(0, 3).join(', ')}`)
	}
	return errs
}

export const validateDailyFile = (f: unknown): string[] => {
	const x = f as Partial<DailyWatchlistFile> | null
	if (!x || typeof x !== 'object') return ['not an object']
	const errs: string[] = []
	if (x.rulesVersion !== RULES_VERSION) errs.push(`rulesVersion ${String(x.rulesVersion)} ≠ ${RULES_VERSION}`)
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.forSession))) errs.push('forSession missing')
	return [...errs, ...validateList(x.symbols)]
}

/** SCREENER_ENABLED: off unless exactly 'true' (owner, 2 Nov: default off until a scan has been reviewed). */
export const screenerEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.SCREENER_ENABLED === 'true'

export interface WatchlistChoice {
	path: string
	symbols: string[]
	source: 'daily' | 'static'
	/** The daily file's entries (group core/rotating, pick score/turnover); daily source only. */
	entries?: RankedEntry[]
	reason: string
	/** True when the daily list was wanted but couldn't be used (alert the owner). */
	fellBack: boolean
}

/** Which list the engine boots from: the daily file when enabled, valid and for today; else the static file. */
export const chooseWatchlist = (opts: { enabled: boolean; dailyPath: string; staticPath: string; today: string; readFile?: (p: string) => string }): WatchlistChoice => {
	const read = opts.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'))
	const fromStatic = (reason: string, fellBack: boolean): WatchlistChoice => ({
		path: opts.staticPath,
		symbols: JSON.parse(read(opts.staticPath)) as string[],
		source: 'static',
		reason,
		fellBack,
	})
	if (!opts.enabled) return fromStatic('SCREENER_ENABLED is not true', false)
	let f: DailyWatchlistFile
	try {
		f = JSON.parse(read(opts.dailyPath)) as DailyWatchlistFile
	} catch {
		return fromStatic(`no readable ${path.basename(opts.dailyPath)}`, true)
	}
	const errs = validateDailyFile(f)
	if (errs.length) return fromStatic(`daily list invalid: ${errs.join('; ')}`, true)
	if (f.forSession !== opts.today) return fromStatic(`daily list is for ${f.forSession}, not ${opts.today}`, true)
	return { path: opts.dailyPath, symbols: f.symbols, source: 'daily', entries: Array.isArray(f.entries) ? f.entries : [], reason: `rules ${f.rulesVersion}, as of ${f.asOf}`, fellBack: false }
}

/** Raised by the request budget; a QuotaStopError, so the batched fetch stops at once. */
export class ScanBudgetError extends QuotaStopError {}

export interface ScanDeps {
	asOf: string
	forSession: string
	nowMs: number
	core: string[]
	downloadMaster: () => Promise<string[]> // the universe from NSE_CM.csv
	getQuotes: (batch: string[]) => Promise<unknown> // production: gate.call(() => budgeted api.getQuotes)
	quoteRequestsUsed: () => number // attempts made by getQuotes so far (gate retries included)
	limitQuoteRequests?: (n: number) => void // lowers the attempt cap to batches + QUOTE_RETRY_CAP, once the batch count is known
	writeFile: (name: string, content: string) => void // atomic, relative to the data dir
	saveRaw?: (line: string) => void // one JSON line per quote batch, written as it returns (dw-2 raw sample)
	notify: (text: string) => Promise<unknown>
	log?: Pick<Console, 'log' | 'warn'>
}

export type ScanResult = { ok: true; file: DailyWatchlistFile } | { ok: false; reason: string; requests: number }

/** True between 09:00 and 15:30 IST on a trading day (the scan refuses to run then). */
export const inSessionWindow = (nowMs: number, isTradingDay: boolean): boolean => {
	const m = istMinutes(nowMs)
	return isTradingDay && m >= 9 * 60 && m < 15 * 60 + 30
}

export const runDailyScan = async (d: ScanDeps): Promise<ScanResult> => {
	const log = d.log ?? console
	let requests = 0
	const fail = async (reason: string): Promise<ScanResult> => {
		const msg = `⚠️ Daily watchlist for ${d.forSession} NOT updated (${reason}); the previous list is kept. Requests used: ${requests}/${SCAN_REQUEST_CAP}.`
		log.warn(`[DailyWatchlist] ${msg}`)
		await d.notify(msg)
		return { ok: false, reason, requests }
	}
	if (d.core.length !== CORE_SIZE || new Set(d.core).size !== CORE_SIZE || !d.core.every((s) => SYMBOL_RE.test(s)))
		return fail(`core list must be ${CORE_SIZE} unique well-formed symbols`)

	let universe: string[]
	requests++ // the master download counts as 1 of the cap
	try {
		universe = await d.downloadMaster()
		if (universe.length < 1000) throw new Error(`only ${universe.length} symbols in the master`)
	} catch (err) {
		return fail(`symbol master: ${(err as Error).message}`)
	}
	const universeSet = new Set(universe)
	const toQuote = universe.filter((s) => !d.core.includes(s))
	const groups = batches(toQuote, QUOTE_BATCH)
	if (groups.length > QUOTE_BATCH_CAP) return fail(`${groups.length} quote batches needed > cap ${QUOTE_BATCH_CAP}`)
	const attemptCap = Math.min(QUOTE_REQUEST_CAP, groups.length + QUOTE_RETRY_CAP)
	d.limitQuoteRequests?.(attemptCap)
	log.log(`[DailyWatchlist] universe ${universe.length} · ${groups.length} quote batches (cap ${QUOTE_BATCH_CAP}) · at most ${attemptCap} quote attempts`)

	const quotes = new Map<string, DailyQuote>()
	let failed = 0
	const raw = (line: object) => {
		try {
			d.saveRaw?.(JSON.stringify(line))
		} catch {}
	}
	for (const [i, g] of groups.entries()) {
		try {
			const resp = await d.getQuotes(g)
			raw({ batch: i, at: new Date().toISOString(), resp })
			for (const [s, q] of parseDailyQuotes(resp)) quotes.set(s, q)
		} catch (err) {
			raw({ batch: i, at: new Date().toISOString(), error: (err as Error)?.message ?? err })
			if (err instanceof QuotaStopError) {
				requests = 1 + d.quoteRequestsUsed()
				return fail(`quota stop: ${err.message}`)
			}
			failed++
			log.warn(`[DailyWatchlist] quote batch of ${g.length} failed: ${(err as Error)?.message ?? String(err)}`)
		}
	}
	requests = 1 + d.quoteRequestsUsed()
	if (requests > SCAN_REQUEST_CAP) return fail(`${requests} requests > ${SCAN_REQUEST_CAP}`)
	if (failed / Math.max(1, groups.length) > MAX_FAILED_BATCH_SHARE) return fail(`${failed}/${groups.length} quote batches failed`)

	const funnel = eligibilityFunnel(quotes, d.core, d.asOf)
	const funnelText = `quoted ${funnel.quoted} → as-of day ${funnel.asOfDay} → price ${funnel.price} → turnover ${funnel.turnover} → eligible ${funnel.eligible}`
	log.log(`[DailyWatchlist] ${funnelText}`)
	const rotating = rankRotating(quotes, d.core, d.asOf)
	const symbols = [...d.core, ...rotating.map((r) => r.symbol)]
	const errs = validateList(symbols, { rotating: rotating.map((r) => r.symbol), universe: universeSet })
	if (errs.length) return fail(`validation: ${errs.join('; ')}; ${funnelText}`)

	const file: DailyWatchlistFile = {
		rulesVersion: RULES_VERSION,
		asOf: d.asOf,
		forSession: d.forSession,
		generatedAt: new Date(d.nowMs).toISOString(),
		requests,
		funnel,
		symbols,
		entries: [...d.core.map((symbol) => ({ symbol, group: 'core' as const })), ...rotating],
	}
	const body = JSON.stringify(file, null, 1)
	d.writeFile(`${HISTORY_DIR}/${d.forSession}.json`, body)
	d.writeFile(DAILY_FILE, body)
	log.log(`[DailyWatchlist] ✅ ${symbols.length} stocks for ${d.forSession} (core ${d.core.length} + rotating ${rotating.length}; ${quotes.size} quotes; ${requests}/${SCAN_REQUEST_CAP} requests)`)
	return { ok: true, file }
}

/** The hard request cap around the raw API call. Put it INSIDE gate.call so every attempt (retries too) counts. */
export const budgeted = (inner: (batch: string[]) => Promise<unknown>, cap = QUOTE_REQUEST_CAP) => {
	let used = 0
	let max = cap
	const call = async (batch: string[]): Promise<unknown> => {
		if (used >= max) throw new ScanBudgetError(`quote request cap ${max} reached`)
		used++
		return inner(batch)
	}
	/** Only ever lowers the cap. */
	const limit = (n: number) => {
		max = Math.min(max, n)
	}
	return { call, used: () => used, limit }
}

/** Atomic write into a directory: temp file, then rename. */
export const atomicWriter = (dir: string) => (name: string, content: string | Buffer) => {
	const target = path.join(dir, name)
	fs.mkdirSync(path.dirname(target), { recursive: true })
	const tmp = `${target}.tmp-${process.pid}`
	fs.writeFileSync(tmp, content)
	fs.renameSync(tmp, target)
}
