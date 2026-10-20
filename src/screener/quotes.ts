// ============================================================
// screener/quotes.ts — batched quotes through the quota gate
//
// ≤ 50 symbols per request (prefilter.QUOTE_BATCH). A failed batch is not
// fatal: its symbols simply have no quote and the lenient pre-filter fetches
// them. A quota stop (allocation / daily limit / throttle limit) ends it.
// ============================================================

import { QuotaStopError, type QuotaGate } from '../fyers/quota.js'
import type { QuoteReport } from './job.js'
import { batches, parseQuotes, QUOTE_BATCH } from './prefilter.js'

export const fetchQuotesBatched = async (
	symbols: string[],
	deps: { getQuotes: (batch: string[]) => Promise<unknown>; gate: QuotaGate; log?: Pick<Console, 'warn'> },
): Promise<QuoteReport> => {
	const report: QuoteReport = { quotes: new Map(), failed: [], requests: 0, stopped: null }
	for (const batch of batches(symbols, QUOTE_BATCH)) {
		try {
			const resp = await deps.gate.call(async () => {
				report.requests++
				const r = (await deps.getQuotes(batch)) as { s?: string }
				if (r?.s !== 'ok') throw r // error body → the gate classifies it (daily / throttle / other)
				return r
			})
			for (const [sym, q] of parseQuotes(resp)) report.quotes.set(sym, q)
		} catch (err) {
			if (err instanceof QuotaStopError) {
				report.stopped = err
				return report
			}
			report.failed.push(...batch)
			deps.log?.warn(`[Screener] quote batch of ${batch.length} failed (fetched anyway): ${(err as { message?: string })?.message ?? JSON.stringify(err)}`)
		}
	}
	return report
}
