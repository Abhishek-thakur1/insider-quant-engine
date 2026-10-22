// ============================================================
// tests/fetchReplay.test.ts — the liquid-replay fetch rules (backtest/fetchReplay.ts)
//
// Owner's required tests (2026-10-21): refuses on any breach, stops at the evening cap,
// resumes, fetches the most liquid first, sandbox has no credentials. Plus: per-evening
// owner OK, 15:45 rule, allocation, quota stop, no look-ahead in the liquid ranking.
// Real createQuotaGate on an in-memory ledger; no network.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

import {
	EVENING_REQUEST_CAP,
	REPLAY_SESSIONS,
	buildLiquidList,
	dailyCandidates,
	coversReplaySessions,
	preflight,
	runFetch,
	sandboxViolations,
	type Bar,
	type FetchTask,
} from '../backtest/fetchReplay.js'
import { MemoryLedger, createQuotaGate, type LedgerState, type QuotaConfig } from '../src/fyers/quota.js'

const IST = 330 * 60_000
const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00Z`) - IST
const clean: LedgerState = { used: {}, breaches: 0, exhausted: false, cooldownUntil: 0 }
const EVENING = at('2026-10-23', '16:00')

test('PREFLIGHT: clean ledger, after 15:45, OK for today → budget = min(1000, allocation left)', () => {
	const r = preflight({ nowMs: EVENING, ledger: clean, backtestAllocation: 1500, ownerOkDay: '2026-10-23' })
	assert.deepEqual(r.refusals, [])
	assert.equal(r.budget, EVENING_REQUEST_CAP)
	const r2 = preflight({ nowMs: EVENING, ledger: { ...clean, used: { backtest: 1200 } }, backtestAllocation: 1500, ownerOkDay: '2026-10-23' })
	assert.equal(r2.budget, 300)
})

test('PREFLIGHT refuses on ANY breach today (even 1, below the gate stop of 2)', () => {
	const r = preflight({ nowMs: EVENING, ledger: { ...clean, breaches: 1 }, backtestAllocation: 1500, ownerOkDay: '2026-10-23' })
	assert.equal(r.ok, false)
	assert.equal(r.budget, 0)
	assert.match(r.refusals.join(), /1 breach/)
})

test('PREFLIGHT refuses: no owner OK, yesterday’s OK, before 15:45, exhausted, cooldown, allocation used', () => {
	const base = { nowMs: EVENING, ledger: clean, backtestAllocation: 1500, ownerOkDay: '2026-10-23' as string | null }
	assert.match(preflight({ ...base, ownerOkDay: null }).refusals.join(), /no owner OK/)
	assert.match(preflight({ ...base, ownerOkDay: '2026-10-22' }).refusals.join(), /no owner OK for 2026-10-23/)
	assert.match(preflight({ ...base, nowMs: at('2026-10-23', '15:44') }).refusals.join(), /before 15:45/)
	assert.equal(preflight({ ...base, nowMs: at('2026-10-23', '15:45') }).ok, true)
	assert.match(preflight({ ...base, ledger: { ...clean, exhausted: true } }).refusals.join(), /exhausted/)
	assert.match(preflight({ ...base, ledger: { ...clean, cooldownUntil: EVENING + 60_000 } }).refusals.join(), /cooldown/)
	assert.match(preflight({ ...base, ledger: { ...clean, used: { backtest: 1500 } } }).refusals.join(), /allocation/)
})

// ── liquid list ──
const DAY = 86_400_000
const series = (lastDay: string, n: number, close: number, vol: number): Bar[] =>
	Array.from({ length: n }, (_, k) => {
		const t = Date.parse(`${lastDay}T03:45:00Z`) - (n - 1 - k) * DAY
		return { t, o: close, h: close, l: close, c: close, v: vol }
	})

test('LIQUID: ranks by 30-session average traded value as of Oct 14, most liquid first; > ₹15 cr only', () => {
	const m = new Map<string, Bar[]>([
		['NSE:MID-EQ', series('2026-10-14', 40, 100, 200_000)], // 2 cr: out
		['NSE:BIG-EQ', series('2026-10-14', 40, 1000, 500_000)], // 50 cr
		['NSE:EDGE-EQ', series('2026-10-14', 40, 100, 1_500_000)], // exactly 15 cr: out (strictly greater)
		['NSE:NEW-EQ', series('2026-10-14', 12, 1000, 900_000)], // 12 sessions: listed as insufficient
		['NSE:ALSO-EQ', series('2026-10-14', 30, 500, 400_000)], // 20 cr
	])
	const l = buildLiquidList(m)
	assert.deepEqual(l.liquid.map((r) => r.symbol), ['NSE:BIG-EQ', 'NSE:ALSO-EQ'])
	assert.equal(l.liquid[0]!.avgTurnoverCr, 50)
	assert.deepEqual(l.insufficientHistory, ['NSE:NEW-EQ'])
})

test('LIQUID: NO LOOK-AHEAD — bars after Oct 14 never change the ranking', () => {
	const before = series('2026-10-14', 30, 100, 1_000_000) // 10 cr
	const spike = series('2026-10-22', 6, 100, 100_000_000) // huge turnover in the replay week
	const a = buildLiquidList(new Map([['NSE:X-EQ', before]]))
	const b = buildLiquidList(new Map([['NSE:X-EQ', [...before, ...spike.filter((x) => x.t > before.at(-1)!.t)]]]))
	assert.deepEqual(b, a)
	assert.equal(a.liquid.length, 0)
})

// ── runner ──
const FAST: QuotaConfig = {
	dataApi: { perSecond: 5, perMinute: 50, perDay: 5000 },
	allocations: { screener: 0, seeder: 0, anomaly: 0, backtest: 1500 },
	maxBreachesPerDay: 2,
	cooldownMs: 65_000,
	maxRetries: 0,
}
const fakeClock = () => {
	let now = EVENING
	return { now: () => now, sleep: async (ms: number) => void (now += ms) }
}
const quiet = { log: () => {}, warn: () => {}, error: () => {} }
const bars1m = (sessions: readonly string[] = REPLAY_SESSIONS): Bar[] => sessions.map((d) => ({ t: Date.parse(`${d}T04:00:00Z`), o: 1, h: 1, l: 1, c: 1, v: 1 }))

const harness = (opts: { throttleAt?: number; done?: Set<string> } = {}) => {
	const ledger = new MemoryLedger()
	const gate = createQuotaGate({ job: 'backtest', config: FAST, ledger, clock: fakeClock(), log: quiet })
	const calls: string[] = []
	const disk = new Map<string, Bar[]>()
	for (const s of opts.done ?? []) disk.set(s, bars1m())
	const deps = {
		gate,
		log: quiet,
		fetchOne: (s: string, gated: <T>(fn: () => Promise<T>) => Promise<T>) =>
			gated(async () => {
				calls.push(s)
				if (opts.throttleAt !== undefined && calls.length === opts.throttleAt) throw { code: 429, message: 'request limit reached' }
				return bars1m()
			}),
		isComplete: (s: string) => coversReplaySessions(disk.get(s) ?? []),
		save: (s: string, b: Bar[]) => void disk.set(s, b),
	}
	return { ledger, calls, disk, deps }
}
const tasks = (n: number): FetchTask[] => Array.from({ length: n }, (_, k) => ({ symbol: `NSE:S${String(k).padStart(4, '0')}-EQ`, requests: 1 }))

test('RUNNER: fetches in the given (most-liquid-first) order and stops exactly at the evening cap', async () => {
	const h = harness()
	const t = tasks(1200)
	const r = await runFetch(t, 1000, h.deps)
	assert.equal(h.calls.length, 1000)
	assert.deepEqual(h.calls, t.slice(0, 1000).map((x) => x.symbol), 'order preserved')
	assert.equal(r.requested, 1000)
	assert.match(r.stoppedBy!, /budget of 1000/)
	assert.deepEqual(r.remaining, t.slice(1000).map((x) => x.symbol))
	assert.equal((await h.ledger.state('2026-10-23')).used.backtest, 1000, 'every request counted in the ledger')
})

test('RUNNER: RESUMES — a second evening skips what is complete on disk and continues from the first missing symbol', async () => {
	const t = tasks(30)
	const h1 = harness()
	await runFetch(t, 12, h1.deps)
	const h2 = harness({ done: new Set(h1.disk.keys()) })
	const r2 = await runFetch(t, 1000, h2.deps)
	assert.equal(r2.skippedComplete, 12)
	assert.deepEqual(h2.calls, t.slice(12).map((x) => x.symbol))
	assert.equal(r2.stoppedBy, null)
})

test('RUNNER: a symbol missing any replay session is NOT complete (re-fetched)', () => {
	assert.equal(coversReplaySessions(bars1m()), true)
	assert.equal(coversReplaySessions(bars1m(REPLAY_SESSIONS.slice(0, -1))), false)
})

test('RUNNER: stops on the first quota stop and keeps everything already saved', async () => {
	// maxBreachesPerDay 1 → the first throttle is a BreachLimitError (QuotaStopError)
	const h = harness({ throttleAt: 5 })
	const strict = createQuotaGate({ job: 'backtest', config: { ...FAST, maxBreachesPerDay: 1 }, ledger: h.ledger, clock: fakeClock(), log: quiet })
	const t = tasks(20)
	const r = await runFetch(t, 1000, { ...h.deps, gate: strict })
	assert.equal(h.calls.length, 5)
	assert.match(r.stoppedBy!, /quota stop/)
	assert.equal(h.disk.size, 4, 'the 4 symbols before the throttle are on disk')
	assert.deepEqual(r.remaining, t.slice(4).map((x) => x.symbol))
	assert.equal((await h.ledger.state('2026-10-23')).breaches, 1)
})

test('SANDBOX: refuses any credential, a token file, or BACKTEST_MODE unset', () => {
	assert.deepEqual(sandboxViolations({ BACKTEST_MODE: 'true', PATH: '/usr/bin', HOME: '/root' }, false), [])
	const v = sandboxViolations(
		{ BACKTEST_MODE: 'false', DATABASE_URL: 'postgres://x', TELEGRAM_BOT_TOKEN: 'x', REDIS_URL: 'redis://x', FYERS_SECRET_ID: 'x', POSTGRES_PASSWORD: 'x' },
		true,
	)
	assert.equal(v.length, 7)
	assert.ok(v.some((x) => /BACKTEST_MODE/.test(x)))
	assert.ok(v.some((x) => /token file/.test(x)))
})

test('RUNNER: a fetch that tries more requests than it declared is stopped (the cap cannot be overrun)', async () => {
	const h = harness()
	const r = await runFetch([{ symbol: 'NSE:GREEDY-EQ', requests: 1 }], 1000, {
		...h.deps,
		fetchOne: async (s, gated) => {
			await gated(async () => bars1m())
			await gated(async () => bars1m()) // a second, undeclared request
			return bars1m()
		},
	})
	assert.equal(r.requested, 1)
	assert.match(r.failed['NSE:GREEDY-EQ']!, /more than the 1 declared/)
	assert.equal((await h.ledger.state('2026-10-23')).used.backtest, 1, 'only the declared request reached the ledger')
})

test('DAILY CANDIDATES: screener pre-filter thresholds on fetch-day quotes, most traded value first, unquoted kept last', () => {
	const quotes = new Map([
		['NSE:A-EQ', { lp: 100, volume: 300_000 }], // ₹3 cr
		['NSE:B-EQ', { lp: 1000, volume: 500_000 }], // ₹50 cr
		['NSE:C-EQ', { lp: 15, volume: 10_000_000 }], // price < 20: skipped
		['NSE:D-EQ', { lp: 100, volume: 100_000 }], // ₹1 cr: skipped
	])
	const r = dailyCandidates(['NSE:A-EQ', 'NSE:B-EQ', 'NSE:C-EQ', 'NSE:D-EQ', 'NSE:E-EQ'], quotes, { minPrice: 20, minTradedValueRupees: 20_000_000 })
	assert.deepEqual(r.candidates, ['NSE:B-EQ', 'NSE:A-EQ', 'NSE:E-EQ'])
	assert.equal(r.skipped, 2)
	assert.equal(r.noQuote, 1)
})

// ── report ──
import { buildReplayReport, outcomeOf, type ReplayTrade } from '../backtest/replayReport.js'

test('REPORT: n on every row, caveats stated, every fire listed with time, stock, setup, outcome and reason', () => {
	const t = (o: Partial<ReplayTrade>): ReplayTrade => ({ detectorId: 'vcp', sessionDate: '2026-10-15', symbol: 'NSE:A-EQ', side: 'LONG', entryTs: Date.parse('2026-10-15T05:36:00Z'), r: -1.02, exitReason: 'stop', gateScore: 88, gatePassed: true, gateRejectedAt: null, ...o })
	const md = buildReplayReport(
		{ vcp: [t({}), t({ gatePassed: false, gateRejectedAt: 'EV', gateScore: 49, sessionDate: '2026-10-16', entryTs: Date.parse('2026-10-16T09:03:00Z') })], smb: [t({ detectorId: 'smb', gatePassed: false, gateRejectedAt: null, gateScore: 77 })] },
		{ sessions: ['2026-10-15', '2026-10-16'], liquidCount: 640, liquidAsOf: '2026-10-14', quoteDay: '2026-10-23' },
	)
	assert.match(md, /Far too few sessions for any edge conclusion.*n = 3 fires/)
	assert.match(md, /Options are not replayable/)
	assert.match(md, /Look-ahead in the pre-filter.*2026-10-23/)
	assert.match(md, /640 stocks .* as of 2026-10-14/)
	assert.match(md, /\| vcp \| n = 1 \(1 passed\) \| n = 1 \(0 passed\) \| n = 2 \(1 passed\) \|/)
	assert.match(md, /\| 11:06 \| NSE:A-EQ \| vcp \| LONG \| 88 \| PASSED \| -1\.02 \| stop \|/)
	assert.match(md, /\| 14:33 \| NSE:A-EQ \| vcp \| LONG \| 49 \| rejected EV \|/)
	assert.equal(outcomeOf(t({ gatePassed: false, gateRejectedAt: null })), 'rejected SCORE < 78')
	assert.doesNotMatch(md, /win rate:|expectancy:|average R/i, 'no aggregate performance numbers')
})
