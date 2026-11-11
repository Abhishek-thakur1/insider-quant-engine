// ============================================================
// backtest/bt6m/liveRun.ts — the per-day watchlist driver: replay sessions through the live pipeline
//
// For each session with a list in <BT6M_DIR>/lists/<session>.json (backtest/bt6m/rebuildLists.ts), loads that
// day's 1-minute bars of the list's symbols + Nifty from the backtest's own cache (<BT6M_DIR>/cache/res-1) and,
// read-only, the older harness cache (backtest/data/cache/res-1), and runs ./liveSession. Writes
// <BT6M_DIR>/runs/<label>/{signals,paper,ev_shadow}.jsonl and run.json. No network, no Fyers.
// Usage (PC): BACKTEST_MODE=true SHADOW_MODE=true CONFIRMATION_THRESHOLD=78 BT6M_DIR=C:/trade-data/backtest-6m \
//   npx tsx backtest/bt6m/liveRun.ts --label parity --from 2026-11-04 --to 2026-11-09
// ============================================================

import '../core/bootEnv.js'

import fs from 'node:fs'
import path from 'node:path'
import { NIFTY_SYMBOL } from '../config.js'
import { installVirtualClock, istEpoch } from '../core/clock.js'
import { installMemoryRedis } from '../core/memoryRedis.js'
import { barsInRange, safeFileName, type Bar } from '../data/store.js'
import { installMemoryPg } from './memoryPg.js'
import { runLiveSession } from './liveSession.js'

const DAY_MS = 86_400_000
export const LIVE_ENV = { SHADOW_MODE: 'true', CONFIRMATION_THRESHOLD: '78' } as const
/** Live defaults (src/config/env.ts); the server's .env sets neither (checked 10 Nov). */
export const LIVE_CAPITAL = { capitalBase: 100_000, capitalBehavior: 'REDUCE' } as const
/** Flags whose live value is their default (the server .env leaves them unset); asserted and recorded in run.json. */
export const LIVE_DEFAULTS = { TELEGRAM_MAX_ALERTS_PER_DAY: '20', VWAP_SESSION_GATE: 'true', SQUARE_OFF_TIMER: 'true', EV_SHADOW_ENABLED: 'true', NIFTY_DIAG_ENABLED: 'true', PAPER_CAPITAL_BASE: '100000', CAPITAL_CONSTRAINT_BEHAVIOR: 'REDUCE' } as const

export interface DayList { forSession: string; symbols: string[]; entries: { symbol: string; group: 'core' | 'rotating'; pick?: 'score' | 'turnover' }[] }

export const readSeriesFile = (file: string): Bar[] => {
	if (!fs.existsSync(file)) return []
	const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { bars?: Bar[] }
	return j.bars ?? []
}

/** Bars of one symbol from several cache dirs, merged by timestamp (the first dir wins on a duplicate minute). */
export const loadMerged = (symbol: string, dirs: string[]): Bar[] => {
	const byT = new Map<number, Bar>()
	for (const d of dirs) for (const b of readSeriesFile(path.join(d, `${safeFileName(symbol)}.json`))) if (!byT.has(b.t)) byT.set(b.t, b)
	return [...byT.values()].sort((a, b) => a.t - b.t)
}

const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : undefined
}

const main = async (): Promise<void> => {
	if (process.env.BACKTEST_MODE !== 'true') throw new Error('BACKTEST_MODE=true is required')
	for (const [k, v] of Object.entries(LIVE_ENV)) if (process.env[k] !== v) throw new Error(`${k} must be ${v} (live setting)`)
	// Live defaults that a stray local .env could change: must be unset (or the live value).
	for (const [k, ok] of Object.entries(LIVE_DEFAULTS)) if (process.env[k] !== undefined && process.env[k] !== ok) throw new Error(`${k}=${process.env[k]} differs from live (${ok})`)
	if (process.env.BACKTEST_RES && process.env.BACKTEST_RES !== '1') throw new Error('1-minute bars only')
	const dir = process.env.BT6M_DIR
	if (!dir) throw new Error('set BT6M_DIR')
	const label = arg('label') ?? 'run'
	const from = arg('from') ?? '0000'
	const to = arg('to') ?? '9999'
	const caches = [path.join(dir, 'cache', 'res-1'), path.resolve(process.cwd(), 'backtest', 'data', 'cache', 'res-1')]
	const lists: DayList[] = fs
		.readdirSync(path.join(dir, 'lists'))
		.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
		.map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'lists', f), 'utf8')) as DayList)
		.filter((l) => l.forSession >= from && l.forSession <= to)
		.sort((a, b) => a.forSession.localeCompare(b.forSession))
	if (!lists.length) throw new Error('no lists in range')

	// Load each symbol once, keeping only the sessions it is needed for.
	const need = new Map<string, Set<string>>()
	for (const l of lists) for (const s of [...l.symbols, NIFTY_SYMBOL]) (need.get(s) ?? need.set(s, new Set()).get(s)!).add(l.forSession)
	const bars = new Map<string, Map<string, Bar[]>>() // symbol → session → bars
	for (const [s, days] of need) {
		const all = loadMerged(s, caches)
		const m = new Map<string, Bar[]>()
		for (const d of days) {
			const slice = barsInRange(all, istEpoch(d, 0), istEpoch(d, 0) + DAY_MS)
			if (slice.length) m.set(d, slice)
		}
		bars.set(s, m)
	}

	const out = path.join(dir, 'runs', label)
	fs.mkdirSync(out, { recursive: true })
	const w = (f: string) => fs.createWriteStream(path.join(out, f), { flags: 'w' })
	const sigOut = w('signals.jsonl')
	const paperOut = w('paper.jsonl')
	const evOut = w('ev_shadow.jsonl')
	const { uninstall: unRedis } = installMemoryRedis()
	const { store: paper, uninstall: unPg } = installMemoryPg()
	const unClock = installVirtualClock(istEpoch(lists[0]!.forSession, 9 * 60))
	const sessions: Record<string, unknown>[] = []
	const log = console.log
	try {
		for (const l of lists) {
			const day = l.forSession
			const bySym = new Map<string, Bar[]>()
			for (const s of [...l.symbols, NIFTY_SYMBOL]) {
				const b = bars.get(s)?.get(day)
				if (b) bySym.set(s, b)
			}
			if (!bySym.has(NIFTY_SYMBOL)) {
				sessions.push({ session: day, skipped: 'no Nifty bars' })
				continue
			}
			console.log = () => {} // detector/pipeline chatter; the outcome is in the rows
			const r = await runLiveSession({ sessionDate: day, barsBySymbol: bySym, entries: l.entries, paper, config: LIVE_CAPITAL })
			console.log = log
			for (const x of r.signals) sigOut.write(JSON.stringify(x) + '\n')
			for (const x of r.paper) paperOut.write(JSON.stringify({ session: day, ...x }) + '\n')
			for (const x of r.evShadow) evOut.write(JSON.stringify({ session: day, ...x }) + '\n')
			const s = { session: day, signals: r.signals.length, paper: r.paper.length, evShadow: r.evShadow.length, channelMessages: r.channelMessages, stillOpenAtEnd: r.stillOpenAtEnd, missingSymbols: r.missingSymbols.length, errors: r.errors.slice(0, 5), errorCount: r.errors.length, bars: r.barsReplayed }
			sessions.push(s)
			log(JSON.stringify(s))
		}
	} finally {
		console.log = log
		unClock()
		unPg()
		unRedis()
		for (const s of [sigOut, paperOut, evOut]) s.end()
	}
	fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({ label, from, to, sessions, unknownSql: paper.unknown, env: LIVE_ENV, liveDefaults: LIVE_DEFAULTS, capital: LIVE_CAPITAL }, null, 1))
	if (paper.unknown.length) throw new Error(`unexpected SQL: ${paper.unknown.length} statement(s), see run.json`)
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('backtest/bt6m/liveRun.ts')) main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
