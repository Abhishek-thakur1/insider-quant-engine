// ============================================================
// screener/bhavcopy.ts — the daily watchlist from NSE's official bhavcopy (rules dw-3, pre-registered)
//
// docs/studies/daily-watchlist/PREREGISTRATION_dw3.md is the rule book. The data source is the NSE
// capital-market UDiFF common bhavcopy from NSE's published archive (one zip, one CSV). No Fyers call
// and no website scraping. The filters, measures and ranking are dw-2's (dailyWatchlist.ts): each
// Main Board EQ row becomes a DailyQuote and goes through the same rankRotating / validateList.
// Pure functions plus a runner whose download, writes and alerts are injected, so tests make no calls.
// ============================================================

import zlib from 'node:zlib'
import {
	CORE_SIZE,
	eligibilityFunnel,
	HISTORY_DIR,
	DAILY_FILE,
	rankRotating,
	RULES_VERSION,
	SYMBOL_RE,
	validateList,
	type DailyQuote,
	type DailyWatchlistFile,
} from './dailyWatchlist.js'

/** The archive URL for one trading day (YYYY-MM-DD, IST). */
export const bhavcopyUrl = (day: string): string =>
	`https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${day.replace(/-/g, '')}_F_0000.csv.zip`

/** The first entry of a zip (stored or deflate), located through the central directory (its sizes are reliable). */
export const unzipFirst = (buf: Buffer): { name: string; data: Buffer } => {
	let eocd = -1
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i
			break
		}
	}
	if (eocd < 0) throw new Error('not a zip (no end-of-central-directory record)')
	const cd = buf.readUInt32LE(eocd + 16)
	if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('zip central directory not found')
	const method = buf.readUInt16LE(cd + 10)
	const size = buf.readUInt32LE(cd + 20)
	const nameLen = buf.readUInt16LE(cd + 28)
	const local = buf.readUInt32LE(cd + 42)
	const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen)
	if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('zip local header not found')
	const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
	const raw = buf.subarray(start, start + size)
	if (raw.length !== size) throw new Error('zip entry truncated')
	if (method === 0) return { name, data: raw }
	if (method === 8) return { name, data: zlib.inflateRawSync(raw) }
	throw new Error(`zip compression method ${method} not supported`)
}

/** RFC 4180-style CSV: quoted fields may hold commas and doubled quotes. */
export const parseCsv = (text: string): string[][] => {
	const rows: string[][] = []
	let row: string[] = []
	let field = ''
	let quoted = false
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				field += '"'
				i++
			} else if (c === '"') quoted = false
			else field += c
		} else if (c === '"') quoted = true
		else if (c === ',') {
			row.push(field)
			field = ''
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++
			row.push(field)
			if (row.length > 1 || row[0] !== '') rows.push(row)
			row = []
			field = ''
		} else field += c
	}
	if (field !== '' || row.length) {
		row.push(field)
		rows.push(row)
	}
	return rows
}

export const BHAV_COLUMNS = ['TradDt', 'Sgmt', 'SctySrs', 'ISIN', 'TckrSymb', 'LastPric', 'PrvsClsgPric', 'HghPric', 'LwPric', 'TtlTradgVol'] as const

export interface Bhavcopy {
	rows: number
	tradeDates: Set<string>
	/** Main Board EQ (Sgmt CM, SctySrs EQ, INE ISIN), keyed by Fyers symbol; tt = the TradDt date stamp. */
	mainBoard: Map<string, DailyQuote>
	duplicates: string[]
}

/** The bhavcopy CSV → Main Board EQ quotes in the dw-2 shape. Throws if a needed column is missing. */
export const parseBhavcopy = (csv: string): Bhavcopy => {
	const [header, ...body] = parseCsv(csv)
	if (!header) throw new Error('empty bhavcopy')
	const col = Object.fromEntries(BHAV_COLUMNS.map((c) => [c, header.map((h) => h.trim()).indexOf(c)])) as Record<(typeof BHAV_COLUMNS)[number], number>
	const missing = BHAV_COLUMNS.filter((c) => col[c] < 0)
	if (missing.length) throw new Error(`bhavcopy columns missing: ${missing.join(', ')}`)
	const out: Bhavcopy = { rows: body.length, tradeDates: new Set(), mainBoard: new Map(), duplicates: [] }
	for (const r of body) {
		const get = (c: (typeof BHAV_COLUMNS)[number]) => (r[col[c]] ?? '').trim()
		out.tradeDates.add(get('TradDt'))
		if (get('Sgmt') !== 'CM' || get('SctySrs') !== 'EQ' || !get('ISIN').startsWith('INE')) continue
		const symbol = `NSE:${get('TckrSymb')}-EQ`
		const day = get('TradDt')
		const q: DailyQuote = {
			lp: Number(get('LastPric')),
			prevClose: Number(get('PrvsClsgPric')),
			high: Number(get('HghPric')),
			low: Number(get('LwPric')),
			volume: Number(get('TtlTradgVol')),
			tt: /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) / 1000 : NaN,
		}
		if (!Object.values(q).every(Number.isFinite)) continue
		if (out.mainBoard.has(symbol)) out.duplicates.push(symbol)
		else out.mainBoard.set(symbol, q)
	}
	return out
}

export type BhavScanResult =
	| { kind: 'written'; file: DailyWatchlistFile; text: string }
	| { kind: 'not-yet'; reason: string } // not published yet, or a network error: retried at the next half hour
	| { kind: 'failed'; reason: string } // a bad file: alerted at once, not retried that evening

export interface BhavScanDeps {
	asOf: string
	forSession: string
	nowMs: number
	core: string[]
	/** The Fyers NSE EQ symbol list (amendment 1): the image's fyersUniverse.json and the date it was last changed. */
	fyers: { file: string; asOf: string; symbols: Set<string> }
	/** The zip, or null when NSE hasn't published it yet (HTTP 404). Throws on other errors. */
	fetchZip: () => Promise<Buffer | null>
	writeFile: (name: string, content: string | Buffer) => void // atomic, relative to the data dir
	log?: Pick<Console, 'log' | 'warn'>
}

/** One attempt: download, parse, rank (dw-2 rules), validate, write. Never alerts; the caller decides. */
export const runBhavScan = async (d: BhavScanDeps): Promise<BhavScanResult> => {
	const log = d.log ?? console
	if (d.core.length !== CORE_SIZE || new Set(d.core).size !== CORE_SIZE || !d.core.every((s) => SYMBOL_RE.test(s)))
		return { kind: 'failed', reason: `core list must be ${CORE_SIZE} unique well-formed symbols` }
	let zip: Buffer | null
	try {
		zip = await d.fetchZip()
	} catch (err) {
		return { kind: 'not-yet', reason: `download: ${(err as Error)?.message ?? String(err)}` }
	}
	if (!zip) return { kind: 'not-yet', reason: `bhavcopy for ${d.asOf} not published yet` }

	let bhav: Bhavcopy
	let entry: string
	let z: { name: string; data: Buffer }
	try {
		z = unzipFirst(zip)
	} catch (err) {
		// Not a zip (an error or block page served as 200, a cut-off body): transient, retried.
		return { kind: 'not-yet', reason: `download was not a zip (${(err as Error).message}; ${zip.length} bytes)` }
	}
	try {
		entry = z.name
		bhav = parseBhavcopy(z.data.toString('utf8'))
	} catch (err) {
		return { kind: 'failed', reason: `bad file: ${(err as Error).message}` }
	}
	if (!bhav.tradeDates.has(d.asOf) || bhav.tradeDates.size !== 1)
		return { kind: 'failed', reason: `file trade date ${[...bhav.tradeDates].join('/')} ≠ as-of ${d.asOf}` }
	if (bhav.mainBoard.size < 1000) return { kind: 'failed', reason: `only ${bhav.mainBoard.size} Main Board EQ rows` }
	if (bhav.duplicates.length) return { kind: 'failed', reason: `${bhav.duplicates.length} duplicate symbol(s): ${bhav.duplicates.slice(0, 3).join(', ')}` }

	const funnel = eligibilityFunnel(bhav.mainBoard, d.core, d.asOf)
	const funnelText = `Main Board EQ ${funnel.quoted} → as-of day ${funnel.asOfDay} → price ${funnel.price} → turnover ${funnel.turnover} → eligible ${funnel.eligible}`
	log.log(`[DailyWatchlist] ${funnelText}`)
	const ranked = rankRotating(bhav.mainBoard, d.core, d.asOf)
	// Amendment 1/1a: rotating names must be in the Fyers symbol list (dropped, not replaced, if not found).
	// The core is the live watchlist the engine already subscribes to, so it is exempt (its format was checked above).
	const known = (s: string) => SYMBOL_RE.test(s) && d.fyers.symbols.has(s)
	const dropped = ranked.map((r) => r.symbol).filter((s) => !known(s))
	const core = d.core
	const rotating = ranked.filter((r) => known(r.symbol))
	const symbols = [...core, ...rotating.map((r) => r.symbol)]
	const fyersCheck = { file: d.fyers.file, asOf: d.fyers.asOf, symbols: d.fyers.symbols.size, dropped }
	log.log(`[DailyWatchlist] Fyers check (${d.fyers.file}, as of ${d.fyers.asOf}): dropped ${dropped.length}${dropped.length ? ` (${dropped.join(', ')})` : ''} → ${symbols.length} stocks`)
	const errs = validateList(symbols, { rotating: rotating.map((r) => r.symbol), universe: new Set(bhav.mainBoard.keys()) })
	if (errs.length) return { kind: 'failed', reason: `validation: ${errs.join('; ')}; Fyers check dropped ${dropped.length}: ${dropped.join(', ') || 'none'}; ${funnelText}` }

	const file: DailyWatchlistFile = {
		rulesVersion: RULES_VERSION,
		asOf: d.asOf,
		forSession: d.forSession,
		generatedAt: new Date(d.nowMs).toISOString(),
		requests: 0, // no Fyers requests: the source is the NSE bhavcopy
		source: `nse-bhavcopy ${entry}`,
		funnel,
		fyersCheck,
		symbols,
		entries: [...core.map((symbol) => ({ symbol, group: 'core' as const })), ...rotating],
	}
	const text = JSON.stringify(file, null, 1)
	// Live file first: the history copy is the "already written" mark, so it must never exist without it.
	d.writeFile(`bhavcopy/${d.asOf}.csv.zip`, zip)
	d.writeFile(DAILY_FILE, text)
	d.writeFile(`${HISTORY_DIR}/${d.forSession}.json`, text)
	log.log(`[DailyWatchlist] ✅ ${symbols.length} stocks + Nifty for ${d.forSession} (core ${core.length} + rotating ${rotating.length}; rules ${RULES_VERSION})`)
	return { kind: 'written', file, text }
}
