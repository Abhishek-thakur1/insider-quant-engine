// ============================================================
// scripts/fetch_replay.ts — the liquid-replay fetch (backtest/fetchReplay.ts) on EC2
//
// DRY RUN BY DEFAULT: prints the plan, the exact request count and the preflight
// verdict, and makes ZERO Fyers calls. A live run needs BOTH:
//   --live                   and
//   --owner-ok YYYY-MM-DD    equal to today (IST): the owner's OK for THIS evening.
// Preflight refuses outside 15:45–16:15 IST, on any breach in today's ledger, on an
// exhausted day, during a cooldown, or with no requests left. The cap is per EVENING:
// min(1,000 − backtest requests already in today's ledger, allocation left). Mid-run,
// every request re-checks the live ledger (any breach, exhausted, cap by ledger count,
// IST day change, 16:25 window end); the FIRST throttle ends the run (no retries); an
// auth error or 3 consecutive failures end it. All through the Redis ledger, job 'backtest'.
//
// Steps, in order (run in the screener image with the screener_data volume):
//   --step nifty    1 request: Nifty 1-minute, 2026-10-15 → 2026-10-22
//   --step quotes   ~45 requests (50 symbols each): fetch-day quotes for the NSE_CM master,
//                   → <data>/replay/daily-candidates.json (screener pre-filter; LOOK-AHEAD)
//   --step daily    daily history for the candidates into the SCREENER's cache
//                   (<data>/candles/D, its cold-start ranges: up to 2 requests a symbol)
//   --step liquid   0 requests: rank the cache → <data>/replay/liquid15cr.json
//   --step minute   1 request a symbol: 1-minute Oct 15–22 for the liquid list, most liquid first
//
//   docker compose run --rm --no-deps quant_screener node --import tsx scripts/fetch_replay.ts --step nifty
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import fyers from 'fyers-api-v3'
import {
	NIFTY_SYMBOL,
	REPLAY_FROM,
	REPLAY_TO,
	buildLiquidList,
	coversReplaySessions,
	dailyCandidates,
	MinuteStore,
	midRunStop,
	preflight,
	replayGateConfig,
	runFetch,
	type Bar,
	type FetchTask,
	type RunDeps,
} from '../backtest/fetchReplay.js'
import { CandleStore } from '../src/screener/candleStore.js'
import { plannedRanges } from '../src/screener/fetchDaily.js'
import { CM_URL, parseCashUniverse } from '../src/screener/masters.js'
import { batches, parseQuotes, QUOTE_BATCH } from '../src/screener/prefilter.js'
import { screenerDataDir } from '../src/screener/paths.js'
import { RedisLedger, createQuotaGate, loadQuotaConfig } from '../src/fyers/quota.js'
import { getISTDateString } from '../src/utils/marketHours.js'

type History = { s: string; candles?: number[][]; message?: string }

const arg = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const step = arg('step')
const live = process.argv.includes('--live')
const dataDir = screenerDataDir()
const dailyStore = new CandleStore(path.join(dataDir, 'candles', 'D'))
const minuteStore = new MinuteStore(path.join(dataDir, 'candles', '1'))
const replayDir = path.join(dataDir, 'replay')
const LIQUID_FILE = path.join(replayDir, 'liquid15cr.json')
const CANDIDATES_FILE = path.join(replayDir, 'daily-candidates.json')
const toBars = (c: number[][]): Bar[] => c.map((x) => ({ t: x[0]! * 1000, o: x[1]!, h: x[2]!, l: x[3]!, c: x[4]!, v: x[5]! }))
const writeJson = (file: string, v: unknown) => {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify(v, null, 1))
}

const buildLiquid = (): number => {
	const files = fs.existsSync(dailyStore.dir) ? fs.readdirSync(dailyStore.dir).filter((f) => f.endsWith('.json')) : []
	const m = new Map<string, Bar[]>()
	for (const f of files) {
		const j = JSON.parse(fs.readFileSync(path.join(dailyStore.dir, f), 'utf8')) as { symbol?: string; bars?: Bar[] }
		if (j.symbol && Array.isArray(j.bars)) m.set(j.symbol, j.bars)
	}
	const list = buildLiquidList(m)
	writeJson(LIQUID_FILE, { builtAt: new Date().toISOString(), dailyFiles: files.length, ...list })
	console.log(`[fetch-replay] liquid list: ${list.liquid.length} symbols > ₹${list.minTurnoverCr} cr (as of ${list.asOf}); ${list.insufficientHistory.length} with < ${list.lookback} sessions; from ${files.length} daily files → ${LIQUID_FILE}`)
	return 0
}

const main = async (): Promise<number> => {
	if (step === 'liquid') return buildLiquid()
	if (!['nifty', 'quotes', 'daily', 'minute'].includes(step ?? '')) {
		console.error('usage: --step nifty|quotes|daily|liquid|minute [--live --owner-ok YYYY-MM-DD]')
		return 2
	}
	const today = getISTDateString()
	const cfg = loadQuotaConfig()

	// ── the plan for this step (no API calls) ──
	let universe: string[] = []
	let tasks: FetchTask[] = []
	let isComplete: (s: string) => boolean = () => false
	if (step === 'nifty') {
		tasks = [{ symbol: NIFTY_SYMBOL, requests: 1 }]
		isComplete = (s) => coversReplaySessions(minuteStore.load(s))
	} else if (step === 'minute') {
		if (!fs.existsSync(LIQUID_FILE)) return (console.error(`[fetch-replay] ${LIQUID_FILE} missing — run --step liquid first`), 2)
		tasks = (JSON.parse(fs.readFileSync(LIQUID_FILE, 'utf8')) as { liquid: { symbol: string }[] }).liquid.map((r) => ({ symbol: r.symbol, requests: 1 }))
		isComplete = (s) => coversReplaySessions(minuteStore.load(s))
	} else if (step === 'daily') {
		if (!fs.existsSync(CANDIDATES_FILE)) return (console.error(`[fetch-replay] ${CANDIDATES_FILE} missing — run --step quotes first`), 2)
		const cands = (JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8')) as { candidates: string[] }).candidates
		isComplete = (s) => plannedRanges(dailyStore.load(s), today).length === 0
		tasks = cands.map((s) => ({ symbol: s, requests: plannedRanges(dailyStore.load(s), today).length }))
	} else {
		// public symbol master: no Fyers Data-API call
		universe = parseCashUniverse((await axios.get<string>(CM_URL, { responseType: 'text', timeout: 60_000 })).data)
		tasks = batches(universe, QUOTE_BATCH).map((b, i) => ({ symbol: `quotes#${i + 1} (${b.length} symbols)`, requests: 1 }))
	}
	const todo = tasks.filter((t) => !isComplete(t.symbol))
	const needed = todo.reduce((a, t) => a + t.requests, 0)

	const { redisClient, bootRedis } = await import('../src/config/redis.js')
	await bootRedis()
	const ledger = new RedisLedger(redisClient)
	const now = Date.now()
	const pf = preflight({ nowMs: now, ledger: await ledger.state(today), backtestAllocation: cfg.allocations.backtest, ownerOkDay: arg('owner-ok') })
	console.log(`[fetch-replay] step ${step}: ${tasks.length} tasks, ${tasks.length - todo.length} already complete, ${needed} requests needed${step === 'minute' || step === 'nifty' ? ` (1-minute, ${REPLAY_FROM} → ${REPLAY_TO})` : ''}`)
	console.log(`[fetch-replay] preflight: ${pf.ok ? `OK — budget ${pf.budget} requests this evening${needed > pf.budget ? ` (< ${needed}: the rest resumes on another evening)` : ''}` : `REFUSED — ${pf.refusals.join('; ')}`}`)
	if (!live || !pf.ok) {
		console.log(`[fetch-replay] ${live ? 'refused' : 'dry run'}: 0 Fyers calls made.`)
		await redisClient.quit().catch(() => {})
		return live ? 3 : 0
	}

	const { ENV } = await import('../src/config/env.js')
	const api = new fyers.fyersModel({ path: './', enableLogging: false })
	api.setAppId(ENV.FYERS_APP_ID)
	api.setAccessToken(fs.readFileSync('/app/token/access_token.txt', 'utf8').trim())
	// First throttle ends the run (replayGateConfig); every request re-checks the live ledger.
	const gate = createQuotaGate({ job: 'backtest', config: replayGateConfig(cfg), ledger })
	const checkBeforeCall = async () => midRunStop(await ledger.state(getISTDateString()), { nowMs: Date.now(), startDay: today })
	const history = async (symbol: string, resolution: string, from: string, to: string): Promise<Bar[]> => {
		const res = (await api.getHistory({ symbol, resolution, date_format: '1', range_from: from, range_to: to, cont_flag: '1' })) as History
		if (res.s === 'no_data') return []
		if (res.s !== 'ok') throw res // the gate classifies throttle / daily-limit bodies
		return toBars(res.candles ?? [])
	}

	if (step === 'quotes') {
		// The quote batches are all-or-nothing for the candidate list: refuse unless the budget covers them.
		if (needed > pf.budget) return (console.error(`[fetch-replay] quotes need ${needed} requests > budget ${pf.budget}; refusing`), await redisClient.quit(), 3)
		const quotes = new Map<string, { lp: number; volume: number }>()
		const byLabel = new Map(batches(universe, QUOTE_BATCH).map((b, i) => [`quotes#${i + 1} (${b.length} symbols)`, b]))
		const qr = await runFetch(todo, pf.budget, {
			gate,
			checkBeforeCall,
			isComplete: () => false,
			save: () => {},
			fetchOne: async (label, gated) => {
				const r = await gated(async () => {
					const x = (await api.getQuotes(byLabel.get(label)!)) as { s?: string }
					if (x?.s !== 'ok') throw x // the gate classifies throttle / daily-limit bodies
					return x
				})
				for (const [sym, q] of parseQuotes(r)) quotes.set(sym, q)
				return []
			},
		})
		if (qr.stoppedBy) {
			console.error(`[fetch-replay] ⛔ stopped after ${qr.requested} quote requests: ${qr.stoppedBy}. No candidate list written.`)
			await redisClient.quit().catch(() => {})
			return 4
		}
		const pfCfg = (JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'config', 'screener.json'), 'utf8')) as { prefilter: { minPrice: number; minTradedValueRupees: number } }).prefilter
		const c = dailyCandidates(universe, quotes, pfCfg)
		writeJson(CANDIDATES_FILE, { builtAt: new Date().toISOString(), quoteDay: today, lookAhead: `quotes are from ${today}, after the Oct 14 ranking date`, prefilter: pfCfg, universe: universe.length, quoted: quotes.size, failedBatches: Object.keys(qr.failed).length, ...c })
		console.log(`[fetch-replay] quotes: ${qr.requested} requests (${Object.keys(qr.failed).length} failed batches: their symbols stay candidates); ${c.candidates.length} candidates (${c.noQuote} without a quote), ${c.skipped} skipped → ${CANDIDATES_FILE}`)
		console.log(`[fetch-replay] ledger now: ${JSON.stringify(await ledger.state(today))}`)
		await redisClient.quit().catch(() => {})
		return 0
	}

	const fetchOne: RunDeps['fetchOne'] =
		step === 'daily'
			? async (symbol, gated) => {
					let all: Bar[] = []
					for (const [from, to] of plannedRanges(dailyStore.load(symbol), today)) {
						const bars = await gated(() => history(symbol, 'D', from, to))
						if (bars.length > 0) dailyStore.merge(symbol, bars) // saved per chunk: a stop never loses fetched bars
						all = all.concat(bars)
					}
					return all
				}
			: (symbol, gated) => gated(() => history(symbol, '1', REPLAY_FROM, REPLAY_TO))
	const report = await runFetch(todo, pf.budget, {
		gate,
		checkBeforeCall,
		isComplete,
		fetchOne,
		save: step === 'daily' ? () => {} : (s, bars) => void minuteStore.merge(s, bars),
	})
	writeJson(path.join(replayDir, `fetch-${step}-${today}.json`), report)
	console.log(`[fetch-replay] done: ${report.requested} requests, ${report.fetched.length} fetched, ${report.noData.length} no data, ${Object.keys(report.failed).length} failed, ${report.remaining.length} left${report.stoppedBy ? ` (stopped: ${report.stoppedBy})` : ''}`)
	console.log(`[fetch-replay] ledger now: ${JSON.stringify(await ledger.state(today))}`)
	await redisClient.quit().catch(() => {})
	return report.stoppedBy && !/budget/.test(report.stoppedBy) ? 4 : 0
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error('[fetch-replay] ❌ crashed:', err)
		process.exit(1)
	})
