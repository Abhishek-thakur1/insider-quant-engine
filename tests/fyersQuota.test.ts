// ============================================================
// tests/fyersQuota.test.ts — pacing, daily hard stop, cooldown, allocations, ledgers
//
// Real src/fyers/quota.ts on a virtual clock. Error bodies are the exact ones
// Fyers / Cloudflare returned on 2026-10-19 and 2026-10-20.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	AllocationExhaustedError,
	BreachLimitError,
	classifyFyersError,
	createMultiWindowLimiter,
	createQuotaGate,
	DailyQuotaExhaustedError,
	FileLedger,
	loadQuotaConfig,
	MemoryLedger,
	RedisLedger,
	validateQuotaConfig,
	type QuotaConfig,
	type RedisLike,
} from '../src/fyers/quota.js'
import { VirtualClock } from './helpers/virtualClock.js'

// Verbatim from production logs
const DAILY = {
	code: -360,
	message: "You've reached the Standard plan limit of 5,000 requests/day. Upgrade to Prime for higher API limits. To know more, visit https://fyers.in/web/profile/prime",
	s: 'error',
}
const PER_SECOND = { code: -360, message: "You've reached the Standard plan limit of 5 requests/second. Upgrade to Prime for higher API limits. To know more, visit https://fyers.in/web/profile/prime", s: 'error' }
const CLOUDFLARE = {
	type: 'https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1015/',
	title: 'Error 1015: You are being rate limited',
	status: 429,
	error_code: 1015,
	error_name: 'rate_limited',
	zone: 'api-t1.fyers.in',
	cloudflare_error: true,
	retryable: true,
	retry_after: 30,
}

const config = loadQuotaConfig()
const quiet = { warn: () => {}, error: () => {} }
// 2026-10-21 18:00 IST
const START = Date.parse('2026-10-21T12:30:00Z')

const maxInWindow = (starts: number[], w: number) => {
	const s = [...starts].sort((a, b) => a - b)
	let best = 0
	for (let i = 0, j = 0; i < s.length; i++) {
		while (s[i]! - s[j]! >= w) j++
		best = Math.max(best, i - j + 1)
	}
	return best
}

test('config: Fyers Standard Data-API limits respected; allocations fit the day', () => {
	assert.deepEqual(config.dataApi, { perSecond: 4, perMinute: 40, perDay: 5000 })
	assert.deepEqual(config.allocations, { screener: 2200, seeder: 300, anomaly: 200, backtest: 1500 })
	assert.equal(config.maxBreachesPerDay, 2)
	assert.throws(() => validateQuotaConfig({ ...config, dataApi: { ...config.dataApi, perMinute: 60 } }), /50\/min/)
	assert.throws(() => validateQuotaConfig({ ...config, allocations: { ...config.allocations, backtest: 3000 } }), /sum to 5700 > perDay 5000/)
	assert.throws(() => validateQuotaConfig({ ...config, maxBreachesPerDay: 4 }), /more than 3/)
})

test('classification of the real production error bodies', () => {
	assert.equal(classifyFyersError(DAILY), 'DAILY')
	assert.equal(classifyFyersError(new Error(`API returned status: error - ${DAILY.message}`)), 'DAILY')
	assert.equal(classifyFyersError(PER_SECOND), 'THROTTLE')
	assert.equal(classifyFyersError(CLOUDFLARE), 'THROTTLE')
	assert.equal(classifyFyersError({ code: -429, message: 'API rate limit exceeded' }), 'THROTTLE')
	assert.equal(classifyFyersError(new Error('API returned status: error - invalid symbol')), 'OTHER')
})

test('PACING: 120 requests never exceed 4 in any second or 40 in any minute (Fyers: 5 / 50)', async () => {
	const clock = new VirtualClock(START)
	const gate = createQuotaGate({ job: 'screener', config, ledger: new MemoryLedger(), clock, log: quiet })
	const starts: number[] = []
	await clock.run(Promise.all(Array.from({ length: 120 }, () => gate.call(async () => void starts.push(clock.now())))))
	assert.equal(starts.length, 120)
	assert.equal(maxInWindow(starts, 1000), 4)
	assert.equal(maxInWindow(starts, 60_000), 40)
	assert.ok(clock.now() - START >= 2 * 60_000, '120 requests take at least 2 minutes at 40/min')
})

// Requests take 150 ms (network). Anything already in flight when the stop/throttle
// answer arrives cannot be recalled; the property is that NOTHING STARTS after it.
test('HARD STOP: after the daily-limit answer no request starts, for any job sharing the ledger', async () => {
	const clock = new VirtualClock(START)
	const ledger = new MemoryLedger()
	const screener = createQuotaGate({ job: 'screener', config, ledger, clock, log: quiet })
	const seeder = createQuotaGate({ job: 'seeder', config, ledger, clock, log: quiet })
	const starts: number[] = []
	let dailyAt = Infinity
	const fyers = async () => {
		starts.push(clock.now())
		const n = starts.length
		await clock.sleep(150)
		if (n === 5) {
			dailyAt = clock.now()
			throw DAILY
		}
		return 'ok'
	}
	const results = await clock.run(Promise.allSettled(Array.from({ length: 20 }, () => screener.call(fyers))))
	assert.ok(Number.isFinite(dailyAt))
	assert.deepEqual(starts.filter((t) => t >= dailyAt), [], 'a request started after the daily-limit answer')
	assert.ok(starts.length <= 8, `only requests already in flight may have been sent (${starts.length})`)
	assert.ok(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof DailyQuotaExhaustedError))
	const before = starts.length
	await assert.rejects(clock.run(seeder.call(fyers)), DailyQuotaExhaustedError)
	assert.equal(starts.length, before, 'the seeder sends nothing either')
	assert.equal((await ledger.state('2026-10-21')).exhausted, true)
})

test('COOLDOWN: one Cloudflare 1015 pauses ALL callers ≥ 65 s; the 2nd breach stops the job for the day', async () => {
	const clock = new VirtualClock(START)
	const ledger = new MemoryLedger()
	const gate = createQuotaGate({ job: 'screener', config, ledger, clock, log: quiet })
	const starts: number[] = []
	let throttleAt = Infinity
	let throttleNext = 1 // the first request is throttled
	const fyers = async () => {
		starts.push(clock.now())
		await clock.sleep(150)
		if (throttleNext-- > 0) {
			throttleAt = clock.now()
			throw CLOUDFLARE
		}
		return 'ok'
	}
	await clock.run(Promise.all(Array.from({ length: 12 }, () => gate.call(fyers))))
	const later = starts.filter((t) => t >= throttleAt)
	assert.ok(later.length > 0)
	assert.ok(later.every((t) => t - throttleAt >= 65_000), `started during the cooldown: +${later.map((t) => t - throttleAt).join(',')} ms`)
	assert.equal((await ledger.state('2026-10-21')).breaches, 1)

	throttleNext = 1
	await assert.rejects(clock.run(gate.call(fyers)), BreachLimitError)
	const n = starts.length
	await assert.rejects(clock.run(gate.call(fyers)), BreachLimitError)
	assert.equal(starts.length, n, 'after the 2nd breach nothing more is sent (Fyers blocks the day after > 3)')
})

test('ALLOCATIONS: a job stops at its share; other jobs keep theirs; a new IST day starts fresh', async () => {
	const clock = new VirtualClock(START)
	const ledger = new MemoryLedger()
	const small: QuotaConfig = { ...config, allocations: { ...config.allocations, screener: 5 } }
	const screener = createQuotaGate({ job: 'screener', config: small, ledger, clock, log: quiet })
	const anomaly = createQuotaGate({ job: 'anomaly', config: small, ledger, clock, log: quiet })
	let calls = 0
	const fyers = async () => void calls++
	const r = await clock.run(Promise.allSettled(Array.from({ length: 8 }, () => screener.call(fyers))))
	assert.equal(calls, 5)
	assert.ok(r.slice(5).every((x) => x.status === 'rejected' && x.reason instanceof AllocationExhaustedError))
	await clock.run(anomaly.call(fyers))
	assert.equal(calls, 6, 'anomaly still has its allocation')
	clock.t = Date.parse('2026-10-21T18:31:00Z') // 00:01 IST on the 22nd
	await clock.run(screener.call(fyers))
	assert.equal(calls, 7, 'new day, new allocation')
})

test('one shared limiter: seeder + anomaly in the engine together stay within 40/min', async () => {
	const clock = new VirtualClock(START)
	const ledger = new MemoryLedger()
	const shared = createMultiWindowLimiter([{ max: 4, windowMs: 1000 }, { max: 40, windowMs: 60_000 }], clock)
	const a = createQuotaGate({ job: 'seeder', config, ledger, clock, limiter: shared, log: quiet })
	const b = createQuotaGate({ job: 'anomaly', config, ledger, clock, limiter: shared, log: quiet })
	const starts: number[] = []
	const f = async () => void starts.push(clock.now())
	await clock.run(Promise.all([...Array.from({ length: 50 }, () => a.call(f)), ...Array.from({ length: 50 }, () => b.call(f))]))
	assert.equal(maxInWindow(starts, 60_000), 40)
})

test('FileLedger (owner PC) persists across processes/nights; RedisLedger (EC2) has the same semantics', async () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-ledger-')), 'quota-ledger.json')
	await new FileLedger(file).add('2026-10-21', 'backtest', 7)
	await new FileLedger(file).breach('2026-10-21', 123)
	const s = await new FileLedger(file).state('2026-10-21')
	assert.deepEqual(s, { used: { backtest: 7 }, breaches: 1, exhausted: false, cooldownUntil: 123 })

	const h = new Map<string, Map<string, string>>()
	const ttl = new Map<string, number>()
	const fake: RedisLike = {
		hIncrBy: async (k, f, n) => {
			const m = h.get(k) ?? new Map()
			h.set(k, m)
			const v = Number(m.get(f) ?? 0) + n
			m.set(f, String(v))
			return v
		},
		hGetAll: async (k) => Object.fromEntries(h.get(k) ?? []),
		hSet: async (k, f, v) => {
			const m = h.get(k) ?? new Map()
			h.set(k, m)
			m.set(f, v)
			return 1
		},
		expire: async (k, s2) => (ttl.set(k, s2), true),
	}
	const r = new RedisLedger(fake)
	assert.equal(await r.add('2026-10-21', 'seeder', 3), 3)
	assert.equal(await r.add('2026-10-21', 'seeder', 2), 5)
	assert.equal(await r.breach('2026-10-21', 999), 1)
	await r.markExhausted('2026-10-21')
	assert.deepEqual(await r.state('2026-10-21'), { used: { seeder: 5 }, breaches: 1, exhausted: true, cooldownUntil: 999 })
	assert.equal(ttl.get('fyers:quota:2026-10-21'), 3 * 24 * 3600)
})

test('THROTTLE LOG: the warning and the stop error carry Fyers’ own error text', async () => {
	const clock = new VirtualClock(START)
	const ledger = new MemoryLedger()
	const warnings: string[] = []
	const gate = createQuotaGate({ job: 'seeder', config, ledger, clock, log: { warn: (m: string) => void warnings.push(m), error: () => {} } })
	const fyers = async () => {
		throw CLOUDFLARE
	}
	await assert.rejects(clock.run(gate.call(fyers)), (err: Error) => err instanceof BreachLimitError && /Error 1015: You are being rate limited/.test(err.message))
	assert.ok(warnings.length >= 1)
	for (const w of warnings) assert.match(w, /— Fyers said: .*Error 1015: You are being rate limited/)
})
