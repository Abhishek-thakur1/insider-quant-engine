// ============================================================
// scripts/fetch_replay.ts — the liquid-replay fetch (backtest/fetchReplay.ts) on EC2
//
// DRY RUN BY DEFAULT: prints the plan, the request count and the preflight verdict
// and makes ZERO Fyers calls. A live run needs BOTH:
//   --live                   and
//   --owner-ok YYYY-MM-DD    equal to today (IST): the owner's OK for THIS evening.
// Preflight also refuses before 15:45 IST, on any breach in today's ledger, on an
// exhausted day, during a cooldown, or with the 'backtest' allocation used up.
//
// Steps (run in the screener image with the screener_data volume, so daily candles
// are the screener's cache at <data>/candles/D):
//   --step nifty    ONE request: Nifty 1-minute, 2026-10-15 → 2026-10-22
//   --step liquid   no calls: rank <data>/candles/D into <data>/replay/liquid15cr.json
//   --step minute   1-minute Oct 15–22 for the liquid list, most liquid first
// (--step daily, fed by the 48-call quote pre-filter, is the next commit on this branch.)
//
//   docker compose run --rm --no-deps quant_screener node --import tsx scripts/fetch_replay.ts --step nifty
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import fyers from 'fyers-api-v3'
import {
	NIFTY_SYMBOL,
	REPLAY_FROM,
	REPLAY_TO,
	buildLiquidList,
	coversReplaySessions,
	preflight,
	runFetch,
	type Bar,
	type FetchTask,
} from '../backtest/fetchReplay.js'
import { CandleStore } from '../src/screener/candleStore.js'
import { screenerDataDir } from '../src/screener/paths.js'
import { RedisLedger, createQuotaGate, loadQuotaConfig } from '../src/fyers/quota.js'
import { getISTDateString } from '../src/utils/marketHours.js'

const arg = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const step = arg('step')
const live = process.argv.includes('--live')
const dataDir = screenerDataDir()
const dailyStore = new CandleStore(path.join(dataDir, 'candles', 'D'))
const minuteStore = new CandleStore(path.join(dataDir, 'candles', '1'))
const replayDir = path.join(dataDir, 'replay')
const LIQUID_FILE = path.join(replayDir, 'liquid15cr.json')

const readJsonArray = (file: string): string[] => (JSON.parse(fs.readFileSync(file, 'utf8')) as string[]).filter((s) => typeof s === 'string')

const main = async (): Promise<number> => {
	if (step === 'liquid') {
		const files = fs.existsSync(dailyStore.dir) ? fs.readdirSync(dailyStore.dir).filter((f) => f.endsWith('.json')) : []
		const m = new Map<string, Bar[]>()
		for (const f of files) {
			const j = JSON.parse(fs.readFileSync(path.join(dailyStore.dir, f), 'utf8')) as { symbol?: string; bars?: Bar[] }
			if (j.symbol && Array.isArray(j.bars)) m.set(j.symbol, j.bars)
		}
		const list = buildLiquidList(m)
		fs.mkdirSync(replayDir, { recursive: true })
		fs.writeFileSync(LIQUID_FILE, JSON.stringify({ builtAt: new Date().toISOString(), dailyFiles: files.length, ...list }, null, 1))
		console.log(`[fetch-replay] liquid list: ${list.liquid.length} symbols > ₹${list.minTurnoverCr} cr (as of ${list.asOf}); ${list.insufficientHistory.length} with < ${list.lookback} sessions; from ${files.length} daily files → ${LIQUID_FILE}`)
		return 0
	}

	let tasks: FetchTask[]
	if (step === 'nifty') tasks = [{ symbol: NIFTY_SYMBOL, requests: 1 }]
	else if (step === 'minute') {
		if (!fs.existsSync(LIQUID_FILE)) {
			console.error(`[fetch-replay] ${LIQUID_FILE} missing — run --step liquid first`)
			return 2
		}
		const l = JSON.parse(fs.readFileSync(LIQUID_FILE, 'utf8')) as { liquid: { symbol: string }[] }
		tasks = l.liquid.map((r) => ({ symbol: r.symbol, requests: 1 }))
	} else if (step === 'symbols') {
		const f = arg('file')
		if (!f) return (console.error('--step symbols needs --file <json array>'), 2)
		tasks = readJsonArray(f).map((s) => ({ symbol: s, requests: 1 }))
	} else {
		console.error('usage: --step nifty|liquid|minute [--live --owner-ok YYYY-MM-DD]')
		return 2
	}

	const isComplete = (s: string) => coversReplaySessions(minuteStore.load(s))
	const todo = tasks.filter((t) => !isComplete(t.symbol))
	const cfg = loadQuotaConfig()

	// Ledger state: read-only Redis access is needed even for the dry-run verdict.
	const { redisClient, bootRedis } = await import('../src/config/redis.js')
	await bootRedis()
	const ledger = new RedisLedger(redisClient)
	const now = Date.now()
	const pf = preflight({ nowMs: now, ledger: await ledger.state(getISTDateString(now)), backtestAllocation: cfg.allocations.backtest, ownerOkDay: arg('owner-ok') })
	console.log(`[fetch-replay] step ${step}: ${tasks.length} symbols, ${tasks.length - todo.length} already complete, ${todo.length} requests needed (window ${REPLAY_FROM} → ${REPLAY_TO}, 1-minute)`)
	console.log(`[fetch-replay] preflight: ${pf.ok ? `OK — budget ${pf.budget} requests this evening` : `REFUSED — ${pf.refusals.join('; ')}`}`)
	if (!live || !pf.ok) {
		console.log(`[fetch-replay] ${live ? 'refused' : 'dry run'}: 0 Fyers calls made.`)
		await redisClient.quit().catch(() => {})
		return live ? 3 : 0
	}

	const { ENV } = await import('../src/config/env.js')
	const api = new fyers.fyersModel({ path: './', enableLogging: false })
	api.setAppId(ENV.FYERS_APP_ID)
	api.setAccessToken(fs.readFileSync('/app/token/access_token.txt', 'utf8').trim())
	const gate = createQuotaGate({ job: 'backtest', config: cfg, ledger })
	const report = await runFetch(todo, pf.budget, {
		gate,
		isComplete,
		save: (s, bars) => void minuteStore.merge(s, bars),
		fetchOne: async (symbol) => {
			const res = (await api.getHistory({ symbol, resolution: '1', date_format: '1', range_from: REPLAY_FROM, range_to: REPLAY_TO, cont_flag: '1' })) as { s: string; candles?: number[][]; message?: string }
			if (res.s === 'no_data') return []
			if (res.s !== 'ok') throw res
			return (res.candles ?? []).map((c) => ({ t: c[0]! * 1000, o: c[1]!, h: c[2]!, l: c[3]!, c: c[4]!, v: c[5]! }))
		},
	})
	fs.mkdirSync(replayDir, { recursive: true })
	fs.writeFileSync(path.join(replayDir, `fetch-${step}-${pf.today}.json`), JSON.stringify(report, null, 1))
	console.log(`[fetch-replay] done: ${report.requested} requests, ${report.fetched.length} fetched, ${report.noData.length} no data, ${Object.keys(report.failed).length} failed, ${report.remaining.length} left${report.stoppedBy ? ` (stopped: ${report.stoppedBy})` : ''}`)
	console.log(`[fetch-replay] ledger now: ${JSON.stringify(await ledger.state(pf.today))}`)
	await redisClient.quit().catch(() => {})
	return report.stoppedBy && !/budget/.test(report.stoppedBy) ? 4 : 0
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error('[fetch-replay] ❌ crashed:', err)
		process.exit(1)
	})
