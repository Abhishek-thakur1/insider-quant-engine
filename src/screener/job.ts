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
//   universe_stats.json     per-symbol records; legacy fields kept for anomalyScanner
//   history/<date>.json.gz  dated copy of meta + stats, one per run day
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { ScreenerConfig } from './config.js'
import type { CandleStore } from './candleStore.js'
import { evaluateFailureBudget, type FetchReport } from './fetchDaily.js'
import { formatFunnel } from './funnel.js'
import { screenAsOf, type ScreenerSource, type ScreenResult } from './screen.js'

export interface JobDeps {
	dataDir: string
	store: CandleStore
	universe: string[]
	core: string[]
	fno: Set<string>
	config: ScreenerConfig
	configHash: string
	todayIst: string
	/** Fetches every symbol + the benchmark into the store. */
	fetchAll: (symbols: string[]) => Promise<FetchReport>
	notifyAdmin: (text: string) => Promise<unknown>
	log?: Pick<Console, 'log' | 'warn' | 'error'>
}

export type JobResult =
	| { status: 'WRITTEN'; result: ScreenResult; funnelText: string }
	| { status: 'KEPT_PREVIOUS'; reason: string; failed: string[] }

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

export const runScreenerJob = async (deps: JobDeps): Promise<JobResult> => {
	const log = deps.log ?? console
	const { config: c } = deps
	const report = await deps.fetchAll([...deps.universe, c.benchmark])

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

	const series = new Map(deps.universe.map((s) => [s, deps.store.load(s)]))
	const result = screenAsOf({
		asOf: deps.todayIst,
		universe: deps.universe,
		series,
		benchmark: benchBars,
		core: deps.core,
		previous: readPreviousSources(deps.dataDir),
		fno: deps.fno,
		fetchOutcome: report.outcomes,
		config: c,
		configHash: deps.configHash,
	})

	const meta = {
		asOf: result.asOf,
		generatedAt: new Date().toISOString(),
		configHash: result.configHash,
		benchmark: result.benchmark,
		funnel: result.funnel,
		notes: result.notes,
		fetch: { requests: report.requests, retries: report.retries, failed: verdict.failed },
		entries: result.entries,
	}
	writeAtomic(path.join(deps.dataDir, 'universe_stats.json'), JSON.stringify(result.records))
	writeAtomic(path.join(deps.dataDir, 'watchlist_meta.json'), JSON.stringify(meta, null, 2))
	writeAtomic(path.join(deps.dataDir, 'history', `${result.asOf}.json.gz`), zlib.gzipSync(JSON.stringify({ meta, records: result.records })))
	// Last: the file the engine reads. A crash before this line leaves the old list.
	writeAtomic(path.join(deps.dataDir, 'watchlist.json'), JSON.stringify(result.watchlist, null, 2))

	const funnelText = formatFunnel(result)
	log.log(funnelText)
	return { status: 'WRITTEN', result, funnelText }
}
