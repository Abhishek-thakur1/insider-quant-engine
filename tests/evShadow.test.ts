// ============================================================
// tests/evShadow.test.ts — the EV-reject shadow outcome (src/core/evShadow.ts) is observation only.
//
//   1. IDENTICAL: every worker scenario gives the same effects with the shadow on and off: filter
//      calls, trades registered (positions), Redis alert-policy operations, Telegram sends, admin
//      notices and console output. Only the shadow's own store is written, and only on EV rejects.
//   2. SAME RULES: on the same ticks, a shadow closes with the same exit price, reason and R as the
//      real positionTracker.processTick (fake Redis/Postgres, as in tests/removeFlagRace.test.ts).
//   3. SAME LEVELS: the pipeline registers computeTradeLevels' numbers, which the shadow also uses.
//   4. BOUNDS: daily cap, open limit, one open per symbol + detector + side, bad geometry skipped.
//   5. SEPARATE: nothing outside evShadow.ts and the migration names ev_shadow_outcomes, so no
//      stat, API endpoint or dashboard total can read it.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHANNEL_ID ??= '-1000000000000'
process.env.FYERS_APP_ID ??= 'TEST-APP-ID'
process.env.FYERS_SECRET_ID ??= 'test-secret'
process.env.FYERS_REDIRECT_URI ??= 'http://localhost:3000/callback'

const { runAlertPipeline } = await import('../src/workers/alertPipeline.js')
const { scenarios, equity, option, decision, makeDeps, captureRun, NOW } = await import('./helpers/workerScenarios.js')
const ev = await import('../src/core/evShadow.js')
const { computeTradeLevels } = await import('../src/core/tradeLevels.js')
const clock = await import('../backtest/core/clock.js')
const { redisClient } = await import('../src/config/redis.js')
const { pool } = await import('../src/config/db.js')
const { positionTracker } = await import('../src/core/positionTracker.js')

type Insert = import('../src/core/evShadow.js').ShadowInsert
const fakeStore = () => {
	const inserts: Insert[] = []
	const closes: { id: number; price: number; ts: number; reason: string; r: number | null }[] = []
	let next = 1
	const store: import('../src/core/evShadow.js').EvShadowStore = {
		insert: async (r) => (inserts.push(r), next++),
		close: async (id, e) => void closes.push({ id, ...e }),
		loadOpen: async () => [],
		markUnresolved: async () => 0,
		countToday: async () => 0,
	}
	return { store, inserts, closes }
}
const flush = () => new Promise((r) => setTimeout(r, 5))

test('IDENTICAL: every worker scenario has the same effects with the EV shadow on and off', async () => {
	for (const sc of scenarios) {
		const off: unknown[] = []
		const offFx = await captureRun(off as never, () => runAlertPipeline(sc.payload ?? equity, makeDeps(sc, off as never), null))
		const { store, inserts } = fakeStore()
		const tracker = new ev.EvShadowTracker(store, () => NOW, { log() {}, warn() {} })
		const on: unknown[] = []
		const deps = { ...makeDeps(sc, on as never), onEvRejected: (d: never, dec: never, id: string | null) => tracker.record(d, dec, id) }
		const onFx = await captureRun(on as never, () => runAlertPipeline(sc.payload ?? equity, deps, null))
		await flush()
		assert.deepEqual(onFx, offFx, `effects changed: ${sc.name}`)
		const isEv = sc.decision?.rejectedAt === 'EV'
		assert.equal(inserts.length, isEv ? 1 : 0, `shadow rows: ${sc.name}`)
	}
})

test('IDENTICAL: a shadow hook that throws changes nothing either', async () => {
	const sc = scenarios.find((s) => s.decision?.rejectedAt === 'EV' && !s.shadowMode)!
	const off: unknown[] = []
	const offFx = await captureRun(off as never, () => runAlertPipeline(sc.payload ?? equity, makeDeps(sc, off as never), null))
	const on: unknown[] = []
	const deps = { ...makeDeps(sc, on as never), onEvRejected: () => { throw new Error('boom') } }
	const onFx = await captureRun(on as never, () => runAlertPipeline(sc.payload ?? equity, deps, null))
	assert.deepEqual(onFx, offFx)
})

test('SAME LEVELS: the pipeline registers computeTradeLevels numbers (equity and option)', async () => {
	for (const payload of [equity, option]) {
		const sc = { ...scenarios[0]!, payload, decision: decision({ passed: true, score: 85 }) }
		const fx: unknown[][] = []
		await captureRun(fx as never, () => runAlertPipeline(payload, makeDeps(sc, fx as never), null))
		const reg = fx.find((e) => e[0] === 'registerTrade')?.[1] as { stopLoss: number; target: number; entryPrice: number }
		const lv = computeTradeLevels(payload)
		assert.ok(reg, `registered: ${payload.symbol}`)
		assert.deepEqual({ e: reg.entryPrice, s: reg.stopLoss, t: reg.target }, { e: lv.entry, s: lv.stopLoss, t: lv.target1 })
	}
})

// ── SAME RULES vs the real positionTracker ───────────────────────────────────
type Fn = (...a: never[]) => unknown
const patch = (obj: object, impl: Record<string, Fn>) => {
	const o = obj as Record<string, unknown>
	const saved = Object.fromEntries(Object.keys(impl).map((k) => [k, Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined]))
	Object.assign(o, impl)
	return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete o[k]; else o[k] = v } }
}

const paths: { name: string; side: 'LONG' | 'SHORT'; entry: number; stop: number; target: number; ticks: [number, number][] }[] = [
	{ name: 'LONG target', side: 'LONG', entry: 100, stop: 99, target: 101.5, ticks: [[600, 100.4], [601, 99.6], [605, 101.6]] },
	{ name: 'LONG stop', side: 'LONG', entry: 100, stop: 99, target: 101.5, ticks: [[600, 100.2], [602, 98.9]] },
	{ name: 'SHORT target', side: 'SHORT', entry: 200, stop: 201, target: 198.5, ticks: [[700, 199.9], [703, 198.4]] },
	{ name: 'SHORT stop', side: 'SHORT', entry: 200, stop: 201, target: 198.5, ticks: [[700, 200.5], [701, 201.2]] },
	{ name: 'TIME at 15:15', side: 'LONG', entry: 100, stop: 99, target: 101.5, ticks: [[900, 100.3], [914, 100.6], [915, 100.7]] },
	// exactly on the level: the <= / >= edges (review of 28 Oct)
	{ name: 'LONG exactly on stop', side: 'LONG', entry: 100, stop: 99, target: 101.5, ticks: [[610, 100.1], [611, 99]] },
	{ name: 'LONG exactly on target', side: 'LONG', entry: 100, stop: 99, target: 101.5, ticks: [[610, 100.1], [611, 101.5]] },
	{ name: 'SHORT exactly on stop', side: 'SHORT', entry: 200, stop: 201, target: 198.5, ticks: [[710, 200.2], [711, 201]] },
	{ name: 'SHORT exactly on target', side: 'SHORT', entry: 200, stop: 201, target: 198.5, ticks: [[710, 199.8], [711, 198.5]] },
]

test('SAME RULES: shadow exits match positionTracker.processTick on the same ticks (price, reason, R)', async () => {
	const updates: unknown[][] = []
	const restoreRedis = patch(redisClient, {
		hSet: (async () => 1) as Fn, hDel: (async () => 1) as Fn, publish: (async () => 0) as Fn,
		multi: (() => { const c = { hDel: () => c, lPush: () => c, incrByFloat: () => c, exec: async () => [] }; return c }) as Fn,
	})
	const restorePg = patch(pool, {
		query: (async (sql: string, params: unknown[]) => {
			if (/INSERT INTO paper_trades/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 }
			if (/SET exit_price/.test(sql)) updates.push(params)
			return { rows: [], rowCount: 1 }
		}) as Fn,
	})
	const quiet = { log: console.log, warn: console.warn }
	console.log = console.warn = () => {}
	try {
		for (const [i, p] of paths.entries()) {
			const day = '2026-10-27'
			const uninstall = clock.installVirtualClock(clock.istEpoch(day, 9 * 60 + 30))
			try {
				const sym = `NSE:RULES${i}-EQ`
				await positionTracker.registerTrade({
					id: `trade_${i}_${sym}_rules`, symbol: sym, side: p.side, entryPrice: p.entry, stopLoss: p.stop, target: p.target,
					timestamp: Date.now(), detectorName: 'Test', size: 1, actualSize: 1, durationClass: 'INTRADAY',
				})
				const { store, closes } = fakeStore()
				const tr = new ev.EvShadowTracker(store, () => Date.now(), { log() {}, warn() {} })
				// open a shadow with exactly these levels (an equity payload whose VWAP gives this stop is not needed: inject)
				;(tr as unknown as { add(x: unknown): void }).add({ id: 1, key: 'k', symbol: sym, trackedSymbol: sym, side: p.side, entry: p.entry, stop: p.stop, target: p.target, durationClass: 'INTRADAY' })
				const before = updates.length
				for (const [min, price] of p.ticks) {
					const ts = clock.istEpoch(day, min)
					clock.setVirtualNow(ts)
					await positionTracker.processTick(sym, { symbol: sym, price, volume: 1, timestamp: ts } as never)
					await tr.onTick(sym, price, ts)
				}
				const u = updates[before]!
				assert.equal(closes.length, 1, p.name)
				const c = closes[0]!
				assert.equal(c.price, u[0], `${p.name}: exit price`)
				assert.equal(c.ts, u[1], `${p.name}: exit time`)
				assert.equal(c.r, u[3], `${p.name}: R`)
				assert.equal(c.reason, u[4], `${p.name}: reason`)
			} finally {
				uninstall()
			}
		}
	} finally {
		Object.assign(console, quiet)
		restorePg()
		restoreRedis()
	}
})

test('OPTIONS: a Nifty option fire is evaluated on Nifty index ticks and flagged index_proxy', async () => {
	const { store, inserts, closes } = fakeStore()
	const t0 = clock.istEpoch('2026-10-27', 9 * 60 + 47)
	const tr = new ev.EvShadowTracker(store, () => t0, { log() {}, warn() {} })
	const lv = computeTradeLevels(option)
	tr.record(option, decision({ passed: false, rejectedAt: 'EV', score: 46, ev: -16 }), 'sig-1')
	await flush()
	assert.equal(inserts[0]!.trackedSymbol, ev.NIFTY_INDEX)
	assert.deepEqual(inserts[0]!.dataQuality, ['index_proxy'])
	assert.equal(inserts[0]!.signalId, 'sig-1')
	const hit = option.side === 'LONG' ? lv.target1 + 1 : lv.target1 - 1
	await tr.onTick(option.symbol, hit, t0 + 60_000) // option ticks never arrive; ignored anyway
	assert.equal(closes.length, 0)
	await tr.onTick(ev.NIFTY_INDEX, hit, t0 + 60_000)
	assert.equal(closes[0]!.reason, 'TARGET')
})

test('BOUNDS: daily cap, open limit, one open per symbol+detector+side, bad geometry skipped', async () => {
	const t0 = clock.istEpoch('2026-10-27', 10 * 60)
	const rej = decision({ passed: false, rejectedAt: 'EV', score: 40, ev: -3 })
	{
		const { store, inserts } = fakeStore()
		const tr = new ev.EvShadowTracker(store, () => t0, { log() {}, warn() {} })
		tr.record(equity, rej, null)
		tr.record(equity, rej, null) // same symbol + detector + side while open
		await flush()
		assert.equal(inserts.length, 1)
		assert.equal(tr.counts.skippedDuplicate, 1)
	}
	{
		const { store, inserts } = fakeStore()
		const tr = new ev.EvShadowTracker(store, () => t0, { log() {}, warn() {} })
		for (let i = 0; i < ev.EV_SHADOW_MAX_OPEN + 5; i++) tr.record({ ...equity, symbol: `NSE:OPEN${i}-EQ` }, rej, null)
		await flush()
		assert.equal(inserts.length, ev.EV_SHADOW_MAX_OPEN)
		assert.equal(tr.counts.skippedOpenLimit, 5)
	}
	{
		const { store, inserts } = fakeStore()
		const tr = new ev.EvShadowTracker(store, () => t0, { log() {}, warn() {} })
		// close each one at once so the open limit never binds: only the daily cap does
		for (let i = 0; i < ev.EV_SHADOW_DAILY_CAP + 7; i++) {
			const sym = `NSE:CAP${i}-EQ`
			tr.record({ ...equity, symbol: sym }, rej, null)
			await flush()
			await tr.onTick(sym, 0.01, t0 + 1000) // far below any LONG stop / above none: closes LONG by STOP_LOSS
			await tr.onTick(sym, 1e9, t0 + 1000) // closes a SHORT by STOP_LOSS
		}
		assert.equal(inserts.length, ev.EV_SHADOW_DAILY_CAP)
		assert.equal(tr.counts.skippedCap, 7)
	}
	{
		const { store, inserts } = fakeStore()
		const tr = new ev.EvShadowTracker(store, () => t0, { log() {}, warn() {} })
		const wrongSide = equity.side === 'LONG' ? { ...equity, vwap: equity.price * 1.01 } : { ...equity, vwap: equity.price * 0.99 }
		tr.record(wrongSide, rej, null) // stop on the wrong side of entry
		await flush()
		assert.equal(inserts.length, 0)
		assert.equal(tr.counts.skippedGeometry, 1)
	}
})

test('SEPARATE: only evShadow.ts and migration 0007 name ev_shadow_outcomes (no stat, API or dashboard reads it)', () => {
	const hits: string[] = []
	const walk = (dir: string) => {
		for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, f.name)
			if (f.isDirectory()) walk(p)
			else if (/\.(ts|sql|js)$/.test(f.name) && fs.readFileSync(p, 'utf8').includes('ev_shadow_outcomes')) hits.push(p.replace(/\\/g, '/'))
		}
	}
	walk('src')
	walk('db')
	assert.deepEqual(hits.sort(), ['db/migrations/0007_ev_shadow_outcomes.sql', 'src/core/evShadow.ts'])
})

test('OFF by default: no engine instance unless EV_SHADOW_ENABLED=true', () => {
	const prev = process.env.EV_SHADOW_ENABLED
	delete process.env.EV_SHADOW_ENABLED
	assert.equal(ev.evShadowEnabled(), false)
	assert.equal(ev.getEvShadow(), null)
	process.env.EV_SHADOW_ENABLED = 'true'
	assert.equal(ev.evShadowEnabled(), true)
	if (prev === undefined) delete process.env.EV_SHADOW_ENABLED
	else process.env.EV_SHADOW_ENABLED = prev
})

// ── Review of 28 Oct: isolation by construction, and the boot / restart edges ──────

test('ISOLATION: evShadow.ts imports only types and tradeLevels (no Redis, no positionTracker, no db pool)', () => {
	const src = fs.readFileSync('src/core/evShadow.ts', 'utf8')
	// [\s\S]*? also catches multi-line `import { a, b } from` forms; a dynamic import() is not allowed at all
	const imports = [...src.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)'/gm)].map((m) => ({ typeOnly: !!m[1], from: m[2] }))
	assert.equal(/\bimport\s*\(/.test(src), false, 'no dynamic import() in evShadow.ts')
	const runtime = imports.filter((i) => !i.typeOnly).map((i) => i.from)
	assert.deepEqual(runtime, ['./tradeLevels.js'])
	const lv = fs.readFileSync('src/core/tradeLevels.ts', 'utf8')
	assert.deepEqual([...lv.matchAll(/^import\s+(type\s+)?.*?from/gm)].filter((m) => !m[1]).length, 0, 'tradeLevels has no runtime imports')
})

test('ISOLATION: recording and closing a shadow never calls Redis or positionTracker', async () => {
	const calls: string[] = []
	const trap = (name: string) => (async () => { calls.push(name); throw new Error(`shadow touched ${name}`) }) as Fn
	const restoreRedis = patch(redisClient, { get: trap('redis.get'), set: trap('redis.set'), hSet: trap('redis.hSet'), hDel: trap('redis.hDel'), lPush: trap('redis.lPush'), incrByFloat: trap('redis.incrByFloat'), publish: trap('redis.publish'), multi: trap('redis.multi') })
	const restoreTracker = patch(positionTracker, { registerTrade: trap('tracker.registerTrade'), processTick: trap('tracker.processTick'), removeFlag: trap('tracker.removeFlag') })
	const restorePool = patch(pool, { query: trap('pool.query'), connect: trap('pool.connect') })
	try {
		const { store, inserts, closes } = fakeStore()
		const t0 = clock.istEpoch('2026-10-27', 10 * 60)
		const tr = new ev.EvShadowTracker(store, () => t0, { log() {}, warn() {} })
		tr.record(equity, decision({ passed: false, rejectedAt: 'EV', score: 40, ev: -3 }), null)
		await flush()
		await tr.onTick(equity.symbol, 0.01, t0 + 60_000)
		assert.equal(inserts.length, 1)
		assert.equal(closes.length, 1)
		assert.deepEqual(calls, [])
	} finally {
		restorePool()
		restoreTracker()
		restoreRedis()
	}
})

test('RESTART: the daily cap counts every row recorded today, closed ones included', async () => {
	const { store, inserts } = fakeStore()
	store.countToday = async () => ev.EV_SHADOW_DAILY_CAP - 2 // 48 already recorded (most closed) before a restart
	const t0 = clock.istEpoch('2026-10-27', 13 * 60)
	const tr = new ev.EvShadowTracker(store, () => t0, { log() {}, warn() {} })
	await tr.init()
	const rej = decision({ passed: false, rejectedAt: 'EV', score: 40, ev: -3 })
	for (let i = 0; i < 5; i++) tr.record({ ...equity, symbol: `NSE:RST${i}-EQ` }, rej, null)
	await flush()
	assert.equal(inserts.length, 2)
	assert.equal(tr.counts.skippedCap, 3)
})

test('BOOT: a hung or failing database at init never stalls boot; the tracker stays inactive for the day', async () => {
	const { store, inserts } = fakeStore()
	store.markUnresolved = () => new Promise<number>(() => {}) // hangs forever
	const tr = new ev.EvShadowTracker(store, () => clock.istEpoch('2026-10-27', 9 * 60), { log() {}, warn() {} })
	const t = Date.now()
	await tr.init(50)
	assert.ok(Date.now() - t < 1000, 'init returned promptly')
	tr.record(equity, decision({ passed: false, rejectedAt: 'EV', score: 40, ev: -3 }), null)
	await flush()
	assert.equal(inserts.length, 0, 'inactive after a failed init')
	const { store: s2 } = fakeStore()
	s2.markUnresolved = async () => { throw new Error('db down') }
	const tr2 = new ev.EvShadowTracker(s2, () => clock.istEpoch('2026-10-27', 9 * 60), { log() {}, warn() {} })
	await assert.doesNotReject(tr2.init())
})
