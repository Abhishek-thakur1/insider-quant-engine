// ============================================================
// tests/bt6m.test.ts — the 6-month backtest tooling (backtest/bt6m), backtest-only
//
// Proves the guarantees the owner set (10 Nov): the live pipeline runs unchanged in the harness, the same-bar
// rule takes the stop first, the fetch never exceeds its manifest, cap or window and stops on auth / throttle
// errors, and the parity gate's matching rule. No network, no Redis server, no Postgres.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHANNEL_ID ??= '-1000000000000'
process.env.FYERS_APP_ID ??= 'TEST-APP-ID'
process.env.FYERS_SECRET_ID ??= 'test-secret'
process.env.FYERS_REDIRECT_URI ??= 'http://localhost:3000/callback'
process.env.BACKTEST_MODE = 'true'
process.env.SHADOW_MODE = 'true'

const clock = await import('../backtest/core/clock.js')
const { installMemoryRedis } = await import('../backtest/core/memoryRedis.js')
const { redisClient } = await import('../src/config/redis.js')
const { COMPARE_AND_SET_LUA, COMPARE_AND_DELETE_LUA } = await import('../src/workers/alertPolicy.js')
const { MemoryPaperTrades, installMemoryPg } = await import('../backtest/bt6m/memoryPg.js')
const { barPath, sameBarSide, levelsBetween, reorderAfterOpen, runLiveSession } = await import('../backtest/bt6m/liveSession.js')
const { windowsOf, buildManifest } = await import('../backtest/bt6m/fetchPlan.js')
const { runFetch, StopRun, safeErr, istParts } = await import('../backtest/bt6m/fetchRun.js')
const { matchFires } = await import('../backtest/bt6m/parity.js')
const { MemoryLedger, loadQuotaConfig } = await import('../src/fyers/quota.js')
const { syntheticSession, syntheticIndexSession } = await import('../backtest/fixtures/synthetic.js')
const { NIFTY_SYMBOL } = await import('../backtest/config.js')

const bar = (o: number, h: number, l: number, c: number, t = 0, v = 400) => ({ t, o, h, l, c, v })

// ── memory Redis: the commands added for the live pipeline ──────────────────
test('memoryRedis: SET NX/EX against the virtual clock, counters, hashes, multi', async () => {
	const { uninstall } = installMemoryRedis()
	const off = clock.installVirtualClock(1_000_000)
	try {
		const r = redisClient as unknown as {
			set(k: string, v: string, o?: { NX?: boolean; EX?: number }): Promise<string | null>
			get(k: string): Promise<string | null>
			incr(k: string): Promise<number>
			decr(k: string): Promise<number>
			incrByFloat(k: string, n: number): Promise<number>
			hSet(k: string, f: string, v: string): Promise<number>
			hGet(k: string, f: string): Promise<string | null>
			hKeys(k: string): Promise<string[]>
			publish(c: string, m: string): Promise<number>
			multi(): { hDel(k: string, f: string): unknown; incrByFloat(k: string, n: number): unknown; exec(): Promise<unknown[]> }
		}
		assert.equal(await r.set('k', 'a', { NX: true, EX: 10 }), 'OK')
		assert.equal(await r.set('k', 'b', { NX: true, EX: 10 }), null, 'NX refuses an existing key')
		clock.setVirtualNow(1_000_000 + 10_001)
		assert.equal(await r.get('k'), null, 'EX expires on the virtual clock')
		assert.equal(await r.incr('n'), 1)
		assert.equal(await r.decr('n'), 0)
		assert.equal(await r.incrByFloat('f', 1.5), 1.5)
		assert.equal(await r.hSet('h', 'x', '1'), 1)
		assert.equal(await r.hGet('h', 'x'), '1')
		assert.deepEqual(await r.hKeys('h'), ['x'])
		const m = r.multi()
		m.hDel('h', 'x')
		m.incrByFloat('f', -0.5)
		await m.exec()
		assert.equal(await r.hGet('h', 'x'), null)
		assert.equal(await r.get('f'), '1')
		assert.equal(await r.publish('sse:events', 'x'), 0)
	} finally {
		off()
		uninstall()
	}
})

test('memoryRedis: eval runs only the two alert-policy scripts, with their semantics', async () => {
	const { uninstall } = installMemoryRedis()
	const off = clock.installVirtualClock(5_000)
	try {
		const r = redisClient as unknown as { set(k: string, v: string): Promise<unknown>; get(k: string): Promise<string | null>; eval(s: string, o: { keys: string[]; arguments: string[] }): Promise<number> }
		await r.set('c', 'one')
		assert.equal(await r.eval(COMPARE_AND_SET_LUA, { keys: ['c'], arguments: ['nope', 'two', '60'] }), 0)
		assert.equal(await r.eval(COMPARE_AND_SET_LUA, { keys: ['c'], arguments: ['one', 'two', '60'] }), 1)
		assert.equal(await r.get('c'), 'two')
		assert.equal(await r.eval(COMPARE_AND_DELETE_LUA, { keys: ['c'], arguments: ['one'] }), 0)
		assert.equal(await r.eval(COMPARE_AND_DELETE_LUA, { keys: ['c'], arguments: ['two'] }), 1)
		assert.equal(await r.get('c'), null)
		await assert.rejects(r.eval('return 1', { keys: ['c'], arguments: [] }), /unsupported script/)
	} finally {
		off()
		uninstall()
	}
})

// ── memory Postgres: the tracker's statements only ──────────────────────────
test('memoryPg: insert → close → flag removal; anything else is recorded as unknown', async () => {
	const pg = new MemoryPaperTrades()
	const ins = await pg.query(
		`INSERT INTO paper_trades (
			symbol, detector, direction, entry_price, entry_time, stop_price, target_price, status, regime_class, gated, qty, capital_gated, actual_size, duration_class, data_quality
		) VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7, $14, $8, $9, $10, $11, $12, $13, $15)
		RETURNING id`,
		['NSE:X-EQ', 'D', 'LONG', 100, 1, 99, 101.5, 'MOMENTUM', true, 10, false, 10, 'INTRADAY', 'OPEN', ['duplicate_signal']],
	)
	assert.deepEqual(ins.rows, [{ id: 1 }])
	await pg.query(`UPDATE paper_trades SET data_quality = array_remove(data_quality, $1) WHERE id = $2`, ['duplicate_signal', 1])
	await pg.query(
		`UPDATE paper_trades
		 SET exit_price = $1, exit_time = to_timestamp($2 / 1000.0), realized_pnl = $3, r_multiple = $4, exit_reason = $5,
		     status = CASE WHEN status = 'SKIPPED' THEN 'SKIPPED' ELSE 'CLOSED' END
		 WHERE id = $6 AND status IN ('OPEN', 'SKIPPED')`,
		[99, 2, -10, -1, 'STOP_LOSS', 1],
	)
	assert.equal(pg.rows[0]!.status, 'CLOSED')
	assert.equal(pg.rows[0]!.r_multiple, -1)
	assert.deepEqual(pg.rows[0]!.data_quality, [])
	await pg.query('SELECT 1')
	assert.equal(pg.unknown.length, 1)
	const { uninstall } = installMemoryPg()
	assert.throws(() => installMemoryPg(), /already installed/)
	uninstall()
})

// ── same-bar rule and level ticks ───────────────────────────────────────────
test('same-bar rule: a bearish bar holding a LONG stop and target goes to the stop first', () => {
	const b = bar(100, 102, 98, 99) // bearish: the default path is O→H→L→C (target before stop for a LONG)
	const pos = [{ side: 'LONG' as const, stopLoss: 98.5, target: 101.5 }]
	assert.equal(sameBarSide(b, pos), 'LONG')
	assert.deepEqual(barPath(b, sameBarSide(b, pos)).map((t) => t.price), [100, 98, 102, 99])
	assert.deepEqual(barPath(b, null).map((t) => t.price), [100, 102, 98, 99], 'no position: the harness default path')
	assert.equal(sameBarSide(bar(100, 101, 99.9, 100.5), pos), null, 'only one level inside the bar')
	const short = [{ side: 'SHORT' as const, stopLoss: 101.5, target: 98.5 }]
	assert.deepEqual(barPath(bar(100, 102, 98, 101), sameBarSide(bar(100, 102, 98, 101), short)).map((t) => t.price), [100, 102, 98, 101])
})

test('level ticks: the levels strictly between two prices, in the order price passes them', () => {
	const pos = [{ stopLoss: 98.5, target: 101.5 }]
	assert.deepEqual(levelsBetween(100, 97, pos), [98.5])
	assert.deepEqual(levelsBetween(97, 103, pos), [98.5, 101.5])
	assert.deepEqual(levelsBetween(103, 97, pos), [101.5, 98.5])
	assert.deepEqual(levelsBetween(100, 100.5, pos), [])
	assert.deepEqual(levelsBetween(98.5, 97, pos), [], 'a price AT the level is not between')
})

// ── the manifest ────────────────────────────────────────────────────────────
test('manifest: windows under 100 calendar days, cached sessions skipped, stage split, cap enforced', () => {
	assert.deepEqual(windowsOf(['2026-05-11', '2026-08-18', '2026-08-19']), [
		{ from: '2026-05-11', to: '2026-08-18', sessions: 2 },
		{ from: '2026-08-19', to: '2026-08-19', sessions: 1 },
	])
	const need = new Map([
		['NSE:A-EQ', ['2026-05-11', '2026-11-04', '2026-11-05']],
		['NSE:B-EQ', ['2026-06-01', '2026-11-09']],
	])
	const cached = (s: string) => new Set(s === 'NSE:B-EQ' ? ['2026-06-01'] : [])
	const a = buildManifest(need, cached, 'A', 159, 'x')
	assert.deepEqual(a.items.map((i) => [i.symbol, i.from, i.to]), [['NSE:A-EQ', '2026-11-04', '2026-11-05'], ['NSE:B-EQ', '2026-11-09', '2026-11-09']])
	const b = buildManifest(need, cached, 'B', 10, 'x')
	assert.deepEqual(b.items.map((i) => [i.symbol, i.from]), [['NSE:A-EQ', '2026-05-11']], 'B skips Stage A days and cached days')
	assert.throws(() => buildManifest(need, cached, 'A', 1, 'x'), /over the cap/)
})

// ── the capped fetch ────────────────────────────────────────────────────────
const IST_1620_16NOV = Date.parse('2026-11-16T10:50:00Z') // 16:20 IST
const fakeClock = (start: number) => {
	let t = start
	return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) }
}
const manifest = (n: number) => ({ stage: 'A' as const, createdAt: 'x', resolution: '1' as const, cap: 159, items: Array.from({ length: n }, (_, i) => ({ n: i + 1, symbol: `NSE:S${i}-EQ`, from: '2026-11-04', to: '2026-11-09', sessions: 4 })) })
const baseOpts = (n: number, history: (req: unknown) => Promise<{ s: string; candles?: unknown[][]; code?: number; message?: string }>, c = fakeClock(IST_1620_16NOV)) => {
	const done = new Set<number>()
	return {
		manifest: manifest(n),
		maxRequests: 159,
		window: { date: '2026-11-16', fromMin: 16 * 60 + 15, toMin: 17 * 60 },
		history,
		ledger: new MemoryLedger(),
		quota: loadQuotaConfig(),
		done,
		onBars: () => {},
		onDone: (i: { n: number }) => void done.add(i.n),
		log: () => {},
		now: c.now,
		sleep: c.sleep,
	}
}
const ok = async () => ({ s: 'ok', candles: [[1_793_000_000, 1, 2, 0.5, 1.5, 100]] })

test('fetch: refuses outside the approved window and sends nothing', async () => {
	let calls = 0
	const o = { ...baseOpts(3, async () => (calls++, ok())), now: () => Date.parse('2026-11-16T10:40:00Z') } // 16:10 IST
	await assert.rejects(runFetch(o), StopRun)
	assert.equal(calls, 0)
	const late = { ...baseOpts(3, async () => (calls++, ok())), now: () => Date.parse('2026-11-16T11:30:00Z') } // 17:00 IST
	await assert.rejects(runFetch(late), StopRun)
	const otherDay = { ...baseOpts(3, async () => (calls++, ok())), now: () => Date.parse('2026-11-17T10:50:00Z') }
	await assert.rejects(runFetch(otherDay), StopRun)
	assert.equal(calls, 0)
})

test('fetch: never sends more than the hard cap, and the cap cannot exceed the manifest cap', async () => {
	let calls = 0
	const r = await runFetch({ ...baseOpts(10, async () => (calls++, ok())), maxRequests: 4 })
	assert.equal(calls, 4)
	assert.equal(r.sent, 4)
	assert.match(r.stopped, /hard cap/)
	await assert.rejects(runFetch({ ...baseOpts(3, ok), maxRequests: 160 }), StopRun)
})

test('fetch: the manifest completes, and resumes past finished items', async () => {
	let calls = 0
	const o = baseOpts(5, async () => (calls++, ok()))
	o.done.add(1)
	o.done.add(2)
	const r = await runFetch(o)
	assert.equal(calls, 3)
	assert.equal(r.stopped, 'manifest complete')
})

test('fetch: stops at once on an auth error', async () => {
	let calls = 0
	const r = await runFetch(baseOpts(5, async () => (calls++, { s: 'error', code: -16, message: 'Could not authenticate' })))
	assert.equal(calls, 1)
	assert.match(r.stopped, /auth error/)
})

test('fetch: the first throttle stops the run (no retry)', async () => {
	let calls = 0
	const r = await runFetch(baseOpts(5, async () => (calls++, { s: 'error', code: 429, message: 'request limit reached' })))
	assert.equal(calls, 1)
	assert.match(r.stopped, /quota gate stop|throttled/)
})

test('fetch: another failure is retried once, then the run stops', async () => {
	let calls = 0
	const r = await runFetch(baseOpts(5, async () => (calls++, { s: 'error', code: -50, message: 'bad request' })))
	assert.equal(calls, 2)
	assert.match(r.stopped, /failed twice/)
})

test('fetch: the window end stops the run between requests', async () => {
	const c = fakeClock(Date.parse('2026-11-16T11:29:59Z')) // 16:59:59 IST
	let calls = 0
	const r = await runFetch({ ...baseOpts(5, async () => (calls++, c.advance(2000), ok()), c) })
	assert.equal(calls, 1)
	assert.match(r.stopped, /window ended/)
})

test('fetch: logged errors carry only a code, never the message (which could echo a credential)', () => {
	assert.equal(safeErr({ code: -16, message: 'token abc.def invalid' }), 'code=-16 (auth)')
	assert.equal(safeErr(new Error('secret-ish text')), 'code=n/a')
})

test('fetch: the cap is per stage across runs (earlier sends count, failed ones included)', async () => {
	let calls = 0
	const totals: number[] = []
	const r = await runFetch({ ...baseOpts(10, async () => (calls++, ok())), sentBefore: 157, onSent: (t: number) => void totals.push(t) })
	assert.equal(calls, 2, '157 + 2 = 159')
	assert.deepEqual(totals, [158, 159], 'the running total is reported before each send')
	assert.match(r.stopped, /hard cap/)
	let none = 0
	const r2 = await runFetch({ ...baseOpts(10, async () => (none++, ok())), sentBefore: 159 })
	assert.equal(none, 0)
	assert.match(r2.stopped, /already used/)
})

test('fetch: a REJECTED request (how the SDK reports HTTP 429) goes through the gate: breach recorded, no retry, stop', async () => {
	let calls = 0
	const o = baseOpts(5, async () => {
		calls++
		throw Object.assign(new Error('request limit reached'), { code: 429 })
	})
	const r = await runFetch(o)
	assert.equal(calls, 1)
	assert.match(r.stopped, /quota gate stop|throttled/)
	const st = await o.ledger.state(istParts(IST_1620_16NOV).date)
	assert.equal(st.breaches, 1, 'the ledger saw the throttle, so a same-day re-run is blocked by the gate')
})

test('fetch: refuses a manifest that is not the fixed Stage A one, and an unapproved date', async () => {
	const m = manifest(2)
	await assert.rejects(runFetch({ ...baseOpts(2, ok), manifest: { ...m, cap: 160 } }), /stage cap/)
	await assert.rejects(runFetch({ ...baseOpts(2, ok), manifest: { ...m, items: [{ ...m.items[0]!, from: '2026-10-01' }] } }), /outside the Stage A/)
	await assert.rejects(runFetch({ ...baseOpts(2, ok), manifest: { ...m, stage: 'B' as never } }), /stage cap|overlaps/)
	await assert.rejects(runFetch({ ...baseOpts(2, ok), window: { date: '2026-11-17', fromMin: 16 * 60 + 15, toMin: 17 * 60 } }), /not an approved date/)
})

test('fetch: a save failure stops the run instead of re-sending a request that succeeded', async () => {
	let calls = 0
	const o = { ...baseOpts(3, async () => (calls++, ok())), onBars: () => { throw new Error('disk full') } }
	const r = await runFetch(o)
	assert.equal(calls, 1)
	assert.match(r.stopped, /could not be saved/)
})

// ── the parity gate ─────────────────────────────────────────────────────────
test('parity: same detector, symbol and side within ±60 s; pass needs ≥80% matched and |median Δscore| ≤ 3', () => {
	const f = (t: number, score: number, sym = 'NSE:A-EQ', det = 'D') => ({ detector: det, symbol: sym, direction: 'LONG', t, score, alerted: false, date: '2026-11-04' })
	const live = [f(0, 70), f(100_000, 72), f(200_000, 60, 'NSE:B-EQ'), f(300_000, 50), f(400_000, 55)]
	const bt = [f(30_000, 71), f(100_000, 73), f(200_000, 61, 'NSE:B-EQ'), f(390_000, 56), f(500_000, 90)]
	const m = matchFires(live, bt)
	assert.equal(m.matched, 4, 'the fire at 300 s has no backtest fire within 60 s')
	assert.equal(m.matchShare, 0.8)
	assert.equal(m.scoreDiffMedian, 1)
	assert.equal(m.extraBacktest.length, 1)
	assert.equal(m.pass, true)
	assert.equal(matchFires(live, bt.map((b) => ({ ...b, score: b.score! + 10 }))).pass, false, 'a systematic score offset fails')
	assert.equal(matchFires(live, bt.slice(0, 2)).pass, false, 'under 80% matched fails')
})

// ── the live pipeline + the LIVE position tracker: levels, same-bar rule, 15:15 timer ──
test('live tracker: an alerted LONG fills its stop AT the stop (stop first when both levels are in one bar); targets and the 15:15 timer close as live', async () => {
	const { runAlertPipeline } = await import('../src/workers/alertPipeline.js')
	const { decision, equity } = await import('./helpers/workerScenarios.js')
	const { livePipelineDeps, trackerStep, resetTracker } = await import('../backtest/bt6m/liveSession.js')
	const { positionTracker } = await import('../src/core/positionTracker.js')
	const DATE = '2026-03-03'
	const { uninstall } = installMemoryRedis()
	const { store: paper, uninstall: unPg } = installMemoryPg()
	const off = clock.installVirtualClock(clock.istEpoch(DATE, 10 * 60 + 30))
	const log = console.log
	console.log = () => {}
	try {
		resetTracker()
		let sent = 0
		const deps = livePipelineDeps({ config: { capitalBase: 100_000, capitalBehavior: 'REDUCE' }, onChannel: () => void sent++, onAdmin: () => {}, runFilter: async () => decision() })
		const t0 = clock.istEpoch(DATE, 10 * 60 + 30)
		// equity: entry 500, vwap 499 → live stop 498.00 (vwap × 0.998), T1 503.00 (1.5 R)
		await runAlertPipeline({ ...equity, symbol: 'NSE:AAA-EQ' }, deps)
		await runAlertPipeline({ ...equity, symbol: 'NSE:BBB-EQ' }, deps)
		await runAlertPipeline({ ...equity, symbol: 'NSE:CCC-EQ' }, deps)
		assert.equal(sent, 3, 'all three alerted through the live pipeline')
		assert.deepEqual(paper.rows.map((r) => [r.stop_price, r.target_price]), [[498, 503], [498, 503], [498, 503]])
		const lastPx = new Map([['NSE:AAA-EQ', 500], ['NSE:BBB-EQ', 500], ['NSE:CCC-EQ', 500]])
		const feed = async (sym: string, b: ReturnType<typeof bar>) => {
			for (const t of barPath(b, sameBarSide(b, (await import('../backtest/bt6m/liveSession.js')).openOf(sym)))) {
				clock.setVirtualNow(t.timestamp)
				await trackerStep(sym, t.price, t.timestamp, lastPx)
			}
		}
		// AAA: a bearish bar holding both levels → STOP first, filled at 498 (not the bar low 496)
		await feed('NSE:AAA-EQ', bar(501, 504, 496, 499, t0 + 60_000))
		// BBB: a bar reaching only the target → TARGET at 503 (not the bar high 505)
		await feed('NSE:BBB-EQ', bar(501, 505, 500.5, 504, t0 + 60_000))
		// CCC: nothing hit; at 15:15 the live timer closes it at its last price
		await feed('NSE:CCC-EQ', bar(500, 501, 499.5, 500.8, clock.istEpoch(DATE, 15 * 60 + 14)))
		positionTracker.notePrice('NSE:CCC-EQ', 500.8, clock.istEpoch(DATE, 15 * 60 + 14) + 45_000)
		clock.setVirtualNow(clock.istEpoch(DATE, 15 * 60 + 15))
		await positionTracker.squareOffSweep(clock.istEpoch(DATE, 15 * 60 + 15))
		const by = Object.fromEntries(paper.rows.map((r) => [r.symbol, r]))
		assert.equal(by['NSE:AAA-EQ']!.exit_reason, 'STOP_LOSS')
		assert.equal(by['NSE:AAA-EQ']!.exit_price, 498)
		assert.equal(by['NSE:AAA-EQ']!.r_multiple, -1)
		assert.equal(by['NSE:BBB-EQ']!.exit_reason, 'TARGET')
		assert.equal(by['NSE:BBB-EQ']!.exit_price, 503)
		assert.equal(by['NSE:BBB-EQ']!.r_multiple, 1.5)
		assert.equal(by['NSE:CCC-EQ']!.exit_reason, 'TIME')
		assert.equal(by['NSE:CCC-EQ']!.exit_price, 500.8)
		assert.equal(paper.unknown.length, 0)
	} finally {
		console.log = log
		resetTracker()
		off()
		unPg()
		uninstall()
	}
})

// ── end to end through runLiveSession: a known fire per symbol, every fill rule ──
test('live session end to end: gap-through fills at the open, same-bar rule on the entry bar, circuit lock, 15:15 TIME', async () => {
	const { sendTelegramAlert } = await import('../src/workers/telegramWorker.js')
	const { decision, equity } = await import('./helpers/workerScenarios.js')
	const DATE = '2026-03-04'
	const T = (hhmm: number) => clock.istEpoch(DATE, Math.floor(hhmm / 100) * 60 + (hhmm % 100))
	const at10 = T(1000)
	// Flat 500 all session; each symbol's own bars from 10:00 shape its scenario. Entry 500, vwap 499 → stop 498, T1 503.
	const flat = (t: number, p = 500) => bar(p, p + 0.2, p - 0.2, p, t, 1000)
	const session = (custom: Record<number, ReturnType<typeof bar>>) => {
		const out: ReturnType<typeof bar>[] = []
		for (let m = 9 * 60 + 15; m < 15 * 60 + 30; m++) {
			const t = clock.istEpoch(DATE, m)
			out.push(custom[t] ?? flat(t))
		}
		return out
	}
	const bars = new Map<string, ReturnType<typeof bar>[]>([
		[NIFTY_SYMBOL, syntheticIndexSession(DATE)],
		// GAP: the 10:01 candle opens at 496, through the 498 stop → STOP filled at the open (496), not at 498.
		['NSE:GAP-EQ', session({ [at10]: bar(500, 500.5, 499.5, 500.2, at10, 1000), [T(1001)]: bar(496, 497, 495, 496.5, T(1001), 1000) })],
		// ENTRY BAR: entered on the open of a bearish candle holding both levels → STOP at 498 (default path would hit 503 first).
		['NSE:ENTRY-EQ', session({ [at10]: bar(500, 504, 497, 499, at10, 1000) })],
		// LOCK: 10:01 is circuit-locked at 490 (no fill), 10:02 opens at 491 → STOP at 491.
		['NSE:LOCK-EQ', session({ [at10]: bar(500, 500.5, 499.5, 500.2, at10, 1000), [T(1001)]: bar(490, 490, 490, 490, T(1001), 5000), [T(1002)]: bar(491, 492, 490.5, 491.5, T(1002), 1000) })],
		// TIME: nothing hit → the 15:15 timer closes at the 15:14 close (500).
		['NSE:TIME-EQ', session({})],
	])
	class FireOnceAt10 {
		name = 'Test Fire'
		private fired = false
		constructor(public symbol: string) {}
		async analyze(tick: { price: number; timestamp: number }): Promise<void> {
			if (this.fired || tick.timestamp < at10) return
			this.fired = true
			await sendTelegramAlert({ ...equity, symbol: this.symbol, price: tick.price, vwap: 499, detectorName: 'Stock Momentum Breakout' })
		}
	}
	const { uninstall } = installMemoryRedis()
	const { store: paper, uninstall: unPg } = installMemoryPg()
	const off = clock.installVirtualClock(clock.istEpoch(DATE, 9 * 60))
	const log = console.log
	console.log = () => {}
	try {
		const r = await runLiveSession({
			sessionDate: DATE,
			barsBySymbol: bars,
			entries: ['NSE:GAP-EQ', 'NSE:ENTRY-EQ', 'NSE:LOCK-EQ', 'NSE:TIME-EQ'].map((symbol) => ({ symbol, group: 'core' as const })),
			paper,
			config: { capitalBase: 100_000, capitalBehavior: 'REDUCE' },
			testHooks: { equityStack: (s) => [new FireOnceAt10(s)], runFilter: async () => decision() },
		})
		console.log = log
		assert.deepEqual(r.errors, [])
		assert.equal(paper.unknown.length, 0)
		// The stub filter passes every fire, so a synthetic Nifty fire may add an option row: only the -EQ rows are checked.
		const eq = r.paper.filter((p) => p.symbol.endsWith('-EQ'))
		assert.equal(eq.length, 4, 'one paper trade per test symbol, through runAlertPipeline')
		assert.equal(r.signals.filter((s) => String(s.symbol).endsWith('-EQ') && s.alert_sent === true).length, 4, 'all four alerted')
		const by = Object.fromEntries(eq.map((p) => [p.symbol, p]))
		for (const p of eq) assert.deepEqual([p.entry_price, p.stop_price, p.target_price, p.status], [500, 498, 503, 'CLOSED'], p.symbol)
		assert.deepEqual([by['NSE:GAP-EQ']!.exit_reason, by['NSE:GAP-EQ']!.exit_price], ['STOP_LOSS', 496], 'gap through the stop fills at the open')
		assert.deepEqual([by['NSE:ENTRY-EQ']!.exit_reason, by['NSE:ENTRY-EQ']!.exit_price], ['STOP_LOSS', 498], 'stop first on the entry bar')
		assert.deepEqual([by['NSE:LOCK-EQ']!.exit_reason, by['NSE:LOCK-EQ']!.exit_price], ['STOP_LOSS', 491], 'no fill on the locked bar')
		assert.equal(by['NSE:LOCK-EQ']!.exit_time, T(1002), 'filled on the bar after the lock')
		assert.deepEqual([by['NSE:TIME-EQ']!.exit_reason, by['NSE:TIME-EQ']!.exit_price], ['TIME', 500])
		assert.ok(r.stillOpenSymbols.every((s) => !s.endsWith('-EQ')), 'no equity position left open')
	} finally {
		console.log = log
		off()
		unPg()
		uninstall()
	}
})

test('gap-through: a candle opening beyond the TARGET fills at the open too', async () => {
	const { trackerStep, resetTracker, openOf } = await import('../backtest/bt6m/liveSession.js')
	const { runAlertPipeline } = await import('../src/workers/alertPipeline.js')
	const { decision, equity } = await import('./helpers/workerScenarios.js')
	const { livePipelineDeps } = await import('../backtest/bt6m/liveSession.js')
	const DATE = '2026-03-05'
	const { uninstall } = installMemoryRedis()
	const { store: paper, uninstall: unPg } = installMemoryPg()
	const off = clock.installVirtualClock(clock.istEpoch(DATE, 10 * 60))
	const log = console.log
	console.log = () => {}
	try {
		resetTracker()
		await runAlertPipeline({ ...equity, symbol: 'NSE:UP-EQ' }, livePipelineDeps({ config: { capitalBase: 100_000, capitalBehavior: 'REDUCE' }, onChannel: () => {}, onAdmin: () => {}, runFilter: async () => decision() }))
		assert.equal(openOf('NSE:UP-EQ').length, 1)
		const lastPx = new Map<string, number>() // the runner deletes lastPx at a bar's open: same state here
		await trackerStep('NSE:UP-EQ', 505, clock.istEpoch(DATE, 10 * 60 + 1), lastPx)
		assert.deepEqual([paper.rows[0]!.exit_reason, paper.rows[0]!.exit_price], ['TARGET', 505])
	} finally {
		console.log = log
		resetTracker()
		off()
		unPg()
		uninstall()
	}
})

test('same-bar tie-break and entry-bar reorder', () => {
	const L = { side: 'LONG' as const, stopLoss: 98, target: 103 }
	const S = { side: 'SHORT' as const, stopLoss: 101, target: 97 }
	assert.equal(sameBarSide(bar(100, 104, 96, 99), [L, S]), 'SHORT', 'both inside: the stop nearest the open (101) goes first')
	assert.deepEqual(reorderAfterOpen([100, 104, 96, 99], [L]), [100, 96, 104, 99], 'LONG opened on the open tick: low before high')
	assert.deepEqual(reorderAfterOpen([100, 96, 104, 101], [S]), [100, 104, 96, 101], 'SHORT: high before low')
	assert.deepEqual(reorderAfterOpen([100, 100.5, 99.5, 100], [L]), [100, 100.5, 99.5, 100], 'levels not both inside: unchanged')
})

// ── end to end: a synthetic session through the live pipeline ───────────────
test('live session: fires go through runAlertPipeline, the tracker closes equity positions by 15:15, no unknown SQL', async () => {
	const DATE = '2026-03-02'
	const { uninstall } = installMemoryRedis()
	const { store: paper, uninstall: unPg } = installMemoryPg()
	const off = clock.installVirtualClock(clock.istEpoch(DATE, 9 * 60))
	const log = console.log
	console.log = () => {}
	try {
		const bars = new Map([
			[NIFTY_SYMBOL, syntheticIndexSession(DATE)],
			['NSE:TEJASNET-EQ', syntheticSession({ date: DATE, basePrice: 520, seed: 11, breakoutAtMinute: 40, breakoutVolumeMult: 6, drift: 0.03 })],
			['NSE:SBIN-EQ', syntheticSession({ date: DATE, basePrice: 800, seed: 12, breakoutAtMinute: 90, breakoutVolumeMult: 6, drift: -0.03 })],
		])
		const r = await runLiveSession({
			sessionDate: DATE,
			barsBySymbol: bars,
			entries: [{ symbol: 'NSE:TEJASNET-EQ', group: 'core' }, { symbol: 'NSE:SBIN-EQ', group: 'rotating', pick: 'score' }],
			paper,
			config: { capitalBase: 100_000, capitalBehavior: 'REDUCE' },
		})
		console.log = log
		assert.deepEqual(r.errors, [])
		assert.equal(paper.unknown.length, 0, 'only the tracker statements reached the pg stand-in')
		assert.equal(r.channelMessages <= 20, true, 'the daily cap holds')
		// every paper row came from a signals row with a trade id, and every equity row is closed or skipped
		const eq = r.paper.filter((p) => p.symbol.endsWith('-EQ'))
		for (const p of eq) assert.ok(p.status === 'CLOSED' || p.status === 'SKIPPED', `${p.symbol} ${p.status}`)
		for (const p of eq.filter((x) => x.status === 'CLOSED')) assert.ok(['STOP_LOSS', 'TARGET', 'TIME'].includes(p.exit_reason!))
		assert.equal(r.signals.filter((s) => s.trade_id !== null).length, r.paper.length)
		assert.ok(r.signals.every((s) => s.promotion_source === 'CORE' || s.promotion_source === 'DAILY_SCORE' || s.promotion_source === 'INDEX'))
	} finally {
		console.log = log
		off()
		unPg()
		uninstall()
	}
})
