// ============================================================
// screener/prefilter.ts — decide which symbols need daily history today (pure)
//
// History is one Fyers Data-API request per symbol per chunk; the quote API
// covers 50 symbols per request (Fyers: "full market quotes for up to 50 symbols
// at a time"; the SDK joins them comma-separated and does not enforce the cap, so
// QUOTE_BATCH enforces it here). Both count against the same 5,000/day quota.
//
// LENIENT by design — a false skip loses a candidate, a false fetch costs one call:
//   always fetch:  CORE, yesterday's watchlist, yesterday's Layer B set, any symbol
//                  without a usable quote (missing, or its quote batch failed)
//   skip:          today's quote fails a loose bar (price < ₹20, or today's traded
//                  value < ₹2 cr — the full screen needs a ₹15 cr 30-day average)
//   weekly recheck: a symbol the FULL screen rejected as illiquid is skipped for
//                  7 days, then fetched and re-tested
// ============================================================

export const QUOTE_BATCH = 50

export interface PrefilterConfig {
	minPrice: number
	minTradedValueRupees: number
	recheckDays: number
}

export interface Quote {
	lp: number
	volume: number
}

/** symbol → { on: as-of day of the rejection, reason } */
export type PrefilterState = { rejected: Record<string, { on: string; reason: string }> }

export const batches = <T>(xs: T[], size = QUOTE_BATCH): T[][] => {
	const out: T[][] = []
	for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
	return out
}

/**
 * Fyers quotes response: { s:'ok', d:[{ n:'NSE:SBIN-EQ', s:'ok', v:{ lp, volume, … } }] }.
 * Entries with s !== 'ok' or non-numeric lp/volume are left out (→ treated as "no quote").
 */
export const parseQuotes = (resp: unknown): Map<string, Quote> => {
	const out = new Map<string, Quote>()
	const d = (resp as { d?: unknown[] })?.d
	if (!Array.isArray(d)) return out
	for (const row of d) {
		const r = row as { n?: string; s?: string; v?: { lp?: unknown; volume?: unknown } }
		if (!r?.n || r.s !== 'ok' || !r.v) continue
		const lp = Number(r.v.lp)
		const volume = Number(r.v.volume)
		if (Number.isFinite(lp) && Number.isFinite(volume)) out.set(r.n, { lp, volume })
	}
	return out
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
const cr = (r: number) => `₹${(r / 1e7).toFixed(1)} cr`

export interface PrefilterDecision {
	fetch: string[]
	skipped: Map<string, string>
	counts: { always: number; noQuote: number; quoteFail: number; recheckWait: number; recheckDue: number; pass: number }
}

export const decidePrefilter = (args: {
	universe: string[]
	quotes: Map<string, Quote>
	always: Set<string>
	state: PrefilterState
	today: string
	config: PrefilterConfig
}): PrefilterDecision => {
	const { config: c } = args
	const fetch: string[] = []
	const skipped = new Map<string, string>()
	const counts = { always: 0, noQuote: 0, quoteFail: 0, recheckWait: 0, recheckDue: 0, pass: 0 }
	for (const s of args.universe) {
		if (args.always.has(s)) {
			counts.always++
			fetch.push(s)
			continue
		}
		const q = args.quotes.get(s)
		if (!q) {
			counts.noQuote++
			fetch.push(s) // lenient: no quote is not evidence of illiquidity
			continue
		}
		if (q.lp < c.minPrice) {
			counts.quoteFail++
			skipped.set(s, `quote: price ₹${q.lp} < ₹${c.minPrice}`)
			continue
		}
		if (q.lp * q.volume < c.minTradedValueRupees) {
			counts.quoteFail++
			skipped.set(s, `quote: today's traded value ${cr(q.lp * q.volume)} < ${cr(c.minTradedValueRupees)}`)
			continue
		}
		const rej = args.state.rejected[s]
		if (rej) {
			const age = daysBetween(rej.on, args.today)
			if (age < c.recheckDays) {
				counts.recheckWait++
				skipped.set(s, `screen rejected on ${rej.on} (${rej.reason}); weekly recheck in ${c.recheckDays - age} day(s)`)
				continue
			}
			counts.recheckDue++
		} else counts.pass++
		fetch.push(s)
	}
	return { fetch, skipped, counts }
}

/** After the full screen: illiquid fetched names start (or keep) their 7-day wait; liquid ones are cleared. */
export const updatePrefilterState = (
	state: PrefilterState,
	asOf: string,
	screened: Record<string, { liquid: boolean; barOnAsOf: boolean; reasons: string[] }>,
): PrefilterState => {
	const rejected = { ...state.rejected }
	for (const [s, rec] of Object.entries(screened)) {
		if (rec.liquid) delete rejected[s]
		else if (rec.barOnAsOf) rejected[s] = { on: asOf, reason: rec.reasons[0] ?? 'illiquid' }
		// no bar on the as-of day: no verdict, leave as is
	}
	return { rejected }
}
