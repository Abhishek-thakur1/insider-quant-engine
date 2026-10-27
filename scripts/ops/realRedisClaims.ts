// Throwaway real-Redis check of the PR #22 duplicate-policy paths (owner request 2026-10-22).
// Runs ONLY against REDIS_URL (a local throwaway container), never the production Redis.
//   docker run -d --rm --name iqe-redis-throwaway -p 6390:6379 redis:7-alpine
//   REDIS_URL=redis://127.0.0.1:6390 npx tsx scripts/ops/realRedisClaims.ts
//   docker stop iqe-redis-throwaway
import { createClient } from 'redis'
import {
	COMPARE_AND_DELETE_LUA,
	COMPARE_AND_SET_LUA,
	SYMBOL_SIDE_COOLDOWN_MS,
	alertKeys,
	claimDetectorSlot,
	claimSymbolSide,
	countAlertSlot,
	symbolSideKeys,
	type AlertStore,
	type ClaimStore,
} from '../../src/workers/alertPolicy.js'
import { runAlertPipeline, type PipelineDeps } from '../../src/workers/alertPipeline.js'
import { newSignalDraft, buildSignalRow } from '../../src/db/signalRecord.js'
import type { OpenPosition } from '../../src/core/positionTracker.js'

const url = process.env.REDIS_URL
if (!url || !/127\.0\.0\.1:6390|localhost:6390/.test(url)) throw new Error('refusing: REDIS_URL must be the local throwaway container (127.0.0.1:6390)')
const REAL_LOG = console.log
const report = (...a: unknown[]) => REAL_LOG(...a)
const r = createClient({ url })
await r.connect()
await r.flushDb()
const info = (await r.info('server')).match(/redis_version:(\S+)/)?.[1]
console.log(`real Redis ${info} at ${url} (throwaway, flushed)\n`)

// Same adapter code as src/workers/telegramWorker.ts liveDeps.getClaimStore
const claims: ClaimStore = {
	get: (k) => r.get(k),
	set: (k, v, o) => r.set(k, v, o),
	compareAndSet: async (k, e, n, ttl) => Number(await r.eval(COMPARE_AND_SET_LUA, { keys: [k], arguments: [e, n, String(ttl)] })) === 1,
	compareAndDelete: async (k, e) => Number(await r.eval(COMPARE_AND_DELETE_LUA, { keys: [k], arguments: [e] })) === 1,
}
const alerts = r as unknown as AlertStore
let ok = 0
let bad = 0
const check = (cond: boolean, msg: string) => {
	report(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
	cond ? ok++ : bad++
}
const DAY = '2026-10-26'
const T0 = Date.parse('2026-10-26T05:00:00Z')

// 1. atomic first claim under concurrency
{
	const key = symbolSideKeys(DAY, 'LONG', 'NSE:RACE-EQ').alert
	const res = await Promise.all(Array.from({ length: 50 }, (_, i) => claimSymbolSide(claims, key, { ts: T0, positionId: `p${i}` }, () => false)))
	check(res.filter((x) => x.first).length === 1, `50 concurrent claims on one key → exactly 1 winner (got ${res.filter((x) => x.first).length})`)
	const ttl = await r.ttl(key)
	check(ttl > 36 * 3600 - 5 && ttl <= 36 * 3600, `claim TTL ≈ 36 h (TTL ${ttl} s)`)
}

// 2. live holder (position open) blocks; inside 60 min blocks; stale holder replaced atomically
{
	const key = symbolSideKeys(DAY, 'LONG', 'NSE:HOLD-EQ').alert
	await claimSymbolSide(claims, key, { ts: T0, positionId: 'holder' }, () => false)
	const openLater = await claimSymbolSide(claims, key, { ts: T0 + 3 * 3600_000, positionId: 'x' }, (id) => id === 'holder')
	check(!openLater.first, 'holder position still open 3 h later → duplicate')
	const within = await claimSymbolSide(claims, key, { ts: T0 + SYMBOL_SIDE_COOLDOWN_MS - 1, positionId: 'y' }, () => false)
	check(!within.first, 'holder closed, 59:59.999 later → duplicate (60-min window)')
	await r.expire(key, 100) // shorten, to see the takeover reset the TTL
	const later = T0 + SYMBOL_SIDE_COOLDOWN_MS + 1
	const res = await Promise.all(Array.from({ length: 20 }, (_, i) => claimSymbolSide(claims, key, { ts: later, positionId: `t${i}` }, () => false)))
	check(res.filter((x) => x.first).length === 1, `20 concurrent takeovers of a stale holder → exactly 1 winner via Lua compare-and-set (got ${res.filter((x) => x.first).length})`)
	const ttl = await r.ttl(key)
	check(ttl > 36 * 3600 - 5, `takeover reset the TTL to 36 h (TTL ${ttl} s)`)
}

// 3. compare-and-delete only removes the exact value
{
	const key = symbolSideKeys(DAY, 'SHORT', 'NSE:DEL-EQ').alert
	const mine = { ts: T0, positionId: 'mine' }
	await claimSymbolSide(claims, key, mine, () => false)
	check(!(await claims.compareAndDelete(key, JSON.stringify({ ts: T0, positionId: 'other' }))), 'compare-and-delete with another fire’s value → not deleted')
	check((await r.exists(key)) === 1, 'key still present')
	check(await claims.compareAndDelete(key, JSON.stringify(mine)), 'compare-and-delete with own value → deleted')
	check((await r.exists(key)) === 0, 'key gone')
	check(!(await claims.compareAndDelete(key, JSON.stringify(mine))), 'second delete of a missing key → false (no error)')
}

// 4. per-detector slot + cap on real Redis
{
	const k = alertKeys(DAY, 'VCP', 'NSE:CAP-EQ')
	const first = await Promise.all(Array.from({ length: 10 }, () => claimDetectorSlot(alerts, k)))
	check(first.filter(Boolean).length === 1, `10 concurrent per-detector claims → exactly 1 (got ${first.filter(Boolean).length})`)
	check((await r.ttl(k.dedup)) > 36 * 3600 - 5, `per-detector slot TTL 36 h (TTL ${await r.ttl(k.dedup)} s)`)
	await r.set(k.count, '19')
	const s20 = await countAlertSlot(alerts, k, 20)
	const s21 = await countAlertSlot(alerts, k, 20)
	check(s20.action === 'SEND' && s21.action === 'CAP_REACHED' && (s21 as { notifyCap: boolean }).notifyCap, `cap 20: 20th SEND, 21st CAP_REACHED with one admin notice (${s20.action}, ${s21.action})`)
	await r.del([k.count, k.dedup]) // section 5 starts with an empty day
}

// 5. release paths through the REAL pipeline on real Redis (pipeline log lines silenced; results via report())
console.log = console.warn = console.error = () => {}
const world = () => {
	const registered: OpenPosition[] = []
	const open = new Map<string, OpenPosition>()
	let failSends = false
	let notional = 0
	const sends: string[] = []
	const deps: PipelineDeps = {
		runFilter: async () => ({ passed: true, score: 85, posterior: 0.6, ev: 4, kellyHalf: 0.02, regime: 'TRENDING', entropy: 0.4, sizeMult: 1, breakdown: [], positionNote: '', shadowMode: false }),
		getTracker: async () => ({
			getCurrentNotional: () => notional,
			registerTrade: async (p) => (registered.push(p), open.set(p.id, p), registered.length),
			getOpenPositions: () => [...open.values()],
			removeFlag: async () => {},
		}),
		getAlertStore: async () => alerts,
		getClaimStore: async () => claims,
		sendChannel: async (t) => {
			if (failSends) throw new Error('telegram 400')
			sends.push(t)
		},
		sendAdmin: async () => {},
		now: () => T0 + 6 * 3600_000,
		config: { shadowMode: false, maxAlertsPerDay: 20, capitalBase: 100000, get capitalBehavior() { return 'SKIP' }, hasAdmin: false },
	}
	const fire = async (symbol: string, detectorName: string) => {
		const p = { symbol, price: 500, side: 'LONG' as const, percentageChange: 1, volumeSpikeRatio: 2, trigger: 'x | SL ₹496 | T1 ₹506', vwap: 499, avgPrice: 495, detectorName, regimeClass: 'MOMENTUM' as const, durationClass: 'INTRADAY' as const }
		const d = newSignalDraft(p, { signalId: crypto.randomUUID(), firedAt: T0, shadowMode: false })
		await runAlertPipeline(p, deps, d)
		return buildSignalRow(d, { threshold: 78, promotionSource: 'SCREENER' })
	}
	return { fire, sends, registered, setFail: (b: boolean) => (failSends = b), setNotional: (n: number) => (notional = n) }
}
const keysFor = async (sym: string) => (await r.keys(`*${sym}*`)).sort()
{
	const w = world()
	w.setFail(true)
	const a = await w.fire('NSE:SENDFAIL-EQ', 'VCP')
	check(a.alert_suppressed_reason === 'SEND_FAILED', `send failed → ${a.alert_suppressed_reason}`)
	const left = await keysFor('SENDFAIL')
	check(left.length === 0, `after SEND_FAILED: no alert:sym, paper:sym or alert:sent key left (${left.join(', ') || 'none'})`)
	w.setFail(false)
	const b = await w.fire('NSE:SENDFAIL-EQ', 'Momentum')
	check(b.alert_sent === true && (w.registered[1]!.dataQuality ?? []).length === 0, 'next fire alerts, paper row not flagged')
}
{
	const w = world()
	w.setNotional(100000) // no headroom, behaviour SKIP
	const a = await w.fire('NSE:CAPSKIP-EQ', 'VCP')
	check(a.alert_suppressed_reason === 'CAPITAL_SKIP', `capital skip → ${a.alert_suppressed_reason}`)
	const left = await keysFor('CAPSKIP')
	check(left.length === 0, `after CAPITAL_SKIP: paper claim released, no key left (${left.join(', ') || 'none'})`)
}
{
	const w = world()
	await r.set(`alert:count:2026-10-26`, '20')
	const a = await w.fire('NSE:CAPPED-EQ', 'VCP')
	check(a.alert_suppressed_reason === 'CAP_REACHED', `cap reached → ${a.alert_suppressed_reason}`)
	const left = await keysFor('CAPPED')
	check(left.length === 1 && left[0]!.startsWith('alert:sent:'), `after CAP_REACHED: only the per-detector slot kept, symbol + paper claims released (${left.join(', ')})`)
	await r.del('alert:count:2026-10-26')
}
{
	const w = world()
	const [a, b] = await Promise.all([w.fire('NSE:PAIR-EQ', 'Stock Momentum Breakout'), w.fire('NSE:PAIR-EQ', 'Volatility_Contraction_V2')])
	check(w.sends.length === 1, `concurrent pair → exactly 1 Telegram alert (got ${w.sends.length})`)
	check([a, b].filter((x) => x.alert_suppressed_reason === 'DUPLICATE').length === 1, 'the other is DUPLICATE')
	const left = await keysFor('PAIR')
	report(`      keys held after the pair: ${left.join(', ')}`)
	for (const k of left) report(`      ${k}  TTL ${await r.ttl(k)} s  = ${await r.get(k)}`)
}

console.log(`\n${ok} PASS, ${bad} FAIL`)
await r.flushDb()
await r.quit()
process.exit(bad ? 1 : 0)
