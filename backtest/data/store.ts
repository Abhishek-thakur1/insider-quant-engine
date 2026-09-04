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
			const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
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
