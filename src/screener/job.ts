// ============================================================
// screener/job.ts — one end-of-day screener run (I/O injected, testable)
//
// fetch → failure budget → screen → write. If the budget is breached the
// previous watchlist is KEPT (nothing is overwritten), the failed symbols are
// written to failed_<date>.json and the admin is told. Never a partial list.
//
// Files (all in dataDir, written atomically):
//   watchlist.json          string[]  — what the engine reads at boot
//   watchlist_meta.json     as-of, config hash, funnel, per-entry source/tier/score/reason
//   universe_stats.json     per-symbol records for every scanned symbol (review / audit)
//   anomaly_universe.json   Layer B scan set, CAPPED (config layerB.maxSymbols) — what anomalyScanner reads
//   history/<date>.json.gz  dated copy of meta + stats, one per run day
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { ScreenerConfig } from './config.js'
import type { CandleStore } from './candleStore.js'
import { evaluateFailureBudget, type FetchReport } from './fetchDaily.js'
import { formatFunnel } from './funnel.js'
import { anomalyUniverse, screenAsOf, type ScreenerSource, type ScreenResult } from './screen.js'
import { decidePrefilter, updatePrefilterState, type PrefilterState, type Quote } from './prefilter.js'
import type { QuotaStopError } from '../fyers/quota.js'

export interface QuoteReport {
	quotes: Map<string, Quote>
	/** symbols whose quote batch failed (fetched anyway — lenient) */
	failed: string[]
	requests: number
	stopped: QuotaStopError | null
}

export interface JobDeps {
	dataDir: string
	store: CandleStore
	universe: string[]
	core: string[]
	fno: Set<string>
	config: ScreenerConfig
	configHash: string
	todayIst: string
	/** Fetches the given symbols + the benchmark into the store. */
	fetchAll: (symbols: string[]) => Promise<FetchReport>
	/** Quotes for the pre-filter (50 per request). Omitted → every symbol is fetched. */
	fetchQuotes?: (symbols: string[]) => Promise<QuoteReport>
	notifyAdmin: (text: string) => Promise<unknown>
	log?: Pick<Console, 'log' | 'warn' | 'error'>
}

export type JobResult =
	| { status: 'WRITTEN'; result: ScreenResult; funnelText: string }
	| { status: 'KEPT_PREVIOUS'; reason: string; failed: string[] }
	/** The quota gate stopped the run (allocation / daily limit / throttling). Candles fetched so far are kept; the next run resumes. */
	| { status: 'INCOMPLETE'; reason: string; fetched: number; planned: number }

const writeAtomic = (file: string, data: string | Buffer) => {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	const tmp = `${file}.${process.pid}.tmp`
	fs.writeFileSync(tmp, data)
	fs.renameSync(tmp, file)
}

export const readPreviousSources = (dataDir: string): Map<string, ScreenerSource> | null => {
	try {
		const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'watchlist_meta.json'), 'utf8')) as {
			entries?: { symbol: string; source: ScreenerSource }[]
		}
		return new Map((meta.entries ?? []).map((e) => [e.symbol, e.source]))
	} catch {
		return null
	}
}

const readJson = <T>(file: string, fallback: T): T => {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as T
	} catch {
		return fallback
	}
}

/** Names always fetched by the pre-filter: CORE + yesterday's watchlist + yesterday's Layer B set. */
export const alwaysFetch = (dataDir: string, core: string[]): Set<string> =>
	new Set([
		...core,
		...readJson<string[]>(path.join(dataDir, 'watchlist.json'), []),
		...(readPreviousSources(dataDir)?.keys() ?? []),
		...Object.keys(readJson<Record<string, unknown>>(path.join(dataDir, 'anomaly_universe.json'), {})),
	])

export const runScreenerJob = async (deps: JobDeps): Promise<JobResult> => {
	const log = deps.log ?? console
	const { config: c } = deps
	const statePath = path.join(deps.dataDir, 'prefilter_state.json')

	const incomplete = async (stop: QuotaStopError, fetched: number, planned: number): Promise<JobResult> => {
		const reason = stop.message
		writeAtomic(path.join(deps.dataDir, `incomplete_${deps.todayIst}.json`), JSON.stringify({ date: deps.todayIst, reason, fetched, planned }, null, 2))
		const msg = `⏸️ Screener ${deps.todayIst}: stopped by the Fyers quota guard — ${reason}. ${fetched}/${planned} symbols fetched and saved; the next run resumes. Previous watchlist kept.`
		log.error(`[Screener] ${msg}`)
		await deps.notifyAdmin(msg)
		return { status: 'INCOMPLETE', reason, fetched, planned }
	}

	// 1. Lenient quote pre-filter (≈ universe/50 requests)
	let fetchList = deps.universe
	let skipped = new Map<string, string>()
	let prefilterInfo: Record<string, unknown> | null = null
	const prevState = readJson<PrefilterState>(statePath, { rejected: {} })
	if (deps.fetchQuotes) {
		const q = await deps.fetchQuotes(deps.universe)
		if (q.stopped) return incomplete(q.stopped, 0, deps.universe.length)
		const d = decidePrefilter({ universe: deps.universe, quotes: q.quotes, always: alwaysFetch(deps.dataDir, deps.core), state: prevState, today: deps.todayIst, config: c.prefilter })
		fetchList = d.fetch
		skipped = d.skipped
		prefilterInfo = { quoteRequests: q.requests, quoteBatchesFailedSymbols: q.failed.length, ...d.counts, skipped: d.skipped.size, fetch: d.fetch.length }
		log.log(`[Screener] Pre-filter: ${d.fetch.length} of ${deps.universe.length} need history (${q.requests} quote requests; always ${d.counts.always}, no quote ${d.counts.noQuote}, quote pass ${d.counts.pass}, weekly recheck due ${d.counts.recheckDue}; skipped ${d.skipped.size})`)
	}

	// 2. History for the pre-filtered list + the benchmark
	const report = await deps.fetchAll([...fetchList, c.benchmark])
	if (report.stopped) return incomplete(report.stopped, report.outcomes.size, fetchList.length + 1)

	// The benchmark is mandatory: no benchmark, no RS — keep the old list.
	const benchOutcome = report.outcomes.get(c.benchmark)
	report.outcomes.delete(c.benchmark)
	const verdict = evaluateFailureBudget(report.outcomes, c.failureBudget)
	const benchBars = deps.store.load(c.benchmark)
	const reason = !verdict.ok
		? verdict.reason!
		: benchOutcome === 'FAILED' || benchBars.length === 0
			? `benchmark ${c.benchmark} unavailable (${benchOutcome ?? 'missing'})`
			: null

	if (reason) {
		writeAtomic(
			path.join(deps.dataDir, `failed_${deps.todayIst}.json`),
			JSON.stringify({ date: deps.todayIst, reason, failed: verdict.failed, errors: Object.fromEntries(report.errors) }, null, 2),
		)
		const msg = `⚠️ Screener ${deps.todayIst}: run NOT trusted — ${reason}. Previous watchlist kept. Failed: ${verdict.failed.slice(0, 30).join(', ')}${verdict.failed.length > 30 ? ` …+${verdict.failed.length - 30}` : ''}`
		log.error(`[Screener] ${msg}`)
		await deps.notifyAdmin(msg)
		return { status: 'KEPT_PREVIOUS', reason, failed: verdict.failed }
	}

	const series = new Map(fetchList.map((s) => [s, deps.store.load(s)]))
	const result = screenAsOf({
		asOf: deps.todayIst,
		universe: fetchList,
		series,
		benchmark: benchBars,
		core: deps.core,
		previous: readPreviousSources(deps.dataDir),
		fno: deps.fno,
		fetchOutcome: report.outcomes,
		config: c,
		configHash: deps.configHash,
	})

	if (deps.fetchQuotes) {
		result.funnel.scanned = deps.universe.length
		result.funnel.prefilterSkipped = skipped.size
	}
	const layerB = anomalyUniverse(result, c)
	const meta = {
		asOf: result.asOf,
		generatedAt: new Date().toISOString(),
		configHash: result.configHash,
		benchmark: result.benchmark,
		funnel: result.funnel,
		notes: result.notes,
		fetch: { requests: report.requests, retries: report.retries, failed: verdict.failed },
		layerB: { symbols: Object.keys(layerB).length, cap: c.layerB.maxSymbols },
		prefilter: prefilterInfo,
		entries: result.entries,
	}
	writeAtomic(path.join(deps.dataDir, 'universe_stats.json'), JSON.stringify(result.records))
	if (deps.fetchQuotes) {
		writeAtomic(path.join(deps.dataDir, 'prefilter_skipped.json'), JSON.stringify(Object.fromEntries(skipped)))
		writeAtomic(statePath, JSON.stringify(updatePrefilterState(prevState, result.asOf, result.records), null, 2))
	}
	writeAtomic(path.join(deps.dataDir, 'anomaly_universe.json'), JSON.stringify(layerB))
	writeAtomic(path.join(deps.dataDir, 'watchlist_meta.json'), JSON.stringify(meta, null, 2))
	writeAtomic(path.join(deps.dataDir, 'history', `${result.asOf}.json.gz`), zlib.gzipSync(JSON.stringify({ meta, records: result.records })))
	// Last: the file the engine reads. A crash before this line leaves the old list.
	writeAtomic(path.join(deps.dataDir, 'watchlist.json'), JSON.stringify(result.watchlist, null, 2))

	const funnelText = formatFunnel(result)
	log.log(funnelText)
	return { status: 'WRITTEN', result, funnelText }
}
