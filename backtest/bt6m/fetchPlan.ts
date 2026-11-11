// ============================================================
// backtest/bt6m/fetchPlan.ts — the fixed request manifest for the 6-month backtest (no network)
//
// PREREGISTRATION.md §5. From the rebuilt lists, each symbol's listed sessions (+ Nifty on every session) are
// cut into Fyers 1-minute windows of at most 100 calendar days; sessions already in the old harness cache
// (bars on that day) are skipped. Stage A = sessions 2026-11-04 … 2026-11-09 (the parity sessions); Stage B = the
// rest. The manifest is written once and the fetcher (./fetchRun.ts) refuses anything not in it.
// Usage: BT6M_DIR=C:/trade-data/backtest-6m npx tsx backtest/bt6m/fetchPlan.ts --stage A --cap 159
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { NIFTY_SYMBOL } from '../config.js'
import { istDateStringOf } from '../core/clock.js'
import { safeFileName } from '../data/store.js'
import { readSeriesFile } from './liveRun.js'

export const MAX_WINDOW_DAYS = 100 // Fyers: "Up to 100 days of data per request" for minute resolutions
export const STAGE_A = { from: '2026-11-04', to: '2026-11-09' } as const

export interface ManifestItem { n: number; symbol: string; from: string; to: string; sessions: number }
export interface Manifest { stage: 'A' | 'B'; createdAt: string; resolution: '1'; cap: number; items: ManifestItem[] }

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`)

/** Cut sorted session days into windows whose span (first..last) is < MAX_WINDOW_DAYS calendar days. */
export const windowsOf = (days: string[]): { from: string; to: string; sessions: number }[] => {
	const out: { from: string; to: string; sessions: number }[] = []
	for (const d of [...new Set(days)].sort()) {
		const w = out[out.length - 1]
		if (w && (dayMs(d) - dayMs(w.from)) / 86_400_000 < MAX_WINDOW_DAYS) {
			w.to = d
			w.sessions++
		} else out.push({ from: d, to: d, sessions: 1 })
	}
	return out
}

export const buildManifest = (
	need: Map<string, string[]>,
	cachedDays: (symbol: string) => Set<string>,
	stage: 'A' | 'B',
	cap: number,
	createdAt: string,
): Manifest => {
	const inStage = (d: string) => (stage === 'A' ? d >= STAGE_A.from && d <= STAGE_A.to : d < STAGE_A.from)
	const items: ManifestItem[] = []
	for (const [symbol, days] of [...need].sort(([a], [b]) => a.localeCompare(b))) {
		const have = cachedDays(symbol)
		for (const w of windowsOf(days.filter((d) => inStage(d) && !have.has(d)))) items.push({ n: items.length + 1, symbol, ...w })
	}
	if (items.length > cap) throw new Error(`manifest has ${items.length} requests, over the cap of ${cap}: not written`)
	return { stage, createdAt, resolution: '1', cap, items }
}

const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : undefined
}

const main = (): void => {
	const dir = process.env.BT6M_DIR
	if (!dir) throw new Error('set BT6M_DIR')
	const stage = arg('stage')
	const cap = Number(arg('cap'))
	if (stage !== 'A' && stage !== 'B') throw new Error('--stage A|B')
	if (!Number.isInteger(cap) || cap <= 0) throw new Error('--cap <n> is required')
	const file = path.join(dir, `manifest_${stage}.json`)
	if (fs.existsSync(file)) throw new Error(`${file} exists — a manifest is fixed once written`)
	const need = new Map<string, string[]>()
	for (const f of fs.readdirSync(path.join(dir, 'lists')).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
		const l = JSON.parse(fs.readFileSync(path.join(dir, 'lists', f), 'utf8')) as { forSession: string; symbols: string[] }
		for (const s of [...l.symbols, NIFTY_SYMBOL]) (need.get(s) ?? need.set(s, []).get(s)!).push(l.forSession)
	}
	const oldCache = path.resolve(process.cwd(), 'backtest', 'data', 'cache', 'res-1')
	const cachedDays = (s: string) => new Set(readSeriesFile(path.join(oldCache, `${safeFileName(s)}.json`)).map((b) => istDateStringOf(b.t)))
	const m = buildManifest(need, cachedDays, stage, cap, new Date().toISOString())
	fs.writeFileSync(file, JSON.stringify(m, null, 1))
	console.log(JSON.stringify({ stage, requests: m.items.length, symbols: new Set(m.items.map((i) => i.symbol)).size, cap, file }))
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('backtest/bt6m/fetchPlan.ts')) main()
