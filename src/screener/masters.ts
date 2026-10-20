// ============================================================
// screener/masters.ts — universe + F&O flags from the public Fyers symbol masters
//
// NSE_CM.csv → the -EQ cash universe with INE ISINs (same rule as
// universeBuilder.ts: excludes ETFs/MFs, and BE/BZ series incl. trade-for-trade).
// NSE_FO.csv → underlyings that have futures = the F&O list (fno flag).
// Parsing is field-pattern based, not column-index based, so a name containing
// a comma can't shift the columns we read.
// ============================================================

export const CM_URL = 'https://public.fyers.in/sym_details/NSE_CM.csv'
export const FO_URL = 'https://public.fyers.in/sym_details/NSE_FO.csv'

export const parseCashUniverse = (csv: string): string[] => {
	const out = new Set<string>()
	for (const line of csv.split(/\r?\n/)) {
		const fields = line.split(',')
		const sym = fields.find((f) => /^NSE:[A-Z0-9&_.-]+-EQ$/.test(f))
		const isin = fields.find((f) => /^IN[A-Z0-9]{10}$/.test(f))
		if (sym && isin?.startsWith('INE')) out.add(sym)
	}
	return [...out].sort()
}

/** Underlyings with a FUT contract, mapped to their cash symbol NSE:<U>-EQ. Indices drop out naturally. */
export const parseFnoCashSymbols = (csv: string): Set<string> => {
	const out = new Set<string>()
	for (const line of csv.split(/\r?\n/)) {
		const fields = line.split(',')
		const fut = fields.find((f) => /^NSE:[A-Z0-9&_.-]+FUT$/.test(f))
		if (!fut) continue
		// NSE:<UNDERLYING><YY><MON>FUT, e.g. NSE:RELIANCE26OCTFUT
		const m = fut.match(/^NSE:([A-Z0-9&_.-]+?)\d{2}[A-Z]{3}FUT$/)
		if (m) out.add(`NSE:${m[1]}-EQ`)
	}
	return out
}
