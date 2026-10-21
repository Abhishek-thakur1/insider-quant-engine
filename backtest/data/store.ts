// ============================================================
// backtest/data/store.ts — isolated on-disk candle cache
//
// Deliberately NOT Redis. The goal doc requires the backtest's data to live in
// a store that "can never read or write live engine state"; a plain directory
// under backtest/data/cache satisfies that unconditionally, survives restarts
// (so a partially-completed overnight fetch resumes), and is inspectable.
//
// One file per symbol per resolution. Bars are stored sorted ascending by
// timestamp with duplicates removed, so the replay engine can rely on
// ordering without re-sorting 3M bars.
// ============================================================

import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../config.js'

/** One OHLCV bar. `t` is epoch MILLISECONDS (Fyers returns seconds; we convert on ingest). */
export interface Bar {
	t: number
	o: number
	h: number
	l: number
	c: number
	v: number
}

export interface SymbolSeries {
	symbol: string
	resolution: string
	bars: Bar[]
	/** When this file was last written, for cache-freshness decisions. */
	fetchedAt: string
}

// 'NSE:RELIANCE-EQ' → 'NSE_RELIANCE-EQ'. Colons are illegal in Windows paths.
export const safeFileName = (symbol: string): string => symbol.replace(/[:\\/]/g, '_')

const seriesPath = (symbol: string, resolution: string): string =>
	path.join(DATA_DIR, `res-${resolution}`, `${safeFileName(symbol)}.json`)

export const ensureDirs = (): void => {
	fs.mkdirSync(DATA_DIR, { recursive: true })
}

export const hasSeries = (symbol: string, resolution: string): boolean =>
	fs.existsSync(seriesPath(symbol, resolution))

export const loadSeries = (symbol: string, resolution: string): SymbolSeries | null => {
	const p = seriesPath(symbol, resolution)
	if (!fs.existsSync(p)) return null
	try {
		return JSON.parse(fs.readFileSync(p, 'utf8')) as SymbolSeries
	} catch (err) {
		console.warn(`[store] corrupt cache file, ignoring: ${p}`, err)
		return null
	}
}

/**
 * Merge new bars into whatever is cached, de-duplicating on timestamp and
 * keeping ascending order. Merging (rather than overwriting) is what makes a
 * chunked fetch resumable.
 */
export const saveSeries = (symbol: string, resolution: string, incoming: Bar[]): number => {
	const p = seriesPath(symbol, resolution)
	fs.mkdirSync(path.dirname(p), { recursive: true })

	const existing = loadSeries(symbol, resolution)?.bars ?? []
	const byTs = new Map<number, Bar>()
	for (const b of existing) byTs.set(b.t, b)
	for (const b of incoming) byTs.set(b.t, b) // incoming wins on conflict

	const bars = [...byTs.values()].sort((a, b) => a.t - b.t)
	const payload: SymbolSeries = {
		symbol,
		resolution,
		bars,
		fetchedAt: new Date().toISOString(),
	}
	fs.writeFileSync(p, JSON.stringify(payload))
	return bars.length
}

// ── Coverage: which time ranges have been fetched successfully ──────────────
// Lets a resumed fetch skip exactly what it already has, even though chunk edges
// move with the clock between runs and pre-listing ranges legitimately return no
// bars. Stored next to the series as <file>.coverage.json, as a merged union.
const coveragePath = (symbol: string, resolution: string): string =>
	path.join(DATA_DIR, `res-${resolution}`, `${safeFileName(symbol)}.coverage.json`)

export const loadCoverage = (symbol: string, resolution: string): Array<[number, number]> => {
	try {
		return JSON.parse(fs.readFileSync(coveragePath(symbol, resolution), 'utf8')) as Array<[number, number]>
	} catch {
		return []
	}
}

/** Union of ranges (overlapping or touching ranges merged), ascending. */
export const mergeRanges = (ranges: Array<[number, number]>): Array<[number, number]> => {
	const sorted = ranges.slice().sort((a, b) => a[0] - b[0])
	const out: Array<[number, number]> = []
	for (const r of sorted) {
		const last = out[out.length - 1]
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
		else out.push([r[0], r[1]])
	}
	return out
}

export const addCoverage = (symbol: string, resolution: string, fromMs: number, toMs: number): void => {
	const p = coveragePath(symbol, resolution)
	fs.mkdirSync(path.dirname(p), { recursive: true })
	fs.writeFileSync(p, JSON.stringify(mergeRanges([...loadCoverage(symbol, resolution), [fromMs, toMs]])))
}

export const isCovered = (coverage: Array<[number, number]>, fromMs: number, toMs: number): boolean =>
	coverage.some(([a, b]) => a <= fromMs && b >= toMs)

/** Bars whose timestamp falls in [fromMs, toMs). */
export const barsInRange = (bars: Bar[], fromMs: number, toMs: number): Bar[] => {
	// Bars are sorted, so bound the scan with a binary search on the lower edge.
	let lo = 0
	let hi = bars.length
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if (bars[mid]!.t < fromMs) lo = mid + 1
		else hi = mid
	}
	const out: Bar[] = []
	for (let i = lo; i < bars.length && bars[i]!.t < toMs; i++) out.push(bars[i]!)
	return out
}

export const cacheReport = (): { resolution: string; symbols: number; bars: number }[] => {
	if (!fs.existsSync(DATA_DIR)) return []
	return fs
		.readdirSync(DATA_DIR)
		.filter((d) => d.startsWith('res-'))
		.map((d) => {
			const dir = path.join(DATA_DIR, d)
			const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.coverage.json'))
			let bars = 0
			for (const f of files) {
				try {
					bars += (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SymbolSeries).bars
						.length
				} catch {
					/* skip corrupt */
				}
			}
			return { resolution: d.replace('res-', ''), symbols: files.length, bars }
		})
}

// ── Derived resolutions ──────────────────────────────────────────────────────
const IST_OFFSET_MS = 5.5 * 3600 * 1000
const SESSION_OPEN_MIN = 9 * 60 + 15

/**
 * Aggregate 1-minute bars into N-minute bars aligned to the NSE session
 * (09:15, 09:20, … IST): open = first open, high = max, low = min, close =
 * last close, volume = sum, t = bucket start. Exact — no interpolation — so
 * 5-minute bars derived from the cached 1-minute history cost zero API calls.
 */
export const aggregateBars = (bars: Bar[], minutes: number): Bar[] => {
	const out: Bar[] = []
	let cur: Bar | null = null
	let curKey = NaN
	for (const b of bars) {
		const ist = b.t + IST_OFFSET_MS
		const dayStart = ist - (ist % 86_400_000)
		const minOfDay = Math.floor((ist - dayStart) / 60_000)
		const bucket = Math.floor((minOfDay - SESSION_OPEN_MIN) / minutes)
		const key = dayStart + bucket
		if (key !== curKey) {
			if (cur) out.push(cur)
			curKey = key
			const startMin = SESSION_OPEN_MIN + bucket * minutes
			cur = { t: dayStart - IST_OFFSET_MS + startMin * 60_000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }
		} else {
			cur!.h = Math.max(cur!.h, b.h)
			cur!.l = Math.min(cur!.l, b.l)
			cur!.c = b.c
			cur!.v += b.v
		}
	}
	if (cur) out.push(cur)
	return out
}

/** Write res-<to> series for every res-<from> series in the cache. Returns per-symbol bar counts. */
export const deriveResolution = (from: string, to: string, minutes: number): { symbol: string; bars: number }[] => {
	const dir = path.join(DATA_DIR, `res-${from}`)
	if (!fs.existsSync(dir)) return []
	const out: { symbol: string; bars: number }[] = []
	for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.endsWith('.coverage.json'))) {
		const src = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SymbolSeries
		const agg = aggregateBars(src.bars, minutes)
		const p = seriesPath(src.symbol, to)
		fs.mkdirSync(path.dirname(p), { recursive: true })
		fs.writeFileSync(p, JSON.stringify({ symbol: src.symbol, resolution: to, bars: agg, fetchedAt: src.fetchedAt, derivedFrom: `res-${from}` }))
		const cov = loadCoverage(src.symbol, from)
		if (cov.length) fs.writeFileSync(coveragePath(src.symbol, to), JSON.stringify(cov))
		out.push({ symbol: src.symbol, bars: agg.length })
	}
	return out
}
