// ============================================================
// backtest/bt6m/fetchRun.ts — the capped Fyers fetch for the 6-month backtest (PC only)
//
// PREREGISTRATION.md §5; owner decisions of 10 Nov: Stage A on Mon 16 Nov, 16:15–17:00 IST only, at most 159
// requests; Stage B blocked until the owner has seen the parity result. Guarantees, each tested:
//   - only requests listed in the fixed manifest (<BT6M_DIR>/manifest_<stage>.json), in order, resumable;
//   - a hard cap (BT6M_MAX_REQUESTS, required, and never above the manifest's own cap) on requests SENT;
//   - only inside the time window (default 16:15 ≤ IST < 17:00 on BT6M_WINDOW_DATE, required); stops at its end;
//   - pacing and the shared ledger through the live quota gate (src/fyers/quota.ts; 4/s, 40/min, the `backtest`
//     allocation), with maxBreachesPerDay = 1 and no retries: the first throttle (429 / -429 / 1015) stops the run;
//   - stop on any auth error; a request that fails otherwise is retried once, then the run stops;
//   - the token and app id are read from files and never printed, logged or echoed (errors are logged by code and
//     a fixed text only).
// Writes <BT6M_DIR>/cache/res-1/<symbol>.json (the harness store format), fetch_progress.json and fetch.log.
// ============================================================

import '../core/bootEnv.js'

import fs from 'node:fs'
import path from 'node:path'
import fyers from 'fyers-api-v3'
import { createQuotaGate, FileLedger, loadQuotaConfig, QuotaStopError, type QuotaConfig, type QuotaLedger } from '../../src/fyers/quota.js'
import { safeFileName, type Bar } from '../data/store.js'
import type { Manifest, ManifestItem } from './fetchPlan.js'
import { readSeriesFile } from './liveRun.js'

export type HistoryRequest = { symbol: string; resolution: string; date_format: string; range_from: string; range_to: string; cont_flag: string }
export type HistoryFn = (req: HistoryRequest) => Promise<{ s: string; candles?: unknown[][]; code?: number; message?: string }>

export class StopRun extends Error {}

const AUTH_CODES = [-8, -15, -16, -17]
export const isAuthFailure = (e: unknown): boolean => {
	const x = e as { code?: number; status?: number; message?: string } | null
	if (!x || typeof x !== 'object') return false
	if (x.code !== undefined && AUTH_CODES.includes(Number(x.code))) return true
	if (x.status === 401) return true
	return /token.{0,20}(expired|invalid)|invalid.{0,20}token|could not authenticate|unauthori[sz]ed/i.test(String(x.message ?? ''))
}
/** A loggable description of an error that can't contain a credential: the code and a fixed category only. */
export const safeErr = (e: unknown): string => {
	const x = e as { code?: number; s?: string } | null
	return `code=${x && typeof x === 'object' && x.code !== undefined ? Number(x.code) : 'n/a'}${isAuthFailure(e) ? ' (auth)' : ''}`
}

export const istParts = (ms: number): { date: string; minutes: number } => {
	const d = new Date(ms + 5.5 * 3600 * 1000)
	return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() }
}

export interface FetchOptions {
	manifest: Manifest
	maxRequests: number
	window: { date: string; fromMin: number; toMin: number }
	history: HistoryFn
	ledger: QuotaLedger
	quota: QuotaConfig
	done: Set<number>
	onBars: (item: ManifestItem, bars: Bar[]) => void
	onDone: (item: ManifestItem) => void
	log: (line: string) => void
	now?: () => number
	sleep?: (ms: number) => Promise<void>
}

export const toBars = (candles: unknown[][]): Bar[] =>
	candles.map((c) => ({ t: (c[0] as number) * 1000, o: c[1] as number, h: c[2] as number, l: c[3] as number, c: c[4] as number, v: c[5] as number }))

/** Runs the manifest under every guard; returns how many requests were sent and why it stopped. */
export const runFetch = async (o: FetchOptions): Promise<{ sent: number; completed: number; stopped: string }> => {
	const now = o.now ?? Date.now
	if (!(o.maxRequests > 0) || o.maxRequests > o.manifest.cap) throw new StopRun(`max requests ${o.maxRequests} must be 1..${o.manifest.cap} (the manifest cap)`)
	const inWindow = () => {
		const p = istParts(now())
		return p.date === o.window.date && p.minutes >= o.window.fromMin && p.minutes < o.window.toMin
	}
	if (!inWindow()) throw new StopRun(`outside the approved window (${o.window.date} ${o.window.fromMin}–${o.window.toMin} min IST): nothing sent`)
	// Strictest settings: one throttle stops the day's run, no automatic retry inside the gate.
	const gate = createQuotaGate({
		job: 'backtest',
		config: { ...o.quota, maxBreachesPerDay: 1, maxRetries: 0 },
		ledger: o.ledger,
		clock: { now, sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))) },
		log: { warn: () => {}, error: () => {} },
	})
	let sent = 0
	let completed = 0
	for (const item of o.manifest.items) {
		if (o.done.has(item.n)) continue
		for (let attempt = 1; ; attempt++) {
			if (sent >= o.maxRequests) return { sent, completed, stopped: `hard cap of ${o.maxRequests} requests reached` }
			if (!inWindow()) return { sent, completed, stopped: 'approved window ended' }
			try {
				const res = await gate.call(async () => {
					sent++
					return o.history({ symbol: item.symbol, resolution: o.manifest.resolution, date_format: '1', range_from: item.from, range_to: item.to, cont_flag: '1' })
				})
				if (res.s !== 'ok' && res.s !== 'no_data') throw res
				const bars = res.s === 'ok' && res.candles ? toBars(res.candles) : []
				o.onBars(item, bars)
				o.onDone(item)
				completed++
				o.log(`#${item.n} ${item.symbol} ${item.from}..${item.to} ok bars=${bars.length}`)
				break
			} catch (err) {
				if (isAuthFailure(err)) return { sent, completed, stopped: `auth error on #${item.n} (${safeErr(err)}): stopped` }
				if (err instanceof QuotaStopError) return { sent, completed, stopped: `quota gate stop on #${item.n}: ${err.constructor.name}` }
				const throttle = /429|1015|-360|rate|limit/i.test(String((err as { message?: string })?.message ?? '')) || [429, -429, -360].includes(Number((err as { code?: number })?.code))
				if (throttle) return { sent, completed, stopped: `throttled on #${item.n} (${safeErr(err)}): stopped` }
				o.log(`#${item.n} ${item.symbol} failed attempt ${attempt} (${safeErr(err)})`)
				if (attempt >= 2) return { sent, completed, stopped: `#${item.n} failed twice: stopped` }
			}
		}
	}
	return { sent, completed, stopped: 'manifest complete' }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const mergeSave = (file: string, symbol: string, incoming: Bar[]): void => {
	const byT = new Map<number, Bar>()
	for (const b of readSeriesFile(file)) byT.set(b.t, b)
	for (const b of incoming) byT.set(b.t, b)
	const bars = [...byT.values()].sort((a, b) => a.t - b.t)
	const tmp = `${file}.tmp`
	fs.writeFileSync(tmp, JSON.stringify({ symbol, resolution: '1', bars, fetchedAt: new Date().toISOString() }))
	fs.renameSync(tmp, file)
}

const main = async (): Promise<void> => {
	const dir = process.env.BT6M_DIR
	const stage = process.env.BT6M_STAGE
	const max = Number(process.env.BT6M_MAX_REQUESTS)
	const date = process.env.BT6M_WINDOW_DATE
	const tokenFile = process.env.BT6M_TOKEN_FILE
	const appIdFile = process.env.BT6M_APP_ID_FILE
	if (!dir || (stage !== 'A' && stage !== 'B') || !date || !tokenFile || !appIdFile) throw new Error('set BT6M_DIR, BT6M_STAGE, BT6M_MAX_REQUESTS, BT6M_WINDOW_DATE, BT6M_TOKEN_FILE, BT6M_APP_ID_FILE')
	if (stage === 'B' && process.env.BT6M_STAGE_B_APPROVED !== 'yes') throw new Error('Stage B is blocked until the owner approves it after the parity result')
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, `manifest_${stage}.json`), 'utf8')) as Manifest
	const progressFile = path.join(dir, `fetch_progress_${stage}.json`)
	const done = new Set<number>(fs.existsSync(progressFile) ? (JSON.parse(fs.readFileSync(progressFile, 'utf8')) as number[]) : [])
	const cacheDir = path.join(dir, 'cache', 'res-1')
	fs.mkdirSync(cacheDir, { recursive: true })
	const logFile = path.join(dir, 'logs', `fetch_${stage}.log`)
	fs.mkdirSync(path.dirname(logFile), { recursive: true })
	const log = (line: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)

	const api = new fyers.fyersModel({ path: path.join(dir, 'logs'), enableLogging: false })
	api.setAppId(fs.readFileSync(appIdFile, 'utf8').trim())
	api.setAccessToken(fs.readFileSync(tokenFile, 'utf8').trim())

	const r = await runFetch({
		manifest,
		maxRequests: max,
		window: { date, fromMin: 16 * 60 + 15, toMin: 17 * 60 },
		history: (req) => api.getHistory(req),
		ledger: new FileLedger(path.join(dir, 'quota-ledger.json')),
		quota: loadQuotaConfig(),
		done,
		onBars: (item, bars) => mergeSave(path.join(cacheDir, `${safeFileName(item.symbol)}.json`), item.symbol, bars),
		onDone: (item) => {
			done.add(item.n)
			fs.writeFileSync(progressFile, JSON.stringify([...done].sort((a, b) => a - b)))
		},
		log,
	})
	log(`STOP sent=${r.sent} completed=${r.completed} reason=${r.stopped}`)
	console.log(JSON.stringify({ stage, ...r, remaining: manifest.items.length - done.size }))
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('backtest/bt6m/fetchRun.ts'))
	main().then(() => process.exit(0), (e) => { console.error(e instanceof StopRun || e instanceof Error ? e.message : 'failed'); process.exit(1) })
