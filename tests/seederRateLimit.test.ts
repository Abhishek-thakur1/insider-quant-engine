// ============================================================
// tests/seederRateLimit.test.ts — VWAP seeder throttling, retries, skips
//
// Runs the real seedSymbols() / seedHistoricalVwap() from vwapSeeder.ts and the
// real limiter from utils/rateLimit.ts on a virtual clock. The fake Fyers below
// enforces the documented Standard-plan limit (5 req/s, rolling) and answers
// with the exact -360 object from the Oct 19 engine log when it's exceeded.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// vwapSeeder imports config/env (exits without credentials) and creates a
// Redis client (lazy — never connects here). Dummy values only.
process.env.TELEGRAM_BOT_TOKEN ??= 'test'
process.env.TELEGRAM_CHANNEL_ID ??= 'test'
process.env.FYERS_APP_ID ??= 'test'
process.env.FYERS_SECRET_ID ??= 'test'

const { createSlidingWindowLimiter, isRateLimitError, retryDelayMs } = await import('../src/utils/rateLimit.js')
const { seedSymbols, seedHistoricalVwap, SEED_MAX_PER_SECOND } = await import('../src/ingestion/vwapSeeder.js')
const { VirtualClock } = await import('./helpers/virtualClock.js')

// Verbatim from the Oct 19 log.
const FYERS_360 = {
	code: -360,
	message:
		"You've reached the Standard plan limit of 5 requests/second. Upgrade to Prime for higher API limits. To know more, visit https://fyers.in/web/profile/prime",
	s: 'error',
}

const quietLog = { warn: () => {}, error: () => {} }

/** Max number of starts inside any window [t, t + windowMs). */
const maxInAnyWindow = (starts: number[], windowMs: number): number => {
	const s = [...starts].sort((a, b) => a - b)
	let best = 0
	for (let i = 0, j = 0; i < s.length; i++) {
		while (s[i]! - s[j]! >= windowMs) j++
		best = Math.max(best, i - j + 1)
	}
	return best
}

/** Fake Fyers getHistory: rolling 5 req/s, -360 beyond it. Records every call. */
const fakeFyers = (clock: InstanceType<typeof VirtualClock>, opts: { latencyMs?: number } = {}) => {
	const calls: { symbol: string; at: number }[] = []
	const fetch = async (symbol: string): Promise<'SEEDED' | 'NO_DATA'> => {
		const at = clock.now()
		calls.push({ symbol, at })
		const recent = calls.filter((c) => at - c.at < 1000).length
		await clock.sleep(opts.latencyMs ?? 150)
		if (recent > 5) throw FYERS_360
		return 'SEEDED'
	}
	return { calls, fetch }
}

const universe = (n: number) =>
	Array.from({ length: n }, (_, i) => ({ symbol: `NSE:SYM${i}-EQ`, equalWeight: false })).concat({
		symbol: 'NSE:NIFTY50-INDEX',
		equalWeight: true,
	})

test('limiter: 26 queued requests never exceed 4 starts in ANY 1000 ms window, FIFO', async () => {
	const clock = new VirtualClock(1_000_000)
	const { limit } = createSlidingWindowLimiter(4, 1000, clock)
	const starts: { i: number; at: number }[] = []
	await clock.run(
		Promise.all(
			Array.from({ length: 26 }, (_, i) =>
				limit(async () => {
					starts.push({ i, at: clock.now() })
					await clock.sleep(50)
				}),
			),
		),
	)
	assert.equal(starts.length, 26)
	assert.equal(maxInAnyWindow(starts.map((s) => s.at), 1000), 4)
	assert.deepEqual(starts.map((s) => s.i), Array.from({ length: 26 }, (_, i) => i), 'FIFO order')
	// 26 at 4/s: 7 windows → last start at +6 s
	assert.equal(starts.at(-1)!.at - starts[0]!.at, 6000)
})

test('limiter: a burst straddling a window edge is still capped (the old refill bug)', async () => {
	// Old limiter: 5 tokens refilled at each 1 s tick → 5 at t=999 ms + 5 at t=1000 ms
	// = 10 starts within 1 ms. Here: 4 at t=999, the next 4 wait until t=1999.
	const clock = new VirtualClock(0)
	const { limit } = createSlidingWindowLimiter(4, 1000, clock)
	await clock.run(clock.sleep(999))
	const starts: number[] = []
	await clock.run(Promise.all(Array.from({ length: 8 }, () => limit(async () => void starts.push(clock.now())))))
	assert.deepEqual(starts, [999, 999, 999, 999, 1999, 1999, 1999, 1999])
	assert.equal(maxInAnyWindow(starts, 1000), 4)
})

// ── Old limiter (437665b), EXECUTED side by side with the new one ──────────
// The fixture is the verbatim createRateLimiter from 437665b:src/ingestion/vwapSeeder.ts.
// It is loaded as a real module with setInterval/clearInterval bound to the
// virtual clock, so its own code decides when each request starts.

const OLD_LIMITER_COMMIT = '437665b'
const oldLimiterSource = fs.readFileSync(new URL('./fixtures/seederRateLimiter.pre-throttle.txt', import.meta.url), 'utf8')

test(`fixture is the verbatim limiter from ${OLD_LIMITER_COMMIT}:src/ingestion/vwapSeeder.ts`, (t) => {
	let blob: string
	try {
		blob = execFileSync('git', ['show', `${OLD_LIMITER_COMMIT}:src/ingestion/vwapSeeder.ts`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
	} catch {
		t.skip('git or the pinned commit is unavailable here')
		return
	}
	assert.ok(blob.replace(/\r\n/g, '\n').includes(oldLimiterSource.replace(/\r\n/g, '\n').trim()))
})

type OldLimiter = { limit: <T>(fn: () => Promise<T>) => Promise<T>; close: () => void }
const loadOldLimiter = async (clock: InstanceType<typeof VirtualClock>): Promise<OldLimiter> => {
	const file = path.join(os.tmpdir(), `iqe-old-limiter-${process.pid}.ts`)
	fs.writeFileSync(
		file,
		`export const make = (setInterval: any, clearInterval: any) => {\n${oldLimiterSource}\nreturn createRateLimiter\n}\n`,
	)
	const mod = (await import(pathToFileURL(file).href)) as { make: (s: unknown, c: unknown) => (n: number) => OldLimiter }
	return mod.make(clock.setInterval, clock.clearInterval)(5)
}

/**
 * Oct 19 replay: 26 symbols queued at boot; the 10 that Cloudflare-limited
 * (RELIANCE, INFY, TCS, ICICIBANK, GALLANTT, GENESYS, AEQUS, CAPILLARY,
 * JINDWORLD, JSLL) all retry ~31 s later, at the same instant, on a quiet limiter.
 */
const oct19Retries = async (
	clock: InstanceType<typeof VirtualClock>,
	limit: <T>(fn: () => Promise<T>) => Promise<T>,
	fyers: ReturnType<typeof fakeFyers>,
) => {
	const settle = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e?.code === -360 ? '-360' : 'err'))
	const first = universe(25).map((u) => settle(limit(() => fyers.fetch(u.symbol))))
	await clock.run(Promise.all(first))
	await clock.run(clock.sleep(31_000 - (clock.now() % 1000) + 400)) // land mid-window, like a real retry
	const retries = Array.from({ length: 10 }, (_, i) => settle(limit(() => fyers.fetch(`RETRY${i}`))))
	return clock.run(Promise.all(retries))
}

test('Oct 19 replay — OLD limiter (executed): 10 simultaneous retries → >5 starts in a rolling second → -360', async (t) => {
	const clock = new VirtualClock(0)
	const old = await loadOldLimiter(clock)
	const fyers = fakeFyers(clock)
	const results = await oct19Retries(clock, old.limit, fyers)
	old.close()
	const retryStarts = fyers.calls.filter((c) => c.symbol.startsWith('RETRY')).map((c) => c.at)
	t.diagnostic(`old: retry starts at +ms ${retryStarts.map((x) => x - retryStarts[0]!).join(',')} | max in any 1000 ms window = ${maxInAnyWindow(retryStarts, 1000)} | results ${results.join(',')}`)
	assert.ok(maxInAnyWindow(retryStarts, 1000) > 5, `max in a window: ${maxInAnyWindow(retryStarts, 1000)}`)
	assert.ok(results.filter((r) => r === '-360').length > 0, JSON.stringify(results))
})

test('Oct 19 replay — NEW limiter: same 10 retries → never more than 4 per window, zero -360', async (t) => {
	const clock = new VirtualClock(0)
	const { limit } = createSlidingWindowLimiter(SEED_MAX_PER_SECOND, 1000, clock)
	const fyers = fakeFyers(clock)
	const results = await oct19Retries(clock, limit, fyers)
	const rs = fyers.calls.filter((c) => c.symbol.startsWith('RETRY')).map((c) => c.at)
	t.diagnostic(`new: retry starts at +ms ${rs.map((x) => x - rs[0]!).join(',')} | max in any 1000 ms window = ${maxInAnyWindow(fyers.calls.map((c) => c.at), 1000)} | results ${results.join(',')}`)
	assert.equal(maxInAnyWindow(fyers.calls.map((c) => c.at), 1000), 4)
	assert.deepEqual(results, Array(10).fill('ok'))
})

test('seeder vs a strict 5 req/s Fyers: 25 equities + Nifty all seeded, zero -360s', async () => {
	const clock = new VirtualClock(0)
	const fyers = fakeFyers(clock)
	const outcomes = await clock.run(
		seedSymbols(universe(25), { fetch: fyers.fetch, isSeeded: async () => false, clock, log: quietLog }),
	)
	assert.equal(SEED_MAX_PER_SECOND, 4)
	assert.equal(outcomes.size, 26)
	assert.ok([...outcomes.values()].every((o) => o === 'SEEDED'), JSON.stringify([...outcomes]))
	assert.equal(fyers.calls.length, 26, 'one call per symbol, no retries needed')
	assert.equal(maxInAnyWindow(fyers.calls.map((c) => c.at), 1000), 4)
})

test('-360 is detected as a rate limit and retried with backoff (1 s, 2 s, + jitter)', async () => {
	assert.equal(isRateLimitError(FYERS_360), true)
	assert.equal(isRateLimitError(new Error("API returned status: error - You've reached the Standard plan limit of 5 requests/second")), true)
	assert.equal(isRateLimitError({ error_code: 1015, retry_after: 30 }), true) // Cloudflare
	assert.equal(isRateLimitError(new Error('API returned status: error - invalid symbol')), false)

	const clock = new VirtualClock(0)
	const attempts: number[] = []
	const fetch = async () => {
		attempts.push(clock.now())
		if (attempts.length <= 2) throw FYERS_360
		return 'SEEDED' as const
	}
	const outcomes = await clock.run(
		seedSymbols([{ symbol: 'NSE:X-EQ', equalWeight: false }], { fetch, isSeeded: async () => false, clock, log: quietLog, rand: () => 0 }),
	)
	assert.equal(outcomes.get('NSE:X-EQ'), 'SEEDED')
	assert.deepEqual(attempts, [0, 1000, 3000]) // waits 1000, then 2000
	assert.equal(retryDelayMs(2, undefined, () => 0.999), 4000 + 249)
})

test('-360 forever: gives up after 3 retries (4 attempts) and reports FAILED', async () => {
	const clock = new VirtualClock(0)
	let attempts = 0
	const fetch = async (): Promise<'SEEDED'> => {
		attempts++
		throw FYERS_360
	}
	const outcomes = await clock.run(
		seedSymbols([{ symbol: 'NSE:X-EQ', equalWeight: false }], { fetch, isSeeded: async () => false, clock, log: quietLog, rand: () => 0 }),
	)
	assert.equal(outcomes.get('NSE:X-EQ'), 'FAILED')
	assert.equal(attempts, 4)
	assert.equal(clock.now(), 1000 + 2000 + 4000)
})

test('non-rate-limit errors are not retried', async () => {
	const clock = new VirtualClock(0)
	let attempts = 0
	const fetch = async (): Promise<'SEEDED'> => {
		attempts++
		throw new Error('API returned status: error - invalid symbol')
	}
	const outcomes = await clock.run(seedSymbols([{ symbol: 'NSE:X-EQ', equalWeight: false }], { fetch, isSeeded: async () => false, clock, log: quietLog }))
	assert.equal(outcomes.get('NSE:X-EQ'), 'FAILED')
	assert.equal(attempts, 1)
})

test('symbols already seeded today make zero API calls', async () => {
	const clock = new VirtualClock(0)
	const fyers = fakeFyers(clock)
	const seeded = new Set(['NSE:SYM0-EQ', 'NSE:SYM3-EQ', 'NSE:NIFTY50-INDEX'])
	const outcomes = await clock.run(
		seedSymbols(universe(5), { fetch: fyers.fetch, isSeeded: async (s) => seeded.has(s), clock, log: quietLog }),
	)
	assert.deepEqual(fyers.calls.map((c) => c.symbol).sort(), ['NSE:SYM1-EQ', 'NSE:SYM2-EQ', 'NSE:SYM4-EQ'])
	for (const s of seeded) assert.equal(outcomes.get(s), 'ALREADY_SEEDED')
})

test('before 09:15 IST the seeder makes no API call at all (09:00 boot)', async () => {
	const logs: string[] = []
	const orig = console.log
	console.log = (...a: unknown[]) => void logs.push(a.join(' '))
	try {
		// 09:00 IST on Oct 19. Token/watchlist files don't exist here, so if the
		// pre-open guard did NOT return first we'd see the "Missing auth files" path.
		await seedHistoricalVwap(Date.parse('2026-10-19T03:30:00Z'))
	} finally {
		console.log = orig
	}
	assert.ok(logs.some((l) => l.includes('Before 09:15 IST')), logs.join('\n'))
})

test('ENGINE GATE: seeder via the quota gate — 40/min pacing, and the daily-limit answer stops the rest', async () => {
	const { createQuotaGate, loadQuotaConfig, MemoryLedger } = await import('../src/fyers/quota.js')
	const clock = new VirtualClock(Date.parse('2026-10-21T04:00:00Z')) // 09:30 IST, a restart mid-session
	const ledger = new MemoryLedger()
	const gate = createQuotaGate({ job: 'seeder', config: loadQuotaConfig(), ledger, clock, log: quietLog })
	const starts: number[] = []
	const fetch = async () => {
		starts.push(clock.now())
		const n = starts.length
		await clock.sleep(100)
		if (n === 30) throw new Error("API returned status: error - You've reached the Standard plan limit of 5,000 requests/day.")
		return 'SEEDED' as const
	}
	const outcomes = await clock.run(seedSymbols(universe(60), { fetch, isSeeded: async () => false, clock, log: quietLog, gate }))
	assert.equal(maxInAnyWindow(starts, 60_000) <= 40, true)
	assert.ok(starts.length <= 33, `requests after the daily limit: ${starts.length}`)
	assert.ok([...outcomes.values()].filter((o) => o === 'FAILED').length >= 61 - starts.length)
	assert.equal((await ledger.state('2026-10-21')).exhausted, true)
	const anomaly = createQuotaGate({ job: 'anomaly', config: loadQuotaConfig(), ledger, clock, log: quietLog })
	await assert.rejects(clock.run(anomaly.call(async () => 'x')), /daily Data-API limit/)
})

test('engine wiring: seeder and anomaly promotions use the shared engine gates', () => {
	const seeder = fs.readFileSync('src/ingestion/vwapSeeder.ts', 'utf8')
	assert.match(seeder, /gate: engineGate\('seeder'\)/)
	const ws = fs.readFileSync('src/ingestion/websocket.ts', 'utf8')
	assert.match(ws, /engineGate\('anomaly'\)\s*\.call\(\(\) => fetchAndSeedSymbol\(symbol, getTodayString\(\)\)\)/)
	assert.doesNotMatch(ws.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'), /^\s*fetchAndSeedSymbol\(symbol, getTodayString\(\)\)\.catch/m)
})
