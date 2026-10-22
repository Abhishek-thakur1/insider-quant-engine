// ============================================================
// screener/candleStore.ts — on-disk daily candle cache (one file per symbol)
//
// Same Bar shape and file naming as backtest/data/store.ts, so the backtest can
// read the screener's cache directly. Writes are atomic (temp file + rename) so
// a crash mid-run never leaves a truncated file for the next run.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import type { DailyBar } from './indicators.js'

export const safeFileName = (symbol: string): string => symbol.replace(/[:\\/]/g, '_')

export class CandleStore {
	constructor(readonly dir: string) {}

	private file(symbol: string) {
		return path.join(this.dir, `${safeFileName(symbol)}.json`)
	}

	load(symbol: string): DailyBar[] {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file(symbol), 'utf8')) as { bars?: DailyBar[] }
			return Array.isArray(parsed.bars) ? parsed.bars : []
		} catch {
			return []
		}
	}

	/** Merge on timestamp (incoming wins — refreshes a partial bar), keep ascending. Returns bar count. */
	merge(symbol: string, incoming: DailyBar[]): number {
		const byTs = new Map<number, DailyBar>()
		for (const b of this.load(symbol)) byTs.set(b.t, b)
		for (const b of incoming) byTs.set(b.t, b)
		const bars = [...byTs.values()].sort((a, b) => a.t - b.t)
		fs.mkdirSync(this.dir, { recursive: true })
		const tmp = `${this.file(symbol)}.${process.pid}.tmp`
		fs.writeFileSync(tmp, JSON.stringify({ symbol, resolution: 'D', bars, fetchedAt: new Date().toISOString() }))
		fs.renameSync(tmp, this.file(symbol))
		return bars.length
	}
}
