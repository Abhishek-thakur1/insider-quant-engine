// ============================================================
// core/subscriptionPlan.ts — what the data socket subscribes to (pure)
//
// Fyers' Data Socket limit is per user, across all connections: Standard 100
// symbols, Prime 5,000 (websocket overview, page updated 2026-10-14). The
// engine subscribed the whole 2,158-name fyersUniverse.json; from Oct 16 only
// the Nifty index streamed (index names are mapped inside the SDK) and no
// equity or option tick arrived, with no error frame.
//
// The socket now carries only what the engine evaluates:
//   watchlist (screener, cap 60, core included)
//   + bench (Layer B scan set: next-ranked names, cap 30)
//   + Nifty index
//   + Nifty option strikes (0 until the expiry fix — NIFTY_OPTIONS_ENABLED)
// Anomaly promotions move a bench name into the active universe; they never
// add a subscription. Above the cap the engine refuses to boot (exit 0, so
// Docker does not restart-loop) — an over-cap subscribe fails silently.
// ============================================================

export const DEFAULT_SUBSCRIPTION_CAP = 100 // Fyers Standard

export interface SubscriptionPlan {
	symbols: string[] // equities + index, deduplicated, in subscribe order
	watchlist: number
	bench: number
	index: number
	options: number // reserved for option strikes (subscribed later, on the first Nifty tick)
	total: number
	cap: number
	overCap: boolean
}

export const planSubscription = (o: {
	watchlist: string[]
	bench: string[]
	indexSymbol: string
	optionStrikes: number
	cap: number
}): SubscriptionPlan => {
	const seen = new Set<string>()
	const take = (list: string[]): string[] => list.filter((s) => !seen.has(s) && !!seen.add(s))
	const watchlist = take(o.watchlist)
	const bench = take(o.bench)
	const index = take([o.indexSymbol])
	const symbols = [...watchlist, ...bench, ...index]
	const total = symbols.length + o.optionStrikes
	return {
		symbols,
		watchlist: watchlist.length,
		bench: bench.length,
		index: index.length,
		options: o.optionStrikes,
		total,
		cap: o.cap,
		overCap: total > o.cap,
	}
}

export const describePlan = (p: SubscriptionPlan): string =>
	`${p.total}/${p.cap} symbols — watchlist ${p.watchlist} + bench ${p.bench} + index ${p.index} + options ${p.options}`

/** SUBSCRIPTION_CAP from the environment; invalid or missing → the Standard limit. */
export const subscriptionCapFromEnv = (raw: string | undefined): number => {
	const n = Number(raw)
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_SUBSCRIPTION_CAP
}
